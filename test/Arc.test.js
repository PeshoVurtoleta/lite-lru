/**
 * @zakkster/lite-lru -- node:test boundary suite for the ARC member (decisions/0016,
 * D16). Complementary to the heavy differential + zero-alloc gates in
 * test/torture/*.mjs (run under `node --expose-gc test/torture.mjs`); this pins the
 * ARC-specific boundaries a fuzz stream reaches only by luck, as fast, hand-computable
 * node:test cases: the `p` adaptation rule at its edges (cap at c, floor at 0), ghost-
 * driven re-admission (a B1/B2 hit re-admits into T2 and moves `p` the right way), the
 * `|T1| == p` REPLACE boundary, degenerate caps 1/2/3 (segment-audited) + a caps 1..4
 * sweep, and has/peek neutrality (no `p` move, no promotion). validate() (the
 * conservation invariant, incl. the two ghost bounds) runs after mutating scenarios.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Arc, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';

const ARC_T1 = 0;
const ARC_T2 = 1;

/** The resident segment tag for a key (or -1 if absent). */
function segOf(c, key) {
    const s = c._store.get(key);
    return s < 0 ? -1 : c._seg[s];
}

test('Arc: VERSION is the current, un-bumped value (moves only at /release)', () => {
    assert.equal(VERSION, '1.16.1');
});

test('Arc: a newcomer enters T1 (recent); a hit promotes it to T2 (frequent)', () => {
    const c = new Arc(8);
    c.put('x', 1);
    assert.equal(segOf(c, 'x'), ARC_T1, 'newcomer must enter T1');
    assert.equal(c.get('x'), 1);
    assert.equal(segOf(c, 'x'), ARC_T2, 'a hit must promote to T2');
    // A put-update also counts as a hit (promotes to T2).
    c.put('y', 2);
    assert.equal(segOf(c, 'y'), ARC_T1);
    c.put('y', 3);
    assert.equal(segOf(c, 'y'), ARC_T2, 'a put-update must promote to T2');
    assert.equal(c.peek('y'), 3);
    validate(c);
});

test('Arc: has/peek are neutral -- no promotion, no p move', () => {
    const c = new Arc(8);
    c.put('a', 1);
    const pBefore = c._p;
    assert.equal(c.has('a'), true);
    assert.equal(c.peek('a'), 1);
    assert.equal(segOf(c, 'a'), ARC_T1, 'has/peek must not promote a T1 entry');
    assert.equal(c._p, pBefore, 'has/peek must not move p');
    // has/peek on an absent key: neutral, no throw.
    assert.equal(c.has('absent'), false);
    assert.equal(c.peek('absent'), undefined);
    validate(c);
});

/** Stage a known key in B1: fill T2 (so |T1| < c and REPLACE prefers T1 at p==0), leave a
 *  couple in T1, then one true-miss to evict the T1 LRU into B1. Returns [cache, b1key]. */
function stageB1(cap) {
    let evicted;
    const c = new Arc(cap, { onEvict: (k) => { evicted = k; } });
    const t2n = cap - 2;
    for (let i = 0; i < t2n; i++) { c.put('t' + i, i); c.get('t' + i); } // t0..t(n-1) -> T2
    c.put('r0', 0); c.put('r1', 1); // T1: r0(LRU), r1(MRU); size == cap, p == 0
    c.put('x', 99);                 // true miss at p==0 -> REPLACE evicts T1 LRU r0 into B1
    if (evicted !== 'r0') throw new Error('stageB1 invariant: expected r0 evicted, got ' + evicted);
    return [c, 'r0'];
}

test('Arc: a B1 (recent-ghost) hit RAISES p and re-admits into T2', () => {
    const [c, b1key] = stageB1(8);
    assert.ok(c._b1.has(b1key), 'B1 must hold the evicted T1 key');
    const pBefore = c._p;
    c.put(b1key, 999);
    assert.ok(c._p > pBefore, 'a B1 hit must raise p (' + pBefore + ' -> ' + c._p + ')');
    assert.equal(segOf(c, b1key), ARC_T2, 'a B1 re-admit must route to T2');
    assert.ok(!c._b1.has(b1key), 'the re-admitted key must be consumed from B1');
    validate(c);
});

test('Arc: a B2 (frequent-ghost) hit LOWERS p and re-admits into T2', () => {
    const c = new Arc(4);
    for (let i = 0; i < 4; i++) { c.put(i, i); c.get(i); } // all -> T2
    for (let i = 200; i < 220; i++) c.put(i, i);           // flood -> T2 evictions into B2
    assert.ok(c._b2._len > 0, 'B2 must be populated by the flood');
    let b2key = -1;
    for (let k = 0; k < 4; k++) if (c._b2.has(k)) { b2key = k; break; }
    assert.ok(b2key >= 0, 'a B2 key to re-reference');
    c._p = c._capacity; // force p high so a decrease is observable (else floored at 0)
    const pBefore = c._p;
    c.put(b2key, 888);
    assert.ok(c._p < pBefore, 'a B2 hit must lower p (' + pBefore + ' -> ' + c._p + ')');
    assert.equal(segOf(c, b2key), ARC_T2, 'a B2 re-admit must route to T2');
    assert.ok(!c._b2.has(b2key), 'the re-admitted key must be consumed from B2');
    validate(c);
});

test('Arc: the p rule is capped at capacity (B1 hits cannot push p past c)', () => {
    // Stage B1 with a low p, then force p to the cap and do a B1 hit: min(..., c) must hold.
    const [c, b1key] = stageB1(8);
    c._p = c._capacity; // force p to the cap
    c.put(b1key, 1);    // B1 hit -> p = min(p + delta, c)
    assert.ok(c._p <= c._capacity, 'p must never exceed capacity (got ' + c._p + ')');
    validate(c);
});

test('Arc: the p rule is floored at 0 (B2 hits cannot push p below 0)', () => {
    const c = new Arc(4);
    c._p = 0; // already at the floor
    for (let i = 0; i < 4; i++) { c.put(i, i); c.get(i); } // -> T2
    for (let i = 200; i < 220; i++) c.put(i, i);           // evict into B2
    let b2key = -1;
    for (let k = 0; k < 4; k++) if (c._b2.has(k)) { b2key = k; break; }
    assert.ok(b2key >= 0);
    c.put(b2key, 1);
    assert.ok(c._p >= 0, 'p must never go below 0 (got ' + c._p + ')');
    validate(c);
});

test('Arc: REPLACE at p == 0 evicts the T1 LRU into B1 (recency victim)', () => {
    // T2 must be non-empty (|T1| < c) so REPLACE runs (an all-T1 cache is the direct-evict
    // edge, D16.4, which records NO ghost). Promote one key to T2, keep the rest in T1.
    let evKey;
    const c = new Arc(4, { onEvict: (k) => { evKey = k; } });
    c.put('a', 1); c.get('a');           // a -> T2
    c.put('b', 2); c.put('c', 3); c.put('d', 4); // T1: b(LRU),c,d(MRU); size 4, |T1|=3, p=0
    assert.equal(c._p, 0);
    assert.equal(segOf(c, 'a'), ARC_T2);
    c.put('x', 5); // true miss at capacity -> REPLACE evicts the T1 LRU 'b'
    assert.equal(evKey, 'b', 'REPLACE at p==0 must evict the T1 LRU');
    assert.equal(c.has('b'), false);
    assert.ok(c._b1.has('b'), 'the T1-evicted key must be recorded in B1');
    assert.equal(c.size, 4);
    validate(c);
});

test('Arc: all-recent (|T1| == c) true miss evicts the T1 LRU DIRECTLY (no ghost, D16.4)', () => {
    let evKey;
    const c = new Arc(4, { onEvict: (k) => { evKey = k; } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4); // all in T1 (T2 empty), p=0
    assert.equal(c._t1Size, 4);
    c.put('x', 5); // |T1| == c -> direct evict of the T1 LRU 'a', NOT ghosted
    assert.equal(evKey, 'a', 'the all-T1 edge must evict the T1 LRU');
    assert.equal(c.has('a'), false);
    assert.ok(!c._b1.has('a'), 'the all-T1 direct evict must NOT record a ghost (|T1|+|B1| <= c)');
    assert.equal(c._b1._len, 0);
    assert.equal(c.size, 4);
    validate(c);
});

test('Arc: REPLACE boundary -- |T1| == p with the incoming key in B2 tips toward evicting T1', () => {
    // Construct: |T1| == p, T2 non-empty (so the else-branch would otherwise take T2), and
    // an incoming key that is in B2. The boundary rule (xInB2 && |T1| == p) must evict T1.
    const c = new Arc(4);
    // Put two keys and promote one to T2, leave one in T1.
    c.put('t2a', 1); c.get('t2a');   // t2a -> T2
    c.put('t2b', 2); c.get('t2b');   // t2b -> T2   (T2 = {t2a, t2b}, T1 = {})
    c.put('r1', 3);                  // r1 -> T1
    c.put('r2', 4);                  // r2 -> T1   (T1 = {r1(LRU), r2(MRU)}, size 4)
    assert.equal(c.size, 4);
    // Evict a T2 tail into B2 so we have a B2 key to re-reference. Flood one true miss.
    // First set p == |T1| == 2 so the boundary is exactly at the tipping point.
    // Force a B2 population: put a fresh key (true miss) -> REPLACE. With p=0 it takes T1.
    // Instead, directly stage B2 by evicting a T2 entry: raise p so REPLACE takes T2.
    c._p = 4; // recency-biased: |T1|(2) <= p(4) -> REPLACE takes T2
    c.put('m1', 9); // true miss -> REPLACE evicts a T2 LRU into B2
    assert.ok(c._b2._len > 0, 'staging: a T2 entry must have been evicted into B2');
    let b2key;
    for (const k of ['t2a', 't2b']) if (c._b2.has(k)) { b2key = k; break; }
    assert.ok(b2key !== undefined, 'a B2 key to re-reference');
    // The B2 hit lowers p by max(1, floor(|B1|/|B2|)) = 1 (B1 is empty) BEFORE REPLACE, so
    // set p = |T1| + 1 -> after the -1 adaptation p == |T1| exactly, hitting the boundary.
    // At |T1| == p with T2 non-empty, the else-branch would take T2; the boundary
    // (xInB2 && |T1| == p) must instead evict the T1 LRU into B1.
    assert.equal(c._b1._len, 0, 'staging: B1 must be empty so the B2-hit delta is exactly 1');
    c._p = c._t1Size + 1;
    const t1TailKey = c._keys[c._t1Tail];
    c.put(b2key, 100); // B2 hit at capacity -> REPLACE(xInB2=true), |T1|==p -> evict T1 LRU
    assert.equal(segOf(c, b2key), ARC_T2, 'the B2 re-admit must land in T2');
    assert.ok(c._b1.has(t1TailKey), 'the boundary REPLACE must evict the T1 LRU into B1');
    validate(c);
});

/* -------------------------------------------------------------------------------- *
 * BLIND-SPOT CLOSURE (reviewer nit 1, S8 QA): the differential oracle
 * (test/torture/oracles/arc.mjs) and this member SHARE the same bounded-ghost TRIM
 * policy (`_ghostRoom`): when a combined ghost insert would exceed the budget `c`,
 * drop the LARGER ghost's LRU, ties -> B1 (D16.2's bounded-ARC realization, a
 * DELIBERATE deviation from verbatim-textbook ARC, which always drops B2's LRU when
 * |L1|+|L2| == 2c). Because BOTH sides code the identical trim, differential fuzzing
 * (t5) can never catch a regression there -- a bug would appear on both sides and
 * cancel. These three cases pin the trim BY HAND: each constructs a state where the
 * combined ghost budget is EXACTLY saturated (|B1|+|B2| == c), performs ONE more
 * ghosting insert, and asserts -- from literal, hand-derived expected keys, NEVER by
 * calling `_ghostRoom`/`_replace` or the oracle's `ghostRoom` -- exactly which ghost
 * key was dropped and which survived. `keys:'int'` for a strict, inspectable state.
 *
 * The three cases decouple "which ghost receives the new key" from "which ghost the
 * trim removes from" (the interesting, falsifiable claim): a naive/wrong trim might
 * drop from whichever list is about to receive the insert, or always drop B1, or
 * always drop the SMALLER list. All three alternatives are falsified below.
 * -------------------------------------------------------------------------------- */

/** Every ARC put that is a TRUE MISS entering T1 has a SEPARATE, unambiguous pretrim
 *  (D16.4): if |T1|+|B1| == c it unconditionally drops B1's own LRU BEFORE replace
 *  runs, to hold the L1 bound. That is a different mechanism from the combined-ghost
 *  `_ghostRoom` trim under test here (which compares B1 vs B2 sizes). Capacity 8 with
 *  ghost sizes that never reach 6+ keeps |T1|+|B1| comfortably below 8 throughout, so
 *  the L1 pretrim never fires and only `_ghostRoom` is exercised. Verified by hand
 *  trace and cross-checked against the running member step by step (see the QA
 *  session scratch probes) before being hard-coded here. */

test('Arc ghost-trim blind spot -- TIE (|B1|==|B2|==4): the new key targets B2, the ' +
    'larger-or-tie rule must still drop B1 LRU (not B2, not "whichever list receives the insert")', () => {
    const c = new Arc(8, { keys: 'int' });
    // 4 anchors resident in T2 for the whole build (keeps steady T1 room at 4 during
    // B1 churn, and gives T2 plenty of LRU depth for the B2 churn phase).
    for (let i = 0; i < 4; i++) c.put(9000 + i, i);
    for (let i = 0; i < 4; i++) c.get(9000 + i);
    // Fill T1 to its steady size (4) -- total resident 8, capacity reached, no evict yet.
    for (let i = 0; i < 4; i++) c.put(100 + i, i);
    // Grow B1 to EXACTLY 4 via 4 steady-state churn puts (T1 stays size 4: one out, one
    // in, each eviction targets T1 since p==0 and |T1|>0). Stop at 4 -- a 5th put would
    // hit the UNRELATED L1 pretrim (|T1|(4)+|B1|(4)==8) and confound this scenario.
    for (let i = 0; i < 4; i++) c.put(200 + i, i);
    assert.equal(c._b1._len, 4, 'setup: B1 must be exactly 4');
    assert.equal(c._b2._len, 0, 'setup: B2 must still be empty');
    assert.equal(c._t1Size, 4);
    // Drive T1 to empty by promoting every current T1 resident to T2 (has/get do not
    // touch ghosts or p -- pure setup plumbing).
    for (const k of [200, 201, 202, 203]) c.get(k);
    assert.equal(c._t1Size, 0);
    // Grow B2 to EXACTLY 4: each cycle is a true-miss put (T1 empty -> evicts T2 LRU
    // into B2) immediately followed by a get() that re-promotes the new T1 resident
    // back to T2 (keeping T1 empty for the next cycle). B1 is untouched throughout
    // (0 + 4 = 4 < 8, well clear of the L1 pretrim boundary).
    for (let i = 0; i < 4; i++) { c.put(300 + i, i); c.get(300 + i); }
    assert.equal(c._b2._len, 4, 'setup: B2 must be exactly 4 (tie with B1)');
    assert.equal(c._b1._len + c._b2._len, 8, 'setup: combined ghost budget must be EXACTLY saturated');
    assert.equal(c._t1Size, 0, 'setup: T1 must be empty so the final insert targets T2/B2');
    // The B1 LRU (oldest, first evicted into B1) is key 100 -- built by 4 sequential
    // single-key evictions (100, 101, 102, 103 in that order), FIFO oldest-first.
    assert.ok(c._b1.has(100) && c._b1.has(101) && c._b1.has(102) && c._b1.has(103));

    // THE TRIGGER: one more true-miss put. T1 is empty -> REPLACE evicts the T2 LRU
    // into B2. Before the add, |B1|(4)+|B2|(4) == c(8) -- saturated -- so `_ghostRoom`
    // must trim first. HAND-APPLIED RULE (D16.2, NOT invoked from any trim code): tie
    // -> drop B1's LRU. Expected: key 100 is dropped from B1; 101/102/103 survive; B2
    // gains a 5th member (whatever T2's LRU is at this instant) and is otherwise intact.
    c.put(77777, 1);

    assert.equal(c._b1._len, 3, 'B1 must have shrunk by exactly one (the tie-break drop)');
    assert.equal(c._b1.has(100), false, 'HAND-DERIVED: key 100 (B1 LRU) must be the one dropped on a tie');
    assert.ok(c._b1.has(101) && c._b1.has(102) && c._b1.has(103), 'the rest of B1 must survive untouched');
    assert.equal(c._b2._len, 5, 'B2 must have grown by one (it is the list actually receiving the new ghost)');
    assert.equal(c._b1._len + c._b2._len, 8, 'combined ghost budget must be respected after the trim + add');
    validate(c);
});

test('Arc ghost-trim blind spot -- B1 LARGER (6 vs 2): the new key targets B2, the ' +
    'larger-ghost rule must drop B1 LRU even though B1 is NOT the list receiving the insert', () => {
    const c = new Arc(8, { keys: 'int' });
    for (let i = 0; i < 6; i++) c.put(9000 + i, i);
    for (let i = 0; i < 6; i++) c.get(9000 + i); // 6 anchors resident in T2
    for (let i = 0; i < 2; i++) c.put(100 + i, i); // fill T1 to steady size 2 (total 8)
    for (let i = 0; i < 6; i++) c.put(200 + i, i); // grow B1 to exactly 6 (steady churn)
    assert.equal(c._b1._len, 6, 'setup: B1 must be exactly 6');
    assert.equal(c._b2._len, 0, 'setup: B2 must still be empty');
    for (const k of [204, 205]) c.get(k); // drive T1 to empty (promote the 2 residents)
    assert.equal(c._t1Size, 0);
    for (let i = 0; i < 2; i++) { c.put(300 + i, i); c.get(300 + i); } // grow B2 to exactly 2
    assert.equal(c._b2._len, 2, 'setup: B2 must be exactly 2 (B1 is the larger ghost)');
    assert.equal(c._b1._len + c._b2._len, 8, 'setup: combined ghost budget must be EXACTLY saturated');
    assert.equal(c._t1Size, 0, 'setup: T1 empty -> the final insert targets T2/B2');
    assert.ok(c._b1.has(100), 'B1 LRU (oldest evicted, key 100) must still be present pre-trigger');

    // THE TRIGGER: T1 empty -> REPLACE evicts T2 LRU into B2. |B1|(6)+|B2|(2)==8 ->
    // trim first. HAND-APPLIED RULE: B1 is strictly larger -> drop B1's LRU (key 100),
    // NOT B2's LRU (which a naive "drop from the list about to grow" rule would pick).
    c.put(55555, 1);

    assert.equal(c._b1._len, 5, 'B1 (the larger ghost) must have shrunk by exactly one');
    assert.equal(c._b1.has(100), false, 'HAND-DERIVED: key 100 (B1 LRU, the larger ghost) must be dropped');
    assert.equal(c._b2._len, 3, 'B2 must have grown by one (it is the list receiving the new ghost)');
    assert.equal(c._b1._len + c._b2._len, 8, 'combined ghost budget must be respected after the trim + add');
    validate(c);
});

test('Arc ghost-trim blind spot -- B2 LARGER (6 vs 2): the new key targets B1, the ' +
    'larger-ghost rule must drop B2 LRU even though B2 is NOT the list receiving the insert', () => {
    const c = new Arc(8, { keys: 'int' });
    for (let i = 0; i < 2; i++) c.put(9000 + i, i);
    for (let i = 0; i < 2; i++) c.get(9000 + i); // 2 anchors resident in T2
    for (let i = 0; i < 6; i++) c.put(100 + i, i); // fill T1 to steady size 6 (total 8)
    for (let i = 0; i < 2; i++) c.put(200 + i, i); // grow B1 to exactly 2 (steady churn)
    assert.equal(c._b1._len, 2, 'setup: B1 must be exactly 2');
    for (const k of [102, 103, 104, 105, 200, 201]) c.get(k); // drive T1 to empty (6 residents)
    assert.equal(c._t1Size, 0);
    assert.equal(c._t2Size, 8);
    // Grow B2 to 5 with promote-back cycles (T1 stays empty in between).
    for (let i = 0; i < 5; i++) { c.put(300 + i, i); c.get(300 + i); }
    assert.equal(c._b2._len, 5, 'setup: B2 at 5, one short of the target 6');
    // The 6th B2 growth: put WITHOUT promoting back, deliberately leaving the new key
    // resident in T1 (T1 size 1) so the FINAL trigger below evicts T1 (not T2).
    c.put(400, 400);
    assert.equal(c._b2._len, 6, 'setup: B2 must be exactly 6 (B2 is the larger ghost)');
    assert.equal(c._b1._len + c._b2._len, 8, 'setup: combined ghost budget must be EXACTLY saturated');
    assert.equal(c._t1Size, 1, 'setup: exactly one T1 resident (key 400) so the trigger targets T1/B1');
    assert.ok(c._b2.has(9000), 'B2 LRU (oldest evicted, key 9000) must still be present pre-trigger');

    // THE TRIGGER: |T1|==1 > p(0) -> REPLACE evicts the T1 LRU (key 400) into B1.
    // |B1|(2)+|B2|(6)==8 -> trim first. HAND-APPLIED RULE: B2 is strictly larger ->
    // drop B2's LRU (key 9000), NOT B1's LRU (the list about to receive the insert).
    c.put(88888, 1);

    assert.equal(c._b2._len, 5, 'B2 (the larger ghost) must have shrunk by exactly one');
    assert.equal(c._b2.has(9000), false, 'HAND-DERIVED: key 9000 (B2 LRU, the larger ghost) must be dropped');
    assert.equal(c._b1._len, 3, 'B1 must have grown by one (it is the list receiving the new ghost: key 400)');
    assert.ok(c._b1.has(400), 'the evicted T1 resident (400) must have landed in B1');
    assert.equal(c._b1._len + c._b2._len, 8, 'combined ghost budget must be respected after the trim + add');
    validate(c);
});

test('Arc: the D16.4 Case-IV L1 pretrim (|T1|+|B1|==c drops B1 LRU) is a DIFFERENT ' +
    'mechanism from the combined-ghost trim above -- pinned directly, B2 untouched', () => {
    // Capacity 4, one permanent T2 anchor (so T1 steady size is 3, never hitting the
    // all-T1 direct-evict edge). Grow B1 to 3 via steady churn (|T1|(3)+|B1| reaches
    // c(4) exactly once |B1|==1) -- from the SECOND churn put onward, the L1 pretrim
    // fires on every true miss (T1 steady at 3, so 3+1==4 already), holding B1 at
    // exactly 1 forever regardless of how many more true misses arrive.
    const c = new Arc(4, { keys: 'int' });
    c.put(900, 0); c.get(900); // T2 anchor
    c.put(1, 1); c.put(2, 2); c.put(3, 3); // T1 fills to steady 3 (total 4)
    assert.equal(c._t1Size, 3);
    c.put(4, 4); // first churn evict: T1 LRU (1) -> B1 = [1]
    assert.equal(c._b1._len, 1);
    assert.ok(c._b1.has(1));
    // Next true miss: |T1|(3)+|B1|(1) == c(4) -- the L1 pretrim fires BEFORE replace,
    // dropping B1's own LRU (1) first; replace then evicts the new T1 LRU (2) into the
    // now-empty B1. Net: B1 stays size 1, its content advances from {1} to {2}. This is
    // NOT the `_ghostRoom` combined trim (B2 is empty throughout -- b1(<=1) never
    // reaches b2(0), so the larger-ghost comparison never has a reason to fire).
    c.put(5, 5);
    assert.equal(c._b1._len, 1, 'the L1 pretrim must hold B1 at exactly 1 (c - steady T1 size)');
    assert.equal(c._b1.has(1), false, 'HAND-DERIVED: key 1 (the old B1 LRU) must be pretrim-dropped');
    assert.ok(c._b1.has(2), 'the newly-evicted T1 LRU (2) must be the sole B1 survivor');
    assert.equal(c._b2._len, 0, 'B2 must be untouched by the L1 pretrim (a different mechanism)');
    validate(c);
});

test('Arc: p-rule integer-division corners -- max(1, floor(ratio)) at both divisor guards', () => {
    // B1 hit, B2 EMPTY: floor(|B2|/|B1|) = floor(0/1) = 0 -> guarded up to 1. Exact
    // delta pinned (not just "increased"), isolating the divisor-empty guard.
    {
        const [c, b1key] = stageB1(8); // |B1|=1, |B2|=0 at this point (see stageB1 above)
        assert.equal(c._b1._len, 1); assert.equal(c._b2._len, 0);
        const pBefore = c._p;
        c.put(b1key, 1);
        assert.equal(c._p, pBefore + 1, 'B2 empty must guard the delta up to exactly 1, not 0');
        validate(c);
    }
    // B1 hit, |B1|=1, |B2|=5: floor(5/1) = 5, NOT guarded (ratio already >= 1).
    {
        const c = new Arc(8, { keys: 'int', onEvict: () => {} });
        for (let i = 0; i < 6; i++) c.put(i, i); // 6 anchors resident, all promoted below
        for (let i = 0; i < 6; i++) c.get(i);
        c.put(100, 100); c.put(101, 101); // T1 churn room = 8-6 = 2
        assert.equal(c._t1Size, 2);
        c.put(200, 200); // evict T1 LRU (100) -> B1 = [100], |B1|=1
        assert.equal(c._b1._len, 1); assert.ok(c._b1.has(100));
        // Drive T1 empty (promote whatever residents are left), then grow B2 to exactly
        // 5 via promote-back cycles, all while B1 stays untouched at 1.
        while (c._t1Size > 0) {
            const s = c._t1Head;
            c.get(c._keys[s]);
        }
        assert.equal(c._t1Size, 0);
        for (let i = 0; i < 5; i++) { c.put(300 + i, i); c.get(300 + i); }
        assert.equal(c._b2._len, 5, 'setup: B2 must be exactly 5');
        assert.equal(c._b1._len, 1);
        assert.ok(c._b1.has(100), 'B1 must still hold key 100 (untouched by the B2 growth)');
        const pBefore = c._p;
        c.put(100, 999); // B1 hit: delta = floor(|B2|(5)/|B1|(1)) = 5, exact
        assert.equal(c._p, pBefore + 5, 'B1 hit with |B2|=5,|B1|=1 must raise p by exactly floor(5/1)=5');
        validate(c);
    }
    // B2 hit, B1 EMPTY: floor(|B1|/|B2|) = floor(0/1) = 0 -> guarded up to 1. A plain
    // "flood" (repeated true-miss puts with no re-promotion) would NOT keep B1 empty
    // here: after the first eviction the new T1 resident sits at |T1|=1 > p(0), so the
    // VERY NEXT put would evict it into B1 (self-defeating). Each cycle below promotes
    // the freshly-inserted T1 resident straight back to T2 before the next put, so
    // |T1| is 0 at every REPLACE decision and B1 is never touched.
    {
        const c = new Arc(4, { keys: 'int' });
        for (let i = 0; i < 4; i++) c.put(i, i);
        for (let i = 0; i < 4; i++) c.get(i); // all -> T2, T1 empty
        for (let i = 0; i < 3; i++) { c.put(200 + i, i); c.get(200 + i); } // grow B2, B1 untouched
        assert.equal(c._t1Size, 0);
        assert.equal(c._b1._len, 0, 'setup: B1 must be empty for the divisor-guard case');
        assert.ok(c._b2._len > 0, 'setup: B2 must have been populated');
        let b2key = -1;
        for (let k = 0; k < 4; k++) if (c._b2.has(k)) { b2key = k; break; }
        assert.ok(b2key >= 0);
        c._p = c._capacity; // headroom (p in [0,c]) so the floor-at-0 clamp does not mask the delta
        const pBefore = c._p;
        c.put(b2key, 1);
        assert.equal(c._p, pBefore - 1, 'B1 empty must guard the delta down to exactly 1, not 0');
        validate(c);
    }
});

test('Arc: has/peek do not consume a ghost key (only put() interacts with ghosts)', () => {
    const [c, b1key] = stageB1(8);
    assert.ok(c._b1.has(b1key));
    assert.equal(c.has(b1key), false, 'a ghost key is not RESIDENT -- has() must report false');
    assert.equal(c.peek(b1key), undefined, 'a ghost key is not RESIDENT -- peek() must report undefined');
    assert.ok(c._b1.has(b1key), 'has() must not consume the ghost membership');
    const pBefore = c._p;
    c.peek(b1key);
    assert.equal(c._p, pBefore, 'peek() on a ghost key must not move p');
    assert.ok(c._b1.has(b1key), 'peek() must not consume the ghost membership either');
    validate(c);
});

test('Arc: onEvict reentrancy fail-closed -- get/delete/clear/purgeStale throw; has/peek are allowed', () => {
    let reentrant = {};
    const c = new Arc(2, {
        onEvict: () => {
            try { c.get('x'); } catch (e) { reentrant.get = /\[lite-lru\]/.test(e.message); }
            try { c.delete('x'); } catch (e) { reentrant.delete = /\[lite-lru\]/.test(e.message); }
            try { c.clear(); } catch (e) { reentrant.clear = /\[lite-lru\]/.test(e.message); }
            try { c.purgeStale(); } catch (e) { reentrant.purgeStale = /\[lite-lru\]/.test(e.message); }
            // has/peek must NOT throw during onEvict (read-only, allowed).
            reentrant.hasOk = (c.has('a') === true || c.has('a') === false);
            reentrant.peekOk = true; c.peek('a');
        },
    });
    c.put('a', 1); c.put('b', 2);
    c.put('c', 3); // triggers onEvict -> exercises every reentrant branch above
    assert.equal(reentrant.get, true, 'get() must throw a tagged error when reentered from onEvict');
    assert.equal(reentrant.delete, true, 'delete() must throw a tagged error when reentered from onEvict');
    assert.equal(reentrant.clear, true, 'clear() must throw a tagged error when reentered from onEvict');
    assert.equal(reentrant.purgeStale, true, 'purgeStale() must throw a tagged error when reentered from onEvict');
    assert.equal(reentrant.hasOk, true, 'has() must be allowed (no throw) during onEvict');
    assert.equal(reentrant.peekOk, true, 'peek() must be allowed (no throw) during onEvict');
    validate(c);
});

test('Arc: a TTL-stale get() is a miss AND an eviction -- no promotion, NOT ghosted, p unchanged', () => {
    let now = 0;
    const clock = () => now;
    let evKey, evVal;
    const c = new Arc(4, { ttl: 10, clock, onEvict: (k, v) => { evKey = k; evVal = v; } });
    c.put('stale', 'S'); // enters T1
    assert.equal(segOf(c, 'stale'), ARC_T1);
    const pBefore = c._p;
    const b1Before = c._b1._len, b2Before = c._b2._len;
    now = 100; // well past the 10ms ttl
    assert.equal(c.get('stale'), undefined, 'a stale get must be a MISS');
    assert.equal(evKey, 'stale', 'the stale reap must fire onEvict with the expired key');
    assert.equal(evVal, 'S');
    assert.equal(c.has('stale'), false, 'the reaped key must be gone, not merely unpromoted');
    assert.equal(c._p, pBefore, 'a stale reap must not move p (it is not a capacity REPLACE)');
    assert.equal(c._b1._len, b1Before, 'a stale reap must NOT record a B1 ghost');
    assert.equal(c._b2._len, b2Before, 'a stale reap must NOT record a B2 ghost');
    assert.equal(c.size, 0);
    validate(c);
});

test('Arc: degenerate caps 1/2/3 -- every put churns, segments coherent, ghost bounds hold', () => {
    for (const cap of [1, 2, 3]) {
        const c = new Arc(cap);
        for (let i = 0; i < 300; i++) {
            c.put(i, i);
            assert.equal(c.size, Math.min(cap, i + 1), 'cap-' + cap + ' size drift at ' + i);
            assert.equal(c.get(i), i, 'cap-' + cap + ' just-inserted key missing');
            assert.ok(c._b1._len + c._b2._len <= c._ghostCap, 'cap-' + cap + ' combined ghost over bound');
            assert.ok(c._t1Size + c._b1._len <= c._ghostCap, 'cap-' + cap + ' |T1|+|B1| over bound');
            assert.ok(c._p >= 0 && c._p <= cap, 'cap-' + cap + ' p out of range');
            validate(c);
        }
        c.clear();
        assert.equal(c.size, 0, 'cap-' + cap + ' not empty after clear');
        assert.equal(c._b1._len, 0, 'cap-' + cap + ' B1 not empty after clear');
        assert.equal(c._b2._len, 0, 'cap-' + cap + ' B2 not empty after clear');
        assert.equal(c._p, 0, 'cap-' + cap + ' p not reset after clear');
        validate(c);
    }
});

test('Arc: caps 1..4 sweep -- fill / evict-in-place / delete-all / refill, conservation each step', () => {
    for (let cap = 1; cap <= 4; cap++) {
        const c = new Arc(cap);
        for (let i = 0; i < cap; i++) c.put(i, i);
        assert.equal(c.size, cap);
        validate(c);
        // Over-capacity churn: every put evicts exactly one, size held at cap.
        for (let i = cap; i < cap + 50; i++) {
            c.put(i, i);
            assert.equal(c.size, cap, 'cap-' + cap + ' size drift on churn at ' + i);
            validate(c);
        }
        // Promote residents to T2 (2nd touch), keep churning.
        for (let i = cap + 50; i < cap + 80; i++) {
            const anyKey = c._keys[c._t1Head !== -1 ? c._t1Head : c._t2Head];
            c.get(anyKey);
            c.put(i, i);
            assert.equal(c.size, cap);
            validate(c);
        }
        // Delete-all, then refill to capacity: the free list + ghosts must be intact.
        for (const [key] of c.entries()) { /* touch keys() path once */ void key; }
        const keys = [];
        c._store.indexEntries((k) => keys.push(k));
        for (const k of keys) assert.equal(c.delete(k), true, 'cap-' + cap + ' delete miss');
        assert.equal(c.size, 0, 'cap-' + cap + ' not empty after delete-all');
        validate(c);
        for (let i = 0; i < cap; i++) c.put(1000 + i, i);
        assert.equal(c.size, cap, 'cap-' + cap + ' refill short after teardown');
        validate(c);
    }
});

test('Arc: delete is not an eviction -- it never records a ghost or moves p', () => {
    const c = new Arc(4);
    for (let i = 0; i < 4; i++) c.put(i, i);
    const pBefore = c._p;
    const b1Before = c._b1._len, b2Before = c._b2._len;
    assert.equal(c.delete(0), true);
    assert.equal(c.delete(999), false, 'deleting an absent key returns false');
    assert.equal(c._p, pBefore, 'delete must not move p');
    assert.equal(c._b1._len, b1Before, 'delete must not add to B1');
    assert.equal(c._b2._len, b2Before, 'delete must not add to B2');
    assert.equal(c.size, 3);
    validate(c);
});

test('Arc: onEvict fires LAST with the right (key, value); reentrant mutation throws', () => {
    let fired = 0, seenKey, seenVal, reentryThrew = false;
    const c = new Arc(2, {
        onEvict: (k, v) => {
            fired++; seenKey = k; seenVal = v;
            try { c.put('reentry', 0); } catch (e) { reentryThrew = /\[lite-lru\]/.test(e.message); }
        },
    });
    c.put('a', 10); c.put('b', 20); // full
    c.put('c', 30); // evicts the T1 LRU 'a'
    assert.equal(fired, 1);
    assert.equal(seenKey, 'a');
    assert.equal(seenVal, 10);
    assert.ok(reentryThrew, 'a mutating reentry from onEvict must throw');
    assert.equal(c.size, 2);
    validate(c);
});

test('Arc: capacity fail-closed -- non-integer / < 1 throws a tagged RangeError', () => {
    for (const bad of [0, -1, 1.5, NaN, '4', null, undefined]) {
        assert.throws(
            () => new Arc(bad),
            (err) => err instanceof RangeError && err.message.includes('[lite-lru]'),
            'capacity=' + String(bad) + ' did not throw a tagged RangeError');
    }
    // A valid construction stands.
    const c = new Arc(3);
    assert.equal(c.capacity, 3);
    assert.equal(c.size, 0);
});

test('Arc: int backing -- strict typed-array ghosts, byte-identical semantics', () => {
    const c = new Arc(4, { keys: 'int' });
    for (let i = 0; i < 200; i++) { if (c.get(i % 12) === undefined) c.put(i % 12, i); }
    validate(c);
    assert.ok(c._b1._ring instanceof Int32Array, 'int B1 must use a typed ring');
    assert.ok(c._b2._ring instanceof Int32Array, 'int B2 must use a typed ring');
    // A non-integer key on an int cache fails closed.
    assert.throws(() => c.get('nope'), (e) => e instanceof TypeError && e.message.includes('[lite-lru]'));
});
