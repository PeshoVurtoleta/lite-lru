/**
 * @zakkster/lite-lru -- node:test boundary suite for opt-in runtime stats
 * (decisions/0019, session S12; extended S7-QA to the S7 Slru/TwoQ members,
 * decisions/0015 D15.5). Parameterized over ALL SIX family members (LiteLru,
 * Sieve, S3Fifo, WTinyLfu, Slru, TwoQ) so a counting regression in any one member's
 * get/put/_reap override is caught the same way. The centrepiece is BRUTE-TALLY
 * PARITY over the T5 corpus: a seeded mixed get/put/delete/has/peek stream is driven
 * against a `{ stats: true }` cache while the four counters are INDEPENDENTLY
 * recomputed from observable semantics (never reading the instance counters to
 * decide), then compared exactly.
 *
 * The counting law is member-INDEPENDENT (decisions/0019, D19.2):
 *   - get(key): a HIT iff the key is currently resident+live (non-TTL: resident),
 *     else a MISS.
 *   - put(key): always one `puts`; an insert of an ABSENT key at capacity evicts
 *     exactly one entry -> one `eviction`. An update (present key) never evicts.
 *   - delete / has / peek: hit/miss/puts/eviction-NEUTRAL (an explicit delete is not
 *     an eviction; has/peek are inspections, not accesses).
 * so ONE tally proves every member.
 *
 * Plus the stated laws: has/peek neutrality, the stale-TTL miss+evict law, fail-closed
 * accessors on a non-stats instance, and the `stats: true` door rejecting a bad value.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, LruK } from '../Lru.js';
import { validate } from './validate.mjs';

/** Every family member, so each body runs SEVEN TIMES over the exact same LiteCache
 *  surface (the stats contract is stated once on LiteCache, decisions/0019). Slru/TwoQ/Arc
 *  (decisions/0015 D15.5, 0016 D16.6) count identically: segment movement (promotion/
 *  demotion/ghost-admission) and ARC's `p` adaptation are NOT evictions, so the SAME
 *  outcome-based tally proves them too. */
const MEMBERS = [
    { name: 'LiteLru', Ctor: LiteLru },
    { name: 'Sieve', Ctor: Sieve },
    { name: 'S3Fifo', Ctor: S3Fifo },
    { name: 'WTinyLfu', Ctor: WTinyLfu },
    { name: 'Slru', Ctor: Slru },
    { name: 'TwoQ', Ctor: TwoQ },
    { name: 'Arc', Ctor: Arc },
    { name: 'LruK', Ctor: LruK },
];

/** Seeded xorshift32 (same generator the torture harness uses) -- deterministic,
 *  zero external coupling. Must not be seeded with 0. */
function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/**
 * Drive the T5 corpus (get/put/delete/has/peek) against a stats cache and recompute
 * the four counters INDEPENDENTLY of the instance counters. Returns the expected
 * tally; the caller asserts it deep-equals `cache.stats()`. Non-TTL, so the `has`
 * probes used to classify a get/put are pure (they never mutate or reap).
 */
function bruteTally(cache, cap, ops, seed, keyspace) {
    const prng = makePrng(seed);
    const exp = { hits: 0, misses: 0, evictions: 0, puts: 0 };
    for (let i = 0; i < ops; i++) {
        const kind = prng() % 5;
        const key = prng() % keyspace;
        const val = prng() >>> 0;
        switch (kind) {
            case 0: // get: hit iff resident (has is pure under non-TTL)
                if (cache.has(key)) exp.hits++; else exp.misses++;
                cache.get(key);
                break;
            case 1: // put: one `puts`; an absent key at capacity evicts one
                exp.puts++;
                if (!cache.has(key) && cache.size === cap) exp.evictions++;
                cache.put(key, val);
                break;
            case 2: // delete: NEUTRAL (an explicit delete is not an eviction)
                cache.delete(key);
                break;
            case 3: // has: NEUTRAL
                cache.has(key);
                break;
            default: // peek: NEUTRAL
                cache.peek(key);
                break;
        }
    }
    return exp;
}

// --- brute-tally parity over the T5 corpus, all four members -----------------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] stats() matches a brute tally over the T5 corpus (D19.2)', () => {
        // A spread of caps/keyspaces so hits, misses AND evictions all fire often.
        const configs = [
            { cap: 1, keyspace: 4, ops: 20000, seed: 0x51 },   // degenerate cap-1
            { cap: 8, keyspace: 24, ops: 40000, seed: 0x52 },
            { cap: 64, keyspace: 200, ops: 60000, seed: 0x53 },
            { cap: 256, keyspace: 300, ops: 60000, seed: 0x54 }, // high hit rate
        ];
        const total = { hits: 0, misses: 0, evictions: 0, puts: 0 };
        for (const cfg of configs) {
            const cache = new Ctor(cfg.cap, { stats: true });
            const exp = bruteTally(cache, cfg.cap, cfg.ops, cfg.seed, cfg.keyspace);
            assert.deepEqual(
                { ...cache.stats() }, exp,
                name + ' stats drifted from the brute tally at cap ' + cfg.cap);
            total.hits += exp.hits; total.misses += exp.misses;
            total.evictions += exp.evictions; total.puts += exp.puts;
            validate(cache); // structural backstop
        }
        // The corpus is only meaningful if every counter fired somewhere across it.
        assert.ok(total.hits > 0 && total.misses > 0 && total.evictions > 0 && total.puts > 0,
            name + ' T5 corpus did not exercise all four counters: ' + JSON.stringify(total));
    });
}

// --- puts is OUTCOME-based: a throwing put counts nothing (D19.2) ------------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] puts is outcome-based: a throwing put ticks nothing; insert+update each tick 1', () => {
        const cache = new Ctor(8, { keys: 'int', stats: true });
        assert.equal(cache.stats().puts, 0, name + ' fresh stats().puts should be 0');
        // A valid insert ticks puts by exactly 1.
        cache.put(1, 111);
        assert.equal(cache.stats().puts, 1, name + ' a valid insert did not tick puts by 1');
        // A valid update (same key) ticks puts by exactly 1 more.
        cache.put(1, 222);
        assert.equal(cache.stats().puts, 2, name + ' a valid update did not tick puts by 1');
        assert.equal(cache.get(1), 222, name + ' update did not store the new value');
        // A put with an invalid (non-int) key throws under keys:'int' and stores nothing.
        assert.throws(() => cache.put('notanint', 9), /\[lite-lru\]/, name + ' a non-int key did not throw');
        assert.equal(cache.stats().puts, 2, name + ' a throwing put (non-int key) still ticked puts');
        // An out-of-range int key also throws and counts nothing.
        assert.throws(() => cache.put(2147483648, 9), /\[lite-lru\]/, name + ' an out-of-range key did not throw');
        assert.equal(cache.stats().puts, 2, name + ' a throwing put (out-of-range key) still ticked puts');
        // A ttlMs on a non-ttl instance throws before mutating and counts nothing.
        assert.throws(() => cache.put(3, 9, 1000), /\[lite-lru\]/, name + ' ttlMs on a non-ttl cache did not throw');
        assert.equal(cache.stats().puts, 2, name + ' a throwing put (ttlMs, no ttl column) still ticked puts');
        // The cache is still consistent after the throws: only the one live key remains.
        assert.equal(cache.size, 1, name + ' a throwing put mutated size');
        validate(cache);
    });
}

// --- has/peek are hit/miss/eviction-NEUTRAL (D19.2) --------------------------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] has()/peek() never touch a counter (live OR absent)', () => {
        const cache = new Ctor(8, { stats: true });
        for (let i = 0; i < 8; i++) cache.put(i, i * 2 + 1);
        const before = { ...cache.stats() };
        // Live keys and absent keys, through both inspectors.
        for (let i = 0; i < 8; i++) { cache.has(i); cache.peek(i); }
        for (let k = 100; k < 108; k++) { cache.has(k); cache.peek(k); }
        assert.deepEqual({ ...cache.stats() }, before,
            name + ' has()/peek() perturbed a counter');
    });
}

// --- the stale-TTL miss+evict law (D19.2) -----------------------------------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] a stale-TTL get is a MISS and an EVICTION (D19.2)', () => {
        let now = 0;
        const cache = new Ctor(8, { stats: true, ttl: 10, clock: () => now });
        cache.put(1, 111);           // puts = 1
        assert.equal(cache.get(1), 111); // live hit -> hits = 1
        now = 100;                   // key 1 is now stale
        const before = { ...cache.stats() };
        assert.equal(cache.get(1), undefined); // stale = miss + reap
        const after = cache.stats();
        assert.equal(after.misses, before.misses + 1, name + ' stale get did not count a miss');
        assert.equal(after.evictions, before.evictions + 1, name + ' stale get did not count an eviction');
        assert.equal(after.hits, before.hits, name + ' stale get wrongly counted a hit');
        assert.equal(cache.size, 0, name + ' stale get did not reap the entry');
        validate(cache);
    });
}

// --- resetStats() zeroes IN PLACE; the holder is BORROWED (D19.3) ------------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] stats() is borrowed by reference; resetStats() zeroes in place (D19.3)', () => {
        const cache = new Ctor(8, { stats: true });
        const holder = cache.stats();
        assert.equal(cache.stats(), holder, name + ' stats() holder identity is not stable');
        for (let i = 0; i < 8; i++) cache.put(i, i);
        cache.get(0); cache.get(999);
        // The borrowed reference sees the live counters advance.
        assert.ok(holder.puts >= 8 && holder.hits >= 1 && holder.misses >= 1,
            name + ' borrowed holder did not reflect live counters');
        cache.resetStats();
        assert.equal(cache.stats(), holder, name + ' resetStats() replaced the holder object');
        assert.deepEqual({ ...holder }, { hits: 0, misses: 0, evictions: 0, puts: 0 },
            name + ' resetStats() did not zero the four counters');
    });
}

// --- fail closed: accessors on a non-stats instance throw (D19.5) -----------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] stats()/resetStats() fail closed without { stats: true } (D19.5)', () => {
        const cache = new Ctor(8);
        assert.equal(cache._stats, null, name + ' a non-stats instance should have _stats === null');
        assert.throws(() => cache.stats(), /\[lite-lru\]/, name + ' stats() did not fail closed');
        assert.throws(() => cache.resetStats(), /\[lite-lru\]/, name + ' resetStats() did not fail closed');
    });
}

// --- fail closed: the `stats` door rejects a bad value (D19.5) ---------------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] the { stats } door rejects a non-true value (D19.5)', () => {
        for (const bad of [1, 0, 'yes', false, {}, null]) {
            assert.throws(() => new Ctor(8, { stats: bad }), TypeError,
                name + ' the stats door admitted ' + String(bad));
        }
        // The two accepted forms construct without throwing.
        assert.doesNotThrow(() => new Ctor(8));
        assert.doesNotThrow(() => new Ctor(8, { stats: true }));
        assert.doesNotThrow(() => new Ctor(8, { stats: undefined }));
    });
}

// --- ADVERSARIAL: degenerate capacities 1/2/3, eviction count EXACT (QA S12) -

for (const { name, Ctor } of MEMBERS) {
    for (const cap of [1, 2, 3]) {
        test('[' + name + '] cap=' + cap + ': repeated over-capacity puts of distinct keys tick evictions EXACTLY', () => {
            const cache = new Ctor(cap, { stats: true });
            const N = cap + 37; // strictly more distinct keys than capacity
            for (let k = 0; k < N; k++) cache.put(k, k * 3 + 1);
            const st = cache.stats();
            assert.equal(st.puts, N, name + ' cap=' + cap + ' puts should equal ' + N + ' distinct inserts');
            assert.equal(st.evictions, N - cap,
                name + ' cap=' + cap + ' evictions should be exactly ' + (N - cap) + ', got ' + st.evictions);
            assert.equal(st.hits, 0, name + ' cap=' + cap + ' no get() was called; hits should be 0');
            assert.equal(cache.size, cap, name + ' cap=' + cap + ' size should settle at capacity');
            validate(cache);
        });
    }
}

// --- ADVERSARIAL: the S11 iteration walk is counter-NEUTRAL (QA S12) --------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] keys()/values()/entries()/[Symbol.iterator] never touch a counter', () => {
        const cache = new Ctor(6, { stats: true });
        for (let i = 0; i < 6; i++) cache.put(i, i * 5);
        const before = { ...cache.stats() };
        let n = 0;
        for (const k of cache.keys()) { n++; void k; }
        for (const v of cache.values()) { n++; void v; }
        for (const [k, v] of cache.entries()) { n++; void k; void v; }
        for (const [k, v] of cache) { n++; void k; void v; } // default iterator (Symbol.iterator)
        assert.ok(n === 6 * 4, name + ' the walk did not visit every live entry exactly once per pass');
        assert.deepEqual({ ...cache.stats() }, before,
            name + ' an iteration walk forged a hit/miss/eviction/put');
    });
}

// --- ADVERSARIAL: the S10 TTL interop -- stale get, no double-count (QA S12) -

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] a stale get reaps once; a subsequent put does NOT double-count the eviction', () => {
        let now = 0;
        const cache = new Ctor(2, { stats: true, ttl: 10, clock: () => now });
        cache.put(1, 111); // puts=1
        cache.put(2, 222); // puts=2, size=2=cap (no eviction yet: below-capacity fill)
        now = 100;          // both entries are now stale
        const before = { ...cache.stats() };
        assert.equal(cache.get(1), undefined, name + ' a stale get should be a miss');
        const afterGet = { ...cache.stats() };
        assert.equal(afterGet.misses, before.misses + 1, name + ' stale get did not count exactly one miss');
        assert.equal(afterGet.evictions, before.evictions + 1, name + ' stale get did not count exactly one eviction');
        assert.equal(afterGet.hits, before.hits, name + ' stale get wrongly counted a hit');
        assert.equal(cache.size, 1, name + ' the stale get did not reap the entry (size should drop to 1)');
        // The reap freed a slot: a subsequent put of a NEW key has room and must NOT
        // trigger a second, redundant eviction (no double count across the two sites).
        cache.put(3, 333); // puts+1, size back to 2=cap, but NO eviction (there was room)
        const afterPut = cache.stats();
        assert.equal(afterPut.puts, afterGet.puts + 1, name + ' the fill-in put did not tick puts by 1');
        assert.equal(afterPut.evictions, afterGet.evictions,
            name + ' the fill-in put after a reap wrongly double-counted an eviction');
        assert.equal(cache.size, 2, name + ' cache should be back at capacity after the fill-in put');
        validate(cache);
    });
}

// --- ADVERSARIAL: stale has()/peek() reap -- hit/miss-NEUTRAL but DOES evict,
// pinned per D19.2 ("a stale has/peek reap is the same eviction mechanism,
// counted once, at _reap") (QA S12) -----------------------------------------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] a stale has()/peek() reaps the entry: eviction++ but hits/misses NEUTRAL (D19.2)', () => {
        let now = 0;
        const cache = new Ctor(4, { stats: true, ttl: 10, clock: () => now });
        cache.put(1, 111);
        cache.put(2, 222);
        now = 100; // both stale
        const beforeHas = { ...cache.stats() };
        assert.equal(cache.has(1), false, name + ' has() on a stale key should report absent');
        const afterHas = cache.stats();
        assert.equal(afterHas.hits, beforeHas.hits, name + ' has() must never register a hit');
        assert.equal(afterHas.misses, beforeHas.misses, name + ' has() must never register a miss (neutral, not "a miss")');
        assert.equal(afterHas.evictions, beforeHas.evictions + 1,
            name + ' a stale has() reap must still tick exactly one eviction (D19.2)');
        assert.equal(cache.size, 1, name + ' has() did not reap the stale entry');

        const beforePeek = { ...cache.stats() };
        assert.equal(cache.peek(2), undefined, name + ' peek() on a stale key should report absent');
        const afterPeek = cache.stats();
        assert.equal(afterPeek.hits, beforePeek.hits, name + ' peek() must never register a hit');
        assert.equal(afterPeek.misses, beforePeek.misses, name + ' peek() must never register a miss (neutral, not "a miss")');
        assert.equal(afterPeek.evictions, beforePeek.evictions + 1,
            name + ' a stale peek() reap must still tick exactly one eviction (D19.2)');
        assert.equal(cache.size, 0, name + ' peek() did not reap the stale entry');
        validate(cache);
    });
}

// --- ADVERSARIAL: onEvict-during-put interop (QA S12) ------------------------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] puts++ / evictions++ land even though onEvict fires LAST and throws', () => {
        const seen = [];
        const cache = new Ctor(2, {
            stats: true,
            onEvict: (k, v) => { seen.push([k, v]); throw new Error('boom-from-onEvict'); },
        });
        cache.put(1, 'a'); // no eviction (below capacity)
        cache.put(2, 'b'); // no eviction (fills capacity)
        assert.equal(cache.stats().puts, 2, name + ' the two fill puts did not tick puts');
        // The third put evicts key 1 and fires onEvict, which throws. The counting law
        // (D19.2/owner change) is OUTCOME-based on the STORE mutation, not on onEvict:
        // the put already landed (new key inserted, victim evicted) before onEvict runs,
        // so puts/evictions must ALREADY be ticked when the throw propagates.
        assert.throws(() => cache.put(3, 'c'), /boom-from-onEvict/,
            name + ' onEvict throwing did not propagate out of put()');
        assert.equal(seen.length, 1, name + ' onEvict should have fired exactly once');
        const st = cache.stats();
        assert.equal(st.puts, 3, name + ' the put that landed before onEvict threw did not tick puts');
        assert.equal(st.evictions, 1, name + ' the eviction that landed before onEvict threw did not tick evictions');
        assert.equal(cache.size, 2, name + ' cache size should still be at capacity after the throwing onEvict');
        assert.equal(cache.get(3), 'c', name + ' the new key did not actually land despite onEvict throwing');
        validate(cache);
    });
}

// --- ADVERSARIAL: resetStats() mid-life, then CONTINUE counting (QA S12) ----

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] resetStats() mid-life zeroes in place; counting continues on the SAME holder', () => {
        const cache = new Ctor(4, { stats: true });
        const holder = cache.stats();
        for (let i = 0; i < 4; i++) cache.put(i, i);
        cache.get(0); cache.get(999);
        assert.ok(holder.puts > 0, name + ' pre-reset holder did not accumulate puts');
        cache.resetStats();
        assert.equal(cache.stats(), holder, name + ' resetStats() must not replace the holder object');
        assert.deepEqual({ ...holder }, { hits: 0, misses: 0, evictions: 0, puts: 0 },
            name + ' resetStats() did not zero all four counters in place');
        // Continue using the cache AFTER the reset: the SAME holder must keep advancing.
        cache.put(10, 10);      // puts = 1
        cache.get(10);           // hits = 1
        cache.get(12345);        // misses = 1
        assert.equal(cache.stats(), holder, name + ' the holder identity changed after post-reset activity');
        assert.equal(holder.puts, 1, name + ' post-reset put did not tick the SAME holder');
        assert.equal(holder.hits, 1, name + ' post-reset hit did not tick the SAME holder');
        assert.equal(holder.misses, 1, name + ' post-reset miss did not tick the SAME holder');
        validate(cache);
    });
}

// --- ADVERSARIAL boundary matrix on the stats surface itself (QA S12) -------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] stats boundary matrix: 0/1/N-1/N/N+1 ops, empty cache, duplicate resetStats, re-entrant write', () => {
        // 0 ops: a freshly constructed stats cache reads all-zero, holder is plain.
        const cache = new Ctor(4, { stats: true });
        assert.deepEqual({ ...cache.stats() }, { hits: 0, misses: 0, evictions: 0, puts: 0 },
            name + ' a fresh stats holder (0 ops) should be all-zero');

        // 1 op.
        cache.put(0, 'x');
        assert.equal(cache.stats().puts, 1, name + ' 1 op did not tick puts to 1');

        // N-1, N, N+1 relative to capacity=4: fill to N-1 (3 total, still below cap),
        // then to N (cap, no eviction yet), then N+1 (first eviction).
        cache.put(1, 'y'); // 2 total (N-1 relative to cap=4 -> total 2 < cap)
        cache.put(2, 'z'); // 3 total
        cache.put(3, 'w'); // N: 4 total == cap, no eviction
        assert.equal(cache.stats().evictions, 0, name + ' filling to exactly capacity must not evict');
        cache.put(4, 'v'); // N+1: 5th distinct key at capacity -> exactly one eviction
        assert.equal(cache.stats().evictions, 1, name + ' the N+1th distinct key did not evict exactly once');

        // Duplicate resetStats(): calling it twice in a row is idempotent (still zero,
        // still the same holder, no throw on the second call).
        const holder = cache.stats();
        cache.resetStats();
        cache.resetStats(); // duplicate "dispose"-shaped call: must not throw or corrupt
        assert.equal(cache.stats(), holder, name + ' duplicate resetStats() changed holder identity');
        assert.deepEqual({ ...holder }, { hits: 0, misses: 0, evictions: 0, puts: 0 },
            name + ' duplicate resetStats() left stray counts');

        // Re-entrant write: an onEvict that calls stats()/resetStats() on the SAME
        // instance mid-eviction is allowed (stats() is a pure read of a cold field, not
        // a mutating cache method) and must observe the eviction that is already ticked
        // (evictions++ happens before onEvict fires, D19.2/owner change).
        let seenDuringEvict = null;
        const reentrant = new Ctor(1, {
            stats: true,
            onEvict: () => { seenDuringEvict = reentrant.stats().evictions; },
        });
        reentrant.put(1, 'a');
        reentrant.put(2, 'b'); // evicts key 1, onEvict reads stats() reentrantly
        assert.equal(seenDuringEvict, 1,
            name + ' a reentrant stats() read during onEvict did not see the just-ticked eviction');
        assert.equal(reentrant.stats().evictions, 1, name + ' post-hoc evictions mismatched the reentrant read');

        // Adversarial case the planner did not think of: resetStats() called FROM
        // INSIDE onEvict (a re-entrant WRITE to the stats holder, not just a read) must
        // not corrupt the holder identity or throw, and the eviction already ticked
        // before onEvict fired is wiped by the reset (resetStats is unconditional).
        const reentrantWrite = new Ctor(1, {
            stats: true,
            onEvict: () => { reentrantWrite.resetStats(); },
        });
        const rwHolder = reentrantWrite.stats();
        reentrantWrite.put(1, 'a');
        reentrantWrite.put(2, 'b'); // evicts key 1; onEvict resets the holder in place
        assert.equal(reentrantWrite.stats(), rwHolder,
            name + ' a reentrant resetStats() inside onEvict replaced the holder identity');
        assert.deepEqual({ ...rwHolder }, { hits: 0, misses: 0, evictions: 0, puts: 0 },
            name + ' a reentrant resetStats() inside onEvict did not leave the holder zeroed');
        validate(reentrantWrite);
    });
}
