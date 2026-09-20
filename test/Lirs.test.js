/**
 * @zakkster/lite-lru -- node:test boundary suite for the LIRS member (decisions/0023,
 * D23). Complementary to the heavy differential + zero-alloc gates in test/torture/*.mjs
 * (run under `node --expose-gc test/torture.mjs`); this pins the LIRS-specific boundaries a
 * fuzz stream reaches only by luck, as fast, hand-computable node:test cases: the resident
 * split L_hir = max(1, round(cap*0.01)) / L_lir (incl. the cap-1 -> L_lir 0 all-HIR window
 * edge), the LIR warm-up, the resident-HIR-in-S -> LIR promotion (recency-of-recency), the
 * bounded non-resident history re-admit, the Q-front victim, has/peek neutrality, degenerate
 * caps 1..4, fail-closed doors, clear, dump/restore round-trip + fail-closed rejections, and
 * the TTL / stats / iteration cross-cutting joins. validate() runs after mutating scenarios.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Lirs, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';

const LIR = 1; // _st bit0
const INS = 2; // _st bit1

/** The per-slot _st for a key (or -1 if absent). */
function stOf(c, key) {
    const s = c._store.get(key);
    return s < 0 ? -1 : c._st[s];
}
const isLir = (c, k) => (stOf(c, k) & LIR) !== 0;
const isInS = (c, k) => (stOf(c, k) & INS) !== 0;

test('Lirs: VERSION is the current, un-bumped value (moves only at /release)', () => {
    assert.equal(VERSION, '1.18.0');
});

test('Lirs: fail-closed capacity -- non-integer / < 1 throws RangeError', () => {
    assert.throws(() => new Lirs(0), RangeError);
    assert.throws(() => new Lirs(-1), RangeError);
    assert.throws(() => new Lirs(2.5), RangeError);
    assert.throws(() => new Lirs('8'), RangeError);
});

test('Lirs: fail-closed int-key door -- a non-int32 key throws TypeError in keys:int mode', () => {
    const c = new Lirs(4, { keys: 'int' });
    assert.throws(() => c.put('x', 1), TypeError);
    assert.throws(() => c.get(2.5), TypeError);
    assert.throws(() => c.put(2 ** 40, 1), TypeError);
    c.put(7, 70);
    assert.equal(c.get(7), 70);
    validate(c);
});

test('Lirs: fail-closed unknown keys option -> TypeError with hint', () => {
    assert.throws(() => new Lirs(4, { keys: 'lir' }), /did you mean 'int'/);
});

test('Lirs: the resident split L_hir = max(1, round(cap*0.01)), L_lir = cap - L_hir', () => {
    const cases = [[1, 1, 0], [2, 1, 1], [4, 1, 3], [50, 1, 49], [100, 1, 99], [150, 2, 148], [4096, 41, 4055]];
    for (const [cap, lhir, llir] of cases) {
        const c = new Lirs(cap);
        assert.equal(c._Lhir, lhir, 'L_hir for cap ' + cap);
        assert.equal(c._Llir, llir, 'L_lir for cap ' + cap);
        assert.equal(c._Lhir + c._Llir, cap, 'split sums to capacity for cap ' + cap);
    }
});

test('Lirs: warm-up fills the LIR set, then new blocks are resident HIR; cap stays exact', () => {
    const c = new Lirs(100); // L_hir 1, L_lir 99
    for (let i = 0; i < 99; i++) c.put(i, i);
    for (let i = 0; i < 99; i++) assert.ok(isLir(c, i), 'warm-up key ' + i + ' must be LIR');
    c.put(1000, 1000); // LIR set full -> resident HIR
    assert.ok(!isLir(c, 1000), 'a block after warm-up must be HIR');
    assert.ok(isInS(c, 1000), 'a fresh resident HIR is placed in S');
    assert.equal(c.size, 100, 'resident value capacity is EXACTLY capacity');
    validate(c);
});

test('Lirs: a LIR hit moves to the top of S; has/peek are neutral', () => {
    const c = new Lirs(16); // L_hir 1, L_lir 15
    for (let i = 0; i < 15; i++) c.put(i, i); // all LIR
    c.get(0);
    assert.equal(c._sTop, c._store.get(0), 'a LIR hit moves the block to the top of S');
    const top = c._sTop;
    c.has(5); c.peek(5);
    assert.equal(c._sTop, top, 'has/peek must be stack-neutral');
    assert.ok(isLir(c, 5), 'has/peek must not reclassify');
    validate(c);
});

test('Lirs: a resident-HIR hit while IN S reclassifies to LIR (recency-of-recency)', () => {
    const c = new Lirs(16); // L_hir 1, L_lir 15
    for (let i = 0; i < 15; i++) c.put(i, i); // 15 LIR
    c.put(100, 100);                          // resident HIR, in S
    assert.ok(!isLir(c, 100) && isInS(c, 100), 'setup: 100 is a resident HIR in S');
    const lirBefore = c._lirCount;
    assert.equal(c.get(100), 100);
    assert.ok(isLir(c, 100), 'a resident-HIR-in-S hit must promote to LIR');
    assert.equal(c._lirCount, lirBefore, 'promotion demotes the bottom LIR -> |LIR| unchanged');
    validate(c);
});

test('Lirs: a non-resident HIR still in the bounded history is re-admitted as LIR', () => {
    const c = new Lirs(4); // L_hir 1, L_lir 3
    for (let i = 0; i < 3; i++) c.put(i, i); // 3 LIR
    c.put(10, 10);                           // resident HIR
    c.put(11, 11);                           // evicts Q front (10) -> 10 into the history
    assert.ok(c._hist.has(10), 'an evicted resident HIR (that was in S) is recorded in history');
    assert.ok(!c.has(10), '10 is non-resident');
    c.put(10, 10);                           // history hit -> re-admit as LIR
    assert.ok(isLir(c, 10), 'a history re-admit must become LIR');
    validate(c);
});

test('Lirs: the next over-capacity insert evicts the Q front (LRU resident HIR)', () => {
    let evKey;
    const c = new Lirs(4, { onEvict: (k) => { evKey = k; } });
    for (let i = 0; i < 3; i++) c.put(i, i); // 3 LIR
    c.put(10, 10);                           // resident HIR at Q front
    assert.equal(c._peekVictim(), 10, 'victim = Q front');
    c.put(11, 11);                           // evicts 10
    assert.equal(evKey, 10, 'the Q front is the eviction victim');
    assert.equal(c.size, 4, 'size stays at capacity');
    assert.ok(!c.has(10));
    validate(c);
});

test('Lirs: degenerate caps 1..4 construct and behave without throwing', () => {
    for (let cap = 1; cap <= 4; cap++) {
        const c = new Lirs(cap);
        for (let i = 0; i < 40; i++) {
            c.put(i, i * 10);
            assert.equal(c.size, Math.min(cap, i + 1), 'cap ' + cap + ' size at ' + i);
            assert.equal(c.get(i), i * 10, 'cap ' + cap + ' just-inserted key readable');
            assert.ok(c._hist._len <= cap, 'cap ' + cap + ' history bounded');
            validate(c);
        }
    }
});

test('Lirs: cap-1 -> L_lir 0 all-HIR window edge (no LIR ever, FIFO-like over Q)', () => {
    const c = new Lirs(1);
    assert.equal(c._Llir, 0);
    assert.equal(c._Lhir, 1);
    c.put('a', 1);
    assert.ok(!isLir(c, 'a'), 'cap-1 admits HIR only (L_lir 0)');
    assert.equal(c._lirCount, 0);
    c.put('b', 2); // evicts a
    assert.ok(!c.has('a'));
    assert.equal(c.get('b'), 2);
    validate(c);
});

test('Lirs: has/peek do not resurrect an absent key and are undefined/false', () => {
    const c = new Lirs(4);
    assert.equal(c.has('nope'), false);
    assert.equal(c.peek('nope'), undefined);
    assert.equal(c.get('nope'), undefined);
    validate(c);
});

test('Lirs: delete removes a resident, frees the slot, and is not ghosted', () => {
    const c = new Lirs(4);
    for (let i = 0; i < 3; i++) c.put(i, i);
    assert.equal(c.delete(0), true);
    assert.equal(c.delete(0), false, 'a second delete is a no-op');
    assert.equal(c.size, 2);
    assert.equal(c.size + c._freeListLength(), 4, 'conservation after delete');
    assert.ok(!c._hist.has(0), 'a delete is not recorded in the non-resident history');
    validate(c);
});

test('Lirs: clear empties everything (stack, Q, LIR list, history) and rebuilds the free list', () => {
    const c = new Lirs(8, { keys: 'int' });
    for (let i = 0; i < 30; i++) { c.put(i, i); if ((i & 1) === 0) c.get(i); }
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c._freeListLength(), 8, 'free list restored to capacity');
    assert.equal(c._hist._len, 0, 'history emptied');
    assert.equal(c._lirCount, 0);
    assert.equal(c._sTop, -1);
    assert.equal(c._qHead, -1);
    validate(c);
    c.put(1, 1); // reusable after clear
    assert.equal(c.get(1), 1);
    validate(c);
});

test('Lirs: onEvict fires LAST with the evicted (key, value) and reentrancy is fail-closed', () => {
    const seen = [];
    const c = new Lirs(2, { onEvict: (k, v) => { seen.push([k, v]); assert.throws(() => c.put('z', 0)); } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // evicts the Q front
    assert.equal(seen.length, 1);
    validate(c);
});

test('Lirs: dump()/restore() round-trip is an exact fixed point (both backings)', () => {
    for (const keys of [undefined, 'int']) {
        const o = keys ? { keys } : undefined;
        const c = new Lirs(16, o);
        for (let i = 0; i < 60; i++) c.put(i % 24, i * 7);
        for (let i = 0; i < 16; i++) c.get((i * 3) % 24);
        validate(c);
        const snap = c.dump();
        assert.equal(snap.m, 'Lirs');
        const r = Lirs.restore(structuredClone(snap), o);
        validate(r);
        assert.equal(r.size, c.size);
        assert.deepEqual(r.dump().s, snap.s, 'stack order preserved verbatim');
        assert.deepEqual(r.dump().qins, snap.qins, 'per-Q inS bits preserved');
        assert.deepEqual(r.dump().hist, snap.hist, 'bounded history preserved verbatim');
    }
});

test('Lirs: restore fail-closed matrix', () => {
    const c = new Lirs(8);
    for (let i = 0; i < 12; i++) c.put(i, i);
    const good = c.dump();
    // wrong member tag
    assert.throws(() => Lirs.restore({ ...structuredClone(good), m: 'Arc' }), /cannot restore/);
    // malformed qins
    { const s = structuredClone(good); s.qins = 'nope'; assert.throws(() => Lirs.restore(s), /qins/); }
    // non-binary qins entry
    { const s = structuredClone(good); if (s.qins.length) s.qins[0] = 2; else s.q.slots.length && (s.qins = [2]); assert.throws(() => Lirs.restore(s)); }
    // stack not an array
    { const s = structuredClone(good); s.s = null; assert.throws(() => Lirs.restore(s), /stack/); }
    // history over the bound
    { const s = structuredClone(good); s.hist = new Array(9).fill(0).map((_, i) => 1000 + i); assert.throws(() => Lirs.restore(s), /history/); }
    // non-object snapshot
    assert.throws(() => Lirs.restore(null), /cannot restore/);
});

test('Lirs: restore REJECTS a duplicate slot index within the captured stack order (fail-closed)', () => {
    const c = new Lirs(8);
    for (let i = 0; i < 12; i++) c.put(i, i);
    const good = c.dump();
    assert.ok(good.s.length >= 2, 'setup: the stack must have >= 2 entries to duplicate');
    const dup = structuredClone(good);
    dup.s[1] = dup.s[0]; // a duplicate slot index in the captured stack order
    assert.throws(() => Lirs.restore(dup), /\[lite-lru\] cannot restore snapshot: duplicate slot .* in the stack/,
        'a duplicate stack slot must throw a [lite-lru] Error (REJECT, never build a corrupt instance)');
    // A clean snapshot (no duplicates) still round-trips exactly.
    const r = Lirs.restore(structuredClone(good));
    validate(r);
    assert.equal(r.size, c.size);
    assert.deepEqual(r.dump().s, good.s);
});

test('Lirs: TTL interop -- a stale hit is a miss and is reaped in place (lazy, no promotion)', () => {
    let now = 0; const clock = () => now;
    const ev = [];
    const c = new Lirs(8, { ttl: 10, clock, onEvict: (k) => ev.push(k) });
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
    const d = new Lirs(4);
    assert.throws(() => d.put('a', 1, 5));
});

test('Lirs: stats counting law -- outcome-based hits/misses/puts/evictions; peek/has neutral', () => {
    const c = new Lirs(4, { stats: true });
    c.put(0, 0); c.put(1, 1); c.put(2, 2); c.put(3, 3); // 4 puts (LIR/HIR warm)
    assert.equal(c.get(0), 0);   // hit
    assert.equal(c.get(99), undefined); // miss
    c.has(0); c.peek(0);         // neutral
    c.put(4, 4);                 // put + eviction (Q front)
    const s = c.stats();
    assert.equal(s.hits, 1);
    assert.equal(s.misses, 1);
    assert.equal(s.puts, 5);
    assert.equal(s.evictions, 1);
    // a get on a key that is only in the history is a plain MISS (no reclass on get).
    validate(c);
    assert.throws(() => new Lirs(4).stats(), /stats/); // fail-closed without { stats: true }
});

test('Lirs: iteration is RESIDENT-only (LIR list then Q), history excluded, recency-neutral', () => {
    const c = new Lirs(20); // L_hir 1, L_lir 19
    for (let i = 0; i < 19; i++) c.put(i, i);     // 19 LIR
    for (let i = 100; i < 106; i++) c.put(i, i);  // resident HIR churn (evicts Q front each time)
    const keys = [...c.keys()];
    assert.equal(keys.length, c.size, 'iteration visits exactly the resident set');
    // No non-resident history key appears.
    for (const k of keys) assert.ok(c.has(k), 'iterated key ' + k + ' must be resident');
    // recency-neutral: iterating does not change size or the stack top.
    const top = c._sTop;
    for (const _ of c.entries()) { /* walk */ }
    assert.equal(c._sTop, top, 'iteration is recency-neutral');
    validate(c);
});

test('Lirs: loop resistance -- a proven LIR set survives a distinct one-hit flood > capacity', () => {
    const N = 64;
    const c = new Lirs(N);
    for (let h = 0; h < 8; h++) { const k = 'hot' + h; c.put(k, h); c.get(k); c.get(k); }
    const hot = [];
    for (let h = 0; h < 8; h++) if (isLir(c, 'hot' + h)) hot.push(h);
    assert.ok(hot.length > 0, 'at least one hot key reached LIR');
    while (c.size < N) c.put('warm' + c.size, c.size);
    for (let i = 0; i < 4000; i++) { for (const h of hot) c.get('hot' + h); c.put('scan' + i, i); }
    for (const h of hot) assert.ok(c.has('hot' + h), 'LIR key hot' + h + ' survives the scan');
    validate(c);
});

/* ============================================================================
 * QA gap-closure pass (S16, reviewer-APPROVED build). Everything below pins a
 * LIRS-specific boundary the planner's assertions did not already exercise on their
 * own. Each test is hand-verified to FAIL against a documented broken variant (noted
 * inline) before being trusted, exactly like the S13 demo gap-closure pass.
 * ========================================================================== */

// --- restore() fail-closed matrix completeness (D23.6, D21.3) ----------------------

test('Lirs: restore rejects a missing lir/q list entirely (malformed, not silently empty)', () => {
    const c = new Lirs(8);
    for (let i = 0; i < 12; i++) c.put(i, i);
    const good = c.dump();
    // Teeth: deleting the list must throw "malformed", not restore as if it were empty
    // (an empty-but-valid list is `{ slots: [], k: [], v: [] }`, NOT `undefined`).
    { const s = structuredClone(good); delete s.lir; assert.throws(() => Lirs.restore(s), /\[lite-lru\].*malformed/, 'a missing lir list was not rejected'); }
    { const s = structuredClone(good); delete s.q; assert.throws(() => Lirs.restore(s), /\[lite-lru\].*malformed/, 'a missing q list was not rejected'); }
});

test('Lirs: restore rejects an out-of-range or duplicate slot in the lir/q lists (capacity law, never truncate)', () => {
    const c = new Lirs(8);
    for (let i = 0; i < 12; i++) c.put(i, i);
    const good = c.dump();
    assert.ok(good.lir.slots.length > 0 && good.q.slots.length > 0, 'setup: both lists non-empty');
    // Out-of-range slot index in the LIR list.
    { const s = structuredClone(good); s.lir.slots[0] = 8; assert.throws(() => Lirs.restore(s), /\[lite-lru\].*out of range/, 'an out-of-range lir slot was not rejected'); }
    // Out-of-range slot index in the Q list.
    { const s = structuredClone(good); s.q.slots[0] = -1; assert.throws(() => Lirs.restore(s), /\[lite-lru\].*out of range/, 'an out-of-range q slot was not rejected'); }
    // A slot duplicated ACROSS the lir and q lists (would double-occupy on restore).
    {
        const s = structuredClone(good);
        s.q.slots[0] = s.lir.slots[0];
        assert.throws(() => Lirs.restore(s), /\[lite-lru\].*duplicate slot/, 'a slot duplicated across lir/q was not rejected');
    }
    // Non-vacuity: the unmutated snapshot restores fine.
    assert.doesNotThrow(() => Lirs.restore(structuredClone(good)), 'a correct Lirs snapshot was rejected (vacuous)');
});

test('Lirs: restore rejects a non-array / short qins independent of the malformed-qins case above (column-length law)', () => {
    const c = new Lirs(8);
    for (let i = 0; i < 12; i++) c.put(i, i);
    const good = c.dump();
    assert.ok(good.q.slots.length > 0, 'setup: q non-empty (a qins boundary needs a non-empty q)');
    // qins one entry SHORT of q's slots.
    { const s = structuredClone(good); s.qins.pop(); assert.throws(() => Lirs.restore(s), /\[lite-lru\].*qins/, 'a short qins was not rejected'); }
    // qins one entry LONG.
    { const s = structuredClone(good); s.qins.push(1); assert.throws(() => Lirs.restore(s), /\[lite-lru\].*qins/, 'a long qins was not rejected'); }
});

test('Lirs: restore rejects a stack (s) whose length disagrees with the actual in-S slot count', () => {
    const c = new Lirs(8);
    for (let i = 0; i < 12; i++) c.put(i, i);
    const good = c.dump();
    assert.ok(good.s.length > 0, 'setup: stack non-empty');
    // Drop one entry from the captured stack order -> length mismatch vs the rebuilt _st bits.
    { const s = structuredClone(good); s.s.pop(); assert.throws(() => Lirs.restore(s), /\[lite-lru\].*stack length/, 'a short stack was not rejected'); }
});

// --- stats counting law: a reclassifying access is still counted by OUTCOME (D19.2) ----

test('Lirs: stats brute-tally parity -- a history re-admit (miss+reclass) and a resident-HIR promotion never double-count', () => {
    const d = new Lirs(4, { stats: true }); // L_hir 1, L_lir 3
    let hits = 0, misses = 0, puts = 0;
    const ops = [
        ['put', 0, 0], ['put', 1, 1], ['put', 2, 2],   // 3 LIR, no eviction
        ['put', 10, 10],                                // resident HIR, Q front
        ['get', 10],                                    // resident-HIR-in-S hit -> promotes to LIR (a HIT)
        ['put', 20, 20],                                // new resident HIR (Q front)
        ['put', 30, 30],                                // evicts Q front (20) -> enters history
        ['get', 20],                                     // 20 is ONLY in the non-resident history -> a plain MISS
        ['put', 20, 20],                                 // history re-admit -> LIR (a successful PUT, not a hit)
        ['get', 20],                                     // now resident LIR at the top -> a HIT
        ['get', 999],                                    // never-seen key -> a MISS
    ];
    for (const [kind, k, v] of ops) {
        if (kind === 'put') { d.put(k, v); puts++; }
        else {
            const before = d.stats().hits + d.stats().misses;
            const r = d.get(k);
            const after = d.stats().hits + d.stats().misses;
            assert.equal(after, before + 1, 'get must move exactly one of hits/misses (no double-count)');
            if (r === undefined) misses++; else hits++;
        }
    }
    const s = d.stats();
    assert.equal(s.hits, hits, 'hits drifted from the hand-tallied outcome-based count');
    assert.equal(s.misses, misses, 'misses drifted from the hand-tallied outcome-based count');
    assert.equal(s.puts, puts, 'puts drifted from the hand-tallied outcome-based count');
    // Teeth: a broken counter that credits the history re-admit's put as an extra "hit"
    // (double-counting the reclassification) would inflate s.hits past the hand tally above.
    validate(d);
});

// --- degenerate cap-1 (L_lir = 0): the resident-HIR-in-S reclass guard must gate on L_lir --

test('Lirs: cap-1 (L_lir=0) -- a resident-HIR-in-S hit NEVER promotes (no LIR ever exists)', () => {
    const c = new Lirs(1);
    c.put('a', 1);
    assert.ok(!isLir(c, 'a') && isInS(c, 'a'), 'setup: the sole resident is HIR, in S');
    for (let i = 0; i < 10; i++) {
        assert.equal(c.get('a'), 1, 'repeated hits must keep returning the value');
        assert.ok(!isLir(c, 'a'), 'a cap-1 resident must never be promoted to LIR (L_lir=0 guard)');
        assert.equal(c._lirCount, 0, 'lirCount must stay 0 forever at cap 1');
    }
    // FIFO-like behavior over Q persists: the next distinct key evicts 'a'.
    c.put('b', 2);
    assert.ok(!c.has('a'), 'cap-1 evicts the sole resident on the next distinct insert');
    validate(c);
});

// --- TTL x reclassification: a stale resident-HIR-in-S touch is a miss+reap, never a promotion --

test('Lirs: TTL x reclassification -- a stale resident-HIR-in-S hit is a miss+reap, NOT a promotion', () => {
    let now = 0; const clock = () => now;
    const reaped = [];
    const c = new Lirs(4, { ttl: 10, clock, onEvict: (k) => reaped.push(k) }); // L_hir 1, L_lir 3
    c.put(0, 0, Infinity); c.put(1, 1, Infinity); c.put(2, 2, Infinity); // 3 LIR, never expire
    c.put('x', 100); // resident HIR, in S, ttl = now(0) + 10 = 10
    assert.ok(!isLir(c, 'x') && isInS(c, 'x'), 'setup: x is a resident HIR in S');
    now = 11; // past x's deadline
    assert.equal(c.get('x'), undefined, 'a stale resident-HIR-in-S hit must be a MISS, not a promotion');
    assert.deepEqual(reaped, ['x'], 'the stale entry must be reaped (onEvict fired), not silently promoted');
    assert.ok(!c.has('x'), 'x must be fully non-resident after the stale reap');
    assert.equal(c._lirCount, 3, 'lirCount must be unchanged -- no promotion occurred on the stale path');
    validate(c);
});

// --- iteration: fail-closed on a mid-walk structural mutation (D18.6) --------------

test('Lirs: iteration fails closed (throws) on a structural mutation mid-walk', () => {
    const c = new Lirs(16); // L_hir 1, L_lir 15
    for (let i = 0; i < 15; i++) c.put(i, i);
    for (let i = 100; i < 104; i++) c.put(i, i); // resident HIR churn
    const it = c.entries();
    const first = it.next();
    assert.equal(first.done, false, 'setup: iterator must yield at least one entry');
    c.put(999, 999); // structural mutation (evicts Q front) -> bumps _store._ver
    assert.throws(() => it.next(), /\[lite-lru\]/, 'continuing a walk after a structural mutation must throw, not silently desync');
    // Non-vacuity: a FRESH iterator over the post-mutation state still walks fine.
    let count = 0;
    for (const _ of c.entries()) count++;
    assert.equal(count, c.size, 'a fresh iterator after the mutation must see the full resident set');
    validate(c);
});
