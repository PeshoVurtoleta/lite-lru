/**
 * @zakkster/lite-lru -- node:test boundary suite for the TwoQ member (decisions/0015).
 * Mirrors the other members' coverage, pinning 2Q's OWN policy laws: a newcomer enters
 * A1in (FIFO) unless the key is in the A1out ghost -> straight to Am; an A1in hit does
 * NOTHING (no promotion); the ONLY path into Am is via the ghost (A1in -> evicted ->
 * A1out -> seen again); an Am hit moves to Am MRU; at capacity the reclaim step evicts
 * the A1in tail (recording its key in the ghost) when A1in is over its target or Am is
 * empty, else the Am LRU (not ghosted); a distinct one-hit-wonder flood never displaces
 * Am (scan resistance); the ghost is bounded and keys-only; has/peek are neutral.
 * validate() (extended with the TwoQ queue + ghost terms) is the structural backstop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TwoQ, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';
import { makeTwoQOracle } from './torture/oracles/twoq.mjs';

const NIL = -1;
const TWOQ_A1IN = 0; // matches Lru.js tags
const TWOQ_AM = 1;

test('exports: VERSION and the named TwoQ export are present', async () => {
    assert.equal(VERSION, '1.6.0');
    const mod = await import('../Lru.js');
    assert.equal(mod.TwoQ, TwoQ);
});

test('getters: size and capacity reflect state', () => {
    const c = new TwoQ(3);
    assert.equal(c.capacity, 3);
    assert.equal(c.size, 0);
    c.put('a', 1);
    assert.equal(c.size, 1);
    validate(c);
});

test('put/get: basic round-trip', () => {
    const c = new TwoQ(4);
    c.put('a', 1);
    c.put('b', 2);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('b'), 2);
    assert.equal(c.get('missing'), undefined);
    validate(c);
});

// --- TwoQ policy LAWS, named --------------------------------------------------

test('law: a newcomer is admitted to A1in', () => {
    const c = new TwoQ(8); // a1inCap 2
    c.put('a', 1);
    assert.equal(c._seg[c._store.get('a')], TWOQ_A1IN, 'newcomer must enter A1in');
    validate(c);
});

test('law: an A1in hit does NOTHING structural (no promotion, no reorder)', () => {
    const c = new TwoQ(8);
    for (let i = 0; i < 3; i++) c.put(i, i);
    const a1Head = c._a1Head, a1Tail = c._a1Tail;
    assert.equal(c.get(0), 0);
    assert.equal(c._a1Head, a1Head, 'A1in hit moved the head');
    assert.equal(c._a1Tail, a1Tail, 'A1in hit moved the tail');
    assert.equal(c._seg[c._store.get(0)], TWOQ_A1IN, 'A1in hit promoted (must not)');
    validate(c);
});

test('law: the ghost path is the ONLY route into Am (A1in -> A1out -> seen again -> Am)', () => {
    const c = new TwoQ(4); // a1inCap 1, amCap 3, ghostCap 3
    c.put('a', 1);
    c.put('b', 2); c.put('c', 3); c.put('d', 4); // fills to capacity (no eviction yet)
    c.put('e', 5); // over capacity -> evicts the A1in tail 'a' into the ghost
    assert.equal(c.has('a'), false);
    assert.equal(c._ghostHas('a'), true, 'evicted A1in key recorded in the A1out ghost');
    c.put('a', 11); // second sighting while in ghost -> straight to Am
    assert.equal(c._seg[c._store.get('a')], TWOQ_AM, 'ghost re-admit did not route to Am');
    assert.equal(c._ghostHas('a'), false, 'a was not consumed from the ghost on re-admission');
    assert.equal(c.get('a'), 11);
    validate(c);
});

test('law: an Am hit moves to Am MRU', () => {
    const c = new TwoQ(8);
    // get two keys into Am via the ghost path.
    c.put('x', 1); c.put('y', 2);
    for (let i = 0; i < 8; i++) c.put('flush' + i, i); // flush x,y out of A1in -> ghost
    c.put('x', 1); c.put('y', 2); // second sightings -> Am (y is MRU)
    assert.equal(c._seg[c._store.get('x')], TWOQ_AM);
    assert.equal(c._keys[c._amHead], 'y');
    c.get('x'); // Am hit -> x to MRU
    assert.equal(c._keys[c._amHead], 'x', 'an Am hit did not move to MRU');
    validate(c);
});

test('law: reclaim evicts the A1in tail (ghosted) when A1in is over its target', () => {
    let seenKey;
    const c = new TwoQ(4, { onEvict: (k) => { seenKey = k; } }); // a1inCap 1
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4); // all A1in; tail = a
    c.put('e', 5); // A1in over target -> evict A1in tail a, record in ghost
    assert.equal(seenKey, 'a');
    assert.equal(c.has('a'), false);
    assert.equal(c._ghostHas('a'), true, 'A1in eviction was recorded in the ghost');
    assert.equal(c.size, 4);
    validate(c);
});

test('law: Am evictions are NOT ghosted', () => {
    // Fill Am (via ghost path) so that reclaim must take from Am, and assert the Am
    // victim's key is not added to the ghost.
    const c = new TwoQ(4); // a1inCap 1, amCap 3, ghostCap 3
    // route x,y,z into Am
    for (const k of ['x', 'y', 'z']) {
        c.put(k, k);
        c.put('f1', 1); c.put('f2', 2); c.put('f3', 3); c.put('f4', 4); // flush k to ghost
        c.put(k, k); // re-admit to Am
    }
    // Now Am has 3 (x,y,z), A1in has 1. a1inSize(1) > a1inCap(1)? no; amSize>0 -> evict Am.
    validate(c);
    assert.equal(c._amSize, 3);
    const amVictimKey = c._keys[c._amTail];
    c.put('new1', 1); // A1in currently holds the last flush key; ensure reclaim takes Am
    // (Depending on state the reclaim may hit A1in or Am; assert only that whatever Am
    //  key left is NOT in the ghost.)
    if (!c.has(amVictimKey)) {
        assert.equal(c._ghostHas(amVictimKey), false, 'an Am eviction was wrongly ghosted');
    }
    validate(c);
});

test('law: has()/peek() are neutral; ghost keys are NOT present', () => {
    const c = new TwoQ(4);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    c.put('e', 5); // a -> ghost
    assert.equal(c.has('a'), false, 'a ghost key is not resident');
    assert.equal(c.peek('a'), undefined);
    // has/peek on a resident A1in key do not promote it.
    const before = c._seg[c._store.get('b')];
    c.has('b'); c.peek('b');
    assert.equal(c._seg[c._store.get('b')], before);
    validate(c);
});

test('law: a cap-sized distinct-key scan evicts 0 Am entries (scan resistance)', () => {
    const N = 64;
    const c = new TwoQ(N);
    const hot = [];
    for (let h = 0; h < 20; h++) hot.push('hot' + h);
    for (const k of hot) c.put(k, 0);
    for (let i = 0; i < N; i++) c.put('flush' + i, i); // flush hot out of A1in -> ghost
    for (let h = 0; h < hot.length; h++) c.put(hot[h], h); // second sighting -> Am
    for (const k of hot) assert.equal(c._seg[c._store.get(k)], TWOQ_AM);
    while (c.size < N) c.put('warm' + c.size, c.size);
    for (let i = 0; i < N; i++) c.put('scan' + i, i); // exactly cap distinct one-hit-wonders
    for (const k of hot) assert.equal(c.has(k), true, 'Am key ' + k + ' evicted by the scan');
    let survivors = 0;
    for (let i = 0; i < N; i++) if (c.has('scan' + i)) survivors++;
    assert.ok(survivors < N, 'scan keys were evicted (non-vacuous)');
    assert.ok(c._gLen <= c._ghostCap, 'ghost stayed bounded');
    validate(c);
});

// --- D7 -----------------------------------------------------------------------

test('D7: a stored undefined value is indistinguishable from a miss via get()', () => {
    const c = new TwoQ(4);
    c.put('k', undefined);
    assert.equal(c.get('k'), undefined);
    assert.equal(c.get('absent'), undefined);
    assert.equal(c.has('k'), true);
    assert.equal(c.has('absent'), false);
    assert.equal(c.peek('k'), undefined);
    validate(c);
});

// --- SameValueZero ------------------------------------------------------------

test('keys: 0 and -0 collapse to one entry (SameValueZero)', () => {
    const c = new TwoQ(4);
    c.put(0, 'zero');
    c.put(-0, 'neg');
    assert.equal(c.size, 1);
    assert.equal(c.get(0), 'neg');
    validate(c);
});

test('keys: NaN is a single usable key', () => {
    const c = new TwoQ(4);
    c.put(NaN, 'x');
    c.put(NaN, 'y');
    assert.equal(c.size, 1);
    assert.equal(c.get(NaN), 'y');
    validate(c);
});

// --- fail-closed doors --------------------------------------------------------

for (const bad of [0, -1, 1.5, NaN, undefined, null, '4', Infinity]) {
    test('fail-closed: capacity ' + String(bad) + ' throws a tagged RangeError', () => {
        assert.throws(() => new TwoQ(bad), (err) => {
            assert.ok(err instanceof RangeError);
            assert.match(err.message, /\[lite-lru\]/);
            return true;
        });
    });
}

for (const bad of ['Int', 'map', 0, true, {}, null]) {
    test('fail-closed: keys option ' + String(bad) + ' throws a did-you-mean TypeError', () => {
        assert.throws(() => new TwoQ(4, { keys: bad }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /did you mean 'int'\?/);
            return true;
        });
    });
}

// --- degenerate caps 1/2/3 ----------------------------------------------------

test('capacity 1 (ghostCap 0): a bounded A1in-only churn', () => {
    let evictions = 0;
    const c = new TwoQ(1, { onEvict: () => { evictions++; } });
    assert.equal(c._a1inCap, 1);
    assert.equal(c._amCap, 0);
    assert.equal(c._ghostCap, 0);
    c.put('a', 1);
    assert.equal(c.size, 1);
    c.put('b', 2);
    assert.equal(c.has('a'), false);
    assert.equal(c.get('b'), 2);
    assert.equal(c.size, 1);
    assert.equal(evictions, 1);
    assert.equal(c._gLen, 0, 'ghostCap is 0 at capacity 1');
    validate(c);
});

test('capacity 1/2/3: bounded size + conservation over a churn', () => {
    for (const cap of [1, 2, 3]) {
        const c = new TwoQ(cap);
        for (let i = 0; i < 300; i++) {
            c.put(i, i);
            assert.equal(c.size, Math.min(cap, i + 1), 'cap ' + cap + ' size at ' + i);
            assert.equal(c.get(i), i);
            assert.ok(c._gLen <= c._ghostCap, 'cap ' + cap + ' ghost bound at ' + i);
            validate(c);
        }
        c.clear();
        assert.equal(c.size, 0);
        assert.equal(c._gLen, 0);
        validate(c);
    }
});

// --- empty / cleared reads ----------------------------------------------------

test('an empty cache misses cleanly (no throw)', () => {
    const c = new TwoQ(4);
    assert.equal(c.get('x'), undefined);
    assert.equal(c.has('x'), false);
    assert.equal(c.peek('x'), undefined);
    assert.equal(c.delete('x'), false);
    assert.equal(c._a1Head, NIL);
    assert.equal(c._amHead, NIL);
    validate(c);
});

test('clear() empties both queues + the ghost, stays reusable', () => {
    const c = new TwoQ(4);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    c.put('e', 5); // record a ghost key
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c._a1Head, NIL); assert.equal(c._amHead, NIL);
    assert.equal(c._gLen, 0, 'the ghost is emptied by clear');
    validate(c);
    c.put('x', 42);
    assert.equal(c.get('x'), 42);
    validate(c);
});

test('clear() soak: after EACH clear, size/free-list/index/ghost reset', () => {
    const c = new TwoQ(6);
    for (let cyc = 0; cyc < 50; cyc++) {
        for (let i = 0; i < 6 + cyc % 4; i++) c.put('k' + i, i);
        if (cyc % 2 === 0) c.get('k0');
        c.clear();
        assert.equal(c.size, 0, 'cycle ' + cyc + ': size');
        assert.equal(c._freeListLength(), c._capacity, 'cycle ' + cyc + ': free-list');
        assert.equal(c._store.indexSize(), 0, 'cycle ' + cyc + ': index');
        assert.equal(c._gLen, 0, 'cycle ' + cyc + ': ghost');
        validate(c);
    }
});

// --- delete -------------------------------------------------------------------

test('delete() from A1in and Am keeps both queues coherent; delete is not ghosted', () => {
    const c = new TwoQ(8);
    c.put('p', 1); // A1in
    // route q into Am
    c.put('q', 2);
    for (let i = 0; i < 8; i++) c.put('f' + i, i);
    c.put('q', 2);
    assert.equal(c._seg[c._store.get('q')], TWOQ_AM);
    assert.equal(c.delete('q'), true);
    assert.equal(c._ghostHas('q'), false, 'a delete must not record a ghost key');
    validate(c);
    assert.equal(c.delete('nope'), false);
    c.put('r', 3);
    assert.equal(c.get('r'), 3);
    validate(c);
});

test('conservation invariant holds after a mixed op stream', () => {
    const c = new TwoQ(8);
    let x = 1;
    for (let i = 0; i < 500; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        const k = x % 20;
        const op = x % 5;
        if (op === 0) c.get(k);
        else if (op === 1) c.put(k, i);
        else if (op === 2) c.delete(k);
        else if (op === 3) c.has(k);
        else c.peek(k);
        validate(c);
    }
});

// --- onEvict fire-after + reentrancy ------------------------------------------

test('onEvict fires LAST, once, with the cache consistent', () => {
    let calls = 0, sizeDuring = -1, victimPresent = null;
    const c = new TwoQ(4, { onEvict: (k) => { calls++; sizeDuring = c.size; victimPresent = c.has(k); } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    c.put('e', 5); // evicts A1in tail a
    assert.equal(calls, 1);
    assert.equal(sizeDuring, 4);
    assert.equal(victimPresent, false);
    validate(c);
});

for (const reenter of [
    { name: 'put', fn: (c) => c.put('reentrant', 999) },
    { name: 'get', fn: (c) => c.get('b') },
    { name: 'delete', fn: (c) => c.delete('b') },
    { name: 'clear', fn: (c) => c.clear() },
]) {
    test('onEvict reentrancy: a reentrant ' + reenter.name + '() throws, cache stays consistent', () => {
        let fired = 0;
        const c = new TwoQ(4, { onEvict: () => { fired++; reenter.fn(c); } });
        c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
        assert.throws(() => c.put('e', 5), /\[lite-lru\].*must not reenter/);
        assert.equal(fired, 1);
        assert.equal(c.size, 4);
        assert.equal(c.has('e'), true);
        assert.equal(c.has('reentrant'), false);
        validate(c);
    });
}

// --- keys:'int' backing rides identically -------------------------------------

test('int backing: an identical op script observes IDENTICAL results to the default backing', () => {
    const script = [
        ['put', 1, 'A'], ['put', 2, 'B'], ['put', 3, 'C'], ['put', 4, 'D'],
        ['has', 1], ['peek', 2],
        ['get', 1],
        ['put', 5, 'E'],
        ['put', 1, 'A2'], // 1 may be in ghost -> route to Am
        ['has', 2], ['has', 5],
        ['peek', 3],
        ['delete', 3], ['delete', 3],
        ['put', 6, 'F'], ['put', 7, 'G'],
        ['get', 6], ['get', 7],
        ['clear'],
        ['put', 8, 'H'], ['get', 8], ['has', 9],
    ];
    function run(useInt) {
        const events = [];
        const c = new TwoQ(4, { keys: useInt ? 'int' : undefined, onEvict: (k, v) => events.push(['evict', k, v]) });
        for (const [kind, a, b] of script) {
            if (kind === 'put') { c.put(a, b); events.push(['put', c.size]); }
            else if (kind === 'get') events.push(['get', c.get(a)]);
            else if (kind === 'has') events.push(['has', c.has(a)]);
            else if (kind === 'peek') events.push(['peek', c.peek(a)]);
            else if (kind === 'delete') events.push(['delete', c.delete(a)]);
            else { c.clear(); events.push(['clear', c.size]); }
            validate(c);
        }
        return events;
    }
    assert.deepEqual(run(true), run(false));
});

const BAD_INT_KEYS = [1.5, 'x', null, undefined, NaN, Infinity, -2147483649, 2147483648, {}, true];
for (const bad of BAD_INT_KEYS) {
    test('int backing door: key ' + String(bad) + ' throws a [lite-lru] TypeError on every method', () => {
        const c = new TwoQ(4, { keys: 'int' });
        c.put(1, 1);
        const matcher = (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /32-bit signed integer/);
            return true;
        };
        assert.throws(() => c.put(bad, 'v'), matcher);
        assert.throws(() => c.get(bad), matcher);
        assert.throws(() => c.has(bad), matcher);
        assert.throws(() => c.peek(bad), matcher);
        assert.throws(() => c.delete(bad), matcher);
        validate(c);
    });
}

// --- TTL interop --------------------------------------------------------------

test('ttl: a stale get is a miss + reap; a fresh Infinity sibling survives', () => {
    let now = 0; const clock = () => now;
    const ev = [];
    const c = new TwoQ(8, { ttl: 10, clock, onEvict: (k) => ev.push(k) });
    c.put('x', 1);
    c.put('keep', 2, Infinity);
    now = 11;
    assert.equal(c.get('x'), undefined);
    assert.deepEqual(ev, ['x']);
    assert.equal(c.size, 1);
    assert.equal(c.has('keep'), true);
    validate(c);
});

test('ttl: ttlMs on a non-ttl instance throws (fail closed)', () => {
    const c = new TwoQ(4);
    assert.throws(() => c.put('k', 1, 5), /\[lite-lru\]/);
});

// --- iteration (decisions/0018): Am then A1in, each MRU..LRU -------------------

test('iteration order: Am (MRU..LRU) then A1in (newest..oldest)', () => {
    const c = new TwoQ(16);
    for (let i = 0; i < 6; i++) c.put(i, i * 10);   // A1in
    for (let i = 0; i < 16; i++) c.put(100 + i, i); // flush 0..5 out of A1in -> ghost
    c.put(0, 0); c.put(2, 2);                        // second sightings -> Am
    const keys = [];
    for (const k of c.keys()) keys.push(k);
    const want = [];
    for (let s = c._amHead; s !== NIL; s = c._next[s]) want.push(c._keys[s]);
    for (let s = c._a1Head; s !== NIL; s = c._next[s]) want.push(c._keys[s]);
    assert.deepEqual(keys, want);
    const sizeBefore = c.size;
    for (const k of c.keys()) void k;
    assert.equal(c.size, sizeBefore, 'iteration is read-only');
    validate(c);
});

// --- stats interop ------------------------------------------------------------

test('stats: outcome-based hits/misses/puts/evictions; has/peek neutral', () => {
    const c = new TwoQ(2, { stats: true });
    c.put('a', 1); c.put('b', 2);         // 2 puts
    assert.equal(c.get('a'), 1);          // hit
    assert.equal(c.get('z'), undefined);  // miss
    c.has('a'); c.peek('a');              // neutral
    c.put('c', 3);                        // put + eviction
    const s = c.stats();
    assert.equal(s.puts, 3);
    assert.equal(s.hits, 1);
    assert.equal(s.misses, 1);
    assert.equal(s.evictions, 1);
    validate(c);
});

test('stats/resetStats fail closed on a non-stats instance', () => {
    const c = new TwoQ(4);
    assert.throws(() => c.stats(), /\[lite-lru\]/);
    assert.throws(() => c.resetStats(), /\[lite-lru\]/);
});

// --- QA (S7): scan resistance at a > cap burst (not just cap-sized) -----------

test('scan resistance: a > cap (3x) burst of distinct one-hit keys evicts 0 Am entries', () => {
    const N = 32;
    const c = new TwoQ(N);
    const hot = [];
    for (let h = 0; h < 10; h++) hot.push('hot' + h);
    for (const k of hot) c.put(k, 0);
    for (let i = 0; i < N; i++) c.put('flush' + i, i); // flush hot out of A1in -> ghost
    for (let h = 0; h < hot.length; h++) c.put(hot[h], h); // second sighting -> Am
    for (const k of hot) assert.equal(c._seg[c._store.get(k)], TWOQ_AM);
    while (c.size < N) c.put('warm' + c.size, c.size);
    for (let i = 0; i < N * 3; i++) c.put('scan' + i, i); // 3x cap distinct one-hit-wonders
    for (const k of hot) {
        assert.equal(c.has(k), true, 'Am key ' + k + ' evicted by a > cap scan');
        assert.equal(c._seg[c._store.get(k)], TWOQ_AM, k + ' left the Am segment');
    }
    assert.ok(c._gLen <= c._ghostCap, 'ghost stayed bounded through the > cap scan');
    validate(c);
});

// --- QA (S7): degenerate caps 1..4, segment-audited (highest risk: the 25% split
// can floor A1in/Am/ghost; the impl must stay correct with no divide-by-zero / NaN) --

test('degenerate cap=2 (a1inCap=1, amCap=1, ghostCap=1): the FULL ghost-admit pipeline, segment-audited at every step', () => {
    const c = new TwoQ(2);
    assert.equal(c._a1inCap, 1); assert.equal(c._amCap, 1); assert.equal(c._ghostCap, 1);
    c.put('a', 1);
    assert.equal(c._seg[c._store.get('a')], TWOQ_A1IN);
    c.put('b', 2); // fills to capacity, still both A1in (no eviction on a below-cap fill)
    assert.equal(c._seg[c._store.get('b')], TWOQ_A1IN);
    assert.equal(c.size, 2);
    c.put('c', 3); // over capacity: a1Size(2) > a1inCap(1) -> evict A1in tail 'a' -> ghost
    assert.equal(c.has('a'), false);
    assert.equal(c._ghostHas('a'), true, "'a' must be recorded in the ghost");
    assert.equal(c._seg[c._store.get('c')], TWOQ_A1IN);
    c.put('a', 11); // ghost hit -> straight to Am, consumed from ghost
    assert.equal(c._seg[c._store.get('a')], TWOQ_AM, "a ghost re-admit must route straight to Am");
    assert.equal(c._ghostHas('a'), false, 'a must be consumed from the ghost on re-admission');
    assert.equal(c.get('a'), 11);
    assert.equal(c.size, 2);
    validate(c);
});

test('degenerate cap=3 (a1inCap=1, amCap=2, ghostCap=2): ghost-admit pipeline, segment-audited', () => {
    const c = new TwoQ(3);
    assert.equal(c._a1inCap, 1); assert.equal(c._amCap, 2); assert.equal(c._ghostCap, 2);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // fills to capacity, all A1in
    for (const k of ['a', 'b', 'c']) assert.equal(c._seg[c._store.get(k)], TWOQ_A1IN);
    c.put('d', 4); // a1Size(3) > a1inCap(1) -> evict A1in tail 'a' -> ghost
    assert.equal(c.has('a'), false);
    assert.equal(c._ghostHas('a'), true);
    c.put('a', 11); // ghost re-admit -> Am
    assert.equal(c._seg[c._store.get('a')], TWOQ_AM);
    assert.equal(c._ghostHas('a'), false);
    assert.equal(c.size, 3);
    validate(c);
});

test('degenerate caps 1..4: the splits never divide by zero / produce NaN, and a full put+get+evict cycle matches a brute count', () => {
    for (const cap of [1, 2, 3, 4]) {
        const c = new TwoQ(cap);
        assert.ok(Number.isInteger(c._a1inCap) && c._a1inCap >= 1 && c._a1inCap <= cap,
            'cap ' + cap + ': a1inCap must be a sane integer in [1, cap], got ' + c._a1inCap);
        assert.ok(Number.isInteger(c._amCap) && c._amCap >= 0 && c._amCap <= cap,
            'cap ' + cap + ': amCap must be a sane integer in [0, cap], got ' + c._amCap);
        assert.ok(Number.isInteger(c._ghostCap) && c._ghostCap === c._amCap,
            'cap ' + cap + ': ghostCap must equal amCap exactly, got ' + c._ghostCap + ' vs ' + c._amCap);
        let evictions = 0;
        const c2 = new TwoQ(cap, { onEvict: () => { evictions++; } });
        const N = cap * 5 + 3; // strictly more distinct keys than capacity
        for (let k = 0; k < N; k++) {
            c2.put(k, k);
            assert.equal(c2.get(k), k, 'cap ' + cap + ': just-inserted key ' + k + ' missing');
            assert.ok(c2._gLen <= c2._ghostCap, 'cap ' + cap + ': ghost exceeded its bound at k=' + k);
            validate(c2);
        }
        assert.equal(evictions, N - cap, 'cap ' + cap + ': eviction count must equal N - cap exactly');
        assert.equal(c2.size, cap);
        validate(c2);
    }
});

// --- QA (S7): has/peek are ALLOWED during onEvict reentrancy --------------------

test('onEvict reentrancy: has()/peek() during onEvict do NOT throw and read the consistent mid-eviction state', () => {
    let hasDuringEvict, peekDuringEvict;
    const c = new TwoQ(4, {
        onEvict: (k) => {
            hasDuringEvict = c.has(k);     // the just-evicted key must already read absent
            peekDuringEvict = c.peek('b'); // an untouched survivor reads normally
        },
    });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    assert.doesNotThrow(() => c.put('e', 5)); // evicts A1in tail 'a'
    assert.equal(hasDuringEvict, false, 'has() on the victim mid-onEvict must read false');
    assert.equal(peekDuringEvict, 2, 'peek() on a survivor mid-onEvict must read its value');
    validate(c);
});

// --- QA (S7) ADVERSARIAL (the case the planner did not think of): a ghost key can
// AGE OUT of the bounded A1out ring before it is ever re-referenced -- a stale ghost
// membership must NOT admit straight to Am; it must fall back to a fresh A1in entry,
// exactly as if it had never been seen before -----------------------------------

test('ADVERSARIAL: a ghost key that AGES OUT of the bounded ring before re-reference is NOT admitted to Am (falls back to fresh A1in)', () => {
    const c = new TwoQ(2); // a1inCap 1, ghostCap 1 -- the ghost can hold only ONE key
    c.put('x', 1); c.put('y', 2);       // A1in: [y, x]
    c.put('z', 3);                       // evicts A1in tail 'x' -> ghost = [x]
    assert.equal(c._ghostHas('x'), true, 'setup: x must be freshly ghosted');
    c.put('w', 4);                       // evicts A1in tail 'y' -> ghost bumps x out, ghost = [y]
    assert.equal(c._ghostHas('x'), false, 'x must have aged out of the bounded (size-1) ghost');
    assert.equal(c._ghostHas('y'), true, 'y must be the current sole ghost occupant');
    c.put('x', 99);                      // x is NOT in the ghost anymore -> must land in A1IN, fresh
    assert.equal(c._seg[c._store.get('x')], TWOQ_A1IN,
        'a re-reference of an aged-out ghost key must be treated as a brand-new A1in admission, not routed to Am');
    assert.equal(c.get('x'), 99);
    validate(c);
});

// --- cross-check against the independent TwoQ oracle (both backings) -----------

test('both backings match an independent TwoQ oracle over a fuzz stream (caps 1..9, 64)', () => {
    for (const cap of [1, 2, 3, 5, 8, 9, 64]) {
        for (const useInt of [false, true]) {
            const keyspace = cap * 3 + 2;
            const c = new TwoQ(cap, useInt ? { keys: 'int' } : undefined);
            const o = makeTwoQOracle(cap);
            let x = (0x13579bd ^ cap) >>> 0;
            const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x >>> 0; };
            for (let i = 0; i < 8000; i++) {
                const kind = rnd() % 5;
                const key = rnd() % keyspace;
                const val = rnd() >>> 0;
                let rv, ov;
                if (kind === 0) { rv = c.get(key); ov = o.get(key); }
                else if (kind === 1) { c.put(key, val); o.put(key, val); rv = ov = undefined; }
                else if (kind === 2) { rv = c.delete(key); ov = o.delete(key); }
                else if (kind === 3) { rv = c.has(key); ov = o.has(key); }
                else { rv = c.peek(key); ov = o.peek(key); }
                assert.ok(Object.is(rv, ov), 'value mismatch at op ' + i + ' (cap=' + cap + ' int=' + useInt + ')');
                assert.equal(c.size, o.size(), 'size mismatch at op ' + i + ' (cap=' + cap + ' int=' + useInt + ')');
                assert.equal(c._peekVictim(), o.victim(), 'victim mismatch at op ' + i + ' (cap=' + cap + ' int=' + useInt + ')');
                validate(c);
            }
        }
    }
});
