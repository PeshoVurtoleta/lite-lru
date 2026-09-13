// @zakkster/lite-lru -- demo assertions (S13, decisions/0022).
//
//   node --test demo/Demo.test.mjs          (green)
//   node --expose-gc --test demo/Demo.test.mjs  (adds the heap-bound checks)
//
// Dev-only: NOT part of the shipped test/ suite that `npm test` runs (demo/ never
// ships). Proves the demo cannot lie -- every member is drawn strictly from dump(),
// the live hit ratios match a from-scratch replay, and the shipped surface is
// untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro } from '../Lru.js';
import { zipfTrace, loopTrace, scanTrace, beladyOpt } from '../benchmark/Bench.mjs';
import {
    createEngine, step, runToEnd, frameModel, summary,
    MEMBER_NAMES, MEMBER_DEFS, fetchTrace, TRACE_SERVER_HINT,
} from './Visualize.mjs';
import { RENDERERS, RENDERED_MEMBERS, BASE_FIELDS } from './renderers.mjs';
import { serveTrace, handle } from './serve.mjs';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(DEMO_DIR);

const CTORS = { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro };

function makeSpec(cap, length, seed) {
    const trace = zipfTrace({ length, keyspace: cap * 16, exponent: 1.0, seed: seed ^ 0x11 });
    const opt = beladyOpt(trace, cap);
    return { trace, opt, cap, kind: 'zipf', seed };
}

/** A from-scratch replay through a fresh instance, identical to Bench.measureRatio /
 *  the engine's step (get; miss -> put(k,k)). Returns { hits, misses }. */
function replay(Ctor, trace, cap) {
    const c = new Ctor(cap, { stats: true });
    let hits = 0, misses = 0;
    for (let i = 0; i < trace.length; i++) {
        const k = trace[i];
        if (c.get(k) === undefined) { c.put(k, k); misses++; }
        else hits++;
    }
    return { hits, misses };
}

test('every engine member has a renderer (no member silently unrendered)', () => {
    assert.deepEqual([...MEMBER_NAMES].sort(), [...RENDERED_MEMBERS].sort());
    assert.equal(MEMBER_DEFS.length, 10);
});

test('assertion 1: rendered model deep-equals dump() over >= 2000 ops, all 8 (0 shadow fields)', () => {
    const cap = 32;
    const spec = makeSpec(cap, 2500, 1);
    const engine = createEngine(spec);

    // Check at several points across the run so the equality holds continuously,
    // not just at the end.
    const checkpoints = new Set([500, 1200, 2000, spec.trace.length]);
    let steps = 0;
    while (step(engine)) {
        steps++;
        if (checkpoints.has(steps)) {
            // The frame model is the ONE source: capture each member's snapshot ONCE
            // (frameModel calls dump() per member), then build the renderer model from
            // THAT SAME snapshot object and assert equality against it. Comparing two
            // independent dump() calls would be flaky -- each stamps t: clock(), so a
            // ms tick between calls would differ (belt to the fixed-clock suspenders).
            const frame = frameModel(engine);
            for (let i = 0; i < MEMBER_NAMES.length; i++) {
                const name = MEMBER_NAMES[i];
                const snap = frame.members[name];
                const model = RENDERERS[name].model(snap);
                assert.deepStrictEqual(model, snap, name + ' model must equal its own snapshot (0 shadow fields)');
            }
        }
    }
    assert.ok(steps >= 2000, 'exercised >= 2000 ops, got ' + steps);
});

test('assertion 1b: a renderer that drops or invents a field fails the deep-equal', () => {
    const cap = 16;
    const spec = makeSpec(cap, 300, 7);
    const engine = createEngine(spec);
    runToEnd(engine);
    const snap = engine.members.Sieve.dump();
    // Drop a field (hand) -> missing key -> not equal.
    const dropped = { ...RENDERERS.Sieve.model(snap) };
    delete dropped.hand;
    assert.notDeepStrictEqual(dropped, snap);
    // Invent a field -> extra key -> not equal.
    const invented = { ...RENDERERS.Sieve.model(snap), shadow: 123 };
    assert.notDeepStrictEqual(invented, snap);
});

test('assertion 2: live hits/misses == from-scratch replay, 0 divergences over >= 2000 ops, all 8', () => {
    const cap = 32;
    const spec = makeSpec(cap, 2400, 3);
    const engine = createEngine(spec);
    runToEnd(engine);
    assert.ok(spec.trace.length >= 2000);
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        const live = engine.members[name].stats();
        const ref = replay(CTORS[name], spec.trace, cap);
        assert.equal(live.hits, ref.hits, name + ' hits diverged');
        assert.equal(live.misses, ref.misses, name + ' misses diverged');
        assert.equal(live.hits + live.misses, spec.trace.length, name + ' total != ops');
    }
});

test('assertion 3: pctOptimal === 100 * memberHitRate / beladyOpt.hitRate (|delta| <= 1e-12)', () => {
    const cap = 32;
    const spec = makeSpec(cap, 3000, 5);
    const engine = createEngine(spec);
    runToEnd(engine);
    const rows = summary(engine);
    const opt = beladyOpt(spec.trace, cap);
    assert.equal(rows.length, 10);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const expected = opt.hitRate ? (100 * r.hitRate) / opt.hitRate : 0;
        assert.ok(Math.abs(r.pctOptimal - expected) <= 1e-12, r.name + ' pctOptimal off by ' + Math.abs(r.pctOptimal - expected));
    }
});

test('assertion 4: >= 10k steps at cap 32 reuse instances and grow no backing arrays', () => {
    const cap = 32;
    const spec = makeSpec(cap, 10000, 9);
    const engine = createEngine(spec);

    // Snapshot instance identities + typed-array backing sizes BEFORE the run.
    const refs = {};
    const bytes = {};
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        const m = engine.members[name];
        refs[name] = m;
        bytes[name] = m._next.buffer.byteLength; // the intrusive link column every member caches
    }

    let heapBefore = 0;
    if (typeof global.gc === 'function') { global.gc(); heapBefore = process.memoryUsage().heapUsed; }

    let steps = 0;
    while (step(engine)) steps++;
    assert.ok(steps >= 10000, 'ran >= 10k steps, got ' + steps);

    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        assert.equal(engine.members[name], refs[name], name + ' instance was replaced (must be reused)');
        assert.equal(engine.members[name]._next.buffer.byteLength, bytes[name], name + ' link column grew');
    }

    if (typeof global.gc === 'function') {
        global.gc();
        const heapAfter = process.memoryUsage().heapUsed;
        // The step loop reuses instances + the verdict object; it must not retain per
        // step. Allow generous slack for interpreter noise, but not linear growth
        // (10k steps x 8 members would blow a tight bound if anything accumulated).
        const grown = heapAfter - heapBefore;
        assert.ok(grown < 2 * 1024 * 1024, 'heap grew ' + grown + ' B across 10k steps (retention?)');
    }
});

test('assertion 5a: 256 build/run/reset cycles leak nothing', () => {
    const cap = 32;
    const spec = makeSpec(cap, 400, 11);
    let heapBefore = 0;
    if (typeof global.gc === 'function') { global.gc(); heapBefore = process.memoryUsage().heapUsed; }
    for (let c = 0; c < 256; c++) {
        const engine = createEngine({ trace: spec.trace, cap, opt: spec.opt, kind: 'zipf', seed: 11 });
        runToEnd(engine);
        for (let i = 0; i < MEMBER_NAMES.length; i++) engine.members[MEMBER_NAMES[i]].clear();
        // engine drops out of scope here -- nothing outside holds it.
    }
    if (typeof global.gc === 'function') {
        global.gc();
        const grown = process.memoryUsage().heapUsed - heapBefore;
        assert.ok(grown < 4 * 1024 * 1024, '256 cycles grew heap ' + grown + ' B (leak?)');
    } else {
        assert.ok(true, '(run with --expose-gc for the heap-bound check)');
    }
});

// NOTE (QA re-scope, reviewer nit 1): this used to run `git diff --stat` for
// Lru.js/Lru.d.ts/benchmark/Bench.mjs against the LIVE working tree. That is only
// sound in total isolation -- the instant a member session (e.g. S16's LIRS) has its
// own legitimate, additive, uncommitted edits to those SAME files in flight, the same
// diff trips and this dev-only demo check false-fails on every member session, not
// just on an actual demo regression. git has no way to attribute PART of one file's
// diff to "the demo" vs. "the concurrent member session" -- there is no clean
// line-range split -- so a committed-baseline comparison cannot be scoped correctly
// either (a baseline commit is always EITHER before the member session, in which case
// its own edits still show up in the diff, OR after it, in which case there is no
// separate baseline to compare against). So instead of diffing file CONTENT, this
// checks the thing the assertion actually cares about STRUCTURALLY: the demo layer
// must only ever CONSUME the shipped surface (a static `import` of '../Lru.js' /
// '../benchmark/Bench.mjs'), never open one of those paths for writing. That still
// catches a demo that "improperly edits Lru.js" (e.g. a demo script that patches the
// member file to make its own rendering simpler), and -- unlike a live git diff -- it
// is completely immune to concurrent, legitimate member-session edits to Lru.js
// itself, since it never inspects file content, only demo SOURCE for write intent.
test('assertion 5b: demo source never opens the shipped surface (Lru.js/Lru.d.ts/Bench.mjs) for writing', () => {
    const demoFiles = readdirSync(DEMO_DIR).filter(
        (f) => (f.endsWith('.mjs') || f.endsWith('.js')) && f !== 'Demo.test.mjs'
    );
    assert.ok(demoFiles.length > 0, 'no demo source files found to scan (setup invalid)');
    const WRITE_CALL = /writeFile(Sync)?|createWriteStream|appendFile(Sync)?|\bwriteFileSync\b/g;
    const SHIPPED_PATH_HINT = /Lru\.(js|d\.ts)|Bench\.mjs/;
    for (const f of demoFiles) {
        const src = readFileSync(join(DEMO_DIR, f), 'utf8');
        for (const m of src.matchAll(WRITE_CALL)) {
            const around = src.slice(Math.max(0, m.index - 200), m.index + 200);
            assert.ok(!SHIPPED_PATH_HINT.test(around),
                f + ' contains a filesystem write near a shipped-surface path token (' + m[0] +
                ') -- demo must never edit Lru.js/Lru.d.ts/Bench.mjs');
        }
    }
});

/* ============================================================================
 * QA gap-closure pass (S13, reviewer-APPROVED build). Everything below pins a
 * coverage gap the planner's assertions did not already exercise. Each test is
 * written so a deliberately broken variant (documented inline) fails it.
 * ========================================================================== */

/** Assert a renderer's model deep-equals the SAME dump() snapshot object, for
 *  every member named in `names`, given ONE frame captured from `engine`. */
function assertAllModelsMatch(engine, names, label) {
    const frame = frameModel(engine);
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const snap = frame.members[name];
        const model = RENDERERS[name].model(snap);
        assert.deepStrictEqual(model, snap, label + ': ' + name + ' model != dump()');
    }
    return frame;
}

test('gap: degenerate capacities 1..4 -- all 8 members render without throwing, model==dump', () => {
    for (const cap of [1, 2, 3, 4]) {
        const trace = zipfTrace({ length: 400, keyspace: cap * 16, exponent: 1.0, seed: 0xC0FFEE ^ cap });
        const opt = beladyOpt(trace, cap);
        const engine = createEngine({ trace, cap, opt, kind: 'zipf', seed: cap });
        assert.doesNotThrow(() => runToEnd(engine), 'cap=' + cap + ' threw during runToEnd');
        assertAllModelsMatch(engine, MEMBER_NAMES, 'cap=' + cap);
    }
    // Teeth: a renderer that mis-handles an empty/singleton list (e.g. reads slots[1]
    // unconditionally) would throw or desync at cap=1 above -- this loop catches it;
    // dropping the cap===1 iteration from the array would silently lose that coverage.
});

test('gap: all three trace kinds (zipf/loop/scan) exercise assertion 1 for all 8 members', () => {
    const cap = 24;
    const kinds = {
        zipf: () => zipfTrace({ length: 1500, keyspace: cap * 16, exponent: 1.0, seed: 0x1a }),
        loop: () => loopTrace({ length: 1500, span: cap * 4 }),
        scan: () => scanTrace({ length: 1500, hotSize: (cap >> 1) || 1, hotFraction: 0.5, seed: 0x2b }),
    };
    for (const [kind, build] of Object.entries(kinds)) {
        const trace = build();
        const opt = beladyOpt(trace, cap);
        const engine = createEngine({ trace, cap, opt, kind });
        runToEnd(engine);
        assertAllModelsMatch(engine, MEMBER_NAMES, kind);
    }
});

test('gap: renderer teeth across ALL 8 members -- dropping or inventing ANY declared field fails', () => {
    const cap = 20;
    const trace = zipfTrace({ length: 800, keyspace: cap * 16, exponent: 1.0, seed: 0x77 });
    const opt = beladyOpt(trace, cap);
    const engine = createEngine({ trace, cap, opt, kind: 'zipf', seed: 0x77 });
    runToEnd(engine);
    const frame = frameModel(engine);
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        const snap = frame.members[name];
        const renderer = RENDERERS[name];
        const good = renderer.model(snap);
        assert.deepStrictEqual(good, snap, name + ' baseline model should match before mutation');

        // Drop each member-specific field one at a time: a silently unrendered field.
        for (let j = 0; j < renderer.fields.length; j++) {
            const broken = { ...good };
            delete broken[renderer.fields[j]];
            assert.notDeepStrictEqual(broken, snap, name + ': dropping "' + renderer.fields[j] + '" must fail deep-equal');
        }
        // Drop a BASE field too (every renderer is supposed to carry the shared base).
        const brokenBase = { ...good };
        delete brokenBase[BASE_FIELDS[0]];
        assert.notDeepStrictEqual(brokenBase, snap, name + ': dropping base field "' + BASE_FIELDS[0] + '" must fail deep-equal');

        // Invent a field dump() never emitted.
        const invented = { ...good, __shadow: 'nope' };
        assert.notDeepStrictEqual(invented, snap, name + ': inventing a field must fail deep-equal');
    }
});

test('gap: pctOptimal fail-closed on an all-distinct (never-repeating) trace -- opt.hitRate===0 forces every member to 0', () => {
    const cap = 8;
    // Strictly increasing distinct keys: no key ever repeats, so NO policy (nor OPT)
    // can ever hit. opt.hitRate must be exactly 0.
    const trace = [];
    for (let i = 0; i < 500; i++) trace.push(i);
    const opt = beladyOpt(trace, cap);
    assert.equal(opt.hitRate, 0, 'fixture invalid: opt.hitRate must be 0 for an all-distinct trace');
    const engine = createEngine({ trace, cap, opt, kind: 'custom' });
    runToEnd(engine);
    const rows = summary(engine);
    assert.equal(rows.length, 10);
    for (let i = 0; i < rows.length; i++) {
        assert.equal(rows[i].hitRate, 0, rows[i].name + ' should also have hitRate 0 on an all-distinct trace');
        // Teeth: the naive formula 100*hitRate/opt.hitRate is 0/0 = NaN here. A
        // regression that removed the `opt.hitRate ?` guard would produce NaN, not 0.
        assert.equal(rows[i].pctOptimal, 0, rows[i].name + ' pctOptimal must fail closed to 0, never NaN/100');
        assert.ok(Number.isFinite(rows[i].pctOptimal), rows[i].name + ' pctOptimal must be finite');
    }
});

test('gap: pctOptimal on a trivially-perfect trace (single repeated key, opt.hitRate>0) matches the live formula', () => {
    const cap = 4;
    const trace = new Array(300).fill(1); // one miss, then every access hits for every policy
    const opt = beladyOpt(trace, cap);
    assert.ok(opt.hitRate > 0, 'fixture invalid: expected opt.hitRate > 0');
    const engine = createEngine({ trace, cap, opt, kind: 'custom' });
    runToEnd(engine);
    const rows = summary(engine);
    for (let i = 0; i < rows.length; i++) {
        const expected = (100 * rows[i].hitRate) / opt.hitRate;
        assert.ok(Math.abs(rows[i].pctOptimal - expected) <= 1e-12, rows[i].name + ' formula mismatch on the non-fail-closed branch');
        assert.ok(rows[i].pctOptimal > 0, rows[i].name + ' should be > 0% of optimal on a hit-rich trace');
    }
});

test('gap: determinism -- same seed/kind/cap builds byte-identical traces and identical frame sequences', () => {
    const cap = 16;
    const specA = makeSpec(cap, 900, 42);
    const specB = makeSpec(cap, 900, 42);
    assert.deepStrictEqual(specA.trace, specB.trace, 'same seed must build the same trace');

    // Feed the SAME trace/opt into two independently-constructed engines and walk
    // them in lockstep: under the fixed clock every dump() at step i must match.
    const engineA = createEngine({ trace: specA.trace, cap, opt: specA.opt, kind: 'zipf', seed: 42 });
    const engineB = createEngine({ trace: specA.trace, cap, opt: specA.opt, kind: 'zipf', seed: 42 });
    const checkpoints = new Set([1, 50, 400, 900]);
    let n = 0;
    let okA = true, okB = true;
    while (okA || okB) {
        okA = step(engineA);
        okB = step(engineB);
        n++;
        assert.equal(okA, okB, 'the two engines diverged in trace length at step ' + n);
        if (!okA) break;
        if (checkpoints.has(n)) {
            const frameA = frameModel(engineA);
            const frameB = frameModel(engineB);
            for (let i = 0; i < MEMBER_NAMES.length; i++) {
                const name = MEMBER_NAMES[i];
                assert.deepStrictEqual(frameA.members[name], frameB.members[name],
                    name + ' frame diverged at step ' + n + ' (determinism broken)');
            }
        }
    }
});

test('gap: keys:"int" backing smoke -- renderer model still deep-equals dump() for all 8 members', () => {
    const cap = 12;
    const trace = zipfTrace({ length: 600, keyspace: cap * 16, exponent: 1.0, seed: 0x5a });
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        const m = new CTORS[name](cap, { stats: true, clock: () => 0, keys: 'int' });
        for (let j = 0; j < trace.length; j++) {
            const k = trace[j];
            if (m.get(k) === undefined) m.put(k, k);
        }
        const snap = m.dump();
        assert.equal(snap.keys, 'int', name + ': dump() must report the int backing');
        const model = RENDERERS[name].model(snap);
        assert.deepStrictEqual(model, snap, name + ' (int backing) model != dump()');
    }
});

test('gap: createEngine boundary matrix -- 0, negative, non-integer, NaN cap and bad trace/opt all fail closed', () => {
    const validOpt = { hits: 0, misses: 1, hitRate: 0 };
    assert.throws(() => createEngine({ trace: [1], cap: 0, opt: validOpt }), RangeError, 'cap=0 must throw');
    assert.throws(() => createEngine({ trace: [1], cap: -1, opt: validOpt }), RangeError, 'cap=-1 must throw');
    assert.throws(() => createEngine({ trace: [1], cap: 1.5, opt: validOpt }), RangeError, 'cap=1.5 (non-integer) must throw');
    assert.throws(() => createEngine({ trace: [1], cap: NaN, opt: validOpt }), RangeError, 'cap=NaN must throw');
    assert.throws(() => createEngine({ trace: [1], cap: -0, opt: validOpt }), RangeError, 'cap=-0 must throw (Number.isInteger(-0) is true but -0 < 1)');
    assert.throws(() => createEngine({ trace: 'not-an-array', cap: 4, opt: validOpt }), TypeError, 'non-array trace must throw');
    assert.throws(() => createEngine({ trace: [1], cap: 4, opt: null }), TypeError, 'null opt must throw');
    assert.throws(() => createEngine({ trace: [1], cap: 4, opt: undefined }), TypeError, 'undefined opt must throw');
    // N/N+1/empty: cap === trace length, cap one past it, and an empty trace must all
    // construct cleanly and run to completion without throwing.
    assert.doesNotThrow(() => runToEnd(createEngine({ trace: [1, 2, 3], cap: 3, opt: validOpt })), 'cap==trace.length (N) must not throw');
    assert.doesNotThrow(() => runToEnd(createEngine({ trace: [1, 2, 3], cap: 4, opt: validOpt })), 'cap==trace.length+1 (N+1) must not throw');
    const emptyEngine = createEngine({ trace: [], cap: 4, opt: validOpt });
    assert.equal(runToEnd(emptyEngine), 0, 'an empty trace runs 0 steps');
});

test('gap: step() past trace end is idempotent (duplicate "dispose"-style calls do not corrupt engine state)', () => {
    const cap = 6;
    const spec = makeSpec(cap, 30, 99);
    const engine = createEngine(spec);
    runToEnd(engine);
    const indexAfter = engine.index;
    const frameAfter = frameModel(engine);
    for (let i = 0; i < 50; i++) {
        assert.equal(step(engine), false, 'step() past the end must keep returning false');
    }
    assert.equal(engine.index, indexAfter, 'index must not advance past trace.length');
    const frameNow = frameModel(engine);
    for (let i = 0; i < MEMBER_NAMES.length; i++) {
        const name = MEMBER_NAMES[i];
        assert.deepStrictEqual(frameNow.members[name], frameAfter.members[name], name + ': repeated post-end step() must not mutate state');
    }
});

/* ---------------------------- demo/serve.mjs ------------------------------ */

/** A minimal mock response so handle() can be driven without an actual socket. */
function mockRes() {
    const res = {
        statusCode: 0,
        headers: {},
        chunks: [],
        writeHead(code, hdrs) { res.statusCode = code; if (hdrs) Object.assign(res.headers, hdrs); },
        end(body) { if (body !== undefined) res.chunks.push(body); res.ended = true; },
    };
    return res;
}

async function drive(url) {
    const res = mockRes();
    await handle({ url }, res);
    return res;
}

test('gap: serveTrace fails closed on bad kind/cap/length (adversarial inputs)', () => {
    assert.throws(() => serveTrace('bogus-kind', 1, 8, 100), /unknown trace kind/);
    assert.throws(() => serveTrace('zipf', 1, 0, 100), RangeError, 'cap=0 must be rejected');
    assert.throws(() => serveTrace('zipf', 1, -3, 100), RangeError, 'negative cap must be rejected');
    assert.throws(() => serveTrace('zipf', 1, 1.5, 100), RangeError, 'non-integer cap must be rejected');
    assert.throws(() => serveTrace('zipf', 1, NaN, 100), RangeError, 'NaN cap must be rejected');
    assert.throws(() => serveTrace('zipf', 1, 8, 0), RangeError, 'length=0 must be rejected');
    assert.throws(() => serveTrace('zipf', 1, 8, -5), RangeError, 'negative length must be rejected');
    assert.throws(() => serveTrace('zipf', 1, 8, NaN), RangeError, 'NaN length must be rejected');
    // Boundary N=1 must be accepted (the smallest legal cap/length).
    assert.doesNotThrow(() => serveTrace('zipf', 1, 1, 1));
    // seed=0 must fail CLOSED to a stable non-zero seed (>>>0 || 1), never seed 0
    // (an all-zero xorshift32 state would never advance).
    const a = serveTrace('uniform', 0, 4, 20);
    const b = serveTrace('uniform', 0, 4, 20);
    assert.equal(a.seed, 1, 'seed=0 must normalize to 1, not stay 0');
    assert.deepStrictEqual(a.trace, b.trace, 'normalized seed=0 must still be deterministic');
});

test('gap: /trace.json fails closed (400 + JSON error body) on a bad kind over the actual handler', async () => {
    const res = await drive('/trace.json?kind=nonsense&seed=1&cap=8&length=50');
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.chunks.join(''));
    assert.equal(typeof body.error, 'string');
    assert.match(body.error, /unknown trace kind/);
});

test('gap: /trace.json fails closed on cap=0 and on a negative length over the actual handler', async () => {
    const badCap = await drive('/trace.json?kind=zipf&seed=1&cap=0&length=50');
    assert.equal(badCap.statusCode, 400);
    const badLen = await drive('/trace.json?kind=loop&seed=1&cap=8&length=-1');
    assert.equal(badLen.statusCode, 400);
});

test('gap: /trace.json returns a well-shaped, seed-deterministic payload', async () => {
    const r1 = await drive('/trace.json?kind=scan&seed=7&cap=8&length=200');
    const r2 = await drive('/trace.json?kind=scan&seed=7&cap=8&length=200');
    assert.equal(r1.statusCode, 200);
    const p1 = JSON.parse(r1.chunks.join(''));
    const p2 = JSON.parse(r2.chunks.join(''));
    assert.deepStrictEqual(p1, p2, 'same query must produce a byte-identical payload');
    assert.equal(p1.trace.length, 200);
    assert.equal(typeof p1.opt.hitRate, 'number');
});

test('gap: "/" 302-redirects to /demo/visuals.html (the advertised entry URL is not broken)', async () => {
    // Teeth: an in-place serve of the HTML at "/" (statusCode 200 + text/html) leaves
    // the browser base URL at "/", so the page's relative imports (./Visualize.mjs,
    // ./renderers.mjs) resolve to the repo root and 404. A 302 to the real path makes
    // the base URL /demo/, so they resolve. This test fails against the old behavior.
    const root = await drive('/');
    assert.equal(root.statusCode, 302, '"/" must redirect, not serve HTML in place');
    assert.equal(root.headers.location, '/demo/visuals.html', 'redirect Location must be the page path');

    // Following the redirect lands the real page (base URL now /demo/).
    const page = await drive('/demo/visuals.html');
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'], /text\/html/);

    // And the imports the page makes from /demo/ all resolve 200.
    for (const p of ['/demo/Visualize.mjs', '/demo/renderers.mjs', '/Lru.js']) {
        const src = await drive(p);
        assert.equal(src.statusCode, 200, p + ' must load');
        assert.match(src.headers['content-type'], /javascript/, p + ' must be JS');
    }
});

/* ------------------- fetchTrace: the fail-closed loading state (S15) ------- */

test('S15: a REJECTED /trace.json fetch fails closed with the actionable hint, never throws', async () => {
    // Simulates opening the page as a static file / IDE preview: fetch rejects
    // (no such dynamic route). Must resolve to an actionable message, not throw,
    // and never leave the page on a bare "loading...".
    const reject = () => Promise.reject(new TypeError('Failed to fetch'));
    const result = await fetchTrace('/trace.json?kind=zipf', reject);
    assert.equal(result.ok, false, 'a rejected fetch must fail closed');
    assert.ok(result.message.startsWith(TRACE_SERVER_HINT), 'message must lead with the actionable hint');
    assert.match(result.message, /npm run demo:serve/, 'message must name the command to run');
    assert.match(result.message, /localhost:8013/, 'message must name the URL to open');
    assert.match(result.message, /dynamic route/, 'message must explain WHY a static preview fails');
    assert.notEqual(result.message, 'loading...', 'must not remain on the bare loading state');
    // The underlying detail is appended for debuggability, not a raw stack.
    assert.match(result.message, /Failed to fetch/);
});

test('S15: a non-OK status (e.g. 404 from an IDE static server) fails closed with the hint', async () => {
    // WebStorm's static server on :63342 answers /trace.json with 404 -- resp.ok
    // is false. That is the exact miss S15 fixes.
    const notFound = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    const result = await fetchTrace('/trace.json?kind=zipf', notFound);
    assert.equal(result.ok, false, 'a non-OK status must fail closed');
    assert.ok(result.message.startsWith(TRACE_SERVER_HINT));
    assert.match(result.message, /server 404/, 'the status is surfaced in the detail');
});

test('S15: a 200 with a server-reported {error} body fails closed with the hint', async () => {
    const errBody = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ error: 'bad kind' }) });
    const result = await fetchTrace('/trace.json?kind=bogus', errBody);
    assert.equal(result.ok, false, 'a server-reported error must fail closed');
    assert.ok(result.message.startsWith(TRACE_SERVER_HINT));
    assert.match(result.message, /bad kind/);
});

test('S15: a well-formed 200 payload succeeds and carries the data through (the happy path still works)', async () => {
    const payload = { trace: [1, 2, 3], cap: 4, opt: { hits: 0, misses: 3, hitRate: 0 }, kind: 'zipf', seed: 1 };
    const okFetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    const result = await fetchTrace('/trace.json?kind=zipf', okFetch);
    assert.equal(result.ok, true, 'a good payload must succeed');
    assert.deepStrictEqual(result.data, payload, 'the data must pass through untouched');
    // Teeth: the data must be usable to build an engine (the real caller does this next).
    assert.doesNotThrow(() => createEngine(result.data));
});

test('S15: a 200 with valid JSON but the WRONG SHAPE fails closed (no ok:true, no throw)', async () => {
    // A malformed 200 (valid JSON, no {error}, but missing trace/opt) must NOT pass
    // as ok:true -- otherwise createEngine throws downstream and the page hangs on
    // "loading...". ok:true is contractually a payload createEngine can consume.
    const bodies = [{}, { foo: 1 }, { trace: [1, 2] }, { trace: 'nope', opt: { hitRate: 0 } },
        { trace: [1], opt: null }, { trace: [1], opt: {} }, { trace: [1], cap: 0, opt: { hitRate: 0 } }];
    for (const body of bodies) {
        const ok200 = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        const result = await fetchTrace('/trace.json?kind=zipf', ok200);
        assert.equal(result.ok, false, 'wrong-shape body ' + JSON.stringify(body) + ' must fail closed');
        assert.ok(result.message.startsWith(TRACE_SERVER_HINT));
        assert.match(result.message, /malformed trace payload/);
    }
    // Teeth: the SAME code path with a WELL-shaped body must still succeed (so the
    // shape check is not a blanket reject).
    const good = { trace: [1, 2, 3], cap: 4, opt: { hits: 0, misses: 3, hitRate: 0 }, kind: 'zipf', seed: 1 };
    const okFetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(good) });
    const okResult = await fetchTrace('/trace.json?kind=zipf', okFetch);
    assert.equal(okResult.ok, true, 'a well-shaped body must still pass');
    assert.doesNotThrow(() => createEngine(okResult.data));
});

test('S15: the actionable hint is ASCII-only and names all three fix ingredients', () => {
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x00-\x7F]*$/.test(TRACE_SERVER_HINT), 'hint must be ASCII-only');
    assert.match(TRACE_SERVER_HINT, /npm run demo:serve/);
    assert.match(TRACE_SERVER_HINT, /http:\/\/localhost:8013\//);
    assert.match(TRACE_SERVER_HINT, /dynamic route/);
});

test('gap: static route 404s on a missing file instead of throwing', async () => {
    const res = await drive('/demo/does-not-exist.mjs');
    assert.equal(res.statusCode, 404);
});

test('gap: static route is confined to REPO_ROOT under an encoded-slash traversal attempt (adversarial)', async () => {
    // package-lock.json exists BOTH at REPO_ROOT (name "@zakkster/lite-lru") and one
    // directory above it in the monorepo (name "LiteLibrariesSuite"). If the guard
    // let ".." (or its %2f-encoded form, which the WHATWG URL parser does NOT
    // collapse the way it collapses literal "..") escape REPO_ROOT, this request
    // would come back with the PARENT lockfile's content instead of REPO_ROOT's own
    // (or REPO_ROOT's own package.json is untouched -- 404 for a name that only
    // exists one level up would also prove escape).
    const escaped = await drive('/..%2fpackage-lock.json');
    assert.equal(escaped.statusCode, 200, 'must resolve inside REPO_ROOT, not 403/500');
    const body = JSON.parse(escaped.chunks.join(''));
    assert.equal(body.name, '@zakkster/lite-lru', 'traversal must be confined to REPO_ROOT\'s own package-lock.json');

    const escaped2 = await drive('/demo%2f..%2f..%2fpackage-lock.json');
    assert.equal(escaped2.statusCode, 200);
    const body2 = JSON.parse(escaped2.chunks.join(''));
    assert.equal(body2.name, '@zakkster/lite-lru', 'nested encoded traversal must also stay confined to REPO_ROOT');

    // A request for a name that ONLY exists one level above REPO_ROOT must 404, not 200.
    const outsideOnly = await drive('/..%2f..%2fpackage.json');
    // ROOT itself has its own package.json too, so this just re-confirms confinement:
    // whatever comes back must be REPO_ROOT's own (name @zakkster/lite-lru), never escape.
    assert.equal(outsideOnly.statusCode, 200);
    const body3 = JSON.parse(outsideOnly.chunks.join(''));
    assert.equal(body3.name, '@zakkster/lite-lru', 'deep encoded traversal must still resolve inside REPO_ROOT');
});
