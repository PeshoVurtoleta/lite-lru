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
    assert.equal(VERSION, '0.1.0');
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
