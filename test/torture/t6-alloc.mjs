/**
 * t6 -- the zero-alloc gate (+ writes-per-hit), the THING UNDER TEST.
 *
 * HONEST POSTURE (D3): the DLL/slot layer is STRICTLY zero-alloc; the default Map
 * layer is AMORTIZED-stable (its internal resize can allocate). This tier isolates
 * the STRICT claim for the Map path by running the hot loop on a PRE-FILLED,
 * at-capacity cache with a FIXED key set -- get(existing) and put(update existing)
 * only touch Map.get + the Int32Array link columns, so no Map resize is ever in
 * scope.
 *
 * S3 (decisions/0011): the INTEGER substrate backing (`keys: 'int'`) is STRICT with
 * NO pre-fill caveat -- Gate INT churns NEW integer keys from an EMPTY cache so
 * every op inserts + evicts (idxSet + backshift idxDelete), and asserts maxMajor:0
 * AND that the `_ixSlot` / `_ixKey` index buffers never grow. The whole point of
 * the substrate is that even the keyed index never allocates.
 *
 * Two channels, separate windows (one measurement at a time):
 *   Gate 1  the get() re-hit loop (relinks the DLL every op)   -- zero-alloc.
 *   Gate 2  the put(update) loop (rewrites value + relinks)    -- zero-alloc.
 *   Each also runs the RETAINED-alloc channel runOpsGate cannot see.
 *
 * Structural facts a heap gate cannot check: _next.buffer.byteLength and
 * _prev.buffer.byteLength are unchanged across every window (the backing stores
 * never grow).
 *
 * Plus the DEBATE-item-2 pitch, MEASURED: classic LRU's writes per hit. A head
 * re-hit early-returns (0 writes); a non-head re-hit relinks a small constant. S1
 * PINS the baseline; the comparative `< LiteLru` assertion lands at S4 (SIEVE).
 *
 * LLRU_TORTURE_BREAK=1 injects a retained allocation into the hot body so the gate
 * rejects the window; T9 exercises the same alloc lane in-process.
 */

import { LiteLru } from '../../Lru.js';
import {
    runOpsGate, runAllocsGate, BREAK, check, die,
    CountedLru, LRU_WRITES_HEAD_REHIT, LRU_WRITES_INTERIOR_REHIT, LRU_WRITES_TAIL_REHIT,
} from './harness.mjs';

const CAP = 4096;      // power of 2 so the hot body masks its key with & MASK
const MASK = CAP - 1;
const OPS = 60000;
const WARMUP = 4000;

/** Retained sink for the BREAK control -- survives GC so arrayBuffers grows. */
const leak = [];

export async function run() {
    // A pre-filled at-capacity cache with a FIXED integer key set 0..CAP-1.
    const cache = new LiteLru(CAP);
    for (let i = 0; i < CAP; i++) cache.put(i, i * 3 + 1);
    check(cache.size === CAP, () => 't6: pre-fill did not reach capacity');

    const nextBytesBefore = cache._next.buffer.byteLength;
    const prevBytesBefore = cache._prev.buffer.byteLength;
    const sink = new Int32Array(1);

    // --- Gate 1: the get() re-hit loop (relinks the DLL every op) ----------------
    // Cycling keys 0,1,2,... promotes a DIFFERENT non-head slot each op, so the
    // relink path (not just the fast path) runs on essentially every iteration.
    const getHot = (i) => {
        sink[0] += cache.get(i & MASK) | 0;
        if (BREAK) leak.push(new Int32Array(64)); // control: retained growth
    };
    const g1 = runOpsGate(getHot, { ops: OPS, warmup: WARMUP });
    check(cache._next.buffer.byteLength === nextBytesBefore,
        () => 't6 Gate 1: _next.buffer grew ' + nextBytesBefore + ' -> ' + cache._next.buffer.byteLength);
    check(cache._prev.buffer.byteLength === prevBytesBefore,
        () => 't6 Gate 1: _prev.buffer grew ' + prevBytesBefore + ' -> ' + cache._prev.buffer.byteLength);
    if (!g1.report.ok) {
        const g = g1.summary.gc;
        die('t6 Gate 1 (get re-hit) ops gate rejected -- verdict=' + g1.report.verdict +
            ' source=' + g1.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
            (BREAK ? ' (LLRU_TORTURE_BREAK control -- expected)' : ''));
    }
    if (BREAK) die('t6: LLRU_TORTURE_BREAK injected allocations but the gate passed');

    // Retained-alloc channel (async-gc blind spot). BREAK's branch is dead in a
    // clean run (it dies at Gate 1 above), so this measures the pure zero-alloc body.
    const g1a = runAllocsGate(getHot, { iterations: 50000, batches: 8 });
    if (!g1a.ok) {
        die('t6 Gate 1 (get re-hit) retained-alloc gate rejected -- verdict=' + g1a.report.verdict +
            ' settled=' + g1a.result.settled + ' bytesPerCall=' + g1a.bytesPerCall);
    }

    // --- Gate 2: the put(update existing) loop -----------------------------------
    // Same fixed key set, so no key is added or removed: Map.get + a _vals write +
    // a relink. Zero-alloc, no Map resize.
    const putHot = (i) => {
        cache.put(i & MASK, i);
        if (BREAK) leak.push(new Int32Array(64));
    };
    const g2 = runOpsGate(putHot, { ops: OPS, warmup: WARMUP });
    check(cache._next.buffer.byteLength === nextBytesBefore,
        () => 't6 Gate 2: _next.buffer grew ' + nextBytesBefore + ' -> ' + cache._next.buffer.byteLength);
    check(cache._prev.buffer.byteLength === prevBytesBefore,
        () => 't6 Gate 2: _prev.buffer grew ' + prevBytesBefore + ' -> ' + cache._prev.buffer.byteLength);
    check(cache.size === CAP, () => 't6 Gate 2: put(update) changed size to ' + cache.size);
    if (!g2.report.ok) {
        const g = g2.summary.gc;
        die('t6 Gate 2 (put update) ops gate rejected -- verdict=' + g2.report.verdict +
            ' source=' + g2.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const g2a = runAllocsGate(putHot, { iterations: 50000, batches: 8 });
    if (!g2a.ok) {
        die('t6 Gate 2 (put update) retained-alloc gate rejected -- verdict=' + g2a.report.verdict +
            ' settled=' + g2a.result.settled + ' bytesPerCall=' + g2a.bytesPerCall);
    }

    // --- Gate INT: the integer substrate backing -- STRICT, NO pre-fill caveat ---
    // Churn NEW integer keys from an EMPTY cache: after warm-up every op inserts a
    // fresh key AND evicts the LRU, exercising the open-addressed idxSet + the
    // backward-shift idxDelete every iteration. Values are small ints (SMI, no
    // boxing) so the ONLY allocation frontier under test is the keyed index -- and
    // it must be zero, with the index backing stores never growing (decisions/0011).
    const icache = new LiteLru(CAP, { keys: 'int' });
    const iNextBytes = icache._next.buffer.byteLength;
    const iPrevBytes = icache._prev.buffer.byteLength;
    const ixSlotBytes = icache._store._ixSlot.buffer.byteLength;
    const ixKeyBytes = icache._store._ixKey.buffer.byteLength;
    let ik = 0;
    const intHot = () => {
        icache.put(ik, ik & 0xffff); // fresh int key each op; SMI value (no boxing)
        ik++;
    };
    const gi = runOpsGate(intHot, { ops: OPS, warmup: WARMUP });
    check(icache._next.buffer.byteLength === iNextBytes,
        () => 't6 Gate INT: _next.buffer grew ' + iNextBytes + ' -> ' + icache._next.buffer.byteLength);
    check(icache._prev.buffer.byteLength === iPrevBytes,
        () => 't6 Gate INT: _prev.buffer grew ' + iPrevBytes + ' -> ' + icache._prev.buffer.byteLength);
    check(icache._store._ixSlot.buffer.byteLength === ixSlotBytes,
        () => 't6 Gate INT: _ixSlot.buffer grew ' + ixSlotBytes + ' -> ' + icache._store._ixSlot.buffer.byteLength);
    check(icache._store._ixKey.buffer.byteLength === ixKeyBytes,
        () => 't6 Gate INT: _ixKey.buffer grew ' + ixKeyBytes + ' -> ' + icache._store._ixKey.buffer.byteLength);
    check(icache.size === CAP, () => 't6 Gate INT: churn did not stay at capacity (size ' + icache.size + ')');
    if (!gi.report.ok) {
        const g = gi.summary.gc;
        die('t6 Gate INT (int churn) ops gate rejected -- verdict=' + gi.report.verdict +
            ' source=' + gi.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gia = runAllocsGate(intHot, { iterations: 50000, batches: 8 });
    if (!gia.ok) {
        die('t6 Gate INT (int churn) retained-alloc gate rejected -- verdict=' + gia.report.verdict +
            ' settled=' + gia.result.settled + ' bytesPerCall=' + gia.bytesPerCall);
    }

    // --- Gate 3: writes-per-hit, MEASURED (DEBATE item 2) ------------------------
    // A CountedLru (Proxy-counted link columns) is used ONLY here, never on a
    // measured zero-alloc path. It pins classic LRU's relink cost so a refactor
    // that quietly changes the write count trips this gate.
    const N = 8;
    const counted = new CountedLru(N);
    for (let i = 0; i < N; i++) counted.put(i, i); // head = N-1, tail = 0

    counted.resetWrites();
    counted.get(N - 1); // re-hit the MRU: the fast path early-returns
    const headWrites = counted.writes();
    check(headWrites === LRU_WRITES_HEAD_REHIT,
        () => 't6 Gate 3: head re-hit wrote ' + headWrites + ' links, expected ' + LRU_WRITES_HEAD_REHIT);

    // rebuild (the get above moved things); re-hit an interior slot
    const counted2 = new CountedLru(N);
    for (let i = 0; i < N; i++) counted2.put(i, i);
    counted2.resetWrites();
    counted2.get(4); // an interior slot (both neighbours present)
    const interiorWrites = counted2.writes();
    check(interiorWrites === LRU_WRITES_INTERIOR_REHIT,
        () => 't6 Gate 3: interior re-hit wrote ' + interiorWrites + ' links, expected ' + LRU_WRITES_INTERIOR_REHIT);

    const counted3 = new CountedLru(N);
    for (let i = 0; i < N; i++) counted3.put(i, i);
    counted3.resetWrites();
    counted3.get(0); // the tail
    const tailWrites = counted3.writes();
    check(tailWrites === LRU_WRITES_TAIL_REHIT,
        () => 't6 Gate 3: tail re-hit wrote ' + tailWrites + ' links, expected ' + LRU_WRITES_TAIL_REHIT);

    // The honest S1 assertion: the head re-hit is a genuine 0-write fast path, and
    // a non-head re-hit costs a small bounded constant. (SIEVE's 1-bit hit beats
    // this at S4; that comparative lands there, not here.)
    check(LRU_WRITES_HEAD_REHIT === 0 && LRU_WRITES_INTERIOR_REHIT > 0,
        () => 't6 Gate 3: the writes-per-hit baseline is not shaped {head:0, non-head:>0}');
}
