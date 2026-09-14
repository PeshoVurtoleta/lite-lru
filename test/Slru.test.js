/**
 * @zakkster/lite-lru -- node:test boundary suite for the Slru member (decisions/0015).
 * Mirrors the other members' coverage, pinning Slru's OWN policy laws: a newcomer enters
 * PROBATION unvisited; get(X) once leaves X in probation, get(X) twice PROMOTES it to
 * PROTECTED (the promote-on-2nd-hit law); a protected hit moves to protected MRU;
 * protected overflow demotes its LRU to probation; eviction ALWAYS prefers probation, so
 * a distinct one-hit-wonder flood never displaces a protected entry (scan resistance);
 * has/peek are promotion-neutral. validate() (the conservation invariant, extended with
 * the Slru segment terms) runs after mutating tests as a structural backstop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Slru, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';
import { makeSlruOracle } from './torture/oracles/slru.mjs';

const NIL = -1;
const SLRU_PROBATION = 0; // matches Lru.js tags
const SLRU_PROTECTED = 1;

test('exports: VERSION and the named Slru export are present', async () => {
    assert.equal(VERSION, '1.15.0');
    const mod = await import('../Lru.js');
    assert.equal(mod.Slru, Slru);
});

test('getters: size and capacity reflect state', () => {
    const c = new Slru(3);
    assert.equal(c.capacity, 3);
    assert.equal(c.size, 0);
    c.put('a', 1);
    assert.equal(c.size, 1);
    validate(c);
});

test('put/get: basic round-trip', () => {
    const c = new Slru(4);
    c.put('a', 1);
    c.put('b', 2);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('b'), 2);
    assert.equal(c.get('missing'), undefined);
    validate(c);
});

// --- Slru policy LAWS, named --------------------------------------------------

test('law: a newcomer is admitted to PROBATION, unvisited', () => {
    const c = new Slru(16);
    c.put('a', 1);
    const s = c._store.get('a');
    assert.equal(c._seg[s], SLRU_PROBATION, 'newcomer must enter PROBATION');
    assert.equal(c._vis[s], 0, 'newcomer must start unvisited');
    validate(c);
});

test('law: promote-on-2nd-hit -- get(X) once stays probation, get(X) twice -> protected', () => {
    const c = new Slru(16);
    c.put('x', 1);
    assert.equal(c.get('x'), 1); // first hit
    let s = c._store.get('x');
    assert.equal(c._seg[s], SLRU_PROBATION, 'get once must stay in probation');
    assert.equal(c._vis[s], 1, 'first hit sets the visited bit');
    assert.equal(c.get('x'), 1); // second hit
    s = c._store.get('x');
    assert.equal(c._seg[s], SLRU_PROTECTED, 'get twice must promote to protected');
    validate(c);
});

test('law: a first hit does NOT reorder probation (FIFO)', () => {
    const c = new Slru(16);
    for (let i = 0; i < 5; i++) c.put(i, i);
    const probHead = c._probHead, probTail = c._probTail;
    c.get(0); // first hit on the oldest probation entry
    assert.equal(c._probHead, probHead, 'first hit must not move the probation head');
    assert.equal(c._probTail, probTail, 'first hit must not move the probation tail');
    validate(c);
});

test('law: a protected hit moves to protected MRU', () => {
    const c = new Slru(16);
    c.put('a', 1); c.get('a'); c.get('a'); // a -> protected
    c.put('b', 2); c.get('b'); c.get('b'); // b -> protected (MRU), a is now protected LRU
    assert.equal(c._keys[c._protHead], 'b');
    c.get('a'); // protected hit -> a moves to protected MRU
    assert.equal(c._keys[c._protHead], 'a', 'a protected hit did not move to MRU');
    validate(c);
});

test('law: protected overflow demotes its LRU tail back to probation', () => {
    const c = new Slru(4); // protectedCap = round(3.2) = 3
    assert.equal(c._protectedCap, 3);
    // Promote a, b, c into protected (2 hits each); protected is now full (3).
    for (const k of ['a', 'b', 'c']) { c.put(k, k); c.get(k); c.get(k); }
    assert.equal(c._protSize, 3);
    // a is protected LRU. Promote d -> overflow -> a demoted to probation.
    c.put('d', 4); c.get('d'); c.get('d');
    assert.equal(c._protSize, 3, 'protected stayed at its cap');
    assert.equal(c._seg[c._store.get('a')], SLRU_PROBATION, 'the protected LRU was demoted to probation');
    validate(c);
});

test('law: has()/peek() are promotion-NEUTRAL', () => {
    const c = new Slru(16);
    c.put('a', 1);
    assert.equal(c.has('a'), true);
    assert.equal(c.peek('a'), 1);
    const s = c._store.get('a');
    assert.equal(c._vis[s], 0, 'has/peek left a unvisited');
    assert.equal(c._seg[s], SLRU_PROBATION, 'has/peek did not promote');
    validate(c);
});

test('law: at capacity, eviction prefers the probation tail (oldest)', () => {
    let seenKey;
    const c = new Slru(4, { onEvict: (k) => { seenKey = k; } }); // protectedCap 3
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4); // all probation, tail = a
    c.put('e', 5); // evicts probation tail a
    assert.equal(seenKey, 'a');
    assert.equal(c.has('a'), false);
    assert.equal(c.has('e'), true);
    assert.equal(c.size, 4);
    validate(c);
});

test('law: a cap-sized distinct-key scan evicts 0 protected entries (scan resistance)', () => {
    const N = 64;
    const c = new Slru(N);
    const hot = [];
    for (let h = 0; h < 20; h++) { const k = 'hot' + h; c.put(k, h); c.get(k); c.get(k); hot.push(k); }
    for (const k of hot) assert.equal(c._seg[c._store.get(k)], SLRU_PROTECTED);
    while (c.size < N) c.put('warm' + c.size, c.size);
    for (let i = 0; i < N; i++) c.put('scan' + i, i); // exactly cap distinct one-hit-wonders
    for (const k of hot) assert.equal(c.has(k), true, 'protected key ' + k + ' evicted by the scan');
    let survivors = 0;
    for (let i = 0; i < N; i++) if (c.has('scan' + i)) survivors++;
    assert.ok(survivors < N, 'scan keys were evicted (non-vacuous)');
    validate(c);
});

test('law: put(update) counts as a hit for the 2nd-hit rule', () => {
    const c = new Slru(16);
    c.put('a', 1);            // probation, unvisited
    c.put('a', 2);            // update = first hit -> visited
    assert.equal(c._vis[c._store.get('a')], 1);
    assert.equal(c._seg[c._store.get('a')], SLRU_PROBATION);
    c.put('a', 3);            // update = second hit -> protected
    assert.equal(c._seg[c._store.get('a')], SLRU_PROTECTED);
    assert.equal(c.get('a'), 3);
    validate(c);
});

// --- D7: the undefined-value ambiguity ----------------------------------------

test('D7: a stored undefined value is indistinguishable from a miss via get()', () => {
    const c = new Slru(4);
    c.put('k', undefined);
    assert.equal(c.get('k'), undefined);
    assert.equal(c.get('absent'), undefined);
    assert.equal(c.has('k'), true);
    assert.equal(c.has('absent'), false);
    assert.equal(c.peek('k'), undefined);
    validate(c);
});

// --- SameValueZero key semantics ----------------------------------------------

test('keys: 0 and -0 collapse to one entry (SameValueZero)', () => {
    const c = new Slru(4);
    c.put(0, 'zero');
    c.put(-0, 'neg');
    assert.equal(c.size, 1);
    assert.equal(c.get(0), 'neg');
    validate(c);
});

test('keys: NaN is a single usable key', () => {
    const c = new Slru(4);
    c.put(NaN, 'x');
    c.put(NaN, 'y');
    assert.equal(c.size, 1);
    assert.equal(c.get(NaN), 'y');
    validate(c);
});

// --- fail-closed doors --------------------------------------------------------

for (const bad of [0, -1, 1.5, NaN, undefined, null, '4', Infinity]) {
    test('fail-closed: capacity ' + String(bad) + ' throws a tagged RangeError', () => {
        assert.throws(() => new Slru(bad), (err) => {
            assert.ok(err instanceof RangeError);
            assert.match(err.message, /\[lite-lru\]/);
            return true;
        });
    });
}

for (const bad of ['Int', 'map', 0, true, {}, null]) {
    test('fail-closed: keys option ' + String(bad) + ' throws a did-you-mean TypeError', () => {
        assert.throws(() => new Slru(4, { keys: bad }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /did you mean 'int'\?/);
            return true;
        });
    });
}

// --- degenerate caps 1/2/3 ----------------------------------------------------

test('capacity 1/2/3: every put keeps size bounded, conservation holds', () => {
    for (const cap of [1, 2, 3]) {
        let evictions = 0;
        const c = new Slru(cap, { onEvict: () => { evictions++; } });
        for (let i = 0; i < 200; i++) {
            c.put(i, i);
            assert.equal(c.size, Math.min(cap, i + 1), 'cap ' + cap + ' size at ' + i);
            assert.equal(c.get(i), i);
            validate(c);
        }
        assert.equal(evictions, 200 - cap, 'cap ' + cap + ' eviction count');
        c.clear();
        assert.equal(c.size, 0);
        validate(c);
    }
});

// --- empty / cleared reads ----------------------------------------------------

test('an empty cache misses cleanly (no throw)', () => {
    const c = new Slru(4);
    assert.equal(c.get('x'), undefined);
    assert.equal(c.has('x'), false);
    assert.equal(c.peek('x'), undefined);
    assert.equal(c.delete('x'), false);
    assert.equal(c._probHead, NIL);
    assert.equal(c._protHead, NIL);
    validate(c);
});

test('clear() empties both segments, zeroes visited, stays reusable', () => {
    const c = new Slru(4);
    c.put('a', 1); c.get('a'); c.get('a'); // a -> protected
    c.put('b', 2); c.put('c', 3);
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c._probHead, NIL); assert.equal(c._protHead, NIL);
    for (let i = 0; i < c._capacity; i++) assert.equal(c._vis[i], 0, 'visited byte ' + i + ' zeroed');
    validate(c);
    c.put('x', 42);
    assert.equal(c.get('x'), 42);
    validate(c);
});

// --- delete -------------------------------------------------------------------

test('delete() from probation and protected keeps both segments coherent', () => {
    const c = new Slru(16);
    c.put('p', 1);              // probation
    c.put('q', 2); c.get('q'); c.get('q'); // protected
    assert.equal(c.delete('p'), true);
    validate(c);
    assert.equal(c.delete('q'), true);
    validate(c);
    assert.equal(c.delete('nope'), false);
    assert.equal(c.size, 0);
    c.put('r', 3);
    assert.equal(c.get('r'), 3);
    validate(c);
});

test('conservation invariant holds after a mixed op stream', () => {
    const c = new Slru(8);
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

// --- onEvict fire-after + reentrancy (decisions/0002) -------------------------

test('onEvict fires LAST, once, with the cache consistent', () => {
    let calls = 0, sizeDuring = -1, victimPresent = null;
    const c = new Slru(4, { onEvict: (k) => { calls++; sizeDuring = c.size; victimPresent = c.has(k); } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    c.put('e', 5); // evicts a (probation tail)
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
        const c = new Slru(4, { onEvict: () => { fired++; reenter.fn(c); } });
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
        ['get', 1], ['get', 1], // promote 1 to protected
        ['has', 2], ['peek', 3],
        ['put', 5, 'E'],
        ['get', 2], ['get', 2],
        ['delete', 3], ['delete', 3],
        ['put', 6, 'F'], ['get', 6], ['get', 6],
        ['clear'],
        ['put', 8, 'H'], ['get', 8], ['has', 9],
    ];
    function run(useInt) {
        const events = [];
        const c = new Slru(4, { keys: useInt ? 'int' : undefined, onEvict: (k, v) => events.push(['evict', k, v]) });
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
        const c = new Slru(4, { keys: 'int' });
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

// --- TTL interop (decisions/0017) ---------------------------------------------

test('ttl: a stale get is a miss + reap; a fresh Infinity sibling survives', () => {
    let now = 0; const clock = () => now;
    const ev = [];
    const c = new Slru(8, { ttl: 10, clock, onEvict: (k) => ev.push(k) });
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
    const c = new Slru(4);
    assert.throws(() => c.put('k', 1, 5), /\[lite-lru\]/);
});

// --- iteration (decisions/0018): PROTECTED then PROBATION, each MRU..LRU -------

test('iteration order: protected (MRU..LRU) then probation (MRU..LRU)', () => {
    const c = new Slru(16);
    for (let i = 0; i < 6; i++) c.put(i, i * 10); // probation
    c.get(0); c.get(0); c.get(2); c.get(2);       // promote 0 and 2 to protected (2 is MRU)
    const keys = [];
    for (const k of c.keys()) keys.push(k);
    // independent expected walk of protected head then probation head
    const want = [];
    for (let s = c._protHead; s !== NIL; s = c._next[s]) want.push(c._keys[s]);
    for (let s = c._probHead; s !== NIL; s = c._next[s]) want.push(c._keys[s]);
    assert.deepEqual(keys, want);
    assert.equal(c.size, 6, 'iteration is read-only (size unchanged)');
    validate(c);
});

// --- stats interop (decisions/0019) -------------------------------------------

test('stats: outcome-based hits/misses/puts/evictions; has/peek neutral', () => {
    const c = new Slru(2, { stats: true });
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
    const c = new Slru(4);
    assert.throws(() => c.stats(), /\[lite-lru\]/);
    assert.throws(() => c.resetStats(), /\[lite-lru\]/);
});

// --- QA (S7): scan resistance at a > cap burst (not just cap-sized) -----------

test('scan resistance: a > cap (3x) burst of distinct one-hit keys evicts 0 protected entries', () => {
    const N = 32;
    const c = new Slru(N);
    const hot = [];
    for (let h = 0; h < 10; h++) { const k = 'hot' + h; c.put(k, h); c.get(k); c.get(k); hot.push(k); }
    for (const k of hot) assert.equal(c._seg[c._store.get(k)], SLRU_PROTECTED);
    while (c.size < N) c.put('warm' + c.size, c.size);
    for (let i = 0; i < N * 3; i++) c.put('scan' + i, i); // 3x cap distinct one-hit-wonders
    for (const k of hot) {
        assert.equal(c.has(k), true, 'protected key ' + k + ' evicted by a > cap scan');
        assert.equal(c._seg[c._store.get(k)], SLRU_PROTECTED, k + ' left protected segment');
    }
    validate(c);
});

// --- QA (S7): degenerate caps 1..4, segment-audited (highest risk: the 80/20 split
// can floor a segment; the impl must stay correct with no divide-by-zero / NaN cap) --

test('degenerate cap=1: protectedCap==1; a 2nd hit fills the ONLY slot into protected, probation empties; the next put evicts FROM PROTECTED (probation empty)', () => {
    const evicted = [];
    const c = new Slru(1, { onEvict: (k, v) => evicted.push([k, v]) });
    assert.equal(c._protectedCap, 1);
    c.put('a', 1);
    assert.equal(c._seg[c._store.get('a')], SLRU_PROBATION);
    c.get('a'); // 1st hit
    assert.equal(c._seg[c._store.get('a')], SLRU_PROBATION);
    c.get('a'); // 2nd hit -> promote; protSize(1) > protectedCap(1)? no -- fits exactly
    assert.equal(c._seg[c._store.get('a')], SLRU_PROTECTED, 'the only slot must be promotable at cap 1');
    assert.equal(c._probSize, 0, 'probation must be empty after the promotion');
    assert.equal(c._protSize, 1);
    c.put('b', 2); // capacity crunch: probation empty -> evict from PROTECTED
    assert.deepEqual(evicted, [['a', 1]], 'eviction must fall back to protected when probation is empty');
    assert.equal(c.get('b'), 2);
    assert.equal(c.size, 1);
    validate(c);
});

test('degenerate cap=2: protectedCap==2 (== capacity); promotion never overflows (no demotion is reachable)', () => {
    const c = new Slru(2);
    assert.equal(c._protectedCap, 2);
    c.put('a', 1); c.get('a'); c.get('a'); // promote a
    assert.equal(c._seg[c._store.get('a')], SLRU_PROTECTED);
    assert.equal(c._protSize, 1);
    c.put('b', 2); c.get('b'); c.get('b'); // promote b: protSize becomes 2, still <= protectedCap(2)
    assert.equal(c._seg[c._store.get('b')], SLRU_PROTECTED);
    assert.equal(c._protSize, 2, 'both entries fit in protected at cap 2 (no demotion triggered)');
    assert.equal(c._probSize, 0);
    validate(c);
    // A subsequent new key must evict from protected (probation is empty): eviction still works.
    let evictedKey;
    c._onEvict = (k) => { evictedKey = k; };
    c.put('c', 3);
    assert.equal(evictedKey, 'a', 'protected LRU (a) is the correct victim when probation is empty');
    assert.equal(c.size, 2);
    validate(c);
});

test('degenerate cap=3: protectedCap==2; the THIRD promotion overflows and demotes (smallest cap where demotion is reachable)', () => {
    const c = new Slru(3);
    assert.equal(c._protectedCap, 2);
    c.put('a', 1); c.get('a'); c.get('a'); // protected: [a]
    c.put('b', 2); c.get('b'); c.get('b'); // protected: [b, a], full at cap 2
    assert.equal(c._protSize, 2);
    c.put('c', 3); c.get('c'); c.get('c'); // promoting c overflows -> demote protected LRU (a)
    assert.equal(c._protSize, 2, 'protected stays at its cap after the demotion');
    assert.equal(c._seg[c._store.get('a')], SLRU_PROBATION, 'a (protected LRU) must be demoted to probation');
    assert.equal(c._seg[c._store.get('c')], SLRU_PROTECTED, 'the promoting key itself must land in protected');
    assert.equal(c._vis[c._store.get('a')], 0, 'a demoted entry must reset unvisited');
    validate(c);
});

test('degenerate caps 1..4: the split never divides by zero / produces NaN, and a full put+get+evict cycle matches a brute count', () => {
    for (const cap of [1, 2, 3, 4]) {
        const c = new Slru(cap);
        assert.ok(Number.isInteger(c._protectedCap) && c._protectedCap >= 1 && c._protectedCap <= cap,
            'cap ' + cap + ': protectedCap must be a sane integer in [1, cap], got ' + c._protectedCap);
        let evictions = 0;
        const c2 = new Slru(cap, { onEvict: () => { evictions++; } });
        const N = cap * 5 + 3; // strictly more distinct keys than capacity
        for (let k = 0; k < N; k++) {
            c2.put(k, k);
            assert.equal(c2.get(k), k, 'cap ' + cap + ': just-inserted key ' + k + ' missing');
            validate(c2);
        }
        assert.equal(evictions, N - cap, 'cap ' + cap + ': eviction count must equal N - cap exactly');
        assert.equal(c2.size, cap);
        validate(c2);
    }
});

// --- QA (S7): has/peek are ALLOWED during onEvict reentrancy (only put/get/delete/
// clear/purgeStale must throw) ---------------------------------------------------

test('onEvict reentrancy: has()/peek() during onEvict do NOT throw and read the consistent mid-eviction state', () => {
    let hasDuringEvict, peekDuringEvict;
    const c = new Slru(4, {
        onEvict: (k) => {
            hasDuringEvict = c.has(k);   // the just-evicted key must already read absent
            peekDuringEvict = c.peek('b'); // an untouched survivor reads normally
        },
    });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    assert.doesNotThrow(() => c.put('e', 5)); // evicts probation tail 'a'
    assert.equal(hasDuringEvict, false, 'has() on the victim mid-onEvict must read false');
    assert.equal(peekDuringEvict, 2, 'peek() on a survivor mid-onEvict must read its value');
    validate(c);
});

// --- QA (S7) ADVERSARIAL (the case the planner did not think of): a DEMOTED entry
// loses its earned credit -- it needs a FULL fresh 2-hit cycle to re-promote, not
// "one more hit" as if the demotion partially preserved standing -----------------

test('ADVERSARIAL: a demoted entry needs a FULL 2 new hits to re-promote (demotion does not partially preserve credit)', () => {
    const c = new Slru(3); // protectedCap 2
    c.put('a', 1); c.get('a'); c.get('a'); // protected: [a]
    c.put('b', 2); c.get('b'); c.get('b'); // protected: [b, a], full
    c.put('c', 3); c.get('c'); c.get('c'); // promoting c demotes a back to probation
    assert.equal(c._seg[c._store.get('a')], SLRU_PROBATION);
    assert.equal(c._vis[c._store.get('a')], 0, 'a demoted entry must start fully unvisited, no partial credit');
    // ONE hit on the demoted 'a' must NOT re-promote it (must behave exactly like a
    // brand-new probation entry -- the FIRST hit only sets visited, no reorder).
    const probHeadBefore = c._probHead;
    c.get('a');
    assert.equal(c._seg[c._store.get('a')], SLRU_PROBATION, 'one hit after demotion must not re-promote (no preserved credit)');
    assert.equal(c._vis[c._store.get('a')], 1);
    assert.equal(c._probHead, probHeadBefore, 'a first hit must not reorder probation (still FIFO)');
    // The SECOND hit completes the cycle exactly like any fresh probation entry.
    c.get('a');
    assert.equal(c._seg[c._store.get('a')], SLRU_PROTECTED, 'a second hit after demotion promotes normally');
    validate(c);
});

// --- cross-check against the independent Slru oracle (both backings) -----------

test('both backings match an independent Slru oracle over a fuzz stream (caps 1..9, 64)', () => {
    for (const cap of [1, 2, 3, 5, 8, 9, 64]) {
        for (const useInt of [false, true]) {
            const keyspace = cap * 3 + 2;
            const c = new Slru(cap, useInt ? { keys: 'int' } : undefined);
            const o = makeSlruOracle(cap);
            let x = (0x2468ace ^ cap) >>> 0;
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
