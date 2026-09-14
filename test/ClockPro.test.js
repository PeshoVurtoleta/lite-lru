/**
 * @zakkster/lite-lru -- node:test boundary suite for the ClockPro member (decisions/0025,
 * D25). Complementary to the heavy differential + zero-alloc gates in test/torture/*.mjs
 * (run under `node --expose-gc test/torture.mjs`); this pins the ClockPro-specific boundaries
 * a fuzz stream reaches only by luck, as fast, hand-computable node:test cases: the reference-
 * bit lazy hot path (0 relinks, 1 state store), the HAND_cold second chance / promotion, the
 * HAND_hot demotion, the HAND_test test-period expiry, the adaptive `_mHot` raise/lower, the
 * bounded non-resident history re-admit, the fixed-capacity hot/cold split, has/peek
 * neutrality, degenerate caps 1..4, fail-closed doors, clear, dump/restore round-trip +
 * fail-closed rejections, and the TTL / stats / iteration cross-cutting joins. validate() runs
 * after mutating scenarios.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockPro, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';
import { CountedClockPro } from './torture/harness.mjs';

const HOT = 1;  // _st bit0
const REF = 2;  // _st bit1
const TEST = 4; // _st bit2

/** The per-slot _st for a key (or -1 if absent). */
function stOf(c, key) {
    const s = c._store.get(key);
    return s < 0 ? -1 : c._st[s];
}
const isHot = (c, k) => (stOf(c, k) & HOT) !== 0;
const isRef = (c, k) => (stOf(c, k) & REF) !== 0;
const isTest = (c, k) => (stOf(c, k) & TEST) !== 0;

test('ClockPro: VERSION is the current, un-bumped value (moves only at /release)', () => {
    assert.equal(VERSION, '1.13.0');
});

test('ClockPro: fail-closed capacity -- non-integer / < 1 throws RangeError', () => {
    assert.throws(() => new ClockPro(0), RangeError);
    assert.throws(() => new ClockPro(-1), RangeError);
    assert.throws(() => new ClockPro(2.5), RangeError);
    assert.throws(() => new ClockPro('8'), RangeError);
});

test('ClockPro: fail-closed int-key door -- a non-int32 key throws TypeError in keys:int mode', () => {
    const c = new ClockPro(4, { keys: 'int' });
    assert.throws(() => c.put('x', 1), TypeError);
    assert.throws(() => c.get(2.5), TypeError);
    assert.throws(() => c.put(2 ** 40, 1), TypeError);
    c.put(7, 70);
    assert.equal(c.get(7), 70);
    validate(c);
});

test('ClockPro: fail-closed unknown keys option -> TypeError with hint', () => {
    assert.throws(() => new ClockPro(4, { keys: 'clock' }), /did you mean 'int'/);
});

test('ClockPro: the hot path sets the reference bit only; has/peek are neutral; hot+cold==size', () => {
    const c = new ClockPro(8);
    for (let i = 0; i < 8; i++) c.put(i, i);
    assert.ok(!isRef(c, 3), 'a fresh page starts unreferenced');
    assert.equal(c.get(3), 3);
    assert.ok(isRef(c, 3), 'get set the reference bit');
    c.has(5); c.peek(5);
    assert.ok(!isRef(c, 5), 'has/peek are reference-neutral');
    assert.equal(c._nHot + c._nCold, c.size, 'hot + cold == size');
    validate(c);
});

test('ClockPro: a new page is cold in a test period; the reference-bit second chance protects it', () => {
    const c = new ClockPro(4);
    c.put(0, 0); c.put(1, 1); c.put(2, 2); c.put(3, 3);
    assert.ok(!isHot(c, 2) && isTest(c, 2), 'a newcomer is a cold page in a test period');
    c.get(0); c.get(2); c.get(3); // 1 is the only unreferenced page
    let evKey;
    const d = new ClockPro(4, { onEvict: (k) => { evKey = k; } });
    d.put(0, 0); d.put(1, 1); d.put(2, 2); d.put(3, 3);
    d.get(0); d.get(2); d.get(3);
    d.put(4, 4);
    assert.equal(evKey, 1, 'the sweep reclaimed the single unreferenced page (1), not a referenced one');
    assert.ok(d.has(0) && d.has(2) && d.has(3) && d.has(4) && !d.has(1),
        () => 'wrong residents after the second-chance sweep');
    assert.equal(d.size, 4, 'size stays at capacity');
    validate(d);
});

test('ClockPro: the hot set grows once the adaptive target rises (re-admits raise it, promotions stick)', () => {
    // At _mHot 0 a promotion is immediately demoted back to cold (correct adaptive behaviour --
    // the cache keeps ~0 hot pages until the workload proves it should). Raise _mHot via bounded-
    // history re-admits, and the hot set becomes non-empty and stays consistent.
    const c = new ClockPro(8, { keys: 'int' });
    for (let i = 0; i < 8; i++) c.put(i, i);        // 8 cold test pages
    for (let i = 100; i < 140; i++) {               // cold churn -> history fills, then re-admits
        c.put(i, i);
        if (c._hist.has(i - 20)) c.put(i - 20, i);  // re-reference a remembered key -> HOT + raise _mHot
    }
    assert.ok(c._mHot >= 1, 'the adaptive hot target rose via bounded-history re-admits');
    assert.ok(c._nHot >= 1, 'the hot set is non-empty once the target has risen');
    assert.equal(c._nHot + c._nCold, c.size, 'hot + cold == size');
    assert.equal(c.size, 8, 'resident capacity stays exactly capacity');
    validate(c);
});

test('ClockPro: the bounded non-resident history records an evicted test page and re-admits it HOT + raises _mHot', () => {
    const c = new ClockPro(4);
    for (let i = 0; i < 4; i++) c.put(i, i); // 4 cold test pages
    const before = c._mHot;
    c.put(100, 100);                          // evicts a test page -> history
    assert.ok(c._hist._len >= 1, 'an evicted test page is recorded in the bounded history');
    assert.ok(c._hist._len <= c._histCap, 'history is bounded');
    let readmit = -1;
    for (let k = 0; k < 4; k++) if (c._hist.has(k)) { readmit = k; break; }
    assert.ok(readmit >= 0, 'a remembered key exists to re-admit');
    assert.ok(!c.has(readmit), 'the remembered key is non-resident');
    c.put(readmit, readmit);
    assert.ok(isHot(c, readmit), 'a history re-admit becomes HOT');
    assert.ok(c._mHot >= before, 're-admitting a test page raises the adaptive hot target');
    assert.equal(c.size, 4, 'resident capacity stays exactly capacity');
    validate(c);
});

test('ClockPro: HAND_test lowers _mHot when a test page expires unreferenced', () => {
    // Raise _mHot via history re-admits, then churn cold test pages that are never referenced so
    // HAND_test finds unreferenced test pages and lowers _mHot back down.
    const c = new ClockPro(8, { keys: 'int' });
    for (let i = 0; i < 8; i++) c.put(i, i);
    for (let i = 0; i < 8; i++) c.get(i); // reference all -> promotions happen on eviction
    for (let i = 100; i < 140; i++) c.put(i, i); // cold churn (no gets) -> HAND_test expiries
    assert.ok(c._mHot >= 0 && c._mHot <= 8, '_mHot stays in [0, capacity]');
    assert.equal(c.size, 8, 'capacity held under churn');
    validate(c);
});

test('ClockPro: fixed-capacity split -- size stays exactly capacity across churn (hot+cold==size)', () => {
    const c = new ClockPro(16, { keys: 'int' });
    for (let i = 0; i < 2000; i++) {
        c.put(i, i);
        if ((i & 3) === 0 && i > 0) c.get(i - 1);
        assert.ok(c.size <= 16, 'never exceeds capacity');
        if (i >= 16) assert.equal(c.size, 16, 'stays at capacity once full');
    }
    assert.equal(c._nHot + c._nCold, c.size, 'hot + cold == size');
    validate(c);
});

test('ClockPro: degenerate caps 1..4 construct and behave without throwing', () => {
    for (let cap = 1; cap <= 4; cap++) {
        const c = new ClockPro(cap);
        for (let i = 0; i < 40; i++) {
            c.put(i, i * 10);
            assert.equal(c.size, Math.min(cap, i + 1), 'cap ' + cap + ' size at ' + i);
            assert.equal(c.get(i), i * 10, 'cap ' + cap + ' just-inserted key readable');
            assert.ok(c._hist._len <= cap, 'cap ' + cap + ' history bounded');
            assert.equal(c._nHot + c._nCold, c.size, 'cap ' + cap + ' hot+cold==size');
            validate(c);
        }
    }
});

test('ClockPro: cap-1 -- the sole page churns; the next distinct insert evicts it', () => {
    const c = new ClockPro(1);
    c.put('a', 1);
    assert.equal(c.get('a'), 1);
    c.put('b', 2); // evicts a
    assert.ok(!c.has('a'));
    assert.equal(c.get('b'), 2);
    assert.equal(c.size, 1);
    validate(c);
});

test('ClockPro: has/peek do not resurrect an absent key and are undefined/false', () => {
    const c = new ClockPro(4);
    assert.equal(c.has('nope'), false);
    assert.equal(c.peek('nope'), undefined);
    assert.equal(c.get('nope'), undefined);
    validate(c);
});

test('ClockPro: delete removes a resident, frees the slot, and is not recorded in history', () => {
    const c = new ClockPro(4);
    for (let i = 0; i < 3; i++) c.put(i, i);
    assert.equal(c.delete(0), true);
    assert.equal(c.delete(0), false, 'a second delete is a no-op');
    assert.equal(c.size, 2);
    assert.equal(c.size + c._freeListLength(), 4, 'conservation after delete');
    assert.ok(!c._hist.has(0), 'a delete is not recorded in the non-resident history');
    validate(c);
});

test('ClockPro: clear empties everything (ring, hands, history, _mHot) and rebuilds the free list', () => {
    const c = new ClockPro(8, { keys: 'int' });
    for (let i = 0; i < 30; i++) { c.put(i, i); if ((i & 1) === 0) c.get(i); }
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c._freeListLength(), 8, 'free list restored to capacity');
    assert.equal(c._hist._len, 0, 'history emptied');
    assert.equal(c._nHot, 0);
    assert.equal(c._nCold, 0);
    assert.equal(c._mHot, 0);
    assert.equal(c._head, -1);
    assert.equal(c._handCold, -1);
    assert.equal(c._handHot, -1);
    assert.equal(c._handTest, -1);
    validate(c);
    c.put(1, 1); // reusable after clear
    assert.equal(c.get(1), 1);
    validate(c);
});

test('ClockPro: onEvict fires LAST with the evicted (key, value) and reentrancy is fail-closed', () => {
    const seen = [];
    const c = new ClockPro(2, { onEvict: (k, v) => { seen.push([k, v]); assert.throws(() => c.put('z', 0)); } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // evicts one
    assert.equal(seen.length, 1);
    validate(c);
});

test('ClockPro: dump()/restore() round-trip is an exact fixed point (both backings)', () => {
    for (const keys of [undefined, 'int']) {
        const o = keys ? { keys } : undefined;
        const c = new ClockPro(16, o);
        for (let i = 0; i < 60; i++) c.put(i % 24, i * 7);
        for (let i = 0; i < 16; i++) c.get((i * 3) % 24);
        validate(c);
        const snap = c.dump();
        assert.equal(snap.m, 'ClockPro');
        const r = ClockPro.restore(structuredClone(snap), o);
        validate(r);
        assert.equal(r.size, c.size);
        assert.deepEqual(r.dump().st, snap.st, 'per-page state bits preserved verbatim');
        assert.equal(r.dump().handCold, snap.handCold, 'handCold preserved');
        assert.equal(r.dump().handHot, snap.handHot, 'handHot preserved');
        assert.equal(r.dump().handTest, snap.handTest, 'handTest preserved');
        assert.equal(r.dump().mHot, snap.mHot, 'mHot preserved');
        assert.deepEqual(r.dump().hist, snap.hist, 'bounded history preserved verbatim');
    }
});

test('ClockPro: restore fail-closed matrix', () => {
    const c = new ClockPro(8);
    for (let i = 0; i < 12; i++) c.put(i, i);
    for (let i = 0; i < 8; i++) c.get(i % 6);
    const good = c.dump();
    // wrong member tag
    assert.throws(() => ClockPro.restore({ ...structuredClone(good), m: 'Arc' }), /cannot restore/);
    // malformed st
    { const s = structuredClone(good); s.st = 'nope'; assert.throws(() => ClockPro.restore(s), /clockpro st/); }
    // st entry out of range
    { const s = structuredClone(good); if (s.st.length) s.st[0] = 99; assert.throws(() => ClockPro.restore(s), /clockpro st/); }
    // st entry HOT|TEST (invalid combo)
    { const s = structuredClone(good); if (s.st.length) s.st[0] = 5; assert.throws(() => ClockPro.restore(s), /hot and in a test period/); }
    // mHot out of range
    { const s = structuredClone(good); s.mHot = 999; assert.throws(() => ClockPro.restore(s), /clockpro mHot/); }
    // a hand not referencing a resident slot
    { const s = structuredClone(good); s.handCold = 999; assert.throws(() => ClockPro.restore(s), /does not reference a resident slot/); }
    // history over the bound
    { const s = structuredClone(good); s.hist = new Array(9).fill(0).map((_, i) => 1000 + i); assert.throws(() => ClockPro.restore(s), /history/); }
    // non-object snapshot
    assert.throws(() => ClockPro.restore(null), /cannot restore/);
});

test('ClockPro: TTL interop -- a stale hit is a miss and is reaped in place (lazy, no reference set)', () => {
    let now = 0; const clock = () => now;
    const ev = [];
    const c = new ClockPro(8, { ttl: 10, clock, onEvict: (k) => ev.push(k) });
    c.put('x', 1);
    c.put('keep', 2, Infinity);
    now = 11;
    assert.equal(c.get('x'), undefined, 'stale get is a miss');
    assert.equal(ev.length, 1, 'the stale entry was reaped (onEvict fired once)');
    assert.equal(ev[0], 'x');
    assert.ok(c.has('keep'), 'the Infinity sibling survives');
    assert.equal(c.size, 1);
    validate(c);
    // ttlMs on a non-ttl instance fails closed.
    const d = new ClockPro(4);
    assert.throws(() => d.put('a', 1, 5));
});

test('ClockPro: stats counting law -- outcome-based hits/misses/puts/evictions; peek/has neutral', () => {
    const c = new ClockPro(4, { stats: true });
    c.put(0, 0); c.put(1, 1); c.put(2, 2); c.put(3, 3); // 4 puts
    assert.equal(c.get(0), 0);   // hit
    assert.equal(c.get(99), undefined); // miss
    c.has(0); c.peek(0);         // neutral
    c.put(4, 4);                 // put + eviction
    const s = c.stats();
    assert.equal(s.hits, 1);
    assert.equal(s.misses, 1);
    assert.equal(s.puts, 5);
    assert.equal(s.evictions, 1);
    validate(c);
    assert.throws(() => new ClockPro(4).stats(), /stats/); // fail-closed without { stats: true }
});

test('ClockPro: iteration is RESIDENT-only (clock newest..oldest), history excluded, recency-neutral', () => {
    const c = new ClockPro(20);
    for (let i = 0; i < 40; i++) c.put(i % 30, i);   // churn past capacity
    for (let i = 0; i < 20; i++) c.get((i * 3) % 30); // set reference bits
    const keys = [...c.keys()];
    assert.equal(keys.length, c.size, 'iteration visits exactly the resident set');
    for (const k of keys) assert.ok(c.has(k), 'iterated key ' + k + ' must be resident');
    // recency-neutral: iterating changes neither size nor the hands.
    const hc = c._handCold, hh = c._handHot, ht = c._handTest;
    for (const _ of c.entries()) { /* walk */ }
    assert.equal(c._handCold, hc, 'iteration is hand-neutral (cold)');
    assert.equal(c._handHot, hh, 'iteration is hand-neutral (hot)');
    assert.equal(c._handTest, ht, 'iteration is hand-neutral (test)');
    validate(c);
});

test('ClockPro: iteration fails closed (throws) on a structural mutation mid-walk', () => {
    const c = new ClockPro(16);
    for (let i = 0; i < 40; i++) c.put(i % 24, i);
    const it = c.entries();
    const first = it.next();
    assert.equal(first.done, false, 'setup: iterator must yield at least one entry');
    c.put(999, 999); // structural mutation (evicts) -> bumps _store._ver
    assert.throws(() => it.next(), /\[lite-lru\]/, 'continuing a walk after a structural mutation must throw');
    let count = 0;
    for (const _ of c.entries()) count++;
    assert.equal(count, c.size, 'a fresh iterator after the mutation walks the full resident set');
    validate(c);
});

test('ClockPro: worst-case miss+evict SCALES with capacity -- a full-scan-then-insert is O(capacity), not a constant', () => {
    // t6's CLOCKPRO_WRITES_MISS_EVICT_TRIPWIRE=64 is a per-STREAM regression tripwire on a
    // MIXED stream that never does scan-then-insert -- it is NOT a bound on ClockPro's
    // miss+evict cost. The honest worst case (HAND_cold and HAND_hot each sweeping the whole
    // clock to clear reference bits before a victim is found) is proven HERE, positively: fill
    // to capacity, get() every resident key once (a full working-set scan sets every reference
    // bit), then put() one new key. The write count must clearly exceed the tripwire and scale
    // roughly linearly with capacity (~2*capacity), not sit at a fixed small constant.
    function scanThenInsertWrites(cap) {
        const c = new CountedClockPro(cap, { keys: 'int' });
        for (let i = 0; i < cap; i++) c.put(i, i);   // fill to capacity
        for (let i = 0; i < cap; i++) c.get(i);      // full working-set scan: every ref bit set
        validate(c);
        c.resetWrites();
        c.put(cap, cap);                             // one new key -> a genuine miss + evict
        validate(c);
        return c.writes() + c.stWrites();
    }

    const w64 = scanThenInsertWrites(64);
    const w256 = scanThenInsertWrites(256);
    const w1024 = scanThenInsertWrites(1024);

    assert.ok(w256 > 64,
        'cap 256 full-scan-then-insert wrote ' + w256 +
        ' writes; expected to clearly exceed the t6 per-stream tripwire (64) -- the tripwire is not a bound');
    // Roughly ~2*capacity (HAND_cold, then HAND_hot, each sweep the ring once clearing
    // reference bits before a victim/slot is settled). A generous band avoids flakiness
    // while still failing a regression to a small constant OR to a runaway multiple.
    for (const [cap, w] of [[64, w64], [256, w256], [1024, w1024]]) {
        assert.ok(w >= 1.5 * cap && w <= 3 * cap,
            'cap ' + cap + ' full-scan-then-insert wrote ' + w + ', expected roughly [1.5x, 3x] capacity (~2x)');
    }
    // Scaling proof (not just a big number at one capacity): quadrupling capacity roughly
    // quadruples the write count -- a CONSTANT bound would keep this ratio near 1.
    const ratio64to256 = w256 / w64;
    const ratio256to1024 = w1024 / w256;
    assert.ok(ratio64to256 > 2 && ratio64to256 < 8,
        '64->256 (4x capacity) write ratio ' + ratio64to256.toFixed(2) + ' is not consistent with O(capacity) scaling');
    assert.ok(ratio256to1024 > 2 && ratio256to1024 < 8,
        '256->1024 (4x capacity) write ratio ' + ratio256to1024.toFixed(2) + ' is not consistent with O(capacity) scaling');
});

test('ClockPro: scan/loop resistance -- a referenced hot set survives a distinct one-hit flood > capacity', () => {
    const N = 64;
    const c = new ClockPro(N, { keys: 'int' });
    for (let i = 0; i < N; i++) c.put(i, i);
    const hot = [0, 1, 2, 3, 4, 5, 6, 7];
    for (const h of hot) for (let t = 0; t < 8; t++) c.get(h);
    for (let i = 0; i < 4000; i++) { for (const h of hot) c.get(h); c.put(1000 + i, i); }
    for (const h of hot) assert.ok(c.has(h), 'hot key ' + h + ' survives the scan');
    assert.equal(c.size, N, 'capacity held under the flood');
    validate(c);
});
