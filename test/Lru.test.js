/**
 * @zakkster/lite-lru -- node:test boundary suite (classic LRU semantics).
 *
 * Every public method and every recency LAW is named as a test so a refactor
 * cannot silently flip the policy (ROADMAP law 5). validate() (the conservation
 * invariant) runs after mutating tests as a structural backstop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiteLru, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';

/** The key at the LRU (tail) -- the next eviction victim. Test-only introspection. */
function victim(c) {
    return c._tail === -1 ? undefined : c._keys[c._tail];
}

test('exports: VERSION and both named + default export are LiteLru', async () => {
    assert.equal(VERSION, '1.15.0');
    const mod = await import('../Lru.js');
    assert.equal(mod.LiteLru, LiteLru);
    assert.equal(mod.default, LiteLru);
});

test('getters: size and capacity reflect state', () => {
    const c = new LiteLru(3);
    assert.equal(c.capacity, 3);
    assert.equal(c.size, 0);
    c.put('a', 1);
    assert.equal(c.size, 1);
    validate(c);
});

test('put/get: basic round-trip', () => {
    const c = new LiteLru(4);
    c.put('a', 1);
    c.put('b', 2);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('b'), 2);
    assert.equal(c.get('missing'), undefined);
    validate(c);
});

// --- recency LAWS (T0), named -------------------------------------------------

test('law: get PROMOTES the key to MRU', () => {
    const c = new LiteLru(3);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // tail = a
    assert.equal(victim(c), 'a');
    assert.equal(c.get('a'), 1); // promote a
    assert.equal(victim(c), 'b'); // now b is LRU
    assert.equal(c._keys[c._head], 'a'); // a is MRU
    validate(c);
});

test('law: get PROMOTES the key to MRU -- observable via a SUBSEQUENT EVICTION (black-box, not just a return value or internal tail)', () => {
    let evictedKey;
    const c = new LiteLru(3, { onEvict: (k) => { evictedKey = k; } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // LRU order (tail->head): a, b, c
    c.get('a'); // promote a to MRU -- if this is a no-op, 'a' stays the next victim
    c.put('d', 4); // fill to capacity+1 -> must evict the CURRENT LRU
    // Without promotion the victim would be 'a' (the original tail). Promotion
    // means 'b' is now the LRU, so 'b' -- not 'a' -- must be the one evicted.
    assert.equal(evictedKey, 'b');
    assert.equal(c.has('a'), true); // survived because it was promoted
    assert.equal(c.has('b'), false); // evicted
    assert.equal(c.get('a'), 1);
    validate(c);
});

test('law: put(new) PROMOTES the newcomer to MRU', () => {
    const c = new LiteLru(3);
    c.put('a', 1); c.put('b', 2);
    c.put('c', 3);
    assert.equal(c._keys[c._head], 'c');
    validate(c);
});

test('law: put(update existing) PROMOTES to MRU and keeps size', () => {
    const c = new LiteLru(3);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // tail = a
    c.put('a', 11); // update a -> promote
    assert.equal(c.get('a'), 11);
    assert.equal(c._keys[c._head], 'a');
    assert.equal(victim(c), 'b');
    assert.equal(c.size, 3);
    validate(c);
});

test('law: has() is recency-NEUTRAL', () => {
    const c = new LiteLru(3);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // tail = a
    const v = victim(c);
    assert.equal(c.has('a'), true);
    assert.equal(c.has('zzz'), false);
    assert.equal(victim(c), v); // unchanged
    validate(c);
});

test('law: peek() is recency-NEUTRAL', () => {
    const c = new LiteLru(3);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // tail = a
    const v = victim(c);
    assert.equal(c.peek('a'), 1);
    assert.equal(c.peek('zzz'), undefined);
    assert.equal(victim(c), v); // unchanged
    validate(c);
});

test('law: at capacity, a new key evicts EXACTLY the LRU and fires onEvict once', () => {
    let calls = 0;
    let seenKey, seenVal;
    const c = new LiteLru(3, { onEvict: (k, v) => { calls++; seenKey = k; seenVal = v; } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // tail = a
    c.put('d', 4); // must evict a
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
    const c = new LiteLru(4);
    c.put('k', undefined);
    assert.equal(c.get('k'), undefined); // stored undefined
    assert.equal(c.get('absent'), undefined); // miss
    // has() disambiguates:
    assert.equal(c.has('k'), true);
    assert.equal(c.has('absent'), false);
    // peek() returns undefined for BOTH:
    assert.equal(c.peek('k'), undefined);
    assert.equal(c.peek('absent'), undefined);
    validate(c);
});

// --- SameValueZero key semantics ----------------------------------------------

test('keys: 0 and -0 collapse to one entry (SameValueZero)', () => {
    const c = new LiteLru(4);
    c.put(0, 'zero');
    c.put(-0, 'neg');
    assert.equal(c.size, 1);
    assert.equal(c.get(0), 'neg');
    validate(c);
});

test('keys: NaN is a single usable key', () => {
    const c = new LiteLru(4);
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
        assert.throws(() => new LiteLru(bad), (err) => {
            assert.ok(err instanceof RangeError);
            assert.match(err.message, /\[lite-lru\]/);
            return true;
        });
    });
}

test('capacity 1 works: every put evicts, head === tail', () => {
    let evictions = 0;
    const c = new LiteLru(1, { onEvict: () => { evictions++; } });
    c.put('a', 1);
    assert.equal(c._head, c._tail);
    c.put('b', 2); // evicts a
    assert.equal(c._head, c._tail);
    assert.equal(c.has('a'), false);
    assert.equal(c.get('b'), 2);
    assert.equal(c.size, 1);
    assert.equal(evictions, 1);
    validate(c);
});

// --- clear --------------------------------------------------------------------

test('clear() empties, resets size, and leaves the cache reusable', () => {
    const c = new LiteLru(4);
    c.put('a', 1); c.put('b', 2); c.put('c', 3);
    c.get('a'); // scramble recency
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.has('a'), false);
    assert.equal(c.get('a'), undefined);
    validate(c);
    // reusable after clear:
    c.put('x', 42);
    assert.equal(c.get('x'), 42);
    assert.equal(c.size, 1);
    validate(c);
});

// --- delete -------------------------------------------------------------------

test('delete() returns true/false and frees the slot for refill', () => {
    const c = new LiteLru(3);
    c.put('a', 1); c.put('b', 2); c.put('c', 3);
    assert.equal(c.delete('b'), true);
    assert.equal(c.delete('b'), false); // already gone
    assert.equal(c.delete('nope'), false);
    assert.equal(c.size, 2);
    assert.equal(c.has('b'), false);
    validate(c);
    // the cache can sit below capacity, then refill using the freed slot:
    c.put('d', 4);
    c.put('e', 5); // back at capacity 3
    assert.equal(c.size, 3);
    assert.equal(c.get('d'), 4);
    assert.equal(c.get('e'), 5);
    validate(c);
});

test('delete() of the tail then head then middle keeps the list coherent', () => {
    const c = new LiteLru(5);
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
    const c = new LiteLru(8);
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

// --- onEvict reentrancy contract (decisions/0002) -----------------------------
// The classic-core defect S1 qa found: an onEvict that reenters a mutating method
// while an eviction is in flight corrupted the lists (size > capacity, phantom
// slot -1, validate() hang). The fix fires onEvict LAST (cache consistent) and
// fail-closes on reentrant mutation. Pin BOTH: the throw AND the surviving state.

for (const reenter of [
    { name: 'put', fn: (c) => c.put('reentrant', 999) },
    { name: 'get', fn: (c) => c.get('b') },
    { name: 'delete', fn: (c) => c.delete('b') },
    { name: 'clear', fn: (c) => c.clear() },
]) {
    test('onEvict reentrancy: a reentrant ' + reenter.name + '() throws and leaves the cache consistent', () => {
        let fired = 0;
        const c = new LiteLru(3, { onEvict: () => { fired++; reenter.fn(c); } });
        c.put('a', 1); c.put('b', 2); c.put('c', 3); // tail = a
        // The evicting put triggers onEvict, which reenters -> the reentry throws,
        // and that error propagates out of this put().
        assert.throws(() => c.put('d', 4), /\[lite-lru\].*must not reenter/);
        assert.equal(fired, 1, 'onEvict fired exactly once');
        // Fail CLOSED: the outer put completed before the callback, so the cache is
        // whole -- not the size>capacity / phantom-slot corruption of the old bug.
        assert.ok(c.size <= 3, 'size never exceeds capacity');
        assert.equal(c.size, 3);
        assert.equal(c.has('d'), true, 'the newcomer is present');
        assert.equal(c.has('a'), false, 'the victim is gone');
        assert.equal(c.has('reentrant'), false, 'the rejected reentry left nothing behind');
        validate(c); // must not throw and must not hang
    });
}

test('onEvict reads: has() and peek() are ALLOWED inside the callback', () => {
    let ok = true;
    let sawHas, sawPeek;
    const c = new LiteLru(2, {
        onEvict: () => {
            try { sawHas = c.has('y'); sawPeek = c.peek('y'); }
            catch { ok = false; }
        },
    });
    c.put('x', 1); c.put('y', 2); // fill
    c.put('z', 3); // evicts x; onEvict reads y (the newcomer-consistent state)
    assert.equal(ok, true, 'has()/peek() did not throw inside onEvict');
    assert.equal(sawHas, true);
    assert.equal(sawPeek, 2);
    validate(c);
});

test('onEvict fires when the cache is already consistent (fire-after, decisions/0002)', () => {
    // A well-behaved callback that inspects the cache sees the FINAL state: the
    // newcomer inserted, size back at capacity, the victim already removed.
    let sizeDuring = -1;
    let victimStillPresent = null;
    const c = new LiteLru(2, {
        onEvict: (k) => { sizeDuring = c.size; victimStillPresent = c.has(k); },
    });
    c.put('x', 10); c.put('y', 20);
    c.put('z', 30); // evicts x
    assert.equal(sizeDuring, 2, 'callback sees a full, consistent cache');
    assert.equal(victimStillPresent, false, 'the victim is already removed when the callback fires');
    validate(c);
});

// --- S3 coverage gap: the `keys: 'int'` substrate backing (decisions/0011) ----
// test/torture proves this backing only via t5/t6/t9; none of that runs under
// `npm test`. This block pins the same node:test-level contract directly.

/** Replicates Lru.js's hashInt EXACTLY (decisions/0011, a pinned formula) so a
 *  test can construct adversarial key sets (e.g. a forced wrapped cluster)
 *  without reaching into IntSlotStore internals beyond its documented mask. */
function hashIntRef(key, mask) {
    let h = Math.imul(key | 0, 0x9e3779b1) >>> 0;
    h ^= h >>> 16;
    return h & mask;
}

// --- parity: an identical integer-key op script yields identical observable
// results on both backings (get/put promotion, has/peek neutrality, eviction
// key+value, delete freeing + refill, clear + reuse) -----------------------

test('int backing: an identical op script observes IDENTICAL results to the default backing', () => {
    const script = [
        ['put', 1, 'A'], ['put', 2, 'B'], ['put', 3, 'C'], // fill capacity 3, tail = 1
        ['has', 1], ['peek', 2],
        ['get', 1], // promote 1 to MRU -- tail becomes 2
        ['put', 4, 'D'], // over capacity -> evicts 2 (the new LRU), not 1
        ['has', 2], ['has', 4],
        ['peek', 3],
        ['delete', 3], // frees a slot below capacity
        ['delete', 3], // duplicate delete: already gone
        ['put', 5, 'E'], ['put', 6, 'F'], // refill using the freed slot, back at capacity
        ['get', 5], ['get', 6],
        ['clear'],
        ['put', 7, 'G'], ['get', 7], ['has', 8],
    ];

    function run(useInt) {
        const events = [];
        const c = new LiteLru(3, {
            keys: useInt ? 'int' : undefined,
            onEvict: (k, v) => events.push(['evict', k, v]),
        });
        for (const [kind, a, b] of script) {
            if (kind === 'put') { c.put(a, b); events.push(['put', c.size]); }
            else if (kind === 'get') events.push(['get', c.get(a)]);
            else if (kind === 'has') events.push(['has', c.has(a)]);
            else if (kind === 'peek') events.push(['peek', c.peek(a)]);
            else if (kind === 'delete') events.push(['delete', c.delete(a)]);
            else /* clear */ { c.clear(); events.push(['clear', c.size]); }
            validate(c);
        }
        return events;
    }

    assert.deepEqual(run(true), run(false));
});

// --- explicit int-backing pins, mirroring the classic-backing LAW tests above -

test('int backing law: get() PROMOTES to MRU, observable via a subsequent eviction', () => {
    let evictedKey;
    const c = new LiteLru(3, { keys: 'int', onEvict: (k) => { evictedKey = k; } });
    c.put(1, 1); c.put(2, 2); c.put(3, 3); // LRU order (tail->head): 1, 2, 3
    c.get(1); // promote 1 -- if a no-op, 1 stays the next victim
    c.put(4, 4); // must evict the CURRENT LRU (2), not 1
    assert.equal(evictedKey, 2);
    assert.equal(c.has(1), true);
    assert.equal(c.has(2), false);
    validate(c);
});

test('int backing law: put(new) PROMOTES the newcomer to MRU; put(update) PROMOTES + keeps size', () => {
    const c = new LiteLru(3, { keys: 'int' });
    c.put(1, 1); c.put(2, 2); c.put(3, 3);
    assert.equal(c._keys[c._head], 3); // newcomer is MRU
    c.put(1, 11); // update -> promote
    assert.equal(c.get(1), 11);
    assert.equal(c._keys[c._head], 1);
    assert.equal(c.size, 3);
    validate(c);
});

test('int backing law: has()/peek() are recency-NEUTRAL', () => {
    const c = new LiteLru(3, { keys: 'int' });
    c.put(1, 1); c.put(2, 2); c.put(3, 3);
    const victimBefore = c._keys[c._tail];
    assert.equal(c.has(1), true);
    assert.equal(c.has(999), false);
    assert.equal(c.peek(2), 2);
    assert.equal(c.peek(999), undefined);
    assert.equal(c._keys[c._tail], victimBefore); // unchanged
    validate(c);
});

test('int backing law: at capacity a new key evicts EXACTLY the LRU and fires onEvict once', () => {
    let calls = 0, seenKey, seenVal;
    const c = new LiteLru(3, { keys: 'int', onEvict: (k, v) => { calls++; seenKey = k; seenVal = v; } });
    c.put(1, 10); c.put(2, 20); c.put(3, 30); // tail = 1
    c.put(4, 40); // must evict 1
    assert.equal(calls, 1);
    assert.equal(seenKey, 1);
    assert.equal(seenVal, 10);
    assert.equal(c.has(1), false);
    assert.equal(c.has(4), true);
    assert.equal(c.size, 3);
    validate(c);
});

test('int backing: delete() frees the slot for refill; a duplicate delete returns false', () => {
    const c = new LiteLru(3, { keys: 'int' });
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

test('int backing: clear() empties, resets size, and leaves the cache reusable', () => {
    const c = new LiteLru(3, { keys: 'int' });
    c.put(1, 1); c.put(2, 2); c.put(3, 3);
    c.get(1); // scramble recency
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.has(1), false);
    assert.equal(c.get(1), undefined);
    validate(c);
    c.put(42, 420);
    assert.equal(c.get(42), 420);
    assert.equal(c.size, 1);
    validate(c);
});

// --- boundary matrix: capacity 0/1/N-1/N/N+1, and the empty cache -------------

test('int backing: capacity 1 works: every put evicts, head === tail', () => {
    let evictions = 0;
    const c = new LiteLru(1, { keys: 'int', onEvict: () => { evictions++; } });
    c.put(1, 'a');
    assert.equal(c._head, c._tail);
    c.put(2, 'b'); // evicts 1
    assert.equal(c._head, c._tail);
    assert.equal(c.has(1), false);
    assert.equal(c.get(2), 'b');
    assert.equal(evictions, 1);
    validate(c);
});

test('int backing: N-1 fill (no eviction), Nth put (fills exactly), N+1th put (evicts)', () => {
    const N = 5;
    let evictions = 0;
    const c = new LiteLru(N, { keys: 'int', onEvict: () => { evictions++; } });
    for (let i = 0; i < N - 1; i++) c.put(i, i); // N-1: below capacity
    assert.equal(c.size, N - 1);
    assert.equal(evictions, 0);
    validate(c);
    c.put(N - 1, N - 1); // Nth: fills exactly
    assert.equal(c.size, N);
    assert.equal(evictions, 0);
    validate(c);
    c.put(N, N); // N+1th: over capacity -> evicts the LRU (key 0)
    assert.equal(c.size, N);
    assert.equal(evictions, 1);
    assert.equal(c.has(0), false);
    validate(c);
});

test('int backing: an empty cache misses cleanly on get/has/peek/delete (no throw)', () => {
    const c = new LiteLru(4, { keys: 'int' });
    assert.equal(c.size, 0);
    assert.equal(c.get(0), undefined);
    assert.equal(c.has(0), false);
    assert.equal(c.peek(0), undefined);
    assert.equal(c.delete(0), false);
    validate(c);
});

// --- occupancy without a key sentinel: 0, -0, and the int32 bounds are a VALID
// key domain (decisions/0011: occupancy is slot!=NIL, never a key sentinel) ---

test('int backing: key 0 is a valid, storable key in an otherwise-empty cache', () => {
    const c = new LiteLru(4, { keys: 'int' });
    c.put(0, 'zero');
    assert.equal(c.size, 1);
    assert.equal(c.has(0), true);
    assert.equal(c.get(0), 'zero');
    validate(c);
});

test('int backing: 0 and -0 collapse to one entry, mirroring the default backing', () => {
    const c = new LiteLru(4, { keys: 'int' });
    c.put(0, 'zero');
    c.put(-0, 'neg');
    assert.equal(c.size, 1);
    assert.equal(c.get(0), 'neg');
    assert.equal(c.get(-0), 'neg');
    validate(c);
});

test('int backing: the int32 domain bounds are ACCEPTED, not rejected', () => {
    const c = new LiteLru(4, { keys: 'int' });
    c.put(-2147483648, 'min');
    c.put(2147483647, 'max');
    assert.equal(c.size, 2);
    assert.equal(c.get(-2147483648), 'min');
    assert.equal(c.get(2147483647), 'max');
    validate(c);
});

// --- the int-mode fail-closed door: a non-integer / out-of-domain key throws --

const BAD_INT_KEYS = [1.5, -1.5, 'x', '0', null, undefined, NaN, Infinity, -Infinity,
    -2147483649, 2147483648, {}, [], true];

for (const bad of BAD_INT_KEYS) {
    test('int backing door: key ' + String(bad) + ' throws a [lite-lru]-tagged TypeError on every method', () => {
        const c = new LiteLru(4, { keys: 'int' });
        c.put(1, 1); // a valid entry so get/has/peek/delete have something to reach past
        const matcher = (err) => {
            assert.ok(err instanceof TypeError, 'must be a TypeError, not RangeError/generic Error');
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /32-bit signed integer/);
            return true;
        };
        assert.throws(() => c.put(bad, 'v'), matcher, 'put');
        assert.throws(() => c.get(bad), matcher, 'get');
        assert.throws(() => c.has(bad), matcher, 'has');
        assert.throws(() => c.peek(bad), matcher, 'peek');
        assert.throws(() => c.delete(bad), matcher, 'delete');
        // fail-closed: the rejected key never got in, and the valid entry survives.
        assert.equal(c.size, 1);
        assert.equal(c.get(1), 1);
        validate(c);
    });
}

// --- onEvict reentrancy contract (decisions/0002) holds on the int backing too -

for (const reenter of [
    { name: 'put', fn: (c) => c.put(999, 999) },
    { name: 'get', fn: (c) => c.get(2) },
    { name: 'delete', fn: (c) => c.delete(2) },
    { name: 'clear', fn: (c) => c.clear() },
]) {
    test('int backing onEvict reentrancy: a reentrant ' + reenter.name + '() throws and leaves the cache consistent', () => {
        let fired = 0;
        const c = new LiteLru(3, { keys: 'int', onEvict: () => { fired++; reenter.fn(c); } });
        c.put(1, 1); c.put(2, 2); c.put(3, 3); // tail = 1
        assert.throws(() => c.put(4, 4), /\[lite-lru\].*must not reenter/);
        assert.equal(fired, 1, 'onEvict fired exactly once');
        assert.ok(c.size <= 3, 'size never exceeds capacity');
        assert.equal(c.size, 3);
        assert.equal(c.has(4), true, 'the newcomer is present');
        assert.equal(c.has(1), false, 'the victim is gone');
        assert.equal(c.has(999), false, 'the rejected reentry left nothing behind');
        validate(c); // must not throw and must not hang -- also runs checkStable()
    });
}

// --- heavy churn on a small int cache stays conservation-correct -------------

test('int backing: conservation invariant holds after a mixed op stream (heavy churn)', () => {
    const c = new LiteLru(8, { keys: 'int' });
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
        validate(c); // includes checkStable(): the int index buffers must never grow
    }
});

// --- adversarial case: backward-shift deletion across a WRAPPED cluster ------
// The planner's list covers the door and the happy paths but not the trickiest
// part of IntSlotStore's own algorithm: backward-shift deletion when the probe
// cluster wraps past the end of the table (bucket `mask` -> `0` -> `1` ...).
// Force it deterministically by finding real keys that all hash to the LAST
// bucket, so their cluster is guaranteed to wrap when probed.

test('int backing adversarial: backward-shift deletion across a WRAPPED cluster stays coherent', () => {
    const cap = 3; // table size: ceil(3/0.75) = 4 -> next pow2 = 4 -> mask = 3
    const mask = 3;
    const keys = [];
    for (let k = 0; keys.length < cap; k++) {
        if (hashIntRef(k, mask) === mask) keys.push(k);
    }
    assert.equal(keys.length, cap, 'the search found enough colliding keys');

    const c = new LiteLru(cap, { keys: 'int' });
    assert.equal(c._store._mask, mask, 'the table-sizing formula assumption holds');
    for (const k of keys) c.put(k, k * 10); // all collide on bucket `mask` -> wrapped cluster
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
