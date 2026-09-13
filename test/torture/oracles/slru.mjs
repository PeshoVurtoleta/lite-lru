/**
 * Brute-force Slru (Segmented LRU) reference oracle -- the differential ground truth
 * for the `Slru` member (decisions/0015).
 *
 * Deliberately a DIFFERENT representation from Lru.js: two plain JS arrays --
 * `probation` (a FIFO of {key,val,visited,exp} nodes, index 0 = OLDEST = the eviction
 * end, push = newest end) and `protectedL` (an LRU, index 0 = LRU = the eviction end,
 * push = MRU end). It shares NO code with the Int32Array SoA implementation, so it can
 * never share a bug. Clarity over speed -- it is the oracle, not the product.
 *
 * Slru semantics mirrored EXACTLY (decisions/0015, D15):
 *   - sizing: protectedCap = round(cap * 0.8); probation holds the rest, total <= cap.
 *   - newcomer -> probation (newest), unvisited.
 *   - get(hit)/put(update): protected -> move to protected MRU; probation -> FIRST hit
 *     sets visited (no reorder, FIFO), SECOND hit clears it and PROMOTES to protected
 *     MRU, demoting protected's LRU back to probation MRU on overflow.
 *   - has/peek: neutral (no visited change, no promotion).
 *   - at capacity a new key evicts the probation OLDEST, or -- only when probation is
 *     empty -- the protected LRU.
 *   - delete removes from whichever segment.
 *   - victim() = the probation oldest, or the protected LRU when probation is empty.
 *
 * SameValueZero key equality (svz) mirrors JS Map, matching the default backing.
 */

import { svz, oracleExpiry } from './lru.mjs';

/**
 * @param {number} cap
 * @param {{ttl?:number, clock?:()=>number}} [opts]  opt-in TTL (decisions/0017)
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeSlruOracle(cap, opts) {
    const protectedCap = Math.round(cap * 0.8);
    const ttl = opts && opts.ttl;
    const clock = (opts && opts.clock) || (() => 0);
    const hasTtl = ttl !== undefined;

    const probation = [];  // probation[0] = oldest (eviction end); push = newest
    const protectedL = []; // protectedL[0] = LRU (eviction end); push = MRU

    /** Locate a key. Returns {list, idx, node} or null. */
    function find(k) {
        for (let i = 0; i < probation.length; i++) if (svz(probation[i].key, k)) return { list: probation, idx: i, node: probation[i] };
        for (let i = 0; i < protectedL.length; i++) if (svz(protectedL[i].key, k)) return { list: protectedL, idx: i, node: protectedL[i] };
        return null;
    }

    /** Lazy TTL (decisions/0017, D17.3): reap a stale node from its segment, mirroring
     *  delete (no visited/promotion change). Returns true if it reaped. */
    function reapIfStale(loc) {
        if (!hasTtl || loc.node.exp > clock()) return false;
        loc.list.splice(loc.idx, 1);
        return true;
    }

    /** Apply the promote-on-2nd-hit rule (mirrors Lru.js `_touch`). */
    function touch(loc) {
        const node = loc.node;
        if (loc.list === protectedL) {
            protectedL.splice(loc.idx, 1);
            protectedL.push(node); // protected MRU
        } else if (!node.visited) {
            node.visited = true;   // first hit: mark, stay in probation (FIFO)
        } else {
            node.visited = false;  // second hit: promote to protected
            probation.splice(loc.idx, 1);
            protectedL.push(node);
            if (protectedL.length > protectedCap) {
                const d = protectedL.shift(); // protected LRU -> demote to probation
                d.visited = false;
                probation.push(d);            // probation MRU (newest end)
            }
        }
    }

    return {
        get(k) {
            const loc = find(k);
            if (loc === null) return undefined;
            if (reapIfStale(loc)) return undefined; // stale = MISS, no promotion (D17.3)
            const val = loc.node.val;
            touch(loc);
            return val;
        },
        put(k, v, ttlMs) {
            const exp = hasTtl ? oracleExpiry(clock, ttl, ttlMs) : undefined;
            const loc = find(k);
            if (loc !== null) { loc.node.val = v; loc.node.exp = exp; touch(loc); return; }
            if (probation.length + protectedL.length === cap) {
                if (probation.length > 0) probation.shift(); // evict probation oldest
                else protectedL.shift();                     // else protected LRU
            }
            probation.push({ key: k, val: v, visited: false, exp }); // newcomer -> probation MRU
        },
        has(k) { const loc = find(k); if (loc === null) return false; return !reapIfStale(loc); },
        peek(k) { const loc = find(k); if (loc === null) return undefined; if (reapIfStale(loc)) return undefined; return loc.node.val; },
        delete(k) {
            for (let i = 0; i < probation.length; i++) if (svz(probation[i].key, k)) { probation.splice(i, 1); return true; }
            for (let i = 0; i < protectedL.length; i++) if (svz(protectedL[i].key, k)) { protectedL.splice(i, 1); return true; }
            return false;
        },
        size() { return probation.length + protectedL.length; },
        victim() {
            if (probation.length + protectedL.length === 0) return undefined;
            return probation.length > 0 ? probation[0].key : protectedL[0].key;
        },
    };
}
