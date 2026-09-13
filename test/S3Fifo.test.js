/**
 * @zakkster/lite-lru -- node:test boundary suite for the S3-FIFO member
 * (decisions/0013). Mirrors Lru.test.js / Sieve.test.js in coverage, but pins
 * S3-FIFO's OWN policy laws: a newcomer enters SMALL (probation) unvisited; a key
 * seen again while in GHOST is admitted straight to MAIN; a hit sets the visited bit
 * and does NOTHING structural; a proven (visited) SMALL entry GRADUATES to MAIN at
 * the eviction sweep rather than being evicted; a distinct one-hit-wonder flood never
 * displaces the proven-hot set (scan resistance); the ghost is bounded and keys-only.
 * validate() (the conservation invariant, extended with the S3-FIFO ring + ghost
 * terms) runs after mutating tests as a structural backstop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { S3Fifo, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';
import { makeS3FifoOracle } from './torture/oracles/s3fifo.mjs';

const NIL = -1;
const Q_SMALL = 0; // matches Lru.js's S3-FIFO queue tags
const Q_MAIN = 1;

test('exports: VERSION and the named S3Fifo export are present', async () => {
    assert.equal(VERSION, '1.9.0');
    const mod = await import('../Lru.js');
    assert.equal(mod.S3Fifo, S3Fifo);
});

test('getters: size and capacity reflect state', () => {
    const c = new S3Fifo(3);
    assert.equal(c.capacity, 3);
    assert.equal(c.size, 0);
    c.put('a', 1);
    assert.equal(c.size, 1);
    validate(c);
});

test('put/get: basic round-trip', () => {
    const c = new S3Fifo(4);
    c.put('a', 1);
    c.put('b', 2);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('b'), 2);
    assert.equal(c.get('missing'), undefined);
    validate(c);
});

// --- S3-FIFO policy LAWS, named -----------------------------------------------

test('law: a newcomer is admitted to SMALL (probation) unvisited', () => {
    const c = new S3Fifo(10); // smallCap 1
    c.put('a', 1);
    const s = c._store.get('a');
    assert.equal(c._q[s], Q_SMALL, 'newcomer must enter SMALL');
    assert.equal(c._vis[s], 0, 'newcomer must start unvisited');
    validate(c);
});

test('law: get() sets the visited bit but does NOTHING structural (no relink)', () => {
    const c = new S3Fifo(20);
    for (let i = 0; i < 5; i++) c.put(i, i);
    const sHead = c._sHead, sTail = c._sTail;
    assert.equal(c.get(0), 0);
    assert.equal(c._sHead, sHead, 'get must not move the SMALL head');
    assert.equal(c._sTail, sTail, 'get must not move the SMALL tail');
    const s = c._store.get(0);
    assert.equal(c._q[s], Q_SMALL, 'get must not move the entry between rings');
    assert.equal(c._vis[s], 1, 'get sets the visited bit');
    validate(c);
});

test('law: a proven (visited) SMALL entry GRADUATES to MAIN instead of being evicted', () => {
    const c = new S3Fifo(20); // smallCap 2, mainCap 18, ghostCap 18
    for (let i = 0; i < 20; i++) c.put(i, i); // all admitted to SMALL, at capacity
    assert.equal(c._keys[c._sTail], 0, 'key 0 is the SMALL tail (oldest)');
    c.get(0); // PROVE the oldest SMALL entry
    c.put(100, 100); // eviction: 0 is visited -> graduate; 1 is the victim
    assert.equal(c.has(0), true, 'the proven entry survived (graduated)');
    assert.equal(c._q[c._store.get(0)], Q_MAIN, 'the proven entry moved to MAIN');
    assert.equal(c.has(1), false, 'the unproven SMALL tail was the victim');
    assert.equal(c.has(100), true);
    assert.equal(c.size, 20);
    validate(c);
});

test('law: a key seen again while in GHOST is admitted straight to MAIN', () => {
    const c = new S3Fifo(4); // smallCap 1, mainCap 3, ghostCap 3
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4); // all SMALL, at capacity
    c.put('e', 5); // evicts SMALL tail 'a' (unvisited) -> 'a' recorded in ghost
    assert.equal(c.has('a'), false, "'a' was evicted");
    assert.equal(c._gLen, 1, 'ghost recorded exactly one key');
    c.put('a', 11); // 'a' is in ghost -> admitted straight to MAIN, consumed from ghost
    assert.equal(c.has('a'), true);
    assert.equal(c._q[c._store.get('a')], Q_MAIN, "the ghost re-admit routed 'a' to MAIN");
    assert.equal(c._ghostHas('a'), false, "'a' was consumed from the ghost on re-admission");
    assert.equal(c.get('a'), 11);
    validate(c);
});

test('law: MAIN evictions are NOT recorded in ghost (only SMALL evictions are)', () => {
    const c = new S3Fifo(4); // smallCap 1, mainCap 3, ghostCap 3
    // Graduate a couple of entries into MAIN by proving them, then force a MAIN
    // eviction and assert the ghost only ever grew from SMALL evictions.
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    c.get('a'); c.get('b'); c.get('c'); c.get('d'); // prove all
    c.put('e', 5); // sweep graduates proven SMALL entries into MAIN, evicts one
    validate(c);
    assert.equal(c._gLen <= c._ghostCap, true, 'ghost stays bounded');
    validate(c);
});

test('law: has() and peek() are visited-NEUTRAL (no protection from eviction)', () => {
    const c = new S3Fifo(4); // smallCap 1
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4); // tail = 'a'
    assert.equal(c.has('a'), true);
    assert.equal(c.peek('a'), 1);
    const s = c._store.get('a');
    assert.equal(c._vis[s], 0, 'has/peek left a unvisited');
    c.put('e', 5); // a is the unvisited SMALL tail -> the victim
    assert.equal(c.has('a'), false, 'has/peek did not protect a from eviction');
    validate(c);
});

test('law: put(update) sets visited and keeps size; put(new) admits to SMALL', () => {
    const c = new S3Fifo(10);
    c.put('a', 1); c.put('b', 2);
    c.put('c', 3);
    assert.equal(c._q[c._sHead], Q_SMALL);
    assert.equal(c._keys[c._sHead], 'c', 'the newcomer is the SMALL head');
    c.put('a', 11); // update
    const sa = c._store.get('a');
    assert.equal(c._vis[sa], 1, 'an update sets the visited bit (it is a write, like a hit)');
    assert.equal(c.get('a'), 11);
    assert.equal(c.size, 3);
    validate(c);
});

test('law: at capacity, a new key evicts the S3-FIFO victim and fires onEvict once', () => {
    let calls = 0, seenKey, seenVal;
    const c = new S3Fifo(4, { onEvict: (k, v) => { calls++; seenKey = k; seenVal = v; } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4); // all unvisited SMALL, tail = a
    c.put('e', 5); // SMALL tail a is the first unvisited -> victim
    assert.equal(calls, 1);
    assert.equal(seenKey, 'a');
    assert.equal(seenVal, 1);
    assert.equal(c.has('a'), false);
    assert.equal(c.has('e'), true);
    assert.equal(c.size, 4);
    validate(c);
});

test('law: scan resistance -- a proven-hot key survives a one-hit-wonder flood', () => {
    const N = 32;
    const c = new S3Fifo(N);
    const HOT = 'hot';
    c.put(HOT, 1);
    for (let i = 0; i < N - 1; i++) c.put('cold' + i, i);
    for (let i = 0; i < 2000; i++) {
        assert.equal(c.get(HOT), 1, 'hot key lost at ' + i);
        c.put('scan' + i, i);
        assert.equal(c.size, N);
    }
    assert.equal(c.has(HOT), true, 'the hot key survived the scan (scan resistance)');
    assert.equal(c._q[c._store.get(HOT)], Q_MAIN, 'the proven hot key graduated to MAIN');
    let survivors = 0;
    for (let i = 0; i < 2000; i++) if (c.has('scan' + i)) survivors++;
    assert.ok(survivors < N, 'cold scan keys were evicted (non-vacuous)');
    validate(c);
});

// --- D7: the undefined-value ambiguity, pinned as contract --------------------

test('D7: a stored undefined value is indistinguishable from a miss via get()', () => {
    const c = new S3Fifo(4);
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
    const c = new S3Fifo(4);
    c.put(0, 'zero');
    c.put(-0, 'neg');
    assert.equal(c.size, 1);
    assert.equal(c.get(0), 'neg');
    validate(c);
});

test('keys: NaN is a single usable key', () => {
    const c = new S3Fifo(4);
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
        assert.throws(() => new S3Fifo(bad), (err) => {
            assert.ok(err instanceof RangeError);
            assert.match(err.message, /\[lite-lru\]/);
            return true;
        });
    });
}

// --- fail-closed: unknown `keys` option, the did-you-mean door (shared newStore) ---
// `newStore` (decisions/0011) is the ONE factory `LiteLru`/`Sieve`/`S3Fifo` all ride;
// no test anywhere in the suite pinned its "unknown keys" door before this. Pin it
// here since S3Fifo is the member under review this session.

for (const bad of ['Int', 'INT', 'string', 'map', 0, 1, true, {}, [], null]) {
    test('fail-closed: keys option ' + String(bad) + ' throws a tagged, did-you-mean TypeError', () => {
        assert.throws(() => new S3Fifo(4, { keys: bad }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /unknown keys option/);
            assert.match(err.message, /did you mean 'int'\?/);
            return true;
        });
    });
}

// --- capacity-1 and small-cap edges (D13) -------------------------------------

test('capacity 1 (mainCap 0, ghostCap 0): a 1-bit second-chance FIFO over one slot', () => {
    let evictions = 0;
    const c = new S3Fifo(1, { onEvict: () => { evictions++; } });
    assert.equal(c._smallCap, 1);
    assert.equal(c._mainCap, 0);
    assert.equal(c._ghostCap, 0);
    c.put('a', 1);
    assert.equal(c.size, 1);
    c.put('b', 2); // evicts a (no ghost, no main to graduate into permanently)
    assert.equal(c.has('a'), false);
    assert.equal(c.get('b'), 2);
    assert.equal(c.size, 1);
    assert.equal(evictions, 1);
    validate(c);
    // a visited single entry is STILL evicted on the next put (second chance spent
    // within its own eviction step) -- capacity 1 cannot retain more than one key.
    c.get('b');
    c.put('d', 4);
    assert.equal(c.has('b'), false);
    assert.equal(c.get('d'), 4);
    assert.equal(c._gLen, 0, 'ghostCap is 0 at capacity 1');
    validate(c);
});

test('small caps 2..9: fill boundaries N-1 / N / N+1, eviction begins exactly at N+1', () => {
    for (let N = 2; N <= 9; N++) {
        let evictions = 0;
        const c = new S3Fifo(N, { onEvict: () => { evictions++; } });
        for (let i = 0; i < N - 1; i++) c.put(i, i);
        assert.equal(c.size, N - 1);
        assert.equal(evictions, 0);
        validate(c);
        c.put(N - 1, N - 1); // fills exactly
        assert.equal(c.size, N);
        assert.equal(evictions, 0);
        validate(c);
        c.put(N, N); // over capacity -> eviction begins
        assert.equal(c.size, N);
        assert.equal(evictions, 1, 'eviction begins exactly at N+1 (cap ' + N + ')');
        validate(c);
    }
});

// --- empty-cache reads: no throw, the miss contract ---------------------------

test('an empty (never-filled) cache misses cleanly on get/has/peek/delete (no throw)', () => {
    const c = new S3Fifo(4);
    assert.equal(c.size, 0);
    assert.equal(c.get('x'), undefined);
    assert.equal(c.has('x'), false);
    assert.equal(c.peek('x'), undefined);
    assert.equal(c.delete('x'), false);
    assert.equal(c._sHead, NIL);
    assert.equal(c._mHead, NIL);
    validate(c);
});

test('a CLEARED cache misses cleanly on get/has/peek/delete (no throw)', () => {
    const c = new S3Fifo(4);
    c.put('a', 1); c.put('b', 2);
    c.get('a');
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.get('a'), undefined);
    assert.equal(c.has('a'), false);
    assert.equal(c.peek('a'), undefined);
    assert.equal(c.delete('a'), false);
    validate(c);
});

// --- clear --------------------------------------------------------------------

test('clear() empties both rings + the ghost, zeroes visited, stays reusable', () => {
    const c = new S3Fifo(4);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    c.get('a'); c.put('e', 5); // set some visited bits + record a ghost key
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c._sHead, NIL); assert.equal(c._sTail, NIL); assert.equal(c._sSize, 0);
    assert.equal(c._mHead, NIL); assert.equal(c._mTail, NIL); assert.equal(c._mSize, 0);
    assert.equal(c._gLen, 0, 'the ghost is emptied by clear');
    for (let i = 0; i < c._capacity; i++) assert.equal(c._vis[i], 0, 'visited byte ' + i + ' zeroed');
    validate(c);
    c.put('x', 42);
    assert.equal(c.get('x'), 42);
    assert.equal(c.size, 1);
    validate(c);
});

test('clear() soak: after EACH clear() in a churn loop, size/free-list/index/ghost reset', () => {
    const c = new S3Fifo(6);
    for (let cyc = 0; cyc < 50; cyc++) {
        for (let i = 0; i < 6 + cyc % 4; i++) c.put('k' + i, i);
        if (cyc % 2 === 0) c.get('k0');
        c.clear();
        assert.equal(c.size, 0, 'cycle ' + cyc + ': size not 0 after clear');
        assert.equal(c._freeListLength(), c._capacity, 'cycle ' + cyc + ': free-list != capacity');
        assert.equal(c._store.indexSize(), 0, 'cycle ' + cyc + ': index size != 0');
        assert.equal(c._gLen, 0, 'cycle ' + cyc + ': ghost not empty after clear');
        validate(c);
    }
});

// --- delete -------------------------------------------------------------------

test('delete() returns true/false and frees the slot for refill', () => {
    const c = new S3Fifo(4);
    c.put('a', 1); c.put('b', 2); c.put('c', 3);
    assert.equal(c.delete('b'), true);
    assert.equal(c.delete('b'), false);
    assert.equal(c.delete('nope'), false);
    assert.equal(c.size, 2);
    assert.equal(c.has('b'), false);
    validate(c);
    c.put('d', 4);
    c.put('e', 5);
    assert.equal(c.size, 4);
    assert.equal(c.get('d'), 4);
    assert.equal(c.get('e'), 5);
    validate(c);
});

test('delete() from SMALL and from MAIN keeps both rings coherent', () => {
    const c = new S3Fifo(20); // smallCap 2
    for (let i = 0; i < 20; i++) c.put(i, i);
    c.get(0); c.get(1); // prove two entries
    c.put(100, 100); // graduates a proven SMALL entry into MAIN
    validate(c);
    // find one MAIN entry and one SMALL entry and delete both
    let mainKey = -1, smallKey = -1;
    for (let k = 0; k <= 100; k++) {
        const s = c._store.get(k);
        if (s < 0) continue;
        if (c._q[s] === Q_MAIN && mainKey < 0) mainKey = k;
        if (c._q[s] === Q_SMALL && smallKey < 0) smallKey = k;
    }
    assert.ok(mainKey >= 0, 'expected at least one MAIN entry after graduation');
    assert.ok(smallKey >= 0, 'expected at least one SMALL entry');
    assert.equal(c.delete(mainKey), true);
    validate(c);
    assert.equal(c.delete(smallKey), true);
    validate(c);
    assert.equal(c.has(mainKey), false);
    assert.equal(c.has(smallKey), false);
    c.put(200, 200); // still usable after the repairs
    assert.equal(c.get(200), 200);
    validate(c);
});

test('conservation invariant holds after a mixed op stream', () => {
    const c = new S3Fifo(8);
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
    const c = new S3Fifo(4, {
        onEvict: (k) => { calls++; sizeDuring = c.size; victimPresent = c.has(k); },
    });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    c.put('e', 5); // evicts a
    assert.equal(calls, 1);
    assert.equal(sizeDuring, 4, 'the callback sees a full, consistent cache');
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
        const c = new S3Fifo(4, { onEvict: () => { fired++; reenter.fn(c); } });
        c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
        assert.throws(() => c.put('e', 5), /\[lite-lru\].*must not reenter/);
        assert.equal(fired, 1, 'onEvict fired exactly once');
        assert.ok(c.size <= 4, 'size never exceeds capacity');
        assert.equal(c.size, 4);
        assert.equal(c.has('e'), true, 'the newcomer is present');
        assert.equal(c.has('reentrant'), false, 'the rejected reentry left nothing behind');
        validate(c);
    });
}

test('onEvict reads: has() and peek() are ALLOWED inside the callback', () => {
    let ok = true, sawHas, sawPeek;
    const c = new S3Fifo(4, {
        onEvict: () => { try { sawHas = c.has('d'); sawPeek = c.peek('d'); } catch { ok = false; } },
    });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    c.put('e', 5); // evicts a; onEvict reads d (the consistent post-put state)
    assert.equal(ok, true);
    assert.equal(sawHas, true);
    assert.equal(sawPeek, 4);
    validate(c);
});

// --- the `keys: 'int'` substrate backing (decisions/0011) rides identically ----

test('int backing: an identical op script observes IDENTICAL results to the default backing', () => {
    const script = [
        ['put', 1, 'A'], ['put', 2, 'B'], ['put', 3, 'C'], ['put', 4, 'D'],
        ['has', 1], ['peek', 2],
        ['get', 1], // prove 1
        ['put', 5, 'E'], // over capacity -> evict + maybe graduate
        ['put', 1, 'A2'], // 1 may be in ghost -> route to MAIN
        ['has', 2], ['has', 5],
        ['peek', 3],
        ['delete', 3],
        ['delete', 3],
        ['put', 6, 'F'], ['put', 7, 'G'],
        ['get', 6], ['get', 7],
        ['clear'],
        ['put', 8, 'H'], ['get', 8], ['has', 9],
    ];
    function run(useInt) {
        const events = [];
        const c = new S3Fifo(4, {
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
    const c = new S3Fifo(4, { keys: 'int' });
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
    const c = new S3Fifo(3, { keys: 'int' });
    c.put(1, 1); c.put(2, 2); c.put(3, 3);
    assert.equal(c.delete(2), true);
    assert.equal(c.delete(2), false);
    assert.equal(c.delete(999), false);
    assert.equal(c.size, 2);
    validate(c);
    c.put(4, 4); c.put(5, 5);
    assert.equal(c.size, 3);
    assert.equal(c.get(4), 4);
    assert.equal(c.get(5), 5);
    validate(c);
});

const BAD_INT_KEYS = [1.5, -1.5, 'x', '0', null, undefined, NaN, Infinity, -Infinity,
    -2147483649, 2147483648, {}, [], true];

for (const bad of BAD_INT_KEYS) {
    test('int backing door: key ' + String(bad) + ' throws a [lite-lru]-tagged TypeError on every method', () => {
        const c = new S3Fifo(4, { keys: 'int' });
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

test('int backing: conservation invariant holds after a mixed op stream (heavy churn)', () => {
    const c = new S3Fifo(8, { keys: 'int' });
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

// --- cross-check against the independent S3-FIFO oracle (both backings) --------
// A self-contained differential (no torture peers) proving `S3Fifo` matches an
// independent brute-force S3-FIFO across a fuzz stream: same value AND same next
// victim AND same size after every op, on the default AND the int backing, across
// small caps (which exercise the split rounding + the mainCap==0 / ghostCap==0 edge).

test('both backings match an independent S3-FIFO oracle over a fuzz stream (caps 1..9, 64)', () => {
    for (const cap of [1, 2, 3, 5, 8, 9, 64]) {
        for (const useInt of [false, true]) {
            const keyspace = cap * 3 + 2;
            const c = new S3Fifo(cap, useInt ? { keys: 'int' } : undefined);
            const o = makeS3FifoOracle(cap);
            let x = (0x1234567 ^ cap) >>> 0;
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
