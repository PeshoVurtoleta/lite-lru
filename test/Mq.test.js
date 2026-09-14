/**
 * @zakkster/lite-lru -- node:test boundary suite for the Mq member (Multi-Queue, m=8,
 * decisions/0027, D27). Complementary to the heavy differential + zero-alloc gates in
 * test/torture/*.mjs (run under `node --expose-gc test/torture.mjs`); this pins the
 * MQ-specific boundaries a fuzz stream reaches only by luck, as fast, hand-computable
 * node:test cases: the band ranking (band(rc) = highest set bit, clamped to 7), the hot
 * path's real list surgery (0 link writes when already the band MRU, else exactly 5, +
 * 3 stamps -- MQ is NOT a 0-write lazy hit), the FIXED 7-step aging sweep that decays an
 * idle band tail ONE level per access (no cascade -- reset-on-demote), the lowest-queue
 * tail eviction with band priority, the bounded Qout + refcount-preserving re-admit (an
 * evicted rc-5 block re-enters at Q2), the clz32 band SATURATION guard (rc >= 128 -> Q7,
 * fail-closed), has/peek neutrality, degenerate caps 1..4, fail-closed doors, clear, the
 * structural invariants (sum(|Q0..Q7|) === size, _qn matches its queue, Qout bounded),
 * dump/restore round-trip + fail-closed rejections, and the TTL / stats / iteration joins.
 * validate() runs after mutating scenarios.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Mq, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';
import { CountedMq } from './torture/harness.mjs';

/** band(rc): the highest set bit of rc, clamped to 7 (D27.3). */
function band(rc) { return rc >= 128 ? 7 : (31 - Math.clz32(rc)); }

/** The stored band / refcount for a resident key (or -1 if absent). */
function qnOf(c, k) { const s = c._store.get(k); return s < 0 ? -1 : c._qn[s]; }
function rcOf(c, k) { const s = c._store.get(k); return s < 0 ? -1 : c._rc[s]; }

/** Total residents across the 8 band queues (independent recompute of size). */
function queueSum(c) {
    let n = 0;
    for (let q = 0; q < 8; q++) for (let s = c._qHead[q]; s !== -1; s = c._next[s]) n++;
    return n;
}

test('Mq: VERSION is the current, un-bumped value (moves only at /release)', () => {
    assert.equal(VERSION, '1.14.0');
});

test('Mq: fail-closed capacity -- non-integer / < 1 throws RangeError', () => {
    assert.throws(() => new Mq(0), RangeError);
    assert.throws(() => new Mq(-1), RangeError);
    assert.throws(() => new Mq(2.5), RangeError);
    assert.throws(() => new Mq('8'), RangeError);
});

test('Mq: fail-closed int-key door -- a non-int32 key throws TypeError in keys:int mode', () => {
    const c = new Mq(4, { keys: 'int' });
    assert.throws(() => c.put('x', 1), TypeError);
    assert.throws(() => c.get(2.5), TypeError);
    assert.throws(() => c.put(2 ** 40, 1), TypeError);
    c.put(7, 70);
    assert.equal(c.get(7), 70);
    validate(c);
});

test('Mq: fail-closed unknown keys option -> TypeError with hint', () => {
    assert.throws(() => new Mq(4, { keys: 'k2' }), /did you mean 'int'/);
});

test('Mq: band ranking -- a fresh key is rc 1 in Q0; each reference climbs the highest-set-bit band', () => {
    const c = new Mq(16, { keys: 'int' });
    c.put(1, 1);
    assert.equal(rcOf(c, 1), 1);
    assert.equal(qnOf(c, 1), 0); // band(1) = 0
    c.get(1); // rc 2
    assert.equal(qnOf(c, 1), band(2)); // 1
    c.get(1); // rc 3
    assert.equal(qnOf(c, 1), band(3)); // 1
    c.get(1); // rc 4
    assert.equal(qnOf(c, 1), band(4)); // 2
    validate(c);
});

test('Mq: has/peek are policy-neutral (no refcount bump, no re-band)', () => {
    const c = new Mq(8);
    c.put('a', 1); c.get('a'); // rc 2, Q1
    const rcBefore = rcOf(c, 'a'), qnBefore = qnOf(c, 'a');
    assert.equal(c.has('a'), true);
    assert.equal(c.peek('a'), 1);
    assert.equal(rcOf(c, 'a'), rcBefore);
    assert.equal(qnOf(c, 'a'), qnBefore);
    validate(c);
});

test('Mq: the hot path is real list surgery -- 0 links when already band MRU, else exactly 5 (+ 3 stamps)', () => {
    // Build Q2 non-empty (z, rc 4) and Q1 = [y, A, x] with A interior (no aging: lifeTime 16).
    const c = new CountedMq(16);
    c.put('z', 1); c.get('z'); c.get('z'); c.get('z'); // z rc4 -> Q2
    c.put('x', 1); c.get('x');                         // x rc2 -> Q1 head
    c.put('A', 1); c.get('A'); c.get('A');             // A rc3 -> Q1 head
    c.put('y', 1); c.get('y');                         // y rc2 -> Q1 head; Q1 = [y, A, x]
    c.resetWrites();
    c.get('A'); // rc3->4 (Q1->Q2): interior detach(2) + non-empty head push(3) = exactly 5 links
    assert.equal(c.writes(), 5, 'an interior re-band hit must relink exactly 5 cells');
    assert.equal(c.stamps(), 3, 'every access stamps exactly 3 metadata cells (_rc, _qn, _exq)');
    c.resetWrites();
    c.get('A'); // rc4->5 still Q2, already MRU: 0 links + 3 stamps
    assert.equal(c.writes(), 0, 'an already-MRU-of-band hit must relink nothing');
    assert.equal(c.stamps(), 3, 'the fast path still stamps exactly 3 metadata cells');
    validate(c);
});

test('Mq: the aging sweep decays an idle band tail ONE level per access, never cascading (D27.6)', () => {
    // ASSERTION 3 (part 1): rc-4 key in Q2, foreign accesses demote it Q2 -> Q1 -> Q0, one level
    // at a time. The literal count of foreign accesses depends on lifeTime = capacity; the pinned
    // INVARIANT is the stepwise decay (no block drops two bands in one access) + it reaches Q0.
    const c = new Mq(8, { keys: 'int' });
    c.put(0, 0); c.get(0); c.get(0); c.get(0); // key 0 -> rc 4 -> band Q2
    assert.equal(qnOf(c, 0), 2);
    let prev = 2;
    const seen = new Set([2]);
    let fk = 1000;
    for (let i = 0; i < 400; i++) {
        c.put(fk++, i); // fresh Q0 churn: advances logical time + ages; evicts a Q0 block
        const now = qnOf(c, 0);
        if (now < 0) break; // key 0 finally decayed to Q0 and was evicted
        assert.ok(now <= prev, 'key 0 band must never rise without a reference');
        assert.ok(prev - now <= 1, 'key 0 must not drop more than one band in a single access (cascade)');
        seen.add(now);
        prev = now;
    }
    assert.ok(seen.has(1), 'key 0 must pass through Q1 on its way down');
    assert.ok(seen.has(0), 'key 0 must reach Q0 (the eviction end) under the idle flood');
    validate(c);
});

test('Mq: eviction takes the lowest-queue tail -- a higher-band block outranks a Q0 block', () => {
    let evicted;
    const c = new Mq(3, { onEvict: (k) => { evicted = k; } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // Q0: c(head)..a(tail)
    c.get('b');                                   // b -> rc 2 -> Q1 (outranks Q0)
    assert.equal(c._peekVictim(), 'a', 'the next victim is the Q0 tail a, not the Q1 block b');
    c.put('d', 4);                                // evict the Q0 tail a
    assert.equal(evicted, 'a');
    assert.ok(c.has('b') && c.has('c') && c.has('d'));
    assert.equal(c.size, 3);
    validate(c);
});

test('Mq: bounded Qout + refcount-preserving re-admit -- an evicted rc-5 block re-enters at Q2 (D27.5)', () => {
    // ASSERTION 3 (part 2). cap 1: every put evicts the sole resident into Qout WITH its refcount.
    const c = new Mq(1, { keys: 'int' });
    c.put(9, 9); c.get(9); c.get(9); c.get(9); c.get(9); // key 9 -> rc 5 -> band Q2
    assert.equal(qnOf(c, 9), 2);
    c.put(8, 8); // evict 9 (sole) -> Qout rc 5
    assert.equal(c._hist.has(9), true);
    assert.equal(c._hist.rcOf(9), 5, 'Qout preserves the evicted refcount');
    c.put(9, 90); // re-admit: rc 5 + 1 = 6 -> band(6) = Q2
    assert.equal(rcOf(c, 9), 6);
    assert.equal(qnOf(c, 9), 2, 'a re-admitted rc-5 block re-enters at Q2');
    assert.equal(c._hist.has(9), false, 're-admit consumes the key from Qout');
    validate(c);
});

test('Mq: the clz32 band SATURATION guard -- rc >= 128 lands in Q7, never out of range (D27.3)', () => {
    const c = new Mq(4, { keys: 'int' });
    c.put(1, 1);
    for (let i = 0; i < 300; i++) c.get(1); // rc -> 301
    assert.ok(rcOf(c, 1) >= 128);
    assert.equal(qnOf(c, 1), 7, 'a saturated refcount must band to Q7, not a wrapped/out-of-range index');
    validate(c);
});

test('Mq: structural invariants -- sum(|Q0..Q7|) === size, _qn matches its queue, Qout bounded (D27.4)', () => {
    // ASSERTION 4.
    const c = new Mq(16, { keys: 'int' });
    for (let i = 0; i < 400; i++) {
        c.put(i % 30, i);
        if (i % 3 === 0) c.get(i % 30);
        if ((i & 31) === 0) {
            assert.equal(queueSum(c), c.size, 'sum of queue lengths must equal size');
            for (let q = 0; q < 8; q++) {
                for (let s = c._qHead[q]; s !== -1; s = c._next[s]) {
                    assert.equal(c._qn[s], q, 'every slot _qn must match the queue it is threaded in');
                }
            }
            assert.ok(c._hist._len <= c._histCap, 'Qout must stay within its bound');
            validate(c);
        }
    }
});

test('Mq: degenerate caps 1..4 churn, conserve, and clear cleanly', () => {
    for (const cap of [1, 2, 3, 4]) {
        const c = new Mq(cap, { keys: 'int' });
        for (let i = 0; i < 300; i++) {
            c.put(i, i);
            if ((i & 1) === 0) c.get(i);
            assert.equal(c.size, Math.min(cap, i + 1));
            assert.ok(c._hist._len <= cap);
        }
        validate(c);
        c.clear();
        assert.equal(c.size, 0);
        assert.equal(c._t, 0);
        assert.equal(c._hist._len, 0);
        assert.equal(c._freeListLength(), cap);
        for (let q = 0; q < 8; q++) { assert.equal(c._qHead[q], -1); assert.equal(c._qTail[q], -1); }
        validate(c);
    }
});

test('Mq: delete removes a resident and is NOT ghosted (no Qout entry)', () => {
    const c = new Mq(4, { keys: 'int' });
    c.put(1, 1); c.get(1); // rc 2, Q1
    assert.equal(c.delete(1), true);
    assert.equal(c.has(1), false);
    assert.equal(c._hist.has(1), false, 'a delete keeps no non-resident metadata');
    assert.equal(c.delete(1), false);
    validate(c);
});

test('Mq: dump -> structuredClone -> restore reproduces order/values/size + a fixed point', () => {
    for (const keys of [undefined, 'int']) {
        const o = keys ? { keys } : undefined;
        const c = new Mq(20, o);
        for (let i = 0; i < 400; i++) { c.put(i % 30, i * 7); if ((i & 1) === 0) c.get(i % 30); }
        validate(c);
        const snap = c.dump();
        assert.equal(snap.m, 'Mq');
        const r = Mq.restore(structuredClone(snap), o);
        validate(r);
        assert.equal(r.size, c.size);
        const a = [...c.entries()].map(([k, v]) => [k, v]);
        const b = [...r.entries()].map(([k, v]) => [k, v]);
        assert.deepEqual(b, a, 'restored entries drift');
        // dump -> restore -> dump is a fixed point (ignoring the capture-time field).
        assert.deepEqual({ ...r.dump(), t: 0 }, { ...snap, t: 0 }, 'dump is not a fixed point');
    }
});

test('Mq: restore fail-closed -- member mismatch, bad tick, mis-aligned columns, over-bound Qout', () => {
    const src = new Mq(8);
    for (let i = 0; i < 20; i++) src.put(i % 12, i);
    const good = src.dump();
    // member mismatch
    assert.throws(() => Mq.restore({ ...structuredClone(good), m: 'LruK' }), /member mismatch/);
    // bad tick
    assert.throws(() => Mq.restore({ ...structuredClone(good), tick: -1 }), /tick must be/);
    assert.throws(() => Mq.restore({ ...structuredClone(good), tick: 'x' }), /tick must be/);
    // history/histRc length mismatch
    { const s = structuredClone(good); s.histRc = (s.histRc || []).concat([1]); assert.throws(() => Mq.restore(s), /length mismatch/); }
    // over-bound Qout
    { const s = structuredClone(good); s.hist = Array.from({ length: 9 }, (_, i) => 900 + i); s.histRc = s.hist.map(() => 1); assert.throws(() => Mq.restore(s), /exceeds capacity/); }
    // Non-vacuity: the unmutated snapshot restores fine.
    assert.doesNotThrow(() => Mq.restore(structuredClone(good)));
});

test('Mq: TTL join -- a stale entry is a MISS, reaped in place, fires onEvict once (D17.3)', () => {
    let now = 0; const ev = [];
    const c = new Mq(8, { ttl: 10, clock: () => now, onEvict: (k, v) => ev.push([k, v]) });
    c.put('x', 1);              // exp 10
    c.put('keep', 2, Infinity); // never
    now = 11;
    assert.equal(c.get('x'), undefined);
    assert.deepEqual(ev, [['x', 1]]);
    assert.equal(c.size, 1);
    assert.equal(c.has('keep'), true);
    validate(c);
});

test('Mq: stats join -- outcome-based hits/misses/puts/evictions', () => {
    const c = new Mq(2, { stats: true });
    c.put(1, 1); c.put(2, 2);   // 2 puts
    c.get(1);                    // hit
    c.get(99);                   // miss
    c.put(3, 3);                 // put (insert) + eviction
    const s = c.stats();
    assert.equal(s.hits, 1);
    assert.equal(s.misses, 1);
    assert.ok(s.puts >= 3);
    assert.ok(s.evictions >= 1);
    assert.throws(() => new Mq(2).stats(), /stats/); // fail-closed without { stats: true }
    validate(c);
});

test('Mq: iteration join -- keys/values/entries walk Q7..Q0, resident only, Qout excluded', () => {
    const c = new Mq(8, { keys: 'int' });
    for (let i = 0; i < 20; i++) { c.put(i % 10, i); if ((i & 1) === 0) c.get(i % 10); }
    const ks = [...c.keys()];
    assert.equal(ks.length, c.size);
    // every yielded key is resident (present), none are Qout keys
    for (const k of ks) assert.equal(c.has(k), true);
    const pairs = [...c.entries()].map(([k, v]) => [k, v]);
    assert.equal(pairs.length, c.size);
    validate(c);
});
