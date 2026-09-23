/**
 * @zakkster/lite-lru -- the keys:'dense' backing + DirectLru wrapper (decisions/0029).
 *
 * The dense (direct-mapped, generation-stamped) index is an ADDITIVE third backing
 * behind the SAME LiteLru policy. This suite proves it is a byte-faithful substrate
 * swap -- identical eviction order vs the default Map backing on an integer trace --
 * plus the dense-specific contracts the generation-stamp design has to earn:
 *
 *   - NO-INIT SAFETY: a never-written key in [0, maxKey] reads absent on a FRESH store
 *     (the sparse-set epoch trick; no O(U) pre-fill).
 *   - O(1) CLEAR CORRECTNESS: after clear() a pre-clear key reads absent (the epoch
 *     bump invalidates every stamp at once) while the domain stays usable.
 *   - DUMP/RESTORE incl. maxKey: a dense snapshot carries keys:'dense' + mk and
 *     restores to an identical dense cache; fail closed on a dense snapshot missing mk.
 *   - DirectLru == new LiteLru(cap, { keys:'dense', maxKey }) byte-for-byte.
 *   - The fail-closed doors (bad key, absent/bad maxKey).
 *
 * ASCII-only; every potentially-Symbol/BigInt value is turned to text with String().
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiteLru, DirectLru, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';

/** The key at the LRU (tail) -- the next eviction victim. Test-only introspection. */
function victim(c) {
    return c._tail === -1 ? undefined : c._keys[c._tail];
}

/** A seeded xorshift32 so traces are reproducible. */
function prng(seed) {
    let x = (seed >>> 0) || 1;
    return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x >>> 0; };
}

test('dense: VERSION is the current value (moves only at /release)', () => {
    assert.equal(VERSION, '1.19.0');
});

test('dense: exports DirectLru', async () => {
    const mod = await import('../Lru.js');
    assert.equal(mod.DirectLru, DirectLru);
});

/* ============================================================================ *
 * ORACLE: the dense backing decides EXACTLY like the Map backing.
 * ============================================================================ */

test('dense: identical value + eviction order vs the Map backing on a 100k integer trace', () => {
    const CAP = 64, MK = 511;
    const map = new LiteLru(CAP);
    const dense = new LiteLru(CAP, { keys: 'dense', maxKey: MK });
    const rnd = prng(0x1234abcd);
    for (let i = 0; i < 100000; i++) {
        const kind = rnd() % 5;
        const key = rnd() % (MK + 1);
        const val = rnd() >>> 0;
        let rm, rd;
        switch (kind) {
            case 0: rm = map.get(key); rd = dense.get(key); break;
            case 1: map.put(key, val); dense.put(key, val); rm = rd = undefined; break;
            case 2: rm = map.delete(key); rd = dense.delete(key); break;
            case 3: rm = map.has(key); rd = dense.has(key); break;
            default: rm = map.peek(key); rd = dense.peek(key); break;
        }
        assert.ok(Object.is(rm, rd), 'value diverged at op ' + i + ' key=' + key + ' kind=' + kind);
        assert.equal(dense.size, map.size, 'size diverged at op ' + i);
        assert.ok(Object.is(victim(dense), victim(map)), 'victim diverged at op ' + i);
    }
    validate(dense);
});

/* ============================================================================ *
 * NO-INIT SAFETY: the generation-stamp trick reads absent with no O(U) pre-fill.
 * ============================================================================ */

test('dense: a never-written key in [0, maxKey] reads absent on a fresh store', () => {
    const c = new LiteLru(4, { keys: 'dense', maxKey: 1000 });
    for (const k of [0, 1, 7, 500, 999, 1000]) {
        assert.equal(c.has(k), false, 'k=' + k);
        assert.equal(c.get(k), undefined, 'k=' + k);
        assert.equal(c.peek(k), undefined, 'k=' + k);
    }
    // The zero-init _gen array must NOT alias epoch 1 (0 = never-written).
    assert.equal(c._store._epoch, 1);
    assert.equal(c._store._gen[999], 0);
});

/* ============================================================================ *
 * O(1) CLEAR: the epoch bump invalidates every stamp at once.
 * ============================================================================ */

test('dense: after clear() a pre-clear key reads absent (the epoch bump), domain still usable', () => {
    const c = new LiteLru(4, { keys: 'dense', maxKey: 64 });
    c.put(3, 'a'); c.put(9, 'b'); c.put(50, 'c');
    assert.equal(c.get(9), 'b');
    const epochBefore = c._store._epoch;
    c.clear();
    // O(1): the epoch advanced by exactly one; no O(U) fill happened.
    assert.equal(c._store._epoch, epochBefore + 1);
    assert.equal(c.size, 0);
    for (const k of [3, 9, 50]) {
        assert.equal(c.has(k), false, 'stale key ' + k + ' must read absent post-clear');
    }
    // The domain is still usable after the O(1) clear.
    c.put(9, 'z');
    assert.equal(c.get(9), 'z');
    assert.equal(c.size, 1);
    validate(c);
});

test('dense: repeated O(1) clear cycles never leak stamps (a stale slot never reads live)', () => {
    const c = new LiteLru(8, { keys: 'dense', maxKey: 255 });
    for (let cycle = 0; cycle < 5000; cycle++) {
        for (let k = 0; k < 8; k++) c.put((cycle * 13 + k) & 255, k);
        c.clear();
        assert.equal(c.size, 0, 'cycle ' + cycle);
        // A key touched in this cycle must be gone after clear.
        assert.equal(c.has((cycle * 13) & 255), false, 'cycle ' + cycle);
    }
});

/* ============================================================================ *
 * DUMP / RESTORE incl. maxKey.
 * ============================================================================ */

test('dense: dump carries keys:dense + mk, and restore rebuilds an identical cache', () => {
    const c = new LiteLru(8, { keys: 'dense', maxKey: 200 });
    for (let i = 0; i < 40; i++) c.put((i * 7) % 201, i);
    const snap = c.dump();
    assert.equal(snap.keys, 'dense');
    assert.equal(snap.mk, 200);
    assert.equal(snap.m, 'LiteLru');
    const clone = structuredClone(snap);
    const r = LiteLru.restore(clone);
    assert.equal(r.size, c.size);
    assert.equal(r._store._kind, 'dense');
    assert.equal(r._store._maxKey, 200);
    // Same residents + same next victim.
    assert.ok(Object.is(victim(r), victim(c)));
    // dump -> restore -> dump is a fixed point (ignoring capture time t).
    const s2 = r.dump();
    assert.equal(s2.keys, 'dense');
    assert.equal(s2.mk, 200);
    validate(r);
});

test('dense: restore fails closed on a dense snapshot missing mk', () => {
    const c = new LiteLru(4, { keys: 'dense', maxKey: 16 });
    c.put(1, 1); c.put(2, 2);
    const snap = c.dump();
    delete snap.mk;
    assert.throws(() => LiteLru.restore(snap), (err) => {
        assert.match(err.message, /\[lite-lru\]/);
        assert.match(err.message, /mk/);
        return true;
    });
});

test('dense: restore fails closed on a keys opt conflicting with the dense snapshot', () => {
    const c = new LiteLru(4, { keys: 'dense', maxKey: 16 });
    c.put(1, 1);
    const snap = c.dump();
    assert.throws(() => LiteLru.restore(snap, { keys: 'int' }), /\[lite-lru\]/);
});

/* ============================================================================ *
 * DirectLru == new LiteLru(cap, { keys:'dense', maxKey }).
 * ============================================================================ */

test('DirectLru: byte-identical dumps to new LiteLru(cap, { keys:dense, maxKey })', () => {
    const a = new DirectLru(16, { maxKey: 300 });
    const b = new LiteLru(16, { keys: 'dense', maxKey: 300 });
    const rnd = prng(0x99);
    for (let i = 0; i < 5000; i++) {
        const key = rnd() % 301;
        const kind = rnd() % 3;
        if (kind === 0) a.put(key, i), b.put(key, i);
        else if (kind === 1) a.get(key), b.get(key);
        else a.delete(key), b.delete(key);
    }
    const sa = a.dump(), sb = b.dump();
    // Compare every field but the capture time t.
    delete sa.t; delete sb.t;
    assert.deepEqual(sa, sb);
    assert.equal(a.size, b.size);
    assert.ok(Object.is(victim(a), victim(b)));
    validate(a);
});

test('DirectLru: is a LiteLru and shares the surface', () => {
    const d = new DirectLru(4, { maxKey: 10 });
    assert.ok(d instanceof LiteLru);
    d.put(0, 'x'); d.put(5, 'y');
    assert.equal(d.get(0), 'x');
    assert.equal(d.capacity, 4);
    assert.equal([...d.keys()].length, 2);
});

test('DirectLru: a dumped DirectLru restores as a plain LiteLru (documented, decisions/0029 D29.7 + Lru.d.ts restore return type)', () => {
    const d = new DirectLru(4, { maxKey: 10 });
    d.put(0, 'x'); d.put(5, 'y');
    const r = DirectLru.restore(d.dump());
    assert.ok(r instanceof LiteLru);
    assert.equal(r instanceof DirectLru, false, 'restore must NOT resurrect a DirectLru instance');
    assert.equal(r.get(0), 'x');
    assert.equal(r._store._kind, 'dense');
});

test('DirectLru: fail closed on a conflicting keys option', () => {
    assert.throws(() => new DirectLru(4, { keys: 'int', maxKey: 10 }), (err) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /\[lite-lru\]/);
        assert.match(err.message, /dense/);
        return true;
    });
    // keys:'dense' is fine (redundant but consistent).
    const ok = new DirectLru(4, { keys: 'dense', maxKey: 10 });
    ok.put(1, 1);
    assert.equal(ok.get(1), 1);
});

/* ============================================================================ *
 * The fail-closed doors.
 * ============================================================================ */

test('dense: rejects a maxKey that is absent / non-integer / out of range', () => {
    assert.throws(() => new LiteLru(4, { keys: 'dense' }), /\[lite-lru\].*maxKey/);
    assert.throws(() => new LiteLru(4, { keys: 'dense', maxKey: -1 }), /\[lite-lru\].*maxKey/);
    assert.throws(() => new LiteLru(4, { keys: 'dense', maxKey: 1.5 }), /\[lite-lru\].*maxKey/);
    assert.throws(() => new LiteLru(4, { keys: 'dense', maxKey: 2147483648 }), /\[lite-lru\].*maxKey/);
    assert.throws(() => new LiteLru(4, { keys: 'dense', maxKey: '10' }), /\[lite-lru\].*maxKey/);
    assert.throws(() => new LiteLru(4, { keys: 'dense', maxKey: null }), /\[lite-lru\].*maxKey/);
});

test('dense: rejects a key outside [0, maxKey], fail closed (typeof guard FIRST)', () => {
    const c = new LiteLru(4, { keys: 'dense', maxKey: 15 });
    for (const bad of [-1, 16, 100, 1.5, '3', null, undefined, {}, true, Symbol('x'), 10n]) {
        assert.throws(() => c.get(bad), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /dense/);
            return true;
        }, 'key ' + String(bad));
    }
    // maxKey itself is a legal key; 0 is a legal key (0 is not "absent").
    c.put(0, 'zero'); c.put(15, 'top');
    assert.equal(c.get(0), 'zero');
    assert.equal(c.get(15), 'top');
});

test('dense: 0 is a legal key, not a miss sentinel', () => {
    const c = new LiteLru(2, { keys: 'dense', maxKey: 4 });
    c.put(0, 'zero');
    assert.equal(c.has(0), true);
    assert.equal(c.get(0), 'zero');
    c.delete(0);
    assert.equal(c.has(0), false);
});
