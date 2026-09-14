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

import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro, LruK, Mq, Car } from '../../Lru.js';
import {
    runOpsGate, runAllocsGate, BREAK, check, die, makePrng, validate,
    CountedLru, LRU_WRITES_HEAD_REHIT, LRU_WRITES_INTERIOR_REHIT, LRU_WRITES_TAIL_REHIT,
    CountedSieve, SIEVE_WRITES_HIT_LINKS, SIEVE_WRITES_HIT_VIS,
    CountedS3Fifo, S3FIFO_WRITES_HIT_LINKS, S3FIFO_WRITES_HIT_VIS,
    CountedWTinyLfu, WTINYLFU_WRITES_WINDOW_MRU_REHIT,
    CountedLirs, LIRS_WRITES_LIR_TOP_REHIT,
    CountedLfu, LFU_WRITES_FASTPATH, LFU_WRITES_MAX,
    CountedClockPro, CLOCKPRO_WRITES_HIT_LINKS, CLOCKPRO_WRITES_HIT_ST, CLOCKPRO_WRITES_MISS_EVICT_TRIPWIRE,
    CountedLruK, LRUK_WRITES_HIT_WARM, LRUK_WRITES_HIT_PROMOTE, LRUK_WRITES_HIT_STAMPS, LRUK_EVICT_SCAN_TRIPWIRE,
    CountedMq, MQ_WRITES_HIT_FASTPATH, MQ_WRITES_HIT_RELINK, MQ_WRITES_AGING_MAX, MQ_WRITES_MAX, MQ_STAMPS_ACCESS,
    CountedCar, CAR_WRITES_HIT_LINKS, CAR_WRITES_HIT_ST, CAR_WRITES_MISS_EVICT_TRIPWIRE,
} from './harness.mjs';

const CAP = 4096;      // power of 2 so the hot body masks its key with & MASK
const MASK = CAP - 1;
const OPS = 60000;
const WARMUP = 4000;

/**
 * A MIXED, recurring int-key stream (decisions/0015) for the Slru/TwoQ gates. Built ONCE
 * (before any measured window -- the array allocation is off the hot path), then indexed
 * with a masked cursor so the measured closure allocates nothing. Unlike a
 * strictly-increasing stream (which only exercises insert/evict/ghost-ADD), the mix drives
 * the DISTINGUISHING lanes at capacity: a hot working set LARGER than the protected/Am
 * capacity (>= 2nd hits -> promotions, and overflow -> demotions on Slru; Am-hits on TwoQ)
 * plus cold churn and deliberate re-references of recently-evicted keys (A1out -> ghost
 * ADMITS on TwoQ). All keys are non-negative int32 (valid keys:'int').
 */
function buildMixedStream(len, hotSize, a1inCap, seed) {
    const prng = makePrng(seed);
    const s = new Int32Array(len);
    let cold = hotSize; // cold keys live above the hot range
    for (let i = 0; i < len; i++) {
        const r = prng() % 10;
        if (r < 5) {
            s[i] = prng() % hotSize;                 // hot recurrence -> 2nd hits, promotions, Am-hits
        } else if (r < 8) {
            s[i] = cold++;                           // fresh cold churn -> insert + evict-to-ghost
        } else {
            const back = a1inCap + (prng() % 512);   // a key evicted ~a1inCap ops ago (still in ghost)
            let k = cold - back;
            if (k < hotSize) k = prng() % hotSize;   // fallback early on (before enough cold churn)
            s[i] = k;                                // re-reference -> ghost ADMIT (TwoQ) / re-hit (Slru)
        }
    }
    return s;
}

const STREAM_LEN = 1 << 16; // 65536, power of two so the cursor masks
const STREAM_MASK = STREAM_LEN - 1;
const HOT_SIZE = 3600;      // > protectedCap(3277) so protected OVERFLOWS -> demotions fire
const PREFILL = 40000;      // reach steady state (protected/Am filled past their caps) pre-measurement

/** Segment tags, mirrored from Lru.js (decisions/0015): 0 = probation/A1in, 1 = protected/Am. */
const SEG_A = 0, SEG_B = 1;

/** An Slru whose `_touch` counts promotions + protected-overflow demotions via plain integer
 *  field increments (zero-alloc; never on a MEASURED window -- used only for lane coverage). */
class CoveredSlru extends Slru {
    constructor(cap, opts) { super(cap, opts); this._promotions = 0; this._demotions = 0; }
    _touch(s) {
        const before = this._seg[s];
        const protBefore = this._protSize;
        super._touch(s);
        if (before === SEG_A && this._seg[s] === SEG_B) {
            this._promotions++;
            if (this._protSize === protBefore) this._demotions++; // overflow kept protected flat -> a demote fired
        }
    }
}

/** A TwoQ counting ghost-ADMITs (_ghostConsume fires only on an A1out re-reference), Am-hits and
 *  A1in-stays via plain integer increments (zero-alloc; lane coverage only, never measured). */
class CoveredTwoQ extends TwoQ {
    constructor(cap, opts) { super(cap, opts); this._ghostAdmits = 0; this._amHits = 0; this._a1Stays = 0; }
    _ghostConsume(key) { this._ghostAdmits++; super._ghostConsume(key); }
    get(key) {
        const s = this._store.get(key);
        if (s >= 0) { if (this._seg[s] === SEG_B) this._amHits++; else this._a1Stays++; }
        return super.get(key);
    }
}

/** An Arc counting the DISTINGUISHING lanes (decisions/0016) via plain integer field
 *  increments (zero-alloc; lane coverage only, never on a MEASURED window): `p`-adaptations
 *  (B1 or B2 ghost hits), B1 hits, B2 hits, and REPLACE evictions of a T2 (frequent)
 *  resident (the else-branch of REPLACE). The ghost membership is read BEFORE `super.put`
 *  runs (it consumes the key), so the classification is accurate. */
class CoveredArc extends Arc {
    constructor(cap, opts) { super(cap, opts); this._pAdapts = 0; this._b1Hits = 0; this._b2Hits = 0; this._replaceT2 = 0; }
    _replace(xInB2) {
        const before = this._t2Size;
        const r = super._replace(xInB2);
        if (this._t2Size < before) this._replaceT2++; // a T2 (frequent) resident was evicted
        return r;
    }
    put(key, value, ttlMs) {
        if (this._store.get(key) < 0) {
            if (this._b1.has(key)) { this._b1Hits++; this._pAdapts++; }
            else if (this._b2.has(key)) { this._b2Hits++; this._pAdapts++; }
        }
        return super.put(key, value, ttlMs);
    }
}

/** A Lirs counting the DISTINGUISHING lanes (decisions/0023) via plain integer field
 *  increments (zero-alloc; lane coverage only, never on a MEASURED window): LIR hits,
 *  resident-HIR-in-S promotions to LIR, capacity evictions (Q-front replace), AND the max
 *  observed STACK-PRUNE length (the OWNER-RULING measurement -- pruning is NOT capped; its
 *  length is measured and reported, and the maxPauseMs<=4 gate confirms it never blows).
 *  In the bounded design only resident HIR (<= L_hir) sit in the linked stack, so a prune
 *  walks at most L_hir entries -- measured here to prove it stays small. */
class CoveredLirs extends Lirs {
    constructor(cap, opts) { super(cap, opts); this._lirHits = 0; this._promos = 0; this._replaces = 0; this._maxPrune = 0; }
    _prune() {
        let n = 0, b = this._sBot;
        while (b !== -1 && (this._st[b] & 1) === 0) { n++; b = this._sPrev[b]; }
        if (n > this._maxPrune) this._maxPrune = n;
        super._prune();
    }
    _promoteToLir(s) { this._promos++; super._promoteToLir(s); }
    _replace() { this._replaces++; return super._replace(); }
    get(key) {
        const s = this._store.get(key);
        if (s >= 0 && (this._st[s] & 1)) this._lirHits++;
        return super.get(key);
    }
}

/** An Lfu counting the DISTINGUISHING lanes (decisions/0024) via plain integer field
 *  increments (zero-alloc; lane coverage only, never on a MEASURED window): frequency-bucket
 *  CREATES, DESTROYS, and in-place RELABELS (the fast path), plus the max observed
 *  writes-per-hit. A well-mixed stream must exercise all three bucket transitions. */
class CoveredLfu extends Lfu {
    constructor(cap, opts) {
        super(cap, opts);
        this._bCreates = 0; this._bDestroys = 0; this._bRelabels = 0;
    }
    _bAlloc(freq) { this._bCreates++; return super._bAlloc(freq); }
    _bRelease(b) { this._bDestroys++; return super._bRelease(b); }
    _touch(s) {
        const b = this._kB[s];
        const only = this._bHead[b] === s && this._fNext[s] === -1;
        const nb = this._bNext[b];
        const relabel = only && (nb === -1 || this._bFreq[nb] !== this._bFreq[b] + 1);
        if (relabel) this._bRelabels++;
        super._touch(s);
    }
}

/** A ClockPro counting the DISTINGUISHING lanes (decisions/0025) via plain integer field
 *  increments (zero-alloc; lane coverage only, never on a MEASURED window): HAND_cold
 *  promotions of a referenced test page, HAND_hot demotions, Q-front-style evictions, and
 *  history re-admits (a put of a key still in the bounded non-resident history). A well-mixed
 *  stream must exercise all four. */
class CoveredClockPro extends ClockPro {
    constructor(cap, opts) {
        super(cap, opts);
        this._promos = 0; this._demotes = 0; this._evicts = 0; this._histReadmits = 0;
    }
    _promoteCold(c) { this._promos++; super._promoteCold(c); }
    _handHotDemote() {
        const before = this._nHot;
        super._handHotDemote();
        if (this._nHot < before) this._demotes++;
    }
    _evictOne() { this._evicts++; return super._evictOne(); }
    put(key, value, ttlMs) {
        if (this._store.get(key) < 0 && this._hist.has(key)) this._histReadmits++;
        return super.put(key, value, ttlMs);
    }
}

/** A LruK counting the DISTINGUISHING lanes (decisions/0026) via plain integer field
 *  increments (zero-alloc; lane coverage only, never on a MEASURED window): cold->warm
 *  promotions, cold-tail evictions, all-warm min-r1 evictions, history WARM re-admits, AND the
 *  max observed warm-scan LENGTH (the OWNER-RULING measurement -- the scan is NOT capped; its
 *  length is measured and reported, and the maxPauseMs<=4 / worst-op timing confirms it never
 *  blows). A well-mixed stream must exercise promotions, cold evicts and re-admits; the
 *  dedicated all-warm stream drives the warm scan. */
class CoveredLruK extends LruK {
    constructor(cap, opts) {
        super(cap, opts);
        this._promos = 0; this._coldEvicts = 0; this._warmEvicts = 0; this._histReadmits = 0; this._maxScan = 0;
    }
    _access(s) { const wasCold = (this._st[s] & 1) === 0; super._access(s); if (wasCold) this._promos++; }
    _scanWarmVictim() {
        let n = 0; for (let x = this._warmHead; x !== -1; x = this._next[x]) n++;
        if (n > this._maxScan) this._maxScan = n;
        return super._scanWarmVictim();
    }
    _evictOne() {
        const cold = this._coldTail !== -1;
        const r = super._evictOne();
        if (cold) this._coldEvicts++; else this._warmEvicts++;
        return r;
    }
    put(k, v, t) { if (this._store.get(k) < 0 && this._hist.has(k)) this._histReadmits++; return super.put(k, v, t); }
}

/** An Mq counting the DISTINGUISHING lanes (decisions/0027) via plain integer field increments
 *  (zero-alloc; lane coverage only, never on a MEASURED window): aging DEMOTIONS (a band tail
 *  aged one level toward Q0), capacity EVICTIONS (tail of the lowest non-empty queue), history
 *  RE-ADMITS (a put of a key still in the bounded Qout), AND the max observed demotions in a
 *  SINGLE aging sweep (the OWNER-RULING measurement -- the sweep is a fixed <= 7-step constant;
 *  its per-access demotion count is measured to prove reset-on-demote forbids cascade). */
class CoveredMq extends Mq {
    constructor(cap, opts) {
        super(cap, opts);
        this._demotes = 0; this._evicts = 0; this._histReadmits = 0; this._maxSweepDemotes = 0;
    }
    _ageSweep() {
        // Count how many demotions THIS sweep performs (a demote fires iff a band tail is expired).
        let n = 0; const t = this._t, exq = this._exq, tc = this._qTail;
        for (let q = 1; q < 8; q++) { const tail = tc[q]; if (tail !== -1 && exq[tail] < t) n++; }
        this._demotes += n;
        if (n > this._maxSweepDemotes) this._maxSweepDemotes = n;
        super._ageSweep();
    }
    _evictOne() { this._evicts++; return super._evictOne(); }
    put(k, v, t) { if (this._store.get(k) < 0 && this._hist.has(k)) this._histReadmits++; return super.put(k, v, t); }
}

/** A Car counting the DISTINGUISHING lanes (decisions/0028) via plain integer field increments
 *  (zero-alloc; lane coverage only, never on a MEASURED window): `p`-adaptations (B1 or B2 ghost
 *  hits), B1 hits, B2 hits, capacity evictions (REPLACE), AND T1->T2 migrations of a referenced
 *  page. The ghost membership is read BEFORE `super.put` runs (it consumes the key), so the
 *  classification is accurate; migrations are counted by the T2 growth REPLACE performs before it
 *  removes the victim. */
class CoveredCar extends Car {
    constructor(cap, opts) {
        super(cap, opts);
        this._pAdapts = 0; this._b1Hits = 0; this._b2Hits = 0; this._evicts = 0; this._migrations = 0;
    }
    _replace() {
        this._evicts++;
        const t2Before = this._t2Size;
        const r = super._replace();
        // REPLACE grows T2 by (migrations) and may remove one T2 page (the victim). The migration
        // count is the net T2 growth PLUS 1 if the victim came from T2 (net could be one short).
        const grew = this._t2Size - t2Before;
        if (grew > 0) this._migrations += grew;
        return r;
    }
    put(key, value, ttlMs) {
        if (this._store.get(key) < 0) {
            if (this._b1.has(key)) { this._b1Hits++; this._pAdapts++; }
            else if (this._b2.has(key)) { this._b2Hits++; this._pAdapts++; }
        }
        return super.put(key, value, ttlMs);
    }
}

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

    // --- Gate SLRU: the Slru member -- STRICT zero-alloc across EVERY lane (decisions/0015)
    // A strictly-increasing key stream would only exercise insert/evict; it would NEVER
    // reach the lanes that DISTINGUISH Slru -- promote-on-2nd-hit (probation->protected)
    // and protected-overflow demote (protected->probation). So the measured window runs a
    // MIXED, recurring int-key stream (built ONCE, off the hot path) as the canonical cache
    // access -- get, and put on a miss -- at capacity: a hot working set LARGER than
    // protectedCap forces continuous 2nd-hit promotions AND overflow demotions, while cold
    // churn drives eviction. Zero-alloc: the closure indexes a preallocated Int32Array and
    // does int get/put only. _seg / _vis / _next / _prev / the int index buffers never grow.
    // A separate, UN-measured coverage run over the SAME stream (a CoveredSlru counting via
    // zero-alloc integer field increments) proves the steady-state window actually TRIGGERS
    // the promote AND demote lanes -- so a regression that stops exercising a lane fails
    // LOUD instead of silently reading 0 B/op.
    const A1IN_CAP = Math.max(1, Math.round(CAP * 0.25)); // spacing base for re-references
    const slruStream = buildMixedStream(STREAM_LEN, HOT_SIZE, A1IN_CAP, 0x5717c0de);
    const lcache = new Slru(CAP, { keys: 'int' });
    const lsink = new Int32Array(1);
    let lsi = 0;
    // The op: get, put on a miss, and a SECOND get on a hit -- so a resident probation
    // key reaches its 2nd hit (promotion) quickly, saturating protected past its cap so
    // overflow demotions fire steadily. Zero-alloc (stream index + int get/put only).
    const slruHot = () => {
        const k = slruStream[lsi & STREAM_MASK]; lsi++;
        const v = lcache.get(k);
        if (v === undefined) lcache.put(k, k); else { lsink[0] += v | 0; lcache.get(k); }
    };
    for (let i = 0; i < PREFILL; i++) slruHot(); // reach steady state (protected filled past its cap)
    check(lcache.size === CAP, () => 't6 Gate SLRU: prefill did not reach capacity (size ' + lcache.size + ')');
    const lNextBytes = lcache._next.buffer.byteLength;
    const lPrevBytes = lcache._prev.buffer.byteLength;
    const lSegBytes = lcache._seg.buffer.byteLength;
    const lVisBytes = lcache._vis.buffer.byteLength;
    const lIxSlotBytes = lcache._store._ixSlot.buffer.byteLength;
    const lIxKeyBytes = lcache._store._ixKey.buffer.byteLength;
    const gl = runOpsGate(slruHot, { ops: OPS, warmup: WARMUP });
    check(lcache._next.buffer.byteLength === lNextBytes,
        () => 't6 Gate SLRU: _next.buffer grew ' + lNextBytes + ' -> ' + lcache._next.buffer.byteLength);
    check(lcache._prev.buffer.byteLength === lPrevBytes,
        () => 't6 Gate SLRU: _prev.buffer grew ' + lPrevBytes + ' -> ' + lcache._prev.buffer.byteLength);
    check(lcache._seg.buffer.byteLength === lSegBytes,
        () => 't6 Gate SLRU: _seg.buffer grew ' + lSegBytes + ' -> ' + lcache._seg.buffer.byteLength);
    check(lcache._vis.buffer.byteLength === lVisBytes,
        () => 't6 Gate SLRU: _vis.buffer grew ' + lVisBytes + ' -> ' + lcache._vis.buffer.byteLength);
    check(lcache._store._ixSlot.buffer.byteLength === lIxSlotBytes,
        () => 't6 Gate SLRU: _ixSlot.buffer grew ' + lIxSlotBytes + ' -> ' + lcache._store._ixSlot.buffer.byteLength);
    check(lcache._store._ixKey.buffer.byteLength === lIxKeyBytes,
        () => 't6 Gate SLRU: _ixKey.buffer grew ' + lIxKeyBytes + ' -> ' + lcache._store._ixKey.buffer.byteLength);
    check(lcache.size === CAP, () => 't6 Gate SLRU: churn did not stay at capacity (size ' + lcache.size + ')');
    check(lcache._protSize === lcache._protectedCap,
        () => 't6 Gate SLRU: protected did not fill to its cap (protSize ' + lcache._protSize + ' != ' + lcache._protectedCap + ') -- promotions/demotions not exercised');
    if (!gl.report.ok) {
        const g = gl.summary.gc;
        die('t6 Gate SLRU (mixed churn) ops gate rejected -- verdict=' + gl.report.verdict +
            ' source=' + gl.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gla = runAllocsGate(slruHot, { iterations: 50000, batches: 8 });
    if (!gla.ok) {
        die('t6 Gate SLRU (mixed churn) retained-alloc gate rejected -- verdict=' + gla.report.verdict +
            ' settled=' + gla.result.settled + ' bytesPerCall=' + gla.bytesPerCall);
    }
    // Lane coverage (UN-measured): the SAME stream through a counting subclass; the counters
    // are reset AFTER the prefill so they reflect ONLY the steady-state window.
    const covL = new CoveredSlru(CAP, { keys: 'int' });
    let clsi = 0;
    const covLHot = () => {
        const k = slruStream[clsi & STREAM_MASK]; clsi++;
        if (covL.get(k) === undefined) covL.put(k, k); else covL.get(k);
    };
    for (let i = 0; i < PREFILL; i++) covLHot();
    covL._promotions = 0; covL._demotions = 0; // count only the steady-state window
    for (let i = 0; i < OPS; i++) covLHot();
    check(covL._promotions > 0,
        () => 't6 Gate SLRU: the window triggered 0 probation->protected promotions (lane not covered)');
    check(covL._demotions > 0,
        () => 't6 Gate SLRU: the window triggered 0 protected-overflow demotions (lane not covered)');
    process.stderr.write('t6 Gate SLRU: ' + gla.bytesPerCall.toFixed(5) +
        ' B/op mixed churn (' + OPS + ' ops window, capacity ' + CAP + '); lanes covered: promotions=' +
        covL._promotions + ' demotions=' + covL._demotions + '\n');

    // --- Gate TWOQ: the TwoQ member -- STRICT zero-alloc across EVERY lane (decisions/0015)
    // As with Slru, a strictly-increasing stream would only exercise insert/evict/ghost-ADD.
    // The measured window runs the MIXED recurring stream (canonical get + put-on-miss) at
    // capacity so it reaches the DISTINGUISHING lanes: ghost ADMIT (a key in A1out re-
    // referenced -> straight to Am), Am-hit (move-to-MRU), and A1in-stay. Zero-alloc: the
    // closure indexes a preallocated stream + int get/put. _seg / _next / _prev / _ixSlot /
    // _ixKey / the ghost buffers never grow, and `_gLen <= _ghostCap` always. A separate,
    // UN-measured CoveredTwoQ run over the SAME stream proves the steady-state window fires
    // the ghost-admit, Am-hit and A1in-stay lanes at least once each (loud on regression).
    const twoqStream = buildMixedStream(STREAM_LEN, HOT_SIZE, A1IN_CAP, 0x2907beef);
    const qcache = new TwoQ(CAP, { keys: 'int' });
    const qsink = new Int32Array(1);
    let qsi = 0;
    const twoqHot = () => {
        const k = twoqStream[qsi & STREAM_MASK]; qsi++;
        const v = qcache.get(k);
        if (v === undefined) qcache.put(k, k); else { qsink[0] += v | 0; qcache.get(k); }
    };
    for (let i = 0; i < PREFILL; i++) twoqHot(); // reach steady state
    check(qcache.size === CAP, () => 't6 Gate TWOQ: prefill did not reach capacity (size ' + qcache.size + ')');
    const qNextBytes = qcache._next.buffer.byteLength;
    const qPrevBytes = qcache._prev.buffer.byteLength;
    const qSegBytes = qcache._seg.buffer.byteLength;
    const qIxSlotBytes = qcache._store._ixSlot.buffer.byteLength;
    const qIxKeyBytes = qcache._store._ixKey.buffer.byteLength;
    const qgRingBytes = qcache._gRing.buffer.byteLength;
    const qgixKeyBytes = qcache._gixKey.buffer.byteLength;
    const qgixStateBytes = qcache._gixState.buffer.byteLength;
    const gq = runOpsGate(twoqHot, { ops: OPS, warmup: WARMUP });
    check(qcache._next.buffer.byteLength === qNextBytes,
        () => 't6 Gate TWOQ: _next.buffer grew ' + qNextBytes + ' -> ' + qcache._next.buffer.byteLength);
    check(qcache._prev.buffer.byteLength === qPrevBytes,
        () => 't6 Gate TWOQ: _prev.buffer grew ' + qPrevBytes + ' -> ' + qcache._prev.buffer.byteLength);
    check(qcache._seg.buffer.byteLength === qSegBytes,
        () => 't6 Gate TWOQ: _seg.buffer grew ' + qSegBytes + ' -> ' + qcache._seg.buffer.byteLength);
    check(qcache._store._ixSlot.buffer.byteLength === qIxSlotBytes,
        () => 't6 Gate TWOQ: _ixSlot.buffer grew ' + qIxSlotBytes + ' -> ' + qcache._store._ixSlot.buffer.byteLength);
    check(qcache._store._ixKey.buffer.byteLength === qIxKeyBytes,
        () => 't6 Gate TWOQ: _ixKey.buffer grew ' + qIxKeyBytes + ' -> ' + qcache._store._ixKey.buffer.byteLength);
    check(qcache._gRing.buffer.byteLength === qgRingBytes,
        () => 't6 Gate TWOQ: ghost _gRing grew ' + qgRingBytes + ' -> ' + qcache._gRing.buffer.byteLength);
    check(qcache._gixKey.buffer.byteLength === qgixKeyBytes,
        () => 't6 Gate TWOQ: ghost _gixKey grew ' + qgixKeyBytes + ' -> ' + qcache._gixKey.buffer.byteLength);
    check(qcache._gixState.buffer.byteLength === qgixStateBytes,
        () => 't6 Gate TWOQ: ghost _gixState grew ' + qgixStateBytes + ' -> ' + qcache._gixState.buffer.byteLength);
    check(qcache.size === CAP, () => 't6 Gate TWOQ: churn did not stay at capacity (size ' + qcache.size + ')');
    check(qcache._gLen <= qcache._ghostCap, () => 't6 Gate TWOQ: ghost exceeded its bound (' + qcache._gLen + ')');
    check(qcache._amSize > 0, () => 't6 Gate TWOQ: Am empty (ghost-admit lane not exercised)');
    if (!gq.report.ok) {
        const g = gq.summary.gc;
        die('t6 Gate TWOQ (mixed churn) ops gate rejected -- verdict=' + gq.report.verdict +
            ' source=' + gq.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gqa = runAllocsGate(twoqHot, { iterations: 50000, batches: 8 });
    if (!gqa.ok) {
        die('t6 Gate TWOQ (mixed churn) retained-alloc gate rejected -- verdict=' + gqa.report.verdict +
            ' settled=' + gqa.result.settled + ' bytesPerCall=' + gqa.bytesPerCall);
    }
    // Lane coverage (UN-measured): the SAME stream through a counting subclass; counters
    // reset AFTER the prefill so they reflect ONLY the steady-state window.
    const covQ = new CoveredTwoQ(CAP, { keys: 'int' });
    let cqsi = 0;
    const covQHot = () => {
        const k = twoqStream[cqsi & STREAM_MASK]; cqsi++;
        if (covQ.get(k) === undefined) covQ.put(k, k); else covQ.get(k);
    };
    for (let i = 0; i < PREFILL; i++) covQHot();
    covQ._ghostAdmits = 0; covQ._amHits = 0; covQ._a1Stays = 0;
    for (let i = 0; i < OPS; i++) covQHot();
    check(covQ._ghostAdmits > 0,
        () => 't6 Gate TWOQ: the window triggered 0 A1out->Am ghost admits (lane not covered)');
    check(covQ._amHits > 0,
        () => 't6 Gate TWOQ: the window triggered 0 Am-hit move-to-MRU (lane not covered)');
    check(covQ._a1Stays > 0,
        () => 't6 Gate TWOQ: the window triggered 0 A1in-stay hits (lane not covered)');
    process.stderr.write('t6 Gate TWOQ: ' + gqa.bytesPerCall.toFixed(5) +
        ' B/op mixed churn (' + OPS + ' ops window, capacity ' + CAP + '); lanes covered: ghostAdmits=' +
        covQ._ghostAdmits + ' amHits=' + covQ._amHits + ' a1Stays=' + covQ._a1Stays + '\n');

    // --- Gate ARC: the Arc member -- STRICT zero-alloc across EVERY lane (decisions/0016)
    // A strictly-increasing key stream would only exercise insert/evict; it would NEVER
    // reach the lanes that DISTINGUISH Arc -- `p` adaptation on B1/B2 ghost hits, and REPLACE
    // evicting a T2 (frequent) resident. So the measured window runs the SAME MIXED, recurring
    // int-key stream the Slru/TwoQ gates use (built ONCE, off the hot path) as the canonical
    // cache access -- get, and put on a miss, plus a second get on a hit -- at capacity: a hot
    // working set drives promotions to T2 and both ghosts, while cold churn + re-references of
    // recently-evicted keys drive B1/B2 ghost hits (and thus `p` adaptation). Zero-alloc: the
    // closure indexes a preallocated Int32Array and does int get/put only. _seg / _next / _prev
    // / the int index buffers / both ghost rings + membership tables never grow, and
    // `_b1._len + _b2._len <= c`, `_t1Size + _b1._len <= c` always. A separate, UN-measured
    // CoveredArc run over the SAME stream proves the steady-state window TRIGGERS `p`-adapt,
    // B1-hit, B2-hit AND REPLACE-of-a-T2 at least the plan's thresholds -- so a regression that
    // stops exercising a lane fails LOUD instead of silently reading 0 B/op.
    const arcStream = buildMixedStream(STREAM_LEN, HOT_SIZE, A1IN_CAP, 0xA5C0FFEE);
    const acache = new Arc(CAP, { keys: 'int' });
    const asink = new Int32Array(1);
    let asi = 0;
    const arcHot = () => {
        const k = arcStream[asi & STREAM_MASK]; asi++;
        const v = acache.get(k);
        if (v === undefined) acache.put(k, k); else { asink[0] += v | 0; acache.get(k); }
    };
    for (let i = 0; i < PREFILL; i++) arcHot(); // reach steady state (both ghosts populated)
    check(acache.size === CAP, () => 't6 Gate ARC: prefill did not reach capacity (size ' + acache.size + ')');
    const aNextBytes = acache._next.buffer.byteLength;
    const aPrevBytes = acache._prev.buffer.byteLength;
    const aSegBytes = acache._seg.buffer.byteLength;
    const aIxSlotBytes = acache._store._ixSlot.buffer.byteLength;
    const aIxKeyBytes = acache._store._ixKey.buffer.byteLength;
    const ab1RingBytes = acache._b1._ring.buffer.byteLength;
    const ab1KeyBytes = acache._b1._ixKey.buffer.byteLength;
    const ab1StateBytes = acache._b1._ixState.buffer.byteLength;
    const ab2RingBytes = acache._b2._ring.buffer.byteLength;
    const ab2KeyBytes = acache._b2._ixKey.buffer.byteLength;
    const ab2StateBytes = acache._b2._ixState.buffer.byteLength;
    const ga = runOpsGate(arcHot, { ops: OPS, warmup: WARMUP });
    check(acache._next.buffer.byteLength === aNextBytes,
        () => 't6 Gate ARC: _next.buffer grew ' + aNextBytes + ' -> ' + acache._next.buffer.byteLength);
    check(acache._prev.buffer.byteLength === aPrevBytes,
        () => 't6 Gate ARC: _prev.buffer grew ' + aPrevBytes + ' -> ' + acache._prev.buffer.byteLength);
    check(acache._seg.buffer.byteLength === aSegBytes,
        () => 't6 Gate ARC: _seg.buffer grew ' + aSegBytes + ' -> ' + acache._seg.buffer.byteLength);
    check(acache._store._ixSlot.buffer.byteLength === aIxSlotBytes,
        () => 't6 Gate ARC: _ixSlot.buffer grew ' + aIxSlotBytes + ' -> ' + acache._store._ixSlot.buffer.byteLength);
    check(acache._store._ixKey.buffer.byteLength === aIxKeyBytes,
        () => 't6 Gate ARC: _ixKey.buffer grew ' + aIxKeyBytes + ' -> ' + acache._store._ixKey.buffer.byteLength);
    check(acache._b1._ring.buffer.byteLength === ab1RingBytes,
        () => 't6 Gate ARC: B1 _ring grew ' + ab1RingBytes + ' -> ' + acache._b1._ring.buffer.byteLength);
    check(acache._b1._ixKey.buffer.byteLength === ab1KeyBytes,
        () => 't6 Gate ARC: B1 _ixKey grew ' + ab1KeyBytes + ' -> ' + acache._b1._ixKey.buffer.byteLength);
    check(acache._b1._ixState.buffer.byteLength === ab1StateBytes,
        () => 't6 Gate ARC: B1 _ixState grew ' + ab1StateBytes + ' -> ' + acache._b1._ixState.buffer.byteLength);
    check(acache._b2._ring.buffer.byteLength === ab2RingBytes,
        () => 't6 Gate ARC: B2 _ring grew ' + ab2RingBytes + ' -> ' + acache._b2._ring.buffer.byteLength);
    check(acache._b2._ixKey.buffer.byteLength === ab2KeyBytes,
        () => 't6 Gate ARC: B2 _ixKey grew ' + ab2KeyBytes + ' -> ' + acache._b2._ixKey.buffer.byteLength);
    check(acache._b2._ixState.buffer.byteLength === ab2StateBytes,
        () => 't6 Gate ARC: B2 _ixState grew ' + ab2StateBytes + ' -> ' + acache._b2._ixState.buffer.byteLength);
    check(acache.size === CAP, () => 't6 Gate ARC: churn did not stay at capacity (size ' + acache.size + ')');
    check(acache._b1._len + acache._b2._len <= acache._ghostCap,
        () => 't6 Gate ARC: combined ghost exceeded its bound (' + (acache._b1._len + acache._b2._len) + ')');
    check(acache._t1Size + acache._b1._len <= acache._ghostCap,
        () => 't6 Gate ARC: |T1|+|B1| exceeded capacity (' + (acache._t1Size + acache._b1._len) + ')');
    if (!ga.report.ok) {
        const g = ga.summary.gc;
        die('t6 Gate ARC (mixed churn) ops gate rejected -- verdict=' + ga.report.verdict +
            ' source=' + ga.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gaa = runAllocsGate(arcHot, { iterations: 50000, batches: 8 });
    if (!gaa.ok) {
        die('t6 Gate ARC (mixed churn) retained-alloc gate rejected -- verdict=' + gaa.report.verdict +
            ' settled=' + gaa.result.settled + ' bytesPerCall=' + gaa.bytesPerCall);
    }
    // Lane coverage (UN-measured): the SAME stream through a counting subclass; counters
    // reset AFTER the prefill so they reflect ONLY the steady-state window. The plan's floors:
    // p-adapt >= 100, B1-hit >= 50, B2-hit >= 50, REPLACE-T2 >= 50.
    const covA = new CoveredArc(CAP, { keys: 'int' });
    let casi = 0;
    const covAHot = () => {
        const k = arcStream[casi & STREAM_MASK]; casi++;
        if (covA.get(k) === undefined) covA.put(k, k); else covA.get(k);
    };
    for (let i = 0; i < PREFILL; i++) covAHot();
    covA._pAdapts = 0; covA._b1Hits = 0; covA._b2Hits = 0; covA._replaceT2 = 0;
    for (let i = 0; i < OPS; i++) covAHot();
    check(covA._pAdapts >= 100,
        () => 't6 Gate ARC: the window triggered ' + covA._pAdapts + ' p-adaptations (< 100 -- lane not covered)');
    check(covA._b1Hits >= 50,
        () => 't6 Gate ARC: the window triggered ' + covA._b1Hits + ' B1 ghost hits (< 50 -- lane not covered)');
    check(covA._b2Hits >= 50,
        () => 't6 Gate ARC: the window triggered ' + covA._b2Hits + ' B2 ghost hits (< 50 -- lane not covered)');
    check(covA._replaceT2 >= 50,
        () => 't6 Gate ARC: the window triggered ' + covA._replaceT2 + ' REPLACE-of-T2 evictions (< 50 -- lane not covered)');
    process.stderr.write('t6 Gate ARC: ' + gaa.bytesPerCall.toFixed(5) +
        ' B/op mixed churn (' + OPS + ' ops window, capacity ' + CAP + '); lanes covered: pAdapt=' +
        covA._pAdapts + ' b1Hit=' + covA._b1Hits + ' b2Hit=' + covA._b2Hits + ' replaceT2=' + covA._replaceT2 + '\n');

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
        ['Slru', new Slru(CAP)],
        ['TwoQ', new TwoQ(CAP)],
        ['Arc', new Arc(CAP)],
        ['Lirs', new Lirs(CAP)],
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

    // --- Gate STATS: opt-in runtime counters -- STRICT zero-alloc (decisions/0019) --
    // (D19) An int-backed cache constructed with `{ stats: true }` churns NEW,
    // strictly-increasing integer keys from an EMPTY cache. After warm-up every op
    // puts a fresh key (puts++, evicts the LRU -> evictions++) and gets a still-
    // resident recent key (hits++). The counter writes go behind the monomorphic
    // `this._stats === null` guard -- they are plain-number field stores on a fixed
    // holder, never an allocation. The gate asserts maxMajor 0 + retained <= 1 B/op,
    // the holder IDENTITY is stable across the whole run (D19.3), and the holder is a
    // PLAIN object whose key set is EXACTLY the four counter names (D19.4).
    const stCache = new LiteLru(CAP, { keys: 'int', stats: true });
    const stHolderBefore = stCache.stats();
    check(stCache._store._ixSlot !== undefined, () => 't6 Gate STATS: expected int backing');
    const stIxSlotBytes = stCache._store._ixSlot.buffer.byteLength;
    const stIxKeyBytes = stCache._store._ixKey.buffer.byteLength;
    const stSink = new Int32Array(1);
    let stk = 0;
    const statsHot = () => {
        stCache.put(stk, stk & 0xffff);              // fresh key -> puts++, evicts LRU -> evictions++
        stSink[0] += stCache.get((stk - 2) | 0) | 0; // still-resident recent key -> hits++
        stk++;
    };
    const gst = runOpsGate(statsHot, { ops: OPS, warmup: WARMUP });
    check(stCache.stats() === stHolderBefore,
        () => 't6 Gate STATS: the stats() holder identity changed across the run');
    check(stCache._store._ixSlot.buffer.byteLength === stIxSlotBytes,
        () => 't6 Gate STATS: _ixSlot.buffer grew ' + stIxSlotBytes + ' -> ' + stCache._store._ixSlot.buffer.byteLength);
    check(stCache._store._ixKey.buffer.byteLength === stIxKeyBytes,
        () => 't6 Gate STATS: _ixKey.buffer grew ' + stIxKeyBytes + ' -> ' + stCache._store._ixKey.buffer.byteLength);
    check(stCache.size === CAP, () => 't6 Gate STATS: churn did not stay at capacity (size ' + stCache.size + ')');
    // The holder is a PLAIN object with EXACTLY the four counter names (D19.4).
    const stKeys = Object.keys(stHolderBefore).sort().join(',');
    check(stKeys === 'evictions,hits,misses,puts',
        () => 't6 Gate STATS: holder key set is ' + stKeys + ', expected evictions,hits,misses,puts');
    check(Object.getPrototypeOf(stHolderBefore) === Object.prototype,
        () => 't6 Gate STATS: holder is not a plain object');
    // The counters actually advanced (the writes are real, not elided by the engine).
    check(stHolderBefore.puts > 0 && stHolderBefore.hits > 0 && stHolderBefore.evictions > 0,
        () => 't6 Gate STATS: counters did not advance (puts/hits/evictions must be > 0)');
    if (!gst.report.ok) {
        const g = gst.summary.gc;
        die('t6 Gate STATS (stats churn) ops gate rejected -- verdict=' + gst.report.verdict +
            ' source=' + gst.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gsta = runAllocsGate(statsHot, { iterations: 50000, batches: 8 });
    if (!gsta.ok) {
        die('t6 Gate STATS (stats churn) retained-alloc gate rejected -- verdict=' + gsta.report.verdict +
            ' settled=' + gsta.result.settled + ' bytesPerCall=' + gsta.bytesPerCall);
    }
    process.stderr.write('t6 Gate STATS: ' + gsta.bytesPerCall.toFixed(5) +
        ' B/op stats-ON churn (' + OPS + ' ops window, capacity ' + CAP + ')\n');

    // --- Gate SNAP: snapshot/restore (decisions/0021, D21) ----------------------
    // dump()/restore() are COLD and off the hot body -- no substrate field, no hot-path
    // branch. This gate proves FOUR things:
    //   (1) dump() honors its honest <= 96 B/entry budget (measured; no zero-GC claim).
    //   (2) writes-per-hit is UNCHANGED by the snapshot code (0/5/4 -- same as Gate 3),
    //       i.e. adding dump/restore perturbed no hot path.
    //   (3) a RESTORED cache's hot path is STRICT zero-alloc (get re-hit + int insert/evict
    //       churn), with every backing byteLength invariant across the window.
    // Restore rebuilds a fresh instance; if it left the free list / index in a state that
    // forced a grow-on-next-op, this gate's byteLength checks would catch it.
    {
        // (1) dump budget. A full int-backed cache; measure retained bytes across many
        // dumps held live, divided by (dumps * entries).
        const full = new LiteLru(CAP, { keys: 'int' });
        for (let i = 0; i < CAP; i++) full.put(i, i * 3 + 1);
        check(full.size === CAP, () => 't6 Gate SNAP: dump-budget pre-fill did not reach capacity');
        globalThis.gc(); globalThis.gc();
        const heapBefore = process.memoryUsage().heapUsed;
        const held = [];
        const DUMPS = 40;
        for (let i = 0; i < DUMPS; i++) held.push(full.dump());
        globalThis.gc(); globalThis.gc();
        const heapAfter = process.memoryUsage().heapUsed;
        const bytesPerEntry = (heapAfter - heapBefore) / (DUMPS * CAP);
        check(held.length === DUMPS && held[0].m === 'LiteLru' && held[0].list.slots.length === CAP,
            () => 't6 Gate SNAP: dump did not capture the full cache');
        check(bytesPerEntry <= 96,
            () => 't6 Gate SNAP: dump measured ' + bytesPerEntry.toFixed(2) + ' B/entry (> 96 budget)');
        held.length = 0;

        // (2) writes-per-hit unchanged (0/5/4) -- the snapshot code added no hot-path cost.
        const NW = 8;
        const cw1 = new CountedLru(NW); for (let i = 0; i < NW; i++) cw1.put(i, i);
        cw1.resetWrites(); cw1.get(NW - 1);
        check(cw1.writes() === LRU_WRITES_HEAD_REHIT,
            () => 't6 Gate SNAP: head re-hit wrote ' + cw1.writes() + ', expected ' + LRU_WRITES_HEAD_REHIT);
        const cw2 = new CountedLru(NW); for (let i = 0; i < NW; i++) cw2.put(i, i);
        cw2.resetWrites(); cw2.get(4);
        check(cw2.writes() === LRU_WRITES_INTERIOR_REHIT,
            () => 't6 Gate SNAP: interior re-hit wrote ' + cw2.writes() + ', expected ' + LRU_WRITES_INTERIOR_REHIT);
        const cw3 = new CountedLru(NW); for (let i = 0; i < NW; i++) cw3.put(i, i);
        cw3.resetWrites(); cw3.get(0);
        check(cw3.writes() === LRU_WRITES_TAIL_REHIT,
            () => 't6 Gate SNAP: tail re-hit wrote ' + cw3.writes() + ', expected ' + LRU_WRITES_TAIL_REHIT);

        // (3a) restored cache: get() re-hit hot loop is zero-alloc, backings invariant.
        const rc = LiteLru.restore(full.dump(), { keys: 'int' });
        check(rc.size === CAP, () => 't6 Gate SNAP: restored size ' + rc.size + ' != capacity');
        const rcNext = rc._next.buffer.byteLength;
        const rcPrev = rc._prev.buffer.byteLength;
        const rcSlot = rc._store._ixSlot.buffer.byteLength;
        const rcKey = rc._store._ixKey.buffer.byteLength;
        const snapSink = new Int32Array(1);
        const rcGetHot = (i) => { snapSink[0] += rc.get(i & MASK) | 0; };
        const gr = runOpsGate(rcGetHot, { ops: OPS, warmup: WARMUP });
        check(rc._next.buffer.byteLength === rcNext && rc._prev.buffer.byteLength === rcPrev,
            () => 't6 Gate SNAP: restored _next/_prev grew under the get loop');
        check(rc._store._ixSlot.buffer.byteLength === rcSlot && rc._store._ixKey.buffer.byteLength === rcKey,
            () => 't6 Gate SNAP: restored int index buffers grew under the get loop');
        if (!gr.report.ok) {
            const g = gr.summary.gc;
            die('t6 Gate SNAP (restored get re-hit) ops gate rejected -- verdict=' + gr.report.verdict +
                ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
        }
        const gra = runAllocsGate(rcGetHot, { iterations: 50000, batches: 8 });
        if (!gra.ok) {
            die('t6 Gate SNAP (restored get re-hit) retained-alloc gate rejected -- verdict=' + gra.report.verdict +
                ' settled=' + gra.result.settled + ' bytesPerCall=' + gra.bytesPerCall);
        }

        // (3b) restored int cache: fresh-key insert+evict churn is zero-alloc and the
        // rebuilt free list + index never grow (the restore path did not corrupt them).
        const rc2 = LiteLru.restore(full.dump(), { keys: 'int' });
        const rc2Next = rc2._next.buffer.byteLength;
        const rc2Slot = rc2._store._ixSlot.buffer.byteLength;
        const rc2Key = rc2._store._ixKey.buffer.byteLength;
        let rk = CAP;
        const rcChurn = () => { rc2.put(rk, rk & 0xffff); rk++; };
        const grc = runOpsGate(rcChurn, { ops: OPS, warmup: WARMUP });
        check(rc2._next.buffer.byteLength === rc2Next,
            () => 't6 Gate SNAP: restored churn grew _next');
        check(rc2._store._ixSlot.buffer.byteLength === rc2Slot && rc2._store._ixKey.buffer.byteLength === rc2Key,
            () => 't6 Gate SNAP: restored churn grew the int index buffers');
        check(rc2.size === CAP, () => 't6 Gate SNAP: restored churn drifted from capacity (' + rc2.size + ')');
        if (!grc.report.ok) {
            const g = grc.summary.gc;
            die('t6 Gate SNAP (restored churn) ops gate rejected -- verdict=' + grc.report.verdict +
                ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
        }
        const grca = runAllocsGate(rcChurn, { iterations: 50000, batches: 8 });
        if (!grca.ok) {
            die('t6 Gate SNAP (restored churn) retained-alloc gate rejected -- verdict=' + grca.report.verdict +
                ' settled=' + grca.result.settled + ' bytesPerCall=' + grca.bytesPerCall);
        }
        process.stderr.write('t6 Gate SNAP: ' + gra.bytesPerCall.toFixed(5) +
            ' B/op restored get re-hit, ' + grca.bytesPerCall.toFixed(5) + ' B/op restored churn; dump ' +
            bytesPerEntry.toFixed(2) + ' B/entry (<= 96), writes-per-hit 0/5/4 unchanged (capacity ' + CAP + ')\n');
    }

    // --- Gate LIRS: the Lirs member -- STRICT zero-alloc + MEASURED prune length -----
    // (decisions/0023) The SAME MIXED, recurring int-key stream drives every LIRS lane at
    // capacity: hot recurrence -> LIR hits + resident-HIR-in-S promotions (which demote the
    // bottom LIR and prune); cold churn + re-references of recently-evicted keys -> misses,
    // Q-front replaces, and non-resident-history hits (re-admit as LIR). Zero-alloc: the
    // closure indexes a preallocated Int32Array and does int get/put only. The stack columns
    // `_sNext`/`_sPrev`, the shared `_next`/`_prev`, `_st`, the int index buffers AND the
    // history ring never grow; |LIR| + |resident HIR| == size == capacity always. maxPauseMs
    // <= 4 is enforced by RULES on the window -- the OWNER RULING: pruning is measured, not
    // capped, and (bounded design) walks at most L_hir entries, so the pause never blows.
    const lrsStream = buildMixedStream(STREAM_LEN, HOT_SIZE, A1IN_CAP, 0x1145c0de);
    const lrsCache = new Lirs(CAP, { keys: 'int' });
    const lrsSink = new Int32Array(1);
    let lrsi = 0;
    const lrsHot = () => {
        const k = lrsStream[lrsi & STREAM_MASK]; lrsi++;
        const v = lrsCache.get(k);
        if (v === undefined) lrsCache.put(k, k); else { lrsSink[0] += v | 0; lrsCache.get(k); }
    };
    for (let i = 0; i < PREFILL; i++) lrsHot(); // reach steady state
    check(lrsCache.size === CAP, () => 't6 Gate LIRS: prefill did not reach capacity (size ' + lrsCache.size + ')');
    const lrsSNextBytes = lrsCache._sNext.buffer.byteLength;
    const lrsSPrevBytes = lrsCache._sPrev.buffer.byteLength;
    const lrsNextBytes = lrsCache._next.buffer.byteLength;
    const lrsPrevBytes = lrsCache._prev.buffer.byteLength;
    const lrsStBytes = lrsCache._st.buffer.byteLength;
    const lrsIxSlotBytes = lrsCache._store._ixSlot.buffer.byteLength;
    const lrsIxKeyBytes = lrsCache._store._ixKey.buffer.byteLength;
    const lrsHistRingBytes = lrsCache._hist._ring.buffer.byteLength;
    const glirs = runOpsGate(lrsHot, { ops: OPS, warmup: WARMUP });
    check(lrsCache._sNext.buffer.byteLength === lrsSNextBytes,
        () => 't6 Gate LIRS: _sNext.buffer grew ' + lrsSNextBytes + ' -> ' + lrsCache._sNext.buffer.byteLength);
    check(lrsCache._sPrev.buffer.byteLength === lrsSPrevBytes,
        () => 't6 Gate LIRS: _sPrev.buffer grew ' + lrsSPrevBytes + ' -> ' + lrsCache._sPrev.buffer.byteLength);
    check(lrsCache._next.buffer.byteLength === lrsNextBytes,
        () => 't6 Gate LIRS: _next.buffer grew ' + lrsNextBytes + ' -> ' + lrsCache._next.buffer.byteLength);
    check(lrsCache._prev.buffer.byteLength === lrsPrevBytes,
        () => 't6 Gate LIRS: _prev.buffer grew ' + lrsPrevBytes + ' -> ' + lrsCache._prev.buffer.byteLength);
    check(lrsCache._st.buffer.byteLength === lrsStBytes,
        () => 't6 Gate LIRS: _st.buffer grew ' + lrsStBytes + ' -> ' + lrsCache._st.buffer.byteLength);
    check(lrsCache._store._ixSlot.buffer.byteLength === lrsIxSlotBytes,
        () => 't6 Gate LIRS: _ixSlot.buffer grew ' + lrsIxSlotBytes + ' -> ' + lrsCache._store._ixSlot.buffer.byteLength);
    check(lrsCache._store._ixKey.buffer.byteLength === lrsIxKeyBytes,
        () => 't6 Gate LIRS: _ixKey.buffer grew ' + lrsIxKeyBytes + ' -> ' + lrsCache._store._ixKey.buffer.byteLength);
    check(lrsCache._hist._ring.buffer.byteLength === lrsHistRingBytes,
        () => 't6 Gate LIRS: history _ring grew ' + lrsHistRingBytes + ' -> ' + lrsCache._hist._ring.buffer.byteLength);
    check(lrsCache.size === CAP, () => 't6 Gate LIRS: churn did not stay at capacity (size ' + lrsCache.size + ')');
    check(lrsCache._hist._len <= CAP,
        () => 't6 Gate LIRS: history exceeded its bound (' + lrsCache._hist._len + ')');
    if (!glirs.report.ok) {
        const g = glirs.summary.gc;
        die('t6 Gate LIRS (mixed churn) ops gate rejected -- verdict=' + glirs.report.verdict +
            ' source=' + glirs.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const glirsA = runAllocsGate(lrsHot, { iterations: 50000, batches: 8 });
    if (!glirsA.ok) {
        die('t6 Gate LIRS (mixed churn) retained-alloc gate rejected -- verdict=' + glirsA.report.verdict +
            ' settled=' + glirsA.result.settled + ' bytesPerCall=' + glirsA.bytesPerCall);
    }
    // Writes-per-hit pin: a LIR hit at the TOP of the stack relinks NOTHING (0 writes).
    const NLIRS = 16; // cap 16 -> L_hir 1, L_lir 15: keys 0..14 are LIR
    const clirs = new CountedLirs(NLIRS);
    for (let i = 0; i < NLIRS; i++) clirs.put(i, i);
    clirs.get(0);              // key 0 is a LIR block -> now moved to the TOP of S
    check((clirs._st[clirs._store.get(0)] & 1) !== 0 && clirs._sTop === clirs._store.get(0),
        () => 't6 Gate LIRS: setup -- key 0 is not a LIR at the stack top');
    clirs.resetWrites();
    clirs.get(0);             // LIR hit at the top -> the pinned 0-write fast path
    check(clirs.writes() === LIRS_WRITES_LIR_TOP_REHIT,
        () => 't6 Gate LIRS: LIR-hit-at-top wrote ' + clirs.writes() + ', expected ' + LIRS_WRITES_LIR_TOP_REHIT);
    // Lane coverage + the MEASURED max prune length (UN-measured window). Counters reset AFTER
    // the prefill so they reflect ONLY the steady-state window. Floors keep a regression LOUD.
    const covLirs = new CoveredLirs(CAP, { keys: 'int' });
    let covLirsi = 0;
    const covLirsHot = () => {
        const k = lrsStream[covLirsi & STREAM_MASK]; covLirsi++;
        if (covLirs.get(k) === undefined) covLirs.put(k, k); else covLirs.get(k);
    };
    for (let i = 0; i < PREFILL; i++) covLirsHot();
    covLirs._lirHits = 0; covLirs._promos = 0; covLirs._replaces = 0; covLirs._maxPrune = 0;
    for (let i = 0; i < OPS; i++) covLirsHot();
    check(covLirs._lirHits >= 100,
        () => 't6 Gate LIRS: the window triggered ' + covLirs._lirHits + ' LIR hits (< 100 -- lane not covered)');
    check(covLirs._promos >= 20,
        () => 't6 Gate LIRS: the window triggered ' + covLirs._promos + ' HIR->LIR promotions (< 20 -- lane not covered)');
    check(covLirs._replaces >= 50,
        () => 't6 Gate LIRS: the window triggered ' + covLirs._replaces + ' Q-front replaces (< 50 -- lane not covered)');
    check(covLirs._maxPrune <= covLirs._Lhir,
        () => 't6 Gate LIRS: steady-state max prune length ' + covLirs._maxPrune + ' exceeded L_hir ' + covLirs._Lhir);
    // The OWNER-RULING measurement: the ADVERSARIAL worst-case prune at capacity 4096.
    // Stack every resident HIR at the bottom of S above a single LIR, then touch that deep
    // LIR -> the move-to-top triggers a prune that walks the ENTIRE HIR run. In the bounded
    // design only resident HIR (<= L_hir) are ever in the linked stack, so the worst case is
    // exactly L_hir -- NOT O(capacity). Measured here (never capped), and timed to confirm
    // the single worst-case op stays well under the 4 ms pause budget.
    const adv = new CoveredLirs(CAP, { keys: 'int' });
    for (let i = 0; i < CAP; i++) adv.put(i, i);          // keys 0..L_lir-1 LIR, L_lir..CAP-1 HIR (at top)
    for (let i = 1; i < adv._Llir; i++) adv.get(i);       // lift every LIR but key 0 above the HIR run
    adv._maxPrune = 0;
    const advT0 = performance.now();
    adv.get(0);                                           // deep-LIR hit at the bottom -> the big prune
    const advMs = performance.now() - advT0;
    check(adv._maxPrune === adv._Lhir,
        () => 't6 Gate LIRS: adversarial prune measured ' + adv._maxPrune + ', expected the L_hir bound ' + adv._Lhir);
    check(advMs <= 4,
        () => 't6 Gate LIRS: adversarial worst-case prune took ' + advMs.toFixed(3) + ' ms (> 4 ms budget) -- BLOCKER');
    process.stderr.write('t6 Gate LIRS: ' + glirsA.bytesPerCall.toFixed(5) +
        ' B/op mixed churn (' + OPS + ' ops window, capacity ' + CAP + '); maxPauseMs=' +
        glirs.summary.gc.maxMs.toFixed(3) + ' adversarial max prune length=' + adv._maxPrune + ' (L_hir=' +
        adv._Lhir + ', worst-case op ' + advMs.toFixed(3) + ' ms); lanes covered: lirHits=' +
        covLirs._lirHits + ' promos=' + covLirs._promos + ' replaces=' + covLirs._replaces + '\n');

    // --- Gate LFU: the Lfu member -- STRICT zero-alloc + MEASURED writes-per-hit --------
    // (decisions/0024) The SAME MIXED, recurring int-key stream drives every LFU lane at
    // capacity: hot recurrence -> frequency climbs (bucket relabels + creates + destroys and
    // relinks to the freq+1 bucket); cold churn -> min-frequency-bucket evictions. Zero-alloc:
    // the closure indexes a preallocated Int32Array and does int get/put only. The key-list
    // columns `_fNext`/`_fPrev`/`_kB`, the bucket-pool columns `_b*` (Float64 + Int32), and the
    // int index buffers NEVER grow; the bucket pool stays conserved (live + free == cap always).
    const lfuStream = buildMixedStream(STREAM_LEN, HOT_SIZE, A1IN_CAP, 0x1f00d24);
    const lfuCache = new Lfu(CAP, { keys: 'int' });
    const lfuSink = new Int32Array(1);
    let lfui = 0;
    const lfuHot = () => {
        const k = lfuStream[lfui & STREAM_MASK]; lfui++;
        const v = lfuCache.get(k);
        if (v === undefined) lfuCache.put(k, k); else { lfuSink[0] += v | 0; lfuCache.get(k); }
    };
    for (let i = 0; i < PREFILL; i++) lfuHot(); // reach steady state
    check(lfuCache.size === CAP, () => 't6 Gate LFU: prefill did not reach capacity (size ' + lfuCache.size + ')');
    const lfuFNextBytes = lfuCache._fNext.buffer.byteLength;
    const lfuFPrevBytes = lfuCache._fPrev.buffer.byteLength;
    const lfuKBBytes = lfuCache._kB.buffer.byteLength;
    const lfuBFreqBytes = lfuCache._bFreq.buffer.byteLength;
    const lfuBNextBytes = lfuCache._bNext.buffer.byteLength;
    const lfuBPrevBytes = lfuCache._bPrev.buffer.byteLength;
    const lfuBHeadBytes = lfuCache._bHead.buffer.byteLength;
    const lfuBTailBytes = lfuCache._bTail.buffer.byteLength;
    const lfuIxSlotBytes = lfuCache._store._ixSlot.buffer.byteLength;
    const lfuIxKeyBytes = lfuCache._store._ixKey.buffer.byteLength;
    const glfu = runOpsGate(lfuHot, { ops: OPS, warmup: WARMUP });
    check(lfuCache._fNext.buffer.byteLength === lfuFNextBytes,
        () => 't6 Gate LFU: _fNext.buffer grew ' + lfuFNextBytes + ' -> ' + lfuCache._fNext.buffer.byteLength);
    check(lfuCache._fPrev.buffer.byteLength === lfuFPrevBytes,
        () => 't6 Gate LFU: _fPrev.buffer grew ' + lfuFPrevBytes + ' -> ' + lfuCache._fPrev.buffer.byteLength);
    check(lfuCache._kB.buffer.byteLength === lfuKBBytes,
        () => 't6 Gate LFU: _kB.buffer grew ' + lfuKBBytes + ' -> ' + lfuCache._kB.buffer.byteLength);
    check(lfuCache._bFreq.buffer.byteLength === lfuBFreqBytes,
        () => 't6 Gate LFU: _bFreq.buffer grew ' + lfuBFreqBytes + ' -> ' + lfuCache._bFreq.buffer.byteLength);
    check(lfuCache._bNext.buffer.byteLength === lfuBNextBytes,
        () => 't6 Gate LFU: _bNext.buffer grew ' + lfuBNextBytes + ' -> ' + lfuCache._bNext.buffer.byteLength);
    check(lfuCache._bPrev.buffer.byteLength === lfuBPrevBytes,
        () => 't6 Gate LFU: _bPrev.buffer grew ' + lfuBPrevBytes + ' -> ' + lfuCache._bPrev.buffer.byteLength);
    check(lfuCache._bHead.buffer.byteLength === lfuBHeadBytes,
        () => 't6 Gate LFU: _bHead.buffer grew ' + lfuBHeadBytes + ' -> ' + lfuCache._bHead.buffer.byteLength);
    check(lfuCache._bTail.buffer.byteLength === lfuBTailBytes,
        () => 't6 Gate LFU: _bTail.buffer grew ' + lfuBTailBytes + ' -> ' + lfuCache._bTail.buffer.byteLength);
    check(lfuCache._store._ixSlot.buffer.byteLength === lfuIxSlotBytes,
        () => 't6 Gate LFU: _ixSlot.buffer grew ' + lfuIxSlotBytes + ' -> ' + lfuCache._store._ixSlot.buffer.byteLength);
    check(lfuCache._store._ixKey.buffer.byteLength === lfuIxKeyBytes,
        () => 't6 Gate LFU: _ixKey.buffer grew ' + lfuIxKeyBytes + ' -> ' + lfuCache._store._ixKey.buffer.byteLength);
    check(lfuCache.size === CAP, () => 't6 Gate LFU: churn did not stay at capacity (size ' + lfuCache.size + ')');
    // The bucket pool is conserved: live buckets + free buckets == capacity (never grown).
    let lfuLive = 0; for (let b = lfuCache._bMin; b !== -1; b = lfuCache._bNext[b]) lfuLive++;
    let lfuFree = 0; for (let b = lfuCache._bFreeHead; b !== -1; b = lfuCache._bNext[b]) lfuFree++;
    check(lfuLive + lfuFree === CAP,
        () => 't6 Gate LFU: bucket pool not conserved (live ' + lfuLive + ' + free ' + lfuFree + ' != ' + CAP + ')');
    if (!glfu.report.ok) {
        const g = glfu.summary.gc;
        die('t6 Gate LFU (mixed churn) ops gate rejected -- verdict=' + glfu.report.verdict +
            ' source=' + glfu.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const glfuA = runAllocsGate(lfuHot, { iterations: 50000, batches: 8 });
    if (!glfuA.ok) {
        die('t6 Gate LFU (mixed churn) retained-alloc gate rejected -- verdict=' + glfuA.report.verdict +
            ' settled=' + glfuA.result.settled + ' bytesPerCall=' + glfuA.bytesPerCall);
    }
    // Writes-per-hit pins (DEBATE item 2 -- an LFU hit is zero-ALLOC but NOT zero-write).
    // (a) the FAST PATH: a single-key bucket with no freq+1 neighbour is RELABELLED in place.
    const clfuFast = new CountedLfu(8);
    clfuFast.put(0, 0);           // key 0 is the only key in a freq-1 bucket
    clfuFast.resetWrites();
    clfuFast.get(0);             // freq 1 -> 2, no freq-2 bucket -> relabel in place
    check(clfuFast.writes() === LFU_WRITES_FASTPATH,
        () => 't6 Gate LFU: fast-path (single-key relabel) wrote ' + clfuFast.writes() + ', expected ' + LFU_WRITES_FASTPATH);
    // (b) the WORST case over a churn window must never exceed the pinned bound.
    const clfu = new CountedLfu(CAP, { keys: 'int' });
    let clfui = 0, lfuMaxWrites = 0;
    for (let i = 0; i < STREAM_LEN; i++) {
        const k = lfuStream[i & STREAM_MASK];
        const s = clfu._store.get(k);
        if (s < 0) { clfu.put(k, k); continue; }
        clfu.resetWrites();
        clfu.get(k);
        if (clfu.writes() > lfuMaxWrites) lfuMaxWrites = clfu.writes();
    }
    check(lfuMaxWrites <= LFU_WRITES_MAX,
        () => 't6 Gate LFU: worst-case hit wrote ' + lfuMaxWrites + ' cells (> pinned bound ' + LFU_WRITES_MAX + ')');
    check(lfuMaxWrites > LFU_WRITES_FASTPATH,
        () => 't6 Gate LFU: writes-per-hit never exceeded the fast path -- the relink lane was not covered');
    // Lane coverage: the mixed stream must exercise bucket CREATES, DESTROYS and RELABELS.
    const covLfu = new CoveredLfu(CAP, { keys: 'int' });
    let covLfui = 0;
    const covLfuHot = () => {
        const k = lfuStream[covLfui & STREAM_MASK]; covLfui++;
        if (covLfu.get(k) === undefined) covLfu.put(k, k); else covLfu.get(k);
    };
    for (let i = 0; i < PREFILL; i++) covLfuHot();
    covLfu._bCreates = 0; covLfu._bDestroys = 0; covLfu._bRelabels = 0;
    for (let i = 0; i < OPS; i++) covLfuHot();
    check(covLfu._bCreates >= 50,
        () => 't6 Gate LFU: the window created ' + covLfu._bCreates + ' buckets (< 50 -- lane not covered)');
    check(covLfu._bDestroys >= 50,
        () => 't6 Gate LFU: the window destroyed ' + covLfu._bDestroys + ' buckets (< 50 -- lane not covered)');
    check(covLfu._bRelabels >= 50,
        () => 't6 Gate LFU: the window relabelled ' + covLfu._bRelabels + ' buckets (< 50 -- lane not covered)');
    process.stderr.write('t6 Gate LFU: ' + glfuA.bytesPerCall.toFixed(5) +
        ' B/op mixed churn (' + OPS + ' ops window, capacity ' + CAP + '); maxPauseMs=' +
        glfu.summary.gc.maxMs.toFixed(3) + '; writes/hit fast-path=' + LFU_WRITES_FASTPATH +
        ' worst-observed=' + lfuMaxWrites + ' (stream-dependent; pinned bound=' + LFU_WRITES_MAX +
        '); lanes covered: bucketCreates=' +
        covLfu._bCreates + ' destroys=' + covLfu._bDestroys + ' relabels=' + covLfu._bRelabels + '\n');

    // --- Gate CLOCKPRO: the ClockPro member -- STRICT zero-alloc + MEASURED writes-per-hit --
    // (decisions/0025) The SAME MIXED, recurring int-key stream drives every ClockPro lane at
    // capacity: hot recurrence -> reference bits set (0 relinks) + HAND_cold promotions of
    // referenced test pages; cold churn -> HAND_cold evictions + HAND_hot demotions + bounded-
    // history re-admits (raise _mHot) + HAND_test expiries (lower _mHot). Zero-alloc: the
    // closure indexes a preallocated Int32Array and does int get/put only. The ring columns
    // `_next`/`_prev`, the state column `_st`, the int index buffers AND the history ring never
    // grow; |hot| + |cold| == size == capacity always; the history stays bounded.
    const cpStream = buildMixedStream(STREAM_LEN, HOT_SIZE, A1IN_CAP, 0x1c10c9a0);
    const cpCache = new ClockPro(CAP, { keys: 'int' });
    const cpSink = new Int32Array(1);
    let cpi = 0;
    const cpHot = () => {
        const k = cpStream[cpi & STREAM_MASK]; cpi++;
        const v = cpCache.get(k);
        if (v === undefined) cpCache.put(k, k); else { cpSink[0] += v | 0; cpCache.get(k); }
    };
    for (let i = 0; i < PREFILL; i++) cpHot(); // reach steady state
    check(cpCache.size === CAP, () => 't6 Gate CLOCKPRO: prefill did not reach capacity (size ' + cpCache.size + ')');
    const cpNextBytes = cpCache._next.buffer.byteLength;
    const cpPrevBytes = cpCache._prev.buffer.byteLength;
    const cpStBytes = cpCache._st.buffer.byteLength;
    const cpIxSlotBytes = cpCache._store._ixSlot.buffer.byteLength;
    const cpIxKeyBytes = cpCache._store._ixKey.buffer.byteLength;
    const cpHistRingBytes = cpCache._hist._ring.buffer.byteLength;
    const gcp = runOpsGate(cpHot, { ops: OPS, warmup: WARMUP });
    check(cpCache._next.buffer.byteLength === cpNextBytes,
        () => 't6 Gate CLOCKPRO: _next.buffer grew ' + cpNextBytes + ' -> ' + cpCache._next.buffer.byteLength);
    check(cpCache._prev.buffer.byteLength === cpPrevBytes,
        () => 't6 Gate CLOCKPRO: _prev.buffer grew ' + cpPrevBytes + ' -> ' + cpCache._prev.buffer.byteLength);
    check(cpCache._st.buffer.byteLength === cpStBytes,
        () => 't6 Gate CLOCKPRO: _st.buffer grew ' + cpStBytes + ' -> ' + cpCache._st.buffer.byteLength);
    check(cpCache._store._ixSlot.buffer.byteLength === cpIxSlotBytes,
        () => 't6 Gate CLOCKPRO: _ixSlot.buffer grew ' + cpIxSlotBytes + ' -> ' + cpCache._store._ixSlot.buffer.byteLength);
    check(cpCache._store._ixKey.buffer.byteLength === cpIxKeyBytes,
        () => 't6 Gate CLOCKPRO: _ixKey.buffer grew ' + cpIxKeyBytes + ' -> ' + cpCache._store._ixKey.buffer.byteLength);
    check(cpCache._hist._ring.buffer.byteLength === cpHistRingBytes,
        () => 't6 Gate CLOCKPRO: history _ring grew ' + cpHistRingBytes + ' -> ' + cpCache._hist._ring.buffer.byteLength);
    check(cpCache.size === CAP, () => 't6 Gate CLOCKPRO: churn did not stay at capacity (size ' + cpCache.size + ')');
    check(cpCache._nHot + cpCache._nCold === CAP,
        () => 't6 Gate CLOCKPRO: hot(' + cpCache._nHot + ') + cold(' + cpCache._nCold + ') != capacity');
    check(cpCache._hist._len <= CAP,
        () => 't6 Gate CLOCKPRO: history exceeded its bound (' + cpCache._hist._len + ')');
    if (!gcp.report.ok) {
        const g = gcp.summary.gc;
        die('t6 Gate CLOCKPRO (mixed churn) ops gate rejected -- verdict=' + gcp.report.verdict +
            ' source=' + gcp.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gcpA = runAllocsGate(cpHot, { iterations: 50000, batches: 8 });
    if (!gcpA.ok) {
        die('t6 Gate CLOCKPRO (mixed churn) retained-alloc gate rejected -- verdict=' + gcpA.report.verdict +
            ' settled=' + gcpA.result.settled + ' bytesPerCall=' + gcpA.bytesPerCall);
    }
    // Writes-per-hit pin (the headline): a HIT relinks NOTHING (0 _next/_prev stores) and sets
    // exactly ONE _st byte (the reference bit) -- the Sieve/S3Fifo lazy-promotion discipline.
    const ccp = new CountedClockPro(16);
    for (let i = 0; i < 16; i++) ccp.put(i, i);
    ccp.get(5);                    // set the reference bit once (idempotent)
    ccp.resetWrites();
    ccp.get(5);                    // a hit -> 0 links, 1 state store
    check(ccp.writes() === CLOCKPRO_WRITES_HIT_LINKS,
        () => 't6 Gate CLOCKPRO: a hit relinked ' + ccp.writes() + ' cells, expected ' + CLOCKPRO_WRITES_HIT_LINKS);
    check(ccp.stWrites() === CLOCKPRO_WRITES_HIT_ST,
        () => 't6 Gate CLOCKPRO: a hit wrote ' + ccp.stWrites() + ' state bytes, expected ' + CLOCKPRO_WRITES_HIT_ST);
    // Miss+evict is NOT a constant: it is amortized O(1) (classic CLOCK) but WORST-CASE
    // O(capacity) `_st` writes on a full-scan-then-insert (HAND_cold + HAND_hot sweep the whole
    // clock clearing reference bits). We do NOT pin a bound. The number below is a per-STREAM
    // regression TRIPWIRE on `cpStream` only (a mixed stream that never does scan-then-insert):
    // if it ever exceeds the tripwire the change is investigated -- it is not a proven cap.
    const ccp2 = new CountedClockPro(CAP, { keys: 'int' });
    let ccp2i = 0, cpMaxWrites = 0;
    for (let i = 0; i < STREAM_LEN; i++) {
        const k = cpStream[i & STREAM_MASK];
        const s = ccp2._store.get(k);
        if (s >= 0) { ccp2.get(k); continue; }
        ccp2.resetWrites();
        ccp2.put(k, k);
        const w = ccp2.writes() + ccp2.stWrites();
        if (w > cpMaxWrites) cpMaxWrites = w;
    }
    check(cpMaxWrites <= CLOCKPRO_WRITES_MISS_EVICT_TRIPWIRE,
        () => 't6 Gate CLOCKPRO: cpStream miss+evict worst-observed ' + cpMaxWrites +
            ' exceeded the cpStream tripwire ' + CLOCKPRO_WRITES_MISS_EVICT_TRIPWIRE +
            ' (a per-stream regression tripwire, NOT a bound; the true worst case is O(capacity))');
    // Lane coverage: the mixed stream must exercise promotions, demotions, evictions and
    // history re-admits.
    const covCp = new CoveredClockPro(CAP, { keys: 'int' });
    let covCpi = 0;
    const covCpHot = () => {
        const k = cpStream[covCpi & STREAM_MASK]; covCpi++;
        if (covCp.get(k) === undefined) covCp.put(k, k); else covCp.get(k);
    };
    for (let i = 0; i < PREFILL; i++) covCpHot();
    covCp._promos = 0; covCp._demotes = 0; covCp._evicts = 0; covCp._histReadmits = 0;
    for (let i = 0; i < OPS; i++) covCpHot();
    check(covCp._evicts >= 100,
        () => 't6 Gate CLOCKPRO: the window triggered ' + covCp._evicts + ' evictions (< 100 -- lane not covered)');
    check(covCp._promos >= 20,
        () => 't6 Gate CLOCKPRO: the window triggered ' + covCp._promos + ' cold->hot promotions (< 20 -- lane not covered)');
    check(covCp._demotes >= 20,
        () => 't6 Gate CLOCKPRO: the window triggered ' + covCp._demotes + ' hot->cold demotions (< 20 -- lane not covered)');
    check(covCp._histReadmits >= 20,
        () => 't6 Gate CLOCKPRO: the window triggered ' + covCp._histReadmits + ' history re-admits (< 20 -- lane not covered)');
    process.stderr.write('t6 Gate CLOCKPRO: ' + gcpA.bytesPerCall.toFixed(5) +
        ' B/op mixed churn (' + OPS + ' ops window, capacity ' + CAP + '); maxPauseMs=' +
        gcp.summary.gc.maxMs.toFixed(3) + '; writes/hit links=' + CLOCKPRO_WRITES_HIT_LINKS +
        ' state=' + CLOCKPRO_WRITES_HIT_ST + '; miss+evict worst-on-cpStream=' + cpMaxWrites +
        ' (amortized O(1); worst-case O(capacity) on scan-then-insert; cpStream tripwire=' +
        CLOCKPRO_WRITES_MISS_EVICT_TRIPWIRE + '); lanes covered: promos=' +
        covCp._promos + ' demotes=' + covCp._demotes + ' evicts=' + covCp._evicts +
        ' historyReadmits=' + covCp._histReadmits + '\n');

    // --- Gate LRUK: the LruK member -- STRICT zero-alloc + MEASURED writes-per-hit + scan ------
    // (decisions/0026) The SAME MIXED, recurring int-key stream drives every LRU-K lane at
    // capacity: hot recurrence -> cold->warm promotions (2 stamps + 5 links) and warm re-hits (2
    // stamps + 0 links); cold churn -> cold-tail (O(1)) evictions + bounded-history re-admits.
    // Zero-alloc: the closure indexes a preallocated Int32Array and does int get/put only. The
    // shared link columns `_next`/`_prev`, the two reference-time columns `_r0`/`_r1`, the state
    // column `_st`, the int index buffers AND the history ring NEVER grow; |cold| + |warm| ==
    // size == capacity always; the history stays bounded.
    const lkStream = buildMixedStream(STREAM_LEN, HOT_SIZE, A1IN_CAP, 0x1b2c0de5);
    const lkCache = new LruK(CAP, { keys: 'int' });
    const lkSink = new Int32Array(1);
    let lki = 0;
    const lkHot = () => {
        const k = lkStream[lki & STREAM_MASK]; lki++;
        const v = lkCache.get(k);
        if (v === undefined) lkCache.put(k, k); else { lkSink[0] += v | 0; lkCache.get(k); }
    };
    for (let i = 0; i < PREFILL; i++) lkHot(); // reach steady state
    check(lkCache.size === CAP, () => 't6 Gate LRUK: prefill did not reach capacity (size ' + lkCache.size + ')');
    const lkNextBytes = lkCache._next.buffer.byteLength;
    const lkPrevBytes = lkCache._prev.buffer.byteLength;
    const lkR0Bytes = lkCache._r0.buffer.byteLength;
    const lkR1Bytes = lkCache._r1.buffer.byteLength;
    const lkStBytes = lkCache._st.buffer.byteLength;
    const lkIxSlotBytes = lkCache._store._ixSlot.buffer.byteLength;
    const lkIxKeyBytes = lkCache._store._ixKey.buffer.byteLength;
    const lkHistRingBytes = lkCache._hist._ring.buffer.byteLength;
    const glk = runOpsGate(lkHot, { ops: OPS, warmup: WARMUP });
    check(lkCache._next.buffer.byteLength === lkNextBytes,
        () => 't6 Gate LRUK: _next.buffer grew ' + lkNextBytes + ' -> ' + lkCache._next.buffer.byteLength);
    check(lkCache._prev.buffer.byteLength === lkPrevBytes,
        () => 't6 Gate LRUK: _prev.buffer grew ' + lkPrevBytes + ' -> ' + lkCache._prev.buffer.byteLength);
    check(lkCache._r0.buffer.byteLength === lkR0Bytes,
        () => 't6 Gate LRUK: _r0.buffer grew ' + lkR0Bytes + ' -> ' + lkCache._r0.buffer.byteLength);
    check(lkCache._r1.buffer.byteLength === lkR1Bytes,
        () => 't6 Gate LRUK: _r1.buffer grew ' + lkR1Bytes + ' -> ' + lkCache._r1.buffer.byteLength);
    check(lkCache._st.buffer.byteLength === lkStBytes,
        () => 't6 Gate LRUK: _st.buffer grew ' + lkStBytes + ' -> ' + lkCache._st.buffer.byteLength);
    check(lkCache._store._ixSlot.buffer.byteLength === lkIxSlotBytes,
        () => 't6 Gate LRUK: _ixSlot.buffer grew ' + lkIxSlotBytes + ' -> ' + lkCache._store._ixSlot.buffer.byteLength);
    check(lkCache._store._ixKey.buffer.byteLength === lkIxKeyBytes,
        () => 't6 Gate LRUK: _ixKey.buffer grew ' + lkIxKeyBytes + ' -> ' + lkCache._store._ixKey.buffer.byteLength);
    check(lkCache._hist._ring.buffer.byteLength === lkHistRingBytes,
        () => 't6 Gate LRUK: history _ring grew ' + lkHistRingBytes + ' -> ' + lkCache._hist._ring.buffer.byteLength);
    check(lkCache.size === CAP, () => 't6 Gate LRUK: churn did not stay at capacity (size ' + lkCache.size + ')');
    check(lkCache._hist._len <= CAP,
        () => 't6 Gate LRUK: history exceeded its bound (' + lkCache._hist._len + ')');
    if (!glk.report.ok) {
        const g = glk.summary.gc;
        die('t6 Gate LRUK (mixed churn) ops gate rejected -- verdict=' + glk.report.verdict +
            ' source=' + glk.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const glkA = runAllocsGate(lkHot, { iterations: 50000, batches: 8 });
    if (!glkA.ok) {
        die('t6 Gate LRUK (mixed churn) retained-alloc gate rejected -- verdict=' + glkA.report.verdict +
            ' settled=' + glkA.result.settled + ' bytesPerCall=' + glkA.bytesPerCall);
    }
    // Writes-per-hit pins (the headline, decisions/0026 D26.2). A WARM hit relinks NOTHING (0
    // `_next`/`_prev` stores) + 2 stamps; a COLD->WARM promotion is EXACTLY 5 link stores
    // (2 cold-detach + 3 warm-push, non-exceedable) + the SAME 2 stamps.
    const clk = new CountedLruK(16);
    clk.put(100, 100); clk.get(100);          // key 100 warm
    for (let i = 1; i <= 5; i++) clk.put(i, i); // cold list head->tail: 5,4,3,2,1
    clk.resetWrites();
    clk.get(3);                                // INTERIOR cold, warm non-empty -> exactly 5 links
    check(clk.writes() === LRUK_WRITES_HIT_PROMOTE,
        () => 't6 Gate LRUK: cold->warm promotion relinked ' + clk.writes() + ' cells, expected ' + LRUK_WRITES_HIT_PROMOTE);
    check(clk.stamps() === LRUK_WRITES_HIT_STAMPS,
        () => 't6 Gate LRUK: promotion stamped ' + clk.stamps() + ' reference times, expected ' + LRUK_WRITES_HIT_STAMPS);
    clk.resetWrites();
    clk.get(3);                                // now warm -> 0 links, 2 stamps
    check(clk.writes() === LRUK_WRITES_HIT_WARM,
        () => 't6 Gate LRUK: a warm hit relinked ' + clk.writes() + ' cells, expected ' + LRUK_WRITES_HIT_WARM);
    check(clk.stamps() === LRUK_WRITES_HIT_STAMPS,
        () => 't6 Gate LRUK: a warm hit stamped ' + clk.stamps() + ' reference times, expected ' + LRUK_WRITES_HIT_STAMPS);
    // The 5-link promotion bound is PROVEN non-exceedable over a churn window: no promotion path
    // ever relinks more than 5 cells (the honest ceiling, not just the pinned scenario).
    const clk2 = new CountedLruK(CAP, { keys: 'int' });
    let clk2i = 0, lkMaxPromo = 0;
    for (let i = 0; i < STREAM_LEN; i++) {
        const k = lkStream[i & STREAM_MASK];
        const s = clk2._store.get(k);
        if (s < 0) { clk2.put(k, k); continue; }
        clk2.resetWrites();
        clk2.get(k);
        if (clk2.writes() > lkMaxPromo) lkMaxPromo = clk2.writes();
    }
    check(lkMaxPromo <= LRUK_WRITES_HIT_PROMOTE,
        () => 't6 Gate LRUK: worst-observed hit relinked ' + lkMaxPromo + ' cells (> the non-exceedable 5)');
    // The min-r1 WARM SCAN is O(size) READS -- NOT amortized O(1), NO claimed bound. Drive a
    // dedicated ALL-WARM stream at capacity so every insert triggers the full-list scan, MEASURE
    // the worst-observed scan length (per-stream tripwire, never a cap), and time the worst single
    // op to confirm it stays under the 4 ms pause budget.
    const advLk = new CoveredLruK(CAP, { keys: 'int' });
    for (let i = 0; i < CAP; i++) { advLk.put(i, i); advLk.get(i); } // every resident is warm
    check(advLk._coldHead === -1, () => 't6 Gate LRUK: adversarial setup left a cold page (not all-warm)');
    advLk._maxScan = 0;
    let lkWorstMs = 0;
    for (let i = 0; i < 200; i++) {
        const t0 = performance.now();
        advLk.put(CAP + i, i);       // all-warm -> _evictOne scans the whole warm list
        const d = performance.now() - t0;
        if (d > lkWorstMs) lkWorstMs = d;
        advLk.get(CAP + i);          // re-promote the newcomer so the set stays all-warm
    }
    check(advLk._maxScan >= 1000,
        () => 't6 Gate LRUK: all-warm scan measured ' + advLk._maxScan + ' (< 1000 -- the O(size) scan lane was not covered)');
    check(advLk._maxScan <= LRUK_EVICT_SCAN_TRIPWIRE,
        () => 't6 Gate LRUK: all-warm scan worst-observed ' + advLk._maxScan +
            ' exceeded the tripwire ' + LRUK_EVICT_SCAN_TRIPWIRE +
            ' (a per-stream regression tripwire, NOT a bound; the true worst case is O(capacity))');
    check(lkWorstMs <= 4,
        () => 't6 Gate LRUK: all-warm worst-case scan op took ' + lkWorstMs.toFixed(3) + ' ms (> 4 ms budget) -- BLOCKER');
    // Lane coverage. With cold-tail-first eviction + WARM re-admission, genuine cold->warm
    // promotions are rare in a generic steady-state mixed stream (a hot key is warm after warmup;
    // a returning key re-admits WARM, not via promotion), so a PURPOSE-BUILT driver drives all
    // lanes honestly: each fresh cold key is either PROMOTED (a 2nd reference while resident) or
    // left COLD (evicted cold-first), and a recently-evicted key is re-put to force a WARM
    // re-admit. Zero-alloc is proven by the gate above; this loop is unmeasured (int get/put only).
    const covLk = new CoveredLruK(CAP, { keys: 'int' });
    for (let i = 0; i < CAP; i++) covLk.put(i, i); // warm up to capacity
    covLk._promos = 0; covLk._coldEvicts = 0; covLk._warmEvicts = 0; covLk._histReadmits = 0;
    let covNk = CAP;
    for (let i = 0; i < OPS; i++) {
        const k = covNk++;
        covLk.put(k, k);                 // fresh cold insert (evicts the cold tail while cold pages exist)
        if ((i & 1) === 0) covLk.get(k); // half get a 2nd reference -> cold->warm promotion
        if ((i % 5) === 0) {             // re-put a recently-evicted key -> WARM re-admit
            const old = k - 500;
            if (old >= CAP) covLk.put(old, old);
        }
    }
    check(covLk._coldEvicts >= 100,
        () => 't6 Gate LRUK: the window triggered ' + covLk._coldEvicts + ' cold-tail evictions (< 100 -- lane not covered)');
    check(covLk._promos >= 100,
        () => 't6 Gate LRUK: the window triggered ' + covLk._promos + ' cold->warm promotions (< 100 -- lane not covered)');
    check(covLk._histReadmits >= 20,
        () => 't6 Gate LRUK: the window triggered ' + covLk._histReadmits + ' history re-admits (< 20 -- lane not covered)');
    process.stderr.write('t6 Gate LRUK: ' + glkA.bytesPerCall.toFixed(5) +
        ' B/op mixed churn (' + OPS + ' ops window, capacity ' + CAP + '); maxPauseMs=' +
        glk.summary.gc.maxMs.toFixed(3) + '; writes/hit warm-links=' + LRUK_WRITES_HIT_WARM +
        ' promote-links=' + LRUK_WRITES_HIT_PROMOTE + ' (worst-observed=' + lkMaxPromo +
        ', non-exceedable) stamps=' + LRUK_WRITES_HIT_STAMPS + '; min-r1 warm scan O(size) reads' +
        ' (all-warm worst-observed length=' + advLk._maxScan + ', worst op ' + lkWorstMs.toFixed(3) +
        ' ms; tripwire=' + LRUK_EVICT_SCAN_TRIPWIRE + ', NOT a bound); lanes covered: promos=' +
        covLk._promos + ' coldEvicts=' + covLk._coldEvicts + ' historyReadmits=' + covLk._histReadmits + '\n');

    // --- Gate MQ: the Mq member -- STRICT zero-alloc + MEASURED writes-per-hit + aging sweep ----
    // (decisions/0027) The SAME MIXED, recurring int-key stream drives every Multi-Queue lane at
    // capacity: hot recurrence -> refcount growth (re-band + move-to-band-MRU relinks) and the
    // fixed 7-step aging sweep (idle band tails decay toward Q0); cold churn -> lowest-queue-tail
    // evictions + bounded-Qout re-admits. Zero-alloc: the closure indexes a preallocated Int32Array
    // and does int get/put only. The shared link columns `_next`/`_prev`, the metadata columns
    // `_rc`/`_exq`/`_qn`, the queue head/tail arrays, the int index buffers AND the Qout ring +
    // its parallel refcount ring NEVER grow; sum(|Q0..Q7|) == size == capacity always; the Qout
    // stays bounded.
    const mqStream = buildMixedStream(STREAM_LEN, HOT_SIZE, A1IN_CAP, 0x3d7b0f19);
    const mqCache = new Mq(CAP, { keys: 'int' });
    const mqSink = new Int32Array(1);
    let mqi = 0;
    const mqHot = () => {
        const k = mqStream[mqi & STREAM_MASK]; mqi++;
        const v = mqCache.get(k);
        if (v === undefined) mqCache.put(k, k); else { mqSink[0] += v | 0; mqCache.get(k); }
    };
    for (let i = 0; i < PREFILL; i++) mqHot(); // reach steady state
    check(mqCache.size === CAP, () => 't6 Gate MQ: prefill did not reach capacity (size ' + mqCache.size + ')');
    const mqNextBytes = mqCache._next.buffer.byteLength;
    const mqPrevBytes = mqCache._prev.buffer.byteLength;
    const mqRcBytes = mqCache._rc.buffer.byteLength;
    const mqExqBytes = mqCache._exq.buffer.byteLength;
    const mqQnBytes = mqCache._qn.buffer.byteLength;
    const mqQHeadBytes = mqCache._qHead.buffer.byteLength;
    const mqQTailBytes = mqCache._qTail.buffer.byteLength;
    const mqIxSlotBytes = mqCache._store._ixSlot.buffer.byteLength;
    const mqIxKeyBytes = mqCache._store._ixKey.buffer.byteLength;
    const mqHistRingBytes = mqCache._hist._ring.buffer.byteLength;
    const mqHistRcBytes = mqCache._hist._rcRing.buffer.byteLength;
    const gmq = runOpsGate(mqHot, { ops: OPS, warmup: WARMUP });
    check(mqCache._next.buffer.byteLength === mqNextBytes,
        () => 't6 Gate MQ: _next.buffer grew ' + mqNextBytes + ' -> ' + mqCache._next.buffer.byteLength);
    check(mqCache._prev.buffer.byteLength === mqPrevBytes,
        () => 't6 Gate MQ: _prev.buffer grew ' + mqPrevBytes + ' -> ' + mqCache._prev.buffer.byteLength);
    check(mqCache._rc.buffer.byteLength === mqRcBytes,
        () => 't6 Gate MQ: _rc.buffer grew ' + mqRcBytes + ' -> ' + mqCache._rc.buffer.byteLength);
    check(mqCache._exq.buffer.byteLength === mqExqBytes,
        () => 't6 Gate MQ: _exq.buffer grew ' + mqExqBytes + ' -> ' + mqCache._exq.buffer.byteLength);
    check(mqCache._qn.buffer.byteLength === mqQnBytes,
        () => 't6 Gate MQ: _qn.buffer grew ' + mqQnBytes + ' -> ' + mqCache._qn.buffer.byteLength);
    check(mqCache._qHead.buffer.byteLength === mqQHeadBytes,
        () => 't6 Gate MQ: _qHead.buffer grew ' + mqQHeadBytes + ' -> ' + mqCache._qHead.buffer.byteLength);
    check(mqCache._qTail.buffer.byteLength === mqQTailBytes,
        () => 't6 Gate MQ: _qTail.buffer grew ' + mqQTailBytes + ' -> ' + mqCache._qTail.buffer.byteLength);
    check(mqCache._store._ixSlot.buffer.byteLength === mqIxSlotBytes,
        () => 't6 Gate MQ: _ixSlot.buffer grew ' + mqIxSlotBytes + ' -> ' + mqCache._store._ixSlot.buffer.byteLength);
    check(mqCache._store._ixKey.buffer.byteLength === mqIxKeyBytes,
        () => 't6 Gate MQ: _ixKey.buffer grew ' + mqIxKeyBytes + ' -> ' + mqCache._store._ixKey.buffer.byteLength);
    check(mqCache._hist._ring.buffer.byteLength === mqHistRingBytes,
        () => 't6 Gate MQ: Qout _ring grew ' + mqHistRingBytes + ' -> ' + mqCache._hist._ring.buffer.byteLength);
    check(mqCache._hist._rcRing.buffer.byteLength === mqHistRcBytes,
        () => 't6 Gate MQ: Qout _rcRing grew ' + mqHistRcBytes + ' -> ' + mqCache._hist._rcRing.buffer.byteLength);
    check(mqCache.size === CAP, () => 't6 Gate MQ: churn did not stay at capacity (size ' + mqCache.size + ')');
    check(mqCache._hist._len <= CAP, () => 't6 Gate MQ: Qout exceeded its bound (' + mqCache._hist._len + ')');
    if (!gmq.report.ok) {
        const g = gmq.summary.gc;
        die('t6 Gate MQ (mixed churn) ops gate rejected -- verdict=' + gmq.report.verdict +
            ' source=' + gmq.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gmqA = runAllocsGate(mqHot, { iterations: 50000, batches: 8 });
    if (!gmqA.ok) {
        die('t6 Gate MQ (mixed churn) retained-alloc gate rejected -- verdict=' + gmqA.report.verdict +
            ' settled=' + gmqA.result.settled + ' bytesPerCall=' + gmqA.bytesPerCall);
    }
    // Writes-per-hit pins (the headline, decisions/0027 D27.6). A hit already at the MRU of its
    // unchanged band relinks NOTHING (0 links); any other hit is EXACTLY 5 links (<= 2 detach +
    // <= 3 head push). Every access stamps exactly 3 metadata cells (`_rc`, `_qn`, `_exq`).
    {
        // Build the EXACT-5 scenario (interior detach + non-empty head push): band Q2 non-empty
        // (key z, rc 4), band Q1 = [y, A, x] with A INTERIOR (rc 3). No aging fires (lifeTime 16,
        // every exq still in the future). Hitting A brings rc 3->4 (Q1->Q2): detach interior A (2
        // links) + push to non-empty Q2 head (3 links) = exactly 5.
        const cmq = new CountedMq(16);
        cmq.put('z', 1); cmq.get('z'); cmq.get('z'); cmq.get('z'); // z rc4 -> Q2 (sole)
        cmq.put('x', 1); cmq.get('x');                             // x rc2 -> Q1 head
        cmq.put('A', 1); cmq.get('A'); cmq.get('A');               // A rc3 -> Q1 head (already MRU 3rd)
        cmq.put('y', 1); cmq.get('y');                             // y rc2 -> Q1 head; Q1 = [y, A, x]
        cmq.resetWrites();
        cmq.get('A');           // rc3->4 (Q1->Q2): interior detach(2) + non-empty push(3) = 5 links
        check(cmq.writes() === MQ_WRITES_HIT_RELINK,
            () => 't6 Gate MQ: an interior re-band hit relinked ' + cmq.writes() + ' cells, expected ' + MQ_WRITES_HIT_RELINK);
        check(cmq.stamps() === MQ_STAMPS_ACCESS,
            () => 't6 Gate MQ: a re-band hit stamped ' + cmq.stamps() + ' cells, expected ' + MQ_STAMPS_ACCESS);
        cmq.resetWrites();
        cmq.get('A');           // rc4->5 -> still band 2, already MRU of Q2: 0 links + 3 stamps
        check(cmq.writes() === MQ_WRITES_HIT_FASTPATH,
            () => 't6 Gate MQ: an already-MRU hit relinked ' + cmq.writes() + ' cells, expected ' + MQ_WRITES_HIT_FASTPATH);
        check(cmq.stamps() === MQ_STAMPS_ACCESS,
            () => 't6 Gate MQ: an already-MRU hit stamped ' + cmq.stamps() + ' cells, expected ' + MQ_STAMPS_ACCESS);
    }
    // The clz32 band SATURATION guard (decisions/0027 D27.3, the RISK note): a refcount >= 128
    // must saturate the band at 7, NEVER index `_qn`/`_qHead`/`_qTail` out of range. Drive one key
    // past 128 references and confirm it lands in the top band and validate() stays coherent.
    {
        const sat = new Mq(4, { keys: 'int' });
        sat.put(1, 1);
        for (let i = 0; i < 300; i++) sat.get(1); // rc -> 301, well past 128
        const s = sat._store.get(1);
        check(sat._rc[s] >= 128, () => 't6 Gate MQ: saturation setup did not reach rc >= 128 (rc=' + sat._rc[s] + ')');
        check(sat._qn[s] === 7, () => 't6 Gate MQ: rc >= 128 banded to Q' + sat._qn[s] + ', expected the saturated top band Q7');
        validate(mqCache); validate(sat);
    }
    // The <= 33-link per-access CEILING is PROVEN non-exceedable by construction (D27.6): a hit is
    // <= 5 relink and the FIXED 7-step sweep is <= 7 demotions x <= 4 = 28, and RESET-ON-DEMOTE
    // forbids cascade (a demoted block lands at the HEAD of an already-visited lower band with a
    // fresh `_exq`, so it is never re-examined this sweep). MEASURE the worst-observed links/access
    // over both a mixed churn AND an adversarial band-decay stream, and assert it never exceeds 33.
    const cmq2 = new CountedMq(CAP, { keys: 'int' });
    for (let i = 0; i < CAP; i++) cmq2.put(i, i);
    let mqMaxLinks = 0, mqMaxStamps = 0;
    for (let i = 0; i < STREAM_LEN; i++) {
        const k = mqStream[i & STREAM_MASK];
        const s = cmq2._store.get(k);
        cmq2.resetWrites();
        if (s < 0) cmq2.put(k, k); else cmq2.get(k);
        if (cmq2.writes() > mqMaxLinks) mqMaxLinks = cmq2.writes();
        if (cmq2.stamps() > mqMaxStamps) mqMaxStamps = cmq2.stamps();
    }
    // Adversarial band-decay: seed single idle keys across bands 1..7, then churn fresh Q0 keys so
    // logical time advances past lifeTime and the banded tails decay -- the path that fires the
    // aging sweep hardest.
    const bandTargets = [2, 4, 8, 16, 32, 64, 128];
    for (let b = 0; b < bandTargets.length; b++) {
        const key = 900000 + b; cmq2.put(key, key);
        for (let j = 1; j < bandTargets[b]; j++) cmq2.get(key);
    }
    let fkey = 800000;
    for (let i = 0; i < CAP * 4; i++) {
        cmq2.resetWrites();
        cmq2.put(fkey++, 0);
        if (cmq2.writes() > mqMaxLinks) mqMaxLinks = cmq2.writes();
        if (cmq2.stamps() > mqMaxStamps) mqMaxStamps = cmq2.stamps();
    }
    check(mqMaxLinks <= MQ_WRITES_MAX,
        () => 't6 Gate MQ: worst-observed links/access ' + mqMaxLinks + ' exceeded the non-exceedable ceiling ' + MQ_WRITES_MAX);
    // Lane coverage: the aging sweep must genuinely fire (demotions > 0) and never demote a block
    // twice in one sweep (max demotions/sweep <= 7 = m-1 -- the reset-on-demote no-cascade proof).
    const covMq = new CoveredMq(CAP, { keys: 'int' });
    for (let i = 0; i < CAP; i++) covMq.put(i, i);
    covMq._demotes = 0; covMq._evicts = 0; covMq._histReadmits = 0; covMq._maxSweepDemotes = 0;
    let cmk = CAP;
    for (let i = 0; i < OPS; i++) {
        const k = mqStream[i & STREAM_MASK];
        if (covMq.get(k) === undefined) covMq.put(k, k); else covMq.get(k);
        if ((i & 3) === 0) covMq.put(cmk++, cmk); // fresh cold churn to advance time + evict
    }
    check(covMq._demotes > 0,
        () => 't6 Gate MQ: the window triggered 0 aging demotions (the sweep lane was not covered)');
    check(covMq._evicts > 0,
        () => 't6 Gate MQ: the window triggered 0 evictions (lane not covered)');
    check(covMq._maxSweepDemotes <= 7,
        () => 't6 Gate MQ: an aging sweep demoted ' + covMq._maxSweepDemotes + ' blocks (> m-1=7) -- a cascade slipped the reset-on-demote guard');
    process.stderr.write('t6 Gate MQ: ' + gmqA.bytesPerCall.toFixed(5) +
        ' B/op mixed churn (' + OPS + ' ops window, capacity ' + CAP + '); maxPauseMs=' +
        gmq.summary.gc.maxMs.toFixed(3) + '; writes/hit fastpath=' + MQ_WRITES_HIT_FASTPATH +
        ' relink=' + MQ_WRITES_HIT_RELINK + ' + aging <= ' + MQ_WRITES_AGING_MAX + ' (7 x 4) = <= ' +
        MQ_WRITES_MAX + ' links/access NON-EXCEEDABLE (worst-observed=' + mqMaxLinks + '); stamps/access=' +
        MQ_STAMPS_ACCESS + ' + 2/demotion (worst-observed=' + mqMaxStamps + '); lanes covered: demotes=' +
        covMq._demotes + ' evicts=' + covMq._evicts + ' maxDemotes/sweep=' + covMq._maxSweepDemotes +
        ' (<= 7, no cascade)\n');

    // --- Gate CAR: the Car member -- STRICT zero-alloc + MEASURED writes-per-hit --------------
    // (decisions/0028) The SAME MIXED, recurring int-key stream drives every CAR lane at capacity:
    // hot recurrence -> reference bits set (0 relinks) + T1->T2 migrations of referenced pages on
    // REPLACE; cold churn -> REPLACE evictions to B1/B2 + `p` adaptation on B1/B2 ghost hits + the
    // directory trim. Zero-alloc: the closure indexes a preallocated Int32Array and does int
    // get/put only. The clock columns `_next`/`_prev`, the state column `_st`, the int index
    // buffers AND both ghost rings + membership tables never grow; |T1|+|T2| == size == capacity
    // always; |T1|+|B1| <= c and the directory total <= 2c always.
    const carStream = buildMixedStream(STREAM_LEN, HOT_SIZE, A1IN_CAP, 0xCA55EED0);
    const carCache = new Car(CAP, { keys: 'int' });
    const carSink = new Int32Array(1);
    let cari = 0;
    const carHot = () => {
        const k = carStream[cari & STREAM_MASK]; cari++;
        const v = carCache.get(k);
        if (v === undefined) carCache.put(k, k); else { carSink[0] += v | 0; carCache.get(k); }
    };
    for (let i = 0; i < PREFILL; i++) carHot(); // reach steady state (both ghosts populated)
    check(carCache.size === CAP, () => 't6 Gate CAR: prefill did not reach capacity (size ' + carCache.size + ')');
    const carNextBytes = carCache._next.buffer.byteLength;
    const carPrevBytes = carCache._prev.buffer.byteLength;
    const carStBytes = carCache._st.buffer.byteLength;
    const carIxSlotBytes = carCache._store._ixSlot.buffer.byteLength;
    const carIxKeyBytes = carCache._store._ixKey.buffer.byteLength;
    const carB1RingBytes = carCache._b1._ring.buffer.byteLength;
    const carB2RingBytes = carCache._b2._ring.buffer.byteLength;
    const gcar = runOpsGate(carHot, { ops: OPS, warmup: WARMUP });
    check(carCache._next.buffer.byteLength === carNextBytes,
        () => 't6 Gate CAR: _next.buffer grew ' + carNextBytes + ' -> ' + carCache._next.buffer.byteLength);
    check(carCache._prev.buffer.byteLength === carPrevBytes,
        () => 't6 Gate CAR: _prev.buffer grew ' + carPrevBytes + ' -> ' + carCache._prev.buffer.byteLength);
    check(carCache._st.buffer.byteLength === carStBytes,
        () => 't6 Gate CAR: _st.buffer grew ' + carStBytes + ' -> ' + carCache._st.buffer.byteLength);
    check(carCache._store._ixSlot.buffer.byteLength === carIxSlotBytes,
        () => 't6 Gate CAR: _ixSlot.buffer grew ' + carIxSlotBytes + ' -> ' + carCache._store._ixSlot.buffer.byteLength);
    check(carCache._store._ixKey.buffer.byteLength === carIxKeyBytes,
        () => 't6 Gate CAR: _ixKey.buffer grew ' + carIxKeyBytes + ' -> ' + carCache._store._ixKey.buffer.byteLength);
    check(carCache._b1._ring.buffer.byteLength === carB1RingBytes,
        () => 't6 Gate CAR: B1 _ring grew ' + carB1RingBytes + ' -> ' + carCache._b1._ring.buffer.byteLength);
    check(carCache._b2._ring.buffer.byteLength === carB2RingBytes,
        () => 't6 Gate CAR: B2 _ring grew ' + carB2RingBytes + ' -> ' + carCache._b2._ring.buffer.byteLength);
    check(carCache.size === CAP, () => 't6 Gate CAR: churn did not stay at capacity (size ' + carCache.size + ')');
    check(carCache._t1Size + carCache._b1._len <= CAP, () => 't6 Gate CAR: |T1|+|B1| exceeded capacity (' + (carCache._t1Size + carCache._b1._len) + ')');
    check(carCache._t1Size + carCache._t2Size + carCache._b1._len + carCache._b2._len <= 2 * CAP,
        () => 't6 Gate CAR: directory total exceeded 2c (' + (carCache._t1Size + carCache._t2Size + carCache._b1._len + carCache._b2._len) + ')');
    if (!gcar.report.ok) {
        const g = gcar.summary.gc;
        die('t6 Gate CAR (mixed churn) ops gate rejected -- verdict=' + gcar.report.verdict +
            ' source=' + gcar.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
    }
    const gcarA = runAllocsGate(carHot, { iterations: 50000, batches: 8 });
    if (!gcarA.ok) {
        die('t6 Gate CAR (mixed churn) retained-alloc gate rejected -- verdict=' + gcarA.report.verdict +
            ' settled=' + gcarA.result.settled + ' bytesPerCall=' + gcarA.bytesPerCall);
    }
    // Writes-per-hit pin (the headline, D28.5): a HIT relinks NOTHING (0 _next/_prev stores) and
    // sets exactly ONE _st byte (the reference bit) -- the Sieve/S3Fifo/ClockPro discipline. This
    // is the 0-link-write / 1-`_st`-store hit gate; the ref-bit CLEARS live on the miss path below.
    const ccar = new CountedCar(16);
    for (let i = 0; i < 16; i++) ccar.put(i, i);
    ccar.get(5);                    // set the reference bit once (idempotent)
    ccar.resetWrites();
    ccar.get(5);                    // a hit -> 0 links, 1 state store
    check(ccar.writes() === CAR_WRITES_HIT_LINKS,
        () => 't6 Gate CAR: a hit relinked ' + ccar.writes() + ' cells, expected ' + CAR_WRITES_HIT_LINKS);
    check(ccar.stWrites() === CAR_WRITES_HIT_ST,
        () => 't6 Gate CAR: a hit wrote ' + ccar.stWrites() + ' state bytes, expected ' + CAR_WRITES_HIT_ST);
    // Miss+evict is NOT a constant: it is amortized O(1) (classic CLOCK) but WORST-CASE O(capacity)
    // `_st` + link writes on a full-scan-then-insert (REPLACE migrates/clears the whole clock before
    // it finds an unreferenced victim). We do NOT pin a bound. The number below is a per-STREAM
    // regression TRIPWIRE on `carStream` only (a mixed stream that never does scan-then-insert): if
    // it is ever exceeded the change is investigated -- it is not a proven cap. The ATTRIBUTION is
    // exact: these writes are measured on a put(miss) that reaches REPLACE, NEVER on the hit above.
    const ccar2 = new CountedCar(CAP, { keys: 'int' });
    let ccar2i = 0, carMaxWrites = 0;
    for (let i = 0; i < STREAM_LEN; i++) {
        const k = carStream[i & STREAM_MASK];
        const s = ccar2._store.get(k);
        if (s >= 0) { ccar2.get(k); continue; }
        ccar2.resetWrites();
        ccar2.put(k, k);
        const w = ccar2.writes() + ccar2.stWrites();
        if (w > carMaxWrites) carMaxWrites = w;
    }
    check(carMaxWrites <= CAR_WRITES_MISS_EVICT_TRIPWIRE,
        () => 't6 Gate CAR: carStream miss+evict worst-observed ' + carMaxWrites +
            ' exceeded the carStream tripwire ' + CAR_WRITES_MISS_EVICT_TRIPWIRE +
            ' (a per-stream regression tripwire, NOT a bound; the true worst case is O(capacity))');
    // Lane coverage: the mixed stream must exercise evictions, B1 hits, B2 hits, p-adaptations.
    const covCar = new CoveredCar(CAP, { keys: 'int' });
    let covCari = 0;
    const covCarHot = () => {
        const k = carStream[covCari & STREAM_MASK]; covCari++;
        if (covCar.get(k) === undefined) covCar.put(k, k); else covCar.get(k);
    };
    for (let i = 0; i < PREFILL; i++) covCarHot();
    covCar._pAdapts = 0; covCar._b1Hits = 0; covCar._b2Hits = 0; covCar._evicts = 0; covCar._migrations = 0;
    for (let i = 0; i < OPS; i++) covCarHot();
    check(covCar._evicts >= 100,
        () => 't6 Gate CAR: the window triggered ' + covCar._evicts + ' evictions (< 100 -- lane not covered)');
    check(covCar._b1Hits >= 50,
        () => 't6 Gate CAR: the window triggered ' + covCar._b1Hits + ' B1 ghost hits (< 50 -- lane not covered)');
    check(covCar._b2Hits >= 50,
        () => 't6 Gate CAR: the window triggered ' + covCar._b2Hits + ' B2 ghost hits (< 50 -- lane not covered)');
    check(covCar._pAdapts >= 100,
        () => 't6 Gate CAR: the window triggered ' + covCar._pAdapts + ' p-adaptations (< 100 -- lane not covered)');
    check(covCar._migrations > 0,
        () => 't6 Gate CAR: the window triggered 0 T1->T2 migrations (the clock second-chance lane was not covered)');
    process.stderr.write('t6 Gate CAR: ' + gcarA.bytesPerCall.toFixed(5) +
        ' B/op mixed churn (' + OPS + ' ops window, capacity ' + CAP + '); maxPauseMs=' +
        gcar.summary.gc.maxMs.toFixed(3) + '; writes/hit links=' + CAR_WRITES_HIT_LINKS +
        ' state=' + CAR_WRITES_HIT_ST + '; miss+evict worst-on-carStream=' + carMaxWrites +
        ' (amortized O(1); worst-case O(capacity) on scan-then-insert; carStream tripwire=' +
        CAR_WRITES_MISS_EVICT_TRIPWIRE + '); lanes covered: pAdapt=' + covCar._pAdapts +
        ' b1Hit=' + covCar._b1Hits + ' b2Hit=' + covCar._b2Hits + ' evicts=' + covCar._evicts +
        ' migrations=' + covCar._migrations + '\n');
}
