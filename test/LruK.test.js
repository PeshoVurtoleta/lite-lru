/**
 * @zakkster/lite-lru -- node:test boundary suite for the LruK member (LRU-K, K=2,
 * decisions/0026, D26). Complementary to the heavy differential + zero-alloc gates in
 * test/torture/*.mjs (run under `node --expose-gc test/torture.mjs`); this pins the
 * LRU-K-specific boundaries a fuzz stream reaches only by luck, as fast, hand-computable
 * node:test cases: the warm-hit lazy hot path (0 relinks, 2 stamps), the cold->warm
 * promotion (at most 5, 2..5, link writes, non-exceedable; 5 the reachable maximum), the cold
 * sentinel (-Infinity, never 0), the cold-tail (infinite-K-distance) eviction, TWO explicit
 * hand-computed victim traces -- cap 3 all-warm min-r1 (X,Y,Z / get Y,Z,X / put W evicts X,
 * with a REAL pure-LRU control proving it would instead evict Y) and cap 3 cold tie-break
 * (A,B,C / get C twice / put D evicts A, the oldest never-referenced cold page) -- the bounded
 * non-resident history WARM re-admit, has/peek neutrality, degenerate caps 1..4, fail-closed
 * doors, clear, dump/restore round-trip + fail-closed rejections, and the TTL / stats /
 * iteration cross-cutting joins. validate() runs after mutating scenarios.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LruK, LiteLru, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';
import { CountedLruK } from './torture/harness.mjs';

const WARM = 1; // _st bit0

/** The per-slot _st for a key (or -1 if absent). */
function stOf(c, key) {
    const s = c._store.get(key);
    return s < 0 ? -1 : c._st[s];
}
const isWarm = (c, k) => (stOf(c, k) & WARM) !== 0;
/** The stored r0/r1 reference times for a resident key. */
function r0Of(c, k) { const s = c._store.get(k); return s < 0 ? undefined : c._r0[s]; }
function r1Of(c, k) { const s = c._store.get(k); return s < 0 ? undefined : c._r1[s]; }

test('LruK: VERSION is the current, un-bumped value (moves only at /release)', () => {
    assert.equal(VERSION, '1.15.0');
});

test('LruK: fail-closed capacity -- non-integer / < 1 throws RangeError', () => {
    assert.throws(() => new LruK(0), RangeError);
    assert.throws(() => new LruK(-1), RangeError);
    assert.throws(() => new LruK(2.5), RangeError);
    assert.throws(() => new LruK('8'), RangeError);
});

test('LruK: fail-closed int-key door -- a non-int32 key throws TypeError in keys:int mode', () => {
    const c = new LruK(4, { keys: 'int' });
    assert.throws(() => c.put('x', 1), TypeError);
    assert.throws(() => c.get(2.5), TypeError);
    assert.throws(() => c.put(2 ** 40, 1), TypeError);
    c.put(7, 70);
    assert.equal(c.get(7), 70);
    validate(c);
});

test('LruK: fail-closed unknown keys option -> TypeError with hint', () => {
    assert.throws(() => new LruK(4, { keys: 'k2' }), /did you mean 'int'/);
});

test('LruK: a new page is COLD with r1 at the -Infinity sentinel (never 0); the 2nd ref promotes to WARM', () => {
    const c = new LruK(8);
    for (let i = 0; i < 8; i++) c.put(i, i);
    assert.ok(!isWarm(c, 3), 'a fresh page must start cold');
    assert.equal(r1Of(c, 3), -Infinity, 'a cold page r1 must be the -Infinity sentinel, not 0');
    c.get(3); // 2nd reference -> promote
    assert.ok(isWarm(c, 3), '2nd reference did not promote cold->warm');
    assert.ok(Number.isFinite(r1Of(c, 3)) && r1Of(c, 3) !== -Infinity, 'a warm page r1 must be a finite 2nd-reference time');
    validate(c);
});

test('LruK: has/peek are policy-neutral (no stamp, no promotion)', () => {
    const c = new LruK(8);
    for (let i = 0; i < 8; i++) c.put(i, i);
    const r0Before = r0Of(c, 5), r1Before = r1Of(c, 5), warmBefore = isWarm(c, 5);
    assert.ok(c.has(5));
    assert.equal(c.peek(5), 5);
    assert.equal(r0Of(c, 5), r0Before, 'has/peek stamped r0 (must be neutral)');
    assert.equal(r1Of(c, 5), r1Before, 'has/peek stamped r1 (must be neutral)');
    assert.equal(isWarm(c, 5), warmBefore, 'has/peek changed the warm bit (must be neutral)');
    validate(c);
});

test('LruK: the warm-hit hot path relinks NOTHING (0 links) + 2 stamps; a promotion is exactly 5 links + 2 stamps', () => {
    const c = new CountedLruK(16);
    c.put(100, 100); c.get(100);           // key 100 warm
    for (let i = 1; i <= 5; i++) c.put(i, i); // cold list head->tail: 5,4,3,2,1
    c.resetWrites();
    c.get(3);                              // INTERIOR cold, warm non-empty -> exactly 5 links
    assert.equal(c.writes(), 5, 'cold->warm promotion link writes');
    assert.equal(c.stamps(), 2, 'cold->warm promotion stamps');
    c.resetWrites();
    c.get(3);                              // now warm -> 0 links, 2 stamps
    assert.equal(c.writes(), 0, 'warm hit link writes');
    assert.equal(c.stamps(), 2, 'warm hit stamps');
    validate(c);
});

test('LruK: cold-before-warm eviction -- the OLDEST cold page (cold tail) is the victim', () => {
    let evicted;
    const c = new LruK(3, { onEvict: (k) => { evicted = k; } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // cold: newest c .. oldest a
    c.get('a'); c.get('a');                        // a is warm; b, c still cold
    assert.ok(isWarm(c, 'a'));
    assert.equal(c._peekVictim(), 'b', 'the oldest cold page is the next victim');
    c.put('d', 4);
    assert.equal(evicted, 'b', 'evicted the oldest cold page');
    assert.ok(c.has('a') && c.has('c') && c.has('d'));
    assert.equal(c.size, 3);
    validate(c);
});

test('LruK: all-warm eviction takes the smallest 2nd-reference time (LRU-K), where LRU would evict differently', () => {
    let evicted;
    const c = new LruK(3, { onEvict: (k) => { evicted = k; } });
    c.put('X', 1); c.put('Y', 2); c.put('Z', 3);
    c.get('Y'); c.get('Z'); c.get('X'); // all warm; r1: X oldest, then Y, then Z
    assert.equal(c._peekVictim(), 'X', 'min-r1 victim is X (its 2nd-most-recent ref is furthest in the past)');
    c.put('W', 4);
    assert.equal(evicted, 'X', 'evicted the min-r1 page X (classic LRU would evict Y, the LRU)');
    assert.ok(c.has('Y') && c.has('Z') && c.has('W'));
    assert.equal(c.size, 3);
    validate(c);
});

test('LruK: hand-computed victim trace (a) -- cap 3, put X,Y,Z; get Y,Z,X; put W evicts X, WITH a real pure-LRU control that evicts Y on the identical trace', () => {
    // The LruK side (repeats the scenario above as the explicit, self-contained pin).
    let evicted;
    const c = new LruK(3, { onEvict: (k) => { evicted = k; } });
    c.put('X', 1); c.put('Y', 2); c.put('Z', 3);
    c.get('Y'); c.get('Z'); c.get('X');
    assert.equal(c._peekVictim(), 'X', 'LruK min-r1 victim must be X');
    c.put('W', 4);
    assert.equal(evicted, 'X', 'LruK must evict X');
    assert.ok(c.has('Y') && c.has('Z') && c.has('W'));
    assert.equal(c.size, 3);
    validate(c);

    // The CONTROL: the identical put/get trace against a REAL pure-LRU (LiteLru), not a
    // comment -- proving LRU-K's recency-of-recency genuinely diverges from plain LRU here.
    // MRU order after get(Y), get(Z), get(X) is X (MRU) .. Z .. Y (LRU tail) -> put(W) evicts Y.
    let lruEvicted;
    const control = new LiteLru(3, { onEvict: (k) => { lruEvicted = k; } });
    control.put('X', 1); control.put('Y', 2); control.put('Z', 3);
    control.get('Y'); control.get('Z'); control.get('X');
    control.put('W', 4);
    assert.equal(lruEvicted, 'Y', 'control: pure LRU on the identical trace evicts Y, not X');
});

test('LruK: hand-computed victim trace (b) -- cap 3 cold tie-break, put A,B,C; get C twice; put D evicts A (the oldest never-referenced cold page)', () => {
    let evicted;
    const c = new LruK(3, { onEvict: (k) => { evicted = k; } });
    c.put('A', 1); c.put('B', 2); c.put('C', 3); // cold: newest C .. oldest A
    c.get('C'); c.get('C'); // 1st get promotes C cold->warm; 2nd get is a warm re-hit (stamp only)
    assert.ok(isWarm(c, 'C'), 'C must be warm after its first get (the 2nd reference)');
    assert.ok(!isWarm(c, 'A') && !isWarm(c, 'B'), 'A and B were never referenced -- both stay cold');
    assert.equal(c._peekVictim(), 'A', 'the oldest cold page (A) is the next victim, not B');
    c.put('D', 4);
    assert.equal(evicted, 'A', 'evicted the oldest cold page A');
    assert.ok(c.has('B') && c.has('C') && c.has('D'));
    assert.equal(c.size, 3);
    validate(c);
});

test('LruK: the bounded non-resident history records evictions and re-admits a returning key as WARM at r1=r0=t', () => {
    const c = new LruK(3);
    c.put(1, 1); c.put(2, 2); c.put(3, 3); // cold: oldest 1
    c.put(4, 4);                            // evicts the oldest cold (1) -> history
    assert.ok(c._hist.has(1), 'an evicted key is recorded in the bounded history');
    assert.ok(c._hist._len <= c._histCap, 'history stays bounded');
    c.put(1, 10);                           // re-admit -> WARM
    assert.ok(isWarm(c, 1), 'a history re-admit must be WARM');
    assert.ok(Number.isFinite(r1Of(c, 1)) && r0Of(c, 1) === r1Of(c, 1), 'a re-admit sets r1 = r0 = t');
    assert.ok(!c._hist.has(1), 'a re-admitted key is consumed from the history');
    assert.equal(c.get(1), 10);
    assert.equal(c.size, 3);
    validate(c);
});

test('LruK: put-update rewrites the value and applies the access policy (a cold update promotes to warm)', () => {
    const c = new LruK(4);
    c.put(1, 1); // cold
    assert.ok(!isWarm(c, 1));
    c.put(1, 99); // update = a 2nd reference -> promote
    assert.equal(c.get(1), 99);
    assert.ok(isWarm(c, 1), 'a cold update must promote to warm (it is the 2nd reference)');
    validate(c);
});

test('LruK: fixed-capacity -- size stays exactly capacity across churn (|cold| + |warm| == size)', () => {
    const c = new LruK(16, { keys: 'int' });
    for (let i = 0; i < 16; i++) c.put(i, i);
    for (let i = 0; i < 5000; i++) {
        c.put(1000 + i, i);
        if ((i & 1) === 0) c.get(1000 + i); // promote half
        assert.equal(c.size, 16, 'size drifted from capacity at ' + i);
    }
    validate(c);
});

test('LruK: degenerate caps 1..4 construct and behave without throwing', () => {
    for (const cap of [1, 2, 3, 4]) {
        const c = new LruK(cap);
        for (let i = 0; i < 200; i++) {
            c.put(i, i);
            assert.equal(c.size, Math.min(cap, i + 1));
            assert.equal(c.get(i), i);
            validate(c);
        }
    }
});

test('LruK: cap-1 -- the sole page churns; the next distinct insert evicts it', () => {
    const c = new LruK(1);
    c.put('a', 1);
    assert.equal(c.get('a'), 1);
    c.put('b', 2); // evicts the sole page
    assert.ok(!c.has('a'));
    assert.equal(c.get('b'), 2);
    assert.equal(c.size, 1);
    validate(c);
});

test('LruK: has/peek do not resurrect an absent key and are undefined/false', () => {
    const c = new LruK(4);
    c.put(1, 1);
    assert.equal(c.has(2), false);
    assert.equal(c.peek(2), undefined);
    assert.equal(c.get(2), undefined);
    validate(c);
});

test('LruK: delete removes a resident, frees the slot, and is not recorded in history', () => {
    const c = new LruK(4);
    c.put(1, 1); c.put(2, 2);
    assert.equal(c.delete(1), true);
    assert.equal(c.delete(1), false);
    assert.ok(!c.has(1));
    assert.ok(!c._hist.has(1), 'a delete must not be recorded in the history');
    assert.equal(c.size, 1);
    validate(c);
});

test('LruK: clear empties everything (both lists, history, logical clock) and rebuilds the free list', () => {
    const c = new LruK(8, { keys: 'int' });
    for (let i = 0; i < 30; i++) { c.put(i, i); if ((i & 1) === 0) c.get(i); }
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c._coldHead, -1); assert.equal(c._coldTail, -1);
    assert.equal(c._warmHead, -1); assert.equal(c._warmTail, -1);
    assert.equal(c._t, 0, 'the logical clock resets to 0');
    assert.equal(c._hist._len, 0, 'the history empties');
    assert.equal(c._freeListLength(), 8, 'the free list rebuilds to capacity');
    validate(c);
    c.put(5, 50); // reusable after clear
    assert.equal(c.get(5), 50);
    validate(c);
});

test('LruK: onEvict fires LAST with the evicted (key, value) and reentrancy is fail-closed', () => {
    const seen = [];
    const c = new LruK(2, { onEvict: (k, v) => { seen.push([k, v]); assert.throws(() => c.put('z', 0)); } });
    c.put('a', 1); c.put('b', 2); // full
    c.put('c', 3);                // evicts the oldest cold (a)
    assert.deepEqual(seen, [['a', 1]]);
    validate(c);
});

test('LruK: dump()/restore() round-trip is an exact fixed point (both backings)', () => {
    for (const keys of [undefined, 'int']) {
        const o = keys ? { keys } : undefined;
        const c = new LruK(16, o);
        for (let i = 0; i < 60; i++) c.put(i % 30, i * 7);
        for (let i = 0; i < 20; i++) c.get((i * 3) % 30);
        validate(c);
        const snap = c.dump();
        assert.equal(snap.m, 'LruK');
        const r = LruK.restore(structuredClone(snap), o);
        validate(r);
        assert.equal(r.size, c.size);
        // dump -> restore -> dump is a fixed point, ignoring the capture-time `t` (which
        // legitimately differs between two dumps).
        const a = c.dump(); const b = r.dump();
        delete a.t; delete b.t;
        assert.deepStrictEqual(b, a, 'dump -> restore -> dump is a fixed point (ignoring t)');
        // The restored cache makes the SAME next-eviction decision.
        assert.equal(r._peekVictim(), c._peekVictim(), 'restored victim must match the original');
    }
});

test('LruK: restore fail-closed matrix', () => {
    const c = new LruK(8);
    for (let i = 0; i < 6; i++) c.put(i, i);
    for (let i = 0; i < 3; i++) c.get(i); // some warm, some cold
    const good = c.dump();
    // wrong member tag
    assert.throws(() => LruK.restore({ ...structuredClone(good), m: 'Arc' }), /cannot restore/);
    // a reference-time column of the wrong shape
    { const s = structuredClone(good); s.warmR1 = 'nope'; assert.throws(() => LruK.restore(s), /lruk warmR1/); }
    // a NaN reference time
    { const s = structuredClone(good); if (s.warmR0.length) s.warmR0[0] = NaN; assert.throws(() => LruK.restore(s), /lruk warmR0/); }
    // a cold page whose r1 is not the -Infinity sentinel
    { const s = structuredClone(good); if (s.coldR1.length) { s.coldR1[0] = 5; assert.throws(() => LruK.restore(s), /-Infinity sentinel/); } }
    // a bad logical clock
    { const s = structuredClone(good); s.tick = -1; assert.throws(() => LruK.restore(s), /lruk tick/); }
    { const s = structuredClone(good); s.tick = 'x'; assert.throws(() => LruK.restore(s), /lruk tick/); }
    // a history over its bound
    { const s = structuredClone(good); s.hist = new Array(999).fill(0); assert.throws(() => LruK.restore(s), /lruk history/); }
    // not an object
    assert.throws(() => LruK.restore(null), /cannot restore/);
});

test('LruK: TTL interop -- a stale hit is a miss and is reaped in place (lazy, no stamp)', () => {
    let now = 0; const clock = () => now;
    const ev = [];
    const c = new LruK(8, { ttl: 10, clock, onEvict: (k) => ev.push(k) });
    c.put('x', 1);
    c.put('keep', 2, Infinity);
    now = 11;
    assert.equal(c.get('x'), undefined, 'stale get is a miss');
    assert.equal(ev.length, 1, 'the stale entry was reaped (onEvict fired once)');
    assert.equal(ev[0], 'x');
    assert.ok(c.has('keep'), 'the Infinity sibling survives');
    assert.equal(c.size, 1);
    validate(c);
    // ttlMs on a non-ttl instance fails closed.
    const d = new LruK(4);
    assert.throws(() => d.put('a', 1, 5));
});

test('LruK: stats counting law -- outcome-based hits/misses/puts/evictions; peek/has neutral', () => {
    const c = new LruK(4, { stats: true });
    c.put(0, 0); c.put(1, 1); c.put(2, 2); c.put(3, 3); // 4 puts
    assert.equal(c.get(0), 0);   // hit
    assert.equal(c.get(99), undefined); // miss
    c.has(0); c.peek(0);         // neutral
    c.put(4, 4);                 // put + eviction
    const s = c.stats();
    assert.equal(s.hits, 1);
    assert.equal(s.misses, 1);
    assert.equal(s.puts, 5);
    assert.equal(s.evictions, 1);
    validate(c);
    assert.throws(() => new LruK(4).stats(), /stats/); // fail-closed without { stats: true }
});

test('LruK: iteration is RESIDENT-only (warm then cold), history excluded, recency-neutral', () => {
    const c = new LruK(20);
    for (let i = 0; i < 40; i++) c.put(i % 30, i);   // churn past capacity
    for (let i = 0; i < 20; i++) c.get((i * 3) % 30); // promote some to warm (stamp/relink)
    const keys = [...c.keys()];
    assert.equal(keys.length, c.size, 'iteration visits exactly the resident set');
    for (const k of keys) assert.ok(c.has(k), 'iterated key ' + k + ' must be resident');
    // recency-neutral: iterating changes neither size nor the logical clock.
    const t = c._t;
    for (const _ of c.entries()) { /* walk */ }
    assert.equal(c._t, t, 'iteration is stamp-neutral (the logical clock does not advance)');
    assert.equal(c.size, keys.length, 'iteration is size-neutral');
    validate(c);
});

test('LruK: iteration fails closed (throws) on a structural mutation mid-walk', () => {
    const c = new LruK(16);
    for (let i = 0; i < 40; i++) c.put(i % 24, i);
    const it = c.entries();
    const first = it.next();
    assert.equal(first.done, false, 'setup: iterator must yield at least one entry');
    c.put(999, 999); // structural mutation (evicts) -> bumps _store._ver
    assert.throws(() => it.next(), /\[lite-lru\]/, 'continuing a walk after a structural mutation must throw');
    let count = 0;
    for (const _ of c.entries()) count++;
    assert.equal(count, c.size, 'a fresh iterator after the mutation walks the full resident set');
    validate(c);
});

test('LruK: the all-warm min-r1 victim scan SCALES with the warm-set size (O(size) reads, not a constant)', () => {
    // The warm-scan is honestly O(size) reads (decisions/0026, D26.5) -- NOT a claimed bound.
    // Prove the WORK scales: at cap N with every resident warm, _peekVictim must read every warm
    // page. We measure the returned victim is genuinely the min-r1 page over the whole warm list.
    for (const cap of [16, 64, 256]) {
        const c = new LruK(cap, { keys: 'int' });
        for (let i = 0; i < cap; i++) { c.put(i, i); c.get(i); } // every page warm
        assert.equal(c._coldHead, -1, 'setup: all pages must be warm at cap ' + cap);
        // Independently recompute the min-r1 key and confirm the member agrees.
        let want = -1, wantR1 = Infinity;
        for (let s = c._warmHead; s !== -1; s = c._next[s]) {
            if (c._r1[s] < wantR1) { wantR1 = c._r1[s]; want = s; }
        }
        assert.equal(c._peekVictim(), c._keys[want], 'all-warm victim must be the min-r1 key at cap ' + cap);
        validate(c);
    }
});

test('LruK: scan/loop resistance -- a warm hot set survives a distinct one-hit flood > capacity', () => {
    const N = 64;
    const c = new LruK(N, { keys: 'int' });
    for (let i = 0; i < N; i++) c.put(i, i);
    const hot = [0, 1, 2, 3, 4, 5, 6, 7];
    for (const h of hot) for (let t = 0; t < 8; t++) c.get(h); // deeply warm
    for (let i = 0; i < 4000; i++) { for (const h of hot) c.get(h); c.put(1000 + i, i); }
    for (const h of hot) assert.ok(c.has(h), 'warm key ' + h + ' survives the flood');
    assert.equal(c.size, N, 'capacity held under the flood');
    validate(c);
});
