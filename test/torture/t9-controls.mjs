/**
 * t9 -- controls. Every gate must be provably able to fail (a gate that cannot
 * fail is decorative). Each control runs a deliberately-broken variant IN PROCESS
 * and asserts the corresponding gate flags it; where it matters it also proves
 * non-vacuity (the checker passes a genuinely correct input).
 *
 * The whole-suite control lives in T6: LLRU_TORTURE_BREAK=1 injects a retained
 * allocation into the T6 hot loop; controls.mjs drives that arm out-of-process.
 * The controls below prove each in-process gate bites on a plain `npm run torture`.
 *
 * Broken variants (subclasses / ad-hoc policies -- Lru.js is never modified):
 *   C1 _detach that dangles a prev            -> validate() reciprocity fails
 *   C2 evict that forgets the index delete    -> validate() index.size != size fails
 *   C3 get that skips _moveToFront            -> diverges from the LRU oracle
 *   C4 a hot loop that allocates per op        -> the alloc gates reject it
 *   C5 a broken SECOND policy (FIFO)           -> the runner catches it (the seam)
 *   C6 a growing int index buffer             -> validate()'s stability check fails
 *   C7 a SIEVE get that PROMOTES on hit        -> diverges from the sieve oracle
 *   C8 an S3-FIFO get that GRADUATES on touch  -> diverges from the s3fifo oracle
 *   C-stats-double-count  a put that counts puts twice -> brute-tally parity fails
 *   C-stats-counts-peek   a peek that credits a hit    -> brute-tally parity fails
 */

import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro, LruK, Mq, Car } from '../../Lru.js';
import {
    runOpsGate, runAllocsGate, runDifferential, wrapLru, wrapSieve, wrapS3Fifo, wrapWTinyLfu,
    wrapSlru, wrapTwoQ, wrapArc, wrapLirs, wrapLfu, wrapClockPro, wrapLruK, wrapMq, wrapCar, validate, runRoundTrip,
    lruPolicy, check, die, makePrng, spawnTtlConfig, parseTtlResult,
} from './harness.mjs';
import { makeCarOracle } from './oracles/car.mjs';
import { makeMqOracle } from './oracles/mq.mjs';
import { makeLfuOracle } from './oracles/lfu.mjs';
import { makeLruOracle } from './oracles/lru.mjs';
import { makeFifoOracle } from './oracles/fifo.mjs';
import { makeSieveOracle } from './oracles/sieve.mjs';
import { makeS3FifoOracle } from './oracles/s3fifo.mjs';
import { makeWTinyLfuOracle } from './oracles/wtinylfu.mjs';
import { makeSlruOracle } from './oracles/slru.mjs';
import { makeTwoQOracle } from './oracles/twoq.mjs';
import { makeArcOracle } from './oracles/arc.mjs';
import { makeLirsOracle } from './oracles/lirs.mjs';
import { makeClockProOracle } from './oracles/clockpro.mjs';
import { makeLruKOracle } from './oracles/lruk.mjs';

const NIL = -1;

/** C1: a _detach that updates the forward link but dangles the backward one. */
class BrokenDetach extends LiteLru {
    _detach(s) {
        const p = this._prev[s];
        const n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._head = n;
        // BUG: the `_prev[n] = p` fixup is dropped -> reciprocity breaks.
        if (n === NIL) this._tail = p;
    }
}

/** C2: an eviction that reuses the slot but forgets to delete the old index key. */
class BrokenEvict extends LiteLru {
    put(key, value) {
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) { this._vals[existing] = value; this._moveToFront(existing); return; }
        let s;
        if (this._size === this._capacity) {
            s = this._tail;
            const evKey = this._keys[s];
            const evVal = this._vals[s];
            this._detach(s);
            // BUG: store.delete(evKey) is dropped -> the stale key leaks in the index.
            this._size--;
            this._onEvict(evKey, evVal);
        } else {
            s = store.allocSlot();
        }
        this._keys[s] = key; this._vals[s] = value; store.set(key, s); this._pushFront(s); this._size++;
    }
}

/** C3: a get that returns the value but skips the recency promotion. */
class BrokenGet extends LiteLru {
    get(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        // BUG: this._moveToFront(s) is dropped -> recency never updates.
        return this._vals[s];
    }
}

/** C5: a FIFO real whose victim() reports the WRONG end (newest, not oldest). */
function makeBrokenFifoReal(cap) {
    const map = new Map();
    const q = [];
    return {
        get(k) { return map.has(k) ? map.get(k) : undefined; },
        put(k, v) {
            if (map.has(k)) { map.set(k, v); return; }
            if (map.size === cap) { const old = q.shift(); map.delete(old); }
            map.set(k, v); q.push(k);
        },
        has(k) { return map.has(k); },
        peek(k) { return map.has(k) ? map.get(k) : undefined; },
        delete(k) { if (!map.has(k)) return false; map.delete(k); const i = q.indexOf(k); if (i >= 0) q.splice(i, 1); return true; },
        size() { return map.size; },
        victim() { return q.length ? q[q.length - 1] : undefined; }, // BUG: newest, not oldest
    };
}

/** C7: a SIEVE get that PROMOTES the hit to the head (LRU-style relink) instead of
 *  merely setting the visited bit. That relink reorders the FIFO ring, so the next
 *  eviction victim drifts from the pure-SIEVE oracle -- the headline "zero relinks
 *  on hit" is exactly what must not be violated. (The hand still points at a live
 *  ring slot after the relink, so this is a semantic divergence, not a crash.) */
class PromotingSieve extends Sieve {
    get(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        this._vis[s] = 1;
        // BUG: promote to the head like LRU -> the FIFO order (and the victim) drift.
        this._detach(s);
        this._pushFront(s);
        return this._vals[s];
    }
}

/** C8: an S3-FIFO get that GRADUATES a SMALL entry to MAIN on first touch instead of
 *  at eviction time. The whole point of S3-FIFO (decisions/0013) is that promotion is
 *  DEFERRED to the eviction sweep: a hit sets the visited bit and moves nothing.
 *  Graduating eagerly changes the SMALL/MAIN populations, so the next-eviction victim
 *  drifts from the pure-S3-FIFO oracle. (The rings stay coherent, so this is a
 *  semantic divergence, not a crash.) */
class GraduateOnTouchS3Fifo extends S3Fifo {
    get(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        this._vis[s] = 1;
        // BUG: graduate to MAIN immediately (Q_SMALL === 0) instead of at eviction.
        if (this._q[s] === 0) {
            this._detach(s);
            this._pushMain(s);
            this._size = this._sSize + this._mSize;
        }
        return this._vals[s];
    }
}

/** C-slru-promote-on-first-hit (decisions/0015): an Slru whose `_touch` promotes a
 *  probation entry to protected on the FIRST hit instead of the SECOND. The pinned law
 *  (D15) is promote-on-2nd-hit (get once stays probation); promoting eagerly changes the
 *  probation/protected populations, so the next-eviction victim drifts from the pure
 *  Slru oracle. (Segments stay coherent, so this is a semantic divergence, not a crash.) */
class PromoteOnFirstHitSlru extends Slru {
    _touch(s) {
        if (this._seg[s] === 1) { // SLRU_PROTECTED
            if (this._protHead !== s) { this._detach(s); this._pushProtected(s); }
            return;
        }
        // BUG: promote on the FIRST hit (no 2nd-hit gate via _vis).
        this._detach(s);
        this._pushProtected(s);
        if (this._protSize > this._protectedCap) {
            const d = this._protTail;
            this._detach(d);
            this._vis[d] = 0;
            this._pushProbation(d);
        }
    }
}

/** C-twoq-unbounded-ghost (decisions/0015, D15.3): a TwoQ whose A1out ghost is UNBOUNDED
 *  (it never drops the oldest key when full). The ghost bound is load-bearing: a bounded
 *  ghost forgets old A1in-evicted keys, so a long-ago-evicted key re-enters A1in; an
 *  unbounded ghost remembers it forever and admits it straight to Am. That divergent
 *  admission drifts the segment populations and the next-eviction victim from the pure
 *  (bounded) TwoQ oracle. Uses the default Map backing + a growable Set so the override is
 *  self-consistent (the fixed ring buffers are simply unused). */
class UnboundedGhostTwoQ extends TwoQ {
    constructor(cap, options) {
        super(cap, options);
        this._ubGhost = new Set(); // BUG: unbounded membership -- never ages out
    }
    _ghostHas(key) { return this._ubGhost.has(key); }
    _ghostAdd(key) { this._ubGhost.add(key); this._gLen = this._ubGhost.size; }
    _ghostConsume(key) { this._ubGhost.delete(key); this._gLen = this._ubGhost.size; }
}

/** C-arc-p-frozen (decisions/0016, D16.3): an Arc whose adaptive `p` is PINNED at 0 (it
 *  never moves on a B1/B2 ghost hit). The adaptive law is that a B1 hit RAISES p and a B2
 *  hit LOWERS it; freezing p means REPLACE always sees p == 0 at op boundaries, so it
 *  evicts the T1 LRU where an adaptive ARC (with a grown p) would evict the T2 LRU -- the
 *  next-eviction victim MUST drift from the pure (adaptive) Arc oracle. Self-consistent
 *  (its own `_peekVictim` reads the frozen p), yet WRONG versus the oracle. */
class FrozenPArc extends Arc {
    put(key, value, ttlMs) {
        this._p = 0;
        super.put(key, value, ttlMs);
        this._p = 0; // BUG: never let the ghost-hit adaptation persist
    }
}

/** A minimal UNBOUNDED ghost (mirrors the C-twoq-unbounded-ghost control): a growable
 *  Set + array that NEVER ages out when full. Used to break Arc's ghost bound. */
class UnboundedGhost {
    constructor() { this._set = new Set(); this._arr = []; this._len = 0; }
    has(k) { return this._set.has(k); }
    addMRU(k) { if (!this._set.has(k)) { this._set.add(k); this._arr.push(k); this._len = this._set.size; } }
    delLRU() { const k = this._arr.shift(); this._set.delete(k); this._len = this._set.size; return k; }
    consume(k) { if (this._set.delete(k)) { const i = this._arr.indexOf(k); if (i >= 0) this._arr.splice(i, 1); } this._len = this._set.size; }
    clear() { this._set.clear(); this._arr.length = 0; this._len = 0; }
}

/** C-arc-unbounded-ghost (decisions/0016, D16.2): an Arc whose B1/B2 ghosts are UNBOUNDED
 *  (the combined-room trim is a no-op and the rings never age out). The ghost bound is
 *  load-bearing: a bounded ARC forgets old evicted keys, so a long-ago-evicted key re-
 *  enters T1 as a true miss; an unbounded one remembers it forever and re-admits it
 *  straight to T2, drifting the segment populations and the next-eviction victim from the
 *  pure (bounded) Arc oracle -- AND it violates the conservation ghost bound. */
class UnboundedGhostArc extends Arc {
    constructor(cap, options) {
        super(cap, options);
        this._b1 = new UnboundedGhost();
        this._b2 = new UnboundedGhost();
    }
    _ghostRoom() { /* BUG: never make combined-ghost room -> |B1|+|B2| grows unbounded */ }
}

/** C9: a W-TinyLFU whose admission ALWAYS admits the candidate (never rejects on a
 *  frequency tie/loss). The whole point of W-TinyLFU (decisions/0014) is that a cold
 *  one-hit-wonder must NOT displace a higher-frequency incumbent: admission is gated
 *  by `freq(candidate) > freq(victim)`. Admitting unconditionally evicts the probation
 *  victim every time, so the next-eviction victim drifts from the pure-W-TinyLFU
 *  oracle. (The three lists stay coherent, so this is a semantic divergence, not a
 *  crash.) _peekVictim uses the SAME overridden `_admit`, so the broken policy is
 *  self-consistent yet WRONG versus the oracle -- exactly what the gate must catch. */
class AdmitAlwaysWTinyLfu extends WTinyLfu {
    _admit(_candSlot, _victimSlot) { return true; } // BUG: never reject
}

/** C-lirs-drop-ins-bit (decisions/0023): a Lirs whose access policy IGNORES the `inS` bit,
 *  so a resident-HIR hit NEVER reclassifies to LIR (the recency-of-recency headline). Without
 *  the inS test a looping/scan-hot HIR that should promote stays HIR forever, so the LIR/HIR
 *  populations and the next-eviction victim (Q front) drift from the pure LIRS oracle. Self-
 *  consistent (its own _peekVictim reads its own Q), yet WRONG versus the oracle. */
class DropInsBitLirs extends Lirs {
    _access(s) {
        if (this._st[s] & 1) { // LIR branch -- unchanged
            if (this._sTop === s) return;
            const wasBottom = (this._sBot === s);
            this._sMoveTop(s);
            if (wasBottom) this._prune();
        } else {
            // BUG: never consult the inS bit -> a resident-HIR-in-S hit does not promote.
            if ((this._st[s] & 2) === 0) { this._sPushTop(s); this._st[s] |= 2; } else this._sMoveTop(s);
            this._qDetach(s); this._qPushTail(s);
        }
    }
}

/** C-lirs-no-history (decisions/0023): a Lirs whose bounded non-resident history is a NO-OP
 *  (has() always false, add/consume ignored). The history is load-bearing: a block evicted
 *  then re-referenced while still remembered is re-admitted as LIR (distinguishing a loop
 *  from a one-shot scan). Omitting it re-admits every returning key as a plain HIR, drifting
 *  the LIR set + the next-eviction victim from the pure (bounded-history) LIRS oracle. */
class NoHistoryLirs extends Lirs {
    constructor(cap, options) {
        super(cap, options);
        this._hist = { _len: 0, has() { return false; }, addMRU() {}, delLRU() {}, consume() {}, clear() {} };
    }
}

/** C-lfu-approx-freq (decisions/0024): an Lfu whose frequency counting SATURATES at 2 --
 *  the approximate-sketch behaviour Lfu exists to REJECT. Once a key reaches freq 2 it stops
 *  climbing (and stops relinking), so hot keys the exact oracle keeps separating collapse into
 *  one bucket -- the next-eviction victim + returned values drift from the pure EXACT-LFU
 *  oracle. Non-vacuity: the CORRECT (exact) Lfu agrees (t5). */
class ApproxFreqLfu extends Lfu {
    _touch(s) {
        if (this._bFreq[this._kB[s]] >= 2) return; // BUG: saturate -> approximate, not exact
        super._touch(s);
    }
}

/** C-clockpro-no-adapt (decisions/0025): a ClockPro whose adaptive hot target `_mHot` is
 *  FROZEN at 0 -- the D25.3 adaptation (raise on a bounded-history re-admit) is disabled. With
 *  `_mHot` pinned to 0 every promoted page is demoted immediately, so the hot/cold split never
 *  adapts and the next-eviction victim drifts from the pure (adaptive) ClockPro oracle. Self-
 *  consistent (its own _peekVictim reads its own frozen _mHot), yet WRONG versus the oracle.
 *  Non-vacuity: the CORRECT (adaptive) ClockPro agrees (t5). */
class NoAdaptClockPro extends ClockPro {
    put(key, value, ttlMs) { super.put(key, value, ttlMs); this._mHot = 0; } // BUG: never adapt
}

/** C-lruk-lru-tiebreak (decisions/0026): an LruK whose all-warm victim scan returns the warm
 *  LRU (warm tail) instead of the min-`_r1` page (the largest K=2 backward distance). This is
 *  exactly plain LRU-among-warm, NOT LRU-K, so the next-eviction victim drifts from the pure
 *  LRU-K oracle whenever the resident set is all warm. Self-consistent (its own _peekVictim
 *  reads the same broken scan), yet WRONG versus the oracle. Non-vacuity: the CORRECT LruK
 *  agrees (t5). */
class LruTiebreakLruK extends LruK {
    _scanWarmVictim() { return this._warmTail; } // BUG: LRU tiebreak, not min-r1 (K-distance)
}

/** C-mq-no-aging (decisions/0027): an Mq whose aging sweep is a NO-OP, so idle high-band blocks
 *  never decay toward Q0. MQ's whole point is that a once-hot block that goes cold is demoted and
 *  becomes evictable; freezing the sweep collapses it into a pure frequency policy, so the
 *  next-eviction victim drifts from the aging Mq oracle. Self-consistent (its own _peekVictim
 *  reads the same frozen bands), yet WRONG versus the oracle. Non-vacuity: the CORRECT Mq agrees
 *  (t5). */
class NoAgingMq extends Mq {
    _ageSweep() { /* BUG: never demote an idle band tail */ }
}

/** C-car-no-adapt (decisions/0028): a Car whose adaptive `p` is PINNED at 0 (it never moves on a
 *  B1/B2 ghost hit). CAR's headline is the SELF-TUNING split: a B1 (recent) ghost hit RAISES p, a
 *  B2 (frequent) ghost hit LOWERS it. Freezing p means REPLACE always sees max(1,p)==1 at op
 *  boundaries, so its clock-branch choice (T1 vs T2) is pinned -- the next-eviction victim MUST
 *  drift from the pure (adaptive) Car oracle. Self-consistent (its own _peekVictim reads the frozen
 *  p), yet WRONG versus the oracle. Non-vacuity: the CORRECT Car agrees (t5). */
class NoAdaptCar extends Car {
    put(key, value, ttlMs) {
        this._p = 0;
        super.put(key, value, ttlMs);
        this._p = 0; // BUG: never let the ghost-hit adaptation persist
    }
}

/** C-skip-gate (decisions/0017): a get that SKIPS the ttl staleness gate entirely, so a
 *  stale hit returns its (expired) value and promotes it instead of missing + reaping.
 *  It MUST diverge from the ttl oracle (which reaps a stale hit). */
class SkipTtlGateLru extends LiteLru {
    get(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        // BUG: no `this._exp[s] <= this._clock()` check -> stale entries never expire.
        this._moveToFront(s);
        return this._vals[s];
    }
}

/** C-stale-promotes (decisions/0017): a get that DETECTS a stale hit but PROMOTES it
 *  (treats it as a normal hit) instead of reaping. The lazy rule (D17.3) is "stale =
 *  MISS, reap in place, no promotion"; this breaks it, so it MUST diverge from the oracle. */
class StalePromotesLru extends LiteLru {
    get(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            // BUG: promote + return the stale value instead of reap + miss.
            this._moveToFront(s);
            return this._vals[s];
        }
        this._moveToFront(s);
        return this._vals[s];
    }
}

/** C-stats-double-count (decisions/0019): a put that increments `puts` TWICE. The
 *  counting law (D19.2) is exactly one `puts++` per put call; double-counting MUST
 *  diverge from a brute tally recomputed independently of the instance counters. */
class DoubleCountPutLru extends LiteLru {
    put(key, value, ttlMs) {
        super.put(key, value, ttlMs);
        if (this._stats !== null) this._stats.puts++; // BUG: a second, spurious puts++
    }
}

/** C-stats-counts-peek (decisions/0019): a peek that registers a HIT. peek is hit/miss-
 *  NEUTRAL (D19.2) -- an inspection is not an access; counting it MUST diverge from the
 *  brute tally, which never credits a peek. */
class PeekCountsLru extends LiteLru {
    peek(key) {
        const v = super.peek(key);
        if (this._stats !== null && v !== undefined) this._stats.hits++; // BUG: peek is not a hit
        return v;
    }
}

/**
 * Brute-tally parity (decisions/0019): drive a mixed get/put/peek/has stream against a
 * stats cache and INDEPENDENTLY recompute the four counters from OBSERVABLE semantics
 * (never reading the instance counters to decide). A get on a present key is a hit else
 * a miss; every put is one `puts`, and a put of an absent key at capacity is one
 * eviction; peek/has are neutral. Returns true iff `cache.stats()` matches the tally.
 * Non-TTL only, so `has`/`peek` used to probe presence never perturb anything.
 */
function bruteTallyMatches(makeCache, opts) {
    const prng = makePrng(opts.seed);
    const cache = makeCache(opts.cap);
    const ks = opts.keyspace;
    const exp = { hits: 0, misses: 0, evictions: 0, puts: 0 };
    for (let i = 0; i < opts.ops; i++) {
        const kind = prng() % 4;
        const key = prng() % ks;
        const val = prng() >>> 0;
        if (kind === 0) {                 // get: hit iff present (non-TTL: has is pure)
            if (cache.has(key)) exp.hits++; else exp.misses++;
            cache.get(key);
        } else if (kind === 1) {          // put: one puts; an absent key at capacity evicts
            exp.puts++;
            if (!cache.has(key) && cache.size === opts.cap) exp.evictions++;
            cache.put(key, val);
        } else if (kind === 2) {          // peek: neutral
            cache.peek(key);
        } else {                          // has: neutral
            cache.has(key);
        }
    }
    const st = cache.stats();
    return st.hits === exp.hits && st.misses === exp.misses &&
        st.evictions === exp.evictions && st.puts === exp.puts;
}

const leak = [];
const retainSink = [];

export function run() {
    // Liveness: count every control proven. The differential/gate/round-trip helpers
    // die on a toothless control, so a completed invocation count == controls proven;
    // the validate-teeth controls (which expect validate() to THROW) add one each.
    let units = 0;
    const _diff = runDifferential, _ops = runOpsGate, _allocs = runAllocsGate, _rt = runRoundTrip;
    const countDiff = (p, o) => { const r = _diff(p, o); units++; return r; };
    const countOps = (f, o) => { const r = _ops(f, o); units++; return r; };
    const countAllocs = (f, o) => { const r = _allocs(f, o); units++; return r; };
    const countRt = (m, o) => { const r = _rt(m, o); units++; return r; };

    // --- C0: non-vacuity -- a CORRECT cache validates clean and matches the oracle.
    {
        const c = new LiteLru(8);
        for (let i = 0; i < 12; i++) c.put(i, i);
        validate(c); // must not throw
        const r = countDiff(lruPolicy, { cap: 8, ops: 5000, seed: 12345, keyspace: 24 });
        if (!r.ok) die('t9 C0: a correct LiteLru diverged from its own oracle (the runner is vacuous)');
    }

    // --- C1: dangling-prev _detach -> validate() reciprocity fails --------------
    {
        const c = new BrokenDetach(6);
        for (let i = 0; i < 6; i++) c.put(i, i);
        c.get(2); // an interior re-hit -> broken detach dangles a prev
        let threw = false;
        try { validate(c); } catch (e) { threw = true; }
        if (!threw) die('t9 C1: validate() passed a cache with a dangling prev link (no teeth)');
        units++;
    }

    // --- C2: evict forgets the index delete -> validate() index.size != size -----
    {
        const c = new BrokenEvict(4);
        for (let i = 0; i < 5; i++) c.put(i, i); // the 5th put evicts and leaks an index key
        let threw = false;
        try { validate(c); } catch (e) { threw = true; }
        if (!threw) die('t9 C2: validate() passed a cache leaking an evicted index key (no teeth)');
        units++;
    }

    // --- C3: get skips _moveToFront -> diverges from the LRU oracle --------------
    {
        const brokenPolicy = {
            name: 'lru-broken-get',
            real: (cap) => wrapLru(new BrokenGet(cap)),
            oracle: (cap) => makeLruOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 8, ops: 20000, seed: 777, keyspace: 20 });
        if (r.ok) die('t9 C3: a get() that skips promotion did NOT diverge from the LRU oracle (no teeth)');
    }

    // --- C4: an allocating hot loop -> both alloc channels reject it -------------
    // ops channel: a retaining typed-array push grows arrayBuffers.
    const c4ops = countOps(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
    if (c4ops.report.ok) die('t9 C4: an allocating hot loop passed the zero-alloc ops gate');
    leak.length = 0;
    // retained channel: a boxed {} per op survives a forced collection.
    const c4ret = countAllocs((i) => { retainSink.push({ v: i }); }, { iterations: 50000, batches: 8 });
    if (c4ret.ok) die('t9 C4: a {}-per-op body passed the retained-alloc gate -- bytesPerCall=' + c4ret.bytesPerCall);
    retainSink.length = 0;
    // non-vacuity: a non-retaining preallocated-slot body passes.
    const slot = new Int32Array(1);
    const c4ok = countAllocs((i) => { slot[0] = i; }, { iterations: 50000, batches: 8 });
    if (!c4ok.ok) {
        die('t9 C4: a non-retaining slot-write body failed the retained-alloc gate (vacuous) -- verdict=' +
            c4ok.report.verdict + ' settled=' + c4ok.result.settled + ' bytesPerCall=' + c4ok.bytesPerCall);
    }

    // --- C5: the SEAM has teeth -- a broken SECOND policy is caught --------------
    // The runner is policy-parameterized: it drives FIFO too. A FIFO real whose
    // victim() reports the newest instead of the oldest MUST diverge from the FIFO
    // oracle -- proving the runner actually checks the plugged-in policy's victim.
    {
        const brokenFifo = { name: 'fifo-broken', real: makeBrokenFifoReal, oracle: makeFifoOracle };
        const r = countDiff(brokenFifo, { cap: 8, ops: 20000, seed: 999, keyspace: 24 });
        if (r.ok) die('t9 C5: a FIFO with a wrong victim() did NOT diverge from the FIFO oracle (the seam is toothless)');
        // non-vacuity: the CORRECT FIFO agrees with its oracle (proven in t5), and
        // the divergence above is a victim mismatch, not a value/size accident.
        check(r.why === 'victim' || r.why === 'value' || r.why === 'size',
            () => 't9 C5: divergence reason was ' + r.why + ' (unexpected)');
    }

    // --- C6: a GROWING int index -> validate()'s stability check fails -----------
    // The int substrate's whole promise (decisions/0011) is that even the keyed
    // index never allocates: its ArrayBuffers are fixed at construction. Simulate
    // the forbidden event -- an index that resized -- and assert validate() catches
    // it. Non-vacuity: the same cache validates clean BEFORE the buffer is grown.
    {
        const c = new LiteLru(64, { keys: 'int' });
        for (let i = 0; i < 80; i++) c.put(i, i); // churn past capacity (evictions)
        validate(c); // clean: the index buffers are the construction-time size
        // Grow the index backing store -- exactly what the fixed-capacity index forbids.
        c._store._ixSlot = new Int32Array(c._store._ixSlot.length * 2);
        let threw = false;
        try { validate(c); } catch (e) { threw = true; }
        if (!threw) die('t9 C6: validate() passed a grown int index buffer (the stability gate is toothless)');
        units++;
    }

    // --- C7: a SIEVE get that promotes-on-hit -> diverges from the sieve oracle ---
    // The SIEVE headline is "a hit does nothing structural". A get that relinks the
    // hit to the head reorders the FIFO ring, so its next-eviction victim MUST drift
    // from the pure-SIEVE oracle. Non-vacuity: the CORRECT Sieve agrees (proven in
    // t5); here the broken one must diverge, and specifically on the victim.
    {
        const brokenPolicy = {
            name: 'sieve-promoting-get',
            real: (cap) => wrapSieve(new PromotingSieve(cap)),
            oracle: (cap) => makeSieveOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 8, ops: 20000, seed: 424242, keyspace: 20 });
        if (r.ok) die('t9 C7: a SIEVE get() that promotes on hit did NOT diverge from the sieve oracle (no teeth)');
        check(r.why === 'victim',
            () => 't9 C7: expected the promoting-get divergence to be a victim mismatch, got ' + r.why);
    }

    // --- C8: an S3-FIFO get that graduates-on-touch -> diverges from the oracle ---
    // The S3-FIFO headline is deferred promotion: a hit sets the visited bit and
    // moves nothing; graduation happens only during the eviction sweep. A get that
    // graduates a SMALL entry to MAIN eagerly changes the queue populations, so its
    // next-eviction victim MUST drift from the pure-S3-FIFO oracle. Non-vacuity: the
    // CORRECT S3Fifo agrees (proven in t5); here the broken one must diverge.
    {
        const brokenPolicy = {
            name: 's3fifo-graduate-on-touch',
            real: (cap) => wrapS3Fifo(new GraduateOnTouchS3Fifo(cap)),
            oracle: (cap) => makeS3FifoOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 32, ops: 20000, seed: 131313, keyspace: 80 });
        if (r.ok) die('t9 C8: an S3-FIFO get() that graduates on touch did NOT diverge from the s3fifo oracle (no teeth)');
        check(r.why === 'victim' || r.why === 'value' || r.why === 'size',
            () => 't9 C8: divergence reason was ' + r.why + ' (unexpected)');
    }

    // --- C9: a W-TinyLFU that admits-always -> diverges from the wtinylfu oracle --
    // The W-TinyLFU headline is frequency admission: a candidate is admitted over the
    // probation victim ONLY when it is strictly more frequent (ties reject). A policy
    // that always admits evicts the incumbent victim regardless of frequency, so its
    // next-eviction victim MUST drift from the pure-W-TinyLFU oracle. Non-vacuity: the
    // CORRECT WTinyLfu agrees (proven in t5); here the broken one must diverge.
    {
        const brokenPolicy = {
            name: 'wtinylfu-admit-always',
            real: (cap) => wrapWTinyLfu(new AdmitAlwaysWTinyLfu(cap)),
            oracle: (cap) => makeWTinyLfuOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 32, ops: 20000, seed: 246810, keyspace: 80 });
        if (r.ok) die('t9 C9: a W-TinyLFU that admits-always did NOT diverge from the wtinylfu oracle (no teeth)');
        check(r.why === 'victim' || r.why === 'value' || r.why === 'size',
            () => 't9 C9: divergence reason was ' + r.why + ' (unexpected)');
    }

    // --- C-slru-promote-on-first-hit (decisions/0015): promote-on-1st-hit -> diverges
    // The Slru headline is promote-on-2nd-hit (get once stays probation). Promoting on the
    // first hit changes the probation/protected populations, so the next-eviction victim
    // MUST drift from the pure Slru oracle. Non-vacuity: the CORRECT Slru agrees (t5).
    {
        const brokenPolicy = {
            name: 'slru-promote-on-first-hit',
            real: (cap) => wrapSlru(new PromoteOnFirstHitSlru(cap)),
            oracle: (cap) => makeSlruOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 16, ops: 20000, seed: 0x51501, keyspace: 40 });
        if (r.ok) die('t9 C-slru-promote-on-first-hit: promoting on the FIRST hit did NOT diverge from the slru oracle (no teeth)');
    }

    // --- C-twoq-unbounded-ghost (decisions/0015, D15.3): an unbounded A1out -> diverges
    // The ghost bound is load-bearing: a bounded ghost forgets old A1in-evicted keys; an
    // unbounded one admits a long-ago-evicted key straight to Am, drifting the victim from
    // the pure (bounded) TwoQ oracle. Non-vacuity: the CORRECT TwoQ agrees (t5). This also
    // proves the risk the planner flagged (an unbounded ghost drifts) is actually caught.
    {
        const brokenPolicy = {
            name: 'twoq-unbounded-ghost',
            real: (cap) => wrapTwoQ(new UnboundedGhostTwoQ(cap)),
            oracle: (cap) => makeTwoQOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 16, ops: 20000, seed: 0x2001, keyspace: 40 });
        if (r.ok) die('t9 C-twoq-unbounded-ghost: an unbounded A1out ghost did NOT diverge from the twoq oracle (no teeth)');
        // Teeth on validate() too: the unbounded ghost violates the conservation bound.
        const c = new UnboundedGhostTwoQ(8);
        for (let i = 0; i < 200; i++) c.put(i, i); // distinct keys -> ghost grows past ghostCap
        check(c._gLen > c._ghostCap, () => 't9 C-twoq-unbounded-ghost: the ghost did not actually exceed its bound (setup invalid)');
        let threw = false;
        try { validate(c); } catch (e) { threw = true; }
        if (!threw) die('t9 C-twoq-unbounded-ghost: validate() passed a ghost over its bound (the ghost-bound term is toothless)');
        units++;
    }

    // --- C-arc-p-frozen (decisions/0016): a pinned `p` -> diverges from the arc oracle
    // The Arc headline is the SELF-TUNING split: a B1 hit raises p, a B2 hit lowers it.
    // Freezing p pins REPLACE's victim choice, so it drifts from the adaptive oracle.
    // Non-vacuity: the CORRECT Arc agrees (t5).
    {
        const brokenPolicy = {
            name: 'arc-p-frozen',
            real: (cap) => wrapArc(new FrozenPArc(cap)),
            oracle: (cap) => makeArcOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 16, ops: 20000, seed: 0xA2C01, keyspace: 40 });
        if (r.ok) die('t9 C-arc-p-frozen: a pinned `p` did NOT diverge from the arc oracle (no teeth)');
        // Teeth on the phase-change law directly: across a RECENCY phase (B1 hits) an
        // adaptive Arc raises p, but a frozen-p Arc does not. B1 only forms while T2 is
        // non-empty (an all-T1 cache direct-evicts, D16.4), so seed a little T2, then
        // capture the T1 LRU sent to B1 and re-reference it (a B1 hit) each round.
        let evA = null, evF = null;
        const adaptive = new Arc(16, { onEvict: (k) => { evA = k; } });
        const frozen = new FrozenPArc(16, { onEvict: (k) => { evF = k; } });
        for (let i = 0; i < 8; i++) { adaptive.put('f' + i, i); adaptive.get('f' + i); frozen.put('f' + i, i); frozen.get('f' + i); }
        for (let k = 0; k < 400; k++) {
            evA = null; adaptive.put('n' + k, k); if (evA !== null && adaptive._b1.has(evA)) adaptive.put(evA, 0);
            evF = null; frozen.put('n' + k, k); if (evF !== null && frozen._b1.has(evF)) frozen.put(evF, 0);
        }
        check(frozen._p === 0, () => 't9 C-arc-p-frozen: the frozen p moved (control invalid)');
        check(adaptive._p > 0, () => 't9 C-arc-p-frozen: the adaptive p did NOT rise in a recency phase (the phase-change law is toothless)');
    }

    // --- C-arc-unbounded-ghost (decisions/0016, D16.2): unbounded B1/B2 -> diverges + drifts
    // Non-vacuity: the CORRECT Arc agrees (t5). Teeth: an unbounded ghost re-admits an
    // ancient key straight to T2 (drifting the victim) AND overflows the ghost bound.
    {
        const brokenPolicy = {
            name: 'arc-unbounded-ghost',
            real: (cap) => wrapArc(new UnboundedGhostArc(cap)),
            oracle: (cap) => makeArcOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 16, ops: 20000, seed: 0xA2C02, keyspace: 60 });
        if (r.ok) die('t9 C-arc-unbounded-ghost: an unbounded B1/B2 ghost did NOT diverge from the arc oracle (no teeth)');
        // Teeth on validate() too: a MIXED workload (hot recurrence -> T2 promotions, cold
        // churn -> evictions, re-references -> ghost hits) makes the un-trimmed ghost grow
        // past its bound. (A pure distinct-key flood is all-T1 and direct-evicts with no
        // ghost -- D16.4 -- so it would never exercise the bound.)
        const prng = makePrng(0xA2CBEEF);
        const c = new UnboundedGhostArc(8);
        let cold = 8;
        for (let i = 0; i < 5000; i++) {
            const kind = prng() % 10;
            let k;
            if (kind < 5) k = prng() % 6;                 // hot recurrence -> T2 promotions
            else if (kind < 8) k = cold++;                // cold churn -> evictions to ghosts
            else k = cold - (2 + (prng() % 20));          // re-reference recently evicted -> ghost hits
            if (k < 0) k = prng() % 6;
            if (c.get(k) === undefined) c.put(k, k);
        }
        check(c._b1._len + c._b2._len > c._ghostCap,
            () => 't9 C-arc-unbounded-ghost: the ghost did not exceed its bound (setup invalid)');
        let threw = false;
        try { validate(c); } catch (e) { threw = true; }
        if (!threw) die('t9 C-arc-unbounded-ghost: validate() passed a ghost over its bound (the ghost-bound term is toothless)');
        units++;
    }

    // --- C-lirs-drop-ins-bit (decisions/0023): ignoring the inS bit -> diverges --------
    // The LIRS headline is recency-of-recency: a resident-HIR hit while IN the stack S
    // reclassifies to LIR. A policy that never reads the inS bit never promotes, so the
    // LIR/HIR split + the next-eviction victim drift from the pure LIRS oracle. Non-vacuity:
    // the CORRECT Lirs agrees (t5).
    {
        const brokenPolicy = {
            name: 'lirs-drop-ins-bit',
            real: (cap) => wrapLirs(new DropInsBitLirs(cap)),
            oracle: (cap) => makeLirsOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 16, ops: 20000, seed: 0x1145, keyspace: 40 });
        if (r.ok) die('t9 C-lirs-drop-ins-bit: ignoring the inS bit did NOT diverge from the lirs oracle (no teeth)');
    }

    // --- C-lirs-no-history (decisions/0023): omitting the non-resident history -> diverges
    // The bounded history is what lets a returning (evicted) block re-enter as LIR -- the
    // loop/scan discriminator. A no-op history re-admits every returning key as a plain HIR,
    // so the LIR set + victim drift from the pure (bounded-history) LIRS oracle. Non-vacuity:
    // the CORRECT Lirs agrees (t5).
    {
        const brokenPolicy = {
            name: 'lirs-no-history',
            real: (cap) => wrapLirs(new NoHistoryLirs(cap)),
            oracle: (cap) => makeLirsOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 16, ops: 20000, seed: 0x1146, keyspace: 40 });
        if (r.ok) die('t9 C-lirs-no-history: omitting the non-resident history did NOT diverge from the lirs oracle (no teeth)');
    }

    // --- C-lfu-approx-freq (decisions/0024): saturating frequency -> diverges -----------
    // Lfu's headline is EXACT frequency (what distinguishes it from the approximate-sketch
    // WTinyLfu). A cache that saturates its counter at 2 collapses distinct hot frequencies
    // into one bucket, so the LRU-tie-break victim + returned values drift from the pure
    // EXACT-LFU oracle. Non-vacuity: the CORRECT Lfu agrees (t5).
    {
        const brokenPolicy = {
            name: 'lfu-approx-freq',
            real: (cap) => wrapLfu(new ApproxFreqLfu(cap)),
            oracle: (cap) => makeLfuOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 16, ops: 20000, seed: 0x1f24, keyspace: 40 });
        if (r.ok) die('t9 C-lfu-approx-freq: saturating the frequency counter did NOT diverge from the exact-lfu oracle (no teeth)');
    }

    // --- C-clockpro-no-adapt (decisions/0025): freezing the adaptive hot target -> diverges --
    // ClockPro's D25.3 adaptation (raise _mHot on a bounded-history re-admit, lower on a test-
    // page expiry) is load-bearing: freezing _mHot at 0 collapses the hot/cold split so the
    // next-eviction victim drifts from the adaptive oracle. Non-vacuity: the CORRECT ClockPro
    // agrees (t5).
    {
        const brokenPolicy = {
            name: 'clockpro-no-adapt',
            real: (cap) => wrapClockPro(new NoAdaptClockPro(cap)),
            oracle: (cap) => makeClockProOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 16, ops: 20000, seed: 0x1c9a, keyspace: 40 });
        if (r.ok) die('t9 C-clockpro-no-adapt: freezing the adaptive hot target did NOT diverge from the clockpro oracle (no teeth)');
    }

    // --- C-lruk-lru-tiebreak (decisions/0026): LRU-among-warm instead of min-r1 -> diverges ---
    // LRU-K's headline is recency-of-recency: among all-warm residents it evicts the SMALLEST
    // 2nd-reference time (the largest K=2 backward distance), NOT the plain LRU. A scan that
    // returns the warm LRU (warm tail) collapses LRU-K into ordinary LRU, so the next-eviction
    // victim drifts from the pure LRU-K oracle. Non-vacuity: the CORRECT LruK agrees (t5).
    {
        const brokenPolicy = {
            name: 'lruk-lru-tiebreak',
            real: (cap) => wrapLruK(new LruTiebreakLruK(cap)),
            oracle: (cap) => makeLruKOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 16, ops: 20000, seed: 0x2b1e, keyspace: 40 });
        if (r.ok) die('t9 C-lruk-lru-tiebreak: LRU-among-warm did NOT diverge from the lruk oracle (no teeth)');
    }

    // --- C-mq-no-aging (decisions/0027): freezing the aging sweep -> diverges -------------------
    // MQ's headline is that idle high-band blocks DECAY toward Q0 and become evictable. An Mq whose
    // aging sweep is a no-op keeps once-hot blocks pinned high forever, so the next-eviction victim
    // drifts from the aging Mq oracle. Non-vacuity: the CORRECT Mq agrees (t5).
    {
        const brokenPolicy = {
            name: 'mq-no-aging',
            real: (cap) => wrapMq(new NoAgingMq(cap)),
            oracle: (cap) => makeMqOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 16, ops: 20000, seed: 0x3c2f, keyspace: 40 });
        if (r.ok) die('t9 C-mq-no-aging: freezing the aging sweep did NOT diverge from the mq oracle (no teeth)');
    }

    // --- C-car-no-adapt (decisions/0028): a pinned `p` -> diverges from the car oracle ----------
    // CAR's headline is the SELF-TUNING split (the CLOCK reformulation of ARC): a B1 hit raises p,
    // a B2 hit lowers it. Freezing p pins REPLACE's clock-branch choice, so it drifts from the
    // adaptive oracle. Non-vacuity: the CORRECT Car agrees (t5).
    {
        const brokenPolicy = {
            name: 'car-no-adapt',
            real: (cap) => wrapCar(new NoAdaptCar(cap)),
            oracle: (cap) => makeCarOracle(cap),
        };
        const r = countDiff(brokenPolicy, { cap: 16, ops: 20000, seed: 0x4d0a, keyspace: 40 });
        if (r.ok) die('t9 C-car-no-adapt: a pinned `p` did NOT diverge from the car oracle (no teeth)');
        // Teeth on the phase-change law directly: across a RECENCY phase (B1 hits) an adaptive Car
        // raises p, but a no-adapt Car does not. Seed referenced T1 (so REPLACE migrates to T2,
        // freeing room for B1), then capture the T1 LRU sent to B1 and re-reference it each round.
        let evA = null, evF = null;
        const adaptive = new Car(16, { onEvict: (k) => { evA = k; } });
        const frozen = new NoAdaptCar(16, { onEvict: (k) => { evF = k; } });
        for (let i = 0; i < 8; i++) { adaptive.put('f' + i, i); adaptive.get('f' + i); frozen.put('f' + i, i); frozen.get('f' + i); }
        for (let k = 0; k < 400; k++) {
            evA = null; adaptive.put('n' + k, k); if (evA !== null && adaptive._b1.has(evA)) adaptive.put(evA, 0);
            evF = null; frozen.put('n' + k, k); if (evF !== null && frozen._b1.has(evF)) frozen.put(evF, 0);
        }
        check(frozen._p === 0, () => 't9 C-car-no-adapt: the frozen p moved (control invalid)');
        check(adaptive._p > 0, () => 't9 C-car-no-adapt: the adaptive p did NOT rise in a recency phase (the phase-change law is toothless)');
    }

    // --- C-skip-gate (decisions/0017): a get that skips the ttl gate -> diverges ---
    // The lazy TTL rule (D17.3): a stale hit is a MISS, reaped in place. A get that never
    // checks staleness returns the expired value and keeps it resident, so it MUST
    // diverge from the ttl oracle. Non-vacuity: the CORRECT ttl LRU agrees (t5).
    {
        const brokenPolicy = {
            name: 'lru-skip-ttl-gate',
            real: (cap, o) => wrapLru(new SkipTtlGateLru(cap, o)),
            oracle: (cap, o) => makeLruOracle(cap, o),
        };
        const r = countDiff(brokenPolicy, { cap: 8, ops: 20000, seed: 0x7771, keyspace: 20, ttl: 8 });
        if (r.ok) die('t9 C-skip-gate: a get() that skips the ttl gate did NOT diverge from the ttl oracle (no teeth)');
    }

    // --- C-stale-promotes (decisions/0017): a get that promotes a stale hit -> diverges
    // Detecting staleness but PROMOTING (not reaping) also breaks D17.3, so it MUST
    // diverge from the ttl oracle. Non-vacuity: the CORRECT ttl LRU agrees (t5).
    {
        const brokenPolicy = {
            name: 'lru-stale-promotes',
            real: (cap, o) => wrapLru(new StalePromotesLru(cap, o)),
            oracle: (cap, o) => makeLruOracle(cap, o),
        };
        const r = countDiff(brokenPolicy, { cap: 8, ops: 20000, seed: 0x7772, keyspace: 20, ttl: 8 });
        if (r.ok) die('t9 C-stale-promotes: a get() that promotes a stale hit did NOT diverge from the ttl oracle (no teeth)');
    }

    // --- C-growing-_exp (decisions/0017): a grown _exp buffer -> validate() fails ------
    // The ttl `_exp` column is fixed at construction and must NEVER grow (like the int
    // index). Simulate the forbidden event and assert validate() catches it. Non-vacuity:
    // the same cache validates clean BEFORE the buffer is grown.
    {
        const c = new LiteLru(64, { ttl: 1000 });
        for (let i = 0; i < 80; i++) c.put(i, i); // churn past capacity (evictions)
        validate(c); // clean: the _exp column is the construction-time size
        c._exp = new Float64Array(c._exp.length * 2); // grow -- exactly what is forbidden
        let threw = false;
        try { validate(c); } catch (e) { threw = true; }
        if (!threw) die('t9 C-growing-_exp: validate() passed a grown _exp buffer (the stability gate is toothless)');
        units++;
    }

    // --- C-iter-generator (decisions/0018, D18.2): a generator-based iterator that
    // allocates a fresh result PER STEP. The zero-GC iterStep gate (maxBytesPerCall 1)
    // MUST reject a per-step-allocating iterator; the hand-written borrowed-result
    // iterator passes it. (V8 escape-analysis ELIDES a purely transient generator
    // result, so the reliably-observable broken form RETAINS its per-step allocation --
    // an instance trail -- which is exactly the per-step growth the gate exists to catch.)
    {
        const ICAP = 4096;
        class GeneratorIterLru extends LiteLru {
            constructor(cap) { super(cap); this._trail = []; }
            *keys() {
                for (let s = this._head; s !== NIL; s = this._next[s]) {
                    this._trail.push([this._keys[s]]); // BUG: a fresh, retained tuple per step
                    yield this._keys[s];
                }
            }
        }
        const gCache = new GeneratorIterLru(ICAP);
        const rCache = new LiteLru(ICAP);
        for (let i = 0; i < ICAP; i++) { gCache.put(i, i); rCache.put(i, i); }
        const isink = new Int32Array(1);
        let git = gCache.keys();
        const genStep = () => { let r = git.next(); if (r.done) git = gCache.keys(); isink[0] += r.value | 0; };
        const gGate = countAllocs(genStep, { iterations: 50000, batches: 8 });
        if (gGate.ok) {
            die('t9 C-iter-generator: a generator-based iterator that allocates per step PASSED the ' +
                'iterStep alloc gate (no teeth) -- bytesPerCall=' + gGate.bytesPerCall);
        }
        // Non-vacuity: the real hand-written iterator over the SAME body is 0 B/op.
        let rit = rCache.keys();
        const realStep = () => { let r = rit.next(); if (r.done) rit = rCache.keys(); isink[0] += r.value | 0; };
        const rGate = countAllocs(realStep, { iterations: 50000, batches: 8 });
        if (!rGate.ok) {
            die('t9 C-iter-generator: the hand-written iterator FAILED its own zero-alloc gate (vacuous) -- ' +
                'verdict=' + rGate.report.verdict + ' settled=' + rGate.result.settled + ' bytesPerCall=' + rGate.bytesPerCall);
        }
    }

    // --- C-iter-promote (decisions/0018, D18.4): an iterator that PROMOTES on walk (calls
    // get() per entry) is NOT recency-neutral. The recency-neutral law -- a full walk
    // leaves the next eviction victim unchanged -- MUST reject it. Non-vacuity: the real
    // iterator leaves the victim intact.
    {
        class PromotingIterLru extends LiteLru {
            *keys() {
                const ks = [];
                for (let s = this._head; s !== NIL; s = this._next[s]) ks.push(this._keys[s]);
                for (let i = 0; i < ks.length; i++) { this.get(ks[i]); yield ks[i]; } // BUG: get() promotes
            }
        }
        // Non-vacuity: the correct iterator is recency-neutral.
        const ok = new LiteLru(8);
        for (let i = 0; i < 8; i++) ok.put(i, i);
        const okVictim = wrapLru(ok).victim();
        for (const k of ok.keys()) { void k; }
        check(wrapLru(ok).victim() === okVictim,
            () => 't9 C-iter-promote: the REAL iterator changed the victim (not recency-neutral)');
        // Teeth: the promoting walk drifts the victim.
        const b = new PromotingIterLru(8);
        for (let i = 0; i < 8; i++) b.put(i, i); // victim (LRU tail) = 0
        const bVictim = wrapLru(b).victim();
        for (const k of b.keys()) { void k; } // promotes every entry MRU->LRU
        if (wrapLru(b).victim() === bVictim) {
            die('t9 C-iter-promote: a promoting walk did NOT change the eviction victim (the recency-neutral law is toothless)');
        }
    }

    // --- C-iter-reap (decisions/0018, D18.5): an iterator that REAPS stale entries mid-walk
    // performs a structural mutation. Iteration must SKIP stale entries WITHOUT reaping
    // (size is unchanged by a walk); the size-unchanged law MUST reject a reaping walk.
    // Non-vacuity: the real iterator leaves size intact on an all-stale cache.
    {
        class ReapingIterLru extends LiteLru {
            *keys() {
                for (let s = this._head; s !== NIL;) {
                    const nx = this._next[s];
                    if (this._exp !== null && this._exp[s] <= this._clock()) this._reap(s); // BUG: reap mid-walk
                    else yield this._keys[s];
                    s = nx;
                }
            }
        }
        let now = 0; const clock = () => now;
        // Non-vacuity: the correct iterator skips stale entries but reaps none.
        const ok = new LiteLru(8, { ttl: 5, clock });
        for (let i = 0; i < 6; i++) ok.put(i, i);
        now = 100; // all stale
        const okSize = ok.size;
        for (const k of ok.keys()) { void k; }
        check(ok.size === okSize, () => 't9 C-iter-reap: the REAL iterator reaped stale entries mid-walk (size changed)');
        // Teeth: a reaping walk drops size.
        const b = new ReapingIterLru(8, { ttl: 5, clock });
        for (let i = 0; i < 6; i++) b.put(i, i); // stamped at now=100 -> exp 105
        now = 200; // all stale
        const bSize = b.size;
        for (const k of b.keys()) { void k; }
        if (b.size === bSize) {
            die('t9 C-iter-reap: a reaping walk did NOT change size (the no-reap-on-iterate law is toothless)');
        }
    }

    // --- C-stats-double-count (decisions/0019): a put that double-counts -> tally diverges
    // Non-vacuity: a CORRECT stats cache matches the brute tally exactly. Teeth: a put
    // that increments `puts` twice MUST diverge from the tally.
    {
        const opts = { cap: 8, ops: 5000, seed: 0x57A7C0DE, keyspace: 24 };
        if (!bruteTallyMatches((cap) => new LiteLru(cap, { stats: true }), opts)) {
            die('t9 C-stats: a correct stats LiteLru did NOT match the brute tally (the tally is vacuous)');
        }
        if (bruteTallyMatches((cap) => new DoubleCountPutLru(cap, { stats: true }), opts)) {
            die('t9 C-stats-double-count: a put that double-counts `puts` did NOT diverge from the brute tally (no teeth)');
        }
    }

    // --- C-stats-counts-peek (decisions/0019): a peek that credits a hit -> tally diverges
    // peek is hit/miss-neutral (D19.2); a peek that increments `hits` MUST diverge from the
    // brute tally (which never credits a peek). Same corpus as above.
    {
        const opts = { cap: 8, ops: 5000, seed: 0x9EEC0FFE, keyspace: 24 };
        if (!bruteTallyMatches((cap) => new LiteLru(cap, { stats: true }), opts)) {
            die('t9 C-stats: a correct stats LiteLru did NOT match the brute tally (the tally is vacuous)');
        }
        if (bruteTallyMatches((cap) => new PeekCountsLru(cap, { stats: true }), opts)) {
            die('t9 C-stats-counts-peek: a peek that credits a hit did NOT diverge from the brute tally (no teeth)');
        }
    }

    // --- C-snap-* (decisions/0021, D21): a restore that DROPS aux state MUST diverge ---
    // from the un-snapshotted twin (the round-trip differential). Dropping aux state is a
    // fail-OPEN correctness bug: the restored cache would make DIFFERENT future eviction
    // decisions. Three controls, one per kind of dropped aux; each runs the SAME
    // differential the t5 snapshot gate uses. Non-vacuity: the CORRECT restore agrees.
    {
        const cfg = { cap: 64, pre: 40000, ops: 60000, keyspace: 200, seed: 0x5ADC0DE };

        // arc-p-dropped: restore forgets the adaptive integer `p` (pins it to 0). REPLACE's
        // victim choice then drifts from the twin (whose p was preserved).
        class PDroppedArc extends Arc {
            static restore(snap, opts) { const inst = Arc.restore(snap, opts); inst._p = 0; return inst; }
        }
        // sketch-dropped: restore leaves the Count-Min sketch zeroed (drops frequency
        // history). Admission then differs from the twin (whose sketch was preserved).
        class SketchDroppedWTinyLfu extends WTinyLfu {
            static restore(snap, opts) {
                const copy = Object.assign({}, snap, { sk: new Array(snap.sk.length).fill(0), skSize: 0 });
                return WTinyLfu.restore(copy, opts);
            }
        }
        // ghost-omitted: restore drops the keys-only ghost. A ghost re-sighting that the
        // twin admits straight to MAIN instead enters SMALL -> the victim drifts.
        class GhostOmittedS3Fifo extends S3Fifo {
            static restore(snap, opts) {
                const copy = Object.assign({}, snap, { ghost: [] });
                return S3Fifo.restore(copy, opts);
            }
        }
        // lfu-freq-dropped: restore keeps the bucket ORDER but DROPS the exact frequencies,
        // compacting them to 1,2,3,... (the gaps between counted frequencies are lost). A
        // restore that defaults frequencies instead of reconstructing them is a fail-OPEN bug:
        // future promotions merge buckets after the WRONG number of accesses, so the victim
        // drifts from the twin (whose exact frequencies were preserved).
        class FreqDroppedLfu extends Lfu {
            static restore(snap, opts) {
                const copy = Object.assign({}, snap, {
                    buckets: snap.buckets.map((b, i) => ({ freq: i + 1, list: b.list })),
                });
                return Lfu.restore(copy, opts);
            }
        }
        // clockpro-hands-dropped: restore forgets the three swept hand positions (parks them
        // all at the head). HAND_cold/HAND_hot/HAND_test then sweep from the WRONG places, so
        // the victim drifts from the twin (whose hands were preserved). Post-restore mutation
        // (the snapshot itself is valid) -- exactly the fail-OPEN bug D25.6 requires t9 to catch.
        class HandsDroppedClockPro extends ClockPro {
            static restore(snap, opts) {
                const inst = ClockPro.restore(snap, opts);
                inst._handCold = inst._head; inst._handHot = inst._head; inst._handTest = inst._head;
                return inst;
            }
        }
        // clockpro-mhot-dropped: restore forgets the adaptive hot target (pins it to 0). The
        // promote/demote balance then differs from the twin (whose _mHot was preserved).
        class MHotDroppedClockPro extends ClockPro {
            static restore(snap, opts) { const inst = ClockPro.restore(snap, opts); inst._mHot = 0; return inst; }
        }
        // clockpro-test-bits-dropped: restore clears every per-page test bit. An evicted page
        // then never enters the bounded history (and referenced pages promote differently), so
        // the victim drifts from the twin (whose test bits were preserved).
        class TestBitsDroppedClockPro extends ClockPro {
            static restore(snap, opts) {
                const inst = ClockPro.restore(snap, opts);
                for (let i = 0; i < inst._st.length; i++) inst._st[i] &= ~4; // clear CLOCKPRO_TEST
                return inst;
            }
        }
        // lruk-drop-r1: restore keeps the lists + values but ZEROES every warm slot's 2nd-
        // reference time `_r1` (the K=2 backward distance). The all-warm min-r1 victim then
        // differs from the twin (whose r1 was preserved), a fail-OPEN future-eviction bug the
        // round-trip differential must catch. Post-restore mutation (the snapshot is valid).
        class R1DroppedLruK extends LruK {
            static restore(snap, opts) {
                const inst = LruK.restore(snap, opts);
                for (let s = inst._warmHead; s !== -1; s = inst._next[s]) inst._r1[s] = 0;
                return inst;
            }
        }
        // mq-drop-rc: restore keeps the queues + values but ZEROES every resident's refcount `_rc`.
        // The next reference then re-bands from rc 1 (Q0) instead of its true count, so future band
        // placement + the lowest-queue victim drift from the twin (whose rc was preserved) -- a
        // fail-OPEN future-eviction bug the round-trip differential must catch. Post-restore
        // mutation (the snapshot is valid).
        class RcDroppedMq extends Mq {
            static restore(snap, opts) {
                const inst = Mq.restore(snap, opts);
                for (let q = 0; q < 8; q++) {
                    for (let s = inst._qHead[q]; s !== -1; s = inst._next[s]) inst._rc[s] = 0;
                }
                return inst;
            }
        }
        // car-p-dropped: restore forgets the adaptive integer `p` (pins it to 0). REPLACE's
        // clock-branch choice then drifts from the twin (whose p was preserved).
        class PDroppedCar extends Car {
            static restore(snap, opts) { const inst = Car.restore(snap, opts); inst._p = 0; return inst; }
        }
        // car-ref-bits-dropped: restore CLEARS every per-page reference bit. The next REPLACE then
        // finds an unreferenced victim SOONER (no second chances / migrations), so the victim drifts
        // from the twin (whose reference bits were preserved). Post-restore mutation (the snapshot
        // itself is valid) -- exactly the fail-OPEN bug D28.6 requires t9 to catch.
        class RefBitsDroppedCar extends Car {
            static restore(snap, opts) {
                const inst = Car.restore(snap, opts);
                for (let i = 0; i < inst._st.length; i++) inst._st[i] &= ~1; // clear CAR_REF
                return inst;
            }
        }

        const controls = [
            { name: 'arc-p-dropped', broken: { Ctor: PDroppedArc, wrap: wrapArc }, real: { Ctor: Arc, wrap: wrapArc } },
            { name: 'sketch-dropped', broken: { Ctor: SketchDroppedWTinyLfu, wrap: wrapWTinyLfu }, real: { Ctor: WTinyLfu, wrap: wrapWTinyLfu } },
            { name: 'ghost-omitted', broken: { Ctor: GhostOmittedS3Fifo, wrap: wrapS3Fifo }, real: { Ctor: S3Fifo, wrap: wrapS3Fifo } },
            { name: 'lfu-freq-dropped', broken: { Ctor: FreqDroppedLfu, wrap: wrapLfu }, real: { Ctor: Lfu, wrap: wrapLfu } },
            { name: 'clockpro-hands-dropped', broken: { Ctor: HandsDroppedClockPro, wrap: wrapClockPro }, real: { Ctor: ClockPro, wrap: wrapClockPro } },
            { name: 'clockpro-mhot-dropped', broken: { Ctor: MHotDroppedClockPro, wrap: wrapClockPro }, real: { Ctor: ClockPro, wrap: wrapClockPro } },
            { name: 'clockpro-test-bits-dropped', broken: { Ctor: TestBitsDroppedClockPro, wrap: wrapClockPro }, real: { Ctor: ClockPro, wrap: wrapClockPro } },
            { name: 'lruk-drop-r1', broken: { Ctor: R1DroppedLruK, wrap: wrapLruK }, real: { Ctor: LruK, wrap: wrapLruK } },
            { name: 'mq-drop-rc', broken: { Ctor: RcDroppedMq, wrap: wrapMq }, real: { Ctor: Mq, wrap: wrapMq } },
            { name: 'car-p-dropped', broken: { Ctor: PDroppedCar, wrap: wrapCar }, real: { Ctor: Car, wrap: wrapCar } },
            { name: 'car-ref-bits-dropped', broken: { Ctor: RefBitsDroppedCar, wrap: wrapCar }, real: { Ctor: Car, wrap: wrapCar } },
        ];
        for (const ctl of controls) {
            // Non-vacuity: the CORRECT round-trip agrees with the twin (also proven in t5).
            const okr = countRt(ctl.real, cfg);
            if (!okr.ok) {
                die('t9 C-snap-' + ctl.name + ': the CORRECT round-trip diverged (' + okr.why +
                    ') -- the differential is vacuous');
            }
            // Teeth: dropping the aux state MUST diverge from the twin.
            const br = countRt(ctl.broken, cfg);
            if (br.ok) {
                die('t9 C-snap-' + ctl.name + ': a restore that drops the aux state did NOT diverge ' +
                    'from the twin (the round-trip differential is toothless)');
            }
        }
    }

    // C-ttl-boxing: the TTL zero-alloc lane must be able to FAIL. Reintroduce the A1
    // boxing (a helper that RETURNS the expiry double across a call boundary, parked in
    // a local before the typed-array store) in a child under --max-semi-space-size=4,
    // after a TTL-off warm-up. The scavenge lane MUST report > 0 at 8N; a lane that
    // stays 0 on genuinely-boxing code is decorative. (Lru.js is never modified: the
    // boxing lives in the harness's BoxingExpiryLru subclass.)
    {
        const parsed = parseTtlResult(spawnTtlConfig('LiteLru', 'epoch', true));
        check(parsed.ok, () => 't9 C-ttl-boxing: control child failed -- ' + parsed.error);
        const nHi = parsed.result['putchurn-broken'][1];
        check(nHi > 0,
            () => 't9 C-ttl-boxing: the boxing-expiry helper scavenged ' + nHi +
                ' at 8N (expected > 0 -- the TTL scavenge lane is toothless)');
        units++;
    }

    return units;
}
