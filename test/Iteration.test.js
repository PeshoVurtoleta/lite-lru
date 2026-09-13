/**
 * @zakkster/lite-lru -- node:test boundary suite for zero-GC iteration
 * (decisions/0018, D18, session S11; extended S7-QA to the S7 Slru/TwoQ members,
 * decisions/0015 D15.4). Parameterized over ALL SIX family members (LiteLru, Sieve,
 * S3Fifo, WTinyLfu, Slru, TwoQ) so a regression in `keys()`/`values()`/
 * `entries()`/`[Symbol.iterator]` on any one member is caught the same way, plus
 * member-specific order traces (D18.1: each member's documented roster is
 * DIFFERENT -- only LiteLru is true recency). validate() (the conservation
 * invariant) runs after mutating scenarios as a structural backstop.
 *
 * BOUNDARY MATRIX (every new entry point -- `keys()`/`values()`/`entries()`/
 * `[Symbol.iterator]()`/the returned iterator's `next()`): capacity 0 is not a
 * legal cache (rejected at the door, covered elsewhere) so the walk-side boundary
 * is capacity 1/2/3 and N-1/N/N+1 resident entries; empty cache (0 entries, done
 * immediately); `null`/`undefined`/`NaN`/`-0` as KEYS surviving a walk intact (D7:
 * presence is by slot, not value, so a value that is literally `undefined` still
 * appears); duplicate dispose (calling `next()` repeatedly past `done`); dispose-
 * during-iteration / re-entrant write (mutating -- or running a SECOND concurrent
 * iterator over -- the same cache mid-walk, which shares one `_ver`); and one
 * adversarial case the planner did not anticipate: the retention-hardening null-on-
 * done (D18.2 + the reviewer's later hardening) means a BARE `[...cache]` spread or
 * `Array.from(cache)` (no map function) does NOT alias "the last pair" as the
 * pre-hardening D18.2 prose describes -- every element ends up the SAME reference,
 * and that reference has been NULLED by the walk's own final done-check, so the
 * whole array reads back as `[undefined, undefined]` N times. This is NOT
 * "independent copies" (a caller might naively assume) and it is also NOT even the
 * stale-but-readable last pair -- it is nulled. Only `entries()`/`[Symbol.iterator]`
 * combined with an explicit per-step copy, or `Array.from(cache, ([k,v]) => [k,v])`,
 * produces something safe to retain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc } from '../Lru.js';
import { validate } from './validate.mjs';

const NIL = -1;
const SEG_WINDOW = 0;
const SEG_PROBATION = 1;
const SEG_PROTECTED = 2;

/** Every family member, so each test body runs SEVEN TIMES over the exact same
 *  LiteCache<K,V> iteration surface (the D18 contract is stated once). Slru/TwoQ/Arc
 *  (decisions/0015 D15.4, 0016 D16.5) are pinned to PROTECTED/Am/T2 first, then
 *  PROBATION/A1in/T1, each MRU..LRU -- handled by `expectedHeads()` below. */
const MEMBERS = [
    { name: 'LiteLru', Ctor: LiteLru },
    { name: 'Sieve', Ctor: Sieve },
    { name: 'S3Fifo', Ctor: S3Fifo },
    { name: 'WTinyLfu', Ctor: WTinyLfu },
    { name: 'Slru', Ctor: Slru },
    { name: 'TwoQ', Ctor: TwoQ },
    { name: 'Arc', Ctor: Arc },
];

/** A hoisted, mutable virtual clock -- zero-alloc per call, fully controlled by the
 *  test (never real time). Mirrors test/Ttl.test.js. */
function makeClock(start) {
    const state = { now: start };
    const clock = () => state.now;
    clock.set = (t) => { state.now = t; };
    return clock;
}

/** INDEPENDENT per-member iteration ROSTER (decisions/0018, D18.1). Deliberately
 *  does NOT call the cache's own `_iterHeads()`, so a bug in the roster itself
 *  (not just the walk) would be caught by a cross-check against this. */
function expectedHeads(name, c) {
    if (name === 'S3Fifo') return [c._mHead, c._sHead];
    if (name === 'WTinyLfu') return [c._wHead, c._ptHead, c._prHead];
    if (name === 'Slru') return [c._protHead, c._probHead]; // D15.4: PROTECTED then PROBATION
    if (name === 'TwoQ') return [c._amHead, c._a1Head];      // D15.4: Am then A1in
    if (name === 'Arc') return [c._t2Head, c._t1Head];       // D16.5: T2 (frequent) then T1 (recent)
    return [c._head]; // LiteLru (recency DLL), Sieve (FIFO ring)
}

/** INDEPENDENT expected walk: head -> _next -> NIL per roster entry, concatenated,
 *  skipping stale entries (D18.5) -- reads the raw slot columns directly, never the
 *  CacheIterator or `_iterHeads()`. */
function walkExpected(c, heads) {
    const ks = [], vs = [];
    const exp = c._exp;
    const now = c._clock ? c._clock() : 0;
    for (let h = 0; h < heads.length; h++) {
        for (let s = heads[h]; s !== NIL; s = c._next[s]) {
            if (exp !== null && exp !== undefined && exp[s] <= now) continue;
            ks.push(c._keys[s]);
            vs.push(c._vals[s]);
        }
    }
    return { ks, vs };
}

/** The set of RESIDENT keys, read straight off the keyed index (never the
 *  iterator) -- the independent oracle for "no dup, no skip". */
function residentKeySet(c) {
    const s = new Set();
    c._store.indexEntries((key) => { s.add(key); });
    return s;
}

function collectScalars(it) { const a = []; for (let r = it.next(); !r.done; r = it.next()) a.push(r.value); return a; }
/** Drain an entries()/[Symbol.iterator] iterator, COPYING the borrowed [k,v] tuple
 *  per step (the correct way to retain what a walk yields, per D18.2). */
function collectPairsCopy(it) { const a = []; for (let r = it.next(); !r.done; r = it.next()) a.push([r.value[0], r.value[1]]); return a; }

/** Cross-check keys()/values()/entries()/[Symbol.iterator] against an independently
 *  computed roster walk (D18.1/D18.3), AND assert the walk is a pure read (D18.4). */
function checkOrder(name, c) {
    const heads = expectedHeads(name, c);
    const want = walkExpected(c, heads);
    assert.deepEqual(collectScalars(c.keys()), want.ks, name + ': keys() != documented roster walk');
    assert.deepEqual(collectScalars(c.values()), want.vs, name + ': values() != documented roster walk');
    const pairs = collectPairsCopy(c.entries());
    assert.deepEqual(pairs.map((p) => p[0]), want.ks, name + ': entries() keys != documented roster walk');
    assert.deepEqual(pairs.map((p) => p[1]), want.vs, name + ': entries() values != documented roster walk');
    const symPairs = collectPairsCopy(c[Symbol.iterator]());
    assert.deepEqual(symPairs, pairs, name + ': [Symbol.iterator] != entries() (D18.3)');
}

/** No dup / no skip: the walked key set is EXACTLY the resident key set, and no key
 *  repeats in the walk. Only valid on a NON-ttl cache (ttl skip-without-reap is its
 *  own law, section 4 below). */
function assertNoDupSkip(name, c) {
    const walked = collectScalars(c.keys());
    const resident = residentKeySet(c);
    assert.equal(walked.length, resident.size, name + ': walk length != resident count (dup or skip)');
    const seen = new Set();
    for (const k of walked) {
        assert.equal(seen.has(k), false, name + ': duplicate key ' + String(k) + ' in walk');
        seen.add(k);
    }
    for (const k of walked) {
        assert.equal(resident.has(k), true, name + ': walked key ' + String(k) + ' is not resident (phantom)');
    }
}

// ============================================================================
// 1. ORDER (D18.1) -- each member's walk equals its OWN documented order.
// ============================================================================

test('LiteLru order: _head..._tail is MRU->LRU, including after a promoting get() and an evicting put()', () => {
    const c = new LiteLru(3);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // MRU..LRU: c, b, a
    c.get('a'); // promote a to MRU -- MRU..LRU: a, c, b
    c.put('d', 4); // evicts LRU tail 'b' -- MRU..LRU: d, a, c
    assert.deepEqual([...c.keys()], ['d', 'a', 'c']);
    assert.deepEqual([...c.values()], [4, 1, 3]);
    checkOrder('LiteLru', c);
    assertNoDupSkip('LiteLru', c);
    validate(c);
});

test('Sieve order: _head..._tail is FIFO newest->oldest; a hit sets visited but never moves the ring', () => {
    const c = new Sieve(3);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // newest..oldest: c, b, a
    c.get('a'); // visited(a)=1, ring UNCHANGED: c, b, a
    assert.deepEqual([...c.keys()], ['c', 'b', 'a'], 'a hit must not reorder the FIFO ring');
    c.put('d', 4); // sweep from tail 'a' (visited) -> second chance -> victim 'b' (unvisited) evicted
    assert.deepEqual([...c.keys()], ['d', 'c', 'a']);
    assert.deepEqual([...c.values()], [4, 3, 1]);
    checkOrder('Sieve', c);
    assertNoDupSkip('Sieve', c);
    validate(c);
});

test('S3Fifo order: MAIN (newest->oldest) THEN SMALL (newest->oldest); the ghost is EXCLUDED', () => {
    const c = new S3Fifo(4); // smallCap 1, mainCap 3, ghostCap 3
    c.put('a', 1); // small: a
    c.put('b', 2); // small: b, a
    c.get('a');    // vis[a] = 1 (still in small)
    c.put('c', 3); // small: c, b, a
    c.put('d', 4); // small: d, c, b, a (size==capacity now, no eviction on THIS insert)
    c.put('e', 5); // at capacity: evict sweep -- 'a' (tail, visited) graduates to MAIN;
                   // then 'b' (new tail, unvisited) evicts into the ghost; 'e' -> small head
    assert.equal(c._ghostHas('b'), true, "evicted 'b' must be recorded in the ghost");
    assert.equal(c.has('b'), false, "a ghosted key is NOT resident");
    // roster: MAIN [a] ++ SMALL [e, d, c]
    assert.deepEqual([...c.keys()], ['a', 'e', 'd', 'c']);
    assert.deepEqual([...c.values()], [1, 5, 4, 3]);
    assert.equal([...c.keys()].includes('b'), false, 'the ghost key must never appear in the walk');
    checkOrder('S3Fifo', c);
    assertNoDupSkip('S3Fifo', c);
    assert.equal([...c.keys()].length, c.size, 'walk length must equal size (ghost excluded, D18.1)');
    validate(c);
});

test('WTinyLfu order: WINDOW->PROTECTED->PROBATION concatenated, MRU->LRU per segment; grouped, no dup/skip', () => {
    const c = new WTinyLfu(1000); // windowCap 10, mainCap 990, protectedCap 792
    for (let i = 0; i < 1000; i++) c.put(i, i * 10); // fills window+probation past capacity
    // promote exactly one probation resident to protected via a single hit (D14 -- any
    // probation hit promotes, no frequency gate on promotion, only on admission).
    let probeKey = -1;
    for (let k = 0; k < 1000; k++) {
        const s = c._store.get(k);
        if (s >= 0 && c._seg[s] === SEG_PROBATION) { probeKey = k; break; }
    }
    assert.notEqual(probeKey, -1, 'setup: expected at least one probation-resident key');
    c.get(probeKey);
    assert.equal(c._seg[c._store.get(probeKey)], SEG_PROTECTED, 'setup: the hit must have promoted the probe key');

    checkOrder('WTinyLfu', c);
    assertNoDupSkip('WTinyLfu', c);

    // The walk must be GROUPED by segment in window -> protected -> probation rank
    // order (never interleaved), matching the documented roster (D18.1).
    const rankOf = { [SEG_WINDOW]: 0, [SEG_PROTECTED]: 1, [SEG_PROBATION]: 2 };
    const walked = collectScalars(c.keys());
    let lastRank = -1;
    for (const k of walked) {
        const seg = c._seg[c._store.get(k)];
        const rank = rankOf[seg];
        assert.equal(rank >= lastRank, true, 'WTinyLfu: walk order is not grouped window->protected->probation');
        lastRank = rank;
    }
    // The probe key must land inside the PROTECTED block of the walk.
    const probeIdx = walked.indexOf(probeKey);
    assert.notEqual(probeIdx, -1);
    assert.equal(c._seg[c._store.get(walked[probeIdx])], SEG_PROTECTED);
    validate(c);
});

// A churned, larger-cache cross-check for all four members: deterministic (not
// randomized, so a failure is 100% reproducible), exercises promotions/evictions,
// then re-verifies the SAME independent-walk + no-dup/skip laws at scale.
for (const { name, Ctor } of MEMBERS) {
    test(name + ' order at scale: independent roster walk still matches after a churn of puts/gets/evictions', () => {
        const cap = 25;
        const c = new Ctor(cap);
        for (let i = 0; i < cap * 3; i++) {
            c.put(i, i);
            if (i % 3 === 0 && c.has(i - 1)) c.get(i - 1); // interleave promoting hits
            if (i % 7 === 0 && c.has(i - 2)) c.get(i - 2);
        }
        checkOrder(name, c);
        assertNoDupSkip(name, c);
        assert.equal(collectScalars(c.keys()).length, c.size);
        validate(c);
    });
}

// ============================================================================
// 2. Projections, [Symbol.iterator] === entries() (D18.3), for...of, Iterable.
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ': keys()/values()/entries() are the right projections of the same walk', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        const ks = collectScalars(c.keys());
        const vs = collectScalars(c.values());
        const es = collectPairsCopy(c.entries());
        assert.equal(ks.length, 3); assert.equal(vs.length, 3); assert.equal(es.length, 3);
        assert.deepEqual(es.map((p) => p[0]), ks);
        assert.deepEqual(es.map((p) => p[1]), vs);
    });

    test(name + ': [Symbol.iterator] behaves identically to entries() (D18.3)', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        assert.equal(typeof c[Symbol.iterator], 'function');
        const viaEntries = collectPairsCopy(c.entries());
        const viaSymbol = collectPairsCopy(c[Symbol.iterator]());
        assert.deepEqual(viaSymbol, viaEntries);
    });

    test(name + ': is Iterable -- for...of works and yields the same pairs as entries()', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        const collected = [];
        for (const [k, v] of c) collected.push([k, v]);
        assert.deepEqual(collected, collectPairsCopy(c.entries()));
    });
}

// ============================================================================
// 3. RECENCY-NEUTRAL (D18.4): a full walk applies no policy side effect.
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ': a full walk with no get/put between changes NO state (snapshot equality)', () => {
        const c = new Ctor(5);
        for (let i = 0; i < 5; i++) c.put('k' + i, i);
        const before = collectPairsCopy(c.entries());
        // full walk, twice, back to back
        for (const _ of c) { void _; }
        const after = collectPairsCopy(c.entries());
        assert.deepEqual(after, before, name + ': a walk mutated the observable order');
        validate(c);
    });
}

test('WTinyLfu: a walk does NOT promote a probation entry to protected (unlike a real get())', () => {
    const c = new WTinyLfu(1000);
    for (let i = 0; i < 1000; i++) c.put(i, i);
    let probeKey = -1, probeSlot = -1;
    for (let k = 0; k < 1000; k++) {
        const s = c._store.get(k);
        if (s >= 0 && c._seg[s] === SEG_PROBATION) { probeKey = k; probeSlot = s; break; }
    }
    assert.notEqual(probeKey, -1);
    const prHeadBefore = c._prHead, ptHeadBefore = c._ptHead;
    for (const _ of c) { void _; } // full walk
    assert.equal(c._seg[probeSlot], SEG_PROBATION, 'a walk must not promote probation->protected');
    assert.equal(c._prHead, prHeadBefore, 'a walk must not relink probation');
    assert.equal(c._ptHead, ptHeadBefore, 'a walk must not relink protected');
    validate(c);
});

test('Sieve: a walk does not flip any visited byte', () => {
    const c = new Sieve(6);
    for (let i = 0; i < 6; i++) c.put('k' + i, i);
    const visBefore = Array.from(c._vis);
    for (const _ of c) { void _; }
    assert.deepEqual(Array.from(c._vis), visBefore, 'a walk must not touch _vis');
    validate(c);
});

test('S3Fifo: a walk does not flip any visited byte', () => {
    const c = new S3Fifo(6);
    for (let i = 0; i < 6; i++) c.put('k' + i, i);
    c.get('k0'); // set one visited bit so the snapshot is not all-zero
    const visBefore = Array.from(c._vis);
    for (const _ of c) { void _; }
    assert.deepEqual(Array.from(c._vis), visBefore, 'a walk must not touch _vis');
    validate(c);
});

// ============================================================================
// 4. TTL SKIP-NO-REAP (D18.5): a walk hides stale entries but never reaps them.
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' ttl: a walk SKIPS stale entries, leaves size UNCHANGED, and purgeStale() still reaps them afterward', () => {
        const clock = makeClock(0);
        const c = new Ctor(4, { ttl: 100, clock });
        c.put('a', 1);              // expires at 100
        c.put('b', 2);              // expires at 100
        c.put('c', 3, Infinity);    // never expires
        clock.set(150);             // a, b now stale; c still live
        const sizeBeforeWalk = c.size;
        const walked = collectScalars(c.keys());
        assert.deepEqual(walked, ['c'], name + ': a stale-skipping walk must see only live entries');
        assert.equal(c.size, sizeBeforeWalk, name + ': a walk must not change size (no reclamation)');
        const reaped = c.purgeStale();
        assert.equal(reaped, 2, name + ': purgeStale() must reap exactly the stale count the walk skipped');
        assert.equal(c.size, 1);
        validate(c);
    });
}

// ============================================================================
// 5. FAIL-CLOSED _ver (D18.6): structural mutation mid-walk throws; benign
//    get/has/peek reorders (documented-unsupported, not an error) do not.
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' fail-closed: put() (even a plain value-update) during a walk makes the NEXT next() throw', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        const it = c.entries();
        it.next();
        c.put('a', 999); // update-in-place still bumps _ver (D18.6)
        assert.throws(() => it.next(), (err) => err instanceof Error &&
            err.message.includes('[lite-lru]') && /mutat/i.test(err.message));
    });

    test(name + ' fail-closed: an eviction triggered by put-at-capacity during a walk throws', () => {
        const c = new Ctor(2);
        c.put('a', 1); c.put('b', 2);
        const it = c.entries();
        it.next();
        c.put('c', 3); // at capacity -- forces an eviction
        assert.throws(() => it.next(), (err) => err instanceof Error && err.message.includes('[lite-lru]'));
    });

    test(name + ' fail-closed: delete() of an EXISTING key during a walk throws; delete() of a MISSING key does not', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);

        const benign = c.entries();
        benign.next();
        assert.equal(c.delete('does-not-exist'), false);
        assert.doesNotThrow(() => benign.next(), name + ': a no-op delete() must not bump _ver');

        const it = c.entries();
        it.next();
        assert.equal(c.delete('a'), true);
        assert.throws(() => it.next(), (err) => err instanceof Error && err.message.includes('[lite-lru]'));
    });

    test(name + ' fail-closed: clear() during a walk throws', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        const it = c.entries();
        it.next();
        c.clear();
        assert.throws(() => it.next(), (err) => err instanceof Error && err.message.includes('[lite-lru]'));
    });

    test(name + ' fail-closed: a SECOND concurrent iterator mutating the SAME cache invalidates BOTH (shared _ver, re-entrant write)', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        const it1 = c.entries();
        const it2 = c.keys();
        it1.next(); it2.next();
        c.put('d', 4); // a third, unrelated handle mutates the shared store
        assert.throws(() => it1.next());
        assert.throws(() => it2.next());
    });

    test(name + ': a benign non-stale get()/has()/peek() interleaved with a walk does NOT throw (documented-unsupported reorder, D18.6)', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        const it = c.entries();
        it.next();
        c.get('a'); c.has('b'); c.peek('c');
        assert.doesNotThrow(() => { let r; do { r = it.next(); } while (!r.done); });
    });

    test(name + ' ttl fail-closed: a stale get()/has()/peek() that REAPS mid-walk throws; a LIVE one does not', () => {
        const clock = makeClock(0);
        const c = new Ctor(4, { ttl: 100, clock });
        c.put('a', 1);
        c.put('b', 2);

        const itStale = c.entries();
        itStale.next();
        clock.set(150); // both now stale
        c.get('a'); // stale hit -> reaps -> bumps _ver
        assert.throws(() => itStale.next(), (err) => err instanceof Error && err.message.includes('[lite-lru]'));

        clock.set(0);
        const c2 = new Ctor(4, { ttl: 100, clock });
        c2.put('x', 1);
        c2.put('y', 2);
        const itLive = c2.entries();
        itLive.next();
        c2.get('x'); // live -- no reap, no _ver bump
        assert.doesNotThrow(() => { let r; do { r = itLive.next(); } while (!r.done); });
    });
}

// ============================================================================
// 6. BORROWED-TUPLE aliasing (D18.2) + the ADVERSARIAL spread/Array.from case.
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' entries(): the yielded [k,v] tuple is a BORROWED reference, reused (mutated) across steps', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        const it = c.entries();
        const r1 = it.next();
        const pairRef = r1.value;
        const snap1 = [pairRef[0], pairRef[1]];
        const r2 = it.next();
        assert.equal(r2.value, pairRef, name + ': entries() must reuse the SAME array reference across steps');
        assert.notDeepEqual([pairRef[0], pairRef[1]], snap1, name + ': the borrowed tuple must have been mutated in place');
    });

    test(name + ': Array.from(cache.entries(), ([k,v]) => [k,v]) MATERIALIZES independent copies', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        const copies = Array.from(c.entries(), ([k, v]) => [k, v]);
        assert.equal(copies.length, 3);
        const refs = new Set(copies);
        assert.equal(refs.size, copies.length, name + ': mapped copies must be independent array objects');
        for (const [k, v] of copies) assert.equal(c.peek(k), v);
    });

    test(name + ' ADVERSARIAL: a bare [...cache] spread / Array.from(cache) (no map fn) does NOT produce independent copies -- every element aliases the SAME reference, and the retention-hardening null-on-done means that reference reads back as [undefined, undefined]', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        const spread = [...c];
        assert.equal(spread.length, 3);
        for (let i = 1; i < spread.length; i++) {
            assert.equal(spread[i], spread[0], name + ': every spread element must be the SAME borrowed-tuple reference');
        }
        assert.deepEqual(spread[0], [undefined, undefined],
            name + ': the shared reference must have been nulled by the walk\'s own final done-check (retention hardening), ' +
            'NOT "the last live pair" -- a naive caller who assumes independent copies (or even a stale-but-readable last pair) is wrong');

        const arrFrom = Array.from(c);
        assert.equal(arrFrom.length, 3);
        assert.equal(arrFrom[0], arrFrom[arrFrom.length - 1], name + ': Array.from(cache) with no map fn aliases the same way as spread');
        assert.deepEqual(arrFrom[0], [undefined, undefined]);
    });
}

// ============================================================================
// 7. RETENTION HARDENING: a completed walk pins NOTHING (nulled on done).
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ' retention hardening: after a completed entries() walk, the internal _pair holds [undefined, undefined]', () => {
        const c = new Ctor(3);
        const bigA = { tag: 'a' }, bigB = { tag: 'b' };
        c.put('a', bigA); c.put('b', bigB);
        const it = c.entries();
        let r;
        do { r = it.next(); } while (!r.done);
        assert.deepEqual(it._pair, [undefined, undefined],
            name + ': a drained entries() iterator must not pin its last key/value');
    });

    test(name + ' retention hardening: an EMPTY cache walk nulls the pair immediately (done on the first next())', () => {
        const c = new Ctor(3);
        const it = c.entries();
        const r = it.next();
        assert.equal(r.done, true);
        assert.equal(r.value, undefined);
        assert.deepEqual(it._pair, [undefined, undefined]);
    });

    test(name + ' retention hardening: keys()/values() also reset the shared result value to undefined on done', () => {
        const c = new Ctor(3);
        c.put('a', { tag: 'v' });
        const itK = c.keys();
        let r; do { r = itK.next(); } while (!r.done);
        assert.equal(itK._result.value, undefined, name + ': a drained keys() iterator must not pin the last key');

        const itV = c.values();
        let rv; do { rv = itV.next(); } while (!rv.done);
        assert.equal(itV._result.value, undefined, name + ': a drained values() iterator must not pin the last value');
    });
}

// ============================================================================
// 8. EDGE: empty / caps 1-2-3 / N-1,N,N+1 / undefined-value key / delete-all /
//    duplicate dispose (calling next() repeatedly past done).
// ============================================================================

for (const { name, Ctor } of MEMBERS) {
    test(name + ': an empty cache yields nothing from keys()/values()/entries() (done immediately)', () => {
        const c = new Ctor(3);
        assert.deepEqual(collectScalars(c.keys()), []);
        assert.deepEqual(collectScalars(c.values()), []);
        assert.deepEqual(collectPairsCopy(c.entries()), []);
        assert.equal(c.entries().next().done, true);
    });

    for (const cap of [1, 2, 3]) {
        test(name + ' cap=' + cap + ': filled to capacity, the walk yields exactly `cap` entries matching the roster', () => {
            const c = new Ctor(cap);
            for (let i = 0; i < cap; i++) c.put('k' + i, i);
            assert.equal(collectScalars(c.keys()).length, cap);
            checkOrder(name, c);
            assertNoDupSkip(name, c);
            validate(c);
        });
    }

    test(name + ' boundary N-1/N/N+1: resident count through capacity walks correctly at every step', () => {
        const cap = 5;
        const c = new Ctor(cap);
        for (let i = 0; i < cap - 1; i++) c.put('k' + i, i); // N-1
        assert.equal(collectScalars(c.keys()).length, cap - 1);
        c.put('k' + (cap - 1), cap - 1); // N (at capacity)
        assert.equal(collectScalars(c.keys()).length, cap);
        c.put('kOverflow', 999); // N+1 puts -- one eviction, still N resident
        assert.equal(collectScalars(c.keys()).length, cap);
        assert.equal(c.size, cap);
        checkOrder(name, c);
        assertNoDupSkip(name, c);
        validate(c);
    });

    test(name + ': a value that is literally `undefined` still appears as a key (D7 -- presence is by slot, not value)', () => {
        const c = new Ctor(3);
        c.put('present-undefined', undefined);
        c.put('other', 1);
        const ks = collectScalars(c.keys());
        assert.equal(ks.includes('present-undefined'), true);
        const pairs = collectPairsCopy(c.entries());
        const hit = pairs.find((p) => p[0] === 'present-undefined');
        assert.notEqual(hit, undefined, 'the key must be present in entries()');
        assert.equal(hit[1], undefined);
        assertNoDupSkip(name, c);
    });

    test(name + ': keys `null`, `undefined`, `NaN`, `-0` all survive a walk correctly (default Map backing)', () => {
        const c = new Ctor(6);
        c.put(null, 'null-val');
        c.put(undefined, 'undefined-val');
        c.put(NaN, 'nan-val');
        c.put(-0, 'neg-zero-val');
        const pairs = collectPairsCopy(c.entries());
        assert.equal(pairs.length, 4);
        const byKeyIsNaN = pairs.find((p) => p[0] !== p[0]);
        assert.notEqual(byKeyIsNaN, undefined, 'NaN key must survive the walk');
        assert.equal(byKeyIsNaN[1], 'nan-val');
        const byKeyNull = pairs.find((p) => p[0] === null);
        assert.notEqual(byKeyNull, undefined);
        assert.equal(byKeyNull[1], 'null-val');
        const byKeyUndef = pairs.find((p) => p[0] === undefined);
        assert.notEqual(byKeyUndef, undefined);
        assert.equal(byKeyUndef[1], 'undefined-val');
        const byKeyNegZero = pairs.find((p) => Object.is(p[0], -0));
        assert.notEqual(byKeyNegZero, undefined, '-0 key must survive as its own SameValueZero-distinct slot from a would-be +0');
        assert.equal(byKeyNegZero[1], 'neg-zero-val');
        assertNoDupSkip(name, c);
    });

    test(name + ': delete-all then iterate yields nothing (size 0, done immediately)', () => {
        const c = new Ctor(4);
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        assert.equal(c.delete('a'), true);
        assert.equal(c.delete('b'), true);
        assert.equal(c.delete('c'), true);
        assert.equal(c.size, 0);
        assert.deepEqual(collectScalars(c.keys()), []);
        assert.equal(c.entries().next().done, true);
        validate(c);
    });

    test(name + ': duplicate dispose -- calling next() repeatedly past done keeps returning {done:true, value:undefined}, never throws, never re-populates the pair', () => {
        const c = new Ctor(3);
        c.put('a', 1);
        const it = c.entries();
        let r = it.next();
        assert.equal(r.done, false);
        r = it.next(); // -> done
        assert.equal(r.done, true);
        assert.equal(r.value, undefined);
        for (let i = 0; i < 5; i++) {
            const rr = it.next();
            assert.equal(rr.done, true, 'call #' + i + ' past done must still report done');
            assert.equal(rr.value, undefined);
            assert.deepEqual(it._pair, [undefined, undefined]);
        }
    });
}
