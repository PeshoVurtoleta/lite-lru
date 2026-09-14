/**
 * Brute-force Multi-Queue reference oracle (MQ; Zhou, Philbin & Li, USENIX ATC'01,
 * m = 8) -- the differential ground truth for the `Mq` member (decisions/0027, D27).
 *
 * Deliberately a DIFFERENT representation from Lru.js: a plain JS `resident` Map of node
 * objects `{key, val, exp, rc, exq, qn}`, a plain ARRAY per band `queues[0..7]` holding
 * its nodes in HEAD..TAIL order (index 0 = MRU, last = LRU = the O(1) eviction end), a
 * plain `hist` FIFO array of `{key, rc}` (index 0 = oldest), and a plain number logical
 * clock `t`. It shares NO code with the Int32Array SoA + Float64 columns + 8 intrusive
 * DLLs + typed-ring implementation, so it can never share a bug.
 *
 * MQ semantics mirrored EXACTLY (decisions/0027, D27):
 *   - band(rc) = min(floor(log2(rc)), 7) = the highest set bit of rc, saturating to 7 for
 *     rc >= 128 (D27.3).
 *   - a reference (get hit / put update / insert) bumps the logical clock, increments the
 *     block's rc, re-bands it, moves it to the MRU (head) of its band, stamps its logical
 *     expire time exq = t + lifeTime (lifeTime = capacity, D27.2), then runs the FIXED
 *     m-1 = 7-step aging sweep: for each band Q1..Q7 ascending, demote its LRU (tail) IF
 *     expired (exq < t) to the HEAD of the band below, resetting exq (D27.6, no cascade).
 *   - VICTIM: the LRU (tail) of the LOWEST non-empty queue (D27.4).
 *   - a new key still in the bounded Qout history is re-admitted at its remembered rc + 1
 *     (the insert is a reference); a brand-new key enters at rc = 1 (band Q0). Resident
 *     capacity stays EXACTLY cap. Every EVICTION records the victim key + its rc in Qout.
 *   - has/peek: policy-neutral. delete/reap: unlink, NOT recorded in Qout. victim() reports
 *     the key WITHOUT mutating.
 *
 * SameValueZero key equality (svz) mirrors JS Map/Set, matching the default backing.
 */

import { svz, oracleExpiry } from './lru.mjs';

const M = 8;

/** band(rc) = min(floor(log2(rc)), 7), saturating to 7 for rc >= 128 (D27.3). */
function band(rc) { return rc >= 128 ? 7 : (31 - Math.clz32(rc)); }

/**
 * @param {number} cap
 * @param {{ttl?:number, clock?:()=>number}} [opts]  opt-in TTL (decisions/0017)
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeMqOracle(cap, opts) {
    const ttl = opts && opts.ttl;
    const clockFn = (opts && opts.clock) || (() => 0);
    const hasTtl = ttl !== undefined;

    const resident = new Map(); // key -> node {key, val, exp, rc, exq, qn}
    const queues = [];          // queues[q] = nodes in HEAD..TAIL order (index 0 = MRU)
    for (let q = 0; q < M; q++) queues.push([]);
    const hist = [];            // hist[0] = oldest; {key, rc}; bounded to cap
    let t = 0;                  // the monotone logical clock

    function histIndex(k) { for (let i = 0; i < hist.length; i++) if (svz(hist[i].key, k)) return i; return -1; }
    function histAdd(k, rc) { if (hist.length >= cap) hist.shift(); hist.push({ key: k, rc }); }

    function removeFromQueue(node) {
        const cur = queues[node.qn];
        const i = cur.indexOf(node);
        if (i >= 0) cur.splice(i, 1);
    }

    /** The FIXED 7-step aging sweep: demote each band's expired tail to the head of the band
     *  below (Q1..Q7 ascending; reset-on-demote forbids cascade). */
    function ageSweep() {
        for (let q = 1; q < M; q++) {
            const cur = queues[q];
            if (cur.length === 0) continue;
            const tail = cur[cur.length - 1];
            if (tail.exq < t) {
                cur.pop();
                tail.qn = q - 1;
                tail.exq = t + cap;
                queues[q - 1].unshift(tail);
            }
        }
    }

    /** The per-access recency + aging step for a RESIDENT node. */
    function access(node) {
        t++;
        node.rc++;
        const q = band(node.rc);
        removeFromQueue(node);
        node.qn = q;
        node.exq = t + cap;
        queues[q].unshift(node); // MRU head
        ageSweep();
    }

    /** The node the next over-capacity insert would evict (tail of the lowest non-empty queue). */
    function victimNode() {
        for (let q = 0; q < M; q++) {
            const cur = queues[q];
            if (cur.length > 0) return cur[cur.length - 1];
        }
        return null;
    }

    function reapIfStale(k) {
        const node = resident.get(k);
        if (!hasTtl || node.exp > clockFn()) return false;
        removeFromQueue(node);
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
            const hi0 = histIndex(k);
            const inHist = hi0 >= 0;
            const savedRc = inHist ? hist[hi0].rc : 0; // read BEFORE the evict may drop it
            if (resident.size === cap) {
                const victim = victimNode();
                removeFromQueue(victim);
                resident.delete(victim.key);
                histAdd(victim.key, victim.rc);
            }
            if (inHist) {
                // The evict's drop-oldest may already have forgotten this key, so re-find it;
                // an absent key is a no-op (mirrors MqHistory.consume of an absent key).
                const hi = histIndex(k);
                if (hi >= 0) hist.splice(hi, 1);
            }
            t++;
            const rc = savedRc + 1;
            const q = band(rc);
            const node = { key: k, val: v, exp, rc, exq: t + cap, qn: q };
            resident.set(k, node);
            queues[q].unshift(node);
            ageSweep();
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
            removeFromQueue(node);
            resident.delete(k);
            return true;
        },
        size() { return resident.size; },
        victim() { const n = victimNode(); return n === null ? undefined : n.key; },
    };
}
