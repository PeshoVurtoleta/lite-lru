/**
 * Brute-force ARC (Adaptive Replacement Cache, Megiddo & Modha FAST'03) reference
 * oracle -- the differential ground truth for the `Arc` member (decisions/0016).
 *
 * Deliberately a DIFFERENT representation from Lru.js: four plain JS arrays -- `t1`
 * (recent, {key,val,exp} nodes; index 0 = LRU = eviction end, push = MRU), `t2`
 * (frequent, same convention), `b1` (recent ghost: keys only, index 0 = oldest, push =
 * newest), `b2` (frequent ghost, same) -- plus an integer `p`. It shares NO code with
 * the Int32Array SoA + typed-ring implementation, so it can never share a bug.
 *
 * ARC semantics mirrored EXACTLY (decisions/0016, D16), bounded realization:
 *   - resident |t1|+|t2| <= c; ghosts bounded so |b1|+|b2| <= c and |t1|+|b1| <= c.
 *   - get(hit)/put(update): promote to T2 MRU (ARC promotes any hit to frequent).
 *   - put(new) in b1: p = min(p + max(1, floor(|b2|/|b1|)), c); consume from b1; if full,
 *     REPLACE(false); insert at T2 MRU. In b2: p = max(p - max(1, floor(|b1|/|b2|)), 0);
 *     consume from b2; if full, REPLACE(true); insert at T2 MRU. Else (true miss): if
 *     |t1|==c evict t1 LRU directly (no ghost); else drop b1 LRU when |t1|+|b1|==c and
 *     REPLACE(false) if full; insert at T1 MRU.
 *   - REPLACE(xInB2): evict t1 LRU -> b1 when |t1|>=1 and (|t1|>p or (xInB2 and |t1|==p));
 *     else evict t2 LRU -> b2. Defensively total (empty list -> take the other). A ghost
 *     add first ensures combined room (drop the larger ghost's LRU; ties -> b1).
 *   - has/peek: neutral. delete removes from whichever list, NOT ghosted, p unchanged.
 *   - victim() mirrors REPLACE(false): |t1|>=1 and |t1|>p -> t1 LRU, else t2 LRU (with the
 *     same empty-list fallbacks) -- a single deterministic prediction.
 *
 * SameValueZero key equality (svz) mirrors JS Map/Set, matching the default backing.
 */

import { svz, oracleExpiry } from './lru.mjs';

/**
 * @param {number} cap
 * @param {{ttl?:number, clock?:()=>number}} [opts]  opt-in TTL (decisions/0017)
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeArcOracle(cap, opts) {
    const ttl = opts && opts.ttl;
    const clock = (opts && opts.clock) || (() => 0);
    const hasTtl = ttl !== undefined;

    const t1 = []; // t1[0] = LRU (eviction end); push = MRU
    const t2 = []; // t2[0] = LRU (eviction end); push = MRU
    const b1 = []; // b1[0] = oldest key;          push = newest
    const b2 = []; // b2[0] = oldest key;          push = newest
    let p = 0;

    /** Locate a resident key. Returns {list, idx, node} or null. */
    function find(k) {
        for (let i = 0; i < t1.length; i++) if (svz(t1[i].key, k)) return { list: t1, idx: i, node: t1[i] };
        for (let i = 0; i < t2.length; i++) if (svz(t2[i].key, k)) return { list: t2, idx: i, node: t2[i] };
        return null;
    }

    /** Lazy TTL (decisions/0017, D17.3): reap a stale node from its list (no promotion, no
     *  ghost, no p change) -- mirrors delete. Returns true if it reaped. */
    function reapIfStale(loc) {
        if (!hasTtl || loc.node.exp > clock()) return false;
        loc.list.splice(loc.idx, 1);
        return true;
    }

    function ghostIndex(g, k) {
        for (let i = 0; i < g.length; i++) if (svz(g[i], k)) return i;
        return -1;
    }

    /** Ensure combined ghost room (|b1|+|b2| < c): drop the larger ghost's LRU (ties b1). */
    function ghostRoom() {
        if (b1.length + b2.length < cap) return;
        if (b1.length >= b2.length && b1.length > 0) b1.shift();
        else if (b2.length > 0) b2.shift();
        else if (b1.length > 0) b1.shift();
    }

    /** Promote a resident hit to T2 MRU. */
    function touchToT2(loc) {
        loc.list.splice(loc.idx, 1);
        t2.push(loc.node);
    }

    /** REPLACE(xInB2) (D16.4): evict exactly one resident to a ghost. */
    function replace(xInB2) {
        let evictT1 = t1.length >= 1 && (t1.length > p || (xInB2 && t1.length === p));
        if (!evictT1 && t2.length === 0) evictT1 = true;
        if (evictT1 && t1.length === 0) evictT1 = false;
        if (evictT1) {
            const node = t1.shift();
            ghostRoom();
            b1.push(node.key);
        } else {
            const node = t2.shift();
            ghostRoom();
            b2.push(node.key);
        }
    }

    return {
        get(k) {
            const loc = find(k);
            if (loc === null) return undefined;
            if (reapIfStale(loc)) return undefined; // stale = MISS (D17.3)
            const val = loc.node.val;
            touchToT2(loc);
            return val;
        },
        put(k, v, ttlMs) {
            const exp = hasTtl ? oracleExpiry(clock, ttl, ttlMs) : undefined;
            const loc = find(k);
            if (loc !== null) { loc.node.val = v; loc.node.exp = exp; touchToT2(loc); return; }
            const iB1 = ghostIndex(b1, k);
            const iB2 = iB1 >= 0 ? -1 : ghostIndex(b2, k);
            if (iB1 >= 0) {
                let d = Math.floor(b2.length / b1.length); if (d < 1) d = 1;
                p = Math.min(p + d, cap);
                b1.splice(iB1, 1);
                if (t1.length + t2.length === cap) replace(false);
                t2.push({ key: k, val: v, exp });
            } else if (iB2 >= 0) {
                let d = Math.floor(b1.length / b2.length); if (d < 1) d = 1;
                p = Math.max(p - d, 0);
                b2.splice(iB2, 1);
                if (t1.length + t2.length === cap) replace(true);
                t2.push({ key: k, val: v, exp });
            } else {
                if (t1.length === cap) {
                    t1.shift(); // direct evict, no ghost (D16.4)
                } else {
                    if (t1.length + b1.length === cap) b1.shift();
                    if (t1.length + t2.length === cap) replace(false);
                }
                t1.push({ key: k, val: v, exp });
            }
        },
        has(k) { const loc = find(k); if (loc === null) return false; return !reapIfStale(loc); },
        peek(k) { const loc = find(k); if (loc === null) return undefined; if (reapIfStale(loc)) return undefined; return loc.node.val; },
        delete(k) {
            for (let i = 0; i < t1.length; i++) if (svz(t1[i].key, k)) { t1.splice(i, 1); return true; }
            for (let i = 0; i < t2.length; i++) if (svz(t2[i].key, k)) { t2.splice(i, 1); return true; }
            return false;
        },
        size() { return t1.length + t2.length; },
        victim() {
            if (t1.length + t2.length === 0) return undefined;
            let evictT1 = t1.length >= 1 && t1.length > p;
            if (!evictT1 && t2.length === 0) evictT1 = true;
            if (evictT1 && t1.length === 0) evictT1 = false;
            return evictT1 ? t1[0].key : t2[0].key;
        },
    };
}
