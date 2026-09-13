/**
 * Brute-force TwoQ (full 2Q, Johnson & Shasha VLDB'94) reference oracle -- the
 * differential ground truth for the `TwoQ` member (decisions/0015).
 *
 * Deliberately a DIFFERENT representation from Lru.js: three plain JS arrays -- `a1in`
 * (a FIFO of {key,val,exp} nodes, index 0 = OLDEST = eviction end, push = newest), `am`
 * (an LRU, index 0 = LRU = eviction end, push = MRU), and `ghost` (A1out: keys only,
 * index 0 = oldest, push = newest, bounded to ghostCap). It shares NO code with the
 * Int32Array SoA + typed-ring implementation, so it can never share a bug.
 *
 * 2Q semantics mirrored EXACTLY (decisions/0015, D15):
 *   - sizing: a1inCap = max(1, round(cap*0.25)); amCap = cap - a1inCap; ghostCap = amCap.
 *   - get(hit): A1in -> nothing (pure FIFO probation); Am -> move to Am MRU.
 *   - put(update): A1in -> value only, no reorder; Am -> value + move to Am MRU.
 *   - put(new): if key in ghost -> admit to Am (consume ghost); else -> A1in. At
 *     capacity, run ONE reclaim step first: if A1in is over its target (len > a1inCap)
 *     OR Am is empty, evict A1in oldest + record its key in ghost; else evict Am LRU
 *     (NOT ghosted). Admission uses the ghost state AT ARRIVAL.
 *   - has/peek: neutral. delete removes from whichever queue, NOT ghosted.
 *   - victim() = the A1in oldest (when A1in over target or Am empty) else the Am LRU.
 *
 * SameValueZero key equality (svz) mirrors JS Map/Set, matching the default backing.
 */

import { svz, oracleExpiry } from './lru.mjs';

/**
 * @param {number} cap
 * @param {{ttl?:number, clock?:()=>number}} [opts]  opt-in TTL (decisions/0017)
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeTwoQOracle(cap, opts) {
    const a1inCap = Math.max(1, Math.round(cap * 0.25));
    const amCap = cap - a1inCap;
    const ghostCap = amCap;
    const ttl = opts && opts.ttl;
    const clock = (opts && opts.clock) || (() => 0);
    const hasTtl = ttl !== undefined;

    const a1in = [];  // a1in[0] = oldest (eviction end); push = newest
    const am = [];    // am[0]   = LRU (eviction end);    push = MRU
    const ghost = []; // ghost[0] = oldest key;           push = newest

    function findIn(list, k) {
        for (let i = 0; i < list.length; i++) if (svz(list[i].key, k)) return i;
        return -1;
    }
    /** Locate a key across the two resident queues. Returns {list, idx, node} or null. */
    function find(k) {
        let i = findIn(a1in, k);
        if (i >= 0) return { list: a1in, idx: i, node: a1in[i] };
        i = findIn(am, k);
        if (i >= 0) return { list: am, idx: i, node: am[i] };
        return null;
    }

    /** Lazy TTL (decisions/0017, D17.3): reap a stale node from its queue, mirroring
     *  delete (NOT ghosted). Returns true if it reaped. */
    function reapIfStale(loc) {
        if (!hasTtl || loc.node.exp > clock()) return false;
        loc.list.splice(loc.idx, 1);
        return true;
    }

    function ghostIndex(k) {
        for (let i = 0; i < ghost.length; i++) if (svz(ghost[i], k)) return i;
        return -1;
    }
    function ghostAdd(k) {
        if (ghostCap === 0) return;
        if (ghost.length === ghostCap) ghost.shift();
        ghost.push(k);
    }
    function ghostRemove(k) {
        const i = ghostIndex(k);
        if (i >= 0) ghost.splice(i, 1);
    }

    /** One reclaim step over the LIVE queues (mutating). Only called at capacity. */
    function evictStep() {
        if (a1in.length > a1inCap || am.length === 0) {
            const t = a1in.shift(); // A1in oldest -> ghost
            ghostAdd(t.key);
        } else {
            am.shift(); // Am LRU (NOT ghosted)
        }
    }

    return {
        get(k) {
            const loc = find(k);
            if (loc === null) return undefined;
            if (reapIfStale(loc)) return undefined; // stale = MISS (D17.3)
            if (loc.list === am) { am.splice(loc.idx, 1); am.push(loc.node); } // Am -> MRU
            // A1in hit: nothing.
            return loc.node.val;
        },
        put(k, v, ttlMs) {
            const exp = hasTtl ? oracleExpiry(clock, ttl, ttlMs) : undefined;
            const loc = find(k);
            if (loc !== null) {
                loc.node.val = v; loc.node.exp = exp;
                if (loc.list === am) { am.splice(loc.idx, 1); am.push(loc.node); } // Am update -> MRU
                return;
            }
            const toMain = ghostIndex(k) >= 0;
            if (toMain) ghostRemove(k);
            if (a1in.length + am.length === cap) evictStep();
            const entry = { key: k, val: v, exp };
            if (toMain) am.push(entry); else a1in.push(entry);
        },
        has(k) { const loc = find(k); if (loc === null) return false; return !reapIfStale(loc); },
        peek(k) { const loc = find(k); if (loc === null) return undefined; if (reapIfStale(loc)) return undefined; return loc.node.val; },
        delete(k) {
            let i = findIn(a1in, k);
            if (i >= 0) { a1in.splice(i, 1); return true; }
            i = findIn(am, k);
            if (i >= 0) { am.splice(i, 1); return true; }
            return false;
        },
        size() { return a1in.length + am.length; },
        victim() {
            if (a1in.length + am.length === 0) return undefined;
            if (a1in.length > a1inCap || am.length === 0) return a1in[0].key;
            return am[0].key;
        },
    };
}
