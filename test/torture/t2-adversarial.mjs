/**
 * t2 -- adversarial sequences crafted to break the structure. validate() runs
 * after EVERY sub-sequence (the conservation invariant is the net).
 *
 *   A re-hit the MRU N times: the fast path must early-return (head re-hit).
 *   B re-hit the tail then insert, repeatedly: detach-tail + evict-in-place.
 *   C alternate insert/delete at the free-list boundary (0<->1, cap-1<->cap).
 *   D fill / delete-all in three orders (insertion, reverse, random) / refill.
 *   E single-capacity cache: every put evicts; head===tail always.
 */

import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro, LruK } from '../../Lru.js';
import { makePrng, SEED, check, validate, wrapLru, wrapWTinyLfu, wrapSlru, wrapTwoQ, wrapArc, wrapLirs, wrapLfu, wrapClockPro, wrapLruK } from './harness.mjs';

export function run() {
    // --- A: re-hit the MRU N times (the head-re-hit fast path) -------------------
    {
        const c = new LiteLru(8);
        for (let i = 0; i < 8; i++) c.put(i, i);
        const headKey = c._keys[c._head];
        for (let i = 0; i < 1000; i++) {
            const before = c._keys[c._head];
            check(c.get(headKey) === headKey, () => 't2 A: get(head) returned wrong value');
            check(c._keys[c._head] === before, () => 't2 A: re-hitting the MRU changed the head');
        }
        validate(c);
    }

    // --- B: re-hit the tail then insert, repeatedly ------------------------------
    {
        const c = new LiteLru(8, { onEvict: () => {} });
        for (let i = 0; i < 8; i++) c.put(i, i);
        for (let r = 0; r < 500; r++) {
            const tailKey = c._keys[c._tail];
            c.get(tailKey); // promote the tail to head
            check(c._keys[c._head] === tailKey, () => 't2 B: get(tail) did not promote to head');
            c.put(1000 + r, r); // new key evicts the (new) tail
            check(c.size === 8, () => 't2 B: size drifted from capacity (' + c.size + ')');
            validate(c);
        }
    }

    // --- C: alternate insert/delete at the free-list boundary --------------------
    {
        const c = new LiteLru(3);
        for (let r = 0; r < 500; r++) {
            c.put(r, r);           // 0 -> 1 occupied
            check(c.delete(r) === true, () => 't2 C: delete of just-inserted key failed');
            validate(c);           // back to empty each round
            check(c.size === 0, () => 't2 C: size not 0 after delete (' + c.size + ')');
        }
        // now ride the cap-1 <-> cap boundary
        c.put('a', 1); c.put('b', 2); // size 2 of 3
        for (let r = 0; r < 500; r++) {
            c.put('c', r);         // fill to cap (3)
            check(c.size === 3, () => 't2 C: not full at boundary');
            check(c.delete('c') === true, () => 't2 C: delete at boundary failed');
            check(c.size === 2, () => 't2 C: size not 2 after boundary delete');
            validate(c);
        }
    }

    // --- D: fill / delete-all (3 orders) / refill, conservation each phase -------
    {
        const CAP = 32;
        const prng = makePrng(SEED ^ 0xd0);
        const c = new LiteLru(CAP);

        const fill = () => { for (let i = 0; i < CAP; i++) c.put(i, i * 7); validate(c); check(c.size === CAP, () => 't2 D: fill short'); };

        // insertion order
        fill();
        for (let i = 0; i < CAP; i++) { check(c.delete(i), () => 't2 D: insertion-order delete miss'); validate(c); }
        check(c.size === 0, () => 't2 D: not empty after insertion-order delete-all');

        // reverse order
        fill();
        for (let i = CAP - 1; i >= 0; i--) { check(c.delete(i), () => 't2 D: reverse-order delete miss'); validate(c); }
        check(c.size === 0, () => 't2 D: not empty after reverse-order delete-all');

        // random order (Fisher-Yates over a fixed key set)
        fill();
        const keys = [];
        for (let i = 0; i < CAP; i++) keys.push(i);
        for (let i = CAP - 1; i > 0; i--) { const j = prng() % (i + 1); const t = keys[i]; keys[i] = keys[j]; keys[j] = t; }
        for (let i = 0; i < CAP; i++) { check(c.delete(keys[i]), () => 't2 D: random-order delete miss'); validate(c); }
        check(c.size === 0, () => 't2 D: not empty after random-order delete-all');

        // refill after full teardown -- the free list must be intact
        fill();
        check(c.size === CAP, () => 't2 D: refill short after teardown');
        validate(c);
    }

    // --- E: single-capacity cache (head===tail whenever non-empty) --------------
    {
        let evictions = 0;
        const c = new LiteLru(1, { onEvict: () => { evictions++; } });
        for (let i = 0; i < 1000; i++) {
            c.put(i, i);
            check(c.size === 1, () => 't2 E: cap-1 cache size != 1');
            check(c._head === c._tail, () => 't2 E: head !== tail in a cap-1 cache');
            check(c.get(i) === i, () => 't2 E: cap-1 get miss');
            validate(c);
        }
        check(evictions === 999, () => 't2 E: expected 999 evictions, got ' + evictions);
        // clear then reuse
        c.clear();
        check(c.size === 0, () => 't2 E: clear did not empty a cap-1 cache');
        c.put('x', 42);
        check(c.get('x') === 42, () => 't2 E: cap-1 cache not reusable after clear');
        validate(c);
    }

    // --- F: clear() mid-life then reuse, conservation intact --------------------
    {
        const c = new LiteLru(16);
        for (let i = 0; i < 10; i++) c.put(i, i);
        c.get(3); c.get(7); // scramble recency
        c.clear();
        validate(c);
        check(c.size === 0, () => 't2 F: size != 0 after clear');
        for (let i = 0; i < 16; i++) c.put(100 + i, i);
        check(c.size === 16, () => 't2 F: cache not refillable to capacity after clear');
        validate(c);
        void wrapLru(c); // exercise the wrapper on a rebuilt cache
    }

    // --- G: SIEVE scan resistance -- a hot key survives a one-hit-wonder flood ---
    // The canonical SIEVE property (decisions/0012): a repeatedly-accessed key stays
    // visited, so the sweeping hand always grants it a second chance and it survives
    // an unbounded scan of unique one-hit-wonder keys. A plain FIFO would evict it.
    {
        const N = 16;
        const c = new Sieve(N);
        const HOT = 'hot';
        c.put(HOT, 1);
        for (let i = 0; i < N - 1; i++) c.put('cold' + i, i); // fill to capacity
        check(c.size === N, () => 't2 G: sieve not full before the scan');
        for (let i = 0; i < 5000; i++) {
            check(c.get(HOT) === 1, () => 't2 G: hot key lost mid-scan at ' + i);
            c.put('scan' + i, i); // a unique one-hit-wonder each op -> forces eviction
            check(c.size === N, () => 't2 G: sieve drifted from capacity during the scan');
            if ((i & 255) === 0) validate(c);
        }
        check(c.has(HOT), () => 't2 G: the hot key was evicted by a one-hit-wonder scan (no scan resistance)');
        validate(c);

        // Non-vacuity: the cold one-hit-wonders DO get evicted (the scan is real),
        // so the survival above is scan resistance, not an inert cache.
        let scanSurvivors = 0;
        for (let i = 0; i < 5000; i++) if (c.has('scan' + i)) scanSurvivors++;
        check(scanSurvivors < N, () => 't2 G: too many scan keys survived (' + scanSurvivors + ') -- eviction not exercised');
    }

    // --- H: S3-FIFO scan flood -- a proven-hot SET survives distinct one-hit keys -
    // (decisions/0013) S3-FIFO admits newcomers to SMALL (probation); a distinct
    // one-hit-wonder each op enters SMALL unvisited and sweeps straight out. A hot
    // set kept visited graduates to MAIN and keeps earning second chances, so the
    // whole hot set survives an unbounded scan. Stronger than t2 G: a SET, not one key.
    {
        const N = 64;      // smallCap 6, mainCap 58, ghostCap 58
        const HOT = 8;     // a hot working set of 8 keys
        const c = new S3Fifo(N);
        for (let h = 0; h < HOT; h++) c.put('hot' + h, h);
        for (let i = 0; i < N - HOT; i++) c.put('cold' + i, i); // fill to capacity
        check(c.size === N, () => 't2 H: s3fifo not full before the scan');
        for (let i = 0; i < 8000; i++) {
            for (let h = 0; h < HOT; h++) {
                check(c.get('hot' + h) === h, () => 't2 H: hot key ' + h + ' lost mid-scan at ' + i);
            }
            c.put('scan' + i, i); // a unique one-hit-wonder each op -> forces eviction
            check(c.size === N, () => 't2 H: s3fifo drifted from capacity during the scan');
            if ((i & 511) === 0) validate(c);
        }
        for (let h = 0; h < HOT; h++) {
            check(c.has('hot' + h), () => 't2 H: hot key ' + h + ' was evicted by the scan (no scan resistance)');
        }
        validate(c);
        // Non-vacuity: the cold one-hit-wonders DO get evicted (the scan is real).
        let survivors = 0;
        for (let i = 0; i < 8000; i++) if (c.has('scan' + i)) survivors++;
        check(survivors < N, () => 't2 H: too many scan keys survived (' + survivors + ') -- eviction not exercised');
    }

    // --- I: W-TinyLFU degenerate caps + proven-hot-set survival ------------------
    // (decisions/0014) Two adversarial angles. First the degenerate small caps where
    // main==0 (cap 1) or probation==0 (cap 2/3): every put churns, head/tail stay
    // coherent, conservation holds. Then a proven-hot SET survives a distinct one-hit
    // flood -- frequency admission keeps the whole hot set resident (stronger than one
    // key), with a non-vacuity check that the cold keys really are evicted.
    {
        for (const cap of [1, 2, 3]) {
            const c = new WTinyLfu(cap);
            for (let i = 0; i < 500; i++) {
                c.put(i, i);
                check(c.size === Math.min(cap, i + 1), () => 't2 I: cap-' + cap + ' size drift at ' + i);
                check(c.get(i) === i, () => 't2 I: cap-' + cap + ' just-inserted key missing');
                validate(c);
            }
            c.clear();
            check(c.size === 0, () => 't2 I: cap-' + cap + ' not empty after clear');
            validate(c);
        }

        const N = 64;   // window 1, protected 50, probation 13
        const HOT = 8;  // a hot working set of 8 keys
        const c = new WTinyLfu(N);
        for (let h = 0; h < HOT; h++) { c.put('hot' + h, h); for (let r = 0; r < 40; r++) c.get('hot' + h); }
        for (let i = 0; i < N - HOT; i++) c.put('cold' + i, i); // fill to capacity
        check(c.size === N, () => 't2 I: wtinylfu not full before the scan');
        for (let i = 0; i < 8000; i++) {
            for (let h = 0; h < HOT; h++) {
                check(c.get('hot' + h) === h, () => 't2 I: hot key ' + h + ' lost mid-scan at ' + i);
            }
            c.put('scan' + i, i); // a unique one-hit-wonder each op -> forces eviction
            check(c.size === N, () => 't2 I: wtinylfu drifted from capacity during the scan');
            if ((i & 511) === 0) validate(c);
        }
        for (let h = 0; h < HOT; h++) {
            check(c.has('hot' + h), () => 't2 I: hot key ' + h + ' was evicted by the scan (no frequency resistance)');
        }
        validate(c);
        let survivors = 0;
        for (let i = 0; i < 8000; i++) if (c.has('scan' + i)) survivors++;
        check(survivors < N, () => 't2 I: too many scan keys survived (' + survivors + ') -- eviction not exercised');
        void wrapWTinyLfu(c);
    }

    // --- K: Slru degenerate caps + a cap-sized scan evicts 0 protected (decisions/0015)
    {
        const SLRU_PROTECTED = 1;
        for (const cap of [1, 2, 3]) {
            const c = new Slru(cap);
            for (let i = 0; i < 500; i++) {
                c.put(i, i);
                check(c.size === Math.min(cap, i + 1), () => 't2 K: slru cap-' + cap + ' size drift at ' + i);
                check(c.get(i) === i, () => 't2 K: slru cap-' + cap + ' just-inserted key missing');
                validate(c);
            }
            c.clear();
            check(c.size === 0, () => 't2 K: slru cap-' + cap + ' not empty after clear');
            validate(c);
        }
        // A proven-hot SET in protected survives an unbounded distinct one-hit flood.
        const N = 64; const HOT = 8;
        const c = new Slru(N);
        for (let h = 0; h < HOT; h++) { const k = 'hot' + h; c.put(k, h); c.get(k); c.get(k); } // -> protected
        while (c.size < N) c.put('warm' + c.size, c.size);
        check(c.size === N, () => 't2 K: slru not full before the scan');
        for (let i = 0; i < 8000; i++) {
            for (let h = 0; h < HOT; h++) check(c.get('hot' + h) === h, () => 't2 K: hot key ' + h + ' lost mid-scan at ' + i);
            c.put('scan' + i, i);
            check(c.size === N, () => 't2 K: slru drifted from capacity during the scan');
            if ((i & 511) === 0) validate(c);
        }
        for (let h = 0; h < HOT; h++) {
            check(c.has('hot' + h), () => 't2 K: protected hot key ' + h + ' evicted by the scan (no scan resistance)');
            check(c._seg[c._store.get('hot' + h)] === SLRU_PROTECTED, () => 't2 K: hot key ' + h + ' left protected');
        }
        let survivors = 0;
        for (let i = 0; i < 8000; i++) if (c.has('scan' + i)) survivors++;
        check(survivors < N, () => 't2 K: too many scan keys survived (' + survivors + ') -- eviction not exercised');
        validate(c);
        void wrapSlru(c);
    }

    // --- L: TwoQ degenerate caps + a cap-sized scan evicts 0 Am (decisions/0015) -
    {
        const TWOQ_AM = 1;
        for (const cap of [1, 2, 3]) {
            const c = new TwoQ(cap);
            for (let i = 0; i < 500; i++) {
                c.put(i, i);
                check(c.size === Math.min(cap, i + 1), () => 't2 L: twoq cap-' + cap + ' size drift at ' + i);
                check(c.get(i) === i, () => 't2 L: twoq cap-' + cap + ' just-inserted key missing');
                check(c._gLen <= c._ghostCap, () => 't2 L: twoq cap-' + cap + ' ghost exceeded bound');
                validate(c);
            }
            c.clear();
            check(c.size === 0, () => 't2 L: twoq cap-' + cap + ' not empty after clear');
            check(c._gLen === 0, () => 't2 L: twoq cap-' + cap + ' ghost not empty after clear');
            validate(c);
        }
        // A proven-hot SET in Am (via the ghost path) survives a distinct one-hit flood.
        const N = 64; const HOT = 8;
        const c = new TwoQ(N);
        const hot = [];
        for (let h = 0; h < HOT; h++) hot.push('hot' + h);
        for (const k of hot) c.put(k, 0);                  // A1in
        for (let i = 0; i < N; i++) c.put('flush' + i, i); // flush hot out of A1in -> ghost
        for (let h = 0; h < HOT; h++) c.put(hot[h], h);    // second sighting -> Am
        for (const k of hot) check(c._seg[c._store.get(k)] === TWOQ_AM, () => 't2 L: hot key ' + k + ' not in Am');
        while (c.size < N) c.put('warm' + c.size, c.size);
        check(c.size === N, () => 't2 L: twoq not full before the scan');
        for (let i = 0; i < 8000; i++) {
            for (let h = 0; h < HOT; h++) check(c.get('hot' + h) === h, () => 't2 L: hot key ' + h + ' lost mid-scan at ' + i);
            c.put('scan' + i, i);
            check(c.size === N, () => 't2 L: twoq drifted from capacity during the scan');
            check(c._gLen <= c._ghostCap, () => 't2 L: twoq ghost exceeded bound during the scan');
            if ((i & 511) === 0) validate(c);
        }
        for (let h = 0; h < HOT; h++) check(c.has('hot' + h), () => 't2 L: Am hot key ' + h + ' evicted by the scan (no scan resistance)');
        let survivors = 0;
        for (let i = 0; i < 8000; i++) if (c.has('scan' + i)) survivors++;
        check(survivors < N, () => 't2 L: too many scan keys survived (' + survivors + ') -- eviction not exercised');
        validate(c);
        void wrapTwoQ(c);
    }

    // --- M: Arc degenerate caps + scan flood + the PHASE-CHANGE law (decisions/0016) -
    {
        const ARC_T2 = 1;
        // Degenerate caps 1/2/3: every put churns, head/tail stay coherent, conservation
        // holds, both ghost bounds respected.
        for (const cap of [1, 2, 3]) {
            const c = new Arc(cap);
            for (let i = 0; i < 500; i++) {
                c.put(i, i);
                check(c.size === Math.min(cap, i + 1), () => 't2 M: arc cap-' + cap + ' size drift at ' + i);
                check(c.get(i) === i, () => 't2 M: arc cap-' + cap + ' just-inserted key missing');
                check(c._b1._len + c._b2._len <= c._ghostCap, () => 't2 M: arc cap-' + cap + ' combined ghost exceeded bound');
                check(c._t1Size + c._b1._len <= c._ghostCap, () => 't2 M: arc cap-' + cap + ' |T1|+|B1| exceeded bound');
                validate(c);
            }
            c.clear();
            check(c.size === 0, () => 't2 M: arc cap-' + cap + ' not empty after clear');
            check(c._b1._len === 0 && c._b2._len === 0, () => 't2 M: arc cap-' + cap + ' ghosts not empty after clear');
            check(c._p === 0, () => 't2 M: arc cap-' + cap + ' p not reset after clear');
            validate(c);
        }

        // A proven-frequent SET in T2 survives an unbounded distinct one-hit flood -- a
        // cap-sized scan evicts 0 T2 entries.
        const N = 64; const HOT = 8;
        const c = new Arc(N);
        for (let h = 0; h < HOT; h++) { const k = 'hot' + h; c.put(k, h); c.get(k); } // -> T2
        for (let h = 0; h < HOT; h++) check(c._seg[c._store.get('hot' + h)] === ARC_T2, () => 't2 M: hot key ' + h + ' not in T2');
        while (c.size < N) c.put('warm' + c.size, c.size);
        check(c.size === N, () => 't2 M: arc not full before the scan');
        for (let i = 0; i < 8000; i++) {
            for (let h = 0; h < HOT; h++) check(c.get('hot' + h) === h, () => 't2 M: hot key ' + h + ' lost mid-scan at ' + i);
            c.put('scan' + i, i);
            check(c.size === N, () => 't2 M: arc drifted from capacity during the scan');
            check(c._b1._len + c._b2._len <= c._ghostCap, () => 't2 M: arc combined ghost exceeded bound in scan');
            if ((i & 511) === 0) validate(c);
        }
        for (let h = 0; h < HOT; h++) check(c.has('hot' + h), () => 't2 M: T2 hot key ' + h + ' evicted by the scan (no scan resistance)');
        let survivors = 0;
        for (let i = 0; i < 8000; i++) if (c.has('scan' + i)) survivors++;
        check(survivors < N, () => 't2 M: too many scan keys survived (' + survivors + ') -- eviction not exercised');
        validate(c);

        // PHASE-CHANGE law: a RECENCY phase (re-references of keys just evicted from T1 ->
        // B1 hits) must drive p UP; a following FREQUENCY phase (re-references of keys
        // evicted from T2 -> B2 hits) must drive p DOWN. The DIRECTION is the point. Note
        // B1 can only form while T2 is non-empty (an all-T1 cache direct-evicts, D16.4), so
        // the recency phase seeds a little T2 first -- exactly ARC's real regime.
        {
            const CAP = 32;
            // Recency phase: seed some T2, then repeatedly capture the T1 LRU that REPLACE
            // sends to B1 and re-reference it -> a B1 hit each time -> p climbs from 0.
            let lastEvicted = null;
            const a = new Arc(CAP, { onEvict: (k) => { lastEvicted = k; } });
            for (let i = 0; i < 8; i++) { a.put('f' + i, i); a.get('f' + i); } // seed T2
            let b1Hits = 0, next = 0;
            for (let round = 0; round < 400; round++) {
                lastEvicted = null;
                a.put('n' + next, next); next++;                 // true miss -> a resident -> ghost
                if (lastEvicted !== null && a._b1.has(lastEvicted)) { a.put(lastEvicted, 0); b1Hits++; } // B1 hit -> p++
            }
            check(b1Hits > 0, () => 't2 M: recency phase produced 0 B1 hits (setup invalid)');
            check(a._p > 0, () => 't2 M: recency phase did not raise p above 0 (got ' + a._p + ')');
            validate(a);

            // Frequency phase: from a recency-biased peak (p == CAP), drive B2 hits (re-
            // references of keys evicted from T2) -> p must FALL.
            const b = new Arc(CAP);
            for (let i = 0; i < CAP; i++) { b.put(i, i); b.get(i); } // all -> T2
            b._p = CAP; // peak, so a B2 hit's DECREASE is observable (floored at 0 otherwise)
            const pStart = b._p;
            let b2Hits = 0;
            for (let round = 0; round < 8; round++) {
                const base = 1000 + round * CAP;
                for (let i = 0; i < CAP; i++) b.put(base + i, i);            // flush T2 keys -> B2
                for (let i = 0; i < CAP; i++) if (b._b2.has(i)) { b.put(i, i); b2Hits++; } // B2 hits (lower p)
            }
            check(b2Hits > 0, () => 't2 M: frequency phase produced 0 B2 hits (setup invalid)');
            check(b._p < pStart, () => 't2 M: frequency phase did not lower p from ' + pStart + ' (got ' + b._p + ')');
            validate(b);
        }
        void wrapArc(c);
    }

    // --- O: Lirs degenerate caps + the ADVERSARIAL max-pruning trace + scan/loop
    // resistance + conservation (decisions/0023) -----------------------------------
    {
        const LIRS_LIR = 1;
        // Degenerate caps 1..4: every put churns, conservation holds, the split is honored
        // (cap 1 -> L_lir 0 all-HIR window edge), the history stays bounded.
        for (const cap of [1, 2, 3, 4]) {
            const c = new Lirs(cap);
            check(c._Lhir === Math.max(1, Math.round(cap * 0.01)), () => 't2 O: cap-' + cap + ' L_hir wrong');
            check(c._Llir === cap - c._Lhir, () => 't2 O: cap-' + cap + ' L_lir wrong');
            for (let i = 0; i < 500; i++) {
                c.put(i, i);
                check(c.size === Math.min(cap, i + 1), () => 't2 O: lirs cap-' + cap + ' size drift at ' + i);
                check(c.get(i) === i, () => 't2 O: lirs cap-' + cap + ' just-inserted key missing');
                check(c._hist._len <= cap, () => 't2 O: lirs cap-' + cap + ' history exceeded bound');
                validate(c);
            }
            c.clear();
            check(c.size === 0, () => 't2 O: lirs cap-' + cap + ' not empty after clear');
            check(c._hist._len === 0, () => 't2 O: lirs cap-' + cap + ' history not empty after clear');
            validate(c);
        }

        // The ADVERSARIAL max-pruning trace (OWNER RULING: measured, never capped). Stack the
        // WHOLE resident-HIR set at the BOTTOM of S above a single deep LIR, then touch that
        // LIR: the move-to-top forces a prune that walks the entire HIR run in ONE access. In
        // the bounded-ring D23 design the linked stack S holds ONLY resident blocks (non-
        // resident history is the separate keys-only ring), so the worst case is exactly the
        // resident-HIR reserve L_hir -- NOT O(capacity); measured here + timed under 4 ms.
        for (const CAP of [64, 4096]) {
            const c = new Lirs(CAP, { keys: 'int' });
            for (let i = 0; i < CAP; i++) c.put(i, i);   // 0..L_lir-1 LIR (bottom), L_lir..CAP-1 HIR (top)
            check(c.size === CAP, () => 't2 O: adversarial cap-' + CAP + ' not full');
            const residentHir = CAP - c._lirCount;
            for (let i = 1; i < c._Llir; i++) c.get(i);  // lift every LIR but key 0 above the HIR run
            // key 0 is now the sole LIR at the bottom, with the full HIR run just above it.
            check((c._st[c._store.get(0)] & LIRS_LIR) !== 0, () => 't2 O: key 0 lost LIR status');
            check(c._sBot === c._store.get(0), () => 't2 O: key 0 is not the stack bottom pre-prune');
            let hirAtBottom = 0;
            for (let s = c._sPrev[c._sBot]; s !== -1; s = c._sPrev[s]) { if ((c._st[s] & LIRS_LIR) === 0) hirAtBottom++; else break; }
            const t0 = performance.now();
            c.get(0);                                    // deep-LIR hit -> the whole-run prune
            const ms = performance.now() - t0;
            check(hirAtBottom === residentHir, () => 't2 O: cap-' + CAP + ' expected ' + residentHir + ' HIR stacked at the bottom, saw ' + hirAtBottom);
            check(ms <= 4, () => 't2 O: cap-' + CAP + ' adversarial prune took ' + ms.toFixed(3) + ' ms (> 4 ms) -- BLOCKER');
            check(c.size === CAP, () => 't2 O: cap-' + CAP + ' size changed by pruning');
            validate(c);
        }

        // LOOP resistance: a loop LARGER than capacity keeps the proven-hot LIR set stable
        // where classic LRU would thrash it. A cap+1 scan evicts 0 LIR blocks.
        {
            const N = 64;
            const c = new Lirs(N);
            for (let h = 0; h < 8; h++) { const k = 'hot' + h; c.put(k, h); c.get(k); c.get(k); } // establish as LIR
            const hotLir = [];
            for (let h = 0; h < 8; h++) { const s = c._store.get('hot' + h); if (s >= 0 && (c._st[s] & LIRS_LIR)) hotLir.push(h); }
            check(hotLir.length > 0, () => 't2 O: no hot key reached LIR (setup invalid)');
            while (c.size < N) c.put('warm' + c.size, c.size);
            for (let i = 0; i < 8000; i++) {
                for (const h of hotLir) check(c.get('hot' + h) === h, () => 't2 O: hot LIR key ' + h + ' lost mid-scan at ' + i);
                c.put('scan' + i, i);
                check(c.size === N, () => 't2 O: lirs drifted from capacity during the scan');
                check(c._hist._len <= N, () => 't2 O: lirs history exceeded bound in scan');
                if ((i & 511) === 0) validate(c);
            }
            for (const h of hotLir) check(c.has('hot' + h), () => 't2 O: hot LIR key ' + h + ' evicted by the scan (no scan resistance)');
            let survivors = 0;
            for (let i = 0; i < 8000; i++) if (c.has('scan' + i)) survivors++;
            check(survivors < N, () => 't2 O: too many scan keys survived (' + survivors + ') -- eviction not exercised');
            validate(c);
            void wrapLirs(c);
        }
    }

    // --- P: Lfu degenerate caps + exact-frequency law + the min-bucket eviction +
    // in-place-relabel + scan resistance + conservation (decisions/0024) ------------
    {
        // Degenerate caps 1..4: every put churns, conservation holds, and the exact
        // frequency of a repeatedly-touched key climbs by exactly one per access.
        for (const cap of [1, 2, 3, 4]) {
            const c = new Lfu(cap);
            for (let i = 0; i < 500; i++) {
                c.put(i, i);
                check(c.size === Math.min(cap, i + 1), () => 't2 P: lfu cap-' + cap + ' size drift at ' + i);
                check(c.get(i) === i, () => 't2 P: lfu cap-' + cap + ' just-inserted key missing');
                validate(c);
            }
            c.clear();
            check(c.size === 0, () => 't2 P: lfu cap-' + cap + ' not empty after clear');
            check(c._bMin === -1, () => 't2 P: lfu cap-' + cap + ' bucket list not empty after clear');
            check(c._freeListLength() === cap, () => 't2 P: lfu cap-' + cap + ' free list != capacity after clear');
            validate(c);
        }

        // The EXACT-frequency + min-bucket eviction law. Fill; then raise the frequency of
        // a proven-hot subset far above the rest. A cap+K cold scan evicts ONLY the coldest
        // (freq-1) keys -- never a hot key -- which is precisely what an exact LFU must do and
        // what the approximate WTinyLfu sketch cannot guarantee.
        {
            const N = 64;
            const c = new Lfu(N, { keys: 'int' });
            for (let i = 0; i < N; i++) c.put(i, i);        // all at freq 1
            const hot = [0, 1, 2, 3, 4, 5, 6, 7];
            for (const h of hot) for (let t = 0; t < 20; t++) c.get(h); // lift hot keys' frequency
            // The next victim must be a COLD (freq-1) key, and it must be the LRU-end one.
            check(!hot.includes(c._peekVictim()), () => 't2 P: lfu victim is a hot key -- exact LFU violated');
            for (let i = 0; i < 8000; i++) {
                for (const h of hot) check(c.get(h) === h, () => 't2 P: lfu hot key ' + h + ' lost mid-scan at ' + i);
                c.put(1000 + i, i);                          // cold churn
                check(c.size === N, () => 't2 P: lfu drifted from capacity during the scan');
                if ((i & 511) === 0) validate(c);
            }
            for (const h of hot) check(c.has(h), () => 't2 P: lfu hot key ' + h + ' evicted by the scan (no frequency resistance)');
            validate(c);
            void wrapLfu(c);
        }

        // In-place RELABEL: a single key whose frequency climbs unboundedly must never grow
        // the bucket pool beyond one live bucket (relabel, not create+destroy).
        {
            const c = new Lfu(4);
            c.put('x', 1);
            for (let i = 0; i < 100000; i++) c.get('x');
            check(c.size === 1, () => 't2 P: lfu single-key size drift');
            check(c._bFreq[c._bMin] === 100001, () => 't2 P: lfu exact frequency wrong after 100k touches: ' + c._bFreq[c._bMin]);
            // exactly one live bucket, the rest free (pool conserved, never grown)
            let live = 0; for (let b = c._bMin; b !== -1; b = c._bNext[b]) live++;
            check(live === 1, () => 't2 P: lfu single hot key created ' + live + ' live buckets (relabel broken)');
            validate(c);
        }
    }

    // --- Q: ClockPro degenerate caps + reference-bit second chance + scan resistance +
    // the bounded-history bound + conservation (decisions/0025) --------------------
    {
        // Degenerate caps 1..4: every put churns, conservation holds, the history stays
        // bounded, and hot+cold == size always.
        for (const cap of [1, 2, 3, 4]) {
            const c = new ClockPro(cap);
            for (let i = 0; i < 500; i++) {
                c.put(i, i);
                check(c.size === Math.min(cap, i + 1), () => 't2 Q: clockpro cap-' + cap + ' size drift at ' + i);
                check(c.get(i) === i, () => 't2 Q: clockpro cap-' + cap + ' just-inserted key missing');
                check(c._hist._len <= cap, () => 't2 Q: clockpro cap-' + cap + ' history over bound');
                check(c._nHot + c._nCold === c.size, () => 't2 Q: clockpro cap-' + cap + ' hot+cold != size');
                validate(c);
            }
            c.clear();
            check(c.size === 0, () => 't2 Q: clockpro cap-' + cap + ' not empty after clear');
            check(c._handCold === -1 && c._handHot === -1 && c._handTest === -1,
                () => 't2 Q: clockpro cap-' + cap + ' hands not reset after clear');
            check(c._freeListLength() === cap, () => 't2 Q: clockpro cap-' + cap + ' free list != capacity after clear');
            validate(c);
        }

        // Scan resistance: a referenced-and-promoted hot set survives a distinct one-hit
        // flood far larger than capacity, at EXACTLY capacity throughout.
        {
            const N = 64;
            const c = new ClockPro(N, { keys: 'int' });
            for (let i = 0; i < N; i++) c.put(i, i);
            const hot = [0, 1, 2, 3, 4, 5, 6, 7];
            for (const h of hot) for (let t = 0; t < 10; t++) c.get(h);
            for (let i = 0; i < 8000; i++) {
                for (const h of hot) check(c.get(h) === h, () => 't2 Q: clockpro hot key ' + h + ' lost mid-scan at ' + i);
                c.put(1000 + i, i);
                check(c.size === N, () => 't2 Q: clockpro drifted from capacity during the scan');
                check(c._hist._len <= N, () => 't2 Q: clockpro history over bound during the scan');
                if ((i & 511) === 0) validate(c);
            }
            for (const h of hot) check(c.has(h), () => 't2 Q: clockpro hot key ' + h + ' evicted by the scan (no scan resistance)');
            validate(c);
            void wrapClockPro(c);
        }
    }

    // --- R: LruK degenerate caps + cold-first eviction + all-warm min-r1 scan +
    // the bounded-history bound + conservation (decisions/0026) --------------------
    {
        // Degenerate caps 1..4: every put churns, conservation holds, the history stays
        // bounded, |cold| + |warm| == size, and every cold page sits at the -Infinity sentinel.
        for (const cap of [1, 2, 3, 4]) {
            const c = new LruK(cap);
            for (let i = 0; i < 500; i++) {
                c.put(i, i);
                check(c.size === Math.min(cap, i + 1), () => 't2 R: lruk cap-' + cap + ' size drift at ' + i);
                check(c.get(i) === i, () => 't2 R: lruk cap-' + cap + ' just-inserted key missing');
                check(c._hist._len <= cap, () => 't2 R: lruk cap-' + cap + ' history over bound');
                validate(c);
            }
            c.clear();
            check(c.size === 0, () => 't2 R: lruk cap-' + cap + ' not empty after clear');
            check(c._coldHead === -1 && c._coldTail === -1 && c._warmHead === -1 && c._warmTail === -1,
                () => 't2 R: lruk cap-' + cap + ' list ends not reset after clear');
            check(c._t === 0, () => 't2 R: lruk cap-' + cap + ' logical clock not reset after clear');
            check(c._freeListLength() === cap, () => 't2 R: lruk cap-' + cap + ' free list != capacity after clear');
            validate(c);
        }

        // Scan resistance: a deeply-WARM working set survives a distinct one-hit flood far larger
        // than capacity (cold intruders are evicted from the cold tail first), at EXACTLY capacity.
        // This is also the ADVERSARIAL all-warm state where the min-r1 victim scan runs.
        {
            const N = 64;
            const c = new LruK(N, { keys: 'int' });
            for (let i = 0; i < N; i++) c.put(i, i);
            const hot = [0, 1, 2, 3, 4, 5, 6, 7];
            for (const h of hot) for (let t = 0; t < 10; t++) c.get(h);
            for (let i = 0; i < 8000; i++) {
                for (const h of hot) check(c.get(h) === h, () => 't2 R: lruk hot key ' + h + ' lost mid-scan at ' + i);
                c.put(1000 + i, i);
                check(c.size === N, () => 't2 R: lruk drifted from capacity during the scan');
                check(c._hist._len <= N, () => 't2 R: lruk history over bound during the scan');
                if ((i & 511) === 0) validate(c);
            }
            for (const h of hot) check(c.has(h), () => 't2 R: lruk hot key ' + h + ' evicted by the scan (no scan resistance)');
            validate(c);
            void wrapLruK(c);
        }

        // All-warm min-r1 correctness at scale: make every resident warm, then verify the
        // reported victim is exactly the warm page with the smallest _r1 (independent recompute).
        {
            const N = 32;
            const c = new LruK(N, { keys: 'int' });
            for (let i = 0; i < N; i++) { c.put(i, i); c.get(i); } // every page warm
            check(c._coldHead === -1, () => 't2 R: setup -- a cold page remained (not all-warm)');
            // scramble the reference order so r1 values are well mixed
            const p = makePrng(SEED ^ 0x717c0de);
            for (let i = 0; i < 500; i++) c.get(p() % N);
            let want = -1, wantR1 = Infinity;
            for (let s = c._warmHead; s !== -1; s = c._next[s]) {
                if (c._r1[s] < wantR1) { wantR1 = c._r1[s]; want = s; }
            }
            check(c._peekVictim() === c._keys[want],
                () => 't2 R: lruk all-warm victim ' + String(c._peekVictim()) + ' != min-r1 key ' + String(c._keys[want]));
            validate(c);
        }
    }

    // --- J: the LAZY-SEMANTICS TRIPLE as executable laws (decisions/0017, D17.3) --
    // For EVERY member: an expired entry is a MISS through get/has/peek alike, and each
    // of the three REAPS it in place (fires onEvict once, size drops). A fresh Infinity
    // sibling is untouched by any of them. validate() nets each reap.
    {
        const members = [['LiteLru', LiteLru], ['Sieve', Sieve], ['S3Fifo', S3Fifo], ['WTinyLfu', WTinyLfu], ['Slru', Slru], ['TwoQ', TwoQ], ['Arc', Arc], ['Lirs', Lirs], ['Lfu', Lfu], ['ClockPro', ClockPro], ['LruK', LruK]];
        // one probe method per fresh cache (each reap is destructive, so isolate them)
        const probes = [
            ['get', (c, k) => c.get(k), undefined],
            ['has', (c, k) => c.has(k), false],
            ['peek', (c, k) => c.peek(k), undefined],
        ];
        for (const [name, C] of members) {
            for (const [pname, probe, missVal] of probes) {
                let now = 0; const clock = () => now;
                const ev = [];
                const c = new C(8, { ttl: 10, clock, onEvict: (k, v) => ev.push(k) });
                c.put('x', 1);              // ttl 10
                c.put('keep', 2, Infinity); // never expires
                now = 11;                   // x is stale, keep is not
                const r = probe(c, 'x');
                check(Object.is(r, missVal),
                    () => 't2 J: ' + name + '.' + pname + '(stale) returned ' + String(r) + ', expected ' + String(missVal));
                check(ev.length === 1 && ev[0] === 'x',
                    () => 't2 J: ' + name + '.' + pname + '(stale) did not reap+fire onEvict once');
                check(c.size === 1 && c.has('keep'),
                    () => 't2 J: ' + name + '.' + pname + ' reaped the fresh Infinity sibling');
                validate(c);
                // A SECOND probe of the same reaped key is a plain miss (idempotent, no
                // second onEvict).
                const r2 = probe(c, 'x');
                check(Object.is(r2, missVal), () => 't2 J: ' + name + '.' + pname + ' re-probe not a miss');
                check(ev.length === 1, () => 't2 J: ' + name + '.' + pname + ' fired onEvict twice');
            }
        }
    }

    // --- N: snapshot at the adversarial STRUCTURAL boundaries (decisions/0021) ---
    // dump()/restore() must survive the same edges the free-list stresses above hit:
    // an EMPTY cache, a cap-1 cache, a FULL (at-capacity) cache, and a cache sitting
    // BELOW capacity after deletes (the free-list boundary -- restore must rebuild the
    // free stack so size + freeListLength === capacity). Every member, both backings.
    {
        const members = [['LiteLru', LiteLru], ['Sieve', Sieve], ['S3Fifo', S3Fifo],
            ['WTinyLfu', WTinyLfu], ['Slru', Slru], ['TwoQ', TwoQ], ['Arc', Arc], ['Lirs', Lirs], ['Lfu', Lfu],
            ['ClockPro', ClockPro], ['LruK', LruK]];
        for (const [name, C] of members) {
            for (const keys of [undefined, 'int']) {
                const o = keys ? { keys } : undefined;

                // empty cache
                {
                    const c = new C(8, o);
                    const r = C.restore(structuredClone(c.dump()), o);
                    check(r.size === 0, () => 't2 N ' + name + ': empty restore size ' + r.size);
                    check(r._freeListLength() === 8, () => 't2 N ' + name + ': empty restore free list != capacity');
                    validate(r);
                }
                // cap-1 cache, full then reused after restore
                {
                    const c = new C(1, o);
                    c.put(7, 70);
                    const r = C.restore(structuredClone(c.dump()), o);
                    check(r.size === 1 && r.get(7) === 70, () => 't2 N ' + name + ': cap-1 restore lost the entry');
                    r.put(9, 90); // must evict 7 and reuse the sole slot
                    check(r.size === 1 && r.get(9) === 90, () => 't2 N ' + name + ': cap-1 restore not reusable');
                    validate(r);
                }
                // FULL at capacity, churned so all lists/ghosts/sketch/p are populated
                {
                    const c = new C(16, o);
                    for (let i = 0; i < 60; i++) c.put(i % 24, i);
                    for (let i = 0; i < 16; i++) c.get((i * 5) % 24);
                    check(c.size === 16, () => 't2 N ' + name + ': setup not full');
                    const r = C.restore(structuredClone(c.dump()), o);
                    check(r.size === 16, () => 't2 N ' + name + ': full restore size ' + r.size);
                    check(r._freeListLength() === 0, () => 't2 N ' + name + ': full restore free list != 0');
                    validate(r);
                }
                // BELOW capacity after deletes: the free-list boundary
                {
                    const c = new C(16, o);
                    for (let i = 0; i < 16; i++) c.put(i, i * 3);
                    for (let i = 0; i < 6; i++) c.delete(i * 2); // punch holes -> size 10 of 16
                    check(c.size === 10, () => 't2 N ' + name + ': hole-punch setup size ' + c.size);
                    const r = C.restore(structuredClone(c.dump()), o);
                    check(r.size === 10, () => 't2 N ' + name + ': below-cap restore size ' + r.size);
                    check(r.size + r._freeListLength() === 16,
                        () => 't2 N ' + name + ': below-cap restore conservation broken');
                    validate(r);
                    // Refill to capacity after restore -- the rebuilt free list must serve.
                    for (let i = 100; r.size < 16; i++) r.put(i, i);
                    check(r.size === 16, () => 't2 N ' + name + ': restored cache not refillable to capacity');
                    validate(r);
                }
            }
        }
    }
}
