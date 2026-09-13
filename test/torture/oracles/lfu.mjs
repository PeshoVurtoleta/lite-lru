/**
 * Brute-force Lfu (exact O(1) LFU with LRU tie-break) reference oracle -- the differential
 * ground truth for the `Lfu` member (decisions/0024).
 *
 * Deliberately a DIFFERENT representation from Lru.js: a plain array of resident entries
 * `{key, val, freq, exp, seq}` scanned linearly, plus a monotone `seq` stamp used ONLY to
 * break frequency ties by recency. It shares NO code with the SoA/bucket-pool implementation
 * (no Int32Array, no bucket list, no frequency columns), so it can never share a bug.
 * Clarity over speed -- it is the oracle, not the product.
 *
 * Lfu semantics mirrored EXACTLY (decisions/0024, D24):
 *   - exact frequency counting: a new key enters at freq 1; a get(hit) and a put(update)
 *     both increment freq by one (put-update COUNTS as a hit).
 *   - within a frequency, tie-break is LRU: a newcomer and a just-touched key become the
 *     MOST-recent at their frequency (highest `seq`); eviction removes the LEAST-recent key
 *     of the LOWEST frequency.
 *   - has/peek: frequency-neutral (no freq change).
 *   - at capacity a new key evicts the min-frequency, least-recent-within-it entry.
 *   - delete removes the key.
 *   - victim() = the key the next over-capacity insert would evict (never mutates).
 *
 * SameValueZero key equality (svz) mirrors JS Map, matching the default backing.
 */

import { svz, oracleExpiry } from './lru.mjs';

/**
 * @param {number} cap
 * @param {{ttl?:number, clock?:()=>number}} [opts]  opt-in TTL (decisions/0017)
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeLfuOracle(cap, opts) {
    const ttl = opts && opts.ttl;
    const clock = (opts && opts.clock) || (() => 0);
    const hasTtl = ttl !== undefined;

    const entries = []; // resident entries, scanned linearly; order is not significant
    let seq = 0;        // monotone recency stamp: higher = more recently inserted/touched

    function find(k) {
        for (let i = 0; i < entries.length; i++) if (svz(entries[i].key, k)) return i;
        return -1;
    }

    /** Lazy TTL (decisions/0017, D17.3): a stale hit is a MISS, reaped in place (no freq
     *  change). Mirrors the real cache exactly. Returns true if it reaped. */
    function reapIfStale(i) {
        if (hasTtl && entries[i].exp <= clock()) { entries.splice(i, 1); return true; }
        return false;
    }

    /** The index of the eviction victim: lowest freq, and within that the least-recent
     *  (smallest `seq`). Returns -1 when empty. */
    function victimIdx() {
        let best = -1;
        for (let i = 0; i < entries.length; i++) {
            if (best < 0) { best = i; continue; }
            const e = entries[i], b = entries[best];
            if (e.freq < b.freq || (e.freq === b.freq && e.seq < b.seq)) best = i;
        }
        return best;
    }

    return {
        get(k) {
            const i = find(k);
            if (i < 0) return undefined;
            if (reapIfStale(i)) return undefined; // stale = MISS, no freq change (D17.3)
            const e = entries[i];
            e.freq += 1;    // exact frequency increment
            e.seq = ++seq;  // become the most-recent at the new frequency (LRU tie-break)
            return e.val;
        },
        put(k, v, ttlMs) {
            const exp = hasTtl ? oracleExpiry(clock, ttl, ttlMs) : undefined;
            const i = find(k);
            if (i >= 0) { // update-in-place COUNTS as a hit (D24)
                const e = entries[i];
                e.val = v; e.exp = exp;
                e.freq += 1;
                e.seq = ++seq;
                return;
            }
            if (entries.length === cap) {
                const vi = victimIdx();
                if (vi >= 0) entries.splice(vi, 1);
            }
            entries.push({ key: k, val: v, freq: 1, exp, seq: ++seq }); // newcomer -> freq 1, MRU
        },
        has(k) { const i = find(k); if (i < 0) return false; return !reapIfStale(i); }, // freq-neutral
        peek(k) { const i = find(k); if (i < 0) return undefined; if (reapIfStale(i)) return undefined; return entries[i].val; },
        delete(k) {
            const i = find(k);
            if (i < 0) return false;
            entries.splice(i, 1);
            return true;
        },
        size() { return entries.length; },
        victim() { const vi = victimIdx(); return vi < 0 ? undefined : entries[vi].key; },
    };
}
