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

import { LiteLru } from '../../Lru.js';
import { makePrng, SEED, check, validate, wrapLru } from './harness.mjs';

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
}
