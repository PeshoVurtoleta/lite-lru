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
import { validate } from '../validate.mjs';
import {
    spawnTtlConfig, parseTtlResult, TTL_MEMBER_NAMES, TTL_CLOCKS, TTL_N,
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

/**
 * The dense-backing zero-alloc counter (decisions/0029): the direct-mapped index is
 * the `_ixSlot` (k -> slot) + `_gen` (generation stamp) typed arrays -- fixed at
 * construction, so the delta across the window must be 0. Dense stores expose `_gen`
 * (not `_ixKey`), so it needs its own counter reader.
 */
function denseGrows(c) {
    return c._store._ixSlot.buffer.byteLength + c._store._gen.buffer.byteLength;
}

// A dense domain comfortably larger than CAP so a cycling key stream drives real
// insert+evict churn, yet bounded so keys never leave [0, DENSE_MK] (fail-closed door).
const DENSE_MK = CAP * 4 - 1;
const DENSE_SPAN = CAP * 4;

/** dense get-hit: a pre-filled at-capacity dense cache; every op is a resident direct-map
 *  hit + relink (NO hash, NO probe). Scavenge-clean; the index buffers never grow. */
function denseGetHitScenario(m) {
    return {
        name: m.name + ' get-hit (dense)',
        setup() {
            const c = new m.Ctor(CAP, { keys: 'dense', maxKey: DENSE_MK });
            for (let i = 0; i < CAP; i++) c.put(i, (i * 3 + 1) & 0xffff);
            return { c, acc: 0 };
        },
        hot(s, n) {
            const c = s.c;
            let acc = s.acc | 0;
            for (let i = 0; i < n; i++) acc = (acc + (c.get(i & MASK) | 0)) | 0; // int32-wrapped
            s.acc = acc | 0;
        },
        statsOf(s) { return { grows: denseGrows(s.c) }; },
    };
}

/** dense put-churn: keys cycle over a domain 4x capacity, so most ops insert a fresh key
 *  and evict the LRU (a generation-stamp write + a stamp invalidate) -- the rest update in
 *  place. Bounded to [0, DENSE_MK] so the fail-closed key door never fires. Scavenge-clean. */
function densePutChurnScenario(m) {
    return {
        name: m.name + ' put-churn (dense)',
        setup() {
            const c = new m.Ctor(CAP, { keys: 'dense', maxKey: DENSE_MK });
            for (let i = 0; i < CAP; i++) c.put(i, i & 0xffff);
            return { c, k: 0 };
        },
        hot(s, n) {
            const c = s.c;
            let k = s.k | 0;
            for (let i = 0; i < n; i++) {
                c.put(k, k & 0xffff);          // SMI value; direct-map, no hash/probe
                k = (k + 1) % DENSE_SPAN;      // cycle within the bounded dense domain
            }
            s.k = k | 0;
        },
        statsOf(s) { return { grows: denseGrows(s.c) }; },
    };
}

/** 26 int scenarios (get-hit + put-churn per member) + 2 dense scenarios on the
 *  reference member (the dense backing is a shared substrate, LiteLru proves it). */
const scenarios = [];
for (let i = 0; i < MEMBERS.length; i++) {
    scenarios.push(getHitScenario(MEMBERS[i]));
    scenarios.push(putChurnScenario(MEMBERS[i]));
}
scenarios.push(denseGetHitScenario(MEMBERS[0]));
scenarios.push(densePutChurnScenario(MEMBERS[0]));

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
 * TTL zero-alloc lanes (ROADMAP S17 N1 / A1 / A2). The transient boxing on the TTL
 * path (an expiry double crossing a non-inlined return, or a boxed clock() result)
 * is invisible to a heap-delta gate and only shows up after a TTL-OFF warm-up of the
 * same class de-inlines the expiry maths -- and only when epoch/frac/default clocks
 * do NOT share a process (the clock() call site otherwise goes polymorphic). So each
 * (member, clock) config runs in its OWN child launched with the small semi-space,
 * measuring get-hit / iteration / put-churn / stale-reap at N and 8N. Every lane must
 * be 0 scavenges; the boxing-expiry control in t9 proves the instrument has teeth.
 */
for (let mi = 0; mi < TTL_MEMBER_NAMES.length; mi++) {
    for (let ci = 0; ci < TTL_CLOCKS.length; ci++) {
        const member = TTL_MEMBER_NAMES[mi];
        const clock = TTL_CLOCKS[ci];
        test('zero-GC TTL: ' + member + ' (' + clock + ' clock)', () => {
            const parsed = parseTtlResult(spawnTtlConfig(member, clock, false));
            assert.ok(parsed.ok, 'TTL child failed: ' + parsed.error);
            for (const shape in parsed.result) {
                const [nLo, nHi] = parsed.result[shape];
                assert.equal(nHi, 0,
                    member + ' ' + shape + ' (' + clock + '): ' + nHi + ' scavenges at 8N=' +
                    (8 * TTL_N) + ' (transient TTL-path boxing)');
                assert.equal(nLo, 0,
                    member + ' ' + shape + ' (' + clock + '): ' + nLo + ' scavenges at N=' + TTL_N);
            }
        });
    }
}

test('zero-GC TTL: W-TinyLFU int keys below -2^30 (A8)', () => {
    const parsed = parseTtlResult(spawnTtlConfig('wtlfu-neg', '', false));
    assert.ok(parsed.ok, 'wtlfu-neg child failed: ' + parsed.error);
    const [nLo, nHi] = parsed.result['wtlfu-neg'];
    assert.equal(nHi, 0, 'W-TinyLFU neg-key churn: ' + nHi + ' scavenges at 8N (hash left Smi range)');
    assert.equal(nLo, 0, 'W-TinyLFU neg-key churn: ' + nLo + ' scavenges at N');
});

test('perf-gate MUST CATCH: boxing-expiry control trips the TTL scavenge lane', () => {
    const parsed = parseTtlResult(spawnTtlConfig('LiteLru', 'epoch', true));
    assert.ok(parsed.ok, 'broken TTL child failed: ' + parsed.error);
    const [, nHi] = parsed.result['putchurn-broken'];
    assert.ok(nHi > 0,
        'the boxing-expiry control produced ' + nHi + ' scavenges at 8N -- the TTL lane has no teeth');
});

/**
 * F7 (ROADMAP S17 A7): clear() is O(size), NOT O(capacity). Before the fix, clear()
 * swept the whole slot store (SlotStore.reset), so emptying a nearly-empty cache cost
 * time proportional to its CAPACITY -- 0.8 us at cap 16 vs 644 us at cap 1M with <= 8
 * residents (the audit measurement). The fix walks only the resident roster and frees
 * those slots, so clear time now tracks residents, not geometry.
 *
 * The gate: with the SAME tiny residency (8 keys), clearing a cap-1M cache must not be
 * more than 4x the time of clearing a cap-16 cache. It is measured on the DENSE backing
 * (index clear is an O(1) epoch bump, so the slot reclamation is isolated) as the median
 * of several runs -- a timing test is noisy, so a single sample is not trusted, and the
 * threshold (4x) is far above measurement jitter yet far below the ~40000x an O(capacity)
 * clear would show. NOT a zero-GC scenario: clear is a cold path and its roster array
 * may allocate; this asserts the ASYMPTOTE, not the byte budget.
 */
test('F7: clear() is O(size) -- cap 1M vs cap 16 clear time (<= 8 residents) stays under 4x', () => {
    const RESIDENTS = 8;
    const CYCLES = 200;   // put 8 + clear, timed as one batch (matches the 200-cycle conservation gate)
    const RUNS = 11;      // odd count -> a clean median, robust to a stray slow sample

    function timedClearer(cap) {
        const c = new LiteLru(cap, { keys: 'dense', maxKey: cap - 1 });
        for (let w = 0; w < 100; w++) { for (let i = 0; i < RESIDENTS; i++) c.put(i, i); c.clear(); } // JIT warm-up
        return () => {
            const t0 = performance.now();
            for (let r = 0; r < CYCLES; r++) {
                for (let i = 0; i < RESIDENTS; i++) c.put(i, i);
                c.clear();
            }
            return performance.now() - t0;
        };
    }

    const timeBig = timedClearer(1000000);
    const timeSmall = timedClearer(16);
    const bigs = [], smalls = [];
    for (let r = 0; r < RUNS; r++) { bigs.push(timeBig()); smalls.push(timeSmall()); }
    bigs.sort((a, b) => a - b);
    smalls.sort((a, b) => a - b);
    const mid = (RUNS - 1) >> 1;
    const bigMed = bigs[mid], smallMed = smalls[mid];
    const ratio = bigMed / smallMed;
    assert.ok(ratio < 4,
        'clear O(size): cap 1M / cap 16 median ratio ' + ratio.toFixed(2) +
        ' (big ' + bigMed.toFixed(3) + 'ms, small ' + smallMed.toFixed(3) + 'ms per ' + CYCLES + ' cycles)');
});

/**
 * F7 conservation: 200 clear cycles keep validate() OK and size + freeListLength ==
 * capacity on every backing. The O(size) clear pushes freed slots onto the EXISTING
 * free stack rather than rebuilding it, so this proves the conservation invariant
 * (no slot lost or duplicated) survives the new path across all 13 members.
 */
test('F7: 200 clear cycles keep validate() OK and size + freeListLength == capacity (all members, all backings)', () => {
    const MEMBERS_ALL = [LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro, LruK, Mq, Car];
    const cap = 64;
    const backings = [{}, { keys: 'int' }, { keys: 'dense', maxKey: 255 }];
    for (const Ctor of MEMBERS_ALL) {
        for (const opts of backings) {
            const c = new Ctor(cap, opts);
            for (let cyc = 0; cyc < 200; cyc++) {
                // Partially fill (below and at capacity across cycles), then clear.
                const fill = (cyc % 3 === 0) ? 8 : (cyc % 3 === 1) ? cap : cap + 40; // overfill -> eviction churn too
                for (let i = 0; i < fill; i++) c.put(i & 255, i & 0xffff);
                c.clear();
                assert.equal(c.size, 0, Ctor.name + ' size after clear');
                assert.equal(c.size + c._store.freeListLength(), c._capacity,
                    Ctor.name + ' conservation after clear (cycle ' + cyc + ')');
                validate(c); // throws on the first invariant violation (uses activeListsOf internally)
            }
        }
    }
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
