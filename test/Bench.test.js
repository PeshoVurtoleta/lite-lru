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
import { beladyOpt, runBench } from '../benchmark/Bench.mjs';
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
        assert.equal(wl.members.length, 12);
        const names = wl.members.map((m) => m.name);
        assert.deepEqual(names, ['LiteLru', 'Sieve', 'S3Fifo', 'WTinyLfu', 'Slru', 'TwoQ', 'Arc', 'Lirs', 'Lfu', 'ClockPro', 'LruK', 'Mq']);
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
