/**
 * @zakkster/lite-lru -- the HARD zero-allocation perf gate (@zakkster/lite-perf-gate).
 *
 * Run:  node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs
 *
 * This is a node:test-native COMPLEMENT to torture t6, not a replacement. It gates
 * the `keys: 'int'` backing (decisions/0011: STRICT zero-alloc -- even the keyed
 * open-addressed index never grows) via scavenge scaling at N and k*N, with the
 * external / old-gen lanes pinned to 0. The Map-backing hot paths are AMORTIZED
 * (their internal resize may scavenge) and are covered by t6, NOT here.
 *
 * Two scenarios per member (get-hit + put-churn), all `keys: 'int'`:
 *   - get-hit:   a pre-filled at-capacity cache, every op a resident hit (relink).
 *   - put-churn: churn fresh int keys at capacity, every op insert + evict.
 * Both are strict zero-alloc: SMI values (no boxing), int32-wrapped accumulator
 * (never promoted to a heap double), and the int index backing store fixed at
 * construction. The `grows` counter reads that index's byte length; its delta
 * across the window MUST be 0 (the counter lane), sourced uniformly per member.
 *
 * mustFail: an object-key churn on the Map backing that allocates one `{ id }` per
 * op -- it MUST trip the gate, proving the instrument has teeth.
 *
 * The Counted* Proxy wrappers pin exact writes-per-hit and would themselves
 * allocate + trap; they stay OUT of every measured window and appear ONLY in the
 * separate plain writes-pin cross-check below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { zgcSuite } from '@zakkster/lite-perf-gate';
import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro, LruK, Mq, Car } from '../../Lru.js';
import {
    CountedLru, LRU_WRITES_HEAD_REHIT, LRU_WRITES_INTERIOR_REHIT, LRU_WRITES_TAIL_REHIT,
    CountedSieve, SIEVE_WRITES_HIT_LINKS, SIEVE_WRITES_HIT_VIS,
    CountedS3Fifo, S3FIFO_WRITES_HIT_LINKS, S3FIFO_WRITES_HIT_VIS,
    WTINYLFU_WRITES_WINDOW_MRU_REHIT,
    LIRS_WRITES_LIR_TOP_REHIT,
    LFU_WRITES_FASTPATH, LFU_WRITES_MAX,
    CLOCKPRO_WRITES_HIT_LINKS, CLOCKPRO_WRITES_HIT_ST,
    CountedLruK, LRUK_WRITES_HIT_WARM, LRUK_WRITES_HIT_PROMOTE, LRUK_WRITES_HIT_STAMPS,
    CountedMq, MQ_WRITES_HIT_FASTPATH, MQ_WRITES_HIT_RELINK, MQ_WRITES_MAX, MQ_STAMPS_ACCESS,
    CountedCar, CAR_WRITES_HIT_LINKS, CAR_WRITES_HIT_ST,
} from '../torture/harness.mjs';

const CAP = 4096;       // power of 2 so the hot body masks its key with & MASK
const MASK = CAP - 1;

/** The 13 shipped members, in canonical order. */
const MEMBERS = [
    { name: 'LiteLru', Ctor: LiteLru },
    { name: 'Sieve', Ctor: Sieve },
    { name: 'S3Fifo', Ctor: S3Fifo },
    { name: 'WTinyLfu', Ctor: WTinyLfu },
    { name: 'Slru', Ctor: Slru },
    { name: 'TwoQ', Ctor: TwoQ },
    { name: 'Arc', Ctor: Arc },
    { name: 'Lirs', Ctor: Lirs },
    { name: 'Lfu', Ctor: Lfu },
    { name: 'ClockPro', Ctor: ClockPro },
    { name: 'LruK', Ctor: LruK },
    { name: 'Mq', Ctor: Mq },
    { name: 'Car', Ctor: Car },
];

/**
 * The zero-alloc counter shared by every scenario: the `keys: 'int'` store's
 * open-addressed index backing (decisions/0011). The substrate promises even the
 * keyed index never grows -- so the delta across the whole window must be 0. Every
 * int-backed member uses the same IntSlotStore, so `_store._ixSlot`/`_ixKey` are
 * present uniformly.
 */
function intGrows(c) {
    return c._store._ixSlot.buffer.byteLength + c._store._ixKey.buffer.byteLength;
}

/** get-hit: a pre-filled at-capacity int cache; every op is a resident hit + relink. */
function getHitScenario(m) {
    return {
        name: m.name + ' get-hit (int)',
        setup() {
            const c = new m.Ctor(CAP, { keys: 'int' });
            for (let i = 0; i < CAP; i++) c.put(i, (i * 3 + 1) & 0xffff);
            return { c, acc: 0 };
        },
        hot(s, n) {
            const c = s.c;
            let acc = s.acc | 0;
            for (let i = 0; i < n; i++) acc = (acc + (c.get(i & MASK) | 0)) | 0; // int32-wrapped: never a heap double
            s.acc = acc | 0;
        },
        statsOf(s) { return { grows: intGrows(s.c) }; },
    };
}

/** put-churn: fresh int keys at capacity; every op insert + evict (idxSet + backshift idxDelete). */
function putChurnScenario(m) {
    return {
        name: m.name + ' put-churn (int)',
        setup() {
            const c = new m.Ctor(CAP, { keys: 'int' });
            for (let i = 0; i < CAP; i++) c.put(i, i & 0xffff);
            return { c, k: CAP };
        },
        hot(s, n) {
            const c = s.c;
            let k = s.k | 0;
            for (let i = 0; i < n; i++) { c.put(k, k & 0xffff); k = (k + 1) | 0; } // SMI value; fresh key each op
            s.k = k | 0;
        },
        statsOf(s) { return { grows: intGrows(s.c) }; },
    };
}

/** 26 scenarios: get-hit + put-churn for each of the 13 members. */
const scenarios = [];
for (let i = 0; i < MEMBERS.length; i++) {
    scenarios.push(getHitScenario(MEMBERS[i]));
    scenarios.push(putChurnScenario(MEMBERS[i]));
}

/**
 * The teeth: an object-key churn on the Map backing that allocates one `{ id }` per
 * op. It MUST trip the gate (scavenges scale with n). statsOf returns a constant so
 * the failure is the allocation lanes, not a missing-counter artifact.
 */
const mustFailAlloc = {
    name: 'LiteLru object-key churn (MUST allocate)',
    setup() { return { c: new LiteLru(CAP) }; },
    hot(s, n) { const c = s.c; for (let i = 0; i < n; i++) c.put({ id: i }, i); }, // fresh object key per op -> heap churn
    statsOf() { return { grows: 0 }; },
};

// Thresholds. Every ALLOCATION-detecting lane is pinned to the strictest 0: no
// scavenge across N and k*N (the primary transient-allocation detector), no old-gen
// activity, no external / arrayBuffers growth, and a 0 delta on the `grows` counter
// (the int index backing). Those lanes are the teeth (mustFail proves it).
//
// The retained-heap lane keeps perf-gate's own default (64 KB): a heapUsed delta
// bracketed by two forced collections is inherently noisy (measured -0.2 .. ~8 KB on
// a proven zero-alloc int path, member-independent, with scavenges always 0, and the
// node:test runner's own churn lands in the window too). It is a leak BACKSTOP, not
// the zero-alloc proof; a real leak over a 1.6M-op window would scale to MB, far past
// the default, and the scavenge lane catches transient allocation regardless. Pinning
// it below the instrument's noise floor would make the gate flake, not stronger.
zgcSuite({
    N: 200000,
    k: 8,
    maxScavenges: 0,
    maxRetainedKB: 64,
    maxOldGen: 0,
    maxArrayBuffersKB: 0,
    counters: { grows: 0 },
    scenarios,
    mustFail: [mustFailAlloc],
});

/**
 * Writes-pin cross-check (plain node:test, NO measured window). The Counted* Proxy
 * wrappers allocate + trap, so they never appear in a gated scenario; here they
 * confirm the harness's writes-per-hit pins still hold, and the pins equal their
 * documented literals (a drift tripwire on the shipped hot-path shape).
 */
test('perf-gate writes-pin cross-check: harness constants match the shipped hot paths', () => {
    // Documented literals (drift guard): LRU 0/5/4, Sieve 0+1, S3Fifo 0+1,
    // WTinyLfu 0, Lirs 0, Lfu 1/14, ClockPro 0+1, LruK 0/5 links + 2 stamps.
    assert.equal(LRU_WRITES_HEAD_REHIT, 0);
    assert.equal(LRU_WRITES_INTERIOR_REHIT, 5);
    assert.equal(LRU_WRITES_TAIL_REHIT, 4);
    assert.equal(SIEVE_WRITES_HIT_LINKS, 0);
    assert.equal(SIEVE_WRITES_HIT_VIS, 1);
    assert.equal(S3FIFO_WRITES_HIT_LINKS, 0);
    assert.equal(S3FIFO_WRITES_HIT_VIS, 1);
    assert.equal(WTINYLFU_WRITES_WINDOW_MRU_REHIT, 0);
    assert.equal(LIRS_WRITES_LIR_TOP_REHIT, 0);
    assert.equal(LFU_WRITES_FASTPATH, 1);
    assert.equal(LFU_WRITES_MAX, 14);
    assert.equal(CLOCKPRO_WRITES_HIT_LINKS, 0);
    assert.equal(CLOCKPRO_WRITES_HIT_ST, 1);
    assert.equal(LRUK_WRITES_HIT_WARM, 0);
    assert.equal(LRUK_WRITES_HIT_PROMOTE, 5);
    assert.equal(LRUK_WRITES_HIT_STAMPS, 2);
    assert.equal(MQ_WRITES_HIT_FASTPATH, 0);
    assert.equal(MQ_WRITES_HIT_RELINK, 5);
    assert.equal(MQ_WRITES_MAX, 33);
    assert.equal(MQ_STAMPS_ACCESS, 3);
    assert.equal(CAR_WRITES_HIT_LINKS, 0);
    assert.equal(CAR_WRITES_HIT_ST, 1);

    const N = 8;

    // LiteLru: head re-hit early-returns (0); a non-head re-hit relinks a small constant.
    const lHead = new CountedLru(N);
    for (let i = 0; i < N; i++) lHead.put(i, i);
    lHead.resetWrites(); lHead.get(N - 1);
    assert.equal(lHead.writes(), LRU_WRITES_HEAD_REHIT, 'LRU head re-hit writes');

    const lInt = new CountedLru(N);
    for (let i = 0; i < N; i++) lInt.put(i, i);
    lInt.resetWrites(); lInt.get(4);
    assert.equal(lInt.writes(), LRU_WRITES_INTERIOR_REHIT, 'LRU interior re-hit writes');

    const lTail = new CountedLru(N);
    for (let i = 0; i < N; i++) lTail.put(i, i);
    lTail.resetWrites(); lTail.get(0);
    assert.equal(lTail.writes(), LRU_WRITES_TAIL_REHIT, 'LRU tail re-hit writes');

    // Sieve + S3Fifo: a hit relinks NOTHING (0) and sets exactly one visited byte (1),
    // at the head, an interior slot AND the tail alike.
    for (const probe of [N - 1, 4, 0]) {
        const cs = new CountedSieve(N);
        for (let i = 0; i < N; i++) cs.put(i, i);
        cs.resetWrites(); cs.get(probe);
        assert.equal(cs.writes(), SIEVE_WRITES_HIT_LINKS, 'Sieve hit links at ' + probe);
        assert.equal(cs.visWrites(), SIEVE_WRITES_HIT_VIS, 'Sieve hit vis at ' + probe);

        const ct = new CountedS3Fifo(N);
        for (let i = 0; i < N; i++) ct.put(i, i);
        ct.resetWrites(); ct.get(probe);
        assert.equal(ct.writes(), S3FIFO_WRITES_HIT_LINKS, 'S3Fifo hit links at ' + probe);
        assert.equal(ct.visWrites(), S3FIFO_WRITES_HIT_VIS, 'S3Fifo hit vis at ' + probe);
    }

    // LruK: a warm hit relinks NOTHING (0) + 2 stamps; a cold->warm promotion is exactly 5 link
    // stores (2 cold-detach + 3 warm-push, non-exceedable) + the same 2 stamps.
    const ck = new CountedLruK(16);
    ck.put(100, 100); ck.get(100);              // key 100 warm
    for (let i = 1; i <= 5; i++) ck.put(i, i);   // cold list head->tail: 5,4,3,2,1
    ck.resetWrites(); ck.get(3);                 // interior cold, warm non-empty -> exactly 5 links
    assert.equal(ck.writes(), LRUK_WRITES_HIT_PROMOTE, 'LruK cold->warm promotion links');
    assert.equal(ck.stamps(), LRUK_WRITES_HIT_STAMPS, 'LruK promotion stamps');
    ck.resetWrites(); ck.get(3);                 // now warm -> 0 links, 2 stamps
    assert.equal(ck.writes(), LRUK_WRITES_HIT_WARM, 'LruK warm hit links');
    assert.equal(ck.stamps(), LRUK_WRITES_HIT_STAMPS, 'LruK warm hit stamps');

    // Mq: an interior re-band hit is exactly 5 links (2 detach + 3 head push) + 3 stamps; an
    // already-MRU-of-band hit relinks NOTHING (0) + the same 3 stamps. Build Q2 non-empty (z) and
    // Q1 = [y, A, x] with A interior (no aging fires: lifeTime 16).
    const cmq = new CountedMq(16);
    cmq.put('z', 1); cmq.get('z'); cmq.get('z'); cmq.get('z'); // z rc4 -> Q2
    cmq.put('x', 1); cmq.get('x');                             // x rc2 -> Q1 head
    cmq.put('A', 1); cmq.get('A'); cmq.get('A');               // A rc3 -> Q1 head
    cmq.put('y', 1); cmq.get('y');                             // y rc2 -> Q1 head; Q1 = [y, A, x]
    cmq.resetWrites(); cmq.get('A');             // rc3->4 (Q1->Q2): interior detach(2)+push(3)=5
    assert.equal(cmq.writes(), MQ_WRITES_HIT_RELINK, 'Mq interior re-band hit links');
    assert.equal(cmq.stamps(), MQ_STAMPS_ACCESS, 'Mq re-band hit stamps');
    cmq.resetWrites(); cmq.get('A');             // rc4->5 still Q2 head: 0 links, 3 stamps
    assert.equal(cmq.writes(), MQ_WRITES_HIT_FASTPATH, 'Mq already-MRU hit links');
    assert.equal(cmq.stamps(), MQ_STAMPS_ACCESS, 'Mq already-MRU hit stamps');

    // Car: a hit relinks NOTHING (0 _next/_prev stores) and sets exactly one _st byte (the
    // reference bit) -- the CLOCK-of-ARC headline (D28.5). The ref-bit CLEARS live on the miss/
    // evict path (REPLACE), never the hit budget.
    const ccar = new CountedCar(N);
    for (let i = 0; i < N; i++) ccar.put(i, i);
    ccar.get(5);
    ccar.resetWrites(); ccar.get(5);
    assert.equal(ccar.writes(), CAR_WRITES_HIT_LINKS, 'Car hit links');
    assert.equal(ccar.stWrites(), CAR_WRITES_HIT_ST, 'Car hit _st stores');
});
