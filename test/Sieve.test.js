/**
 * @zakkster/lite-lru -- node:test boundary suite for the SIEVE member
 * (decisions/0012). Mirrors Lru.test.js in coverage, but pins SIEVE's OWN policy
 * laws: a hit sets a visited bit and does NOTHING structural (zero relinks, hand
 * untouched); a visited entry survives exactly one sweep (second chance); the hand
 * persists across evictions (it does not reset); delete repairs the hand when its
 * own slot dies. validate() (the conservation invariant, extended with the sieve
 * hand/visited terms) runs after mutating tests as a structural backstop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Sieve, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';
import { makeSieveOracle } from './torture/oracles/sieve.mjs';

const NIL = -1;

test('exports: VERSION and the named Sieve export are present', async () => {
    assert.equal(VERSION, '1.19.0');
    const mod = await import('../Lru.js');
    assert.equal(mod.Sieve, Sieve);
});

test('getters: size and capacity reflect state', () => {
    const c = new Sieve(3);
    assert.equal(c.capacity, 3);
    assert.equal(c.size, 0);
    c.put('a', 1);
    assert.equal(c.size, 1);
    validate(c);
});

test('put/get: basic round-trip', () => {
    const c = new Sieve(4);
    c.put('a', 1);
    c.put('b', 2);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('b'), 2);
    assert.equal(c.get('missing'), undefined);
    validate(c);
});

// --- SIEVE policy LAWS, named -------------------------------------------------

test('law: get() sets the visited bit but does NOTHING structural (no relink, hand fixed)', () => {
    const c = new Sieve(4);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4); // head=d, tail=a
    const head = c._head, tail = c._tail, hand = c._hand;
    assert.equal(c.get('a'), 1);
    assert.equal(c._head, head, 'get must not move the head');
    assert.equal(c._tail, tail, 'get must not move the tail');
    assert.equal(c._hand, hand, 'get must not move the hand');
    const s = c._store.get('a');
    assert.equal(c._vis[s], 1, 'get sets the visited bit');
    validate(c);
});

test('law: a visited entry gets a SECOND CHANCE -- survives one sweep, its bit clears', () => {
    const c = new Sieve(3);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // tail = a
    c.get('a'); // visit a
    const sa = c._store.get('a');
    assert.equal(c._vis[sa], 1);
    c.put('d', 4); // sweep from the tail: a is visited -> second chance; b is the victim
    assert.equal(c.has('a'), true, 'the visited entry survived the sweep');
    assert.equal(c.has('b'), false, 'the first unvisited entry was the victim');
    assert.equal(c._vis[sa], 0, 'the second chance consumed the visited bit');
    validate(c);
});

test('law: an entry visited once is evicted on the NEXT sweep that reaches it', () => {
    const c = new Sieve(2);
    c.put('a', 1); c.put('b', 2); // tail = a
    c.get('a'); // visit a
    c.put('c', 3); // sweep: a visited -> cleared + survives; b is the victim
    assert.equal(c.has('a'), true);
    assert.equal(c.has('b'), false);
    c.put('d', 4); // a is now unvisited -> a is the victim
    assert.equal(c.has('a'), false, 'a is evicted on the sweep after its second chance is spent');
    validate(c);
});

test('law: the hand PERSISTS across evictions (it does not reset to head/tail)', () => {
    const c = new Sieve(4);
    for (const k of ['a', 'b', 'c', 'd']) c.put(k, k);
    c.put('e', 5); // first eviction parks the hand
    const handAfter = c._hand;
    assert.notEqual(handAfter, NIL, 'an eviction parks the hand');
    c.get('e'); c.has('a'); c.peek('b'); // reads must not move the hand
    assert.equal(c._hand, handAfter, 'reads leave the hand parked');
    validate(c);
});

test('law: put(new) inserts at the HEAD; put(update) sets visited and keeps size', () => {
    const c = new Sieve(3);
    c.put('a', 1); c.put('b', 2);
    c.put('c', 3);
    assert.equal(c._keys[c._head], 'c', 'the newcomer is the head');
    c.put('a', 11); // update
    const sa = c._store.get('a');
    assert.equal(c._vis[sa], 1, 'an update sets the visited bit (it is a write, like a hit)');
    assert.equal(c.get('a'), 11);
    assert.equal(c.size, 3);
    validate(c);
});

test('law: has() and peek() are visited-NEUTRAL (no second chance)', () => {
    const c = new Sieve(3);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // tail = a
    assert.equal(c.has('a'), true);
    assert.equal(c.peek('a'), 1);
    const sa = c._store.get('a');
    assert.equal(c._vis[sa], 0, 'has/peek left a unvisited');
    c.put('d', 4); // a is unvisited -> a is the victim
    assert.equal(c.has('a'), false, 'has/peek did not protect a from eviction');
    validate(c);
});

test('law: at capacity, a new key evicts the SIEVE victim and fires onEvict once', () => {
    let calls = 0, seenKey, seenVal;
    const c = new Sieve(3, { onEvict: (k, v) => { calls++; seenKey = k; seenVal = v; } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // all unvisited, tail = a
    c.put('d', 4); // sweep from the tail: a is the first unvisited -> victim
    assert.equal(calls, 1);
    assert.equal(seenKey, 'a');
    assert.equal(seenVal, 1);
    assert.equal(c.has('a'), false);
    assert.equal(c.has('d'), true);
    assert.equal(c.size, 3);
    validate(c);
});

// --- D7: the undefined-value ambiguity, pinned as contract --------------------

test('D7: a stored undefined value is indistinguishable from a miss via get()', () => {
    const c = new Sieve(4);
    c.put('k', undefined);
    assert.equal(c.get('k'), undefined);
    assert.equal(c.get('absent'), undefined);
    assert.equal(c.has('k'), true);
    assert.equal(c.has('absent'), false);
    assert.equal(c.peek('k'), undefined);
    assert.equal(c.peek('absent'), undefined);
    validate(c);
});

// --- SameValueZero key semantics ----------------------------------------------

test('keys: 0 and -0 collapse to one entry (SameValueZero)', () => {
    const c = new Sieve(4);
    c.put(0, 'zero');
    c.put(-0, 'neg');
    assert.equal(c.size, 1);
    assert.equal(c.get(0), 'neg');
    validate(c);
});

test('keys: NaN is a single usable key', () => {
    const c = new Sieve(4);
    c.put(NaN, 'x');
    c.put(NaN, 'y');
    assert.equal(c.size, 1);
    assert.equal(c.get(NaN), 'y');
    assert.equal(c.has(NaN), true);
    validate(c);
});

// --- fail-closed capacity door ------------------------------------------------

for (const bad of [0, -1, 1.5, NaN, undefined, null, '4', Infinity]) {
    test('fail-closed: capacity ' + String(bad) + ' throws a tagged RangeError', () => {
        assert.throws(() => new Sieve(bad), (err) => {
            assert.ok(err instanceof RangeError);
            assert.match(err.message, /\[lite-lru\]/);
            return true;
        });
    });
}

test('capacity 1 works: every put evicts, head === tail, the hand goes to NIL after eviction', () => {
    let evictions = 0;
    const c = new Sieve(1, { onEvict: () => { evictions++; } });
    c.put('a', 1);
    assert.equal(c._head, c._tail);
    assert.equal(c._hand, NIL, 'a fresh (never-evicted) ring has no hand set');
    c.put('b', 2); // evicts a: the single-slot sweep, parkTarget has no prev -> NIL
    assert.equal(c._head, c._tail);
    assert.equal(c._hand, NIL, 'a capacity-1 ring parks the hand at NIL after every eviction (no prev to park on)');
    assert.equal(c.has('a'), false);
    assert.equal(c.get('b'), 2);
    assert.equal(c.size, 1);
    assert.equal(evictions, 1);
    validate(c);
    // a visited single entry still gets evicted on the next put (second chance spent
    // within its own sweep) -- capacity 1 cannot retain more than one key.
    c.get('b');
    c.put('d', 4);
    assert.equal(c.has('b'), false);
    assert.equal(c._hand, NIL, 'hand stays NIL across repeated cap-1 evictions');
    assert.equal(c.get('d'), 4);
    validate(c);
});

// --- boundary matrix: N-1 / N / N+1 fill; eviction begins exactly at N+1 -------

test('fill boundaries: N-1 (no eviction), Nth put (fills exactly), N+1th put (evicts)', () => {
    const N = 5;
    let evictions = 0;
    const c = new Sieve(N, { onEvict: () => { evictions++; } });
    for (let i = 0; i < N - 1; i++) c.put(i, i); // N-1: below capacity
    assert.equal(c.size, N - 1);
    assert.equal(evictions, 0);
    validate(c);
    c.put(N - 1, N - 1); // Nth: fills exactly
    assert.equal(c.size, N);
    assert.equal(evictions, 0);
    validate(c);
    c.put(N, N); // N+1th: over capacity -> the sweep evicts (all unvisited -> tail, key 0)
    assert.equal(c.size, N);
    assert.equal(evictions, 1, 'eviction begins exactly at the N+1th put');
    assert.equal(c.has(0), false);
    validate(c);
});

test('int backing: fill boundaries N-1 / N / N+1, eviction begins exactly at N+1', () => {
    const N = 5;
    let evictions = 0;
    const c = new Sieve(N, { keys: 'int', onEvict: () => { evictions++; } });
    for (let i = 0; i < N - 1; i++) c.put(i, i);
    assert.equal(c.size, N - 1);
    assert.equal(evictions, 0);
    validate(c);
    c.put(N - 1, N - 1);
    assert.equal(c.size, N);
    assert.equal(evictions, 0);
    validate(c);
    c.put(N, N);
    assert.equal(c.size, N);
    assert.equal(evictions, 1, 'eviction begins exactly at the N+1th put');
    assert.equal(c.has(0), false);
    validate(c);
});

// --- empty-cache reads: no throw, the miss contract, on a fresh AND a cleared cache

test('an empty (never-filled) cache misses cleanly on get/has/peek/delete (no throw)', () => {
    const c = new Sieve(4);
    assert.equal(c.size, 0);
    assert.equal(c.get('x'), undefined);
    assert.equal(c.has('x'), false);
    assert.equal(c.peek('x'), undefined);
    assert.equal(c.delete('x'), false);
    assert.equal(c._hand, NIL);
    validate(c);
});

test('a CLEARED cache misses cleanly on get/has/peek/delete (no throw)', () => {
    const c = new Sieve(4);
    c.put('a', 1); c.put('b', 2);
    c.get('a'); // set a visited bit + touch the hand path indirectly
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.get('a'), undefined);
    assert.equal(c.has('a'), false);
    assert.equal(c.peek('a'), undefined);
    assert.equal(c.delete('a'), false);
    validate(c);
});

test('int backing: an empty cache misses cleanly on get/has/peek/delete (no throw)', () => {
    const c = new Sieve(4, { keys: 'int' });
    assert.equal(c.size, 0);
    assert.equal(c.get(0), undefined);
    assert.equal(c.has(0), false);
    assert.equal(c.peek(0), undefined);
    assert.equal(c.delete(0), false);
    validate(c);
});

// --- occupancy without a key sentinel: key 0 is valid in an otherwise-empty cache

test('int backing: key 0 is a valid, storable key in an otherwise-empty cache', () => {
    const c = new Sieve(4, { keys: 'int' });
    c.put(0, 'zero');
    assert.equal(c.size, 1);
    assert.equal(c.has(0), true);
    assert.equal(c.get(0), 'zero');
    validate(c);
});

// --- clear --------------------------------------------------------------------

test('clear() empties, resets the hand to NIL, zeroes visited, stays reusable', () => {
    const c = new Sieve(4);
    for (const k of ['a', 'b', 'c', 'd']) c.put(k, k);
    c.get('a'); c.put('e', 5); // set some visited bits + park the hand
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c._hand, NIL, 'the hand resets to NIL');
    for (let i = 0; i < c._capacity; i++) assert.equal(c._vis[i], 0, 'visited byte ' + i + ' zeroed');
    validate(c);
    c.put('x', 42);
    assert.equal(c.get('x'), 42);
    assert.equal(c.size, 1);
    validate(c);
});

test('clear() soak: after EACH clear() in a churn loop, size/free-list/index all reset exactly', () => {
    const c = new Sieve(6);
    for (let cyc = 0; cyc < 50; cyc++) {
        for (let i = 0; i < 6 + cyc % 3; i++) c.put('k' + i, i); // fill, sometimes past capacity
        if (cyc % 2 === 0) c.get('k0'); // scramble visited bits on alternating cycles
        c.clear();
        assert.equal(c.size, 0, 'cycle ' + cyc + ': size not 0 after clear');
        assert.equal(c._freeListLength(), c._capacity, 'cycle ' + cyc + ': free-list length != capacity after clear');
        assert.equal(c._store.indexSize(), 0, 'cycle ' + cyc + ': index size != 0 after clear');
        assert.equal(c._hand, NIL, 'cycle ' + cyc + ': hand not NIL after clear');
        validate(c);
    }
});

// --- delete -------------------------------------------------------------------

test('delete() returns true/false and frees the slot for refill', () => {
    const c = new Sieve(3);
    c.put('a', 1); c.put('b', 2); c.put('c', 3);
    assert.equal(c.delete('b'), true);
    assert.equal(c.delete('b'), false);
    assert.equal(c.delete('nope'), false);
    assert.equal(c.size, 2);
    assert.equal(c.has('b'), false);
    validate(c);
    c.put('d', 4);
    c.put('e', 5);
    assert.equal(c.size, 3);
    assert.equal(c.get('d'), 4);
    assert.equal(c.get('e'), 5);
    validate(c);
});

test('delete() REPAIRS the hand when the hand\'s own slot dies', () => {
    const c = new Sieve(4);
    for (const k of ['a', 'b', 'c', 'd']) c.put(k, k);
    c.put('e', 5); // eviction parks the hand on some live slot
    const handSlot = c._hand;
    assert.notEqual(handSlot, NIL);
    const handKey = c._keys[handSlot];
    assert.equal(c.delete(handKey), true); // delete the hand's OWN entry
    validate(c); // the extended invariant checks the hand is in-range / in-ring / not dangling
    assert.equal(c.has(handKey), false);
    // the cache remains fully usable after the repair
    c.put('z', 26);
    assert.equal(c.get('z'), 26);
    validate(c);
});

test('delete() of the tail then head then middle keeps the ring coherent', () => {
    const c = new Sieve(5);
    for (let i = 0; i < 5; i++) c.put(i, i * 10);
    assert.equal(c.delete(0), true); // tail
    validate(c);
    assert.equal(c.delete(4), true); // head
    validate(c);
    assert.equal(c.delete(2), true); // middle
    validate(c);
    assert.equal(c.size, 2);
    assert.equal(c.get(1), 10);
    assert.equal(c.get(3), 30);
    validate(c);
});

test('conservation invariant holds after a mixed op stream', () => {
    const c = new Sieve(8);
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

// --- onEvict fire-after + reentrancy (decisions/0002, inherited) ---------------

test('onEvict fires LAST, once, with the cache consistent (size===capacity, victim gone)', () => {
    let calls = 0, sizeDuring = -1, victimPresent = null;
    const c = new Sieve(3, {
        onEvict: (k) => { calls++; sizeDuring = c.size; victimPresent = c.has(k); },
    });
    c.put('a', 1); c.put('b', 2); c.put('c', 3);
    c.put('d', 4); // evicts a
    assert.equal(calls, 1);
    assert.equal(sizeDuring, 3, 'the callback sees a full, consistent cache');
    assert.equal(victimPresent, false, 'the victim is already gone when the callback fires');
    validate(c);
});

for (const reenter of [
    { name: 'put', fn: (c) => c.put('reentrant', 999) },
    { name: 'get', fn: (c) => c.get('b') },
    { name: 'delete', fn: (c) => c.delete('b') },
    { name: 'clear', fn: (c) => c.clear() },
]) {
    test('onEvict reentrancy: a reentrant ' + reenter.name + '() throws and leaves the cache consistent', () => {
        let fired = 0;
        const c = new Sieve(3, { onEvict: () => { fired++; reenter.fn(c); } });
        c.put('a', 1); c.put('b', 2); c.put('c', 3);
        assert.throws(() => c.put('d', 4), /\[lite-lru\].*must not reenter/);
        assert.equal(fired, 1, 'onEvict fired exactly once');
        assert.ok(c.size <= 3, 'size never exceeds capacity');
        assert.equal(c.size, 3);
        assert.equal(c.has('d'), true, 'the newcomer is present');
        assert.equal(c.has('reentrant'), false, 'the rejected reentry left nothing behind');
        validate(c);
    });
}

test('onEvict reads: has() and peek() are ALLOWED inside the callback', () => {
    let ok = true, sawHas, sawPeek;
    const c = new Sieve(2, {
        onEvict: () => { try { sawHas = c.has('y'); sawPeek = c.peek('y'); } catch { ok = false; } },
    });
    c.put('x', 1); c.put('y', 2);
    c.put('z', 3); // evicts x; onEvict reads y (the consistent post-put state)
    assert.equal(ok, true);
    assert.equal(sawHas, true);
    assert.equal(sawPeek, 2);
    validate(c);
});

// --- the `keys: 'int'` substrate backing (decisions/0011) rides identically ----

test('int backing: an identical op script observes IDENTICAL results to the default backing', () => {
    const script = [
        ['put', 1, 'A'], ['put', 2, 'B'], ['put', 3, 'C'],
        ['has', 1], ['peek', 2],
        ['get', 1], // visit 1 (second chance, no reorder)
        ['put', 4, 'D'], // over capacity -> sweep-evict a victim
        ['has', 2], ['has', 4],
        ['peek', 3],
        ['delete', 3],
        ['delete', 3],
        ['put', 5, 'E'], ['put', 6, 'F'],
        ['get', 5], ['get', 6],
        ['clear'],
        ['put', 7, 'G'], ['get', 7], ['has', 8],
    ];
    function run(useInt) {
        const events = [];
        const c = new Sieve(3, {
            keys: useInt ? 'int' : undefined,
            onEvict: (k, v) => events.push(['evict', k, v]),
        });
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

test('int backing: key 0, -0 collapse, and the int32 domain bounds are valid keys', () => {
    const c = new Sieve(4, { keys: 'int' });
    c.put(0, 'zero');
    c.put(-0, 'neg');
    assert.equal(c.size, 1);
    assert.equal(c.get(0), 'neg');
    c.put(-2147483648, 'min');
    c.put(2147483647, 'max');
    assert.equal(c.get(-2147483648), 'min');
    assert.equal(c.get(2147483647), 'max');
    validate(c);
});

test('int backing: delete() frees the slot for refill; a duplicate delete returns false', () => {
    const c = new Sieve(3, { keys: 'int' });
    c.put(1, 1); c.put(2, 2); c.put(3, 3);
    assert.equal(c.delete(2), true);
    assert.equal(c.delete(2), false); // duplicate dispose: already gone
    assert.equal(c.delete(999), false); // never present
    assert.equal(c.size, 2);
    validate(c);
    c.put(4, 4); c.put(5, 5); // refill using the freed slot, back at capacity
    assert.equal(c.size, 3);
    assert.equal(c.get(4), 4);
    assert.equal(c.get(5), 5);
    validate(c);
});

const BAD_INT_KEYS = [1.5, -1.5, 'x', '0', null, undefined, NaN, Infinity, -Infinity,
    -2147483649, 2147483648, {}, [], true];

for (const bad of BAD_INT_KEYS) {
    test('int backing door: key ' + String(bad) + ' throws a [lite-lru]-tagged TypeError on every method', () => {
        const c = new Sieve(4, { keys: 'int' });
        c.put(1, 1);
        const matcher = (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /32-bit signed integer/);
            return true;
        };
        assert.throws(() => c.put(bad, 'v'), matcher, 'put');
        assert.throws(() => c.get(bad), matcher, 'get');
        assert.throws(() => c.has(bad), matcher, 'has');
        assert.throws(() => c.peek(bad), matcher, 'peek');
        assert.throws(() => c.delete(bad), matcher, 'delete');
        assert.equal(c.size, 1);
        assert.equal(c.get(1), 1);
        validate(c);
    });
}

for (const reenter of [
    { name: 'put', fn: (c) => c.put(999, 999) },
    { name: 'get', fn: (c) => c.get(2) },
    { name: 'delete', fn: (c) => c.delete(2) },
    { name: 'clear', fn: (c) => c.clear() },
]) {
    test('int backing onEvict reentrancy: a reentrant ' + reenter.name + '() throws and stays consistent', () => {
        let fired = 0;
        const c = new Sieve(3, { keys: 'int', onEvict: () => { fired++; reenter.fn(c); } });
        c.put(1, 1); c.put(2, 2); c.put(3, 3);
        assert.throws(() => c.put(4, 4), /\[lite-lru\].*must not reenter/);
        assert.equal(fired, 1);
        assert.equal(c.size, 3);
        assert.equal(c.has(4), true);
        assert.equal(c.has(999), false);
        validate(c); // also runs checkStable(): the int index buffers must never grow
    });
}

test('int backing: conservation invariant holds after a mixed op stream (heavy churn)', () => {
    const c = new Sieve(8, { keys: 'int' });
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

// --- adversarial case: backward-shift deletion across a WRAPPED cluster -------
// Mirrors Lru.test.js's own wrapped-cluster adversarial case: the planner's list
// covers the door and the happy paths but not the trickiest part of IntSlotStore's
// OWN algorithm (shared substrate, decisions/0011) -- backward-shift deletion when
// the probe cluster wraps past the end of the table (bucket `mask` -> `0` -> `1`
// ...). Force it deterministically with real keys that all hash to the LAST
// bucket. Sieve rides the identical substrate, so the same wrap hazard applies,
// PLUS the sieve-specific hand must stay coherent across the wrapped deletes.

/** Replicates Lru.js's hashInt EXACTLY (decisions/0011, a pinned formula). */
function hashIntRef(key, mask) {
    let h = Math.imul(key | 0, 0x9e3779b1) >>> 0;
    h ^= h >>> 16;
    return h & mask;
}

test('int backing adversarial: backward-shift deletion across a WRAPPED cluster stays coherent', () => {
    const cap = 3; // table size: ceil(3/0.75) = 4 -> next pow2 = 4 -> mask = 3
    const mask = 3;
    const keys = [];
    for (let k = 0; keys.length < cap; k++) {
        if (hashIntRef(k, mask) === mask) keys.push(k);
    }
    assert.equal(keys.length, cap, 'the search found enough colliding keys');

    const c = new Sieve(cap, { keys: 'int' });
    assert.equal(c._store._mask, mask, 'the table-sizing formula assumption holds');
    for (const k of keys) c.put(k, k * 10); // all collide on bucket `mask` -> wrapped cluster, no eviction yet
    validate(c);

    // Delete the first-inserted key (native bucket = mask): backward-shift must
    // pull the wrapped entries (buckets 0, 1) back across the table boundary.
    assert.equal(c.delete(keys[0]), true);
    validate(c); // reciprocity + index agreement must survive the wrap
    assert.equal(c.has(keys[0]), false);
    assert.equal(c.get(keys[1]), keys[1] * 10);
    assert.equal(c.get(keys[2]), keys[2] * 10);
    validate(c);
});

test('int backing adversarial: an eviction that parks the hand INSIDE a WRAPPED cluster stays coherent', () => {
    const cap = 3;
    const mask = 3;
    const keys = [];
    for (let k = 0; keys.length < cap; k++) {
        if (hashIntRef(k, mask) === mask) keys.push(k);
    }
    const c = new Sieve(cap, { keys: 'int' });
    for (const k of keys) c.put(k, k * 10); // fill exactly, all in the wrapped cluster
    validate(c);
    // Find a 4th key that ALSO wraps onto the same bucket, so the post-eviction
    // insert extends the same wrapped cluster rather than landing elsewhere.
    let extra = keys[cap - 1] + 1;
    while (hashIntRef(extra, mask) !== mask) extra++;
    c.put(extra, extra * 10); // over capacity: sweep-evicts (all unvisited -> tail) + parks the hand
    validate(c);
    const handSlot = c._hand;
    assert.notEqual(handSlot, NIL, 'an eviction parks the hand');
    const handKey = c._keys[handSlot];
    // Delete the hand's OWN entry while the index still holds the (still-wrapped)
    // remaining cluster: must repair the hand AND keep backward-shift coherent.
    assert.equal(c.delete(handKey), true);
    validate(c);
    assert.equal(c.has(handKey), false);
    // whichever original keys remain, the wrapped-cluster index must still resolve them
    for (const k of [...keys, extra]) {
        if (k !== handKey && c.has(k)) assert.equal(c.get(k), k * 10);
    }
    validate(c);
});

// --- adversarial case NOT in the planner's boundary matrix: a FULL-RING sweep --
// Every entry visited at once forces `_sweepVictim` to walk the ENTIRE ring (not
// just a one-hop second chance): it must clear every bit as it passes and still
// terminate at the sweep's own starting slot (documented in Lru.js's comment on
// `_sweepVictim`: "after a full ring traversal every bit is 0, so a cleared slot
// is reached"). This exercises the wrap-back-to-start branch the single-hit-then-
// evict law tests never reach.

test('adversarial: ALL entries visited forces a FULL-ring sweep; victim is the sweep start, every bit clears', () => {
    const c = new Sieve(4);
    for (const k of ['a', 'b', 'c', 'd']) c.put(k, k); // tail = a (sweep start)
    for (const k of ['a', 'b', 'c', 'd']) c.get(k); // visit EVERY entry
    for (const k of ['a', 'b', 'c', 'd']) {
        const s = c._store.get(k);
        assert.equal(c._vis[s], 1, k + ' must be visited before the sweep');
    }
    const sweepStart = c._hand !== NIL ? c._hand : c._tail;
    const startKey = c._keys[sweepStart];
    c.put('e', 5); // insert-at-capacity: every entry visited -> full-ring sweep
    assert.equal(c.has(startKey), false, 'the sweep-start entry is the victim of a full sweep');
    assert.equal(c.has('e'), true);
    assert.equal(c.size, 4);
    // Every surviving entry's bit was cleared by the traversal (second chances spent).
    for (const k of ['a', 'b', 'c', 'd']) {
        if (k === startKey) continue;
        const s = c._store.get(k);
        assert.equal(c._vis[s], 0, k + ' should have been cleared by the full-ring sweep');
    }
    validate(c);
});

// --- cross-check against the independent SIEVE oracle (both backings) ----------
// A self-contained differential (no torture peers) proving `Sieve` matches an
// independent brute-force SIEVE across a fuzz stream: same value AND same next
// victim AND same size after every op, on the default AND the int backing.

test('both backings match an independent SIEVE oracle over a fuzz stream', () => {
    for (const useInt of [false, true]) {
        const cap = 8, keyspace = 24;
        const c = new Sieve(cap, useInt ? { keys: 'int' } : undefined);
        const o = makeSieveOracle(cap);
        let x = 0x1234567 >>> 0;
        const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x >>> 0; };
        for (let i = 0; i < 20000; i++) {
            const kind = rnd() % 5;
            const key = rnd() % keyspace;
            const val = rnd() >>> 0;
            let rv, ov;
            if (kind === 0) { rv = c.get(key); ov = o.get(key); }
            else if (kind === 1) { c.put(key, val); o.put(key, val); rv = ov = undefined; }
            else if (kind === 2) { rv = c.delete(key); ov = o.delete(key); }
            else if (kind === 3) { rv = c.has(key); ov = o.has(key); }
            else { rv = c.peek(key); ov = o.peek(key); }
            assert.ok(Object.is(rv, ov), 'value mismatch at op ' + i + ' (int=' + useInt + ')');
            assert.equal(c.size, o.size(), 'size mismatch at op ' + i + ' (int=' + useInt + ')');
            assert.equal(c._peekVictim(), o.victim(), 'victim mismatch at op ' + i + ' (int=' + useInt + ')');
            validate(c);
        }
    }
});
