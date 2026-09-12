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

import { LiteLru, S3Fifo, WTinyLfu } from '../../Lru.js';
import { makePrng, SEED, check, validate, wrapLru, wrapS3Fifo, wrapWTinyLfu } from './harness.mjs';

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
}
