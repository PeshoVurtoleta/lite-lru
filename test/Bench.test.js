/**
 * @zakkster/lite-lru -- node:test boundary suite for the shipped bench surface
 * (Bench.mjs: `beladyOpt`, `runBench`). This is a LIGHTWEIGHT contract/boundary
 * suite, complementary to the heavy differential in
 * test/torture/t8-opt.mjs (beladyOpt vs an independent brute-force OPT, run
 * under `node --expose-gc test/torture.mjs`). It does not repeat that
 * differential; it pins the bench's OWN small, hand-computable cases and its
 * output CONTRACT (shape, ranges, determinism, degenerate inputs) so the
 * shipped tool cannot silently drift.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { beladyOpt, runBench, backingCompare, parseIntTrace, webTrace, ZIPF_ALPHAS } from '../benchmark/Bench.mjs';
import { LiteLru, Sieve } from '../Lru.js';

/* -------------------------------------------------------------------------- *
 * beladyOpt -- hand-computable traces (independent of t8's brute reference;
 * these are worked by hand / by inspection, not by a second implementation).
 * -------------------------------------------------------------------------- */

test('beladyOpt: [1,2,1,2,1,2] cap 2 -> 4 hits (alternating pair fits exactly)', () => {
    const r = beladyOpt([1, 2, 1, 2, 1, 2], 2);
    assert.equal(r.hits, 4);
    assert.equal(r.misses, 2);
    assert.equal(r.hitRate, 4 / 6);
});

test('beladyOpt: [1,1,1,1] cap 1 -> 3 hits (only the first touch misses)', () => {
    const r = beladyOpt([1, 1, 1, 1], 1);
    assert.equal(r.hits, 3);
    assert.equal(r.misses, 1);
});

test('beladyOpt: [1,2,3,4,1,2,3,4] cap 2 -> 2 hits (only 2 of 4 keys fit)', () => {
    const r = beladyOpt([1, 2, 3, 4, 1, 2, 3, 4], 2);
    assert.equal(r.hits, 2);
    assert.equal(r.misses, 6);
});

test('beladyOpt: a never-reused scan (all distinct keys) -> 0 hits, regardless of capacity', () => {
    const trace = [1, 2, 3, 4, 5];
    for (const cap of [1, 3, 5, 10]) {
        const r = beladyOpt(trace, cap);
        assert.equal(r.hits, 0, 'cap=' + cap);
        assert.equal(r.misses, trace.length, 'cap=' + cap);
    }
});

test('beladyOpt: capacity 1 boundary -- a hit requires the SAME key twice in a row', () => {
    // No adjacent repeat anywhere -> every access evicts the sole resident -> 0 hits.
    const noAdjacentRepeat = beladyOpt([1, 2, 1, 2], 1);
    assert.equal(noAdjacentRepeat.hits, 0);
    // Adjacent repeats -> each repeat is a hit.
    const adjacentRepeats = beladyOpt([1, 1, 2, 2, 3, 3], 1);
    assert.equal(adjacentRepeats.hits, 3);
});

test('beladyOpt: capacity >= distinct keys -- every access after first-touch is a hit', () => {
    const trace = [1, 2, 3, 1, 2, 3, 1, 2, 3]; // 3 distinct keys, 9 accesses
    for (const cap of [3, 4, 100]) {
        const r = beladyOpt(trace, cap);
        assert.equal(r.hits, trace.length - 3, 'cap=' + cap + ' (3 first-touch misses, rest hits)');
    }
});

/* -------------------------------------------------------------------------- *
 * beladyOpt -- degenerate inputs, pinned to the CODE'S actual contract (read
 * from Bench.mjs, not invented): empty trace and capacity <= 0 both return a
 * zeroed result object rather than throwing.
 * -------------------------------------------------------------------------- */

test('beladyOpt: empty trace returns { hits:0, misses:0, hitRate:0 } (no throw)', () => {
    const r = beladyOpt([], 4);
    assert.deepEqual(r, { hits: 0, misses: 0, hitRate: 0 });
});

test('beladyOpt: capacity 0 returns { hits:0, misses:n, hitRate:0 } (no throw, fails closed to zero capacity)', () => {
    const r = beladyOpt([1, 2, 3], 0);
    assert.deepEqual(r, { hits: 0, misses: 3, hitRate: 0 });
});

test('beladyOpt: negative capacity behaves identically to capacity 0 (no throw)', () => {
    const r = beladyOpt([1, 2, 3], -1);
    assert.deepEqual(r, { hits: 0, misses: 3, hitRate: 0 });
});

test('beladyOpt: a negative NON-integer capacity ALSO falls back cleanly (the <= 0 door is checked first)', () => {
    const r = beladyOpt([1, 2, 3], -2.5);
    assert.deepEqual(r, { hits: 0, misses: 3, hitRate: 0 });
});

/* -------------------------------------------------------------------------- *
 * beladyOpt -- the fail-CLOSED capacity door (qa TASK 3): NaN, undefined and a
 * non-integer POSITIVE capacity throw a tagged RangeError BEFORE the degenerate
 * capacity<=0 fallback above ever runs (Bench.mjs checks `typeof`/`NaN` first,
 * then non-integer-ness ONLY when capacity > 0 -- a non-integer capacity <= 0
 * still reaches the fallback, per the case above, never this door).
 * -------------------------------------------------------------------------- */

test('beladyOpt: capacity NaN throws a [lite-lru]-tagged RangeError', () => {
    assert.throws(() => beladyOpt([1, 2, 3], NaN), (err) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /\[lite-lru\]/);
        return true;
    });
});

test('beladyOpt: capacity undefined throws a [lite-lru]-tagged RangeError', () => {
    assert.throws(() => beladyOpt([1, 2, 3], undefined), (err) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /\[lite-lru\]/);
        return true;
    });
});

test('beladyOpt: capacity 2.5 (a non-integer > 0) throws a [lite-lru]-tagged RangeError', () => {
    assert.throws(() => beladyOpt([1, 2, 3], 2.5), (err) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /\[lite-lru\]/);
        return true;
    });
});

// qa (final pipeline gap-close, 1.16.0): Infinity is `typeof "number"` and not NaN, so it
// clears the first door, but `Number.isInteger(Infinity) === false` -- it must fall into the
// SAME non-integer-positive-capacity door as 2.5 above, not silently pass through or hang
// building an Int32Array/heap sized off it.
test('beladyOpt: capacity Infinity (a non-integer > 0) throws a [lite-lru]-tagged RangeError, not a hang/OOM', () => {
    assert.throws(() => beladyOpt([1, 2, 3], Infinity), (err) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /\[lite-lru\]/);
        assert.match(err.message, /Infinity/);
        return true;
    });
});

/* -------------------------------------------------------------------------- *
 * beladyOpt -- the optimality bound, mirrored at small scale (t8 proves this
 * at bench scale under torture; this pins the invariant is at least true on a
 * handful of tiny, fast, node:test-friendly traces so a regression here fails
 * loud on `npm test`, not only under `--expose-gc`).
 * -------------------------------------------------------------------------- */

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

test('beladyOpt: hits are within [0, trace.length) and >= each member on small traces', () => {
    const traces = [
        { trace: [1, 2, 1, 2, 1, 2], cap: 2 },
        { trace: [1, 2, 3, 4, 1, 2, 3, 4], cap: 2 },
        { trace: [5, 1, 2, 3, 1, 2, 3, 1, 2, 3, 4], cap: 3 },
        { trace: [1, 1, 1, 1], cap: 1 },
    ];
    for (const { trace, cap } of traces) {
        const opt = beladyOpt(trace, cap).hits;
        assert.ok(opt >= 0 && opt < trace.length, 'opt=' + opt + ' out of [0, ' + trace.length + ')');
        const lru = memberHits(LiteLru, trace, cap);
        const sieve = memberHits(Sieve, trace, cap);
        assert.ok(opt >= lru, 'OPT ' + opt + ' < LiteLru ' + lru + ' on ' + JSON.stringify(trace));
        assert.ok(opt >= sieve, 'OPT ' + opt + ' < Sieve ' + sieve + ' on ' + JSON.stringify(trace));
    }
});

/* -------------------------------------------------------------------------- *
 * runBench -- structural contract on a small, fast configuration (the heavy,
 * realistic-scale numbers are a `node benchmark/Bench.mjs` concern, verified manually;
 * this only pins the SHAPE and RANGES of what runBench returns).
 * -------------------------------------------------------------------------- */

const SMALL = { capacity: 32, length: 4000, seed: 0x2a };

test('runBench: returns a well-formed structure (version/node/arch/config/workloads)', () => {
    const out = runBench(SMALL);
    assert.equal(typeof out.version, 'string');
    assert.equal(typeof out.node, 'string');
    assert.equal(typeof out.arch, 'string');
    assert.deepEqual(out.config, SMALL);
    assert.ok(Array.isArray(out.workloads));
    assert.equal(out.workloads.length, 3); // zipf, loop, scan
    for (const wl of out.workloads) {
        assert.equal(typeof wl.name, 'string');
        assert.equal(wl.capacity, SMALL.capacity);
        assert.equal(wl.ops, SMALL.length);
        assert.equal(typeof wl.opt.hits, 'number');
        assert.ok(Number.isFinite(wl.opt.hitRatio));
        assert.ok(Array.isArray(wl.members));
        assert.equal(wl.members.length, 13);
        const names = wl.members.map((m) => m.name);
        assert.deepEqual(names, ['LiteLru', 'Sieve', 'S3Fifo', 'WTinyLfu', 'Slru', 'TwoQ', 'Arc', 'Lirs', 'Lfu', 'ClockPro', 'LruK', 'Mq', 'Car']);
    }
});

test('runBench: every member reports pctOptimal in [0,100] and hitRatio in [0,1]', () => {
    const out = runBench(SMALL);
    for (const wl of out.workloads) {
        for (const m of wl.members) {
            assert.ok(Number.isFinite(m.pctOptimal), m.name + '.' + wl.name + ' pctOptimal not finite');
            assert.ok(m.pctOptimal >= 0 && m.pctOptimal <= 100,
                m.name + '.' + wl.name + ' pctOptimal=' + m.pctOptimal + ' out of [0,100]');
            assert.ok(Number.isFinite(m.hitRatio), m.name + '.' + wl.name + ' hitRatio not finite');
            assert.ok(m.hitRatio >= 0 && m.hitRatio <= 1,
                m.name + '.' + wl.name + ' hitRatio=' + m.hitRatio + ' out of [0,1]');
            assert.ok(m.writesPerHit >= 0, m.name + '.' + wl.name + ' writesPerHit negative');
        }
    }
});

test('runBench: SIEVE writesPerHit <= LiteLru writesPerHit on the skewed (zipf) workload', () => {
    const out = runBench(SMALL);
    const zipf = out.workloads.find((wl) => wl.name === 'zipf');
    assert.ok(zipf, 'zipf workload present');
    const lru = zipf.members.find((m) => m.name === 'LiteLru');
    const sieve = zipf.members.find((m) => m.name === 'Sieve');
    assert.ok(sieve.hits > 0 && lru.hits > 0, 'both members must register hits for the comparison to be meaningful');
    assert.ok(sieve.writesPerHit <= lru.writesPerHit,
        'Sieve writesPerHit=' + sieve.writesPerHit + ' > LiteLru writesPerHit=' + lru.writesPerHit);
});

test('backingCompare: reports the 3 keyed-index backings with IDENTICAL hit ratios (same policy, decisions/0029)', () => {
    const out = backingCompare({ capacity: 32, length: 4000, seed: 0x2a });
    assert.equal(typeof out.version, 'string');
    assert.equal(out.capacity, 32);
    assert.equal(out.ops, 4000);
    assert.equal(out.maxKey, 32 * 16 - 1);
    assert.ok(Array.isArray(out.rows));
    assert.equal(out.rows.length, 3); // Map (default), keys:'int', keys:'dense'
    assert.deepEqual(out.rows.map((r) => r.backing), ['Map (default)', "keys:'int'", "keys:'dense'"]);
    // The backing is a substrate swap under ONE policy: the hit ratio is identical.
    const h0 = out.rows[0].hitRatio;
    for (const r of out.rows) {
        assert.equal(r.hitRatio, h0, r.backing + ' hitRatio drifted from the Map backing');
        assert.ok(r.hitRatio >= 0 && r.hitRatio <= 1, r.backing + ' hitRatio out of [0,1]');
        assert.ok(Number.isFinite(r.nsPerOp) && r.nsPerOp > 0, r.backing + ' nsPerOp not a positive finite number');
    }
});

test('runBench: deterministic for a fixed seed -- hitRatio/pctOptimal/writesPerHit are IDENTICAL across two runs (nsPerOp is NOT asserted)', () => {
    const a = runBench(SMALL);
    const b = runBench(SMALL);
    assert.equal(a.workloads.length, b.workloads.length);
    for (let i = 0; i < a.workloads.length; i++) {
        const wa = a.workloads[i], wb = b.workloads[i];
        assert.equal(wa.name, wb.name);
        assert.equal(wa.opt.hits, wb.opt.hits);
        assert.equal(wa.opt.hitRatio, wb.opt.hitRatio);
        assert.equal(wa.members.length, wb.members.length);
        for (let j = 0; j < wa.members.length; j++) {
            const ma = wa.members[j], mb = wb.members[j];
            assert.equal(ma.name, mb.name);
            assert.equal(ma.hits, mb.hits);
            assert.equal(ma.misses, mb.misses);
            assert.equal(ma.hitRatio, mb.hitRatio);
            assert.equal(ma.writesPerHit, mb.writesPerHit);
            assert.equal(ma.pctOptimal, mb.pctOptimal);
            // nsPerOp is machine-local wall-clock -- intentionally NOT compared.
        }
    }
});

/* -------------------------------------------------------------------------- *
 * runBench -- degenerate inputs via the `workloads` override, pinned to the
 * CODE'S actual contract (read from Bench.mjs): an empty trace does not throw;
 * pctOptimal falls back to 100 (opt.hits is falsy, per the `opt.hits ? ... :
 * 100` ternary), hitRatio is 0 (0/0 guarded), and nsPerOp is NOT finite
 * (0-length timed loop divides by trace.length === 0).
 * -------------------------------------------------------------------------- */

test('runBench: an empty-trace workload does not throw; pctOptimal=100 (vacuous), hitRatio=0, nsPerOp non-finite', () => {
    const out = runBench({ workloads: [{ name: 'empty', capacity: 4, trace: [] }] });
    assert.equal(out.workloads.length, 1);
    const wl = out.workloads[0];
    assert.equal(wl.ops, 0);
    assert.equal(wl.opt.hits, 0);
    assert.equal(wl.opt.hitRatio, 0);
    for (const m of wl.members) {
        assert.equal(m.hits, 0);
        assert.equal(m.misses, 0);
        assert.equal(m.hitRatio, 0);
        assert.equal(m.writesPerHit, 0);
        assert.equal(m.pctOptimal, 100, m.name + ': vacuous pctOptimal must fall back to 100, not NaN/0');
        assert.ok(!Number.isFinite(m.nsPerOp), m.name + ': nsPerOp over an empty loop must not be finite');
    }
});

test('runBench: a capacity-1 workload does not throw and reports sane, bounded numbers', () => {
    const out = runBench({ workloads: [{ name: 'cap1', capacity: 1, trace: [1, 2, 1, 2, 3, 1] }] });
    const wl = out.workloads[0];
    assert.equal(wl.capacity, 1);
    assert.equal(wl.opt.hits, 0, 'no capacity-1 hit is possible on this trace (no adjacent repeat)');
    for (const m of wl.members) {
        assert.equal(m.hits, 0);
        assert.equal(m.misses, 6);
        assert.equal(m.hitRatio, 0);
        assert.equal(m.pctOptimal, 100, m.name + ': OPT also scored 0 here -- vacuous fallback applies');
        assert.ok(Number.isFinite(m.nsPerOp) && m.nsPerOp >= 0);
    }
});

/* -------------------------------------------------------------------------- *
 * Adversarial case the planner did not think of: a caller-supplied custom
 * `workloads` array with DUPLICATE capacities pointing at the SAME trace array
 * instance, reused across two workload entries. runBench must not mutate the
 * shared trace (each member gets a FRESH cache instance per measurement pass;
 * the trace itself is only ever read) -- both workload entries must report
 * IDENTICAL results even though they alias the same underlying Array.
 * -------------------------------------------------------------------------- */

test('adversarial: two workload entries aliasing the SAME trace array report identical results (no mutation, no cross-talk)', () => {
    const sharedTrace = [1, 2, 3, 1, 2, 4, 1, 5, 1, 2];
    const out = runBench({
        workloads: [
            { name: 'alias-a', capacity: 3, trace: sharedTrace },
            { name: 'alias-b', capacity: 3, trace: sharedTrace },
        ],
    });
    assert.equal(out.workloads.length, 2);
    const [a, b] = out.workloads;
    assert.equal(a.opt.hits, b.opt.hits);
    assert.deepEqual(sharedTrace, [1, 2, 3, 1, 2, 4, 1, 5, 1, 2], 'runBench must not mutate the caller\'s trace array');
    for (let i = 0; i < a.members.length; i++) {
        assert.equal(a.members[i].name, b.members[i].name);
        assert.equal(a.members[i].hits, b.members[i].hits);
        assert.equal(a.members[i].misses, b.members[i].misses);
        assert.equal(a.members[i].writesPerHit, b.members[i].writesPerHit);
        assert.equal(a.members[i].pctOptimal, b.members[i].pctOptimal);
    }
});

/* ============================================================================ *
 * QA: planner ASSERTIONS on the alphas/keyspaceRatio/repeats/loader/webTrace
 * benchmark enhancements. Each block below is one numbered planner assertion.
 * Config sizes are kept as small as each assertion allows -- large enough to be
 * a real measurement, small enough that `npm test` stays fast -- EXCEPT the one
 * explicit full-default-scale call assertion 1 requires, which is deliberately
 * run at the library's real default (capacity 256 / length 200000) and costs
 * several seconds by itself; see the QA report for the measured wall time.
 * ============================================================================ */

const DEFAULT_SEED = 0x9e3779b9;
const SWEEP_CFG = { capacity: 64, length: 20000 };

// Computed ONCE at module load and reused across assertions 1 and 2 (both use
// the identical {capacity:64, length:20000} config with the default seed) to
// avoid re-running the same ~1.2s bench pass twice.
const TRIPWIRE_OUT = runBench(SWEEP_CFG);
const SWEEP_OUT = runBench({ ...SWEEP_CFG, alphas: ZIPF_ALPHAS });

/* -------------------------------------------------------------------------- *
 * ASSERTION 1 -- BACK-COMPAT TRIPWIRE
 * -------------------------------------------------------------------------- */

test('ASSERTION 1: runBench({capacity,length}) returns exactly 3 workloads named [zipf,loop,scan]', () => {
    assert.deepStrictEqual(TRIPWIRE_OUT.workloads.map((w) => w.name), ['zipf', 'loop', 'scan']);
    assert.equal(TRIPWIRE_OUT.workloads.length, 3);
});

test('ASSERTION 1: out.config deepEquals {capacity,length,seed} with EXACTLY 3 keys -- no new knob leaks in', () => {
    assert.deepStrictEqual(TRIPWIRE_OUT.config, { capacity: 64, length: 20000, seed: DEFAULT_SEED });
    assert.deepStrictEqual(Object.keys(TRIPWIRE_OUT.config).sort(), ['capacity', 'length', 'seed']);
    // Explicit negative check: the new knobs must NOT leak into config by any name.
    assert.equal('alphas' in TRIPWIRE_OUT.config, false);
    assert.equal('keyspaceRatio' in TRIPWIRE_OUT.config, false);
    assert.equal('repeats' in TRIPWIRE_OUT.config, false);
});

test('ASSERTION 1: the new knobs live ONLY under out.tuning, with the documented defaults', () => {
    assert.deepStrictEqual(Object.keys(TRIPWIRE_OUT.tuning).sort(), ['alphas', 'keyspaceRatio', 'repeats']);
    assert.deepStrictEqual(TRIPWIRE_OUT.tuning.alphas, [1.0]);
    assert.equal(TRIPWIRE_OUT.tuning.keyspaceRatio, 16);
    assert.equal(TRIPWIRE_OUT.tuning.repeats, 5);
});

test('ASSERTION 1: runBench() with NO options (the real library default, capacity=256/length=200000) still emits exactly [zipf,loop,scan]', () => {
    // Deliberately the full default scale -- this is the actual back-compat
    // tripwire the planner asked for, not a scaled-down stand-in. MEASURED to
    // take several seconds; see the QA report.
    const out = runBench();
    assert.deepStrictEqual(out.workloads.map((w) => w.name), ['zipf', 'loop', 'scan']);
    assert.equal(out.config.capacity, 256);
    assert.equal(out.config.length, 200000);
});

/* -------------------------------------------------------------------------- *
 * ASSERTION 2 -- ALPHA SWEEP
 * -------------------------------------------------------------------------- */

test('ASSERTION 2: runBench({alphas: ZIPF_ALPHAS}) yields 6 workloads including zipf-a0.7 and zipf-a1.2', () => {
    const names = SWEEP_OUT.workloads.map((w) => w.name);
    assert.equal(names.length, 6);
    assert.deepStrictEqual(names, ['zipf-a0.7', 'zipf-a0.9', 'zipf-a1.0', 'zipf-a1.2', 'loop', 'scan']);
    assert.ok(names.includes('zipf-a0.7'));
    assert.ok(names.includes('zipf-a1.2'));
});

test('ASSERTION 2: two runs with the same alpha-sweep opts give identical opt.hits per workload (determinism)', () => {
    const cfg = { alphas: ZIPF_ALPHAS, capacity: 32, length: 2000 };
    const a = runBench(cfg);
    const b = runBench(cfg);
    assert.equal(a.workloads.length, b.workloads.length);
    for (let i = 0; i < a.workloads.length; i++) {
        assert.equal(a.workloads[i].name, b.workloads[i].name);
        assert.equal(a.workloads[i].opt.hits, b.workloads[i].opt.hits, a.workloads[i].name + ' opt.hits drifted across identical runs');
    }
});

test('ASSERTION 2: zipf-a1.0 (from the sweep) matches the default single-alpha zipf workload (naming/seed reduction). Trace itself is NOT exposed on the result, so this compares opt.hits + every member hits/misses (the measurable proxy)', () => {
    const swept = SWEEP_OUT.workloads.find((w) => w.name === 'zipf-a1.0');
    const single = TRIPWIRE_OUT.workloads.find((w) => w.name === 'zipf');
    assert.ok(swept, 'zipf-a1.0 workload present in the sweep');
    assert.ok(single, 'zipf workload present in the default run');
    assert.deepStrictEqual(swept.opt, single.opt);
    assert.equal(swept.members.length, single.members.length);
    for (let i = 0; i < swept.members.length; i++) {
        assert.equal(swept.members[i].name, single.members[i].name);
        assert.equal(swept.members[i].hits, single.members[i].hits, swept.members[i].name + ' hits drifted');
        assert.equal(swept.members[i].misses, single.members[i].misses, swept.members[i].name + ' misses drifted');
        assert.equal(swept.members[i].writesPerHit, single.members[i].writesPerHit, swept.members[i].name + ' writesPerHit drifted');
    }
});

test('FAIL-CLOSED (assertion 2 family): runBench({alphas:[]}) throws a [lite-lru]-tagged RangeError -- an empty sweep must NOT silently collapse to [loop,scan] or fall back to the 3-workload default', () => {
    assert.throws(
        () => runBench({ alphas: [], capacity: 32, length: 2000 }),
        (e) => e instanceof RangeError && e.message.startsWith('[lite-lru]'),
    );
});

/* -------------------------------------------------------------------------- *
 * ASSERTION 3 -- TIMING SHAPE
 * -------------------------------------------------------------------------- */

test('ASSERTION 3: every member has finite nsPerOpMedian/nsPerOpP95 with p95 >= median > 0, and nsPerOp === nsPerOpMedian', () => {
    const out = runBench({ capacity: 32, length: 4000, seed: 0x2a });
    for (const wl of out.workloads) {
        for (const m of wl.members) {
            const tag = wl.name + '.' + m.name;
            assert.ok(Number.isFinite(m.nsPerOpMedian), tag + ' nsPerOpMedian not finite');
            assert.ok(Number.isFinite(m.nsPerOpP95), tag + ' nsPerOpP95 not finite');
            assert.ok(m.nsPerOpMedian > 0, tag + ' nsPerOpMedian not > 0: ' + m.nsPerOpMedian);
            assert.ok(m.nsPerOpP95 >= m.nsPerOpMedian, tag + ' p95 ' + m.nsPerOpP95 + ' < median ' + m.nsPerOpMedian);
            assert.equal(m.nsPerOp, m.nsPerOpMedian, tag + ' nsPerOp !== nsPerOpMedian');
        }
    }
});

/* -------------------------------------------------------------------------- *
 * ASSERTION 4 -- FAIL-CLOSED on `repeats` (measureTiming is NOT exported; the
 * only reachable entry point is runBench({repeats}), which forwards it
 * straight to measureTiming for the very first member -- so the throw
 * happens immediately, before any expensive work).
 * -------------------------------------------------------------------------- */

const TINY = { capacity: 16, length: 500 };

const BAD_REPEATS = [
    { label: '0', value: 0 },
    { label: '-1', value: -1 },
    { label: '1.5', value: 1.5 },
    { label: '-0', value: -0 },
    { label: 'NaN', value: NaN },
    { label: 'null', value: null },
];

for (const { label, value } of BAD_REPEATS) {
    test('ASSERTION 4: runBench({repeats:' + label + '}) throws a [lite-lru]-tagged RangeError', () => {
        assert.throws(() => runBench({ ...TINY, repeats: value }), (err) => {
            assert.ok(err instanceof RangeError, 'expected RangeError, got ' + err);
            assert.match(err.message, /\[lite-lru\]/);
            return true;
        });
    });
}

test('ASSERTION 4: runBench({repeats:1}) works (no throw) and produces a single-sample median===p95', () => {
    const out = runBench({ ...TINY, repeats: 1 });
    assert.equal(out.tuning.repeats, 1);
    for (const wl of out.workloads) {
        for (const m of wl.members) {
            assert.ok(Number.isFinite(m.nsPerOpMedian) && m.nsPerOpMedian > 0);
            assert.equal(m.nsPerOpP95, m.nsPerOpMedian, 'a single timed pass must have p95 === median');
        }
    }
});

test('ASSERTION 4: runBench({repeats:undefined}) is the documented "use the default" door, NOT a fail-closed rejection', () => {
    const out = runBench({ ...TINY, repeats: undefined });
    assert.equal(out.tuning.repeats, 5);
});

/* -------------------------------------------------------------------------- *
 * ASSERTION 5 -- LOADER: parseIntTrace
 * -------------------------------------------------------------------------- */

test('ASSERTION 5: parseIntTrace parses newline-delimited integers (one record per line)', () => {
    assert.deepStrictEqual(parseIntTrace('1\n2\n3\n4\n5\n'), [1, 2, 3, 4, 5]);
});

test('ASSERTION 5: parseIntTrace trims surrounding whitespace/tabs around each single-token record line', () => {
    assert.deepStrictEqual(parseIntTrace('  10  \n\t20\t\n   30\n'), [10, 20, 30]);
});

test('ASSERTION 5: within a line, the default column (0) reads the FIRST whitespace-split token -- other tokens on that line are ignored unless requested via `column`', () => {
    assert.deepStrictEqual(parseIntTrace('1 2  3\n4\n5\n'), [1, 4, 5]);
});

test('ASSERTION 5: parseIntTrace honors a column option', () => {
    // column 0 (the default) vs column 1 vs the boundary column N-1 / N / N+1 on a
    // 3-token line ("10,20,30" -> valid indices 0,1,2; index 3 is out of range).
    assert.deepStrictEqual(parseIntTrace('10,20,30\n40,50,60', { delimiter: ',', column: 1 }), [20, 50]);
    assert.deepStrictEqual(parseIntTrace('10,20,30', { delimiter: ',', column: 2 }), [30]); // N-1 (last valid column)
    assert.throws(() => parseIntTrace('10,20,30', { delimiter: ',', column: 3 }), /\[lite-lru\]/); // N (out of range)
    assert.throws(() => parseIntTrace('10,20,30', { delimiter: ',', column: 4 }), /\[lite-lru\]/); // N+1
});

test('ASSERTION 5: parseIntTrace strips a whole-line and a trailing comment-prefix', () => {
    assert.deepStrictEqual(parseIntTrace('# a whole-line comment\n1\n2 # inline\n3', { comment: '#' }), [1, 2, 3]);
});

test('ASSERTION 5: parseIntTrace skipHeader drops the first non-blank data line even if it is non-numeric', () => {
    assert.deepStrictEqual(parseIntTrace('key\n1\n2\n3\n', { skipHeader: true }), [1, 2, 3]);
});

test('ASSERTION 5: parseIntTrace returns [] for empty / whitespace-only input (documented contract, not an error)', () => {
    assert.deepStrictEqual(parseIntTrace(''), []);
    assert.deepStrictEqual(parseIntTrace('   \n\t\n   \n'), []);
    assert.deepStrictEqual(parseIntTrace('\n\n\n'), []);
});

test('ASSERTION 5: parseIntTrace throws a [lite-lru]-tagged RangeError on a non-integer token', () => {
    assert.throws(() => parseIntTrace('1\nabc\n3'), (err) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /\[lite-lru\]/);
        return true;
    });
});

test('ASSERTION 5: parseIntTrace throws a [lite-lru]-tagged RangeError on a float token', () => {
    assert.throws(() => parseIntTrace('1\n2.5\n3'), (err) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /\[lite-lru\]/);
        return true;
    });
});

test('ASSERTION 5: parseIntTrace throws a [lite-lru]-tagged RangeError on non-string input (null, number)', () => {
    assert.throws(() => parseIntTrace(null), (err) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /\[lite-lru\]/);
        assert.match(err.message, /null/);
        return true;
    });
    assert.throws(() => parseIntTrace(123), (err) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /\[lite-lru\]/);
        return true;
    });
    assert.throws(() => parseIntTrace(undefined), (err) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /\[lite-lru\]/);
        return true;
    });
});

/* -------------------------------------------------------------------------- *
 * ASSERTION 6 -- WEBTRACE
 * -------------------------------------------------------------------------- */

test('ASSERTION 6: webTrace is deterministic -- same seed produces a byte-identical trace', () => {
    const opts = { length: 2000, keyspace: 100, seed: 0x1234 };
    const a = webTrace(opts);
    const b = webTrace(opts);
    assert.deepStrictEqual(a, b);
});

test('ASSERTION 6: webTrace is seed-sensitive -- a different seed produces a different trace', () => {
    const a = webTrace({ length: 2000, keyspace: 100, seed: 0x1234 });
    const b = webTrace({ length: 2000, keyspace: 100, seed: 0x4321 });
    assert.notDeepStrictEqual(a, b);
});

test('ASSERTION 6: every webTrace key is an integer in [0, keyspace)', () => {
    const keyspace = 100;
    const trace = webTrace({ length: 5000, keyspace, seed: 0x777, period: 137, hotSize: 7, hotFraction: 0.65, exponent: 0.9 });
    assert.equal(trace.length, 5000);
    for (let i = 0; i < trace.length; i++) {
        const k = trace[i];
        assert.ok(Number.isInteger(k), 'index ' + i + ' key ' + k + ' is not an integer');
        assert.ok(k >= 0 && k < keyspace, 'index ' + i + ' key ' + k + ' out of [0,' + keyspace + ')');
    }
});
