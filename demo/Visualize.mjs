// @zakkster/lite-lru -- demo engine (S13, decisions/0022, D22).
//
//   npm run demo                 (headless per-member summary)
//   node demo/Visualize.mjs      (same)
//
// The headless visualization engine. It constructs ALL SEVEN members once, reuses
// them across every step, feeds one shared trace, and reads each member's live
// state via dump() -- the SINGLE honest source (D22.1). It NEVER re-implements a
// member's mechanics.
//
// This module imports ONLY ../Lru.js, so it loads unchanged in the browser
// (demo/visuals.html). The Node-main block (npm run demo) DYNAMICALLY imports
// benchmark/Bench.mjs + node:url, guarded by `typeof process`, so that path never
// runs in the browser (Bench.mjs imports node:url, which the browser cannot
// resolve -- D22.4).
//
// Repo-only dev artifact; NEVER shipped in the npm tarball (D22.3).

import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu } from '../Lru.js';

/** The nine family members, in the roster order Bench.mjs uses (so a demo run and
 *  a bench run line up member-for-member). Each is constructed once per engine. */
export const MEMBER_DEFS = [
    { name: 'LiteLru', ctor: LiteLru },
    { name: 'Sieve', ctor: Sieve },
    { name: 'S3Fifo', ctor: S3Fifo },
    { name: 'WTinyLfu', ctor: WTinyLfu },
    { name: 'Slru', ctor: Slru },
    { name: 'TwoQ', ctor: TwoQ },
    { name: 'Arc', ctor: Arc },
    { name: 'Lirs', ctor: Lirs },
    { name: 'Lfu', ctor: Lfu },
];

export const MEMBER_NAMES = MEMBER_DEFS.map((d) => d.name);

/** Result codes for one member on one step (reused, never allocated per step). */
export const MISS = 0;
export const HIT = 1;

/** A fixed clock for the demo. The demo never uses TTL, so `_exp` is null and this
 *  clock is only ever read by dump() to stamp `t`. Pinning it to 0 makes every
 *  snapshot's `t` stable, so a snapshot compares equal to a re-dump and frames are
 *  fully deterministic (same seed -> same frames). Date.now() would make `t` vary
 *  between two dumps of the same state and between frames. */
const FIXED_CLOCK = () => 0;

/** Construct one fresh instance of every member at `cap`, stats ON so the live
 *  hit/miss counters are read from the member itself (not a shadow tally), and a
 *  FIXED clock so dump().t is stable (the demo has no TTL, so a constant clock is
 *  harmless). The returned map is reused for the engine's whole life -- no per-step
 *  allocation. */
export function makeMembers(cap) {
    const members = {};
    for (let i = 0; i < MEMBER_DEFS.length; i++) {
        const d = MEMBER_DEFS[i];
        members[d.name] = new d.ctor(cap, { stats: true, clock: FIXED_CLOCK });
    }
    return members;
}

/**
 * Build a visualization engine over a trace + its Belady OPT.
 *
 * @param {{trace:number[], cap:number, opt:{hits:number,misses:number,hitRate:number},
 *          kind?:string, seed?:number}} spec  trace + OPT (from serve.mjs / Bench.mjs)
 */
export function createEngine(spec) {
    const trace = spec.trace;
    const cap = spec.cap;
    if (!Array.isArray(trace)) throw new TypeError('[demo] engine spec.trace must be an array');
    if (!Number.isInteger(cap) || cap < 1) throw new RangeError('[demo] engine spec.cap must be an integer >= 1');
    if (spec.opt === null || typeof spec.opt !== 'object') throw new TypeError('[demo] engine spec.opt must be a Belady OPT result');

    // The per-step hit/miss verdict, reused across every step (fixed shape, one
    // slot per member) so step() allocates nothing.
    const verdict = {};
    for (let i = 0; i < MEMBER_NAMES.length; i++) verdict[MEMBER_NAMES[i]] = MISS;

    return {
        kind: spec.kind === undefined ? 'custom' : spec.kind,
        seed: spec.seed === undefined ? 0 : spec.seed,
        cap,
        trace,
        opt: spec.opt,
        members: makeMembers(cap),
        index: 0,
        lastKey: -1,
        verdict,
    };
}

/**
 * Apply the next trace op to EVERY member and advance. The replay is identical to
 * Bench.mjs measureRatio: get(key); a hit stops there (recency updated by the
 * member), a miss inserts put(key, key). Returns false once the trace is exhausted.
 * Zero allocation per step: the members are reused and the verdict object is reused.
 */
export function step(engine) {
    if (engine.index >= engine.trace.length) return false;
    const k = engine.trace[engine.index];
    const members = engine.members;
    const verdict = engine.verdict;
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        const m = members[name];
        const v = m.get(k);
        if (v === undefined) { m.put(k, k); verdict[name] = MISS; }
        else verdict[name] = HIT;
    }
    engine.lastKey = k;
    engine.index++;
    return true;
}

/** Run the whole trace through the engine (headless). Returns the step count. */
export function runToEnd(engine) {
    let n = 0;
    while (step(engine)) n++;
    return n;
}

/**
 * The current frame model the renderers consume: the index just applied, its key,
 * the per-member hit/miss verdict, and each member's LIVE snapshot via dump(). The
 * snapshot IS the render model (D22.1) -- no field is added. dump() is COLD and MAY
 * allocate; this is a render-time call, not a hot-path step.
 */
export function frameModel(engine) {
    const members = {};
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        members[name] = engine.members[name].dump();
    }
    return {
        index: engine.index,
        key: engine.lastKey,
        verdict: engine.verdict,
        members,
    };
}

/**
 * Per-member live hit ratio + % of Belady optimal. Hits/misses come from the
 * member's own stats() holder (not a shadow tally). pctOptimal is
 * 100 * memberHitRate / opt.hitRate (D22 assertion 3).
 */
export function summary(engine) {
    const opt = engine.opt;
    const out = [];
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        const s = engine.members[name].stats();
        const total = s.hits + s.misses;
        const hitRate = total ? s.hits / total : 0;
        // Fail closed on an all-miss trace (opt.hitRate === 0): "% of optimal" is
        // undefined, so report 0, never 100 -- "null is not zero" (a member cannot
        // be 100% of an optimum that itself scored zero hits).
        const pctOptimal = opt.hitRate ? (100 * hitRate) / opt.hitRate : 0;
        out.push({ name, hits: s.hits, misses: s.misses, hitRate, pctOptimal });
    }
    return out;
}

/* -------------------------------------------------------------------------- *
 * Trace loading (browser). The /trace.json route is DYNAMIC (computed by
 * demo/serve.mjs), so it exists ONLY under the Node server. Opened as a static
 * file, via an IDE static preview (WebStorm et al.), or with the server down,
 * the fetch REJECTS or returns a non-OK status. We fail CLOSED with an
 * actionable, dependency-free message instead of hanging on "loading..." (S15).
 * -------------------------------------------------------------------------- */

/** The actionable message shown when /trace.json cannot be loaded. Rendered into
 *  the status area in place of "loading...". ASCII-only, no dependency. */
export const TRACE_SERVER_HINT =
    'This demo needs its Node server. Run  npm run demo:serve  and open  ' +
    'http://localhost:8013/  (a static file or IDE preview will not work: ' +
    '/trace.json is a dynamic route).';

/**
 * Fetch a trace payload, failing CLOSED. Never throws. Returns
 * `{ ok:true, data }` on a 2xx JSON body, or `{ ok:false, message }` on a
 * rejected fetch, a non-OK status, or a server-reported `{ error }` body -- the
 * message is the actionable hint with the underlying detail appended. `fetchImpl`
 * defaults to the global `fetch` so a test can inject a stub.
 *
 * @param {string} url
 * @param {(url:string)=>Promise<any>} [fetchImpl]
 * @returns {Promise<{ok:true,data:any}|{ok:false,message:string}>}
 */
export async function fetchTrace(url, fetchImpl) {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (f === null) return { ok: false, message: TRACE_SERVER_HINT + '  [no fetch available]' };
    try {
        const resp = await f(url);
        if (!resp || !resp.ok) throw new Error('server ' + (resp ? resp.status : 'unreachable'));
        const data = await resp.json();
        if (data && data.error) throw new Error(data.error);
        // Fail closed on a well-formed HTTP 200 whose BODY is the wrong shape: ok:true
        // must guarantee createEngine can consume it (an array `trace`, an integer cap
        // >= 1, and an `opt` with a numeric hitRate -- exactly serveTrace's payload).
        // Otherwise the caller would build an engine that throws, and the page would
        // hang on "loading..." -- the very failure S15 exists to prevent.
        if (data === null || typeof data !== 'object' ||
            !Array.isArray(data.trace) ||
            !Number.isInteger(data.cap) || data.cap < 1 ||
            data.opt === null || typeof data.opt !== 'object' ||
            typeof data.opt.hitRate !== 'number') {
            return { ok: false, message: TRACE_SERVER_HINT + '  [malformed trace payload]' };
        }
        return { ok: true, data };
    } catch (err) {
        const detail = err && err.message ? String(err.message) : String(err);
        return { ok: false, message: TRACE_SERVER_HINT + '  [' + detail + ']' };
    }
}

/* -------------------------------------------------------------------------- *
 * Node-main: npm run demo. DYNAMICALLY imports Bench.mjs + node:url so the
 * browser (which has no `process`) never touches the node:url path (D22.4).
 * -------------------------------------------------------------------------- */

async function main() {
    const { pathToFileURL } = await import('node:url');
    if (!process.argv[1] || import.meta.url !== pathToFileURL(process.argv[1]).href) return;

    const bench = await import('../benchmark/Bench.mjs');

    // Defaults: a skewed (zipf) trace, the workload where recency/frequency policies
    // earn their keep. Overridable: node demo/Visualize.mjs <kind> <cap> <length> <seed>
    const kind = process.argv[2] || 'zipf';
    const cap = Number(process.argv[3]) || 64;
    const length = Number(process.argv[4]) || 20000;
    const seed = Number(process.argv[5]) || 0x9e3779b9;

    const trace = buildNodeTrace(bench, kind, cap, length, seed);
    const opt = bench.beladyOpt(trace, cap);
    const engine = createEngine({ trace, cap, opt, kind, seed });
    runToEnd(engine);

    const rows = summary(engine);
    const line = (s) => process.stdout.write(s + '\n');
    line('@zakkster/lite-lru demo  (dump()-driven visualization engine, headless)');
    line('kind=' + kind + '  cap=' + cap + '  ops=' + length + '  seed=0x' + (seed >>> 0).toString(16));
    line('Belady OPT hit%=' + (opt.hitRate * 100).toFixed(1));
    line('');
    line(pad('policy', 10) + padLeft('hit%', 8) + padLeft('%OPT', 8));
    line('-'.repeat(26));
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        line(pad(r.name, 10) + padLeft((r.hitRate * 100).toFixed(1), 8) + padLeft(r.pctOptimal.toFixed(1), 8));
    }
}

/** Build a trace via Bench.mjs generators, mirroring Bench.defaultWorkloads params
 *  so a demo run and a bench run agree. Node-only (Bench is imported dynamically). */
function buildNodeTrace(bench, kind, cap, length, seed) {
    if (kind === 'zipf') return bench.zipfTrace({ length, keyspace: cap * 16, exponent: 1.0, seed: seed ^ 0x11 });
    if (kind === 'loop') return bench.loopTrace({ length, span: cap * 4 });
    if (kind === 'scan') return bench.scanTrace({ length, hotSize: (cap >> 1) || 1, hotFraction: 0.5, seed: seed ^ 0x22 });
    if (kind === 'uniform') {
        const prng = bench.makePrng(seed);
        const keyspace = cap * 4;
        const trace = new Array(length);
        for (let i = 0; i < length; i++) trace[i] = prng() % keyspace;
        return trace;
    }
    throw new Error('[demo] unknown trace kind ' + String(kind) + " (zipf|loop|scan|uniform)");
}

function pad(s, w) { s = String(s); return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padLeft(s, w) { s = String(s); return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

if (typeof process !== 'undefined' && process.argv) {
    main();
}
