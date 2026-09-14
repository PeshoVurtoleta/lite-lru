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
import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro, LruK, Mq } from '../../Lru.js';
import { makeLruOracle, svz } from './oracles/lru.mjs';
import { makeLirsOracle } from './oracles/lirs.mjs';
import { makeLfuOracle } from './oracles/lfu.mjs';
import { makeClockProOracle } from './oracles/clockpro.mjs';
import { makeLruKOracle } from './oracles/lruk.mjs';
import { makeMqOracle } from './oracles/mq.mjs';
import { makeFifoOracle, makeFifoReal } from './oracles/fifo.mjs';
import { makeSieveOracle } from './oracles/sieve.mjs';
import { makeS3FifoOracle } from './oracles/s3fifo.mjs';
import { makeWTinyLfuOracle } from './oracles/wtinylfu.mjs';
import { makeSlruOracle } from './oracles/slru.mjs';
import { makeTwoQOracle } from './oracles/twoq.mjs';
import { makeArcOracle } from './oracles/arc.mjs';

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
        put: (k, v, t) => cache.put(k, v, t),
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
        put: (k, v, t) => cache.put(k, v, t),
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
        put: (k, v, t) => cache.put(k, v, t),
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
        put: (k, v, t) => cache.put(k, v, t),
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

/** Wrap a real Slru as a uniform driver. victim = the key the next over-capacity
 *  insert would evict, read via the non-mutating `_peekVictim` (test-only). */
export function wrapSlru(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v, t) => cache.put(k, v, t),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => cache._peekVictim(),
        raw: cache,
    };
}

/** The Slru policy (decisions/0015): the Segmented-LRU member + its own independent
 *  probation/protected oracle. Default backing (Map): arbitrary keys. */
export const slruPolicy = {
    name: 'slru',
    real: (cap) => wrapSlru(new Slru(cap)),
    oracle: (cap) => makeSlruOracle(cap),
};

/** The Slru policy on the INTEGER substrate backing (`keys: 'int'`), driven against the
 *  SAME slru oracle: the strict-zero backing must return byte-identical values + victims. */
export const slruIntPolicy = {
    name: 'slru-int',
    real: (cap) => wrapSlru(new Slru(cap, { keys: 'int' })),
    oracle: (cap) => makeSlruOracle(cap),
};

/** Wrap a real TwoQ as a uniform driver. victim via `_peekVictim` (test-only). */
export function wrapTwoQ(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v, t) => cache.put(k, v, t),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => cache._peekVictim(),
        raw: cache,
    };
}

/** The TwoQ policy (decisions/0015): the full-2Q member + its own independent
 *  A1in/Am/A1out-ghost oracle. Default backing (Map): arbitrary keys. */
export const twoqPolicy = {
    name: 'twoq',
    real: (cap) => wrapTwoQ(new TwoQ(cap)),
    oracle: (cap) => makeTwoQOracle(cap),
};

/** The TwoQ policy on the INTEGER substrate backing (`keys: 'int'`), driven against the
 *  SAME twoq oracle: the strict-zero backing (incl. the int A1out ghost ring +
 *  membership table) must return byte-identical values + victims. */
export const twoqIntPolicy = {
    name: 'twoq-int',
    real: (cap) => wrapTwoQ(new TwoQ(cap, { keys: 'int' })),
    oracle: (cap) => makeTwoQOracle(cap),
};

/** Wrap a real Arc as a uniform driver. victim via `_peekVictim` (test-only). */
export function wrapArc(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v, t) => cache.put(k, v, t),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => cache._peekVictim(),
        raw: cache,
    };
}

/** The Arc policy (decisions/0016): the adaptive member + its own independent
 *  two-list/two-ghost/`p` oracle. Default backing (Map): arbitrary keys. */
export const arcPolicy = {
    name: 'arc',
    real: (cap) => wrapArc(new Arc(cap)),
    oracle: (cap) => makeArcOracle(cap),
};

/** The Arc policy on the INTEGER substrate backing (`keys: 'int'`), driven against the
 *  SAME arc oracle: the strict-zero backing (incl. the int B1/B2 ghost rings +
 *  membership tables) must return byte-identical values + victims. */
export const arcIntPolicy = {
    name: 'arc-int',
    real: (cap) => wrapArc(new Arc(cap, { keys: 'int' })),
    oracle: (cap) => makeArcOracle(cap),
};

/* -------------------------------------------------------------------------- *
 * TTL policies (decisions/0017). The factories FORWARD a construction-options arg
 * `o` (the { ttl, clock } the runner injects) to BOTH the real cache and its oracle,
 * so runDifferential's virtual clock drives them in lockstep. The lazy stale rule
 * (D17.3) is mirrored inside each oracle exactly, so a stale get/has/peek reaps the
 * same entry in both -- the differential proves it.
 * -------------------------------------------------------------------------- */

/** Classic LRU with an opt-in TTL default (decisions/0017). */
export const lruTtlPolicy = {
    name: 'lru-ttl',
    real: (cap, o) => wrapLru(new LiteLru(cap, o)),
    oracle: (cap, o) => makeLruOracle(cap, o),
};

/** SIEVE with an opt-in TTL default (decisions/0017). */
export const sieveTtlPolicy = {
    name: 'sieve-ttl',
    real: (cap, o) => wrapSieve(new Sieve(cap, o)),
    oracle: (cap, o) => makeSieveOracle(cap, o),
};

/** S3-FIFO with an opt-in TTL default (decisions/0017). */
export const s3fifoTtlPolicy = {
    name: 's3fifo-ttl',
    real: (cap, o) => wrapS3Fifo(new S3Fifo(cap, o)),
    oracle: (cap, o) => makeS3FifoOracle(cap, o),
};

/** W-TinyLFU with an opt-in TTL default (decisions/0017). */
export const wtinylfuTtlPolicy = {
    name: 'wtinylfu-ttl',
    real: (cap, o) => wrapWTinyLfu(new WTinyLfu(cap, o)),
    oracle: (cap, o) => makeWTinyLfuOracle(cap, o),
};

/** Slru with an opt-in TTL default (decisions/0017). */
export const slruTtlPolicy = {
    name: 'slru-ttl',
    real: (cap, o) => wrapSlru(new Slru(cap, o)),
    oracle: (cap, o) => makeSlruOracle(cap, o),
};

/** TwoQ with an opt-in TTL default (decisions/0017). */
export const twoqTtlPolicy = {
    name: 'twoq-ttl',
    real: (cap, o) => wrapTwoQ(new TwoQ(cap, o)),
    oracle: (cap, o) => makeTwoQOracle(cap, o),
};

/** Arc with an opt-in TTL default (decisions/0017). */
export const arcTtlPolicy = {
    name: 'arc-ttl',
    real: (cap, o) => wrapArc(new Arc(cap, o)),
    oracle: (cap, o) => makeArcOracle(cap, o),
};

/** Wrap a real Lirs as a uniform driver. victim via `_peekVictim` (Q front, test-only). */
export function wrapLirs(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v, t) => cache.put(k, v, t),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => cache._peekVictim(),
        raw: cache,
    };
}

/** The Lirs policy (decisions/0023): the LIRS member + its own independent stack/Q/bounded-
 *  history oracle. Default backing (Map): arbitrary keys. */
export const lirsPolicy = {
    name: 'lirs',
    real: (cap) => wrapLirs(new Lirs(cap)),
    oracle: (cap) => makeLirsOracle(cap),
};

/** The Lirs policy on the INTEGER substrate backing (`keys: 'int'`), driven against the
 *  SAME lirs oracle: the strict-zero backing (incl. the int history ring) must return
 *  byte-identical values + victims (decisions/0011 + 0023). */
export const lirsIntPolicy = {
    name: 'lirs-int',
    real: (cap) => wrapLirs(new Lirs(cap, { keys: 'int' })),
    oracle: (cap) => makeLirsOracle(cap),
};

/** Lirs with an opt-in TTL default (decisions/0017). */
export const lirsTtlPolicy = {
    name: 'lirs-ttl',
    real: (cap, o) => wrapLirs(new Lirs(cap, o)),
    oracle: (cap, o) => makeLirsOracle(cap, o),
};

/** Wrap a real Lfu as a uniform driver. victim via `_peekVictim` (the LRU-end key of the
 *  lowest-frequency bucket, test-only introspection, never a hot path). */
export function wrapLfu(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v, t) => cache.put(k, v, t),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => cache._peekVictim(),
        raw: cache,
    };
}

/** The Lfu policy (decisions/0024): the exact-LFU member + its own independent
 *  exact-frequency + LRU-tie-break oracle. Default backing (Map): arbitrary keys. */
export const lfuPolicy = {
    name: 'lfu',
    real: (cap) => wrapLfu(new Lfu(cap)),
    oracle: (cap) => makeLfuOracle(cap),
};

/** The Lfu policy on the INTEGER substrate backing (`keys: 'int'`), driven against the SAME
 *  lfu oracle: the strict-zero backing must return byte-identical values + victims. */
export const lfuIntPolicy = {
    name: 'lfu-int',
    real: (cap) => wrapLfu(new Lfu(cap, { keys: 'int' })),
    oracle: (cap) => makeLfuOracle(cap),
};

/** Lfu with an opt-in TTL default (decisions/0017). */
export const lfuTtlPolicy = {
    name: 'lfu-ttl',
    real: (cap, o) => wrapLfu(new Lfu(cap, o)),
    oracle: (cap, o) => makeLfuOracle(cap, o),
};

/** Wrap a real ClockPro as a uniform driver. victim via `_peekVictim` (the non-destructive
 *  twin of the HAND_cold eviction sweep, test-only introspection, never a hot path). */
export function wrapClockPro(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v, t) => cache.put(k, v, t),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => cache._peekVictim(),
        raw: cache,
    };
}

/** The ClockPro policy (decisions/0025): the CLOCK-approximation-of-LIRS member + its own
 *  independent clock/three-hand/bounded-history oracle. Default backing (Map): arbitrary keys. */
export const clockProPolicy = {
    name: 'clockpro',
    real: (cap) => wrapClockPro(new ClockPro(cap)),
    oracle: (cap) => makeClockProOracle(cap),
};

/** The ClockPro policy on the INTEGER substrate backing (`keys: 'int'`), driven against the
 *  SAME clockpro oracle: the strict-zero backing (incl. the int history ring) must return
 *  byte-identical values + victims (decisions/0011 + 0025). */
export const clockProIntPolicy = {
    name: 'clockpro-int',
    real: (cap) => wrapClockPro(new ClockPro(cap, { keys: 'int' })),
    oracle: (cap) => makeClockProOracle(cap),
};

/** ClockPro with an opt-in TTL default (decisions/0017). */
export const clockProTtlPolicy = {
    name: 'clockpro-ttl',
    real: (cap, o) => wrapClockPro(new ClockPro(cap, o)),
    oracle: (cap, o) => makeClockProOracle(cap, o),
};

/** Wrap a real LruK as a uniform driver. victim via `_peekVictim` (the cold tail, else the
 *  min-`_r1` warm page -- test-only introspection, never a hot path). */
export function wrapLruK(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v, t) => cache.put(k, v, t),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => cache._peekVictim(),
        raw: cache,
    };
}

/** The LruK policy (decisions/0026): the LRU-K (K=2) member + its own independent
 *  cold/warm/reference-time/bounded-history oracle. Default backing (Map): arbitrary keys. */
export const lrukPolicy = {
    name: 'lruk',
    real: (cap) => wrapLruK(new LruK(cap)),
    oracle: (cap) => makeLruKOracle(cap),
};

/** The LruK policy on the INTEGER substrate backing (`keys: 'int'`), driven against the SAME
 *  lruk oracle: the strict-zero backing (incl. the int history ring) must return byte-identical
 *  values + victims (decisions/0011 + 0026). */
export const lrukIntPolicy = {
    name: 'lruk-int',
    real: (cap) => wrapLruK(new LruK(cap, { keys: 'int' })),
    oracle: (cap) => makeLruKOracle(cap),
};

/** LruK with an opt-in TTL default (decisions/0017). */
export const lrukTtlPolicy = {
    name: 'lruk-ttl',
    real: (cap, o) => wrapLruK(new LruK(cap, o)),
    oracle: (cap, o) => makeLruKOracle(cap, o),
};

/** Wrap a real Mq as a uniform driver. victim via `_peekVictim` (the LRU tail of the lowest
 *  non-empty band queue -- test-only introspection, never a hot path). */
export function wrapMq(cache) {
    return {
        get: (k) => cache.get(k),
        put: (k, v, t) => cache.put(k, v, t),
        has: (k) => cache.has(k),
        peek: (k) => cache.peek(k),
        delete: (k) => cache.delete(k),
        size: () => cache.size,
        victim: () => cache._peekVictim(),
        raw: cache,
    };
}

/** The Mq policy (decisions/0027): the Multi-Queue (m=8) member + its own independent
 *  8-band/refcount/logical-clock/bounded-Qout oracle. Default backing (Map): arbitrary keys. */
export const mqPolicy = {
    name: 'mq',
    real: (cap) => wrapMq(new Mq(cap)),
    oracle: (cap) => makeMqOracle(cap),
};

/** The Mq policy on the INTEGER substrate backing (`keys: 'int'`), driven against the SAME mq
 *  oracle: the strict-zero backing (incl. the int Qout ring + refcount ring) must return
 *  byte-identical values + victims (decisions/0011 + 0027). */
export const mqIntPolicy = {
    name: 'mq-int',
    real: (cap) => wrapMq(new Mq(cap, { keys: 'int' })),
    oracle: (cap) => makeMqOracle(cap),
};

/** Mq with an opt-in TTL default (decisions/0017). The logical clock `_t` is SEPARATE from the
 *  wall-clock ttl; both are driven in lockstep with the oracle. */
export const mqTtlPolicy = {
    name: 'mq-ttl',
    real: (cap, o) => wrapMq(new Mq(cap, o)),
    oracle: (cap, o) => makeMqOracle(cap, o),
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

/** Apply one op to a uniform driver, returning the observable value. `ttlMs` is only
 *  ever defined in TTL mode and only for a put (decisions/0017). */
function applyOp(d, kind, key, val, ttlMs) {
    switch (kind) {
        case OP_GET: return d.get(key);
        case OP_PUT: d.put(key, val, ttlMs); return undefined;
        case OP_DELETE: return d.delete(key);
        case OP_HAS: return d.has(key);
        default: return d.peek(key); // OP_PEEK
    }
}

/**
 * @param {{name,real,oracle}} policy
 * @param {{cap:number, ops:number, seed:number, keyspace:number, ttl?:number}} opts
 * @returns {{ok:true} | {ok:false, i, kind, key, why, real, oracle}}
 *
 * When `opts.ttl` is set (decisions/0017) the runner drives a VIRTUAL CLOCK shared by
 * the real cache and the oracle: it advances a few ms per op and passes a per-put
 * `ttlMs` (sometimes Infinity) so entries actually expire mid-stream and the lazy
 * stale rule (get/has/peek reap on touch) is differential-checked, victim included.
 */
export function runDifferential(policy, opts) {
    const prng = makePrng(opts.seed);
    const ttl = opts.ttl;
    // A virtual clock (a mutable holder both driver factories close over via cfn).
    const vclock = { now: 0 };
    const cfn = ttl !== undefined ? () => vclock.now : undefined;
    const cacheOpts = ttl !== undefined ? { ttl, clock: cfn } : undefined;
    const real = policy.real(opts.cap, cacheOpts);
    const oracle = policy.oracle(opts.cap, cacheOpts);
    const ks = opts.keyspace;

    for (let i = 0; i < opts.ops; i++) {
        // Advance the virtual clock BEFORE the op so real + oracle read the same now.
        if (ttl !== undefined) vclock.now += prng() % 3; // 0/1/2 ms per op
        const kind = prng() % 5;
        const key = prng() % ks;
        const val = prng() >>> 0;
        // A per-put ttlMs in TTL mode: mostly small (so entries expire), sometimes
        // Infinity (never), sometimes omitted (the instance default).
        let ttlMs;
        if (ttl !== undefined && kind === OP_PUT) {
            const pick = prng() % 4;
            ttlMs = pick === 0 ? undefined : pick === 1 ? Infinity : 1 + (prng() % 6);
        }

        const rv = applyOp(real, kind, key, val, ttlMs);
        const ov = applyOp(oracle, kind, key, val, ttlMs);
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

/**
 * A Lirs subclass whose stack-S columns `_sNext`/`_sPrev` are wrapped in counting
 * Proxies -- used ONLY in the T6 LIRS counter sub-tier, NEVER on a measured zero-alloc
 * path (a Proxy allocates + traps and would poison the gate). It pins the ONE genuine
 * fast path: a LIR hit at the TOP of the stack relinks NOTHING (the pinned 0-write case,
 * like LiteLru's head re-hit), while an interior LIR hit is the 5-write "move to top of S".
 */
export class CountedLirs extends Lirs {
    constructor(capacity, options) {
        super(capacity, options);
        this._writes = 0; // _sNext / _sPrev link stores
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
        this._sNext = countStores(this._sNext);
        this._sPrev = countStores(this._sPrev);
    }
    resetWrites() { this._writes = 0; }
    writes() { return this._writes; }
}

/** LIRS LIR-hit-at-top baseline (measured; regression tripwire): the pinned 0-write path. */
export const LIRS_WRITES_LIR_TOP_REHIT = 0;

/**
 * An Lfu subclass whose key-list columns `_fNext`/`_fPrev`/`_kB` AND the bucket-pool
 * columns `_bFreq`/`_bNext`/`_bPrev`/`_bHead`/`_bTail` are wrapped in counting Proxies --
 * used ONLY in the T6 LFU counter sub-tier, NEVER on a measured zero-alloc path (a Proxy
 * allocates + traps and would poison the gate). An Lfu hit legitimately RELINKS across
 * frequency buckets: the gate asserts zero-ALLOCATION, not minimal writes, and pins the
 * DEBATE-honest numbers -- the FAST PATH (a single-key bucket with no freq+1 neighbour is
 * RELABELLED in place: 1 write) and the worst-case bound (<= 14 writes/hit). The Proxy
 * writes through to the same underlying buffers the store reads, so alloc/free stay
 * consistent (as in CountedLru). */
export class CountedLfu extends Lfu {
    constructor(capacity, options) {
        super(capacity, options);
        this._writes = 0;
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
        this._fNext = countStores(this._fNext);
        this._fPrev = countStores(this._fPrev);
        this._kB = countStores(this._kB);
        this._bFreq = countStores(this._bFreq);
        this._bNext = countStores(this._bNext);
        this._bPrev = countStores(this._bPrev);
        this._bHead = countStores(this._bHead);
        this._bTail = countStores(this._bTail);
    }
    resetWrites() { this._writes = 0; }
    writes() { return this._writes; }
}

/** Lfu hit baselines (measured; regression tripwire). The FAST PATH relabels a single-key
 *  bucket in place (1 write); the worst-case relink is bounded at LFU_WRITES_MAX. */
export const LFU_WRITES_FASTPATH = 1;
export const LFU_WRITES_MAX = 14;

/**
 * A ClockPro subclass whose ring columns `_next`/`_prev` AND the per-page state column `_st`
 * are wrapped in counting Proxies -- used ONLY in the T6 ClockPro counter sub-tier, NEVER on
 * a measured zero-alloc path (a Proxy allocates + traps and would poison the gate). It pins
 * ClockPro's headline: a HIT relinks NOTHING (0 `_next`/`_prev` stores) and sets exactly ONE
 * `_st` byte (the reference bit) -- the Sieve/S3Fifo lazy-promotion discipline. The Proxy
 * writes through to the same underlying buffer the store reads, so alloc/free stay consistent.
 */
export class CountedClockPro extends ClockPro {
    constructor(capacity, options) {
        super(capacity, options);
        this._writes = 0;   // _next / _prev link stores
        this._stWrites = 0; // _st state stores
        const self = this;
        const countStores = (arr, isSt) => new Proxy(arr, {
            set(t, prop, value) {
                if (typeof prop === 'string' && prop !== 'length' && String(+prop) === prop) {
                    if (isSt) self._stWrites++; else self._writes++;
                }
                t[prop] = value;
                return true;
            },
        });
        this._next = countStores(this._next, false);
        this._prev = countStores(this._prev, false);
        this._st = countStores(this._st, true);
    }
    resetWrites() { this._writes = 0; this._stWrites = 0; }
    writes() { return this._writes; }
    stWrites() { return this._stWrites; }
}

/** ClockPro hit baselines (measured; a REAL regression pin). The headline: a hit relinks
 *  NOTHING (0 link stores) and sets exactly ONE state byte (the reference bit). */
export const CLOCKPRO_WRITES_HIT_LINKS = 0;
export const CLOCKPRO_WRITES_HIT_ST = 1;

/** NOT a bound -- a per-STREAM regression TRIPWIRE only. A ClockPro miss+evict is amortized
 *  O(1) (classic CLOCK) but WORST-CASE O(capacity) `_st` writes on a full-scan-then-insert
 *  (fill to capacity, reference every resident page, then insert -- HAND_cold + HAND_hot must
 *  sweep the whole clock clearing reference bits, ~2*capacity writes). This constant only
 *  tripwires the t6 `cpStream` corpus (a mixed stream that never does scan-then-insert,
 *  worst-observed ~37); it makes NO claim about the true worst case (which is O(capacity)),
 *  unlike Lfu's PROVEN <= 14. Do not call it a bound. */
export const CLOCKPRO_WRITES_MISS_EVICT_TRIPWIRE = 64;

/**
 * A LruK subclass whose shared link columns `_next`/`_prev` AND the two reference-time columns
 * `_r0`/`_r1` are wrapped in counting Proxies -- used ONLY in the T6 LRU-K counter sub-tier,
 * NEVER on a measured zero-alloc path (a Proxy allocates + traps and would poison the gate). It
 * pins LRU-K's write budget (decisions/0026, D26.2): a WARM hit relinks NOTHING (0 `_next`/`_prev`
 * stores) and does exactly TWO stamps (`_r1`, then `_r0`); a COLD->WARM promotion is exactly
 * FIVE link stores (2 cold detach + 3 warm push, non-exceedable) and the SAME two stamps. The
 * Proxy writes through to the same underlying buffers the store reads, so alloc/free stay
 * consistent (as in CountedLru).
 */
export class CountedLruK extends LruK {
    constructor(capacity, options) {
        super(capacity, options);
        this._writes = 0;  // _next / _prev link stores
        this._stamps = 0;  // _r0 / _r1 reference-time stores
        const self = this;
        const countStores = (arr, isStamp) => new Proxy(arr, {
            set(t, prop, value) {
                if (typeof prop === 'string' && prop !== 'length' && String(+prop) === prop) {
                    if (isStamp) self._stamps++; else self._writes++;
                }
                t[prop] = value;
                return true;
            },
        });
        this._next = countStores(this._next, false);
        this._prev = countStores(this._prev, false);
        this._r0 = countStores(this._r0, true);
        this._r1 = countStores(this._r1, true);
    }
    resetWrites() { this._writes = 0; this._stamps = 0; }
    writes() { return this._writes; }
    stamps() { return this._stamps; }
}

/** LruK hit baselines (measured; a REAL regression pin, decisions/0026 D26.2). A warm hit
 *  relinks NOTHING; a cold->warm promotion is exactly 5 link stores (non-exceedable). Both do
 *  exactly 2 reference-time stamps. */
export const LRUK_WRITES_HIT_WARM = 0;    // a warm hit relinks nothing
export const LRUK_WRITES_HIT_PROMOTE = 5; // a cold->warm promotion: 2 cold-detach + 3 warm-push
export const LRUK_WRITES_HIT_STAMPS = 2;  // both paths slide r1 then stamp r0

/** NOT a bound -- a per-STREAM regression TRIPWIRE only (decisions/0026, D26.5). An LruK
 *  miss+evict is O(1) when a cold page exists (cold-tail eviction), but WORST-CASE O(size)
 *  READS when the resident set is ALL WARM (the min-`_r1` scan walks the whole warm list). We do
 *  NOT pin a bound. This constant tripwires the t6 all-warm stream (worst-observed scan length);
 *  if it is ever exceeded the change is investigated -- the true worst case is O(capacity). The
 *  t6 all-warm stream runs at capacity 4096, where the whole warm list (up to 4096 pages) is
 *  scanned; the tripwire sits just above that with headroom. */
export const LRUK_EVICT_SCAN_TRIPWIRE = 4352;

/**
 * An Mq subclass whose shared link columns `_next`/`_prev` AND the three metadata columns
 * `_rc`/`_exq`/`_qn` are wrapped in counting Proxies -- used ONLY in the T6 MQ counter sub-tier,
 * NEVER on a measured zero-alloc path (a Proxy allocates + traps and would poison the gate). It
 * pins MQ's write budget (decisions/0027, D27.6): a hit that is already the MRU of its unchanged
 * band relinks NOTHING (0 `_next`/`_prev` stores); any other hit is EXACTLY 5 link stores (a
 * <= 2-write detach + a <= 3-write head push). The FIXED 7-step aging sweep adds AT MOST 7
 * demotions x <= 4 link writes = 28, so the WHOLE per-access link total is <= 33 -- NON-EXCEEDABLE
 * (reset-on-demote forbids cascade). The accessed slot always receives exactly 3 metadata stamps
 * (`_rc`, `_qn`, `_exq`); each aging demotion adds 2 more (`_qn`, `_exq` on the demoted slot). The
 * Proxy writes through to the same underlying buffers the store reads, so alloc/free stay
 * consistent (as in CountedLru).
 */
export class CountedMq extends Mq {
    constructor(capacity, options) {
        super(capacity, options);
        this._writes = 0;  // _next / _prev link stores
        this._stamps = 0;  // _rc / _exq / _qn metadata stores
        const self = this;
        const countStores = (arr, isStamp) => new Proxy(arr, {
            set(t, prop, value) {
                if (typeof prop === 'string' && prop !== 'length' && String(+prop) === prop) {
                    if (isStamp) self._stamps++; else self._writes++;
                }
                t[prop] = value;
                return true;
            },
        });
        this._next = countStores(this._next, false);
        this._prev = countStores(this._prev, false);
        this._rc = countStores(this._rc, true);
        this._exq = countStores(this._exq, true);
        this._qn = countStores(this._qn, true);
    }
    resetWrites() { this._writes = 0; this._stamps = 0; }
    writes() { return this._writes; }
    stamps() { return this._stamps; }
}

/** Mq hit link baselines (measured; a REAL regression pin, decisions/0027 D27.6). A hit that is
 *  already the MRU of its unchanged band relinks NOTHING; any other hit is exactly 5 link stores.
 *  The FIXED 7-step aging sweep adds <= 7 x 4 = 28, so the whole per-access link total is <= 33 --
 *  non-exceedable. The accessed slot always receives exactly 3 metadata stamps. */
export const MQ_WRITES_HIT_FASTPATH = 0;   // already-MRU-of-band hit relinks nothing
export const MQ_WRITES_HIT_RELINK = 5;     // any other hit: <= 2 detach + <= 3 head push
export const MQ_WRITES_AGING_MAX = 28;     // 7 demotions x <= 4 link writes (the fixed sweep)
export const MQ_WRITES_MAX = 33;           // 5 relink + 28 aging, NON-EXCEEDABLE per access
export const MQ_STAMPS_ACCESS = 3;         // _rc + _qn + _exq on the accessed slot, every access

/* -------------------------------------------------------------------------- *
 * Snapshot / restore round-trip differential (decisions/0021, D21).
 *
 * The teeth for dump()/restore(): (1) dump -> restore -> dump is deep-equal (the
 * snapshot is a fixed point), and (2) a restored cache and the un-snapshotted TWIN
 * it was reconstructed from make IDENTICAL future decisions -- same returned value,
 * same live size, AND same next-eviction victim after every op of a shared future
 * trace. Dropping any aux state (Arc's p, W-TinyLFU's sketch, a ghost) is a fail-OPEN
 * correctness bug the future-eviction leg catches.
 *
 * The original cache IS the twin: dump() is read-only (it does not bump _ver or move
 * anything), so the snapshotted state and the post-dump original are identical, and
 * restore() targets a FRESH instance. Both are then driven in lockstep.
 * -------------------------------------------------------------------------- */

/** Every member paired with its Ctor + uniform driver wrapper (victim()). */
export const SNAP_MEMBERS = [
    { name: 'LiteLru', Ctor: LiteLru, wrap: wrapLru },
    { name: 'Sieve', Ctor: Sieve, wrap: wrapSieve },
    { name: 'S3Fifo', Ctor: S3Fifo, wrap: wrapS3Fifo },
    { name: 'WTinyLfu', Ctor: WTinyLfu, wrap: wrapWTinyLfu },
    { name: 'Slru', Ctor: Slru, wrap: wrapSlru },
    { name: 'TwoQ', Ctor: TwoQ, wrap: wrapTwoQ },
    { name: 'Arc', Ctor: Arc, wrap: wrapArc },
    { name: 'Lirs', Ctor: Lirs, wrap: wrapLirs },
    { name: 'Lfu', Ctor: Lfu, wrap: wrapLfu },
    { name: 'ClockPro', Ctor: ClockPro, wrap: wrapClockPro },
    { name: 'LruK', Ctor: LruK, wrap: wrapLruK },
    { name: 'Mq', Ctor: Mq, wrap: wrapMq },
];

/** Structural deep-equality for two snapshots, IGNORING the capture-time field `t`
 *  (which legitimately differs between dumps). Object.is at the leaves so Infinity /
 *  NaN / -0 are compared exactly (the TTL-verbatim expiries live here). */
export function snapDeepEq(a, b) {
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!snapDeepEq(a[i], b[i])) return false;
        return true;
    }
    if (a !== null && typeof a === 'object') {
        if (b === null || typeof b !== 'object' || Array.isArray(b)) return false;
        const ka = Object.keys(a).filter((k) => k !== 't');
        const kb = Object.keys(b).filter((k) => k !== 't');
        if (ka.length !== kb.length) return false;
        for (let i = 0; i < ka.length; i++) {
            const k = ka[i];
            if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
            if (!snapDeepEq(a[k], b[k])) return false;
        }
        return true;
    }
    return Object.is(a, b);
}

/**
 * Run the round-trip differential for one member.
 * @param {{name,Ctor,wrap}} member
 * @param {{cap,pre,ops,seed,keyspace,keys?,ttl?}} opts
 * @returns {{ok:true} | {ok:false, why, i?, ...}}
 */
export function runRoundTrip(member, opts) {
    const prng = makePrng(opts.seed);
    const ttl = opts.ttl;
    const vclock = { now: 0 };
    const cfn = ttl !== undefined ? () => vclock.now : undefined;
    const cacheOpts = {};
    if (opts.keys) cacheOpts.keys = opts.keys;
    if (ttl !== undefined) { cacheOpts.ttl = ttl; cacheOpts.clock = cfn; }
    const hasOpts = Object.keys(cacheOpts).length > 0;
    const ctorOpts = hasOpts ? cacheOpts : undefined;
    const ks = opts.keyspace;

    const orig = new member.Ctor(opts.cap, ctorOpts);

    // Build-up churn: reach a rich mid-life state (all lists + ghosts + sketch + p).
    for (let i = 0; i < opts.pre; i++) {
        if (ttl !== undefined) vclock.now += prng() % 3;
        const kind = prng() % 5;
        const key = prng() % ks;
        const val = prng() >>> 0;
        let ttlMs;
        if (ttl !== undefined && kind === OP_PUT) {
            const pick = prng() % 4;
            ttlMs = pick === 0 ? undefined : pick === 1 ? Infinity : 1 + (prng() % 6);
        }
        applyOp(member.wrap(orig), kind, key, val, ttlMs);
    }

    // dump -> structuredClone (prove it round-trips as a plain graph) -> restore.
    const snap1 = orig.dump();
    let clone;
    try { clone = structuredClone(snap1); }
    catch (e) { return { ok: false, why: 'structuredClone-threw', err: String(e) }; }
    let restored;
    try { restored = member.Ctor.restore(clone, ctorOpts); }
    catch (e) { return { ok: false, why: 'restore-threw', err: String(e) }; }

    // dump -> restore -> dump is a fixed point.
    if (!snapDeepEq(snap1, restored.dump())) {
        return { ok: false, why: 'dump-redump-diff' };
    }
    if (restored.size !== orig.size) {
        return { ok: false, why: 'size-after-restore', real: restored.size, oracle: orig.size };
    }

    // Future-eviction differential: same trace to the TWIN (orig) and the RESTORED.
    const dOrig = member.wrap(orig);
    const dRest = member.wrap(restored);
    for (let i = 0; i < opts.ops; i++) {
        if (ttl !== undefined) vclock.now += prng() % 3;
        const kind = prng() % 5;
        const key = prng() % ks;
        const val = prng() >>> 0;
        let ttlMs;
        if (ttl !== undefined && kind === OP_PUT) {
            const pick = prng() % 4;
            ttlMs = pick === 0 ? undefined : pick === 1 ? Infinity : 1 + (prng() % 6);
        }
        const rv = applyOp(dRest, kind, key, val, ttlMs);
        const ov = applyOp(dOrig, kind, key, val, ttlMs);
        if (!Object.is(rv, ov)) return { ok: false, why: 'value', i, kind, key, real: rv, oracle: ov };
        if (dRest.size() !== dOrig.size()) {
            return { ok: false, why: 'size', i, kind, key, real: dRest.size(), oracle: dOrig.size() };
        }
        const rvic = dRest.victim();
        const ovic = dOrig.victim();
        if (!Object.is(rvic, ovic)) return { ok: false, why: 'victim', i, kind, key, real: rvic, oracle: ovic };
    }
    return { ok: true };
}
