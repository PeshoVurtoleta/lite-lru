/**
 * @zakkster/lite-lru -- torture harness (the shared spine).
 *
 * Modeled on ../LiteBinaryReader/test/torture/harness.mjs -- same four disciplines,
 * restructured to LiteLru's spec (ROADMAP section 4). Machinery adapted, domain
 * swapped: a mutable LRU cache instead of an immutable binary reader.
 *
 *   1. SCRATCH ONCE. Every measured hot loop is driven by a pre-built cache and a
 *      pre-bound closure; the harness never allocates on a measured path.
 *   2. FAILURE-ONLY MESSAGES. check(cond, msgThunk) builds its string ONLY on
 *      failure -- a template literal per iteration is an allocation that would fail
 *      the T6 gate. Pass a thunk, never a pre-built string.
 *   3. SEEDED REPLAY. The PRNG is a seeded xorshift32 (TORTURE_SEED env, 0-guarded
 *      to 1). Every failing message can carry the seed for one-env-var replay.
 *   4. ONE MEASUREMENT WINDOW AT A TIME. lite-gc-profiler shares one heap across
 *      lanes; runOpsGate opens and closes a single window per call and tiers run
 *      strictly sequentially -- never nested, never concurrent.
 *
 * THE SEAM (DEBATE item 1 = B): runDifferential is parameterized by a POLICY (a
 * real-cache factory + an oracle factory sharing one uniform driver surface). One
 * runner checks classic LRU today and every future family member unchanged -- and
 * a second stub policy (FIFO) proves the parameterization now.
 *
 * @license MIT
 */

import { measureOps, checkNoGc, measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';
import { LiteLru, Sieve, S3Fifo, WTinyLfu } from '../../Lru.js';
import { makeLruOracle, svz } from './oracles/lru.mjs';
import { makeFifoOracle, makeFifoReal } from './oracles/fifo.mjs';
import { makeSieveOracle } from './oracles/sieve.mjs';
import { makeS3FifoOracle } from './oracles/s3fifo.mjs';
import { makeWTinyLfuOracle } from './oracles/wtinylfu.mjs';

export { validate } from '../validate.mjs';

const NIL = -1;

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Deliberately-broken control mode: injects a retained allocation into the T6 hot loop. */
export const BREAK = process.env.LLRU_TORTURE_BREAK === '1';

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps stabilize:'deep'. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/** Smallest heap object V8 can place: the floor of any real retention regression. */
export const MIN_HEAP_OBJECT_BYTES = 16;

/** The zero-RETENTION rule (1 B/call: below one heap object, above measurement noise). */
export const ALLOC_RULES = { maxBytesPerCall: 1 };

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg + '\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/** Re-export SameValueZero so tiers share one equality with the oracle. */
export { svz };

/**
 * Run fn(i) under a single measured window and gate it against RULES. Uses
 * measureOps stabilize:'deep' so maxArrayBuffersGrowth is resolvable (typed-array
 * backing stores live outside the V8 heap). A budget that moves is not a gate.
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return { report: checkNoGc(res.summary, RULES), summary: res.summary };
}

/**
 * Measure per-call RETAINED allocation (bytes surviving a forced collection,
 * min-over-batches) and gate it against ALLOC_RULES. Requires --expose-gc. This is
 * the async-gc channel runOpsGate cannot see. An inconclusive/unsettled verdict is
 * a FAIL here, never a skip.
 */
export function runAllocsGate(fn, opts) {
    const iterations = opts.iterations;
    const result = measureAllocs(fn, {
        iterations,
        batches: opts.batches === undefined ? 8 : opts.batches,
        warmup: opts.warmup === undefined ? iterations : opts.warmup,
    });
    const report = checkAllocs(result, ALLOC_RULES);
    const ok = report.verdict === 'pass' && result.settled === true;
    return { report, result, bytesPerCall: result.bytesPerCall, ok };
}

/** One-sided reachability census: false only when EVERY sampled ref is still live. */
export function censusOk(refs) {
    if (refs.length === 0) return true;
    let live = 0;
    for (let i = 0; i < refs.length; i++) if (refs[i].deref() !== undefined) live++;
    return live !== refs.length;
}

/** Force several GC settle cycles so transient refs clear before a census read. */
export async function settleGc(cycles) {
    const n = cycles === undefined ? 4 : cycles;
    for (let i = 0; i < n; i++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 20));
    }
}

/* -------------------------------------------------------------------------- *
 * Driver wrappers -- the uniform surface the differential runner drives.
 *
 * A "driver" exposes get/put/delete/has/peek/size + victim(): the key that would
 * be evicted on the NEXT over-capacity insert. The oracle drivers already have it;
 * wrapLru adds it to a real LiteLru by reading the tail slot (test-only
 * introspection, never a hot path). The seam is: policy = {real, oracle}.
 * -------------------------------------------------------------------------- */

/** Wrap a real LiteLru as a uniform driver (victim = the current LRU tail key). */
export function wrapLru(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v) => cache.put(k, v),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => (cache._tail === NIL ? undefined : cache._keys[cache._tail]),
        raw: cache,
    };
}

/** The classic-LRU policy: the reference member + differential oracle + floor.
 *  Default backing (Map): arbitrary keys, honestly amortized (decisions/0011). */
export const lruPolicy = {
    name: 'lru',
    real: (cap) => wrapLru(new LiteLru(cap)),
    oracle: (cap) => makeLruOracle(cap),
};

/** The classic-LRU policy on the INTEGER substrate backing (`keys: 'int'`). Driven
 *  against the SAME lru oracle as the default backing: the open-addressed
 *  typed-array index must return byte-identical values + victims (decisions/0011). */
export const lruIntPolicy = {
    name: 'lru-int',
    real: (cap) => wrapLru(new LiteLru(cap, { keys: 'int' })),
    oracle: (cap) => makeLruOracle(cap),
};

/** The FIFO seam policy: real Map+queue vs brute array oracle. Proves the runner
 *  is policy-parameterized (not that FIFO ships). */
export const fifoPolicy = {
    name: 'fifo',
    real: (cap) => makeFifoReal(cap),
    oracle: (cap) => makeFifoOracle(cap),
};

/** Wrap a real Sieve as a uniform driver. victim = the key the next over-capacity
 *  insert would evict, read via the non-mutating `_peekVictim` (test-only, never a
 *  hot path) -- the same value `_sweepVictim` would pick. */
export function wrapSieve(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v) => cache.put(k, v),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => cache._peekVictim(),
        raw: cache,
    };
}

/** The SIEVE policy: the first modern family member + its independent oracle
 *  (decisions/0012). Default backing (Map): arbitrary keys. */
export const sievePolicy = {
    name: 'sieve',
    real: (cap) => wrapSieve(new Sieve(cap)),
    oracle: (cap) => makeSieveOracle(cap),
};

/** The SIEVE policy on the INTEGER substrate backing (`keys: 'int'`), driven
 *  against the SAME sieve oracle: the strict-zero backing must return byte-
 *  identical values + victims (decisions/0011 + 0012). */
export const sieveIntPolicy = {
    name: 'sieve-int',
    real: (cap) => wrapSieve(new Sieve(cap, { keys: 'int' })),
    oracle: (cap) => makeSieveOracle(cap),
};

/** Wrap a real S3Fifo as a uniform driver. victim = the key the next over-capacity
 *  insert would evict, read via the non-mutating `_peekVictim` (test-only, never a
 *  hot path) -- the same value `_evict` would pick. */
export function wrapS3Fifo(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v) => cache.put(k, v),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => cache._peekVictim(),
        raw: cache,
    };
}

/** The S3-FIFO policy (decisions/0013): the admission-controlled member + its own
 *  independent three-structure oracle. Default backing (Map): arbitrary keys. */
export const s3fifoPolicy = {
    name: 's3fifo',
    real: (cap) => wrapS3Fifo(new S3Fifo(cap)),
    oracle: (cap) => makeS3FifoOracle(cap),
};

/** The S3-FIFO policy on the INTEGER substrate backing (`keys: 'int'`), driven
 *  against the SAME s3fifo oracle: the strict-zero backing (including the int ghost
 *  ring + membership table) must return byte-identical values + victims. */
export const s3fifoIntPolicy = {
    name: 's3fifo-int',
    real: (cap) => wrapS3Fifo(new S3Fifo(cap, { keys: 'int' })),
    oracle: (cap) => makeS3FifoOracle(cap),
};

/** Wrap a real WTinyLfu as a uniform driver. victim = the key the next over-capacity
 *  insert would evict, read via the non-mutating `_peekVictim` (test-only, never a
 *  hot path) -- the same value `put` would pick. */
export function wrapWTinyLfu(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v) => cache.put(k, v),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => cache._peekVictim(),
        raw: cache,
    };
}

/** The W-TinyLFU policy (decisions/0014): the frequency-admission member + its own
 *  independent window+SLRU+sketch oracle. Default backing (Map): arbitrary keys. */
export const wtinylfuPolicy = {
    name: 'wtinylfu',
    real: (cap) => wrapWTinyLfu(new WTinyLfu(cap)),
    oracle: (cap) => makeWTinyLfuOracle(cap),
};

/** The W-TinyLFU policy on the INTEGER substrate backing (`keys: 'int'`), driven
 *  against the SAME wtinylfu oracle: the strict-zero backing must return byte-
 *  identical values + victims (decisions/0011 + 0014). */
export const wtinylfuIntPolicy = {
    name: 'wtinylfu-int',
    real: (cap) => wrapWTinyLfu(new WTinyLfu(cap, { keys: 'int' })),
    oracle: (cap) => makeWTinyLfuOracle(cap),
};

/* -------------------------------------------------------------------------- *
 * The PARAMETERIZED differential runner (the whole point of S1).
 *
 * Drives a seeded mixed op stream against BOTH the real cache and the brute
 * oracle, comparing the returned value AND the next over-capacity eviction victim
 * AND the live size after every op. Divergence returns a record carrying the seed
 * and op index for one-env-var replay -- it never throws (the caller reports).
 * -------------------------------------------------------------------------- */

const OP_GET = 0, OP_PUT = 1, OP_DELETE = 2, OP_HAS = 3, OP_PEEK = 4;

/** Apply one op to a uniform driver, returning the observable value. */
function applyOp(d, kind, key, val) {
    switch (kind) {
        case OP_GET: return d.get(key);
        case OP_PUT: d.put(key, val); return undefined;
        case OP_DELETE: return d.delete(key);
        case OP_HAS: return d.has(key);
        default: return d.peek(key); // OP_PEEK
    }
}

/**
 * @param {{name,real,oracle}} policy
 * @param {{cap:number, ops:number, seed:number, keyspace:number}} opts
 * @returns {{ok:true} | {ok:false, i, kind, key, why, real, oracle}}
 */
export function runDifferential(policy, opts) {
    const prng = makePrng(opts.seed);
    const real = policy.real(opts.cap);
    const oracle = policy.oracle(opts.cap);
    const ks = opts.keyspace;

    for (let i = 0; i < opts.ops; i++) {
        const kind = prng() % 5;
        const key = prng() % ks;
        const val = prng() >>> 0;

        const rv = applyOp(real, kind, key, val);
        const ov = applyOp(oracle, kind, key, val);
        if (!Object.is(rv, ov)) {
            return { ok: false, i, kind, key, why: 'value', real: rv, oracle: ov };
        }
        if (real.size() !== oracle.size()) {
            return { ok: false, i, kind, key, why: 'size', real: real.size(), oracle: oracle.size() };
        }
        const rvic = real.victim();
        const ovic = oracle.victim();
        if (!Object.is(rvic, ovic)) {
            return { ok: false, i, kind, key, why: 'victim', real: rvic, oracle: ovic };
        }
    }
    return { ok: true };
}

/* -------------------------------------------------------------------------- *
 * Writes-per-hit counter (DEBATE item 2: the HONEST pitch is "fewer writes per
 * hit," never "lock-free").
 *
 * A LiteLru subclass whose _next/_prev columns are wrapped in a counting Proxy
 * that tallies every INDEX STORE. Used ONLY in the T6 counter sub-tier -- NEVER on
 * a measured zero-alloc path (a Proxy allocates and traps, which would poison the
 * gate). It pins classic LRU's baseline: a head re-hit early-returns (0 writes); a
 * non-head re-hit relinks a small constant.
 * -------------------------------------------------------------------------- */

export class CountedLru extends LiteLru {
    constructor(capacity, options) {
        super(capacity, options);
        this._writes = 0;
        const self = this;
        const countStores = (arr) => new Proxy(arr, {
            set(t, prop, value) {
                // Count only numeric-index stores (the link relinks), not .length etc.
                if (typeof prop === 'string' && prop !== 'length' && String(+prop) === prop) {
                    self._writes++;
                }
                t[prop] = value;
                return true;
            },
        });
        this._next = countStores(this._next);
        this._prev = countStores(this._prev);
    }
    resetWrites() { this._writes = 0; }
    writes() { return this._writes; }
}

/** Baselines pinned from Lru.js's structure (measured; regression tripwire). */
export const LRU_WRITES_HEAD_REHIT = 0;     // _moveToFront early-returns on head
export const LRU_WRITES_INTERIOR_REHIT = 5; // _detach(2) + _pushFront(3) for a mid slot
export const LRU_WRITES_TAIL_REHIT = 4;     // _detach(1) + _pushFront(3) for the tail

/**
 * A Sieve subclass whose _next/_prev AND _vis columns are wrapped in counting
 * Proxies -- used ONLY in the T6 SIEVE counter sub-tier, NEVER on a measured
 * zero-alloc path (a Proxy allocates + traps and would poison the gate). It pins
 * SIEVE's headline: a HIT relinks NOTHING (0 _next/_prev stores at head, interior
 * AND tail) and sets exactly ONE visited byte.
 */
export class CountedSieve extends Sieve {
    constructor(capacity, options) {
        super(capacity, options);
        this._writes = 0;    // _next / _prev link stores
        this._visWrites = 0; // _vis stores
        const self = this;
        const countStores = (arr, isVis) => new Proxy(arr, {
            set(t, prop, value) {
                if (typeof prop === 'string' && prop !== 'length' && String(+prop) === prop) {
                    if (isVis) self._visWrites++; else self._writes++;
                }
                t[prop] = value;
                return true;
            },
        });
        this._next = countStores(this._next, false);
        this._prev = countStores(this._prev, false);
        this._vis = countStores(this._vis, true);
    }
    resetWrites() { this._writes = 0; this._visWrites = 0; }
    writes() { return this._writes; }
    visWrites() { return this._visWrites; }
}

/** SIEVE hit baselines (measured; regression tripwire). The headline. */
export const SIEVE_WRITES_HIT_LINKS = 0; // a hit relinks nothing
export const SIEVE_WRITES_HIT_VIS = 1;   // ... it sets exactly one visited byte

/**
 * An S3Fifo subclass whose _next/_prev AND _vis columns are wrapped in counting
 * Proxies -- used ONLY in the T6 S3-FIFO counter sub-tier, NEVER on a measured
 * zero-alloc path (a Proxy allocates + traps and would poison the gate). S3-FIFO
 * shares SIEVE's 1-bit hit: a HIT relinks NOTHING (0 _next/_prev stores in EITHER
 * ring) and sets exactly ONE visited byte. The Proxy writes through to the same
 * underlying buffer the store reads, so alloc/free stay consistent (as in CountedLru).
 */
export class CountedS3Fifo extends S3Fifo {
    constructor(capacity, options) {
        super(capacity, options);
        this._writes = 0;    // _next / _prev link stores
        this._visWrites = 0; // _vis stores
        const self = this;
        const countStores = (arr, isVis) => new Proxy(arr, {
            set(t, prop, value) {
                if (typeof prop === 'string' && prop !== 'length' && String(+prop) === prop) {
                    if (isVis) self._visWrites++; else self._writes++;
                }
                t[prop] = value;
                return true;
            },
        });
        this._next = countStores(this._next, false);
        this._prev = countStores(this._prev, false);
        this._vis = countStores(this._vis, true);
    }
    resetWrites() { this._writes = 0; this._visWrites = 0; }
    writes() { return this._writes; }
    visWrites() { return this._visWrites; }
}

/** S3-FIFO hit baselines (measured; regression tripwire). Same headline as SIEVE. */
export const S3FIFO_WRITES_HIT_LINKS = 0; // a hit relinks nothing
export const S3FIFO_WRITES_HIT_VIS = 1;   // ... it sets exactly one visited byte

/**
 * A WTinyLfu subclass whose _next/_prev columns are wrapped in counting Proxies --
 * used ONLY in the T6 W-TinyLFU counter sub-tier, NEVER on a measured zero-alloc path
 * (a Proxy allocates + traps and would poison the gate). Unlike SIEVE/S3-FIFO, a
 * W-TinyLFU hit legitimately relinks (recency/promotion) AND bumps the sketch -- the
 * gate asserts zero-ALLOCATION, not minimal writes. This counter pins the ONE genuine
 * fast path: a re-hit of the window MRU relinks NOTHING (early return in `_onHit`).
 */
export class CountedWTinyLfu extends WTinyLfu {
    constructor(capacity, options) {
        super(capacity, options);
        this._writes = 0; // _next / _prev link stores
        const self = this;
        const countStores = (arr) => new Proxy(arr, {
            set(t, prop, value) {
                if (typeof prop === 'string' && prop !== 'length' && String(+prop) === prop) {
                    self._writes++;
                }
                t[prop] = value;
                return true;
            },
        });
        this._next = countStores(this._next);
        this._prev = countStores(this._prev);
    }
    resetWrites() { this._writes = 0; }
    writes() { return this._writes; }
}

/** W-TinyLFU window-MRU re-hit baseline (measured): the one 0-relink fast path. */
export const WTINYLFU_WRITES_WINDOW_MRU_REHIT = 0;
