/**
 * t8 -- Belady OPT gate (S9, DEBATE item 13 / decisions D20).
 *
 * The shipped bench tool reports each policy's hit ratio as a fraction of Belady's
 * OPT -- the clairvoyant offline optimum (evict the resident whose NEXT use is
 * farthest in the future). Every "% of optimal" figure leans on `beladyOpt` being
 * EXACTLY right, so it is gated two ways, fail-closed:
 *
 *   (1) CORRECTNESS. `beladyOpt` (the practical heap impl shipped in Bench.mjs) is
 *       differential-tested against a brute-force O(N*C) OPT on small seeded traces.
 *       Any disagreement dies with the replay seed.
 *
 *   (2) OPTIMALITY. On every trace, OPT's hit count must be >= each MEMBER's hit
 *       count (LiteLru AND Sieve) on the SAME trace -- no online policy can beat the
 *       clairvoyant optimum. A member out-hitting OPT means OPT is wrong (or a member
 *       is peeking at the future); either way the gate fails.
 *
 * OPT lives STRICTLY in the offline bench (Bench.mjs), never in Lru.js -- it is a
 * reference oracle, not a cache policy. This tier reuses the exact exported impl.
 */

import { LiteLru, Sieve } from '../../Lru.js';
import { beladyOpt } from '../../benchmark/Bench.mjs';
import { makePrng, SEED, check } from './harness.mjs';

/* -------------------------------------------------------------------------- *
 * The brute-force OPT -- the ground truth for check (1). Deliberately the DUMB
 * O(N*C*N) implementation: a forward scan that, on a miss at capacity, evicts the
 * resident whose next occurrence is farthest ahead (or never). Shares NO code with
 * beladyOpt, so it can never share a bug. Only run on SMALL traces.
 * -------------------------------------------------------------------------- */
function bruteOptHits(trace, capacity) {
    const n = trace.length;
    const resident = new Set();
    let hits = 0;
    for (let i = 0; i < n; i++) {
        const k = trace[i];
        if (resident.has(k)) { hits++; continue; }
        if (resident.size === capacity) {
            let victim, farthest = -1;
            for (const r of resident) {
                let nu = n; // never used again -> farthest possible
                for (let j = i + 1; j < n; j++) { if (trace[j] === r) { nu = j; break; } }
                if (nu > farthest) { farthest = nu; victim = r; }
            }
            resident.delete(victim);
        }
        resident.add(k);
    }
    return hits;
}

/** Hits a real member scores on a trace, using the same get-or-put protocol the
 *  bench uses (a resident key is a hit; a miss inserts it). */
function memberHits(CacheClass, trace, capacity) {
    const c = new CacheClass(capacity);
    let hits = 0;
    for (let i = 0; i < trace.length; i++) {
        const k = trace[i];
        if (c.get(k) !== undefined) hits++;
        else c.put(k, k);
    }
    return hits;
}

/* -------------------------------------------------------------------------- *
 * Seeded trace builders (self-contained; the bench's generators are exercised
 * separately by node benchmark/Bench.mjs). Plain integer-key Arrays so hit counts reproduce.
 * -------------------------------------------------------------------------- */
function zipfish(prng, length, keyspace) {
    const t = new Array(length);
    for (let i = 0; i < length; i++) {
        // A cheap skew: square the uniform sample to bias toward low keys.
        const u = prng() / 0x100000000;
        t[i] = (u * u * keyspace) | 0;
    }
    return t;
}

function loopish(length, span) {
    const t = new Array(length);
    for (let i = 0; i < length; i++) t[i] = i % span;
    return t;
}

function scanish(prng, length, hotSize) {
    const t = new Array(length);
    let flood = hotSize;
    for (let i = 0; i < length; i++) {
        if ((prng() / 0x100000000) < 0.5) t[i] = prng() % hotSize;
        else t[i] = flood++;
    }
    return t;
}

export function run() {
    const prng = makePrng(SEED ^ 0x08);
    let units = 0; // work units: differential OPT configs + optimality-bound checks

    // --- check (1): beladyOpt === brute-force OPT on small seeded traces --------
    // Small enough that the O(N*C*N) brute reference is affordable, varied enough
    // (cap, keyspace, pattern) to exercise the heap's eviction + rebuild paths.
    const smallConfigs = [
        { cap: 1, len: 120, ks: 6 },
        { cap: 2, len: 200, ks: 8 },
        { cap: 4, len: 240, ks: 12 },
        { cap: 8, len: 300, ks: 20 },
        { cap: 3, len: 180, ks: 5 },   // ks < cap*2 -> frequent hits
    ];
    for (let ci = 0; ci < smallConfigs.length; ci++) {
        const cfg = smallConfigs[ci];
        for (let rep = 0; rep < 8; rep++) {
            const seed = (SEED ^ (cfg.cap << 8) ^ (rep + 1)) >>> 0 || 1;
            const p = makePrng(seed);
            const trace = zipfish(p, cfg.len, cfg.ks);
            const got = beladyOpt(trace, cfg.cap).hits;
            const want = bruteOptHits(trace, cfg.cap);
            check(got === want,
                () => 't8 (1): beladyOpt=' + got + ' != brute OPT=' + want +
                    ' (cap=' + cfg.cap + ' len=' + cfg.len + ' ks=' + cfg.ks + ' rep=' + rep +
                    ')\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs');
            units++; // one beladyOpt-vs-brute differential config proven
        }
    }

    // A degenerate loop trace also matches the brute reference (classic LRU worst
    // case; OPT should still find every avoidable hit).
    {
        const trace = loopish(200, 5);
        const got = beladyOpt(trace, 3).hits;
        const want = bruteOptHits(trace, 3);
        check(got === want,
            () => 't8 (1): loop trace beladyOpt=' + got + ' != brute=' + want);
        units++;
    }

    // --- check (2): OPT >= every member on the SAME trace (both members) --------
    // Larger, realistic traces across all three workload shapes. No online policy
    // can beat the clairvoyant optimum; a violation means OPT is wrong.
    const bigConfigs = [
        { name: 'zipf', cap: 64, trace: zipfish(prng, 40000, 64 * 16) },
        { name: 'loop', cap: 64, trace: loopish(40000, 64 * 4) },
        { name: 'scan', cap: 64, trace: scanish(prng, 40000, 32) },
        { name: 'zipf-small', cap: 8, trace: zipfish(prng, 20000, 40) },
        { name: 'scan-tight', cap: 16, trace: scanish(prng, 20000, 8) },
    ];
    for (let ci = 0; ci < bigConfigs.length; ci++) {
        const cfg = bigConfigs[ci];
        const opt = beladyOpt(cfg.trace, cfg.cap).hits;
        const lru = memberHits(LiteLru, cfg.trace, cfg.cap);
        const sieve = memberHits(Sieve, cfg.trace, cfg.cap);
        check(opt >= lru,
            () => 't8 (2): LiteLru hits ' + lru + ' > OPT ' + opt + ' on ' + cfg.name +
                ' (cap=' + cfg.cap + ') -- no policy can beat OPT' +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs');
        check(opt >= sieve,
            () => 't8 (2): Sieve hits ' + sieve + ' > OPT ' + opt + ' on ' + cfg.name +
                ' (cap=' + cfg.cap + ') -- no policy can beat OPT' +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs');
        units += 2; // LiteLru + Sieve optimality bounds checked on this trace
    }

    // Non-vacuity: the brute reference is not trivially returning 0 on a trace with
    // obvious reuse (else check (1) would be decorative).
    {
        const trace = [1, 2, 1, 2, 1, 2];
        const want = bruteOptHits(trace, 2);
        check(want === 4, () => 't8: brute OPT vacuous -- expected 4 hits on [1,2]*3, got ' + want);
        units++;
    }

    return units;
}
