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
 * reproduce it on your own hardware; the numbers move with the runtime. The FIXED
 * structural facts (writes-per-hit, zero-GC budgets) are gated in the torture suite,
 * not measured here.
 *
 * @license MIT
 */

import {LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, VERSION} from '../Lru.js';

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
        x ^= x >> 17;
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
 * @param {number} capacity                  the cache size limit (>= 1)
 * @returns {{ hits:number, misses:number, hitRate:number }}
 */
export function beladyOpt(trace, capacity) {
    const n = trace.length;
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

/** Machine-local ns/op for the plain get/put loop (one warmup pass, one timed). */
function measureTiming(CacheClass, trace, capacity) {
    const warm = new CacheClass(capacity);
    for (let i = 0; i < trace.length; i++) {
        const k = trace[i];
        if (warm.get(k) === undefined) warm.put(k, k);
    }
    const cache = new CacheClass(capacity);
    const t0 = performance.now();
    for (let i = 0; i < trace.length; i++) {
        const k = trace[i];
        if (cache.get(k) === undefined) cache.put(k, k);
    }
    const t1 = performance.now();
    return ((t1 - t0) * 1e6) / trace.length; // ns per op
}

const MEMBERS = [
    {name: 'LiteLru', ctor: LiteLru},
    {name: 'Sieve', ctor: Sieve},
    {name: 'S3Fifo', ctor: S3Fifo},
    {name: 'WTinyLfu', ctor: WTinyLfu},
    {name: 'Slru', ctor: Slru},
    {name: 'TwoQ', ctor: TwoQ},
];

/* -------------------------------------------------------------------------- *
 * runBench -- the importable entry. Returns a structured result; does NOT print.
 * -------------------------------------------------------------------------- */

/** Default workload set. Each trace is seeded -> reproducible. */
function defaultWorkloads(opts) {
    const capacity = opts.capacity;
    const length = opts.length;
    const seed = opts.seed;
    return [
        {
            name: 'zipf',
            capacity,
            trace: zipfTrace({length, keyspace: capacity * 16, exponent: 1.0, seed: seed ^ 0x11}),
        },
        {
            name: 'loop',
            capacity,
            trace: loopTrace({length, span: capacity * 4}),
        },
        {
            name: 'scan',
            capacity,
            trace: scanTrace({length, hotSize: (capacity >> 1) || 1, hotFraction: 0.5, seed: seed ^ 0x22}),
        },
    ];
}

/**
 * Run the bench and RETURN structured results (no printing). Deterministic for a
 * given `opts`. Callers can pass their own `workloads: [{ name, capacity, trace }]`
 * to replay their OWN trace.
 *
 * @param {{capacity?:number, length?:number, seed?:number,
 *          workloads?:Array<{name:string, capacity:number, trace:Array<number>}>}} [opts]
 */
export function runBench(opts) {
    const o = opts || {};
    const capacity = o.capacity === undefined ? 256 : o.capacity;
    const length = o.length === undefined ? 200000 : o.length;
    const seed = o.seed === undefined ? 0x9e3779b9 : (o.seed >>> 0) || 1;
    const workloads = o.workloads || defaultWorkloads({capacity, length, seed});

    const results = [];
    for (let w = 0; w < workloads.length; w++) {
        const wl = workloads[w];
        const cap = wl.capacity;
        const opt = beladyOpt(wl.trace, cap);
        const members = [];
        for (let m = 0; m < MEMBERS.length; m++) {
            const M = MEMBERS[m];
            const r = measureRatio(M.ctor, wl.trace, cap);
            const nsPerOp = measureTiming(M.ctor, wl.trace, cap);
            members.push({
                name: M.name,
                hits: r.hits,
                misses: r.misses,
                hitRatio: r.hitRatio,
                writesPerHit: r.writesPerHit,
                nsPerOp,
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
        config: {capacity, length, seed},
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
        padLeft('%OPT', 8) + padLeft('wr/hit', 9) + padLeft('ns/op', 10);
    lines.push(header);
    lines.push('-'.repeat(header.length));
    for (const wl of out.workloads) {
        lines.push(pad(wl.name, 10) + pad('OPT', 10) +
            padLeft((wl.opt.hitRatio * 100).toFixed(1), 8) +
            padLeft('100.0', 8) + padLeft('-', 9) + padLeft('-', 10));
        for (const m of wl.members) {
            lines.push(pad('', 10) + pad(m.name, 10) +
                padLeft((m.hitRatio * 100).toFixed(1), 8) +
                padLeft(m.pctOptimal.toFixed(1), 8) +
                padLeft(m.writesPerHit.toFixed(3), 9) +
                padLeft(m.nsPerOp.toFixed(1), 10));
        }
        lines.push('');
    }
    process.stdout.write(lines.join('\n') + '\n');
}

// Run the printer only when invoked directly (node benchmark/Bench.mjs / npm run bench),
// not when imported. Kept dependency-free: node:url is a builtin.
import {pathToFileURL} from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    printBench(runBench());
}
