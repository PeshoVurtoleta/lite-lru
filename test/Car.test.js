/**
 * @zakkster/lite-lru -- node:test boundary suite for the Car member (decisions/0028, D28).
 * Complementary to the heavy differential + zero-alloc gates in test/torture/*.mjs (run under
 * `node --expose-gc test/torture.mjs`); this pins the CAR-specific boundaries a fuzz stream reaches
 * only by luck, as fast, hand-computable node:test cases: the reference-bit lazy hot path (0
 * relinks, 1 state store), the reference-bit second chance (hand-computed victim), the T1->T2
 * migration, the adaptive `p` raise (B1 ghost hit) / lower (B2 ghost hit) with the ghost-rehit
 * routing into T2, the fixed-capacity split, has/peek neutrality, the two ghost bounds, degenerate
 * caps 1..4, fail-closed doors, clear, dump/restore round-trip + fail-closed rejections, and the
 * TTL / stats / iteration cross-cutting joins. validate() runs after mutating scenarios.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Car, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';
import { CountedCar, CAR_WRITES_HIT_LINKS, CAR_WRITES_HIT_ST } from './torture/harness.mjs';

const REF = 1;  // _st bit0
const T2 = 2;   // _st bit1

/** The per-slot _st for a key (or -1 if absent). */
function stOf(c, key) {
    const s = c._store.get(key);
    return s < 0 ? -1 : c._st[s];
}
const isRef = (c, k) => (stOf(c, k) & REF) !== 0;
const inT2 = (c, k) => (stOf(c, k) & T2) !== 0;

test('Car: VERSION is the current, un-bumped value (moves only at /release)', () => {
    assert.equal(VERSION, '1.16.0');
});

test('Car: fail-closed capacity -- non-integer / < 1 throws RangeError', () => {
    assert.throws(() => new Car(0), RangeError);
    assert.throws(() => new Car(-1), RangeError);
    assert.throws(() => new Car(2.5), RangeError);
    assert.throws(() => new Car('8'), RangeError);
});

test('Car: fail-closed int-key door -- a non-int32 key throws TypeError in keys:int mode', () => {
    const c = new Car(4, { keys: 'int' });
    assert.throws(() => c.put('x', 1), TypeError);
    assert.throws(() => c.get(2.5), TypeError);
    assert.throws(() => c.put(2 ** 40, 1), TypeError);
    c.put(7, 70);
    assert.equal(c.get(7), 70);
    validate(c);
});

test('Car: fail-closed unknown keys option -> TypeError with hint', () => {
    assert.throws(() => new Car(4, { keys: 'clock' }), /did you mean 'int'/);
});

test('Car: the hot path sets the reference bit only; true miss enters T1; has/peek neutral', () => {
    const c = new Car(8);
    for (let i = 0; i < 8; i++) c.put(i, i);
    assert.ok(!inT2(c, 3), 'a true-miss newcomer enters T1 (recent)');
    assert.ok(!isRef(c, 3), 'a fresh page starts unreferenced');
    assert.equal(c.get(3), 3);
    assert.ok(isRef(c, 3), 'get set the reference bit');
    c.has(5); c.peek(5);
    assert.ok(!isRef(c, 5), 'has/peek are reference-neutral');
    assert.equal(c._t1Size + c._t2Size, c.size, 't1 + t2 == size');
    validate(c);
});

test('Car: a hit is 0 link writes + exactly 1 _st store (the CLOCK-of-ARC headline)', () => {
    const c = new CountedCar(16);
    for (let i = 0; i < 16; i++) c.put(i, i);
    c.get(5);              // idempotent ref set
    c.resetWrites();
    c.get(5);             // a hit
    assert.equal(c.writes(), CAR_WRITES_HIT_LINKS, 'a hit relinks nothing');
    assert.equal(c.stWrites(), CAR_WRITES_HIT_ST, 'a hit sets exactly one _st byte');
    // put-update is likewise a hit: 0 links + 1 _st store.
    c.resetWrites();
    c.put(7, 99);
    assert.equal(c.writes(), CAR_WRITES_HIT_LINKS, 'a put-update relinks nothing');
    assert.equal(c.stWrites(), CAR_WRITES_HIT_ST, 'a put-update sets exactly one _st byte');
});

test('Car: the reference-bit second chance -- the single unreferenced page is the victim', () => {
    // Hand-computed: fill 4, reference all but key 1, insert a 5th. REPLACE gives every
    // referenced page a second chance (migrate to T2 / clear ref) and evicts the one
    // unreferenced page (1) -- to B1 (it left T1 unreferenced).
    let evicted;
    const c = new Car(4, { onEvict: (k) => { evicted = k; } });
    c.put(0, 0); c.put(1, 1); c.put(2, 2); c.put(3, 3);
    c.get(0); c.get(2); c.get(3); // 1 is the only unreferenced page
    assert.equal(c._peekVictim(), 1, 'the predicted victim is the unreferenced page 1');
    c.put(4, 4);
    assert.equal(evicted, 1, 'REPLACE evicted the unreferenced page 1');
    assert.ok(c.has(0) && c.has(2) && c.has(3) && c.has(4), 'referenced pages survived');
    assert.ok(c._b1.has(1), 'the T1-evicted page was demoted to B1');
    assert.equal(c.size, 4, 'resident capacity stays exactly capacity');
    validate(c);
});

test('Car: a referenced T1 page MIGRATES to T2 on REPLACE (the second-chance promotion)', () => {
    // Fill T1, reference one page, then churn a fresh miss that must sweep past the
    // referenced page (migrating it to T2) before finding an unreferenced victim.
    const c = new Car(4);
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4); // all T1, unref
    c.get('a'); c.get('b'); c.get('c'); c.get('d');             // all referenced
    c.put('e', 5); // REPLACE: every T1 page is referenced -> migrate to T2, evict from T2
    // After a full referenced sweep the survivors are in T2 (frequent).
    let anyT2 = false;
    for (const k of ['a', 'b', 'c', 'd', 'e']) { const s = c._store.get(k); if (s >= 0 && (c._st[s] & T2)) anyT2 = true; }
    assert.ok(anyT2, 'a referenced page migrated into the frequent clock T2');
    assert.equal(c.size, 4, 'size stays at capacity');
    validate(c);
});

test('Car: a B1 (recent) ghost hit RAISES p and re-admits into T2 (adaptive law)', () => {
    // Seed referenced T1 so REPLACE builds T2 and frees ghost room, then capture a T1
    // eviction into B1 and re-reference it -> a B1 hit -> p rises, key re-admits to T2.
    let lastEv = null;
    const c = new Car(32, { onEvict: (k) => { lastEv = k; } });
    for (let i = 0; i < 8; i++) { c.put('f' + i, i); c.get('f' + i); } // referenced T1 seed
    let raised = false, next = 0;
    for (let round = 0; round < 400 && !raised; round++) {
        lastEv = null;
        c.put('n' + next, next); next++;
        if (lastEv !== null && c._b1.has(lastEv)) {
            const pBefore = c._p;
            c.put(lastEv, 999);       // B1 hit
            assert.ok(c._p >= pBefore, 'a B1 hit never lowers p');
            if (c._p > pBefore) raised = true;
            assert.ok(inT2(c, lastEv), 'a B1 re-admit routes to T2');
        }
    }
    assert.ok(raised, 'a B1 (recent-ghost) hit raised p at least once');
    validate(c);
});

test('Car: a B2 (frequent) ghost hit LOWERS p and re-admits into T2 (adaptive law)', () => {
    const CAP = 16;
    const c = new Car(CAP);
    for (let i = 0; i < CAP; i++) { c.put(i, i); c.get(i); } // referenced T1
    c._p = CAP; // peak so a decrease is observable (floored at 0 otherwise)
    const pStart = c._p;
    let lowered = false;
    for (let round = 0; round < 8 && !lowered; round++) {
        const base = 1000 + round * CAP;
        for (let i = 0; i < CAP; i++) c.put(base + i, i); // flush: referenced migrate to T2, evict to B2
        for (let i = 0; i < CAP; i++) {
            if (c._b2.has(i)) {
                const pBefore = c._p;
                c.put(i, i);          // B2 hit
                assert.ok(c._p <= pBefore, 'a B2 hit never raises p');
                if (c._p < pBefore) lowered = true;
                assert.ok(inT2(c, i), 'a B2 re-admit routes to T2');
            }
        }
    }
    assert.ok(lowered && c._p < pStart, 'a B2 (frequent-ghost) hit lowered p');
    validate(c);
});

test('Car: REPLACE evicts an unreferenced page -- _peekVictim predicts the actual onEvict victim', () => {
    // The eviction path in `_replace` fires ONLY on the `(_st[h] & CAR_REF) === 0` branch, so the
    // page it demotes is unreferenced at the instant of eviction (a referenced page always earns a
    // second chance -- migrate/rotate -- and is never the victim). This is checked observably: the
    // non-destructive `_peekVictim` prediction equals the key `onEvict` actually receives, over a
    // long churn, and the victim is genuinely removed from the resident set.
    let lastEv;
    const c = new Car(8, { keys: 'int', onEvict: (k) => { lastEv = k; } });
    for (let i = 0; i < 8; i++) c.put(i, i);
    let evictions = 0;
    for (let i = 0; i < 5000; i++) {
        const k = i % 20;
        if (c.get(k) === undefined) {
            if (c.size === c.capacity) {
                const predicted = c._peekVictim();
                lastEv = undefined;
                c.put(k, i);
                assert.equal(lastEv, predicted, 'onEvict victim == the _peekVictim prediction');
                assert.ok(!c.has(predicted), 'the predicted victim was actually evicted');
                evictions++;
            } else {
                c.put(k, i);
            }
        }
        if ((i & 511) === 0) validate(c);
    }
    assert.ok(evictions > 100, 'the churn genuinely exercised eviction');
    validate(c);
});

test('Car: the two ghost bounds hold under churn -- |T1|+|B1| <= c and directory total <= 2c', () => {
    const CAP = 32;
    const c = new Car(CAP, { keys: 'int' });
    for (let i = 0; i < 20000; i++) {
        const k = i % 90;
        if (c.get(k) === undefined) c.put(k, i); else c.get(k);
        assert.ok(c._t1Size + c._b1._len <= CAP, '|T1|+|B1| <= c');
        assert.ok(c._t1Size + c._t2Size + c._b1._len + c._b2._len <= 2 * CAP, 'directory total <= 2c');
        assert.ok(c._p >= 0 && c._p <= CAP, 'p in [0, c]');
        assert.equal(c._t1Size + c._t2Size, c.size, 't1+t2 == size');
    }
    validate(c);
});

test('Car: degenerate caps 1..4 -- every put churns, conservation + bounds hold, clear resets', () => {
    for (const cap of [1, 2, 3, 4]) {
        const c = new Car(cap);
        for (let i = 0; i < 500; i++) {
            c.put(i, i);
            assert.equal(c.size, Math.min(cap, i + 1), 'size tracks fill then capacity');
            assert.equal(c.get(i), i, 'just-inserted key present');
            assert.ok(c._t1Size + c._b1._len <= cap, '|T1|+|B1| bound');
            assert.ok(c._t1Size + c._t2Size + c._b1._len + c._b2._len <= 2 * cap, 'directory bound');
            validate(c);
        }
        c.clear();
        assert.equal(c.size, 0, 'empty after clear');
        assert.equal(c._b1._len, 0, 'B1 empty after clear');
        assert.equal(c._b2._len, 0, 'B2 empty after clear');
        assert.equal(c._p, 0, 'p reset after clear');
        assert.equal(c._hT1, -1, 'hT1 reset after clear');
        assert.equal(c._hT2, -1, 'hT2 reset after clear');
        assert.equal(c._freeListLength(), cap, 'free list restored after clear');
        validate(c);
    }
});

test('Car: delete removes from whichever clock, is never ghosted, and never moves p', () => {
    const c = new Car(8);
    for (let i = 0; i < 8; i++) c.put(i, i);
    c.get(0); c.get(1); // referenced
    const pBefore = c._p;
    assert.ok(c.delete(3), 'delete returns true for a present key');
    assert.ok(!c.has(3), 'deleted key is gone');
    assert.ok(!c._b1.has(3) && !c._b2.has(3), 'a delete is not recorded in a ghost');
    assert.equal(c._p, pBefore, 'a delete never moves p');
    assert.equal(c.size, 7, 'size dropped by one');
    assert.equal(c.delete('nope'), false, 'delete of an absent key returns false');
    validate(c);
});

test('Car: dump -> restore is a byte-identical fixed point + a live twin', () => {
    for (const keys of [undefined, 'int']) {
        const c = new Car(20, keys ? { keys } : undefined);
        for (let i = 0; i < 80; i++) c.put(i % 30, i * 7);
        for (let i = 0; i < 20; i++) c.get((i * 3) % 30); // scramble reference bits + migrations
        validate(c);
        const snap = c.dump();
        const r = Car.restore(structuredClone(snap), keys ? { keys } : undefined);
        validate(r);
        assert.equal(r.size, c.size, 'restored size matches');
        assert.equal(r._p, c._p, 'restored p matches');
        assert.equal(r._peekVictim(), c._peekVictim(), 'restored twin predicts the same victim');
        // fixed point: dump -> restore -> dump is deep-equal (ignoring capture time `t`).
        const s2 = r.dump();
        assert.equal(JSON.stringify({ ...s2, t: 0 }), JSON.stringify({ ...snap, t: 0 }), 'dump is a fixed point');
    }
});

test('Car: a restored twin decides ALL future evictions identically, from a state with T1/T2/B1/B2 all non-empty', () => {
    // A deterministic mixed stream (hot recurrence 60%, cold churn 20%, ghost re-reference 20%)
    // is the SAME recipe t6's carStream uses to drive every CAR lane; at this scale it reliably
    // fills all four directory partitions simultaneously (hand-verified below, not assumed).
    const CAP = 16;
    const HOT = 24; // hot working set > capacity -> some hot pages eventually evict T2 -> B2
    let x = (12345 >>> 0) || 1;
    const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x >>> 0; };
    function nextKey(coldRef) {
        const r = rnd() % 10;
        if (r < 6) return rnd() % HOT;                 // hot recurrence
        if (r < 8) return coldRef.v++;                  // fresh cold churn
        const back = 20 + (rnd() % 50);
        const k = coldRef.v - back;
        return k < HOT ? rnd() % HOT : k;               // re-reference a recently-evicted key
    }
    const c = new Car(CAP);
    const cold = { v: HOT };
    for (let i = 0; i < 4000; i++) {
        const k = nextKey(cold);
        if (c.get(k) === undefined) c.put(k, k);
    }
    // Non-vacuity: the pre-dump state genuinely has pages in all four partitions.
    assert.ok(c._t1Size > 0, 'setup: T1 must be non-empty');
    assert.ok(c._t2Size > 0, 'setup: T2 must be non-empty');
    assert.ok(c._b1._len > 0, 'setup: B1 must be non-empty');
    assert.ok(c._b2._len > 0, 'setup: B2 must be non-empty');
    validate(c);

    const twin = Car.restore(structuredClone(c.dump()));
    validate(twin);

    // Drive 1000 FUTURE ops in lockstep on the original and the twin: at every capacity-miss
    // (the only point a REPLACE decision is made), both must predict + evict the SAME victim.
    let evictionsChecked = 0;
    for (let i = 0; i < 1000; i++) {
        const k = nextKey(cold);
        const cMiss = c.get(k) === undefined;
        const tMiss = twin.get(k) === undefined;
        assert.equal(cMiss, tMiss, 'hit/miss parity diverged at future op ' + i);
        if (cMiss) {
            if (c.size === c.capacity) {
                const pc = c._peekVictim(), pt = twin._peekVictim();
                assert.equal(pc, pt, 'future eviction victim diverged at op ' + i);
                evictionsChecked++;
            }
            c.put(k, k);
            twin.put(k, k);
        }
    }
    assert.ok(evictionsChecked > 50, 'the future-ops window barely evicted anything (weak test)');
    assert.equal(twin._p, c._p, 'p stayed in lockstep across the whole future-ops window');
    validate(c);
    validate(twin);
});

test('Car: restore fail-closed rejections (member/p/st/ghost bounds)', () => {
    const c = new Car(8, { keys: 'int' });
    for (let i = 0; i < 12; i++) c.put(i, i);
    const good = c.dump();
    // wrong member tag
    assert.throws(() => Car.restore({ ...good, m: 'Arc' }, { keys: 'int' }), /member mismatch/);
    // p out of range
    assert.throws(() => Car.restore({ ...good, p: 99 }, { keys: 'int' }), /car p out of/);
    assert.throws(() => Car.restore({ ...good, p: -1 }, { keys: 'int' }), /car p out of/);
    // a T2-list st byte missing the inT2 bit (only if T2 is non-empty)
    if (good.st2.length > 0) {
        const badSt2 = good.st2.slice(); badSt2[0] = 0; // clear inT2
        assert.throws(() => Car.restore({ ...good, st2: badSt2 }, { keys: 'int' }), /inT2 bit/);
    }
    // a T1-list st byte carrying the inT2 bit
    if (good.st1.length > 0) {
        const badSt1 = good.st1.slice(); badSt1[0] |= 2; // set inT2
        assert.throws(() => Car.restore({ ...good, st1: badSt1 }, { keys: 'int' }), /inT2 bit/);
    }
});

test('Car: TTL join -- a stale get/has/peek is a MISS and reaps in place, no promotion', () => {
    let now = 0; const clock = () => now;
    const ev = [];
    const c = new Car(4, { ttl: 10, clock, onEvict: (k, v) => ev.push([k, v]) });
    c.put('a', 1); c.put('b', 2, Infinity); c.put('c', 3);
    now = 11; // a and c stale, b never expires
    assert.equal(c.get('a'), undefined, 'stale get misses');
    assert.equal(ev.length, 1, 'a stale get reaped once');
    assert.equal(ev[0][0], 'a', 'reaped the stale key');
    assert.ok(c.has('b'), 'the Infinity sibling survives');
    assert.equal(c.get('c'), undefined, 'the other stale entry misses on touch');
    validate(c);
    // per-put ttlMs requires the ttl option (fail closed)
    const d = new Car(4);
    assert.throws(() => d.put('x', 1, 5), /requires the cache to be constructed with a { ttl }/);
});

test('Car: stats join -- hits/misses/evictions/puts counted; fail-closed without { stats: true }', () => {
    const c = new Car(2, { stats: true });
    c.put(1, 1); c.put(2, 2);   // 2 puts
    c.get(1);                    // hit
    c.get(9);                    // miss
    c.put(3, 3);                 // put + eviction (at capacity)
    const st = c.stats();
    assert.equal(st.hits, 1);
    assert.equal(st.misses, 1);
    assert.equal(st.puts, 3);
    assert.equal(st.evictions, 1);
    c.resetStats();
    assert.equal(c.stats().hits, 0);
    const d = new Car(2);
    assert.throws(() => d.stats(), /stats\(\)\/resetStats\(\) require/);
});

test('Car: iteration order is T2 (MRU..LRU) then T1 (MRU..LRU), ghosts excluded', () => {
    const c = new Car(20);
    for (let i = 0; i < 20; i++) c.put(i, i);      // all T1
    for (let i = 0; i < 12; i++) c.get(i);         // reference some
    for (let i = 100; i < 110; i++) c.put(i, i);   // churn -> migrations to T2
    // build the expected walk: T2 head..tail then T1 head..tail via the shared _next column.
    const NIL = -1;
    const want = [];
    for (let s = c._headT2; s !== NIL; s = c._next[s]) want.push(c._keys[s]);
    for (let s = c._headT1; s !== NIL; s = c._next[s]) want.push(c._keys[s]);
    const got = [];
    for (const k of c.keys()) got.push(k);
    assert.deepEqual(got, want, 'keys() walks T2 then T1');
    assert.equal(got.length, c.size, 'iteration covers exactly the resident set (ghosts excluded)');
    validate(c);
});

test('Car: iteration is ghost-excluded, resident-only, and hand-neutral (mirrors ClockPro D18)', () => {
    const c = new Car(20);
    for (let i = 0; i < 40; i++) c.put(i % 30, i);   // churn past capacity -> ghosts populate
    for (let i = 0; i < 20; i++) c.get((i * 3) % 30); // reference bits + migrations
    const keys = [...c.keys()];
    assert.equal(keys.length, c.size, 'iteration visits exactly the resident set');
    for (const k of keys) {
        assert.ok(c.has(k), 'iterated key ' + k + ' must be resident');
        assert.ok(!c._b1.has(k) && !c._b2.has(k), 'iterated key ' + k + ' must not also sit in a ghost');
    }
    // recency-neutral: walking touches neither hand.
    const h1 = c._hT1, h2 = c._hT2;
    for (const _ of c.entries()) { /* walk */ }
    assert.equal(c._hT1, h1, 'iteration is hand-neutral (T1)');
    assert.equal(c._hT2, h2, 'iteration is hand-neutral (T2)');
    validate(c);
});

test('Car: iteration fails closed (throws) on a structural mutation mid-walk', () => {
    const c = new Car(16);
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

/* -------------------------------------------------------------------------------- *
 * HAND-DERIVED VICTIM ORDER (qa TASK 1, CHANGELOG.md:34): CAR and ClockPro share the
 * SAME circular-clock geometry (a NIL-terminated head=newest..tail=oldest DLL whose
 * hand wraps `_advance(_tail) -> _head`, decisions/0028 D28.1 / decisions/0025 D25.1)
 * as the t5 differential oracles they are checked against -- a regression in the
 * SHARED wrap-around traversal math would reproduce identically on both sides of the
 * differential and cancel, exactly the blind spot the Arc ghost-trim suite above pins
 * for ARC's shared-trim geometry. These cases derive the EXACT eviction order BY HAND
 * from D28.1 (clock realization) + D28.4 (REPLACE), tracing slot assignment, clock
 * contents, hand position and `_st` bits after every op -- never by running Car and
 * transcribing its output. (The derivation below was cross-checked step-by-step
 * against the live member during QA -- as the Arc suite's precedent documents doing
 * -- and agreed at every step; no discrepancy was found.)
 *
 * Slot assignment fact used throughout (D2/D4): a FRESH store's free stack is
 * 0 -> 1 -> ... -> capacity-1, popped in order, so `new Car(4)` then
 * `put(0)`,`put(1)`,`put(2)`,`put(3)` (all true misses, nothing resident yet) assigns
 * key i to slot i, in that order.
 * -------------------------------------------------------------------------------- */

test('Car HAND-DERIVED (a): no-reference straight rotation -- the hand wraps tail -> ' +
    'head, so eviction order is NOT plain insertion order past the first victim', () => {
    // Trace, entirely by hand from D28.1/D28.4 (T1 push is always at HEAD; `_next`
    // points head->tail; the hand starts parked at the first-ever insert, which is
    // both head and tail; `_advance`/`_ringSucc` wrap `_next[tail] -> _head`). SLOTS
    // are fixed physical columns and get REUSED by the next inserted key on eviction
    // (D2/D4, D28.4 "reuse its slot"); every line below is written `slot:key` to keep
    // the two distinct -- the hand (`_hT1`) is always a SLOT index, never a key.
    //
    //  put(0): T1 [head..tail] = 0:0.                    hT1=0 (sole entry: hand parks here)
    //  put(1): T1 = 1:1, 0:0.                             hT1=0 (unchanged: push only touches head)
    //  put(2): T1 = 2:2, 1:1, 0:0.                        hT1=0
    //  put(3): T1 = 3:3, 2:2, 1:1, 0:0. all st=0 (unref). hT1=0  <- hand sits at the TAIL (slot0, key0)
    //
    //  put(4): REPLACE, pTarget=max(1,p=0)=1, |T1|=4>=1 -> take T1. h=hT1=slot0
    //    (key0). st[0]&REF==0 (unreferenced) -> IMMEDIATE VICTIM: key 0. Ring successor
    //    of the TAIL (next[slot0]=NIL) wraps to the CURRENT head (slot3, the newest
    //    resident at this instant) -- NOT to the second-oldest (slot1/key1). hT1 <- 3.
    //    slot0 is freed and reused for key4: T1 = 0:4, 3:3, 2:2, 1:1(tail).   hT1=3
    //
    //  put(5): h=hT1=slot3 (key3), unreferenced -> VICTIM: key 3. next[slot3]=slot2
    //    (a REGULAR link, slot3 is not the tail) -> ringSucc=2, no wrap. slot3 is
    //    freed and reused for key5: T1 = 3:5, 0:4, 2:2, 1:1(tail).           hT1=2
    //
    //  put(6): h=hT1=slot2 (key2), unreferenced -> VICTIM: key 2. next[slot2]=slot1
    //    (regular, slot2 not tail) -> ringSucc=1. slot2 freed, reused for key6:
    //    T1 = 2:6, 3:5, 0:4, 1:1(tail).                                     hT1=1
    //
    //  put(7): h=hT1=slot1 (key1, the tail again), unreferenced -> VICTIM: key 1.
    //    Its ring successor is next[slot1]=NIL (still the tail) -> WRAPS again, to
    //    the CURRENT head (slot2, which now holds key6, the newest survivor at this
    //    instant) -- NOT slot index "6". slot1 freed, reused for key7:
    //    T1 = 1:7, 2:6, 3:5, 0:4(tail).                                     hT1=2
    //
    // So the FIRST FOUR victims are, in order: 0, 3, 2, 1 -- the first eviction takes
    // the oldest (a plain FIFO step), but every eviction AFTER a tail-wrap instead
    // sweeps newest-to-oldest among the surviving originals, because the tail's ring
    // successor is the head, not "the next-oldest survivor". A naive reader of "CLOCK
    // == FIFO order" would wrongly predict 0, 1, 2, 3. The hand ends parked on SLOT 2
    // (which by then holds key6) -- a coincidence of slot reuse, not a claim about key 2.
    const order = [];
    const c = new Car(4, { onEvict: (k) => order.push(k) });
    for (let i = 0; i < 4; i++) c.put(i, i);
    assert.equal(c._hT1, 0, 'setup: the hand parks at the first-ever insert (the tail)');
    c.put(4, 4); c.put(5, 5); c.put(6, 6); c.put(7, 7);
    assert.deepEqual(order, [0, 3, 2, 1], 'HAND-DERIVED: the tail-wrap victim order, not plain FIFO 0,1,2,3');
    assert.equal(c._hT1, 2, 'HAND-DERIVED: the hand parks on slot 2 (holding key6) after the fourth (wrapping) eviction');
    assert.equal(c._keys[c._hT1], 6, 'HAND-DERIVED: slot 2 was reused for key6 by the time the hand re-parks there');
    validate(c);
});

test('Car HAND-DERIVED (b): the reference-bit second chance -- a referenced hand ' +
    'position is skipped (ref cleared, migrated to T2), the NEXT unreferenced page is ' +
    'the actual victim', () => {
    // Same fill as (a): T1 = 3,2,1,0 (head..tail), hT1=0 (parked on key0, the tail),
    // all st=0. Now `get(0)`: D28.5's hit path is `_st[s] |= CAR_REF` only (0 link
    // writes) -> st[slot0] = CAR_REF(1). Topology is UNCHANGED (a hit moves nothing).
    //
    //  put(4): REPLACE, pTarget=1, |T1|=4>=1 -> T1. h=hT1=0 (key0). st[0]&REF!=0
    //    (REFERENCED) -> SECOND CHANCE, not a victim: ring successor of the tail
    //    (next[0]=NIL) wraps to the current head (3) -> hT1<-3 BEFORE the detach; the
    //    survivor migrates: st[0] <- CAR_T2 (ref cleared, inT2 set) and slot0 is
    //    pushed onto T2 (T2 was empty -> head=tail=hT2=slot0, the "T1 survivor
    //    migrates to T2" of D28.4). |T1| drops to 3, take-T1 re-evaluated: 3>=1 still
    //    true -> loop continues with h=hT1=3 (key3). st[3]&REF==0 (unreferenced) ->
    //    NOW the victim: key 3. Its ring successor is next[3]=2 (regular) -> hT1<-2.
    //    T1 after evict+push key4 into the freed slot3: head=4(slot3),2,1(tail).
    //                                                              hT1=2, T2={0}, hT2=0
    //
    // Net: the referenced page (key0) was SKIPPED, its ref bit cleared and the page
    // MIGRATED into T2 (not evicted); the very next unreferenced page found by the
    // continuing sweep (key3) is the ACTUAL victim -- never key0.
    const order = [];
    const c = new Car(4, { onEvict: (k) => order.push(k) });
    for (let i = 0; i < 4; i++) c.put(i, i);
    c.get(0); // reference the hand's current position only
    c.put(4, 4);
    assert.deepEqual(order, [3], 'HAND-DERIVED: key3 (not key0) is the actual victim');
    assert.ok(c.has(0), 'the referenced page survived the sweep');
    assert.equal(stOf(c, 0), T2, 'HAND-DERIVED: key0 migrated to T2 with its reference bit cleared');
    assert.equal(c._hT1, 2, 'HAND-DERIVED: the hand parks on key2 slot after the eviction');
    assert.equal(c._hT2, c._store.get(0), 'HAND-DERIVED: the T2 hand parks on the sole migrated survivor');
    validate(c);
});

test('Car HAND-DERIVED (c): the T1-survivor migration in (b) is what CHANGES the ' +
    'victim -- an identical fill with the SAME single get() diverges from a twin ' +
    'without it', () => {
    // A direct counterfactual pin (not just an assertion on one cache): build two
    // caches through the IDENTICAL fill put(0..3), then reference key0 on ONLY one
    // twin before the capacity-triggering put(4). Per the (a)/(b) derivations above:
    //   - twin A (no get): hT1 stays at the tail (key0, unreferenced) -> put(4)
    //     evicts key0 DIRECTLY -- no migration ever happens.
    //   - twin B (get(0)): the SAME hand position is now referenced -> key0 is given
    //     a second chance and MIGRATES to T2 instead of being evicted; the sweep
    //     continues to key3, which becomes the victim.
    // The ONE bit of extra history (one get() on the page the hand happens to be
    // parked on) flips the victim from key0 to key3 -- this is the causal claim
    // "a T1-survivor migration to T2 changes who the next victim is", pinned by
    // literal divergence between two otherwise-identical caches.
    const evA = [], evB = [];
    const a = new Car(4, { onEvict: (k) => evA.push(k) });
    const b = new Car(4, { onEvict: (k) => evB.push(k) });
    for (let i = 0; i < 4; i++) { a.put(i, i); b.put(i, i); }
    b.get(0); // the ONLY difference between the two twins
    a.put(4, 4);
    b.put(4, 4);
    assert.deepEqual(evA, [0], 'HAND-DERIVED: without the migration, the hand-position page (0) is evicted');
    assert.deepEqual(evB, [3], 'HAND-DERIVED: with the migration, a DIFFERENT page (3) is evicted instead');
    assert.notEqual(evA[0], evB[0], 'the T1->T2 migration changed the victim identity');
    assert.ok(b.has(0) && !a.has(0), 'the migrated survivor (0) is resident only in the twin that referenced it');
    validate(a);
    validate(b);
});
