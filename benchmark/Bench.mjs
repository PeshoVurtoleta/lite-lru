/**
 * @zakkster/lite-lru -- Bench.mjs: the shipped measurement tool (S9).
 *
 * A runnable ESM tool AND an importable module. Two entry paths, both supported:
 *
 *   node benchmark/Bench.mjs                         -- prints a readable table
 *   npm run bench                                    -- the same
 *   import { runBench, beladyOpt } from '@zakkster/lite-lru/benchmark/Bench.mjs'
 *
 * It imports ONLY ../Lru.js (the single implementation) -- zero runtime deps, and
 * NOT the test-only devDeps. It is a TOOL, not a hot path: zero-alloc is NOT a
 * requirement of the bench itself; it must only stay dependency-free and never
 * mutate global state.
 *
 * WHAT IT REPORTS. For each workload x member (LiteLru, Sieve, S3Fifo, WTinyLfu) on a DETERMINISTIC
 * seeded trace: hit ratio, writes-per-hit (metadata stores on the hit path), ns/op
 * (machine-local wall-clock, an EXAMPLE only), and pctOptimal = memberHits /
 * optHits * 100, where optHits is Belady's OPT -- the clairvoyant offline optimum
 * (evict the resident whose NEXT use is farthest away). OPT is a reference oracle,
 * NOT a cache policy; it never appears in Lru.js.
 *
 * HONESTY (the suite law 8 + the S9 rulings). Hit ratio is a bench OUTPUT reported
 * against a NAMED trace ("on this trace, ..."), never a headline claim, and never a
 * cross-library "beats X by N%" comparison. ns/op is wall-clock and machine-local:
 * reproduce it on your own hardware; the numbers move with the runtime. All members
 * are timed in ONE process, so cross-member ns/op carries shared-call-site (inline-cache
 * / megamorphic) bias -- another reason ns/op is indicative only. The FIXED structural
 * facts (writes-per-hit, zero-GC budgets) are gated in the torture suite, not measured here.
 *
 * @license MIT
 */

import {LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro, LruK, Mq, Car, VERSION} from '../Lru.js';

/* -------------------------------------------------------------------------- *
 * Seeded PRNG -- xorshift32, the same generator the torture harness uses, so a
 * trace is byte-reproducible from its seed. Kept local: Bench.mjs imports only
 * ../Lru.js.
 * -------------------------------------------------------------------------- */

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13;
        x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        return x >>> 0;
    };
}

/* -------------------------------------------------------------------------- *
 * Workload trace generators. Each returns a plain Array of non-negative integer
 * keys, fully determined by its seed + parameters, so hit ratios reproduce.
 * -------------------------------------------------------------------------- */

/**
 * ZIPF (skewed popularity). A small hot set is hit far more often than the long
 * tail -- the shape real web / CDN / database key access follows. Built from a
 * precomputed cumulative weight table for rank r ~ 1 / (r+1)^exponent, sampled
 * with the seeded PRNG. This is the workload where recency/frequency policies earn
 * their keep.
 */
export function zipfTrace(opts) {
    const n = opts.length;
    const keyspace = opts.keyspace;
    const exponent = opts.exponent === undefined ? 1.0 : opts.exponent;
    const prng = makePrng(opts.seed);

    // Cumulative weights over ranks 0..keyspace-1.
    const cum = new Float64Array(keyspace);
    let acc = 0;
    for (let r = 0; r < keyspace; r++) {
        acc += 1 / Math.pow(r + 1, exponent);
        cum[r] = acc;
    }
    const total = acc;

    const trace = new Array(n);
    for (let i = 0; i < n; i++) {
        const u = (prng() / 0x100000000) * total;
        // Binary search the cumulative table for the sampled rank.
        let lo = 0, hi = keyspace - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cum[mid] < u) lo = mid + 1; else hi = mid;
        }
        trace[i] = lo;
    }
    return trace;
}

/**
 * LOOP (sequential scan larger than the cache). Keys 0..span-1 repeated in order,
 * span > capacity. The textbook LRU pathology: by the time a key comes round again
 * it has just been evicted, so classic LRU thrashes to a near-zero hit ratio. A
 * useful floor case for "is a policy any better than LRU here?".
 */
export function loopTrace(opts) {
    const n = opts.length;
    const span = opts.span;
    const trace = new Array(n);
    for (let i = 0; i < n; i++) trace[i] = i % span;
    return trace;
}

/**
 * SCAN (one-hit-wonder flood). A stable hot set (size hotSize <= capacity) is
 * interleaved with a flood of DISTINCT single-use keys. A scan-resistant policy
 * keeps the hot set through the flood; a naive one lets the flood evict it. The
 * hot fraction controls how often a hot key vs a fresh flood key is emitted.
 */
export function scanTrace(opts) {
    const n = opts.length;
    const hotSize = opts.hotSize;
    const hotFraction = opts.hotFraction === undefined ? 0.5 : opts.hotFraction;
    const prng = makePrng(opts.seed);
    const hotBase = 0;
    const floodBase = hotSize; // flood keys never collide with the hot set
    let flood = floodBase;
    const trace = new Array(n);
    for (let i = 0; i < n; i++) {
        if ((prng() / 0x100000000) < hotFraction) {
            trace[i] = hotBase + (prng() % hotSize); // a hot-set key
        } else {
            trace[i] = flood++; // a fresh, single-use flood key
        }
    }
    return trace;
}

/**
 * WEB (diurnal hot-set shift + zipf tail). A seeded, deterministic "web-like"
 * generator: a hot set of `hotSize` keys whose base slowly ROTATES across the
 * keyspace over each `period` accesses (the "hot content of the hour" sliding as
 * the day turns), interleaved with a zipf-sampled long tail. `hotFraction`
 * controls the hot-vs-tail mix. Fully determined by seed + params, like the other
 * generators. NOT part of the default workload set -- an opt-in extra axis.
 */
export function webTrace(opts) {
    const n = opts.length;
    const keyspace = opts.keyspace;
    const hotSize = opts.hotSize === undefined ? (Math.max(1, keyspace >> 5)) : opts.hotSize;
    const exponent = opts.exponent === undefined ? 1.0 : opts.exponent;
    const hotFraction = opts.hotFraction === undefined ? 0.8 : opts.hotFraction;
    const period = opts.period === undefined ? (Math.max(1, n >> 3)) : opts.period;
    const prng = makePrng(opts.seed);

    // Cumulative zipf weights over the whole keyspace for the tail draw.
    const cum = new Float64Array(keyspace);
    let acc = 0;
    for (let r = 0; r < keyspace; r++) {
        acc += 1 / Math.pow(r + 1, exponent);
        cum[r] = acc;
    }
    const total = acc;

    // The hot window's base slides across [0, shiftRange] as the phase advances.
    const shiftRange = Math.max(1, keyspace - hotSize);
    const trace = new Array(n);
    for (let i = 0; i < n; i++) {
        if ((prng() / 0x100000000) < hotFraction) {
            const phase = (i % period) / period;               // 0..1 within the current "day"
            const base = Math.floor(phase * shiftRange);        // the hour's hot-set base
            trace[i] = base + (prng() % hotSize);
        } else {
            const u = (prng() / 0x100000000) * total;           // a long-tail zipf draw
            let lo = 0, hi = keyspace - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (cum[mid] < u) lo = mid + 1; else hi = mid;
            }
            trace[i] = lo;
        }
    }
    return trace;
}

/* -------------------------------------------------------------------------- *
 * Trace loader. Pure string -> integer Array glue for a columnar/CSV integer-key
 * format, so a caller can replay their OWN captured trace via runBench({workloads}).
 * Takes a STRING, not a path: no node:fs, stays dependency-free. Fails closed on a
 * non-integer token (the alternative -- silently coercing NaN -- would corrupt the
 * hit ratio it feeds).
 * -------------------------------------------------------------------------- */

/**
 * Parse a columnar text blob into an integer-key Array.
 *
 * @param {string} text  the raw trace text (one record per line)
 * @param {{delimiter?:string|RegExp, column?:number, comment?:string, skipHeader?:boolean}} [opts]
 *   - delimiter : field separator; default splits on any run of whitespace
 *   - column    : 0-based field index to read as the key; default 0
 *   - comment   : a comment prefix; a whole-line or trailing occurrence is stripped
 *   - skipHeader: drop the first non-blank/non-comment data line (a header row)
 * @returns {Array<number>}  a verified-empty input (empty / whitespace-only / all
 *   comments) returns [] BY CONTRACT -- a legitimately empty trace, not an error.
 */
export function parseIntTrace(text, opts) {
    if (typeof text !== "string") {
        throw new RangeError("[lite-lru] parseIntTrace text must be a string, got " + (text === null ? "null" : typeof text));
    }
    const o = opts || {};
    const delimiter = o.delimiter;
    const column = o.column === undefined ? 0 : o.column;
    const comment = o.comment;
    const skipHeader = o.skipHeader === true;

    const out = [];
    const lines = text.split("\n");
    let seenData = false;
    for (let li = 0; li < lines.length; li++) {
        let line = lines[li];
        // Strip a trailing CR so CRLF files parse identically to LF.
        if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
        if (comment !== undefined && comment !== "") {
            const ci = line.indexOf(comment);
            if (ci === 0) continue;              // whole-line comment
            if (ci > 0) line = line.slice(0, ci); // trailing comment
        }
        if (line.trim() === "") continue;         // blank line
        if (skipHeader && !seenData) { seenData = true; continue; }
        seenData = true;
        const tokens = delimiter === undefined ? line.trim().split(/\s+/) : line.split(delimiter);
        const raw = tokens[column];
        if (raw === undefined) {
            throw new RangeError("[lite-lru] parseIntTrace: line " + (li + 1) + " has no column " + column);
        }
        const tok = raw.trim();
        if (!/^[+-]?\d+$/.test(tok)) {
            throw new RangeError("[lite-lru] parseIntTrace: non-integer token \"" + tok + "\" at line " + (li + 1) + " column " + column);
        }
        const v = Number(tok);
        if (!Number.isSafeInteger(v)) {
            throw new RangeError("[lite-lru] parseIntTrace: integer out of safe range \"" + tok + "\" at line " + (li + 1));
        }
        out.push(v);
    }
    return out;
}

/* -------------------------------------------------------------------------- *
 * Belady OPT -- the clairvoyant offline optimum (RESEARCH.md sec 2). Evicts the
 * resident whose NEXT use is farthest in the future (or never). A REFERENCE
 * ORACLE, never a production policy. Practical impl: reverse-scan next-use +
 * lazy-deletion max-heap with amortized rebuild, so it stays affordable on long
 * traces. Differential-tested against a brute-force O(N*C) OPT in the torture gate
 * (test/torture/t8-opt.mjs) -- every "% of optimal" figure depends on it being
 * exactly right.
 * -------------------------------------------------------------------------- */

/**
 * @param {Array<number>|Uint32Array} trace  the sequence of accessed keys
 * @param {number} capacity                  the cache size limit; a positive integer
 *                                            (0 / negative are documented degenerate fallbacks below)
 * @returns {{ hits:number, misses:number, hitRate:number }}
 */
export function beladyOpt(trace, capacity) {
    const n = trace.length;
    // Fail closed on an unverified capacity BEFORE the documented degenerate fallbacks:
    // a non-number / NaN, or a positive non-integer, is a caller bug -- never coerce it.
    if (typeof capacity !== "number" || Number.isNaN(capacity)) {
        throw new RangeError("[lite-lru] beladyOpt capacity must be a number, got " + String(capacity));
    }
    if (capacity > 0 && !Number.isInteger(capacity)) {
        throw new RangeError("[lite-lru] beladyOpt capacity must be an integer, got " + String(capacity));
    }
    if (n === 0) return {hits: 0, misses: 0, hitRate: 0};
    if (capacity <= 0) return {hits: 0, misses: n, hitRate: 0};

    // 1. Next-use precomputation (one reverse pass). nextUse[i] = the next index
    //    at which trace[i] recurs, or n ("never again").
    const nextUse = new Int32Array(n);
    const last = new Map();
    for (let i = n - 1; i >= 0; i--) {
        const key = trace[i];
        nextUse[i] = last.has(key) ? last.get(key) : n;
        last.set(key, i);
    }

    // 2. A lazy-deletion max-heap keyed by next-use. Bounded to ~4x capacity so a
    //    long trace does not accumulate stale entries without bound; on overflow
    //    it is rebuilt from the live resident set.
    const maxHeapCap = Math.max(capacity * 4, 1024);
    const heapKeys = new Array(maxHeapCap);
    const heapNextUse = new Int32Array(maxHeapCap);
    let heapSize = 0;
    let poppedKey = 0;
    let poppedNu = 0;

    function heapPush(key, nu) {
        let idx = heapSize++;
        while (idx > 0) {
            const parent = (idx - 1) >>> 1;
            const parentNu = heapNextUse[parent];
            if (parentNu >= nu) break;
            heapKeys[idx] = heapKeys[parent];
            heapNextUse[idx] = parentNu;
            idx = parent;
        }
        heapKeys[idx] = key;
        heapNextUse[idx] = nu;
    }

    function heapPop() {
        poppedKey = heapKeys[0];
        poppedNu = heapNextUse[0];
        const lastKey = heapKeys[--heapSize];
        const lastNu = heapNextUse[heapSize];
        if (heapSize > 0) {
            let idx = 0;
            for (; ;) {
                const left = (idx << 1) + 1;
                const right = left + 1;
                let largest = idx;
                let largestNu = lastNu;
                if (left < heapSize && heapNextUse[left] > largestNu) {
                    largest = left;
                    largestNu = heapNextUse[left];
                }
                if (right < heapSize && heapNextUse[right] > largestNu) {
                    largest = right;
                    largestNu = heapNextUse[right];
                }
                if (largest === idx) break;
                heapKeys[idx] = heapKeys[largest];
                heapNextUse[idx] = heapNextUse[largest];
                idx = largest;
            }
            heapKeys[idx] = lastKey;
            heapNextUse[idx] = lastNu;
        }
    }

    function rebuildHeap(resident) {
        heapSize = 0;
        for (const [k, nu] of resident.entries()) heapPush(k, nu);
    }

    // 3. Forward simulation. On a miss at capacity, evict the resident with the
    //    farthest next-use: pop the max, skipping stale heap entries (a key whose
    //    heap next-use no longer matches its current resident value).
    let hits = 0;
    let misses = 0;
    const resident = new Map();

    for (let i = 0; i < n; i++) {
        const key = trace[i];
        const nu = nextUse[i];
        if (resident.has(key)) {
            hits++;
            resident.set(key, nu);
            heapPush(key, nu);
        } else {
            misses++;
            if (resident.size === capacity) {
                while (heapSize > 0) {
                    heapPop();
                    if (resident.get(poppedKey) === poppedNu) {
                        resident.delete(poppedKey);
                        break;
                    }
                }
            }
            resident.set(key, nu);
            heapPush(key, nu);
        }
        if (heapSize >= maxHeapCap) rebuildHeap(resident);
    }

    return {hits, misses, hitRate: hits / n};
}

/* -------------------------------------------------------------------------- *
 * Per-member measurement. Two passes per member: one that counts hits, misses,
 * and hit-path metadata writes (via a counting Proxy over the link/visited
 * columns -- test instrumentation, off the timed path); one that times the plain
 * get/put loop for a machine-local ns/op.
 * -------------------------------------------------------------------------- */

/** Wrap a cache's hot-path metadata columns in a Proxy that tallies every numeric
 *  index store into `counter`. NOT zero-alloc (a Proxy traps) -- used only in the
 *  untimed ratio/writes pass, never in the timed loop. */
function instrument(cache, counter) {
    const wrap = (arr) => new Proxy(arr, {
        set(t, prop, value) {
            if (typeof prop === 'string' && prop !== 'length' && String(+prop) === prop) {
                counter.n++;
            }
            t[prop] = value;
            return true;
        },
    });
    cache._next = wrap(cache._next);
    cache._prev = wrap(cache._prev);
    if (cache._vis) cache._vis = wrap(cache._vis); // Sieve's visited column
    if (cache._handCold !== undefined) cache._st = wrap(cache._st); // ClockPro reference-bit column (a hit is 1 _st store)
    else if (cache._hT1 !== undefined) cache._st = wrap(cache._st); // Car reference-bit column (a hit is 1 _st store)
    else if (cache._sNext) { cache._sNext = wrap(cache._sNext); cache._sPrev = wrap(cache._sPrev); } // Lirs stack S
    if (cache._coldHead !== undefined) { cache._r0 = wrap(cache._r0); cache._r1 = wrap(cache._r1); } // LruK reference-time columns (a hit stamps 2)
    if (cache._qn !== undefined) { cache._rc = wrap(cache._rc); cache._exq = wrap(cache._exq); cache._qn = wrap(cache._qn); } // Mq metadata columns (a hit stamps 3 + relinks + ages)
    if (cache._fNext) { // Lfu key lists + bucket pool (a hit relinks across frequency buckets)
        cache._fNext = wrap(cache._fNext); cache._fPrev = wrap(cache._fPrev); cache._kB = wrap(cache._kB);
        cache._bFreq = wrap(cache._bFreq); cache._bNext = wrap(cache._bNext); cache._bPrev = wrap(cache._bPrev);
        cache._bHead = wrap(cache._bHead); cache._bTail = wrap(cache._bTail);
    }
}

/** Hit ratio + writes-per-hit for one member over one trace (untimed). A "hit" is
 *  a key already resident; a miss inserts it with put(key, key). writesPerHit is
 *  the average metadata stores a HIT incurs (LRU relinks; SIEVE sets one byte). */
function measureRatio(CacheClass, trace, capacity) {
    const cache = new CacheClass(capacity);
    const counter = {n: 0};
    instrument(cache, counter);
    let hits = 0, misses = 0, hitWrites = 0;
    for (let i = 0; i < trace.length; i++) {
        const k = trace[i];
        const before = counter.n;
        const v = cache.get(k);
        if (v !== undefined) {
            hits++;
            hitWrites += counter.n - before;
        } else {
            misses++;
            cache.put(k, k);
        }
    }
    const total = hits + misses;
    return {
        hits,
        misses,
        hitRatio: total ? hits / total : 0,
        writesPerHit: hits ? hitWrites / hits : 0,
    };
}

/** Machine-local ns/op for the plain get/put loop. One warmup pass + `repeats`
 *  timed passes (default 5) -> variance-aware. Returns { nsPerOp, nsPerOpMedian,
 *  nsPerOpP95, passes } where nsPerOp === nsPerOpMedian (the median, kept for
 *  back-compat) and nsPerOpP95 is the nearest-rank 95th percentile over the passes.
 *  Reporting median + p95 strengthens the "reproduce on your own hardware" caveat:
 *  a single timed pass is noisy; it deliberately does NOT collapse to one headline
 *  throughput number (the honesty rule forbids the single-big-number framing). */
function measureTiming(CacheClass, trace, capacity, repeats) {
    const passes = repeats === undefined ? 5 : repeats;
    // Fail closed on an unverified repeats knob: a non-positive / non-integer count
    // would leave median/p95 as NaN/undefined -- a caller bug, never coerced.
    if (typeof passes !== "number" || !Number.isInteger(passes) || passes < 1) {
        throw new RangeError("[lite-lru] measureTiming repeats must be a positive integer, got " + String(repeats));
    }
    // One warmup pass so JIT/inline-caches settle before the timed passes.
    const warm = new CacheClass(capacity);
    for (let i = 0; i < trace.length; i++) {
        const k = trace[i];
        if (warm.get(k) === undefined) warm.put(k, k);
    }
    const samples = new Float64Array(passes);
    for (let p = 0; p < passes; p++) {
        const cache = new CacheClass(capacity);
        const t0 = performance.now();
        for (let i = 0; i < trace.length; i++) {
            const k = trace[i];
            if (cache.get(k) === undefined) cache.put(k, k);
        }
        const t1 = performance.now();
        samples[p] = ((t1 - t0) * 1e6) / trace.length; // ns per op
    }
    const sorted = Array.prototype.slice.call(samples).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = (sorted.length & 1) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const rank = Math.ceil(0.95 * sorted.length); // nearest-rank p95 (1-based)
    const p95 = sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
    return {nsPerOp: median, nsPerOpMedian: median, nsPerOpP95: p95, passes};
}

/** Machine-local ns/op for a cache built by a FACTORY (so the keyed-index backing --
 *  default Map / keys:'int' / keys:'dense' -- can be varied for the same LRU policy). */
function measureTimingFactory(factory, trace, capacity) {
    const warm = factory(capacity);
    for (let i = 0; i < trace.length; i++) { const k = trace[i]; if (warm.get(k) === undefined) warm.put(k, k); }
    const cache = factory(capacity);
    const t0 = performance.now();
    for (let i = 0; i < trace.length; i++) { const k = trace[i]; if (cache.get(k) === undefined) cache.put(k, k); }
    const t1 = performance.now();
    return ((t1 - t0) * 1e6) / trace.length; // ns per op
}

/**
 * The KEYED-INDEX BACKING comparison (decisions/0011 + 0029): the SAME LiteLru recency
 * policy over its three index backings on an integer, dense-domain workload --
 *   - default Map: arbitrary keys, honestly AMORTIZED (internal resize can allocate)
 *   - keys:'int' : open-addressed typed-array index, STRICT zero-alloc (large/sparse)
 *   - keys:'dense': direct-mapped generation-stamped index, STRICT zero-alloc, O(maxKey)
 *     space, hot body a single array read (no hash, no probe) -- DirectLru's engine.
 * Hit ratio + eviction order are IDENTICAL across all three (same policy); only ns/op and
 * the space/allocation posture differ. RETURNS structured rows; does NOT print.
 */
export function backingCompare(opts) {
    const o = opts || {};
    const capacity = o.capacity === undefined ? 256 : o.capacity;
    const length = o.length === undefined ? 200000 : o.length;
    const seed = o.seed === undefined ? 0x9e3779b9 : (o.seed >>> 0) || 1;
    const maxKey = capacity * 16 - 1; // dense domain covers the zipf keyspace exactly
    const trace = zipfTrace({length, keyspace: maxKey + 1, exponent: 1.0, seed: seed ^ 0x33});
    const backings = [
        {name: 'Map (default)', factory: (cap) => new LiteLru(cap)},
        {name: "keys:'int'", factory: (cap) => new LiteLru(cap, {keys: 'int'})},
        {name: "keys:'dense'", factory: (cap) => new LiteLru(cap, {keys: 'dense', maxKey})},
    ];
    const ratio = measureRatio(LiteLru, trace, capacity); // shared: identical across backings
    const rows = [];
    for (let i = 0; i < backings.length; i++) {
        const b = backings[i];
        rows.push({
            backing: b.name,
            nsPerOp: measureTimingFactory(b.factory, trace, capacity),
            hitRatio: ratio.hitRatio,
        });
    }
    return {version: VERSION, node: process.version, arch: process.arch, capacity, ops: length, maxKey, rows};
}

const MEMBERS = [
    {name: 'LiteLru', ctor: LiteLru},
    {name: 'Sieve', ctor: Sieve},
    {name: 'S3Fifo', ctor: S3Fifo},
    {name: 'WTinyLfu', ctor: WTinyLfu},
    {name: 'Slru', ctor: Slru},
    {name: 'TwoQ', ctor: TwoQ},
    {name: 'Arc', ctor: Arc},
    {name: 'Lirs', ctor: Lirs},
    {name: 'Lfu', ctor: Lfu},
    {name: 'ClockPro', ctor: ClockPro},
    {name: 'LruK', ctor: LruK},
    {name: 'Mq', ctor: Mq},
    {name: 'Car', ctor: Car},
];

/* -------------------------------------------------------------------------- *
 * runBench -- the importable entry. Returns a structured result; does NOT print.
 * -------------------------------------------------------------------------- */

/**
 * The opt-in zipf alpha sweep (web-cache literature's skew axis): shows how each
 * policy's edge over LRU moves as popularity skew changes. NOT the default (the
 * default set stays exactly zipf/loop/scan); pass runBench({ alphas: ZIPF_ALPHAS }).
 */
export const ZIPF_ALPHAS = [0.7, 0.9, 1.0, 1.2];

/** Canonical decimal label for an alpha, ASCII, at least one decimal place:
 *  0.7 -> "0.7", 1.0 -> "1.0", 1.2 -> "1.2", 1.25 -> "1.25". */
function alphaLabel(a) {
    let s = a.toFixed(3).replace(/0+$/, "");
    if (s.charCodeAt(s.length - 1) === 46) s += "0"; // trailing '.' -> add a '0'
    return s;
}

/** Default workload set. Each trace is seeded -> reproducible. `alphas` (default
 *  [1.0]) and `keyspaceRatio` (default 16) are knobs; with the defaults this emits
 *  exactly ['zipf','loop','scan'] with byte-identical traces to prior releases. */
function defaultWorkloads(opts) {
    const capacity = opts.capacity;
    const length = opts.length;
    const seed = opts.seed;
    const keyspaceRatio = opts.keyspaceRatio === undefined ? 16 : opts.keyspaceRatio;
    const alphas = opts.alphas === undefined ? [1.0] : opts.alphas;
    // Fail closed on an unverified alphas knob: a non-array, an empty sweep, or any
    // non-positive / non-finite element would silently drop the zipf workload(s) --
    // a caller bug, never a silent collapse to [loop, scan].
    if (!Array.isArray(alphas) || alphas.length === 0) {
        throw new RangeError("[lite-lru] alphas must be a non-empty array of positive numbers, got " + (Array.isArray(alphas) ? "[]" : String(alphas)));
    }
    for (let i = 0; i < alphas.length; i++) {
        const a = alphas[i];
        if (typeof a !== "number" || !Number.isFinite(a) || a <= 0) {
            throw new RangeError("[lite-lru] alphas must be a non-empty array of positive numbers, got " + String(a) + " at index " + i);
        }
    }
    const keyspace = capacity * keyspaceRatio;
    // If the sweep is exactly [1.0], the single zipf workload keeps the name 'zipf'
    // (and, since (a*1000-1000)>>>0 === 0 for a=1.0, the seed seed^0x11) so the
    // default output is byte-identical. Any other sweep names each 'zipf-a<A>'.
    const single = alphas.length === 1 && alphas[0] === 1.0;
    const workloads = [];
    for (let i = 0; i < alphas.length; i++) {
        const a = alphas[i];
        const aSeed = (seed ^ 0x11) ^ ((Math.round(a * 1000) - 1000) >>> 0);
        workloads.push({
            name: single ? 'zipf' : 'zipf-a' + alphaLabel(a),
            capacity,
            trace: zipfTrace({length, keyspace, exponent: a, seed: aSeed}),
        });
    }
    workloads.push({
        name: 'loop',
        capacity,
        trace: loopTrace({length, span: capacity * 4}),
    });
    workloads.push({
        name: 'scan',
        capacity,
        trace: scanTrace({length, hotSize: (capacity >> 1) || 1, hotFraction: 0.5, seed: seed ^ 0x22}),
    });
    return workloads;
}

/**
 * Run the bench and RETURN structured results (no printing). Deterministic for a
 * given `opts`. Callers can pass their own `workloads: [{ name, capacity, trace }]`
 * to replay their OWN trace.
 *
 * @param {{capacity?:number, length?:number, seed?:number,
 *          alphas?:Array<number>, keyspaceRatio?:number, repeats?:number,
 *          workloads?:Array<{name:string, capacity:number, trace:Array<number>}>}} [opts]
 */
export function runBench(opts) {
    const o = opts || {};
    const capacity = o.capacity === undefined ? 256 : o.capacity;
    const length = o.length === undefined ? 200000 : o.length;
    const seed = o.seed === undefined ? 0x9e3779b9 : (o.seed >>> 0) || 1;
    const alphas = o.alphas === undefined ? [1.0] : o.alphas;
    const keyspaceRatio = o.keyspaceRatio === undefined ? 16 : o.keyspaceRatio;
    const repeats = o.repeats === undefined ? 5 : o.repeats;
    const workloads = o.workloads || defaultWorkloads({capacity, length, seed, alphas, keyspaceRatio});

    const results = [];
    for (let w = 0; w < workloads.length; w++) {
        const wl = workloads[w];
        const cap = wl.capacity;
        const opt = beladyOpt(wl.trace, cap);
        const members = [];
        for (let m = 0; m < MEMBERS.length; m++) {
            const M = MEMBERS[m];
            const r = measureRatio(M.ctor, wl.trace, cap);
            const t = measureTiming(M.ctor, wl.trace, cap, repeats);
            members.push({
                name: M.name,
                hits: r.hits,
                misses: r.misses,
                hitRatio: r.hitRatio,
                writesPerHit: r.writesPerHit,
                nsPerOp: t.nsPerOp,
                nsPerOpMedian: t.nsPerOpMedian,
                nsPerOpP95: t.nsPerOpP95,
                pctOptimal: opt.hits ? (r.hits / opt.hits) * 100 : 100,
            });
        }
        results.push({
            name: wl.name,
            capacity: cap,
            ops: wl.trace.length,
            opt: {hits: opt.hits, hitRatio: opt.hitRate},
            members,
        });
    }

    return {
        version: VERSION,
        node: process.version,
        arch: process.arch,
        // config stays exactly {capacity, length, seed}; the new tuning knobs are
        // echoed in a SEPARATE top-level object so callers can round-trip them.
        config: {capacity, length, seed},
        tuning: {alphas, keyspaceRatio, repeats},
        workloads: results,
    };
}

/* -------------------------------------------------------------------------- *
 * Direct-run printer. Only executes when this file is the process entry point.
 * -------------------------------------------------------------------------- */

function pad(s, width) {
    s = String(s);
    return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(s, width) {
    s = String(s);
    return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function printBench(out) {
    const lines = [];
    lines.push('@zakkster/lite-lru bench  v' + out.version +
        '  (node ' + out.node + ', ' + out.arch + ')');
    lines.push('capacity=' + out.config.capacity + '  ops=' + out.config.length +
        '  seed=0x' + (out.config.seed >>> 0).toString(16));
    lines.push('ns/op is wall-clock and MACHINE-LOCAL -- reproduce on your own hardware.');
    lines.push('');
    const header = pad('workload', 10) + pad('policy', 10) + padLeft('hit%', 8) +
        padLeft('%OPT', 8) + padLeft('wr/hit', 9) + padLeft('ns/op', 10) + padLeft('p95', 10);
    lines.push(header);
    lines.push('-'.repeat(header.length));
    for (const wl of out.workloads) {
        lines.push(pad(wl.name, 10) + pad('OPT', 10) +
            padLeft((wl.opt.hitRatio * 100).toFixed(1), 8) +
            padLeft('100.0', 8) + padLeft('-', 9) + padLeft('-', 10) + padLeft('-', 10));
        for (const m of wl.members) {
            lines.push(pad('', 10) + pad(m.name, 10) +
                padLeft((m.hitRatio * 100).toFixed(1), 8) +
                padLeft(m.pctOptimal.toFixed(1), 8) +
                padLeft(m.writesPerHit.toFixed(3), 9) +
                padLeft(m.nsPerOp.toFixed(1), 10) +
                padLeft(m.nsPerOpP95.toFixed(1), 10));
        }
        lines.push('');
    }
    process.stdout.write(lines.join('\n') + '\n');
}

function printBackingCompare(out) {
    const lines = [];
    lines.push('');
    lines.push('keyed-index backing comparison  (same LRU policy, integer dense-domain zipf)');
    lines.push('capacity=' + out.capacity + '  ops=' + out.ops + '  maxKey=' + out.maxKey +
        '  hit%=' + (out.rows[0].hitRatio * 100).toFixed(1) + ' (identical across backings)');
    const header = pad('backing', 16) + padLeft('ns/op', 10);
    lines.push(header);
    lines.push('-'.repeat(header.length));
    for (const r of out.rows) {
        lines.push(pad(r.backing, 16) + padLeft(r.nsPerOp.toFixed(1), 10));
    }
    process.stdout.write(lines.join('\n') + '\n');
}

// Run the printer only when invoked directly (node benchmark/Bench.mjs / npm run bench),
// not when imported. Kept dependency-free: node:url is a builtin.
import {pathToFileURL} from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    printBench(runBench());
    printBackingCompare(backingCompare());
}
