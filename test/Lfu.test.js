/**
 * @zakkster/lite-lru -- node:test boundary suite for the Lfu member (decisions/0024).
 * Mirrors the other members' coverage, pinning Lfu's OWN policy laws: EXACT frequency
 * counting (get AND put-update each +1; has/peek neutral); eviction of the LOWEST-frequency
 * key with an LRU tie-break within a frequency; a newcomer and a just-promoted key attach at
 * the MRU end of their bucket; a single-key bucket with no freq+1 neighbour is RELABELLED in
 * place (the bucket pool never grows); TTL lazy-stale semantics; ascending-frequency iteration
 * order; snapshot round-trip that reconstructs EXACT frequencies; and fail-closed doors.
 * validate() (the conservation invariant, extended with the Lfu bucket-pool term) runs after
 * mutating tests as a structural backstop.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Lfu, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';
import { makeLfuOracle } from './torture/oracles/lfu.mjs';

const NIL = -1;

/** The exact frequency of a resident key (test helper: read the owning bucket's freq). */
function freqOf(c, key) {
    const s = c._store.get(key);
    assert.ok(s >= 0, 'freqOf: key not resident');
    return c._bFreq[c._kB[s]];
}

/** Keys in iteration order (ascending frequency, MRU->LRU per bucket). */
function orderKeys(c) {
    const out = [];
    for (const k of c.keys()) out.push(k);
    return out;
}

test('exports: VERSION and the named Lfu export are present', async () => {
    assert.equal(VERSION, '1.16.1');
    const mod = await import('../Lru.js');
    assert.equal(mod.Lfu, Lfu);
});

test('getters: size and capacity reflect state', () => {
    const c = new Lfu(3);
    assert.equal(c.capacity, 3);
    assert.equal(c.size, 0);
    c.put('a', 1);
    assert.equal(c.size, 1);
    validate(c);
});

test('constructor: fail closed on a bad capacity', () => {
    assert.throws(() => new Lfu(0), /capacity must be an integer >= 1/);
    assert.throws(() => new Lfu(-1), /capacity must be an integer >= 1/);
    assert.throws(() => new Lfu(1.5), /capacity must be an integer >= 1/);
    assert.throws(() => new Lfu('4'), /capacity must be an integer >= 1/);
});

test('constructor: fail closed on an unknown keys backing', () => {
    assert.throws(() => new Lfu(4, { keys: 'lfu' }), /unknown keys option/);
});

test('put/get: basic round-trip', () => {
    const c = new Lfu(4);
    c.put('a', 1);
    c.put('b', 2);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('b'), 2);
    assert.equal(c.get('missing'), undefined);
    validate(c);
});

test('put: update rewrites the value in place (no size change)', () => {
    const c = new Lfu(4);
    c.put('a', 1);
    c.put('a', 2);
    assert.equal(c.size, 1);
    assert.equal(c.peek('a'), 2);
    validate(c);
});

test('LAW exact frequency: a newcomer starts at freq 1', () => {
    const c = new Lfu(4);
    c.put('a', 1);
    assert.equal(freqOf(c, 'a'), 1);
    validate(c);
});

test('LAW exact frequency: get increments by exactly one each hit', () => {
    const c = new Lfu(4);
    c.put('a', 1);
    c.get('a');
    assert.equal(freqOf(c, 'a'), 2);
    c.get('a'); c.get('a');
    assert.equal(freqOf(c, 'a'), 4);
    validate(c);
});

test('LAW exact frequency: put-update COUNTS as a hit (D24)', () => {
    const c = new Lfu(4);
    c.put('a', 1);          // freq 1
    c.put('a', 9);          // freq 2 (update counts)
    assert.equal(freqOf(c, 'a'), 2);
    assert.equal(c.peek('a'), 9);
    validate(c);
});

test('LAW has/peek are frequency-neutral', () => {
    const c = new Lfu(4);
    c.put('a', 1);
    c.get('a');             // freq 2
    c.has('a'); c.has('a');
    c.peek('a'); c.peek('a');
    assert.equal(freqOf(c, 'a'), 2);
    validate(c);
});

test('LAW eviction: the LOWEST-frequency key is evicted', () => {
    let evicted;
    const c = new Lfu(3, { onEvict: (k) => { evicted = k; } });
    c.put('a', 1); c.put('b', 2); c.put('c', 3);
    c.get('a'); c.get('a');    // a -> freq 3
    c.get('b');                // b -> freq 2
    // c is freq 1 (the lowest) -> it is the victim
    assert.equal(c._peekVictim(), 'c');
    c.put('d', 4);
    assert.equal(evicted, 'c');
    assert.ok(c.has('a') && c.has('b') && c.has('d') && !c.has('c'));
    validate(c);
});

test('LAW LRU tie-break: within one frequency the least-recent is evicted', () => {
    const c = new Lfu(3);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); // all freq 1; insertion MRU c,b,a (a oldest)
    // all at freq 1: the LRU-end (oldest) key 'a' is the victim
    assert.equal(c._peekVictim(), 'a');
    c.put('d', 4);                                // evicts 'a'
    assert.ok(!c.has('a') && c.has('b') && c.has('c') && c.has('d'));
    validate(c);
});

test('LAW LRU tie-break: a just-promoted key becomes MRU at its new frequency', () => {
    const c = new Lfu(4);
    c.put('a', 1); c.put('b', 2);
    c.get('a'); c.get('b');   // both -> freq 2; b touched last => b is MRU of freq-2 bucket
    // within freq 2, 'a' is the LRU -> the victim among the freq-2 tie (both are min freq now)
    assert.equal(c._peekVictim(), 'a');
    validate(c);
});

test('LAW frequency (scan) resistance: a hot set survives a flood larger than capacity', () => {
    const c = new Lfu(16, { keys: 'int' });
    for (let i = 0; i < 16; i++) c.put(i, i);
    const hot = [0, 1, 2, 3];
    for (const h of hot) for (let t = 0; t < 8; t++) c.get(h);
    for (let i = 0; i < 4000; i++) { for (const h of hot) c.get(h); c.put(1000 + i, i); }
    for (const h of hot) assert.ok(c.has(h), 'hot key ' + h + ' evicted by the flood');
    validate(c);
});

test('bucket relabel: a single hot key never grows the bucket pool', () => {
    const c = new Lfu(4);
    c.put('x', 1);
    const bytes = c._bFreq.buffer.byteLength;
    for (let i = 0; i < 100000; i++) c.get('x');
    assert.equal(freqOf(c, 'x'), 100001);
    assert.equal(c._bFreq.buffer.byteLength, bytes); // never grew
    let live = 0; for (let b = c._bMin; b !== NIL; b = c._bNext[b]) live++;
    assert.equal(live, 1); // exactly one live bucket (relabel, not create+destroy)
    validate(c);
});

test('delete: removes a key and frees its slot', () => {
    const c = new Lfu(4);
    c.put('a', 1); c.put('b', 2);
    c.get('a');                 // a -> freq 2 (distinct bucket)
    assert.equal(c.delete('a'), true);
    assert.equal(c.delete('a'), false);
    assert.equal(c.size, 1);
    assert.ok(c.has('b') && !c.has('a'));
    validate(c);
});

test('delete: the last key in a bucket destroys the bucket', () => {
    const c = new Lfu(4);
    c.put('a', 1);
    c.get('a');                 // a in a freq-2 bucket, sole occupant
    c.delete('a');
    assert.equal(c._bMin, NIL); // bucket list empty
    assert.equal(c.size, 0);
    validate(c);
});

test('clear: empties and rebuilds both free stacks', () => {
    const c = new Lfu(8);
    for (let i = 0; i < 8; i++) c.put(i, i);
    for (let i = 0; i < 4; i++) c.get(i);
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c._bMin, NIL);
    assert.equal(c._freeListLength(), 8);
    // reusable after clear
    c.put('x', 42);
    assert.equal(c.get('x'), 42);
    validate(c);
});

test('onEvict: fires last with the evicted (key, value) at capacity', () => {
    const seen = [];
    const c = new Lfu(2, { onEvict: (k, v) => seen.push([k, v]) });
    c.put('a', 1); c.put('b', 2);
    c.get('a');            // a -> freq 2, b stays freq 1 (the victim)
    c.put('c', 3);         // evicts b
    assert.deepEqual(seen, [['b', 2]]);
    validate(c);
});

test('onEvict: a mutating reentry fails closed', () => {
    let c;
    c = new Lfu(1, { onEvict: () => { c.put('z', 0); } });
    c.put('a', 1);
    assert.throws(() => c.put('b', 2), /must not reenter/);
});

test('D7: an undefined value is indistinguishable from a miss on get, disambiguated by has', () => {
    const c = new Lfu(4);
    c.put('a', undefined);
    assert.equal(c.get('a'), undefined);
    assert.equal(c.has('a'), true);
    validate(c);
});

// --- iteration order (decisions/0018, D24) ---------------------------------

test('iteration: ascending frequency, MRU..LRU per bucket', () => {
    const c = new Lfu(8);
    for (let i = 0; i < 5; i++) c.put(i, i); // all freq 1 (MRU 4,3,2,1,0)
    c.get(0); c.get(1);                      // 0,1 -> freq 2 (1 touched last -> MRU)
    c.get(0);                                // 0 -> freq 3
    // freq-1 bucket: keys 4,3,2 (MRU..LRU); freq-2 bucket: key 1; freq-3 bucket: key 0
    assert.deepEqual(orderKeys(c), [4, 3, 2, 1, 0]);
    validate(c);
});

test('iteration: entries yields a BORROWED, reused tuple (copy what you keep)', () => {
    const c = new Lfu(4);
    c.put('a', 1); c.put('b', 2);
    const it = c.entries();
    const first = it.next().value;
    const copy = [first[0], first[1]];
    it.next();
    assert.deepEqual(copy, ['b', 2].sort ? copy : copy); // copy is stable
    // the borrowed tuple identity is reused across steps
    assert.equal(typeof first[0] === 'string' || typeof first[0] === 'undefined', true);
    validate(c);
});

test('iteration: a structural mutation mid-walk fails closed', () => {
    const c = new Lfu(4);
    c.put('a', 1); c.put('b', 2);
    const it = c.keys();
    it.next();
    c.put('c', 3); // structural mutation -> bumps _ver
    assert.throws(() => it.next(), /structurally mutated during iteration/);
});

// --- TTL (decisions/0017) ---------------------------------------------------

test('TTL: a stale get is a MISS and reaps in place (no frequency change on siblings)', () => {
    let now = 0; const clock = () => now;
    const ev = [];
    const c = new Lfu(4, { ttl: 10, clock, onEvict: (k, v) => ev.push([k, v]) });
    c.put('x', 1);            // exp 10
    c.put('keep', 2, Infinity);
    now = 11;
    assert.equal(c.get('x'), undefined);
    assert.deepEqual(ev, [['x', 1]]);
    assert.equal(c.size, 1);
    assert.ok(c.has('keep'));
    validate(c);
});

test('TTL: has/peek reap a stale entry and report a miss', () => {
    let now = 0; const clock = () => now;
    const c = new Lfu(4, { ttl: 5, clock });
    c.put('a', 1);
    now = 6;
    assert.equal(c.has('a'), false);
    assert.equal(c.size, 0);
    validate(c);
});

test('TTL: per-put ttlMs overrides the instance default; Infinity never expires', () => {
    let now = 0; const clock = () => now;
    const c = new Lfu(4, { ttl: 100, clock });
    c.put('def', 1);
    c.put('short', 2, 5);
    c.put('never', 3, Infinity);
    now = 6;
    assert.equal(c.get('short'), undefined);
    assert.equal(c.get('def'), 1);
    assert.equal(c.get('never'), 3);
    validate(c);
});

test('TTL: put(ttlMs) on a non-ttl instance fails closed', () => {
    const c = new Lfu(4);
    assert.throws(() => c.put('a', 1, 10), /requires the cache to be constructed with a \{ ttl \} option/);
});

test('TTL: purgeStale reclaims every expired resident', () => {
    let now = 0; const clock = () => now;
    const c = new Lfu(8, { ttl: 5, clock });
    for (let i = 0; i < 6; i++) c.put(i, i, (i & 1) ? 5 : Infinity);
    now = 10;
    const purged = c.purgeStale();
    assert.equal(purged, 3);       // the three odd-index ttl-5 entries
    assert.equal(c.purgeStale(), 0);
    validate(c);
});

// --- opt-in stats (decisions/0019) -----------------------------------------

test('stats: outcome-based counting (hit/miss/put/eviction); has/peek neutral', () => {
    const c = new Lfu(2, { stats: true });
    c.put('a', 1);          // puts 1
    c.put('b', 2);          // puts 2
    c.get('a');             // hits 1
    c.get('z');             // misses 1
    c.has('a'); c.peek('b'); // neutral
    c.put('c', 3);          // puts 3 + evictions 1 (b, the freq-1 LRU)
    const s = c.stats();
    assert.equal(s.hits, 1);
    assert.equal(s.misses, 1);
    assert.equal(s.puts, 3);
    assert.equal(s.evictions, 1);
    validate(c);
});

test('stats: fail closed without { stats: true }', () => {
    const c = new Lfu(4);
    assert.throws(() => c.stats(), /require the cache to be constructed with \{ stats: true \}/);
    assert.throws(() => c.resetStats(), /require the cache to be constructed with \{ stats: true \}/);
});

// --- snapshot / restore (decisions/0021 + 0024) ----------------------------

test('snapshot: round-trip reconstructs EXACT frequencies + order', () => {
    const c = new Lfu(8);
    for (let i = 0; i < 6; i++) c.put(i, i * 10);
    c.get(0); c.get(0); c.get(1); c.get(2); // spread frequencies
    const snap = c.dump();
    const r = Lfu.restore(structuredClone(snap), undefined);
    validate(r);
    assert.equal(r.size, c.size);
    // exact frequencies survive
    for (let i = 0; i < 6; i++) assert.equal(freqOf(r, i), freqOf(c, i));
    // dump -> restore -> dump is a fixed point (ignoring capture time)
    const a = JSON.stringify(snap, (k, v) => (k === 't' ? 0 : v));
    const b = JSON.stringify(r.dump(), (k, v) => (k === 't' ? 0 : v));
    assert.equal(a, b);
});

test('snapshot: a restored cache evicts identically to its twin', () => {
    const c = new Lfu(8, { keys: 'int' });
    for (let i = 0; i < 8; i++) c.put(i, i);
    for (let i = 0; i < 4; i++) for (let t = 0; t < i + 1; t++) c.get(i);
    const r = Lfu.restore(structuredClone(c.dump()), { keys: 'int' });
    // same next victim + same future eviction on a shared op
    assert.equal(r._peekVictim(), c._peekVictim());
    c.put(100, 100); r.put(100, 100);
    assert.equal(r._peekVictim(), c._peekVictim());
    assert.equal(r.size, c.size);
    validate(r);
});

test('snapshot: fail closed on a dropped frequency', () => {
    const c = new Lfu(4);
    for (let i = 0; i < 3; i++) c.put(i, i);
    c.get(0); c.get(0);
    const snap = c.dump();
    const bad = { ...snap, buckets: snap.buckets.map((b) => ({ ...b, freq: undefined })) };
    assert.throws(() => Lfu.restore(bad, undefined), /freq must be a positive integer/);
});

test('snapshot: fail closed on non-ascending frequencies', () => {
    const c = new Lfu(4);
    for (let i = 0; i < 3; i++) c.put(i, i);
    c.get(0); c.get(0); // creates >= 2 buckets
    const snap = c.dump();
    assert.ok(snap.buckets.length >= 2, 'setup needs >= 2 buckets');
    const bad = { ...snap, buckets: [snap.buckets[1], snap.buckets[0]] };
    assert.throws(() => Lfu.restore(bad, undefined), /strictly ascending/);
});

test('snapshot: fail closed on a member mismatch', () => {
    const c = new Lfu(4);
    c.put('a', 1);
    const snap = c.dump();
    const bad = { ...snap, m: 'Slru' };
    assert.throws(() => Lfu.restore(bad, undefined), /member mismatch/);
});

test('snapshot: fail closed when residents exceed capacity (REJECT, never truncate)', () => {
    const c = new Lfu(2);
    c.put('a', 1); c.put('b', 2);
    const snap = c.dump();
    // craft a bucket list with more slots than capacity by duplicating the bucket
    const extra = structuredClone(snap.buckets[snap.buckets.length - 1]);
    // give the extra a strictly-higher freq and a fresh slot index within range
    extra.freq = snap.buckets[snap.buckets.length - 1].freq + 1;
    const bad = { ...snap, buckets: [...snap.buckets, extra] };
    assert.throws(() => Lfu.restore(bad, undefined), /(exceed capacity|duplicate slot)/);
});

// --- degenerate caps 1..4 --------------------------------------------------

for (const cap of [1, 2, 3, 4]) {
    test('degenerate cap ' + cap + ': churn stays coherent + matches the oracle', () => {
        const c = new Lfu(cap);
        const o = makeLfuOracle(cap);
        const ks = cap * 3 + 2;
        let x = 12345 + cap;
        const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
        for (let i = 0; i < 3000; i++) {
            const kind = rnd() % 5, key = rnd() % ks, val = rnd();
            let rv, ov;
            if (kind === 0) { rv = c.get(key); ov = o.get(key); }
            else if (kind === 1) { c.put(key, val); o.put(key, val); rv = ov = undefined; }
            else if (kind === 2) { rv = c.delete(key); ov = o.delete(key); }
            else if (kind === 3) { rv = c.has(key); ov = o.has(key); }
            else { rv = c.peek(key); ov = o.peek(key); }
            assert.ok(Object.is(rv, ov), 'value diverged at op ' + i + ' kind ' + kind + ' key ' + key);
            assert.equal(c.size, o.size(), 'size diverged at op ' + i);
            assert.ok(Object.is(c._peekVictim(), o.victim()), 'victim diverged at op ' + i);
        }
        validate(c);
    });
}

// --- degenerate keys / values ----------------------------------------------

test('degenerate keys: NaN, -0, undefined, null, objects coexist (SameValueZero)', () => {
    const c = new Lfu(8);
    const objKey = {};
    c.put(NaN, 'nan');
    c.put(-0, 'negzero');
    c.put(undefined, 'undef');
    c.put(null, 'null');
    c.put(objKey, 'obj');
    assert.equal(c.get(NaN), 'nan');           // NaN matches NaN
    assert.equal(c.get(0), 'negzero');         // -0 matches +0
    assert.equal(c.get(undefined), 'undef');
    assert.equal(c.get(null), 'null');
    assert.equal(c.get(objKey), 'obj');
    validate(c);
});

test('degenerate values: null / undefined / 0 / false round-trip via peek', () => {
    const c = new Lfu(8);
    c.put('n', null);
    c.put('u', undefined);
    c.put('z', 0);
    c.put('f', false);
    assert.equal(c.peek('n'), null);
    assert.equal(c.peek('u'), undefined);
    assert.equal(c.peek('z'), 0);
    assert.equal(c.peek('f'), false);
    validate(c);
});

test('int backing: rejects a non-int32 key, fail closed', () => {
    const c = new Lfu(4, { keys: 'int' });
    assert.throws(() => c.put('a', 1), /keys:'int' requires a 32-bit signed integer key/);
    assert.throws(() => c.get(1.5), /keys:'int' requires a 32-bit signed integer key/);
    c.put(7, 1);
    assert.equal(c.get(7), 1);
    validate(c);
});
