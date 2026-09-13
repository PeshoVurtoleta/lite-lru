/**
 * t0 -- metamorphic recency laws for classic LRU, asserted over a fuzz corpus.
 *
 * These are the policy laws that a refactor must never silently flip (ROADMAP law
 * 5). Each is NAMED and checked directly against the real cache and validate():
 *
 *   L1 get PROMOTES the key to MRU.
 *   L2 put(new) and put(update) PROMOTE to MRU.
 *   L3 has() and peek() are recency-NEUTRAL (victim unchanged).
 *   L4 at capacity, a new key evicts EXACTLY the LRU tail and fires onEvict once
 *      with (evictedKey, evictedValue).
 *
 * The corpus builds random cache states with a seeded PRNG; on each state we probe
 * one law and assert. validate() runs after mutations so a law that "passes" on a
 * corrupt structure still fails the tier.
 */

import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs } from '../../Lru.js';
import { makePrng, SEED, check, validate, wrapLru, wrapS3Fifo, wrapWTinyLfu, wrapSlru, wrapTwoQ, wrapArc, wrapLirs } from './harness.mjs';

const NIL = -1;

/** INDEPENDENT expected iteration order (decisions/0018, D18.1): walk each documented
 *  head field -> _next -> NIL, concatenated, skipping stale entries (D18.5). Deliberately
 *  does NOT call the cache's _iterHeads(), so a bug in the roster is caught. */
function walkExpected(c, heads) {
    const ks = [], vs = [];
    const exp = c._exp;
    const now = c._clock ? c._clock() : 0;
    for (let h = 0; h < heads.length; h++) {
        for (let s = heads[h]; s !== NIL; s = c._next[s]) {
            if (exp !== null && exp !== undefined && exp[s] <= now) continue; // D18.5 -- skip stale
            ks.push(c._keys[s]);
            vs.push(c._vals[s]);
        }
    }
    return { ks, vs };
}

/** Drain an iterator that yields scalars into an array. */
function collectScalars(it) { const a = []; for (let r = it.next(); !r.done; r = it.next()) a.push(r.value); return a; }
/** Drain an entries()/[Symbol.iterator] iterator, COPYING the borrowed [k,v] tuple. */
function collectPairs(it) { const a = []; for (let r = it.next(); !r.done; r = it.next()) a.push([r.value[0], r.value[1]]); return a; }
function eqArr(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false; return true; }

/** The iteration-order law for one member (decisions/0018): keys()/values()/entries()/
 *  [Symbol.iterator] all match the documented roster walk, and a walk is read-only. */
function checkIterOrder(label, c, heads) {
    const want = walkExpected(c, heads);
    check(eqArr(collectScalars(c.keys()), want.ks),
        () => 't0 ITER ' + label + ': keys() order != documented roster walk');
    check(eqArr(collectScalars(c.values()), want.vs),
        () => 't0 ITER ' + label + ': values() order != documented roster walk');
    const pairs = collectPairs(c.entries());
    check(pairs.length === want.ks.length, () => 't0 ITER ' + label + ': entries() length mismatch');
    for (let i = 0; i < pairs.length; i++) {
        check(Object.is(pairs[i][0], want.ks[i]) && Object.is(pairs[i][1], want.vs[i]),
            () => 't0 ITER ' + label + ': entries()[' + i + '] != (key,value) roster');
    }
    const sym = collectPairs(c[Symbol.iterator]());
    check(eqArr(sym.map((p) => p[0]), want.ks) && eqArr(sym.map((p) => p[1]), want.vs),
        () => 't0 ITER ' + label + ': [Symbol.iterator] != entries()');
    // D18.4 recency-neutral / D18.5 no-reap: a full walk does not change size.
    const sizeBefore = c.size;
    for (const k of c.keys()) { void k; }
    check(c.size === sizeBefore, () => 't0 ITER ' + label + ': a walk changed size (not read-only)');
}

const CAP = 16;
const KEYSPACE = 40;
const STATES = 4000;

/** Build a random populated cache (below capacity often, at capacity sometimes). */
function randomCache(prng, cap, keyspace) {
    const c = new LiteLru(cap);
    const n = prng() % (cap + 1);
    for (let i = 0; i < n; i++) c.put(prng() % keyspace, prng() >>> 0);
    return c;
}

export function run() {
    const prng = makePrng(SEED ^ 0x0a);

    for (let s = 0; s < STATES; s++) {
        const c = randomCache(prng, CAP, KEYSPACE);
        const d = wrapLru(c);

        // L1: get PROMOTES. Pick a present key that is not already the tail-of-1.
        if (c.size >= 2) {
            const victimBefore = d.victim();
            // find a present key != victimBefore
            let probe = -1;
            for (let k = 0; k < KEYSPACE; k++) {
                if (c.has(k) && k !== victimBefore) { probe = k; break; }
            }
            if (probe >= 0) {
                c.get(probe);
                check(d.victim() !== probe,
                    () => 't0 L1: get(' + probe + ') did not promote (still the victim)');
                check(c._keys[c._head] === probe,
                    () => 't0 L1: get(' + probe + ') did not become MRU (head)');
                validate(c);
            }
        }

        // L2: put(update existing) PROMOTES.
        if (c.size >= 2) {
            const victimBefore = d.victim();
            if (victimBefore !== undefined && c.has(victimBefore)) {
                c.put(victimBefore, 999); // update the current LRU
                check(c._keys[c._head] === victimBefore,
                    () => 't0 L2: put(update ' + victimBefore + ') did not promote to MRU');
                validate(c);
            }
        }

        // L2b: put(new) PROMOTES the newcomer to MRU.
        {
            let fresh = -1;
            for (let k = 0; k < KEYSPACE; k++) if (!c.has(k)) { fresh = k; break; }
            if (fresh >= 0) {
                c.put(fresh, 123);
                check(c._keys[c._head] === fresh, () => 't0 L2b: put(new ' + fresh + ') did not become MRU');
                validate(c);
            }
        }

        // L3: has() and peek() are recency-NEUTRAL.
        if (c.size >= 1) {
            const victimBefore = d.victim();
            const headBefore = c._keys[c._head];
            const anyKey = c._keys[c._tail];
            c.has(anyKey);
            c.peek(anyKey);
            check(d.victim() === victimBefore,
                () => 't0 L3: has/peek changed the victim ' + victimBefore + ' -> ' + d.victim());
            check(c._keys[c._head] === headBefore,
                () => 't0 L3: has/peek changed the MRU head');
        }
    }

    // L4: at capacity, insert evicts EXACTLY the LRU tail, onEvict fires once with
    // the right (key, value). A deterministic, isolated construction.
    {
        let evCount = 0;
        let evKey, evVal;
        const c = new LiteLru(4, { onEvict: (k, v) => { evCount++; evKey = k; evVal = v; } });
        c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4); // tail = 'a'
        const victim = wrapLru(c).victim();
        check(victim === 'a', () => 't0 L4: expected LRU victim "a", got ' + victim);
        c.put('e', 5); // must evict 'a'
        check(evCount === 1, () => 't0 L4: onEvict fired ' + evCount + ' times, expected 1');
        check(evKey === 'a' && evVal === 1,
            () => 't0 L4: onEvict got (' + String(evKey) + ',' + String(evVal) + '), expected (a,1)');
        check(!c.has('a'), () => 't0 L4: evicted key "a" is still present');
        check(c.has('e'), () => 't0 L4: newcomer "e" is absent after insert');
        check(c.size === 4, () => 't0 L4: size ' + c.size + ' != capacity 4 after evicting insert');
        validate(c);
    }

    // --- S3-FIFO laws (decisions/0013) ------------------------------------------
    const Q_MAIN = 1; // matches Lru.js's S3-FIFO queue tag for the MAIN ring

    // S1: prove-then-graduate. A SMALL entry that is VISITED (proven) when the
    // eviction sweep reaches it GRADUATES to MAIN rather than being evicted; the next
    // (unproven) SMALL entry is the one that leaves (to ghost).
    {
        const c = new S3Fifo(20); // smallCap 2, mainCap 18, ghostCap 18
        for (let i = 0; i < 20; i++) c.put(i, i); // all admitted to SMALL, at capacity
        check(c._keys[c._sTail] === 0, () => 't0 S1: key 0 is not the SMALL tail (oldest)');
        c.get(0); // PROVE key 0 (the oldest SMALL entry)
        c.put(100, 100); // eviction: SMALL tail 0 is visited -> graduate; 1 is the victim
        check(c.has(0), () => 't0 S1: proven SMALL entry 0 was evicted instead of graduating');
        const s0 = c._store.get(0);
        check(c._q[s0] === Q_MAIN, () => 't0 S1: proven entry 0 did not graduate into MAIN');
        check(!c.has(1), () => 't0 S1: the unproven SMALL tail 1 was not the victim');
        check(c.has(100), () => 't0 S1: the newcomer 100 is absent');
        check(c.size === 20, () => 't0 S1: size drifted from capacity (' + c.size + ')');
        validate(c);
    }

    // S2: scan resistance. A repeatedly-accessed HOT key graduates to MAIN and keeps
    // earning second chances, so an unbounded flood of distinct one-hit-wonder keys
    // (which enter SMALL unvisited and sweep straight out) never displaces it. A plain
    // FIFO -- and classic LRU on a scan -- would evict it.
    {
        const N = 32; // smallCap 3, mainCap 29
        const c = new S3Fifo(N);
        const HOT = 'hot';
        c.put(HOT, 1);
        for (let i = 0; i < N - 1; i++) c.put('cold' + i, i); // fill to capacity
        check(c.size === N, () => 't0 S2: s3fifo not full before the scan');
        for (let i = 0; i < 5000; i++) {
            check(c.get(HOT) === 1, () => 't0 S2: hot key lost mid-scan at ' + i);
            c.put('scan' + i, i); // a unique one-hit-wonder each op -> forces eviction
            check(c.size === N, () => 't0 S2: s3fifo drifted from capacity during the scan');
            if ((i & 255) === 0) validate(c);
        }
        check(c.has(HOT), () => 't0 S2: the hot key was evicted by a one-hit-wonder scan (no scan resistance)');
        const sHot = c._store.get(HOT);
        check(c._q[sHot] === Q_MAIN, () => 't0 S2: the proven hot key never graduated to MAIN');
        // Non-vacuity: the cold one-hit-wonders DO get evicted (the scan is real).
        let survivors = 0;
        for (let i = 0; i < 5000; i++) if (c.has('scan' + i)) survivors++;
        check(survivors < N, () => 't0 S2: too many scan keys survived (' + survivors + ') -- eviction not exercised');
        validate(c);
        void wrapS3Fifo(c); // exercise the driver wrapper on a churned cache
    }

    // --- W-TinyLFU laws (decisions/0014) ----------------------------------------
    const SEG_WINDOW = 0, SEG_PROBATION = 1, SEG_PROTECTED = 2; // matches Lru.js tags

    // W1: a newcomer is admitted to the WINDOW.
    {
        const c = new WTinyLfu(64); // window 1
        c.put('a', 1);
        const s = c._store.get('a');
        check(c._seg[s] === SEG_WINDOW, () => 't0 W1: newcomer did not enter the WINDOW');
        validate(c);
    }

    // W2: a HIT on a PROBATION entry PROMOTES it to PROTECTED (deferred SLRU
    // promotion). Fill past the window so the window overflow lands in probation, then
    // hit a probation entry and assert it moved.
    {
        const c = new WTinyLfu(20); // window 1, main 19, protected 15, probation 4
        for (let i = 0; i < 20; i++) c.put(i, i); // fill; window sheds overflow to probation
        // find a probation slot
        let probeKey = -1;
        for (let k = 0; k < 20; k++) {
            const s = c._store.get(k);
            if (s >= 0 && c._seg[s] === SEG_PROBATION) { probeKey = k; break; }
        }
        check(probeKey >= 0, () => 't0 W2: no probation entry to probe (setup invalid)');
        c.get(probeKey); // hit -> promote to protected
        const s2 = c._store.get(probeKey);
        check(c._seg[s2] === SEG_PROTECTED, () => 't0 W2: probation hit did not promote to PROTECTED');
        validate(c);
    }

    // W3: frequency admission -- a proven-hot key survives an unbounded flood of
    // distinct one-hit-wonders. Each cold newcomer enters the window with frequency ~1;
    // the hot key's sketch frequency keeps climbing, so when a cold candidate is weighed
    // against a resident it loses, and the hot key is never the evicted victim. A plain
    // LRU/FIFO on a scan would evict it.
    {
        const N = 64; // window 1, protected 50, probation 13
        const c = new WTinyLfu(N);
        const HOT = 'hot';
        c.put(HOT, 1);
        for (let i = 0; i < 200; i++) c.get(HOT); // build the hot key's frequency
        for (let i = 0; i < N - 1; i++) c.put('cold' + i, i); // fill to capacity
        check(c.size === N, () => 't0 W3: wtinylfu not full before the scan');
        for (let i = 0; i < 6000; i++) {
            check(c.get(HOT) === 1, () => 't0 W3: hot key lost mid-scan at ' + i);
            c.put('scan' + i, i); // a unique one-hit-wonder each op -> forces eviction
            check(c.size === N, () => 't0 W3: wtinylfu drifted from capacity during the scan');
            if ((i & 255) === 0) validate(c);
        }
        check(c.has(HOT), () => 't0 W3: the hot key was evicted by a one-hit-wonder scan (no frequency resistance)');
        // Non-vacuity: the cold one-hit-wonders DO get evicted (the scan is real).
        let survivors = 0;
        for (let i = 0; i < 6000; i++) if (c.has('scan' + i)) survivors++;
        check(survivors < N, () => 't0 W3: too many scan keys survived (' + survivors + ') -- eviction not exercised');
        validate(c);
        void wrapWTinyLfu(c); // exercise the driver wrapper on a churned cache
    }

    // --- Slru laws (decisions/0015) ---------------------------------------------
    const SLRU_PROBATION = 0, SLRU_PROTECTED = 1; // matches Lru.js tags

    // SL1: promote-on-2nd-hit. A newcomer enters PROBATION; get(X) ONCE leaves X in
    // probation (visited set); get(X) TWICE promotes X to PROTECTED. This is the pinned
    // Slru law -- a promote-on-first-hit variant is the t9 control that MUST diverge.
    {
        const c = new Slru(64); // protectedCap 51
        c.put('x', 1);
        let s = c._store.get('x');
        check(c._seg[s] === SLRU_PROBATION, () => 't0 SL1: newcomer did not enter PROBATION');
        c.get('x'); // first hit
        s = c._store.get('x');
        check(c._seg[s] === SLRU_PROBATION, () => 't0 SL1: get(X) ONCE promoted (must stay probation)');
        check(c._vis[s] === 1, () => 't0 SL1: first hit did not set the visited bit');
        c.get('x'); // second hit
        s = c._store.get('x');
        check(c._seg[s] === SLRU_PROTECTED, () => 't0 SL1: get(X) TWICE did not promote to PROTECTED');
        validate(c);
    }

    // SL2: scan resistance -- a cap-sized distinct-key scan evicts 0 PROTECTED entries.
    // Promote a hot set into protected, fill probation, then run EXACTLY `cap` distinct
    // new puts; every protected key must survive (eviction always takes from probation).
    {
        const N = 64;
        const c = new Slru(N);
        const HOT = [];
        for (let h = 0; h < 20; h++) { const k = 'hot' + h; c.put(k, h); c.get(k); c.get(k); HOT.push(k); } // 2 hits -> protected
        for (const k of HOT) check(c._seg[c._store.get(k)] === SLRU_PROTECTED, () => 't0 SL2: hot key ' + k + ' not in protected after 2 hits');
        for (let i = 0; c.size < N; i++) c.put('warm' + i, i); // fill probation to capacity
        check(c.size === N, () => 't0 SL2: slru not full before the scan');
        for (let i = 0; i < N; i++) { // exactly cap distinct one-hit-wonders
            c.put('scan' + i, i);
            check(c.size === N, () => 't0 SL2: slru drifted from capacity during the scan');
        }
        for (const k of HOT) check(c.has(k), () => 't0 SL2: PROTECTED key ' + k + ' evicted by a cap-sized scan (no scan resistance)');
        // Non-vacuity: the scan really evicted (probation churned).
        let survivors = 0;
        for (let i = 0; i < N; i++) if (c.has('scan' + i)) survivors++;
        check(survivors < N, () => 't0 SL2: too many scan keys survived (' + survivors + ') -- eviction not exercised');
        validate(c);
        void wrapSlru(c);
    }

    // --- TwoQ laws (decisions/0015) ---------------------------------------------
    const TWOQ_A1IN = 0, TWOQ_AM = 1; // matches Lru.js tags

    // TQ1: a newcomer enters A1in; an A1in hit does NOT promote; the ghost path (A1in ->
    // evicted -> A1out -> seen again) is the ONLY route into Am.
    {
        const c = new TwoQ(4); // a1inCap 1, amCap 3, ghostCap 3
        c.put('a', 1);
        check(c._seg[c._store.get('a')] === TWOQ_A1IN, () => 't0 TQ1: newcomer did not enter A1in');
        c.get('a'); // A1in hit -- must NOT promote
        check(c._seg[c._store.get('a')] === TWOQ_A1IN, () => 't0 TQ1: an A1in hit promoted (must not)');
        c.put('b', 2); c.put('c', 3); c.put('d', 4); // fills to capacity (no eviction yet)
        c.put('e', 5); // over capacity -> evicts the A1in tail 'a' into the ghost
        check(!c.has('a'), () => 't0 TQ1: a was not evicted from A1in');
        check(c._ghostHas('a'), () => 't0 TQ1: evicted A1in key not recorded in A1out ghost');
        c.put('a', 11); // second sighting while in ghost -> straight to Am
        check(c._seg[c._store.get('a')] === TWOQ_AM, () => 't0 TQ1: a ghost re-admit did not route to Am');
        check(!c._ghostHas('a'), () => 't0 TQ1: a was not consumed from the ghost on re-admission');
        validate(c);
    }

    // TQ2: scan resistance -- a cap-sized distinct-key scan evicts 0 Am entries. Get a hot
    // set into Am via the ghost path, fill A1in, then run EXACTLY `cap` distinct new puts;
    // every Am key survives (the scan churns A1in only).
    {
        const N = 64; // a1inCap 16
        const c = new TwoQ(N);
        const HOT = [];
        for (let h = 0; h < 20; h++) HOT.push('hot' + h);
        for (const k of HOT) c.put(k, 0);                 // enter A1in
        for (let i = 0; i < N; i++) c.put('flush' + i, i); // flush hot keys out of A1in into ghost
        for (let h = 0; h < HOT.length; h++) c.put(HOT[h], h); // second sighting -> Am
        for (const k of HOT) check(c._seg[c._store.get(k)] === TWOQ_AM, () => 't0 TQ2: hot key ' + k + ' not in Am after ghost re-admit');
        while (c.size < N) c.put('warm' + (c.size), c.size); // fill to capacity
        check(c.size === N, () => 't0 TQ2: twoq not full before the scan');
        for (let i = 0; i < N; i++) {
            c.put('scan' + i, i);
            check(c.size === N, () => 't0 TQ2: twoq drifted from capacity during the scan');
        }
        for (const k of HOT) check(c.has(k), () => 't0 TQ2: Am key ' + k + ' evicted by a cap-sized scan (no scan resistance)');
        let survivors = 0;
        for (let i = 0; i < N; i++) if (c.has('scan' + i)) survivors++;
        check(survivors < N, () => 't0 TQ2: too many scan keys survived (' + survivors + ') -- eviction not exercised');
        check(c._gLen <= c._ghostCap, () => 't0 TQ2: A1out ghost exceeded its bound');
        validate(c);
        void wrapTwoQ(c);
    }

    // --- Arc laws (decisions/0016) ----------------------------------------------
    const ARC_T1 = 0, ARC_T2 = 1; // matches Lru.js tags

    // A1: a hit PROMOTES to T2 (frequent). A newcomer enters T1 (recent); get(X) once
    // moves X to T2 (ARC promotes any hit to frequent). has/peek are neutral.
    {
        const c = new Arc(8);
        c.put('x', 1);
        check(c._seg[c._store.get('x')] === ARC_T1, () => 't0 A1: newcomer did not enter T1');
        c.get('x'); // hit -> promote to T2
        check(c._seg[c._store.get('x')] === ARC_T2, () => 't0 A1: a hit did not promote to T2');
        c.put('y', 2);
        check(c._seg[c._store.get('y')] === ARC_T1, () => 't0 A1: setup for neutrality invalid');
        c.has('y'); c.peek('y');
        check(c._seg[c._store.get('y')] === ARC_T1, () => 't0 A1: has/peek promoted (must be neutral)');
        validate(c);
    }

    // A2: p-adaptation DIRECTION. A B1 (recent ghost) hit RAISES p; a B2 (frequent ghost)
    // hit LOWERS p. This is the pinned adaptive law -- a p-frozen Arc is the t9 control.
    {
        // Stage B1: fill T2 (so |T1| < c and REPLACE at p==0 prefers T1), leave 2 in T1, one
        // true miss evicts the T1 LRU 'r0' into B1 (an all-T1 cache direct-evicts, D16.4).
        let evicted;
        const c = new Arc(8, { onEvict: (k) => { evicted = k; } });
        for (let i = 0; i < 6; i++) { c.put('t' + i, i); c.get('t' + i); } // t0..t5 -> T2
        c.put('r0', 0); c.put('r1', 1);       // T1: r0(LRU), r1(MRU); size 8, p == 0
        c.put('x', 99);                       // true miss -> REPLACE evicts T1 LRU r0 -> B1
        check(evicted === 'r0' && c._b1.has('r0'), () => 't0 A2: staging B1 failed (evicted ' + String(evicted) + ')');
        const pBefore = c._p;
        c.put('r0', 999); // B1 hit -> p += max(1, floor(|B2|/|B1|))
        check(c._p > pBefore, () => 't0 A2: a B1 (recent-ghost) hit did not RAISE p (' + pBefore + ' -> ' + c._p + ')');
        check(c._seg[c._store.get('r0')] === ARC_T2, () => 't0 A2: a B1 re-admit did not route to T2');
        validate(c);

        const d = new Arc(4);
        for (let i = 0; i < 4; i++) { d.put(i, i); d.get(i); } // all promoted to T2
        for (let i = 200; i < 220; i++) d.put(i, i);           // flood -> T2 evictions -> B2
        check(d._b2._len > 0, () => 't0 A2: B2 empty after a T2 flood (setup invalid)');
        let b2key = -1;
        for (let k = 0; k < 4; k++) if (d._b2.has(k)) { b2key = k; break; }
        check(b2key >= 0, () => 't0 A2: no B2 key to re-reference (setup invalid)');
        d._p = d._capacity; // force p high so a decrease is observable (floored at 0 otherwise)
        const pBefore2 = d._p;
        d.put(b2key, 888); // B2 hit -> p -= max(1, floor(|B1|/|B2|))
        check(d._p < pBefore2, () => 't0 A2: a B2 (frequent-ghost) hit did not LOWER p (' + pBefore2 + ' -> ' + d._p + ')');
        check(d._seg[d._store.get(b2key)] === ARC_T2, () => 't0 A2: a B2 re-admit did not route to T2');
        validate(d);
    }

    // A3: REPLACE victim. With p == 0, |T1| > p whenever T1 is non-empty -> the next
    // capacity victim is the T1 LRU, evicted into B1 (T2 non-empty so it is a REPLACE, not
    // the all-T1 direct-evict edge, which records NO ghost -- D16.4).
    {
        const c = new Arc(4);
        c.put('a', 1); c.get('a');                   // a -> T2
        c.put('b', 2); c.put('c', 3); c.put('d', 4); // T1: b(LRU),c,d(MRU); p=0
        check(c._p === 0, () => 't0 A3: p not 0 at start');
        check(wrapArc(c).victim() === 'b', () => 't0 A3: expected T1 LRU "b" as victim, got ' + wrapArc(c).victim());
        let evKey;
        const e = new Arc(4, { onEvict: (k) => { evKey = k; } });
        e.put('a', 1); e.get('a');
        e.put('b', 2); e.put('c', 3); e.put('d', 4);
        e.put('x', 5); // true miss at capacity -> REPLACE evicts T1 LRU 'b' into B1
        check(evKey === 'b', () => 't0 A3: REPLACE did not evict the T1 LRU (evicted ' + String(evKey) + ')');
        check(!e.has('b'), () => 't0 A3: evicted key still present');
        check(e._b1.has('b'), () => 't0 A3: the T1-evicted key was not recorded in B1');
        check(e.size === 4, () => 't0 A3: size drifted from capacity');
        // The all-T1 edge (|T1| == c) evicts directly with NO ghost record (D16.4).
        const f = new Arc(4);
        f.put(1, 1); f.put(2, 2); f.put(3, 3); f.put(4, 4); // all T1
        f.put(5, 5); // |T1| == c -> direct evict of the T1 LRU 1, not ghosted
        check(!f.has(1), () => 't0 A3: all-T1 edge did not evict the T1 LRU');
        check(!f._b1.has(1), () => 't0 A3: all-T1 direct evict wrongly recorded a ghost');
        validate(e); validate(f);
    }

    // A4: scan resistance -- a proven-frequent SET (in T2) survives a distinct one-hit flood.
    {
        const N = 64; const HOT = 8;
        const c = new Arc(N);
        for (let h = 0; h < HOT; h++) { const k = 'hot' + h; c.put(k, h); c.get(k); } // promote to T2
        for (let h = 0; h < HOT; h++) check(c._seg[c._store.get('hot' + h)] === ARC_T2, () => 't0 A4: hot key ' + h + ' not in T2');
        while (c.size < N) c.put('warm' + c.size, c.size);
        check(c.size === N, () => 't0 A4: arc not full before the scan');
        for (let i = 0; i < 8000; i++) {
            for (let h = 0; h < HOT; h++) check(c.get('hot' + h) === h, () => 't0 A4: hot key ' + h + ' lost mid-scan at ' + i);
            c.put('scan' + i, i);
            check(c.size === N, () => 't0 A4: arc drifted from capacity during the scan');
            check(c._b1._len + c._b2._len <= c._ghostCap, () => 't0 A4: combined ghost exceeded its bound');
            if ((i & 511) === 0) validate(c);
        }
        for (let h = 0; h < HOT; h++) check(c.has('hot' + h), () => 't0 A4: T2 hot key ' + h + ' evicted by the scan (no scan resistance)');
        let survivors = 0;
        for (let i = 0; i < 8000; i++) if (c.has('scan' + i)) survivors++;
        check(survivors < N, () => 't0 A4: too many scan keys survived (' + survivors + ') -- eviction not exercised');
        validate(c);
        void wrapArc(c);
    }

    // --- Lirs laws (decisions/0023) ---------------------------------------------
    const LIRS_LIR = 1, LIRS_INS = 2; // matches Lru.js _st bits

    // L1: the resident split. L_hir = max(1, round(cap*0.01)), L_lir = cap - L_hir; the
    // resident value cap is EXACTLY capacity (only the split moves). The first L_lir distinct
    // blocks warm up as LIR; the next fill as resident HIR.
    {
        const c = new Lirs(100); // L_hir 1, L_lir 99
        check(c._Lhir === 1 && c._Llir === 99, () => 't0 L1: split wrong (Lhir ' + c._Lhir + ' Llir ' + c._Llir + ')');
        for (let i = 0; i < 99; i++) c.put(i, i);
        for (let i = 0; i < 99; i++) check((c._st[c._store.get(i)] & LIRS_LIR) !== 0, () => 't0 L1: warm-up key ' + i + ' not LIR');
        c.put(1000, 1000); // LIR set full -> a new block is resident HIR
        check((c._st[c._store.get(1000)] & LIRS_LIR) === 0, () => 't0 L1: block after warm-up was not HIR');
        check(c.size === 100, () => 't0 L1: resident value cap != capacity');
        validate(c);
    }

    // L2: a LIR hit moves to the TOP of S and is NEUTRAL to Q (LIR blocks are not in Q); has/
    // peek are neutral (no reclass, no stack move).
    {
        const c = new Lirs(16); // L_hir 1, L_lir 15
        for (let i = 0; i < 15; i++) c.put(i, i);       // all LIR
        c.get(0);                                       // LIR hit -> top of S
        check(c._sTop === c._store.get(0), () => 't0 L2: LIR hit did not move to the top of S');
        const topBefore = c._sTop;
        c.has(5); c.peek(5);
        check(c._sTop === topBefore, () => 't0 L2: has/peek moved the stack top (must be neutral)');
        validate(c);
    }

    // L3: a resident-HIR hit while IN S reclassifies to LIR (and demotes the bottom LIR to Q);
    // the HEADLINE recency-of-recency promotion. A non-resident HIR still in the bounded
    // history, re-admitted, also becomes LIR.
    {
        const c = new Lirs(16); // L_hir 1, L_lir 15
        for (let i = 0; i < 15; i++) c.put(i, i);       // 15 LIR
        c.put(100, 100);                                // resident HIR (inS, at top)
        const s100 = c._store.get(100);
        check((c._st[s100] & LIRS_LIR) === 0 && (c._st[s100] & LIRS_INS) !== 0, () => 't0 L3: setup HIR-in-S invalid');
        const lirBefore = c._lirCount;
        c.get(100);                                     // resident-HIR-in-S hit -> promote to LIR
        check((c._st[c._store.get(100)] & LIRS_LIR) !== 0, () => 't0 L3: resident-HIR-in-S hit did not promote to LIR');
        check(c._lirCount === lirBefore, () => 't0 L3: promotion did not demote a bottom LIR (|LIR| drifted)');
        validate(c);

        // Non-resident history re-admit -> LIR (recency-of-recency across an eviction).
        const d = new Lirs(4); // L_hir 1, L_lir 3
        for (let i = 0; i < 3; i++) d.put(i, i);        // 3 LIR
        d.put(10, 10);                                  // resident HIR
        d.put(11, 11);                                  // evicts Q front (10) -> 10 into history
        check(d._hist.has(10), () => 't0 L3: evicted resident HIR not recorded in history');
        d.put(10, 10);                                  // history hit -> re-admit as LIR
        check((d._st[d._store.get(10)] & LIRS_LIR) !== 0, () => 't0 L3: history re-admit did not become LIR');
        validate(d);
    }

    // L4: victim = Q front. The next over-capacity insert evicts the LRU resident HIR.
    {
        const c = new Lirs(4); // L_hir 1, L_lir 3
        for (let i = 0; i < 3; i++) c.put(i, i);       // 3 LIR
        c.put(10, 10);                                  // resident HIR at Q front
        check(wrapLirs(c).victim() === 10, () => 't0 L4: expected Q front 10 as victim, got ' + wrapLirs(c).victim());
        let evKey;
        const e = new Lirs(4, { onEvict: (k) => { evKey = k; } });
        for (let i = 0; i < 3; i++) e.put(i, i);
        e.put(10, 10); e.put(11, 11); // 11 evicts the Q front 10
        check(evKey === 10, () => 't0 L4: eviction victim was not the Q front (got ' + String(evKey) + ')');
        check(e.size === 4, () => 't0 L4: size drifted from capacity');
        validate(e);
    }

    // L5: loop resistance -- a proven LIR set survives a distinct one-hit flood larger than cap.
    {
        const N = 64;
        const c = new Lirs(N);
        for (let h = 0; h < 8; h++) { const k = 'hot' + h; c.put(k, h); c.get(k); c.get(k); }
        const hot = [];
        for (let h = 0; h < 8; h++) { const s = c._store.get('hot' + h); if (s >= 0 && (c._st[s] & LIRS_LIR)) hot.push(h); }
        check(hot.length > 0, () => 't0 L5: no hot key reached LIR (setup invalid)');
        while (c.size < N) c.put('warm' + c.size, c.size);
        for (let i = 0; i < 4000; i++) { for (const h of hot) c.get('hot' + h); c.put('scan' + i, i); }
        for (const h of hot) check(c.has('hot' + h), () => 't0 L5: LIR key ' + h + ' evicted by the scan');
        validate(c);
        void wrapLirs(c);
    }

    // --- TTL laws (decisions/0017) ----------------------------------------------

    // T1: stale = MISS, and the MISS does NOTHING to policy state. get() on an expired
    // key returns undefined, reaps the entry, fires onEvict exactly once with the right
    // (key, value), and -- crucially -- does NOT promote (no recency change): the LRU
    // order is exactly what it was minus the reaped entry.
    {
        let now = 0; const clock = () => now;
        const ev = [];
        const c = new LiteLru(4, { ttl: 10, clock, onEvict: (k, v) => ev.push([k, v]) });
        c.put('a', 1); c.put('b', 2); c.put('c', 3); // exp all 10; MRU=c .. LRU=a
        now = 11; // everything is now stale
        check(c.get('b') === undefined, () => 't0 TTL T1: stale get did not miss');
        check(ev.length === 1 && ev[0][0] === 'b' && ev[0][1] === 2,
            () => 't0 TTL T1: onEvict not fired once with (b,2)');
        check(c.size === 2, () => 't0 TTL T1: size ' + c.size + ' != 2 after one reap');
        check(c._keys[c._head] === 'c', () => 't0 TTL T1: a stale get PROMOTED (head changed)');
        validate(c);
    }

    // T2: per-put ttlMs OVERRIDES the instance default (D17.4). A short per-put ttl
    // expires before the default; Infinity never expires.
    {
        let now = 0; const clock = () => now;
        const c = new LiteLru(4, { ttl: 100, clock });
        c.put('def', 1);            // default ttl 100
        c.put('short', 2, 5);       // per-put 5
        c.put('never', 3, Infinity);// never
        now = 6;
        check(c.get('short') === undefined, () => 't0 TTL T2: per-put short ttl did not expire');
        check(c.get('def') === 1, () => 't0 TTL T2: default-ttl entry expired too early');
        check(c.get('never') === 3, () => 't0 TTL T2: Infinity ttl expired');
        now = 200;
        check(c.get('def') === undefined, () => 't0 TTL T2: default ttl did not expire by 200');
        check(c.get('never') === 3, () => 't0 TTL T2: Infinity ttl expired at 200');
        validate(c);
    }

    // T3: capacity eviction does NOT prefer stale slots (D17.3). An untouched stale
    // entry still counts toward size and is evicted by the ordinary policy victim, not
    // preferentially because it is stale. Here the stale tail is the LRU victim anyway,
    // but the point is size stays at capacity with a stale resident until touched.
    {
        let now = 0; const clock = () => now;
        const c = new LiteLru(3, { ttl: 5, clock });
        c.put(1, 1); c.put(2, 2, Infinity); c.put(3, 3, Infinity);
        now = 10; // key 1 is stale but untouched
        check(c.size === 3, () => 't0 TTL T3: stale-but-untouched entry dropped from size early');
        c.put(4, 4, Infinity); // ordinary LRU eviction: tail (1) leaves
        check(!c.has(1), () => 't0 TTL T3: LRU tail was not evicted at capacity');
        check(c.size === 3, () => 't0 TTL T3: size drifted from capacity');
        validate(c);
    }

    // --- Iteration order laws (decisions/0018, D18.1/D18.4/D18.5) ----------------
    // keys()/values()/entries()/[Symbol.iterator] walk the documented per-member roster
    // (head -> _next -> NIL per list, concatenated), match an INDEPENDENT manual walk of
    // the documented head fields, and are read-only (size unchanged by a walk).

    // I1 LiteLru -- one recency DLL, MRU (head) -> LRU (tail).
    {
        const c = new LiteLru(16);
        for (let i = 0; i < 40; i++) c.put(i % 24, i); // churn past capacity + updates
        for (let i = 0; i < 10; i++) c.get((i * 7) % 24); // scramble recency
        checkIterOrder('lru', c, [c._head]);
        validate(c);
    }

    // I2 Sieve -- one FIFO ring, newest (head) -> oldest (tail).
    {
        const c = new Sieve(16);
        for (let i = 0; i < 40; i++) c.put(i % 24, i);
        for (let i = 0; i < 10; i++) c.get((i * 5) % 24); // set visited bits (no relink)
        checkIterOrder('sieve', c, [c._head]);
        validate(c);
    }

    // I3 S3Fifo -- MAIN (_mHead..) THEN SMALL (_sHead..); ghost EXCLUDED.
    {
        const c = new S3Fifo(20); // smallCap 2, mainCap 18
        for (let i = 0; i < 20; i++) c.put(i, i); // all in SMALL, at capacity
        c.get(0); c.get(1); // prove some -> they graduate to MAIN on the next eviction
        for (let i = 100; i < 110; i++) c.put(i, i); // force eviction sweeps -> populate MAIN
        check(c._mHead !== NIL, () => 't0 ITER s3fifo: MAIN empty (setup did not exercise both rings)');
        check(c._sHead !== NIL, () => 't0 ITER s3fifo: SMALL empty (setup invalid)');
        checkIterOrder('s3fifo', c, [c._mHead, c._sHead]);
        validate(c);
    }

    // I4 WTinyLfu -- WINDOW (_wHead..) THEN PROTECTED (_ptHead..) THEN PROBATION (_prHead..).
    {
        const c = new WTinyLfu(20); // window 1, protected 15, probation 4
        for (let i = 0; i < 20; i++) c.put(i, i); // fill; window sheds overflow to probation
        for (let i = 0; i < 20; i++) c.get(i); // promote probation hits into protected
        check(c._ptHead !== NIL, () => 't0 ITER wtinylfu: PROTECTED empty (setup invalid)');
        checkIterOrder('wtinylfu', c, [c._wHead, c._ptHead, c._prHead]);
        validate(c);
    }

    // I6 Slru -- PROTECTED (_protHead..) THEN PROBATION (_probHead..), each MRU..LRU.
    {
        const c = new Slru(20); // protectedCap 16
        for (let i = 0; i < 20; i++) c.put(i, i); // all in probation, at capacity
        for (let i = 0; i < 20; i++) { c.get(i); c.get(i); } // 2 hits each -> promote to protected
        check(c._protHead !== NIL, () => 't0 ITER slru: PROTECTED empty (setup invalid)');
        for (let i = 100; i < 108; i++) c.put(i, i); // fresh newcomers -> probation
        check(c._probHead !== NIL, () => 't0 ITER slru: PROBATION empty (setup invalid)');
        checkIterOrder('slru', c, [c._protHead, c._probHead]);
        validate(c);
    }

    // I7 TwoQ -- Am (_amHead..) THEN A1in (_a1Head..), each MRU..LRU.
    {
        const c = new TwoQ(20); // a1inCap 5, ghostCap 15
        for (let i = 0; i < 10; i++) c.put(i, i);        // enter A1in
        for (let i = 0; i < 20; i++) c.put(1000 + i, i); // flush 0..9 out of A1in -> ghost
        for (let i = 0; i < 10; i++) c.put(i, i);        // second sighting -> Am
        for (let i = 100; i < 105; i++) c.put(i, i);     // fresh newcomers -> A1in
        check(c._amHead !== NIL, () => 't0 ITER twoq: Am empty (setup invalid)');
        check(c._a1Head !== NIL, () => 't0 ITER twoq: A1in empty (setup invalid)');
        checkIterOrder('twoq', c, [c._amHead, c._a1Head]);
        validate(c);
    }

    // I8 Arc -- T2 (_t2Head..) THEN T1 (_t1Head..), each MRU..LRU (decisions/0016, D16.5).
    {
        const c = new Arc(20);
        for (let i = 0; i < 20; i++) c.put(i, i);      // all newcomers -> T1
        for (let i = 0; i < 10; i++) c.get(i);         // hits -> promote to T2
        for (let i = 100; i < 106; i++) c.put(i, i);   // fresh newcomers -> T1
        check(c._t2Head !== NIL, () => 't0 ITER arc: T2 empty (setup invalid)');
        check(c._t1Head !== NIL, () => 't0 ITER arc: T1 empty (setup invalid)');
        checkIterOrder('arc', c, [c._t2Head, c._t1Head]);
        validate(c);
    }

    // I9 Lirs -- the LIR list (_lirHead..) THEN Q (_qHead..), RESIDENT only, non-resident
    // history EXCLUDED (decisions/0023). Both threaded through the shared _next columns.
    {
        const c = new Lirs(20); // L_hir 1, L_lir 19
        for (let i = 0; i < 19; i++) c.put(i, i);      // 19 LIR
        for (let i = 100; i < 106; i++) c.put(i, i);   // resident HIR churn (each evicts the Q front)
        check(c._lirHead !== NIL, () => 't0 ITER lirs: LIR list empty (setup invalid)');
        check(c._qHead !== NIL, () => 't0 ITER lirs: Q empty (setup invalid)');
        checkIterOrder('lirs', c, [c._lirHead, c._qHead]);
        validate(c);
    }

    // I5 TTL-skip WITHOUT reap (D18.5): a walk sees only live entries, but leaves the
    // stale ones resident (size unchanged); purgeStale() is the reclamation path.
    {
        let now = 0; const clock = () => now;
        const c = new LiteLru(8, { ttl: 10, clock });
        c.put('a', 1); c.put('b', 2, Infinity); c.put('c', 3); // b never expires
        now = 20; // a and c are stale, b is live
        const ks = collectScalars(c.keys());
        check(ks.length === 1 && ks[0] === 'b',
            () => 't0 ITER TTL: stale entries not skipped (got [' + ks.join(',') + '])');
        check(c.size === 3, () => 't0 ITER TTL: iteration REAPED stale entries (size ' + c.size + ', expected 3)');
        c.purgeStale(); // the reclamation path (not iteration)
        check(c.size === 1, () => 't0 ITER TTL: purgeStale did not reclaim (size ' + c.size + ')');
        validate(c);
    }

    // --- Snapshot / restore laws (decisions/0021, D21) --------------------------
    const SNAP = [['LiteLru', LiteLru], ['Sieve', Sieve], ['S3Fifo', S3Fifo],
        ['WTinyLfu', WTinyLfu], ['Slru', Slru], ['TwoQ', TwoQ], ['Arc', Arc], ['Lirs', Lirs]];

    // SN1: round-trip identity. Build a churned mid-life state, dump, structuredClone,
    // restore, and assert dump==dump (fixed point) AND identical order/values/size via an
    // independent walk. Every member, both backings.
    for (const [name, C] of SNAP) {
        for (const keys of [undefined, 'int']) {
            const c = new C(20, keys ? { keys } : undefined);
            for (let i = 0; i < 60; i++) c.put(i % 30, i * 7);
            for (let i = 0; i < 20; i++) c.get((i * 3) % 30); // scramble policy state
            validate(c);
            const snap = c.dump();
            const r = C.restore(structuredClone(snap), keys ? { keys } : undefined);
            validate(r);
            check(r.size === c.size, () => 't0 SN1 ' + name + ': restored size ' + r.size + ' != ' + c.size);
            const a = collectPairs(c.entries()), b = collectPairs(r.entries());
            check(a.length === b.length, () => 't0 SN1 ' + name + ': entries length drift');
            for (let i = 0; i < a.length; i++) {
                check(Object.is(a[i][0], b[i][0]) && Object.is(a[i][1], b[i][1]),
                    () => 't0 SN1 ' + name + ': entries[' + i + '] drift after restore');
            }
        }
    }

    // SN2: dump() during a walk is READ-ONLY -- it does NOT bump _ver, so the live
    // iterator keeps stepping (D21 iteration interop). A structural mutation WOULD throw.
    {
        const c = new LiteLru(8);
        for (let i = 0; i < 8; i++) c.put(i, i);
        const it = c.entries();
        it.next();
        const verBefore = c._store._ver;
        c.dump(); // read-only
        check(c._store._ver === verBefore, () => 't0 SN2: dump() bumped _ver (not read-only)');
        let stepped = 0;
        for (let r = it.next(); !r.done; r = it.next()) stepped++;
        check(stepped > 0, () => 't0 SN2: the iterator did not continue after a dump() mid-walk');
    }

    // SN3: TTL verbatim (D21). A restored entry expires at the SAME absolute deadline it
    // would have without the snapshot (expiries are captured verbatim, NOT rebased).
    {
        let now = 0; const clock = () => now;
        const c = new LiteLru(8, { ttl: 100, clock });
        c.put('x', 1);           // exp = 100
        c.put('y', 2, 50);       // exp = 50
        now = 40;
        const r = LiteLru.restore(structuredClone(c.dump()), { ttl: 100, clock });
        now = 60; // past y's deadline (50), before x's (100)
        check(r.get('y') === undefined, () => 't0 SN3: restored short-ttl entry did not expire at its verbatim deadline');
        check(r.get('x') === 1, () => 't0 SN3: restored default-ttl entry expired too early (rebased?)');
        now = 120;
        check(r.get('x') === undefined, () => 't0 SN3: restored default-ttl entry did not expire by its verbatim deadline');
        validate(r);
    }

    // SN4: fresh stats (D21). A restored instance requested with { stats: true } starts
    // with fresh zeroed counters (the holder is NOT captured).
    {
        const c = new LiteLru(8, { stats: true });
        for (let i = 0; i < 12; i++) c.put(i, i);
        c.get(11); c.get(999);
        const r = LiteLru.restore(structuredClone(c.dump()), { stats: true });
        const st = r.stats();
        check(st.hits === 0 && st.misses === 0 && st.evictions === 0 && st.puts === 0,
            () => 't0 SN4: restored stats are not fresh-zeroed');
        validate(r);
    }
}
