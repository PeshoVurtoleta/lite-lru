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

import { LiteLru, Sieve, S3Fifo, WTinyLfu } from '../../Lru.js';
import {
    runOpsGate, runAllocsGate, BREAK, check, die,
    CountedLru, LRU_WRITES_HEAD_REHIT, LRU_WRITES_INTERIOR_REHIT, LRU_WRITES_TAIL_REHIT,
    CountedSieve, SIEVE_WRITES_HIT_LINKS, SIEVE_WRITES_HIT_VIS,
    CountedS3Fifo, S3FIFO_WRITES_HIT_LINKS, S3FIFO_WRITES_HIT_VIS,
    CountedWTinyLfu, WTINYLFU_WRITES_WINDOW_MRU_REHIT,
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

    // --- Gate SIEVE: the SIEVE member -- STRICT zero-alloc + the 1-bit headline --
    // (decisions/0012) The int-backed Sieve churns NEW integer keys from an EMPTY
    // ring, so after warm-up every op inserts a fresh key AND sweep-evicts a victim
    // (open-addressed idxSet + backward-shift idxDelete + the sweep). NO pre-fill
    // caveat: strict zero-alloc, and _vis / _next / _ixSlot / _ixKey never grow.
    const scache = new Sieve(CAP, { keys: 'int' });
    const sNextBytes = scache._next.buffer.byteLength;
    const sPrevBytes = scache._prev.buffer.byteLength;
    const sVisBytes = scache._vis.buffer.byteLength;
    const sIxSlotBytes = scache._store._ixSlot.buffer.byteLength;
    const sIxKeyBytes = scache._store._ixKey.buffer.byteLength;
    let sk = 0;
    const sieveHot = () => {
        scache.put(sk, sk & 0xffff); // fresh int key each op; SMI value (no boxing)
        sk++;
    };
    const gs = runOpsGate(sieveHot, { ops: OPS, warmup: WARMUP });
    check(scache._next.buffer.byteLength === sNextBytes,
        () => 't6 Gate SIEVE: _next.buffer grew ' + sNextBytes + ' -> ' + scache._next.buffer.byteLength);
    check(scache._prev.buffer.byteLength === sPrevBytes,
        () => 't6 Gate SIEVE: _prev.buffer grew ' + sPrevBytes + ' -> ' + scache._prev.buffer.byteLength);
    check(scache._vis.buffer.byteLength === sVisBytes,
        () => 't6 Gate SIEVE: _vis.buffer grew ' + sVisBytes + ' -> ' + scache._vis.buffer.byteLength);
    check(scache._store._ixSlot.buffer.byteLength === sIxSlotBytes,
        () => 't6 Gate SIEVE: _ixSlot.buffer grew ' + sIxSlotBytes + ' -> ' + scache._store._ixSlot.buffer.byteLength);
    check(scache._store._ixKey.buffer.byteLength === sIxKeyBytes,
        () => 't6 Gate SIEVE: _ixKey.buffer grew ' + sIxKeyBytes + ' -> ' + scache._store._ixKey.buffer.byteLength);
    check(scache.size === CAP, () => 't6 Gate SIEVE: churn did not stay at capacity (size ' + scache.size + ')');
    if (!gs.report.ok) {
        const g = gs.summary.gc;
        die('t6 Gate SIEVE (int churn) ops gate rejected -- verdict=' + gs.report.verdict +
            ' source=' + gs.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gsa = runAllocsGate(sieveHot, { iterations: 50000, batches: 8 });
    if (!gsa.ok) {
        die('t6 Gate SIEVE (int churn) retained-alloc gate rejected -- verdict=' + gsa.report.verdict +
            ' settled=' + gsa.result.settled + ' bytesPerCall=' + gsa.bytesPerCall);
    }

    // The DEBATE-item-2 payoff, MEASURED: a SIEVE hit relinks NOTHING (0 _next/_prev
    // stores) and sets exactly ONE visited byte -- at the HEAD, an INTERIOR slot AND
    // the TAIL alike (vs classic LRU's 0 / 5 / 4). This is the headline the S1 gate
    // deferred to S4.
    const M = 8;
    for (const probe of [M - 1, 4, 0]) { // insertion order: head, interior, tail
        const cs = new CountedSieve(M);
        for (let i = 0; i < M; i++) cs.put(i, i);
        cs.resetWrites();
        cs.get(probe); // a hit
        check(cs.writes() === SIEVE_WRITES_HIT_LINKS,
            () => 't6 Gate SIEVE: hit at ' + probe + ' relinked ' + cs.writes() + ' cells, expected ' + SIEVE_WRITES_HIT_LINKS);
        check(cs.visWrites() === SIEVE_WRITES_HIT_VIS,
            () => 't6 Gate SIEVE: hit at ' + probe + ' wrote ' + cs.visWrites() + ' visited bytes, expected ' + SIEVE_WRITES_HIT_VIS);
    }
    // The comparative, now that both are measured: SIEVE's hit is strictly cheaper
    // than classic LRU's interior/tail relink.
    check(SIEVE_WRITES_HIT_LINKS < LRU_WRITES_INTERIOR_REHIT && SIEVE_WRITES_HIT_LINKS < LRU_WRITES_TAIL_REHIT,
        () => 't6 Gate SIEVE: the SIEVE hit (' + SIEVE_WRITES_HIT_LINKS + ' links) is not cheaper than the LRU relink');

    // --- Gate S3FIFO: the S3-FIFO member -- STRICT zero-alloc + the 1-bit headline -
    // (decisions/0013) The int-backed S3Fifo churns NEW, strictly-increasing integer
    // keys from an EMPTY cache. Fresh keys are never in ghost, so after warm-up every
    // op admits to SMALL and evicts the unvisited SMALL tail (recording its key in the
    // int ghost ring + membership table) -- exercising the open-addressed store index
    // idxSet/backshift AND the strict-zero ghost every iteration. NO pre-fill caveat:
    // strict zero-alloc, and _vis / _q / _next / _ixSlot / _ixKey / the ghost buffers
    // never grow.
    const tcache = new S3Fifo(CAP, { keys: 'int' });
    const tNextBytes = tcache._next.buffer.byteLength;
    const tPrevBytes = tcache._prev.buffer.byteLength;
    const tVisBytes = tcache._vis.buffer.byteLength;
    const tQBytes = tcache._q.buffer.byteLength;
    const tIxSlotBytes = tcache._store._ixSlot.buffer.byteLength;
    const tIxKeyBytes = tcache._store._ixKey.buffer.byteLength;
    const tgRingBytes = tcache._gRing.buffer.byteLength;
    const tgixKeyBytes = tcache._gixKey.buffer.byteLength;
    const tgixStateBytes = tcache._gixState.buffer.byteLength;
    let tk = 0;
    const s3Hot = () => {
        tcache.put(tk, tk & 0xffff); // fresh, strictly-increasing int key; SMI value
        tk++;
    };
    const gt = runOpsGate(s3Hot, { ops: OPS, warmup: WARMUP });
    check(tcache._next.buffer.byteLength === tNextBytes,
        () => 't6 Gate S3FIFO: _next.buffer grew ' + tNextBytes + ' -> ' + tcache._next.buffer.byteLength);
    check(tcache._prev.buffer.byteLength === tPrevBytes,
        () => 't6 Gate S3FIFO: _prev.buffer grew ' + tPrevBytes + ' -> ' + tcache._prev.buffer.byteLength);
    check(tcache._vis.buffer.byteLength === tVisBytes,
        () => 't6 Gate S3FIFO: _vis.buffer grew ' + tVisBytes + ' -> ' + tcache._vis.buffer.byteLength);
    check(tcache._q.buffer.byteLength === tQBytes,
        () => 't6 Gate S3FIFO: _q.buffer grew ' + tQBytes + ' -> ' + tcache._q.buffer.byteLength);
    check(tcache._store._ixSlot.buffer.byteLength === tIxSlotBytes,
        () => 't6 Gate S3FIFO: _ixSlot.buffer grew ' + tIxSlotBytes + ' -> ' + tcache._store._ixSlot.buffer.byteLength);
    check(tcache._store._ixKey.buffer.byteLength === tIxKeyBytes,
        () => 't6 Gate S3FIFO: _ixKey.buffer grew ' + tIxKeyBytes + ' -> ' + tcache._store._ixKey.buffer.byteLength);
    check(tcache._gRing.buffer.byteLength === tgRingBytes,
        () => 't6 Gate S3FIFO: ghost _gRing grew ' + tgRingBytes + ' -> ' + tcache._gRing.buffer.byteLength);
    check(tcache._gixKey.buffer.byteLength === tgixKeyBytes,
        () => 't6 Gate S3FIFO: ghost _gixKey grew ' + tgixKeyBytes + ' -> ' + tcache._gixKey.buffer.byteLength);
    check(tcache._gixState.buffer.byteLength === tgixStateBytes,
        () => 't6 Gate S3FIFO: ghost _gixState grew ' + tgixStateBytes + ' -> ' + tcache._gixState.buffer.byteLength);
    check(tcache.size === CAP, () => 't6 Gate S3FIFO: churn did not stay at capacity (size ' + tcache.size + ')');
    check(tcache._gLen <= tcache._ghostCap, () => 't6 Gate S3FIFO: ghost exceeded its bound (' + tcache._gLen + ')');
    if (!gt.report.ok) {
        const g = gt.summary.gc;
        die('t6 Gate S3FIFO (int churn) ops gate rejected -- verdict=' + gt.report.verdict +
            ' source=' + gt.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gta = runAllocsGate(s3Hot, { iterations: 50000, batches: 8 });
    if (!gta.ok) {
        die('t6 Gate S3FIFO (int churn) retained-alloc gate rejected -- verdict=' + gta.report.verdict +
            ' settled=' + gta.result.settled + ' bytesPerCall=' + gta.bytesPerCall);
    }

    // The 1-bit hit headline, MEASURED: an S3-FIFO hit relinks NOTHING (0 _next/_prev
    // stores) and sets exactly ONE visited byte, whether the entry sits at the head,
    // an interior slot or the tail of SMALL. Same as SIEVE, strictly cheaper than the
    // classic-LRU relink.
    const P = 8; // all admitted to SMALL (fresh keys, none in ghost)
    for (const probe of [P - 1, 4, 0]) { // insertion order: head, interior, tail of SMALL
        const cs = new CountedS3Fifo(P);
        for (let i = 0; i < P; i++) cs.put(i, i);
        cs.resetWrites();
        cs.get(probe); // a hit
        check(cs.writes() === S3FIFO_WRITES_HIT_LINKS,
            () => 't6 Gate S3FIFO: hit at ' + probe + ' relinked ' + cs.writes() + ' cells, expected ' + S3FIFO_WRITES_HIT_LINKS);
        check(cs.visWrites() === S3FIFO_WRITES_HIT_VIS,
            () => 't6 Gate S3FIFO: hit at ' + probe + ' wrote ' + cs.visWrites() + ' visited bytes, expected ' + S3FIFO_WRITES_HIT_VIS);
    }
    check(S3FIFO_WRITES_HIT_LINKS < LRU_WRITES_INTERIOR_REHIT && S3FIFO_WRITES_HIT_LINKS < LRU_WRITES_TAIL_REHIT,
        () => 't6 Gate S3FIFO: the S3-FIFO hit (' + S3FIFO_WRITES_HIT_LINKS + ' links) is not cheaper than the LRU relink');

    // --- Gate WTINYLFU: the W-TinyLFU member -- STRICT zero-alloc incl. the sketch --
    // (decisions/0014) The int-backed WTinyLfu churns NEW, strictly-increasing integer
    // keys from an EMPTY cache. Every op after warm-up admits a fresh key to the window
    // and evicts one entry via the admission compare, AND bumps the count-min sketch
    // (aging every 10*cap = 40960 bumps -> multiple aging passes across the window),
    // exercising the open-addressed store index idxSet/backshift AND the packed sketch
    // every iteration. NO pre-fill caveat: strict zero-alloc, and _seg / _sk / _next /
    // _prev / _ixSlot / _ixKey never grow.
    const wcache = new WTinyLfu(CAP, { keys: 'int' });
    const wNextBytes = wcache._next.buffer.byteLength;
    const wPrevBytes = wcache._prev.buffer.byteLength;
    const wSegBytes = wcache._seg.buffer.byteLength;
    const wSkBytes = wcache._sk.buffer.byteLength;
    const wIxSlotBytes = wcache._store._ixSlot.buffer.byteLength;
    const wIxKeyBytes = wcache._store._ixKey.buffer.byteLength;
    // The fixed sketch size is load-bearing (D14.2): 4 rows of 4-bit counters,
    // width = pow2 >= cap, packed 8-per-Uint32 -> ((4*width + 7) >> 3) * 4 bytes.
    const wSkExpect = (((4 * wcache._skWidth + 7) >> 3)) * 4;
    check(wSkBytes === wSkExpect,
        () => 't6 Gate WTINYLFU: sketch buffer ' + wSkBytes + ' != fixed size ' + wSkExpect);
    let wk = 0;
    const wHot = () => {
        wcache.put(wk, wk & 0xffff); // fresh, strictly-increasing int key; SMI value
        wk++;
    };
    const gw = runOpsGate(wHot, { ops: OPS, warmup: WARMUP });
    check(wcache._next.buffer.byteLength === wNextBytes,
        () => 't6 Gate WTINYLFU: _next.buffer grew ' + wNextBytes + ' -> ' + wcache._next.buffer.byteLength);
    check(wcache._prev.buffer.byteLength === wPrevBytes,
        () => 't6 Gate WTINYLFU: _prev.buffer grew ' + wPrevBytes + ' -> ' + wcache._prev.buffer.byteLength);
    check(wcache._seg.buffer.byteLength === wSegBytes,
        () => 't6 Gate WTINYLFU: _seg.buffer grew ' + wSegBytes + ' -> ' + wcache._seg.buffer.byteLength);
    check(wcache._sk.buffer.byteLength === wSkBytes,
        () => 't6 Gate WTINYLFU: _sk.buffer grew ' + wSkBytes + ' -> ' + wcache._sk.buffer.byteLength);
    check(wcache._store._ixSlot.buffer.byteLength === wIxSlotBytes,
        () => 't6 Gate WTINYLFU: _ixSlot.buffer grew ' + wIxSlotBytes + ' -> ' + wcache._store._ixSlot.buffer.byteLength);
    check(wcache._store._ixKey.buffer.byteLength === wIxKeyBytes,
        () => 't6 Gate WTINYLFU: _ixKey.buffer grew ' + wIxKeyBytes + ' -> ' + wcache._store._ixKey.buffer.byteLength);
    check(wcache.size === CAP, () => 't6 Gate WTINYLFU: churn did not stay at capacity (size ' + wcache.size + ')');
    if (!gw.report.ok) {
        const g = gw.summary.gc;
        die('t6 Gate WTINYLFU (int churn) ops gate rejected -- verdict=' + gw.report.verdict +
            ' source=' + gw.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gwa = runAllocsGate(wHot, { iterations: 50000, batches: 8 });
    if (!gwa.ok) {
        die('t6 Gate WTINYLFU (int churn) retained-alloc gate rejected -- verdict=' + gwa.report.verdict +
            ' settled=' + gwa.result.settled + ' bytesPerCall=' + gwa.bytesPerCall);
    }

    // OBJECT-KEY path (D14.1): a large mixed get/put run over a FIXED set of OBJECT
    // keys on a PRE-FILLED at-capacity cache. Object keys hash by their RESIDENT SLOT
    // (no WeakMap), so the sketch bump + segment relinks stay strictly zero-alloc, and
    // the run crosses the aging threshold many times. No key is added/removed, so the
    // Map backing never resizes (the same isolation the get/put gates above use).
    const ocache = new WTinyLfu(CAP);
    const objKeys = new Array(CAP);
    for (let i = 0; i < CAP; i++) { objKeys[i] = { id: i }; ocache.put(objKeys[i], i * 3 + 1); }
    check(ocache.size === CAP, () => 't6 Gate WTINYLFU: object pre-fill did not reach capacity');
    const oSkBytes = ocache._sk.buffer.byteLength;
    const oNextBytes = ocache._next.buffer.byteLength;
    const osink = new Int32Array(1);
    // 1e6 mixed ops incl. sketch increments + many aging passes (sample = 10*CAP), all
    // on object keys -- the assertion 1 shape (maxMajor 0, maxPauseMs 4, no buffer growth).
    const objHot = (i) => {
        const k = objKeys[i & MASK];
        if ((i & 1) === 0) ocache.put(k, i); else osink[0] += ocache.get(k) | 0;
    };
    const go = runOpsGate(objHot, { ops: 1000000, warmup: WARMUP });
    check(ocache._sk.buffer.byteLength === oSkBytes,
        () => 't6 Gate WTINYLFU: object-key _sk.buffer grew ' + oSkBytes + ' -> ' + ocache._sk.buffer.byteLength);
    check(ocache._next.buffer.byteLength === oNextBytes,
        () => 't6 Gate WTINYLFU: object-key _next.buffer grew ' + oNextBytes + ' -> ' + ocache._next.buffer.byteLength);
    check(ocache.size === CAP, () => 't6 Gate WTINYLFU: object-key run drifted from capacity (' + ocache.size + ')');
    if (!go.report.ok) {
        const g = go.summary.gc;
        die('t6 Gate WTINYLFU (object-key mixed) ops gate rejected -- verdict=' + go.report.verdict +
            ' source=' + go.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const goa = runAllocsGate(objHot, { iterations: 50000, batches: 8 });
    if (!goa.ok) {
        die('t6 Gate WTINYLFU (object-key mixed) retained-alloc gate rejected -- verdict=' + goa.report.verdict +
            ' settled=' + goa.result.settled + ' bytesPerCall=' + goa.bytesPerCall);
    }

    // The ONE genuine fast path, MEASURED: a re-hit of the WINDOW MRU relinks NOTHING
    // (early return in `_onHit`). Unlike SIEVE/S3-FIFO a W-TinyLFU hit generally DOES
    // relink (recency/promotion) and bump the sketch -- that is fine; the gate asserts
    // zero-ALLOCATION, not minimal writes (decisions/0014).
    {
        const cw = new CountedWTinyLfu(8);
        for (let i = 0; i < 8; i++) cw.put(i, i); // key 7 is the window MRU
        cw.resetWrites();
        cw.get(cw._keys[cw._wHead]); // re-hit the window MRU
        check(cw.writes() === WTINYLFU_WRITES_WINDOW_MRU_REHIT,
            () => 't6 Gate WTINYLFU: window-MRU re-hit relinked ' + cw.writes() +
                ' cells, expected ' + WTINYLFU_WRITES_WINDOW_MRU_REHIT);
    }

    // --- Gate TTL-OFF: byte-identical hot path (decisions/0017) -------------------
    // The off-path decision (D17): a single monomorphic `this._exp === null` guard,
    // KEPT because it costs zero writes on the ttl-OFF path. Proof (a): a non-ttl cache
    // has NO `_exp` column, and the CountedLru writes-per-hit are UNCHANGED from the S1
    // baseline (0 / 5 / 4) even with the ttl branches present in the source -- the guard
    // is predicted-not-taken and writes nothing. This is the "pay nothing when you do
    // not use it" gate.
    {
        const off = new LiteLru(8);
        check(off._exp === null, () => 't6 Gate TTL-OFF: a non-ttl cache allocated an _exp column');
        const N2 = 8;
        const co = new CountedLru(N2);
        for (let i = 0; i < N2; i++) co.put(i, i);
        co.resetWrites(); co.get(N2 - 1);
        check(co.writes() === LRU_WRITES_HEAD_REHIT,
            () => 't6 Gate TTL-OFF: head re-hit wrote ' + co.writes() + ', expected ' + LRU_WRITES_HEAD_REHIT);
        const co2 = new CountedLru(N2);
        for (let i = 0; i < N2; i++) co2.put(i, i);
        co2.resetWrites(); co2.get(4);
        check(co2.writes() === LRU_WRITES_INTERIOR_REHIT,
            () => 't6 Gate TTL-OFF: interior re-hit wrote ' + co2.writes() + ', expected ' + LRU_WRITES_INTERIOR_REHIT);
        const co3 = new CountedLru(N2);
        for (let i = 0; i < N2; i++) co3.put(i, i);
        co3.resetWrites(); co3.get(0);
        check(co3.writes() === LRU_WRITES_TAIL_REHIT,
            () => 't6 Gate TTL-OFF: tail re-hit wrote ' + co3.writes() + ', expected ' + LRU_WRITES_TAIL_REHIT);
    }

    // --- Gate TTL-ON: STRICT zero-alloc incl. expiring gets + _exp stable ---------
    // (decisions/0017) An int-backed ttl cache pre-filled to capacity with never-expire
    // entries, then churned: every op puts a fresh finite-ttl key (evicts the LRU +
    // STAMPS `_exp`) AND does a stale get on an older key (which REAPS it in place --
    // freeSlot resets `_exp`). A virtual clock advances 1 ms/op. Both the put-stamp and
    // the get-reap ttl paths run every iteration and must be strictly zero-alloc, with
    // `_exp` / `_next` / `_prev` / the int index buffers all fixed (never grown).
    let tnow = 0;
    const ttlCache = new LiteLru(CAP, { keys: 'int', ttl: 8, clock: () => tnow });
    for (let i = 0; i < CAP; i++) ttlCache.put(-1 - i, i, Infinity); // never-expire pre-fill
    check(ttlCache.size === CAP, () => 't6 Gate TTL-ON: pre-fill did not reach capacity');
    const ttlExpBytes = ttlCache._exp.buffer.byteLength;
    const ttlNextBytes = ttlCache._next.buffer.byteLength;
    const ttlPrevBytes = ttlCache._prev.buffer.byteLength;
    const ttlIxSlotBytes = ttlCache._store._ixSlot.buffer.byteLength;
    const ttlIxKeyBytes = ttlCache._store._ixKey.buffer.byteLength;
    check(ttlExpBytes === CAP * 8, () => 't6 Gate TTL-ON: _exp buffer ' + ttlExpBytes + ' != ' + (CAP * 8));
    const ttlSink = new Int32Array(1);
    let tk2 = 0;
    const ttlHot = () => {
        ttlCache.put(tk2, tk2 & 0xffff, 4);          // fresh key, ttl 4 -> stamps _exp, evicts LRU
        ttlSink[0] += ttlCache.get((tk2 - 6) | 0) | 0; // older key is stale -> reap in place
        tnow++;                                        // advance the virtual clock 1 ms/op
        tk2++;
    };
    const gttl = runOpsGate(ttlHot, { ops: OPS, warmup: WARMUP });
    check(ttlCache._exp.buffer.byteLength === ttlExpBytes,
        () => 't6 Gate TTL-ON: _exp.buffer grew ' + ttlExpBytes + ' -> ' + ttlCache._exp.buffer.byteLength);
    check(ttlCache._next.buffer.byteLength === ttlNextBytes,
        () => 't6 Gate TTL-ON: _next.buffer grew ' + ttlNextBytes + ' -> ' + ttlCache._next.buffer.byteLength);
    check(ttlCache._prev.buffer.byteLength === ttlPrevBytes,
        () => 't6 Gate TTL-ON: _prev.buffer grew ' + ttlPrevBytes + ' -> ' + ttlCache._prev.buffer.byteLength);
    check(ttlCache._store._ixSlot.buffer.byteLength === ttlIxSlotBytes,
        () => 't6 Gate TTL-ON: _ixSlot.buffer grew ' + ttlIxSlotBytes + ' -> ' + ttlCache._store._ixSlot.buffer.byteLength);
    check(ttlCache._store._ixKey.buffer.byteLength === ttlIxKeyBytes,
        () => 't6 Gate TTL-ON: _ixKey.buffer grew ' + ttlIxKeyBytes + ' -> ' + ttlCache._store._ixKey.buffer.byteLength);
    if (!gttl.report.ok) {
        const g = gttl.summary.gc;
        die('t6 Gate TTL-ON (ttl churn) ops gate rejected -- verdict=' + gttl.report.verdict +
            ' source=' + gttl.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gttla = runAllocsGate(ttlHot, { iterations: 50000, batches: 8 });
    if (!gttla.ok) {
        die('t6 Gate TTL-ON (ttl churn) retained-alloc gate rejected -- verdict=' + gttla.report.verdict +
            ' settled=' + gttla.result.settled + ' bytesPerCall=' + gttla.bytesPerCall);
    }

    // --- Gate ITER: zero-GC iteration steps, ALL FOUR MEMBERS (decisions/0018, D18.2) --
    // Prefill each member at capacity, then drive OPS (>> 10,000) next() steps of
    // entries() -- the BORROWED [k,v] tuple path. The iterator OBJECT is COLD: recreated
    // only when a walk exhausts (~once per CAP steps); each next() STEP must allocate
    // NOTHING. Two channels, same shape as every gate above: the ops window (maxMajor 0,
    // maxPauseMs 4, no arrayBuffers growth) and the retained window (maxBytesPerCall 1).
    const iterMembers = [
        ['LiteLru', new LiteLru(CAP)],
        ['Sieve', new Sieve(CAP)],
        ['S3Fifo', new S3Fifo(CAP)],
        ['WTinyLfu', new WTinyLfu(CAP)],
    ];
    const iterSink = new Int32Array(1);
    for (let m = 0; m < iterMembers.length; m++) {
        const label = iterMembers[m][0];
        const cache2 = iterMembers[m][1];
        for (let i = 0; i < CAP; i++) cache2.put(i, i * 2 + 1);
        check(cache2.size === CAP, () => 't6 Gate ITER ' + label + ': pre-fill did not reach capacity');
        let it = cache2.entries();
        const iterHot = () => {
            let r = it.next();
            if (r.done) { it = cache2.entries(); r = it.next(); } // cold iterator recreate, ~1/CAP
            iterSink[0] += r.value[0] | 0; // read the BORROWED tuple's key (keeps the step live)
        };
        const gIter = runOpsGate(iterHot, { ops: OPS, warmup: WARMUP });
        if (!gIter.report.ok) {
            const g = gIter.summary.gc;
            die('t6 Gate ITER ' + label + ' (entries step) ops gate rejected -- verdict=' + gIter.report.verdict +
                ' source=' + gIter.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
        }
        it = cache2.entries(); // fresh iterator for the retained channel
        const gIterA = runAllocsGate(iterHot, { iterations: 50000, batches: 8 });
        if (!gIterA.ok) {
            die('t6 Gate ITER ' + label + ' (entries step) retained-alloc gate rejected -- verdict=' + gIterA.report.verdict +
                ' settled=' + gIterA.result.settled + ' bytesPerCall=' + gIterA.bytesPerCall);
        }
        // Report the measured per-step retained allocation (stderr keeps stdout == "ok").
        process.stderr.write('t6 Gate ITER ' + label + ': ' + gIterA.bytesPerCall.toFixed(5) +
            ' B/op per next() step (' + OPS + ' ops window, prefilled at capacity ' + CAP + ')\n');
    }
}
