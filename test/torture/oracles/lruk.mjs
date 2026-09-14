/**
 * Brute-force LRU-K reference oracle (LRU-K; O'Neil, O'Neil & Weikum, SIGMOD'93, K=2)
 * -- the differential ground truth for the `LruK` member (decisions/0026, the K=2,
 * no-CRP, keys-only-bounded-history variant D26).
 *
 * Deliberately a DIFFERENT representation from Lru.js: a plain JS `resident` Map of node
 * objects `{key, val, exp, r0, r1, warm}`, a plain `cold` ARRAY in insertion order
 * (cold[0] = oldest = the O(1) eviction end), a plain `hist` FIFO array (index 0 = oldest),
 * and a plain number logical clock `t`. It shares NO code with the Int32Array SoA +
 * Float64 reference-time columns + two intrusive DLLs + typed-ring implementation, so it
 * can never share a bug.
 *
 * LRU-K (K=2) semantics mirrored EXACTLY (decisions/0026, D26):
 *   - a page is COLD until its 2nd reference (r1 at the -Infinity sentinel), then WARM.
 *   - a reference stamps r1 = r0; r0 = ++t. A cold page's 2nd reference promotes it to warm.
 *   - VICTIM: the OLDEST cold page (infinite K-distance -> evicted first, cold[0]); only when
 *     no cold page exists, the WARM page with the smallest r1 (the largest K=2 backward
 *     distance). The clock is strictly monotone so every warm r1 is distinct -> a unique min.
 *   - a new key still in the bounded history is re-admitted WARM at r1 = r0 = ++t (proven >= K
 *     references over time); a brand-new key enters COLD. Resident capacity stays EXACTLY cap.
 *   - has/peek: policy-neutral. delete/reap: unlink, NOT recorded in history. Every EVICTION
 *     records the victim key in the bounded history. victim() reports the key WITHOUT mutating.
 *
 * SameValueZero key equality (svz) mirrors JS Map/Set, matching the default backing.
 */

import { svz, oracleExpiry } from './lru.mjs';

/**
 * @param {number} cap
 * @param {{ttl?:number, clock?:()=>number}} [opts]  opt-in TTL (decisions/0017)
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeLruKOracle(cap, opts) {
    const ttl = opts && opts.ttl;
    const clockFn = (opts && opts.clock) || (() => 0);
    const hasTtl = ttl !== undefined;

    const resident = new Map(); // key -> node {key, val, exp, r0, r1, warm}
    const cold = [];            // cold nodes in insertion order; cold[0] = oldest (victim end)
    const hist = [];            // hist[0] = oldest; bounded to cap (non-resident evicted keys)
    let t = 0;                  // the monotone logical clock

    function histIndex(k) { for (let i = 0; i < hist.length; i++) if (svz(hist[i], k)) return i; return -1; }
    function histAdd(k) { if (hist.length >= cap) hist.shift(); hist.push(k); }

    function coldRemove(node) { const i = cold.indexOf(node); if (i >= 0) cold.splice(i, 1); }

    /** The warm page with the smallest r1 (the largest K=2 backward distance); r1 is unique. */
    function warmVictim() {
        let best = null, bestR1 = Infinity;
        for (const node of resident.values()) {
            if (node.warm && node.r1 < bestR1) { bestR1 = node.r1; best = node; }
        }
        return best;
    }

    /** The node the next over-capacity insert would evict (cold oldest, else min-r1 warm). */
    function victimNode() {
        if (resident.size === 0) return null;
        if (cold.length > 0) return cold[0];
        return warmVictim();
    }

    /** The per-access recency step: slide r1 down, stamp r0, promote a cold page to warm. */
    function access(node) {
        node.r1 = node.r0;
        node.r0 = ++t;
        if (!node.warm) { coldRemove(node); node.warm = true; }
    }

    function reapIfStale(k) {
        const node = resident.get(k);
        if (!hasTtl || node.exp > clockFn()) return false;
        if (!node.warm) coldRemove(node);
        resident.delete(k);
        return true;
    }

    return {
        get(k) {
            const node = resident.get(k);
            if (node === undefined) return undefined;
            if (reapIfStale(k)) return undefined; // stale = MISS, reap in place (D17.3)
            access(node);
            return node.val;
        },
        put(k, v, ttlMs) {
            const exp = hasTtl ? oracleExpiry(clockFn, ttl, ttlMs) : undefined;
            const existing = resident.get(k);
            if (existing !== undefined) { // update-in-place + access policy
                existing.val = v; existing.exp = exp; access(existing);
                return;
            }
            const inHist = histIndex(k) >= 0;
            if (resident.size === cap) {
                const victim = victimNode();
                if (!victim.warm) coldRemove(victim);
                resident.delete(victim.key);
                histAdd(victim.key);
            }
            if (inHist) {
                // The re-admit decision is taken BEFORE the eviction; the eviction's
                // drop-oldest may already have forgotten this key, so the consume is a
                // no-op then (mirrors the member's ArcGhost.consume of an absent key).
                const hi = histIndex(k);
                if (hi >= 0) hist.splice(hi, 1);
            }
            const tt = ++t;
            const node = { key: k, val: v, exp, r0: tt, r1: inHist ? tt : -Infinity, warm: inHist };
            resident.set(k, node);
            if (!inHist) cold.push(node);
        },
        has(k) { if (!resident.has(k)) return false; return !reapIfStale(k); },
        peek(k) {
            const node = resident.get(k);
            if (node === undefined) return undefined;
            if (reapIfStale(k)) return undefined;
            return node.val;
        },
        delete(k) {
            const node = resident.get(k);
            if (node === undefined) return false;
            if (!node.warm) coldRemove(node);
            resident.delete(k);
            return true;
        },
        size() { return resident.size; },
        victim() { const n = victimNode(); return n === null ? undefined : n.key; },
    };
}
