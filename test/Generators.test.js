/**
 * @zakkster/lite-lru -- self-check for the pseudo-random op streams the member suites use.
 * Finding (Research/BITWISE_RESEARCH.md section 1, 2026-10-07; re-verified 2026-10-18): the
 * mixed-stream generator `x = (x * 1103515245 + 12345) & 0x7fffffff` multiplies in doubles,
 * so past 2^53 the low bits round away (period 10,466 instead of 2^31), and `k = x % 20`,
 * `op = x % 5` come from the same draw (20 is a multiple of 5), so op === k % 5 always.
 * The 500-step stream reached 7 of 100 (key, op) pairs and `put` only touched key 16: the
 * "heavy churn" conservation tests never filled the cache and never evicted.
 * This file pins the fix: no suite may use the double-precision form again, and the fixed
 * streams must cover the (key, op) space and actually evict. Each check carries a control
 * that runs the OLD generator through the same predicate and must fail it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { LiteLru } from '../Lru.js';

const DIR = new URL('./', import.meta.url);
const BROKEN = /\bx\s*\*\s*1103515245\b/;

const oldStep = (x) => (x * 1103515245 + 12345) & 0x7fffffff;
const newStep = (x) => (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;

// The mixed stream as the member suites run it (500 ops over keys 0..19, cap 8).
function mixedStream(fixed) {
    const pairs = new Set(), putKeys = new Set();
    let x = 1;
    const ops = [];
    for (let i = 0; i < 500; i++) {
        x = fixed ? newStep(x) : oldStep(x);
        const k = fixed ? (x >>> 16) % 20 : x % 20;
        const op = fixed ? (x >>> 8) % 5 : x % 5;
        pairs.add(k + ':' + op);
        if (op === 1) putKeys.add(k);
        ops.push(k, op);
    }
    return { pairs: pairs.size, putKeys: putKeys.size, ops };
}

function evictions(ops) {
    let n = 0;
    const c = new LiteLru(8, { onEvict: () => { n++; } });
    for (let i = 0; i < ops.length; i += 2) {
        const k = ops[i], op = ops[i + 1];
        if (op === 0) c.get(k);
        else if (op === 1) c.put(k, i);
        else if (op === 2) c.delete(k);
        else if (op === 3) c.has(k);
        else c.peek(k);
    }
    return n;
}

const covers = (s) => s.pairs >= 90 && s.putKeys > 8;

test('no suite uses the double-precision LCG multiply', () => {
    const hits = [];
    for (const f of readdirSync(DIR)) {
        if (!/\.(test\.js|mjs)$/.test(f) || f === 'Generators.test.js') continue;
        const lines = readFileSync(new URL(f, DIR), 'utf8').split('\n');
        lines.forEach((l, i) => { if (BROKEN.test(l)) hits.push(f + ':' + (i + 1)); });
    }
    assert.deepEqual(hits, [], 'use Math.imul(x, 1103515245): ' + hits.join(', '));
});

test('control: the lint pattern catches the old form', () => {
    assert.ok(BROKEN.test('x = (x * 1103515245 + 12345) & 0x7fffffff;'));
    assert.ok(!BROKEN.test('x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;'));
});

test('fixed mixed stream covers the (key, op) space and evicts', () => {
    const s = mixedStream(true);
    assert.ok(covers(s), 'pairs ' + s.pairs + '/100, put keys ' + s.putKeys);
    assert.ok(evictions(s.ops) > 0, 'a cap-8 cache must evict under the stream');
});

test('control: the old mixed stream fails the same coverage and eviction checks', () => {
    const s = mixedStream(false);
    assert.ok(!covers(s), 'old stream unexpectedly covers: ' + s.pairs + ' pairs');
    assert.equal(s.pairs, 7);
    assert.equal(s.putKeys, 1);
    assert.equal(evictions(s.ops), 0);
});

test('fixed generator has no short cycle; the old one cycles at period 10,466', () => {
    const period = (step, limit) => {
        const seen = new Map();
        let x = 1;
        for (let i = 0; i < limit; i++) {
            const at = seen.get(x);
            if (at !== undefined) return i - at;
            seen.set(x, i);
            x = step(x);
        }
        return Infinity;
    };
    assert.equal(period(newStep, 200000), Infinity);
    assert.equal(period(oldStep, 200000), 10466);   // control: the defect is real
});
