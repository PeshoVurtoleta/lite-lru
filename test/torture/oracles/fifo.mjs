/**
 * The SECOND policy -- a plain FIFO. Its whole job is to PROVE the differential
 * runner is policy-parameterized (DEBATE item 1 = B, the family reframe): the same
 * runner drives it with zero changes, only a different policy object.
 *
 * FIFO semantics (distinct from LRU on purpose):
 *   - get() does NOT promote -- position is fixed at insertion.
 *   - put(existing) updates the value, does NOT reorder.
 *   - at capacity, a new key evicts the OLDEST INSERTED (queue front), not the LRU.
 *
 * Two independent implementations so the differential has teeth:
 *   - makeFifoOracle: brute array in insertion order (front = oldest).
 *   - makeFifoReal:   a genuinely different Map + key-queue implementation.
 * They share no code, so agreement across the fuzz corpus is real evidence.
 *
 * Integer keys only (the seam proof does not need degenerate keys; those live in
 * the classic-LRU T1 tier).
 */

/** Brute FIFO reference: an array in insertion order, front = oldest = next victim. */
export function makeFifoOracle(cap) {
    const order = []; // order[0] is the oldest inserted

    function find(k) {
        for (let i = 0; i < order.length; i++) if (order[i].key === k) return i;
        return -1;
    }

    return {
        get(k) { const i = find(k); return i < 0 ? undefined : order[i].val; }, // no promote
        put(k, v) {
            const i = find(k);
            if (i >= 0) { order[i].val = v; return; } // update in place, no reorder
            if (order.length === cap) order.shift(); // evict oldest
            order.push({ key: k, val: v });
        },
        has(k) { return find(k) >= 0; },
        peek(k) { const i = find(k); return i < 0 ? undefined : order[i].val; },
        delete(k) { const i = find(k); if (i < 0) return false; order.splice(i, 1); return true; },
        size() { return order.length; },
        victim() { return order.length ? order[0].key : undefined; },
    };
}

/** A different real FIFO: a Map for lookup + a key queue for eviction order. */
export function makeFifoReal(cap) {
    const map = new Map();
    const q = []; // keys in insertion order; q[0] is the oldest

    return {
        get(k) { return map.has(k) ? map.get(k) : undefined; }, // no promote
        put(k, v) {
            if (map.has(k)) { map.set(k, v); return; } // update, no reorder
            if (map.size === cap) { const old = q.shift(); map.delete(old); }
            map.set(k, v);
            q.push(k);
        },
        has(k) { return map.has(k); },
        peek(k) { return map.has(k) ? map.get(k) : undefined; },
        delete(k) {
            if (!map.has(k)) return false;
            map.delete(k);
            const i = q.indexOf(k);
            if (i >= 0) q.splice(i, 1);
            return true;
        },
        size() { return map.size; },
        victim() { return q.length ? q[0] : undefined; },
    };
}
