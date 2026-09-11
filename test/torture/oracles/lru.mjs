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
 * @param {number} cap
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeLruOracle(cap) {
    // order[0] is MOST recently used; order[order.length-1] is the LRU (next victim).
    const order = [];

    function find(k) {
        for (let i = 0; i < order.length; i++) if (svz(order[i].key, k)) return i;
        return -1;
    }

    return {
        get(k) {
            const i = find(k);
            if (i < 0) return undefined;
            const e = order[i];
            order.splice(i, 1);
            order.unshift(e); // promote to MRU
            return e.val;
        },
        put(k, v) {
            const i = find(k);
            if (i >= 0) { // update + promote
                order.splice(i, 1);
                order.unshift({ key: k, val: v });
                return;
            }
            if (order.length === cap) order.pop(); // evict LRU
            order.unshift({ key: k, val: v });
        },
        has(k) { return find(k) >= 0; }, // recency-neutral
        peek(k) { const i = find(k); return i < 0 ? undefined : order[i].val; }, // recency-neutral
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
