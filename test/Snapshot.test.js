/**
 * @zakkster/lite-lru -- node:test boundary suite for snapshot/restore
 * (decisions/0021, session S-next). Parameterized over ALL TEN family members
 * (LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro) so a
 * capture/reconstruct regression in any one member's dump()/restore() override is
 * caught the same way.
 *
 * The centrepiece is ROUND-TRIP IDENTITY: dump() -> structuredClone -> restore()
 * reproduces the exact resident order + values + size, and a restored cache decides
 * FUTURE evictions identically to the original (the un-snapshotted twin) fed the same
 * trace. Plus the eight fail-closed rejection cases (D21.3), the capacity law on load
 * (never truncate), the S10/S11/S12 interop laws (TTL verbatim expiry, fresh stats,
 * dump-mid-iteration read-only), degenerate caps 1/2/3/4, and degenerate keys/values.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro, LruK, Mq, Car } from '../Lru.js';
import { validate } from './validate.mjs';

/** Every family member -- each body runs TWELVE TIMES over the same LiteCache surface. */
const MEMBERS = [
    { name: 'LiteLru', Ctor: LiteLru },
    { name: 'Sieve', Ctor: Sieve },
    { name: 'S3Fifo', Ctor: S3Fifo },
    { name: 'WTinyLfu', Ctor: WTinyLfu },
    { name: 'Slru', Ctor: Slru },
    { name: 'TwoQ', Ctor: TwoQ },
    { name: 'Arc', Ctor: Arc },
    { name: 'Lirs', Ctor: Lirs },
    { name: 'Lfu', Ctor: Lfu },
    { name: 'ClockPro', Ctor: ClockPro },
    { name: 'LruK', Ctor: LruK },
    { name: 'Mq', Ctor: Mq },
];

/** Seeded xorshift32 (same generator the torture harness uses). */
function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Drain entries(), COPYING the borrowed [k, v] tuple. */
function pairs(cache) {
    const a = [];
    for (const [k, v] of cache.entries()) a.push([k, v]);
    return a;
}

/** The next over-capacity victim, member-agnostic (test-only introspection). */
function victim(cache) {
    if (typeof cache._peekVictim === 'function') return cache._peekVictim();
    return cache._tail === -1 ? undefined : cache._keys[cache._tail];
}

// --- round-trip identity over a churned state, both backings -----------------

for (const { name, Ctor } of MEMBERS) {
    for (const keys of [undefined, 'int']) {
        test('[' + name + '] dump -> structuredClone -> restore reproduces order/values/size (keys=' + String(keys) + ')', () => {
            const o = keys ? { keys } : undefined;
            const c = new Ctor(24, o);
            const prng = makePrng(0xC0FFEE ^ name.length ^ (keys ? 5 : 0));
            for (let i = 0; i < 4000; i++) {
                const kind = prng() % 5, key = prng() % 72, val = prng() >>> 0;
                if (kind === 0) c.get(key);
                else if (kind === 1) c.put(key, val);
                else if (kind === 2) c.delete(key);
                else if (kind === 3) c.has(key);
                else c.peek(key);
            }
            validate(c);
            const snap = c.dump();
            assert.equal(snap.f, 'litelru/1', name + ' snapshot format tag');
            assert.equal(snap.m, name, name + ' snapshot member tag');
            assert.equal(snap.cap, 24, name + ' snapshot capacity tag');
            assert.equal(snap.keys, keys === 'int' ? 'int' : null, name + ' snapshot keys tag');
            assert.equal(snap.ttl, false, name + ' snapshot ttl tag');
            const r = Ctor.restore(structuredClone(snap), o);
            validate(r);
            assert.equal(r.size, c.size, name + ' restored size drift');
            assert.deepEqual(pairs(r), pairs(c), name + ' restored entries drift');
            // dump -> restore -> dump is a fixed point (ignoring the capture-time field).
            const s2 = r.dump();
            assert.deepEqual({ ...s2, t: 0 }, { ...snap, t: 0 }, name + ' dump is not a fixed point');
        });
    }
}

// --- future-eviction differential: restored vs the un-snapshotted twin -------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] a restored cache decides future evictions identically to the twin', () => {
        const c = new Ctor(64, { keys: 'int' });
        const pre = makePrng(0xBEEF ^ name.length);
        for (let i = 0; i < 6000; i++) {
            const kind = pre() % 5, key = pre() % 200, val = pre() >>> 0;
            if (kind === 0) c.get(key); else if (kind === 1) c.put(key, val);
            else if (kind === 2) c.delete(key); else if (kind === 3) c.has(key); else c.peek(key);
        }
        const r = Ctor.restore(structuredClone(c.dump()), { keys: 'int' });
        const fut = makePrng(0xF00D ^ name.length);
        for (let i = 0; i < 30000; i++) {
            const kind = fut() % 5, key = fut() % 200, val = fut() >>> 0;
            let rc, rr;
            if (kind === 0) { rc = c.get(key); rr = r.get(key); }
            else if (kind === 1) { c.put(key, val); r.put(key, val); }
            else if (kind === 2) { rc = c.delete(key); rr = r.delete(key); }
            else if (kind === 3) { rc = c.has(key); rr = r.has(key); }
            else { rc = c.peek(key); rr = r.peek(key); }
            assert.ok(Object.is(rc, rr), name + ' value drift at op ' + i);
            assert.equal(r.size, c.size, name + ' size drift at op ' + i);
            assert.ok(Object.is(victim(r), victim(c)), name + ' victim drift at op ' + i);
        }
    });
}

// --- fail closed: the eight rejection cases (D21.3) --------------------------

test('restore fail-closed rejections (D21.3)', () => {
    const src = new LiteLru(8);
    for (let i = 0; i < 8; i++) src.put(i, i * 3 + 1);
    const good = src.dump();

    // (1) member mismatch: restoring a LiteLru snapshot as a Sieve.
    assert.throws(() => Sieve.restore(structuredClone(good)), /\[lite-lru\].*member mismatch/,
        'a member mismatch was not rejected');

    // (2) wrong format tag f.
    assert.throws(() => LiteLru.restore({ ...structuredClone(good), f: 'nope/9' }), /\[lite-lru\].*format tag/,
        'a wrong format tag was not rejected');

    // (3) absent format tag f.
    { const s = structuredClone(good); delete s.f; assert.throws(() => LiteLru.restore(s), /\[lite-lru\].*format tag/, 'an absent format tag was not rejected'); }

    // (4) a non-object snapshot.
    assert.throws(() => LiteLru.restore(null), /\[lite-lru\].*plain object/, 'a null snapshot was not rejected');
    assert.throws(() => LiteLru.restore(42), /\[lite-lru\].*plain object/, 'a non-object snapshot was not rejected');

    // (5) capacity conflict vs an explicit opts.capacity.
    assert.throws(() => LiteLru.restore(structuredClone(good), { capacity: 9 }), /\[lite-lru\].*capacity opt/,
        'a capacity/opts conflict was not rejected');

    // (6) keys-backing mismatch (Map snapshot restored with { keys: 'int' }).
    assert.throws(() => LiteLru.restore(structuredClone(good), { keys: 'int' }), /\[lite-lru\].*keys opt/,
        'a keys-backing mismatch was not rejected');

    // (7) ttl on/off mismatch: a non-ttl snapshot restored WITH a ttl option.
    assert.throws(() => LiteLru.restore(structuredClone(good), { ttl: 100 }), /\[lite-lru\].*ttl/,
        'a ttl option on a non-ttl snapshot was not rejected');
    // ... and a ttl snapshot restored WITHOUT the required ttl default.
    const ttlSrc = new LiteLru(8, { ttl: 100, clock: () => 0 });
    for (let i = 0; i < 8; i++) ttlSrc.put(i, i);
    assert.throws(() => LiteLru.restore(structuredClone(ttlSrc.dump())), /\[lite-lru\].*ttl/,
        'a ttl snapshot without a ttl option was not rejected');

    // (8) corrupt/short field: a value column shorter than the slots column.
    { const s = structuredClone(good); s.list.v.pop(); assert.throws(() => LiteLru.restore(s), /\[lite-lru\].*length mismatch/, 'a short value column was not rejected'); }
    // ... a missing list entirely.
    { const s = structuredClone(good); delete s.list; assert.throws(() => LiteLru.restore(s), /\[lite-lru\].*malformed/, 'a missing list was not rejected'); }
    // ... a bad capacity in the tag.
    assert.throws(() => LiteLru.restore({ ...structuredClone(good), cap: 0 }), /\[lite-lru\].*capacity must be/,
        'a bad capacity tag was not rejected');
});

// --- capacity law on load: never truncate, REJECT (D21.3) --------------------

test('capacity law on load: an over-capacity or corrupt-slot snapshot is REJECTED, never truncated', () => {
    const src = new LiteLru(4);
    for (let i = 0; i < 4; i++) src.put(i, i);
    // A slot index out of [0, cap): reject.
    { const s = structuredClone(src.dump()); s.list.slots[0] = 4; assert.throws(() => LiteLru.restore(s), /\[lite-lru\].*out of range/, 'an out-of-range slot was not rejected'); }
    // A duplicate slot (which would let residents exceed capacity): reject.
    { const s = structuredClone(src.dump()); s.list.slots[1] = s.list.slots[0]; assert.throws(() => LiteLru.restore(s), /\[lite-lru\].*duplicate slot/, 'a duplicate slot was not rejected'); }
});

// --- S10 interop: TTL captured VERBATIM (absolute deadlines, not rebased) ----

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] TTL interop: restored entries expire at their VERBATIM absolute deadlines (D21)', () => {
        let now = 0;
        const c = new Ctor(8, { ttl: 100, clock: () => now });
        c.put(1, 111);        // exp = 100
        c.put(2, 222, 40);    // exp = 40
        c.put(3, 333, Infinity); // never
        now = 30;
        const r = Ctor.restore(structuredClone(c.dump()), { ttl: 100, clock: () => now });
        now = 50; // past 2's deadline (40), before 1's (100)
        assert.equal(r.get(2), undefined, name + ' short-ttl entry did not expire at its verbatim deadline');
        assert.equal(r.get(1), 111, name + ' default-ttl entry expired too early (rebased?)');
        assert.equal(r.get(3), 333, name + ' Infinity-ttl entry expired');
        now = 200;
        assert.equal(r.get(1), undefined, name + ' default-ttl entry did not expire by its verbatim deadline');
        assert.equal(r.get(3), 333, name + ' Infinity-ttl entry expired at 200');
        validate(r);
    });
}

// --- S12 interop: a restored instance starts with FRESH zeroed stats ---------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] stats interop: a restored { stats: true } instance starts fresh-zeroed (D21)', () => {
        const c = new Ctor(8, { stats: true });
        for (let i = 0; i < 12; i++) c.put(i, i);
        c.get(11); c.get(9999);
        assert.ok(c.stats().puts > 0, name + ' setup did not accumulate stats');
        const r = Ctor.restore(structuredClone(c.dump()), { stats: true });
        assert.deepEqual({ ...r.stats() }, { hits: 0, misses: 0, evictions: 0, puts: 0 },
            name + ' restored stats are not fresh-zeroed');
        // A restore WITHOUT { stats: true } has no holder (fail closed on stats()).
        const r2 = Ctor.restore(structuredClone(c.dump()));
        assert.throws(() => r2.stats(), /\[lite-lru\]/, name + ' a restore without stats did not fail closed');
        validate(r);
    });
}

// --- S11 interop: dump() mid-iteration is read-only (does NOT bump _ver) ------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] iteration interop: dump() mid-walk does not invalidate a live iterator (D21)', () => {
        const c = new Ctor(8);
        for (let i = 0; i < 8; i++) c.put(i, i * 2 + 1);
        const it = c.entries();
        it.next();
        const verBefore = c._store._ver;
        c.dump(); // read-only: must not bump _ver
        assert.equal(c._store._ver, verBefore, name + ' dump() bumped _ver (not read-only)');
        let stepped = 0;
        for (let r = it.next(); !r.done; r = it.next()) stepped++;
        assert.ok(stepped > 0, name + ' the iterator did not continue after a dump() mid-walk');
    });
}

// --- degenerate capacities 1/2/3/4 -------------------------------------------

for (const { name, Ctor } of MEMBERS) {
    for (const cap of [1, 2, 3, 4]) {
        test('[' + name + '] cap=' + cap + ': round-trip survives the degenerate splits', () => {
            for (const keys of [undefined, 'int']) {
                const o = keys ? { keys } : undefined;
                const c = new Ctor(cap, o);
                for (let i = 0; i < cap * 20 + 7; i++) { c.put(i % (cap * 3 + 2), i); if ((i & 1) === 0) c.get(i % (cap * 3 + 2)); }
                validate(c);
                const r = Ctor.restore(structuredClone(c.dump()), o);
                validate(r);
                assert.equal(r.size, c.size, name + ' cap=' + cap + ' restored size drift');
                assert.deepEqual(pairs(r), pairs(c), name + ' cap=' + cap + ' restored entries drift');
                // empty round-trip too.
                const e = new Ctor(cap, o);
                const re = Ctor.restore(structuredClone(e.dump()), o);
                assert.equal(re.size, 0, name + ' cap=' + cap + ' empty restore size');
                assert.equal(re._freeListLength(), cap, name + ' cap=' + cap + ' empty restore free list');
                validate(re);
            }
        });
    }
}

// --- degenerate keys/values (default Map backing) ---------------------------

for (const { name, Ctor } of MEMBERS) {
    test('[' + name + '] degenerate keys/values survive the round-trip', () => {
        const c = new Ctor(8);
        const objKey = { id: 'k' };
        const entries = [
            [5, undefined],      // stored undefined value (distinct from 0/-0)
            [null, 'null-key'],  // null as a key
            ['', 'empty-str'],   // empty-string key
            [NaN, 'nan-key'],    // NaN key (SameValueZero)
            [-0, 'neg-zero'],    // -0 key (SameValueZero: collides with +0, by design)
            [objKey, { v: 1 }],  // object key + object value
            ['s', 'str'],
        ];
        for (const [k, v] of entries) c.put(k, v);
        validate(c);
        // Object keys clone under structuredClone (new identity), so restore WITHOUT a
        // clone to preserve key identity -- the graph is still plain; the clone hazard for
        // object keys is documented, not a bug.
        const r = Ctor.restore(c.dump());
        validate(r);
        assert.equal(r.size, c.size, name + ' degenerate restore size drift');
        // Every present key round-trips with its exact value (has() disambiguates undefined).
        assert.equal(r.has(5), c.has(5), name + ' undefined-value key presence drift');
        assert.equal(r.peek(5), undefined, name + ' undefined value not preserved');
        assert.equal(r.peek(null), 'null-key', name + ' null key not preserved');
        assert.equal(r.peek(''), 'empty-str', name + ' empty-string key not preserved');
        assert.equal(r.peek(NaN), 'nan-key', name + ' NaN key not preserved (SameValueZero)');
        assert.equal(r.peek(-0), 'neg-zero', name + ' -0 key not preserved');
        assert.equal(r.peek('s'), 'str', name + ' string key not preserved');
        if (r.has(objKey)) assert.deepEqual(r.peek(objKey), { v: 1 }, name + ' object-key value not preserved');
    });
}

// --- fail closed: a missing/short/non-binary vis column is REJECTED (D21.3, blocker) --
// Only Sieve (hand sweep), S3Fifo and Slru (promote-on-2nd-hit) emit a `vis` column; a
// corrupt/truncated vis is aux state that steers FUTURE evictions, so it must THROW, not
// coerce the missing tail to 0. Mirrors the short-`v` rejection.
const VIS_MEMBERS = [
    { name: 'Sieve', Ctor: Sieve, lists: ['list'] },
    { name: 'S3Fifo', Ctor: S3Fifo, lists: ['main', 'small'] },
    { name: 'Slru', Ctor: Slru, lists: ['prot', 'prob'] },
];

for (const { name, Ctor, lists } of VIS_MEMBERS) {
    test('[' + name + '] a missing/short/non-binary vis column is REJECTED (D21.3)', () => {
        const build = () => {
            const c = new Ctor(16);
            for (let i = 0; i < 40; i++) { c.put(i % 24, i); if ((i & 1) === 0) c.get(i % 24); }
            return c;
        };
        let tested = 0;
        for (const field of lists) {
            // deleted vis column -> reject.
            { const s = build().dump(); delete s[field].vis; assert.throws(() => Ctor.restore(s), /\[lite-lru\].*vis/, name + ' ' + field + ' missing vis not rejected'); }
            const probe = build().dump();
            if (probe[field].slots.length === 0) continue; // short/non-binary need a non-empty list
            tested++;
            // short vis column (pop one) -> reject.
            { const s = build().dump(); s[field].vis.pop(); assert.throws(() => Ctor.restore(s), /\[lite-lru\].*vis/, name + ' ' + field + ' short vis not rejected'); }
            // non-binary vis byte (2) -> reject.
            { const s = build().dump(); s[field].vis[0] = 2; assert.throws(() => Ctor.restore(s), /\[lite-lru\].*vis/, name + ' ' + field + ' non-binary vis not rejected'); }
        }
        assert.ok(tested > 0, name + ' no non-empty vis list was exercised (setup invalid)');
        // Non-vacuity: the unmutated snapshot restores fine.
        assert.doesNotThrow(() => Ctor.restore(build().dump()), name + ' a correct vis snapshot was rejected (vacuous)');
    });
}

// --- fail closed: a non-int ghost key is REJECTED on the keys:'int' backing (NIT2) ----
// Ghost keys are replayed straight into the open-addressed membership index (bypassing
// store.set's int-key door), so a hand-crafted snapshot with a non-int ghost key would
// silently pollute the index. It must throw [lite-lru], like a bad list key.
test('non-int ghost keys are REJECTED on the keys:int backing (D21.3, NIT2)', () => {
    const build = (C) => {
        const c = new C(16, { keys: 'int' });
        for (let i = 0; i < 80; i++) { c.put(i % 40, i); if ((i & 1) === 0) c.get(i % 40); }
        return c;
    };
    const cases = [['S3Fifo', S3Fifo, 'ghost'], ['TwoQ', TwoQ, 'ghost'], ['Arc', Arc, 'b1']];
    for (const [name, C, field] of cases) {
        const s = build(C).dump();
        if (!Array.isArray(s[field]) || s[field].length === 0) s[field] = [1.5]; // ensure a corrupt ghost key
        else s[field][0] = 1.5; // a non-integer ghost key
        assert.throws(() => C.restore(s, { keys: 'int' }), /\[lite-lru\]/, name + ' a non-int ghost key was not rejected');
    }
    // Non-vacuity: a clean int-ghost snapshot restores fine.
    assert.doesNotThrow(() => S3Fifo.restore(build(S3Fifo).dump(), { keys: 'int' }), 'a correct int-ghost snapshot was rejected (vacuous)');
});

// --- fail closed: member-specific aux state is validated too (QA gap-fill) ---------
// D21.3's eight rejection cases are proven generically (LiteLru) above; the per-member
// aux fields (Arc `p` + both ghosts, WTinyLfu's sketch + aging counter, the S3Fifo/TwoQ
// ghost-vs-ghostCap bound) had NO dedicated boundary coverage anywhere in the suite --
// hand-verified against Lru.js's snapRead/restore bodies before writing these.

test('Arc: a `p` out of [0,cap], a missing ghost array, or a ghost-bound violation is REJECTED', () => {
    const build = () => {
        const c = new Arc(8);
        for (let i = 0; i < 8; i++) c.put(i, i);
        return c;
    };
    // p above the [0,cap] bound.
    { const s = build().dump(); s.p = 999; assert.throws(() => Arc.restore(s), /\[lite-lru\].*arc p out of/, 'p above cap was not rejected'); }
    // p below the [0,cap] bound (negative).
    { const s = build().dump(); s.p = -1; assert.throws(() => Arc.restore(s), /\[lite-lru\].*arc p out of/, 'a negative p was not rejected'); }
    // p non-integer.
    { const s = build().dump(); s.p = 1.5; assert.throws(() => Arc.restore(s), /\[lite-lru\].*arc p out of/, 'a non-integer p was not rejected'); }
    // a missing ghost array (b1).
    { const s = build().dump(); delete s.b1; assert.throws(() => Arc.restore(s), /\[lite-lru\].*missing a ghost array/, 'a missing b1 was not rejected'); }
    // a missing ghost array (b2).
    { const s = build().dump(); delete s.b2; assert.throws(() => Arc.restore(s), /\[lite-lru\].*missing a ghost array/, 'a missing b2 was not rejected'); }
    // |B1| + |B2| > cap (the combined ghost-directory bound, D16.2).
    { const s = build().dump(); s.b1 = [100, 101, 102, 103, 104]; s.b2 = [200, 201, 202, 203, 204, 205]; assert.throws(() => Arc.restore(s), /\[lite-lru\].*B1.*B2.*exceeds capacity/, '|B1|+|B2| > cap was not rejected'); }
    // |T1| + |B1| > cap (the recency-directory bound, D16.2) -- t1 alone is small but b1 pushes it over.
    { const s = build().dump(); s.b1 = [100, 101, 102, 103, 104, 105, 106, 107]; assert.throws(() => Arc.restore(s), /\[lite-lru\].*T1.*B1.*exceeds capacity/, '|T1|+|B1| > cap was not rejected'); }
    // Non-vacuity: the unmutated snapshot restores fine.
    assert.doesNotThrow(() => Arc.restore(build().dump()), 'a correct Arc snapshot was rejected (vacuous)');
});

test('WTinyLfu: a wrong-length, missing, or non-array sketch, or an invalid skSize, is REJECTED', () => {
    const build = () => {
        const c = new WTinyLfu(16);
        for (let i = 0; i < 16; i++) c.put(i, i);
        for (let i = 0; i < 5; i++) c.get(5);
        return c;
    };
    // sketch one word short of the expected packed length.
    { const s = build().dump(); s.sk = s.sk.slice(0, s.sk.length - 1); assert.throws(() => WTinyLfu.restore(s), /\[lite-lru\].*sketch length mismatch/, 'a short sketch was not rejected'); }
    // sketch one word too long.
    { const s = build().dump(); s.sk = s.sk.concat([0]); assert.throws(() => WTinyLfu.restore(s), /\[lite-lru\].*sketch length mismatch/, 'a long sketch was not rejected'); }
    // sketch not an array at all.
    { const s = build().dump(); s.sk = null; assert.throws(() => WTinyLfu.restore(s), /\[lite-lru\].*sketch length mismatch/, 'a non-array sketch was not rejected'); }
    // skSize negative.
    { const s = build().dump(); s.skSize = -1; assert.throws(() => WTinyLfu.restore(s), /\[lite-lru\].*skSize invalid/, 'a negative skSize was not rejected'); }
    // skSize non-integer.
    { const s = build().dump(); s.skSize = 3.5; assert.throws(() => WTinyLfu.restore(s), /\[lite-lru\].*skSize invalid/, 'a non-integer skSize was not rejected'); }
    // Non-vacuity: the unmutated snapshot restores fine.
    assert.doesNotThrow(() => WTinyLfu.restore(build().dump()), 'a correct WTinyLfu snapshot was rejected (vacuous)');
});

test('S3Fifo/TwoQ: a missing ghost array or a ghost exceeding ghostCap is REJECTED', () => {
    const cases = [['S3Fifo', S3Fifo], ['TwoQ', TwoQ]];
    for (const [name, Ctor] of cases) {
        const build = () => {
            const c = new Ctor(16);
            for (let i = 0; i < 40; i++) { c.put(i % 24, i); if ((i & 1) === 0) c.get(i % 24); }
            return c;
        };
        const ghostCap = build()._ghostCap;
        // a missing ghost array entirely.
        { const s = build().dump(); delete s.ghost; assert.throws(() => Ctor.restore(s), /\[lite-lru\].*missing ghost array/, name + ' a missing ghost was not rejected'); }
        // a ghost longer than ghostCap (the bounded-ghost law, D13/D15).
        { const s = build().dump(); s.ghost = Array.from({ length: ghostCap + 5 }, (_, i) => 9000 + i); assert.throws(() => Ctor.restore(s), /\[lite-lru\].*exceeds ghostCap/, name + ' a ghost over ghostCap was not rejected'); }
        // Non-vacuity: the unmutated snapshot restores fine.
        assert.doesNotThrow(() => Ctor.restore(build().dump()), name + ' a correct ghost snapshot was rejected (vacuous)');
    }
});

// --- NIT (owner ruling): the future-eviction differential must have its OWN teeth --
// against dropped aux state, INDEPENDENT of the dump-redump fixed-point leg.
//
// t9's three snapshot controls (arc-p-dropped, sketch-dropped, ghost-omitted) each
// build a BROKEN `restore()` that mutates the SNAPSHOT before delegating to the real
// restore -- so the dropped aux state is dump-VISIBLE, and runRoundTrip's fixed-point
// check (`dump -> restore -> dump` deep-equal, which runs BEFORE the future-eviction
// loop) trips FIRST every time. The future-eviction leg never runs on those controls,
// so it has no proof of its own teeth for a dropped-aux scenario -- confirmed by
// running all three t9 controls standalone: every one reports why:'dump-redump-diff'.
//
// This test closes that gap by corrupting the LIVE RESTORED INSTANCE's in-memory aux
// state AFTER a fully-correct restore -- never the snapshot -- so the fixed-point leg
// is never exercised here at all (it is asserted to hold FIRST, as a sanity check, then
// the corruption happens strictly afterward). Only the future-eviction differential is
// exercised, and it must catch the divergence entirely on its own. (The eviction
// mechanism's own teeth -- that dropping p/sketch/ghost changes an actual eviction
// decision -- already live in C3/C7/C8/C9 and decisions/0016/0014/0013; this test's
// teeth are specifically that the DIFFERENTIAL LOOP notices, independent of the
// stronger fixed-point leg.)
function applyOpTo(cache, kind, key, val) {
    if (kind === 0) return cache.get(key);
    if (kind === 1) { cache.put(key, val); return undefined; }
    if (kind === 2) return cache.delete(key);
    if (kind === 3) return cache.has(key);
    return cache.peek(key);
}

test('NIT: the future-eviction differential has its own teeth, independent of the fixed-point leg', () => {
    const cases = [
        {
            name: 'Arc p-dropped',
            Ctor: Arc,
            corrupt: (r) => { r._p = 0; },
        },
        {
            name: 'WTinyLfu sketch-dropped',
            Ctor: WTinyLfu,
            corrupt: (r) => { r._sk.fill(0); r._skSize = 0; },
        },
        {
            name: 'S3Fifo ghost-dropped',
            Ctor: S3Fifo,
            // Mirrors clear()'s own ghost reset (Lru.js): empty the ring AND the
            // membership structure, so a re-sighting no longer registers as a ghost hit.
            corrupt: (r) => {
                r._gLen = 0; r._gHead = 0;
                if (r._ghostInt) r._gixState.fill(0);
                else { r._gSet.clear(); r._gRingArr.fill(undefined); }
            },
        },
    ];

    for (const { name, Ctor, corrupt } of cases) {
        const orig = new Ctor(64, { keys: 'int' });
        const prng = makePrng(0xC0DE1234 ^ name.length);
        for (let i = 0; i < 40000; i++) {
            const kind = prng() % 5, key = prng() % 200, val = prng() >>> 0;
            applyOpTo(orig, kind, key, val);
        }

        // Sanity FIRST: a correct restore IS a fixed point (proves the mechanism itself
        // is right before we go corrupt it -- otherwise this test would be vacuous).
        const snap = orig.dump();
        const restored = Ctor.restore(structuredClone(snap), { keys: 'int' });
        assert.deepEqual({ ...restored.dump(), t: 0 }, { ...snap, t: 0 },
            name + ': a correct restore was not a fixed point (setup invalid)');

        // Corrupt the LIVE instance now -- the snapshot itself is never touched again,
        // so the fixed-point leg plays no further part in this test.
        corrupt(restored);

        // Drive the SAME future trace against the untouched twin (orig) and the
        // corrupted restored instance; the differential (value / size / next-eviction
        // victim) must catch the divergence on its own before the trace ends.
        const fut = makePrng(0xF00DBEEF ^ name.length);
        let diverged = false;
        for (let i = 0; i < 60000 && !diverged; i++) {
            const kind = fut() % 5, key = fut() % 200, val = fut() >>> 0;
            const ov = applyOpTo(orig, kind, key, val);
            const rv = applyOpTo(restored, kind, key, val);
            if (!Object.is(ov, rv)) diverged = true;
            else if (orig.size !== restored.size) diverged = true;
            else if (!Object.is(victim(orig), victim(restored))) diverged = true;
        }
        assert.ok(diverged, name + ': the future-eviction differential did NOT catch dropped ' +
            'aux state on its own (no independent teeth)');
    }
});

// --- hand-derived independent assertions (QA teeth against a subtly-wrong-but-self- --
// consistent serializer -- a dump()/restore() pair that agrees with ITSELF but not with
// the documented algorithm would still pass every fixed-point check above). Each of
// these expected structures is traced BY HAND against the member's decision doc before
// being asserted, exactly like the ghost-trim assertions in earlier QA passes.

test('Arc: hand-traced T1/T2/p/B1/B2 after a recency-then-frequency phase change survives restore', () => {
    // cap=4. put 1..4 (all new -> T1 MRU..LRU = [4,3,2,1], T2 = [], p = 0).
    const c = new Arc(4);
    c.put(1, 'a'); c.put(2, 'b'); c.put(3, 'c'); c.put(4, 'd');
    // get(1), get(2): ARC promotes ANY hit to T2 (D16.5/decisions/0016) -> T2 MRU..LRU
    // = [2,1] (2 promoted last -> MRU), T1 = [4,3].
    c.get(1); c.get(2);
    let s = c.dump();
    assert.deepEqual(s.t2.k, [2, 1], 'hand-trace: T2 after two promotions');
    assert.deepEqual(s.t1.k, [4, 3], 'hand-trace: T1 after two promotions');
    assert.equal(s.p, 0, 'hand-trace: p unmoved before any ghost hit');

    // put(5): a true miss at capacity. REPLACE(xInB2=false): |T1|=2 >= 1 and
    // |T1|(2) > p(0) -> evict T1 LRU (3) to B1 MRU; push 5 to T1 MRU (D16.4).
    c.put(5, 'e');
    s = c.dump();
    assert.deepEqual(s.t1.k, [5, 4], 'hand-trace: T1 after the true-miss T1 eviction');
    assert.deepEqual(s.b1, [3], 'hand-trace: B1 gains the evicted T1 key');
    assert.equal(s.p, 0, 'hand-trace: a true miss never adapts p');

    // put(3, 'x'): 3 is a B1 hit (xInB2=false). Adaptation (D16.3): p = min(p +
    // max(1, floor(|B2|/|B1|)), c) = min(0 + max(1, floor(0/1)), 4) = 1. REPLACE then
    // runs with the NEW p: |T1|=2 > p(1) -> evict T1 LRU (4) to B1 MRU (3 is consumed
    // from B1 first). The ghost-hit key re-enters at T2 MRU (D16.3: a ghost hit proves
    // frequency), so T2 = [3,2,1], T1 = [5], B1 = [4].
    c.put(3, 'x');
    s = c.dump();
    assert.equal(s.p, 1, 'hand-trace: p adapts up by exactly 1 on a B1 hit with |B2|=0');
    assert.deepEqual(s.t2.k, [3, 2, 1], 'hand-trace: T2 after the B1-hit re-admission');
    assert.deepEqual(s.t1.k, [5], 'hand-trace: T1 after the B1-hit REPLACE');
    assert.deepEqual(s.b1, [4], 'hand-trace: B1 after consuming 3 and gaining 4');
    assert.deepEqual(s.b2, [], 'hand-trace: B2 untouched throughout');

    // The restored instance must reproduce this EXACT hand-traced structure, not just
    // agree with its own pre-restore dump.
    const r = Arc.restore(structuredClone(s));
    const s2 = r.dump();
    assert.deepEqual(s2.t2.k, [3, 2, 1], 'restored T2 drifted from the hand-traced structure');
    assert.deepEqual(s2.t1.k, [5], 'restored T1 drifted from the hand-traced structure');
    assert.equal(s2.p, 1, 'restored p drifted from the hand-traced value');
    assert.deepEqual(s2.b1, [4], 'restored B1 drifted from the hand-traced structure');
    assert.deepEqual(s2.b2, [], 'restored B2 drifted from the hand-traced structure');
    // And the restored cache's NEXT eviction must match the hand-traced state: at
    // capacity (size 4), a true miss evicts T1 (|T1|=1 >= 1, T2 nonempty, but T1(1) is
    // NOT > p(1) -- falls to the "T2 empty?" check, which is false, so evictT1 stays
    // false) -> the victim is the T2 LRU tail, key 1.
    assert.equal(r._peekVictim(), 1, 'restored next-eviction victim drifted from the hand trace');
    validate(r);
});

test('WTinyLfu: sketch counts survive restore exactly (saturating-counter law, D14.2)', () => {
    // cap=16: window=max(1,round(16/100))=1, main=15, protected=round(15*0.8)=12,
    // probation=3. Touch key 5 twenty times via get() (each hit bumps the sketch by
    // one row-set); D14.2 documents a 4-bit SATURATING counter, cap 15 -- so the
    // hand-derived expected frequency is min(20, 15) = 15, independent of the sketch's
    // internal hash/packing (which _sketchFreq decodes for us as a test aid, exactly
    // like _peekVictim is sanctioned test-only introspection elsewhere in this suite).
    const c = new WTinyLfu(16);
    for (let i = 0; i < 16; i++) c.put(i, i);
    for (let i = 0; i < 20; i++) c.get(5);
    const h5 = c._hashKey(5, -1); // numeric key: hashes by VALUE (D14.1), slot irrelevant
    assert.equal(c._sketchFreq(h5), 15, 'hand-derived: 20 bumps saturate a 4-bit counter at 15');
    // An untouched key never inserted after the initial fill has frequency 0 (or a low
    // collision artifact) -- assert it is strictly LESS than the saturated key's, so the
    // restored sketch still discriminates hot from cold.
    const h9 = c._hashKey(9, -1);
    const freq9Before = c._sketchFreq(h9);
    assert.ok(freq9Before < 15, 'hand-derived: an untouched key must not already be saturated (setup invalid)');

    const snap = c.dump();
    const r = WTinyLfu.restore(structuredClone(snap));
    assert.equal(r._sketchFreq(h5), 15, 'restored sketch lost the saturated frequency (hand-derived expectation)');
    assert.equal(r._sketchFreq(h9), freq9Before, 'restored sketch drifted for the untouched key');
    assert.equal(r._skSize, c._skSize, 'restored aging counter (_skSize) drifted from the hand-observed pre-dump value');
    validate(r);
});

test('S3Fifo: hand-traced SMALL/MAIN/ghost/visited-bit structure survives restore exactly', () => {
    // cap=4: smallCap=max(1,floor(4/10))=1, mainCap=3, ghostCap=3 (D13). Sequence traced
    // BY HAND against decisions/0013's eviction sweep (small-tail-first, graduate a
    // visited tail to MAIN, evict an unvisited tail to ghost, ghost is bounded FIFO):
    //   put 1,2,3,4        -> SMALL head..tail (newest..oldest) = [4,3,2,1], no eviction
    //                          yet (size reaches capacity exactly, not over).
    //   get(4)             -> vis[4] = 1 (S3Fifo hits set ONE bit, relink nothing).
    //   put(5)             -> evicts SMALL tail 1 (unvisited) to ghost; SMALL=[5,4,3,2].
    //   put(6)             -> evicts SMALL tail 2 (unvisited) to ghost; SMALL=[6,5,4,3].
    //   put(7)             -> evicts SMALL tail 3 (unvisited) to ghost; SMALL=[7,6,5,4].
    //                          ghost is now [1,2,3] (oldest..newest), at its cap of 3.
    //   put(8)             -> SMALL tail is 4, vis[4]=1 -> GRADUATES to MAIN (vis
    //                          cleared), MAIN=[4]; sweep continues (SMALL still >= its
    //                          target): new tail is 5, vis[5]=0 -> evicted to ghost,
    //                          bumping the FULL ghost (drops oldest=1): ghost=[2,3,5].
    //                          SMALL=[6,7]... wait head/tail bookkeeping -> push 8 ->
    //                          SMALL head..tail = [8,7,6].
    const f = new S3Fifo(4);
    f.put(1, 'a'); f.put(2, 'b'); f.put(3, 'c'); f.put(4, 'd');
    f.get(4);
    f.put(5, 'e'); f.put(6, 'f'); f.put(7, 'g'); f.put(8, 'h');
    const s = f.dump();
    assert.deepEqual(s.main.k, [4], 'hand-trace: MAIN after the graduation');
    assert.deepEqual(s.main.vis, [0], 'hand-trace: a graduated entry\'s visited bit is cleared');
    assert.deepEqual(s.small.k, [8, 7, 6], 'hand-trace: SMALL head..tail after the sweep');
    assert.deepEqual(s.small.vis, [0, 0, 0], 'hand-trace: none of the survivors were re-touched');
    assert.deepEqual(s.ghost, [2, 3, 5], 'hand-trace: bounded ghost FIFO (oldest 1 dropped at cap 3)');

    const r = S3Fifo.restore(structuredClone(s));
    const s2 = r.dump();
    assert.deepEqual(s2.main.k, [4], 'restored MAIN drifted from the hand-traced structure');
    assert.deepEqual(s2.small.k, [8, 7, 6], 'restored SMALL drifted from the hand-traced structure');
    assert.deepEqual(s2.ghost, [2, 3, 5], 'restored ghost drifted from the hand-traced structure');
    // A re-sighting of ghost key 5 must be admitted straight to MAIN (D13) -- proving
    // the restored ghost is not just structurally equal but FUNCTIONALLY live.
    r.put(5, 'zz');
    const s3 = r.dump();
    assert.ok(s3.main.k.includes(5), 'a restored ghost re-sighting did not admit straight to MAIN');
    validate(r);
});

// --- S17 F3/F5/F11: restore input-door tightening ----------------------------
// Recursively collect every captured RESIDENT list (an object with parallel
// slots/k/v arrays). Members nest their lists differently -- LiteLru at
// snap.list, Lfu under buckets[].list, Mq under queues[] -- so we walk the tree.
function residentLists(node, out) {
    if (node === null || typeof node !== 'object') return out;
    if (Array.isArray(node.slots) && Array.isArray(node.k) && Array.isArray(node.v)) {
        out.push(node);
        return out; // a list is a leaf for our purposes
    }
    if (Array.isArray(node)) { for (const el of node) residentLists(el, out); }
    else { for (const key in node) residentLists(node[key], out); }
    return out;
}

// F3: a DUPLICATE KEY (two resident slots carrying the same key) is rejected on
// EVERY backing for EVERY member -- it would clobber the store index (the second
// store.set wins, the first slot orphans). Validation completes before any mutation.
const F3_BACKINGS = [
    ['map', undefined],
    ['int', { keys: 'int' }],
    ['dense', { keys: 'dense', maxKey: 100 }],
];
// The base MEMBERS roster omits Car (a control member); F3/F5 cover it too (all 13).
const F3F5_MEMBERS = [...MEMBERS, { name: 'Car', Ctor: Car }];
for (const { name, Ctor } of F3F5_MEMBERS) {
    for (const [bname, o] of F3_BACKINGS) {
        test('[' + name + '] restore rejects a duplicate KEY on the ' + bname + ' backing (S17 F3)', () => {
            const c = new Ctor(8, o);
            c.put(10, 'a');
            c.put(20, 'b');
            const s = structuredClone(c.dump());
            const flat = [];
            for (const L of residentLists(s, [])) {
                for (let i = 0; i < L.k.length; i++) flat.push({ arr: L.k, idx: i });
            }
            assert.ok(flat.length >= 2, name + '/' + bname + ' needs >= 2 resident entries (vacuous)');
            // Force the second resident key to collide with the first.
            flat[1].arr[flat[1].idx] = flat[0].arr[flat[0].idx];
            assert.throws(() => Ctor.restore(s, o), /\[lite-lru\].*duplicate key/,
                name + '/' + bname + ' a duplicate key was not rejected');
            // Non-vacuity: the unmutated snapshot restores fine.
            assert.doesNotThrow(() => Ctor.restore(structuredClone(c.dump()), o),
                name + '/' + bname + ' a correct snapshot was rejected (vacuous)');
        });
    }
}

// F5: a corrupt per-entry EXPIRY value is rejected. Valid = a number that is not
// NaN (Infinity + any finite ms are fine); NaN/undefined/{}/"abc"/null all fail
// closed (null is not zero). An Infinity expiry survives a structuredClone round-trip.
for (const { name, Ctor } of F3F5_MEMBERS) {
    test('[' + name + '] restore rejects a corrupt per-entry expiry value (S17 F5)', () => {
        const c = new Ctor(8, { ttl: 1000 });
        c.put(10, 'a');
        c.put(20, 'b');
        for (const bad of [NaN, undefined, {}, 'abc', null]) {
            const s = structuredClone(c.dump());
            let hit = false;
            for (const L of residentLists(s, [])) {
                if (Array.isArray(L.e) && L.e.length) { L.e[0] = bad; hit = true; break; }
            }
            assert.ok(hit, name + ' no exp column to corrupt (vacuous)');
            assert.throws(() => Ctor.restore(s, { ttl: 1000 }), /\[lite-lru\]/,
                name + ' a corrupt expiry ' + String(bad) + ' was not rejected');
        }
        // Non-vacuity + Infinity survives structuredClone (unlike JSON).
        const ic = new Ctor(8, { ttl: 1000 });
        ic.put(10, 'a', Infinity);
        ic.put(20, 'b');
        const r = Ctor.restore(structuredClone(ic.dump()), { ttl: 1000 });
        assert.equal(r.size, ic.size, name + ' an Infinity-expiry round-trip drifted');
        assert.equal(r.get(10), 'a', name + ' an Infinity-expiry entry did not survive the round-trip');
    });
}

// F11: restore rejects a capacity above 2^31-1 (the 32-bit signed index domain).
test('restore rejects a capacity above 2^31-1 (S17 F11)', () => {
    const good = new LiteLru(4).dump();
    assert.throws(() => LiteLru.restore({ ...structuredClone(good), cap: 2 ** 31 }),
        /\[lite-lru\].*exceed/, 'an over-2^31 capacity snapshot was not rejected');
});
