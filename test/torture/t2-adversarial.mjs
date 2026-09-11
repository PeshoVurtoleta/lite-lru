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

import { LiteLru } from '../../Lru.js';
import { makePrng, SEED, check, validate, wrapLru } from './harness.mjs';

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
}
