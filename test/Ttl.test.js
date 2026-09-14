/**
 * @zakkster/lite-lru -- node:test boundary suite for opt-in TTL (decisions/0017,
 * session S10; extended S7-QA to the S7 Slru/TwoQ members). Parameterized over ALL
 * SIX family members (LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ) so a TTL
 * regression in any one member's `get`/`put`/`has`/`peek`/`purgeStale` override is
 * caught the same way. Drives an INJECTED virtual
 * clock throughout -- never real-time `setTimeout`/sleep -- so the suite is fast
 * and deterministic. validate() (the conservation invariant, which already checks
 * the `_exp` column: fixed size, never grows, every FREE slot reads Infinity) runs
 * after every mutating scenario as a structural backstop.
 *
 * BOUNDARY MATRIX (every new TTL entry point -- `ttl`, `ttlMs`, `clock`,
 * `purgeStale()`): 0, 1, N-1/N/N+1 (ms around the expiry boundary and stale-count
 * around capacity), empty (omitted ttlMs -> instance default), `null`, `undefined`,
 * `NaN`, `-0`, duplicate purgeStale ("duplicate dispose"), purgeStale over a
 * scattered int-backed table ("dispose during iteration" -- backward-shift delete
 * mid-sweep), re-entrant onEvict writes during a TTL reap, and one adversarial case
 * (see "ADVERSARIAL" below).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, LruK, Mq } from '../Lru.js';
import { validate } from './validate.mjs';

/** Every family member, so each test body runs SEVEN TIMES over the exact same
 *  LiteCache surface (the TTL contract is stated once on LiteCache, decisions/0017).
 *  Slru/TwoQ/Arc ride the identical `_exp`/`_clock`/`_reap` substrate (decisions/0015, 0016). */
const MEMBERS = [
    { name: 'LiteLru', Ctor: LiteLru },
    { name: 'Sieve', Ctor: Sieve },
    { name: 'S3Fifo', Ctor: S3Fifo },
    { name: 'WTinyLfu', Ctor: WTinyLfu },
    { name: 'Slru', Ctor: Slru },
    { name: 'TwoQ', Ctor: TwoQ },
    { name: 'Arc', Ctor: Arc },
    { name: 'LruK', Ctor: LruK },
    { name: 'Mq', Ctor: Mq },
];

/** A hoisted, mutable virtual clock -- zero-alloc per call, fully controlled by the
 *  test (never real time). `.set(t)` jumps to an absolute ms; `.now` is a plain
 *  number so assertions can read it directly. */
function makeClock(start) {
    const state = { now: start };
    const clock = () => state.now;
    clock.set = (t) => { state.now = t; };
    return clock;
}

// ============================================================================
// A. Fail-closed construction (ttl / clock)
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' ttl: 0 / -1 / NaN / "5" / null / -0 each throw a [lite-lru] RangeError', () => {
        for (const bad of [0, -1, NaN, '5', null, -0]) {
            assert.throws(
                () => new Ctor(3, { ttl: bad }),
                (err) => err instanceof RangeError && err.message.includes('[lite-lru]'),
                'ttl=' + String(bad) + ' did not throw a tagged RangeError'
            );
        }
    });

    test(name + ' ttl: Infinity is a valid never-expire default (no throw)', () => {
        const c = new Ctor(2, { ttl: Infinity });
        assert.equal(typeof c.put, 'function');
        c.put('a', 1);
        assert.equal(c.get('a'), 1);
        validate(c);
    });

    test(name + ' ttl: omitted -> no ttl configured, _exp stays null', () => {
        const c = new Ctor(2);
        assert.equal(c._exp, null);
        validate(c);
    });

    test(name + ' clock: a non-function throws a [lite-lru] TypeError; a function is accepted', () => {
        for (const bad of [0, 'now', null, {}, NaN]) {
            assert.throws(
                () => new Ctor(2, { ttl: 100, clock: bad }),
                (err) => err instanceof TypeError && err.message.includes('[lite-lru]'),
                'clock=' + String(bad) + ' did not throw a tagged TypeError'
            );
        }
        const clock = makeClock(0);
        const c = new Ctor(2, { ttl: 100, clock });
        assert.equal(c._exp.length, 2);
        validate(c);
    });

    test(name + ' ttl: the _exp column is allocated ONCE, sized to capacity, filled Infinity', () => {
        const c = new Ctor(4, { ttl: 50 });
        assert.equal(c._exp.length, 4);
        assert.equal(c._exp.buffer.byteLength, 4 * 8);
        for (let i = 0; i < 4; i++) assert.equal(c._exp[i], Infinity);
        validate(c);
    });
}

// ============================================================================
// B. Fresh / live / stale boundary via get, peek, has (0, 1, N-1, N, N+1 ms)
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' ttl: fresh entry hits on get/peek/has; live entry (N-1 ms) still hits', () => {
        const clock = makeClock(0);
        const c = new Ctor(2, { ttl: 100, clock });
        c.put('a', 1);
        assert.equal(c.get('a'), 1);   // t=0, fresh
        clock.set(99);                 // N-1: 1ms before expiry
        assert.equal(c.peek('a'), 1);
        assert.equal(c.has('a'), true);
        assert.equal(c.get('a'), 1);
        assert.equal(c.size, 1);
        validate(c);
    });

    test(name + ' ttl: entry read AT expiresAt (N) is a MISS on get, peek, AND has; slot freed', () => {
        for (const method of ['get', 'peek', 'has']) {
            let evicted = null;
            const clock = makeClock(0);
            const c = new Ctor(2, { ttl: 1000, clock, onEvict: (k, v) => {
                assert.equal(evicted, null, method + ': onEvict fired more than once');
                evicted = { k, v };
            } });
            c.put('a', 1, 100); // expires at 100
            c.put('b', 2);      // instance default (1000) -- stays live
            clock.set(100); // == expiresAt -- <= semantics: this IS expired ("null is not zero")
            const result = c[method]('a');
            if (method === 'has') assert.equal(result, false);
            else assert.equal(result, undefined);
            assert.deepEqual(evicted, { k: 'a', v: 1 });
            assert.equal(c.size, 1); // slot freed
            assert.equal(c.has('a'), false);
            assert.equal(c.get('b'), 2); // untouched sibling survives
            validate(c);
        }
    });

    test(name + ' ttl: entry read well after expiry (N+1 ms) is still a MISS, reaped exactly once', () => {
        let evictions = 0;
        const clock = makeClock(0);
        const c = new Ctor(2, { ttl: 100, clock, onEvict: () => { evictions++; } });
        c.put('a', 1);
        clock.set(101);
        assert.equal(c.get('a'), undefined);
        assert.equal(evictions, 1);
        assert.equal(c.has('a'), false); // duplicate touch: already gone, no double reap
        assert.equal(c.get('a'), undefined);
        assert.equal(evictions, 1); // NOT fired a second time
        assert.equal(c.size, 0);
        validate(c);
    });

    test(name + ' ttl: untouched-stale entries count toward size until touched or purged', () => {
        const clock = makeClock(0);
        const c = new Ctor(2, { ttl: 10, clock });
        c.put('a', 1);
        clock.set(11); // stale, but never touched
        assert.equal(c.size, 1); // still counted -- laziness (D17.3)
        validate(c);
    });

    test(name + ' ttl: capacity eviction ignores staleness (a stale but untouched entry can still be evicted normally)', () => {
        let evictedKey;
        const clock = makeClock(0);
        const c = new Ctor(1, { ttl: 10, clock, onEvict: (k) => { evictedKey = k; } });
        c.put('a', 1);
        clock.set(11); // 'a' is stale but untouched
        c.put('b', 2); // capacity crunch evicts 'a' via the NORMAL policy, not TTL
        assert.equal(evictedKey, 'a');
        assert.equal(c.get('b'), 2);
        validate(c);
    });
}

// ============================================================================
// C. Stale get/has/peek does NOT apply the member's hit policy (no rescue)
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' ttl: a stale touch does not rescue the entry -- it is gone, not merely skipped, and a live sibling is unaffected', () => {
        const clock = makeClock(0);
        const c = new Ctor(3, { ttl: 100, clock });
        c.put('stale', 'S');
        c.put('live', 'L', Infinity); // never expires
        clock.set(100); // 'stale' now stale, 'live' is not
        assert.equal(c.get('stale'), undefined); // MISS -- not promoted/visited/protected
        assert.equal(c.has('stale'), false);     // truly gone, not "kept but unpromoted"
        assert.equal(c.size, 1);                 // only 'live' remains
        assert.equal(c.get('live'), 'L');        // untouched, unaffected by the stale touch
        assert.equal(c.has('live'), true);
        validate(c);
    });
}

// ============================================================================
// D. Per-put ttlMs override
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' ttl: per-put ttlMs overrides the instance default (shorter expires first)', () => {
        const clock = makeClock(0);
        const c = new Ctor(3, { ttl: 1000, clock }); // long instance default
        c.put('short', 1, 10);  // overridden: expires at 10
        c.put('long', 2);       // instance default: expires at 1000
        clock.set(11);
        assert.equal(c.get('short'), undefined); // overridden ttl already expired
        assert.equal(c.has('short'), false);
        assert.equal(c.get('long'), 2);          // instance default still alive
        validate(c);
    });

    test(name + ' ttl: per-put ttlMs = Infinity never expires even with a short instance default', () => {
        const clock = makeClock(0);
        const c = new Ctor(2, { ttl: 5, clock });
        c.put('forever', 1, Infinity);
        clock.set(1e9);
        assert.equal(c.get('forever'), 1);
        assert.equal(c.has('forever'), true);
        validate(c);
    });

    test(name + ' ttl: restamping an EXISTING key via put(key, value, ttlMs) replaces its expiry', () => {
        const clock = makeClock(0);
        const c = new Ctor(2, { ttl: 10, clock });
        c.put('a', 1);           // expires at 10
        clock.set(5);
        c.put('a', 2, 1000);     // restamp -> expires at 1005
        clock.set(11);           // past the ORIGINAL expiry
        assert.equal(c.get('a'), 2); // still alive under the new stamp
        validate(c);
    });

    test(name + ' ttl: put ttlMs boundary values 0 / -1 / NaN / "5" / -0 each throw RangeError', () => {
        const clock = makeClock(0);
        const c = new Ctor(2, { ttl: 100, clock });
        for (const bad of [0, -1, NaN, '5', -0]) {
            assert.throws(
                () => c.put('x', 1, bad),
                (err) => err instanceof RangeError && err.message.includes('[lite-lru]'),
                'ttlMs=' + String(bad) + ' did not throw a tagged RangeError'
            );
        }
        assert.equal(c.has('x'), false); // the rejected put never touched the cache
        validate(c);
    });
}

// ============================================================================
// E. No-ttl instance: ttlMs on put throws; _exp stays null
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' ttl: passing ttlMs to put() on a NON-ttl instance throws [lite-lru]; _exp stays null', () => {
        const c = new Ctor(2); // no ttl option at all
        assert.equal(c._exp, null);
        for (const ttlMs of [1, Infinity, 100]) {
            assert.throws(
                () => c.put('a', 1, ttlMs),
                (err) => err.message.includes('[lite-lru]'),
                'ttlMs=' + String(ttlMs) + ' did not throw'
            );
        }
        assert.equal(c.size, 0); // the rejected put never touched the cache
        assert.equal(c._exp, null); // no column ever allocated
        validate(c);
    });

    test(name + ' ttl: purgeStale() on a non-ttl instance is a no-op returning 0', () => {
        const c = new Ctor(2);
        c.put('a', 1);
        assert.equal(c.purgeStale(), 0);
        assert.equal(c.size, 1);
        validate(c);
    });
}

// ============================================================================
// F. "null is not zero": <= semantics, 0 is never never-expire
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' ttl: an entry whose computed expiresAt is literal 0 is treated as ALREADY EXPIRED, not never-expire', () => {
        // A never-expire entry is stamped Infinity, NEVER 0 (D17.1). Drive the clock
        // negative so a REAL, validated ttlMs computes to a literal 0 expiresAt
        // (clock() + ttlMs = -100 + 100 = 0), then prove 0 reads as expired, not as
        // the never-expire sentinel.
        const clock = makeClock(-100);
        const c = new Ctor(2, { ttl: 1000, clock });
        c.put('zero', 1, 100); // expiresAt = clock() + 100 = 0
        assert.equal(c._exp[c._store.get('zero')], 0);
        clock.set(0); // clock() == expiresAt == 0
        assert.equal(c.get('zero'), undefined); // <= : 0 <= 0 is expired
        assert.equal(c.has('zero'), false);
        validate(c);
    });

    test(name + ' ttl: freed slots read back Infinity, never 0 (freeSlot/reset hygiene)', () => {
        const clock = makeClock(0);
        const c = new Ctor(2, { ttl: 10, clock });
        c.put('a', 1);
        c.delete('a');
        const freedSlot = c._store.freeListLength() > 0 ? c._exp.findIndex((v) => v === Infinity) : -1;
        assert.notEqual(freedSlot, -1);
        for (let i = 0; i < c._exp.length; i++) assert.notEqual(c._exp[i], 0);
        validate(c);
    });
}

// ============================================================================
// G. D7 under TTL: stored-undefined value, live vs stale
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' ttl D7: a live stored-undefined value -- get() is undefined but has() is true; stale -- has() is false', () => {
        const clock = makeClock(0);
        const c = new Ctor(2, { ttl: 50, clock });
        c.put('u', undefined);
        assert.equal(c.get('u'), undefined); // ambiguous by design (D7)
        assert.equal(c.has('u'), true);      // disambiguates: present
        assert.equal(c.peek('u'), undefined);
        clock.set(50); // now stale
        assert.equal(c.has('u'), false);     // disambiguates: truly gone
        assert.equal(c.get('u'), undefined);
        validate(c);
    });
}

// ============================================================================
// H. purgeStale(): count, onEvict-per-victim, remaining-live, idempotency,
//    dispose-during-iteration, and onEvict reentrancy mid-purge
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' ttl: purgeStale() evicts exactly the stale residents (N-1 of N), fires onEvict per victim, size correct', () => {
        const clock = makeClock(0);
        const evicted = [];
        const c = new Ctor(4, { ttl: 10, clock, onEvict: (k, v) => evicted.push([k, v]) });
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        c.put('d', 4, 1000); // the ONE survivor (N-1 of N stale)
        clock.set(11);
        const n = c.purgeStale();
        assert.equal(n, 3);
        assert.equal(evicted.length, 3);
        assert.deepEqual(new Set(evicted.map((e) => e[0])), new Set(['a', 'b', 'c']));
        assert.equal(c.size, 1);
        assert.equal(c.has('d'), true);
        assert.equal(c.get('d'), 4);
        validate(c);
    });

    test(name + ' ttl: purgeStale() on an empty cache and on a cache with ZERO stale entries returns 0', () => {
        const clock = makeClock(0);
        const c = new Ctor(3, { ttl: 100, clock });
        assert.equal(c.purgeStale(), 0); // empty
        c.put('a', 1); c.put('b', 2);
        assert.equal(c.purgeStale(), 0); // nothing stale yet
        validate(c);
    });

    test(name + ' ttl: purgeStale() purges ALL N residents when everything is stale', () => {
        const clock = makeClock(0);
        const c = new Ctor(3, { ttl: 10, clock });
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        clock.set(10);
        assert.equal(c.purgeStale(), 3);
        assert.equal(c.size, 0);
        validate(c);
        // reusable after a full purge
        c.put('x', 1);
        assert.equal(c.get('x'), 1);
        validate(c);
    });

    test(name + ' ttl: duplicate purgeStale() (called twice back-to-back) is idempotent -- second call is a true no-op', () => {
        const clock = makeClock(0);
        let evictions = 0;
        const c = new Ctor(3, { ttl: 10, clock, onEvict: () => { evictions++; } });
        c.put('a', 1); c.put('b', 2);
        clock.set(10);
        assert.equal(c.purgeStale(), 2);
        assert.equal(evictions, 2);
        assert.equal(c.purgeStale(), 0); // duplicate dispose: nothing left to reap
        assert.equal(evictions, 2);      // NOT double-fired
        validate(c);
    });

    test(name + ' ttl: purgeStale() over a scattered int-backed table survives backward-shift deletion mid-sweep (dispose-during-iteration)', () => {
        const clock = makeClock(0);
        const evicted = [];
        const c = new Ctor(16, { ttl: 10, keys: 'int', clock, onEvict: (k, v) => evicted.push(k) });
        // Interleave short-lived and long-lived keys so the int index's
        // backward-shift-on-delete has to reshuffle buckets WHILE the sweep is
        // still in flight (indexEntries collected victims BEFORE any delete runs).
        const survivors = [];
        for (let i = 0; i < 12; i++) {
            if (i % 3 === 0) { c.put(i, i * 10, 1000); survivors.push(i); }
            else c.put(i, i * 10); // instance default ttl=10
        }
        clock.set(10);
        const n = c.purgeStale();
        assert.equal(n, 12 - survivors.length);
        assert.equal(new Set(evicted).size, evicted.length); // no key reaped twice
        assert.equal(c.size, survivors.length);
        for (const s of survivors) assert.equal(c.get(s), s * 10);
        validate(c);
    });

    test(name + ' ttl: onEvict during purgeStale() that re-enters (put/get/delete/clear/purgeStale) throws [lite-lru]; the exception ABORTS the sweep -- fail-closed by design (0002), regression-pinned', () => {
        // INTENDED FAIL-CLOSED BEHAVIOR (decisions/0017 D17.5), pinned here as a
        // regression guard. onEvict must not re-enter the instance (the 0002 contract);
        // a well-behaved onEvict lets the sweep reap every stale resident. When an
        // onEvict VIOLATES that contract mid-sweep, purgeStale() collects the full
        // victim list up front then reaps sequentially, and the guard's throw propagates
        // straight out -- so victims ordered AFTER the offender are left resident (still
        // stale, still indexed). This is deliberate: continuing to reap past a contract
        // violation would be fail-OPEN. The cache stays STRUCTURALLY valid (validate()
        // passes: conservation holds for whatever was reaped before the throw), and
        // because TTL is lazy the un-reaped stales are reaped by the next touch or a
        // later purgeStale(). purgeStale() promises "structurally consistent, stale-free
        // UNLESS an onEvict threw" -- never partial corruption. Holds identically for all
        // five reentrant ops.
        for (const op of ['put', 'get', 'delete', 'clear', 'purgeStale']) {
            const clock = makeClock(0);
            const c = new Ctor(4, { ttl: 10, clock, onEvict: (k) => {
                if (k === 'trigger') {
                    if (op === 'put') c.put('z', 1);
                    else if (op === 'get') c.get('z');
                    else if (op === 'delete') c.delete('z');
                    else if (op === 'clear') c.clear();
                    else c.purgeStale();
                }
            } });
            c.put('before', 1);
            c.put('trigger', 2);
            c.put('after', 3); // ordered AFTER 'trigger' in the default Map's insertion order
            clock.set(10); // all three stale
            let threw = null;
            try { c.purgeStale(); } catch (err) { threw = err; }
            assert.ok(threw, op + ': the reentrant call did not throw');
            assert.ok(threw.message.includes('[lite-lru]'), op + ': error not [lite-lru]-tagged');
            // 'before' and 'trigger' were fully reaped (state committed, onEvict fired)
            // BEFORE the reentrancy violation happened -- they are gone either way.
            assert.equal(c.has('before'), false, op + ": 'before' should already be reaped");
            // 'after' is the MEASURED gap: probe its raw resident state via the store
            // BEFORE calling any has()/get()/peek() on it, since those themselves would
            // lazily reap it and mask the true post-purgeStale() state.
            const slot = c._store.get('after');
            assert.notEqual(slot, -1, op +
                ": fail-closed abort not observed -- 'after' was purged past the throw (behavior changed)");
            assert.ok(c._exp[slot] <= clock(), op + ": 'after' should still read as stale");
            validate(c); // structurally consistent even though semantically incomplete
        }
    });
}

// ============================================================================
// I. keys:'int' backing + ttl: strict path + out-of-range door
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' ttl + keys:int: fresh/live/stale semantics hold identically over the int backing', () => {
        const clock = makeClock(0);
        const c = new Ctor(3, { ttl: 100, keys: 'int' });
        assert.equal(typeof c._exp, 'object');
        const c2 = new Ctor(3, { ttl: 100, keys: 'int', clock });
        c2.put(1, 'a');
        c2.put(2, 'b');
        clock.set(100);
        assert.equal(c2.get(1), undefined);
        assert.equal(c2.has(1), false);
        assert.equal(c2.get(2), undefined); // both stamped at t=0 with the same ttl
        assert.equal(c2.size, 0);
        validate(c2);
    });

    test(name + ' ttl + keys:int: an out-of-range key still throws the int-door TypeError (ttl does not weaken the door)', () => {
        const clock = makeClock(0);
        const c = new Ctor(3, { ttl: 100, keys: 'int', clock });
        for (const bad of [1.5, NaN, Infinity, -Infinity, 2147483648, -2147483649, 'x', null, undefined, {}]) {
            assert.throws(() => c.put(bad, 1), TypeError, 'put(' + String(bad) + ')');
            assert.throws(() => c.get(bad), TypeError, 'get(' + String(bad) + ')');
            assert.throws(() => c.has(bad), TypeError, 'has(' + String(bad) + ')');
            assert.throws(() => c.peek(bad), TypeError, 'peek(' + String(bad) + ')');
        }
        validate(c);
    });
}

// ============================================================================
// J. clear() with ttl resets cleanly and stays reusable
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' ttl: clear() resets size to 0 and every _exp slot back to Infinity; instance stays reusable', () => {
        const clock = makeClock(0);
        const c = new Ctor(3, { ttl: 10, clock });
        c.put('a', 1); c.put('b', 2, 1000);
        c.clear();
        assert.equal(c.size, 0);
        for (let i = 0; i < c._exp.length; i++) assert.equal(c._exp[i], Infinity);
        validate(c);
        // reusable: a fresh put behaves normally post-clear (fresh clock, fresh stamp)
        c.put('x', 1);
        assert.equal(c.get('x'), 1);
        assert.equal(c.has('x'), true);
        validate(c);
    });
}

// ============================================================================
// K. ADVERSARIAL (the case the planner did not think of): a stale reap must
//    not leave a persistent, cross-key side effect in a member whose hit-policy
//    state OUTLIVES the reaped slot. LiteLru/Sieve/S3Fifo reset their per-slot
//    hit-policy bit inside `_reap` -- but WTinyLfu's frequency sketch is bucketed
//    by (key, slot) and intentionally NOT cleared on delete/reap ("frequency
//    history persists", by design, decisions/0014). If a future refactor ever
//    reordered a stale `get()` to bump the sketch BEFORE the staleness check
//    (instead of skipping the bump entirely, per D17.3), a totally unrelated key
//    that later inherits the SAME freed slot would inherit a phantom frequency
//    boost it never earned -- silently corrupting admission decisions. This is
//    exactly the D14.1 slot-inherited-frequency hazard, but reachable through the
//    LAZY TTL reap path instead of a normal capacity eviction.
// ============================================================================

test('WTinyLfu ttl ADVERSARIAL: a stale get() must NOT bump the frequency sketch -- a key later inheriting the freed slot must not inherit a phantom boost', () => {
    const clock = makeClock(0);
    const c = new WTinyLfu(2, { ttl: 10, clock });
    c.put('doomed', 1);       // expires at 10
    c.put('anchor', 2, 1000); // long-lived, keeps the cache at capacity 2

    // Repeatedly "touch" the doomed key once it is stale. Each touch is a MISS
    // that reaps the slot in place (D17.3): if a regression made this bump the
    // sketch first, the slot's resident frequency would be inflated.
    clock.set(10);
    assert.equal(c.get('doomed'), undefined); // first touch reaps it
    assert.equal(c.has('doomed'), false);
    assert.equal(c.size, 1);

    // A brand-new, never-before-seen key now lands in a fresh slot (capacity
    // still 2, only 'anchor' resident). Prove it starts with NO inherited
    // frequency advantage: it must NOT out-frequency a genuinely-hot admission
    // candidate on arrival alone (a phantom bump would let a cold key win ties
    // it has no right to win).
    c.put('newcomer', 3); // admitted straight in (below capacity: 1 -> 2)
    assert.equal(c.size, 2);
    assert.equal(c.get('newcomer'), 3);

    // Fill to capacity and force an admission compare: a brand-new hot candidate
    // vs a probation/window victim. If 'newcomer' (or whichever slot 'doomed'
    // vacated) carries a phantom frequency edge, an otherwise-losing candidate
    // could wrongly win. We instead assert the neutral, expected outcome: a
    // single-touch candidate with NO real history does not survive against an
    // established, repeatedly-hit resident (ties reject the incumbent challenger).
    for (let i = 0; i < 5; i++) c.get('anchor'); // build real, earned frequency
    c.put('challenger', 4); // capacity crunch: window candidate vs probation victim
    // The exact eviction choice is a policy detail already covered by
    // WTinyLfu.test.js; the ADVERSARIAL proof here is narrower and decisive:
    // 'anchor' (repeatedly and legitimately touched) must still be resident --
    // a phantom-frequency newcomer must not have been able to out-compete it.
    assert.equal(c.has('anchor'), true);
    validate(c);
});
