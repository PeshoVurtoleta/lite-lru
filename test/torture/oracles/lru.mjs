/**
 * Brute-force LRU reference oracle -- the differential ground truth.
 *
 * Deliberately the DUMB implementation: an array in recency order (index 0 = MRU,
 * last = LRU) with O(n) linear scans. It shares NO code with Lru.js, so it can
 * never share a bug. Clarity over speed -- it is the oracle, not the product.
 *
 * SameValueZero key equality (svz) mirrors JS Map: NaN matches NaN; -0 matches 0.
 * The uniform driver surface (get/put/delete/has/peek/size/victim) is exactly the
 * one the parameterized runner drives against the real cache.
 */

/** SameValueZero: === except NaN equals NaN (a!==a is true only for NaN). */
export function svz(a, b) {
    return a === b || (a !== a && b !== b);
}

/**
 * TTL expiry timestamp for an oracle put (decisions/0017), mirroring Lru.js
 * `expiryFor` EXACTLY so the lazy rule stays in lockstep: `ttlMs` omitted -> the
 * instance default `ttl`; `Infinity` -> never; else `clock() + ttlMs`. Only called
 * when the oracle was built with a ttl.
 */
export function oracleExpiry(clock, ttl, ttlMs) {
    if (ttlMs === undefined) return ttl === Infinity ? Infinity : clock() + ttl;
    if (ttlMs === Infinity) return Infinity;
    return clock() + ttlMs;
}

/**
 * @param {number} cap
 * @param {{ttl?:number, clock?:()=>number}} [opts]  opt-in TTL (decisions/0017)
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeLruOracle(cap, opts) {
    // order[0] is MOST recently used; order[order.length-1] is the LRU (next victim).
    const order = [];
    const ttl = opts && opts.ttl;
    const clock = (opts && opts.clock) || (() => 0);
    const hasTtl = ttl !== undefined;

    function find(k) {
        for (let i = 0; i < order.length; i++) if (svz(order[i].key, k)) return i;
        return -1;
    }
    /** Lazy TTL (decisions/0017, D17.3): a stale hit is a MISS and is reaped in place
     *  (no promotion). Mirrors the real cache exactly. Returns true if it reaped. */
    function reapIfStale(i) {
        if (hasTtl && order[i].exp <= clock()) { order.splice(i, 1); return true; }
        return false;
    }

    return {
        get(k) {
            const i = find(k);
            if (i < 0) return undefined;
            if (reapIfStale(i)) return undefined;
            const e = order[i];
            order.splice(i, 1);
            order.unshift(e); // promote to MRU
            return e.val;
        },
        put(k, v, ttlMs) {
            const exp = hasTtl ? oracleExpiry(clock, ttl, ttlMs) : undefined;
            const i = find(k);
            if (i >= 0) { // update + promote
                order.splice(i, 1);
                order.unshift({ key: k, val: v, exp });
                return;
            }
            if (order.length === cap) order.pop(); // evict LRU
            order.unshift({ key: k, val: v, exp });
        },
        has(k) { const i = find(k); if (i < 0) return false; return !reapIfStale(i); }, // recency-neutral
        peek(k) { const i = find(k); if (i < 0) return undefined; if (reapIfStale(i)) return undefined; return order[i].val; },
        delete(k) {
            const i = find(k);
            if (i < 0) return false;
            order.splice(i, 1);
            return true;
        },
        size() { return order.length; },
        victim() { return order.length ? order[order.length - 1].key : undefined; },
    };
}
