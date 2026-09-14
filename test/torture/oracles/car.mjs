/**
 * Brute-force CAR reference oracle (CAR, Clock with Adaptive Replacement; Bansal & Modha,
 * USENIX FAST'04) -- the differential ground truth for the `Car` member (decisions/0028).
 *
 * Deliberately a DIFFERENT representation from Lru.js: two plain JS ARRAYS of page nodes
 * `{key, val, exp, ref}` in clock order (index 0 = head/newest .. last = tail/oldest) for the
 * two clocks T1 (recent) and T2 (frequent), with the two hands kept as plain ARRAY INDICES
 * (hand1/hand2), a `resident` Map for O(1) lookup, an integer `p`, and two bounded keys-only
 * ghost FIFO arrays b1 (cap c) / b2 (cap 2c) (index 0 = oldest). It shares NO code with the
 * Int32Array SoA + wrap-around-DLL + open-addressed-ring implementation, so it can never share
 * a bug. The per-page reference bit mirrors Lru.js `_st` bit0; the inT2 tag is the array a node
 * lives in.
 *
 * CAR semantics mirrored EXACTLY (decisions/0028, D28):
 *   - TWO circular clocks; a hit (get / put-update) sets the reference bit ONLY (no move).
 *   - REPLACE: from the T1 hand (when |T1| >= max(1,p)) or the T2 hand, a REFERENCED page has
 *     its ref bit cleared and MIGRATES to the T2 MRU (a T1 survivor) or rotates within T2 (a
 *     T2 survivor); the first UNREFERENCED page found is the victim -> b1 (from T1) or b2 (from
 *     T2). Amortized O(1); worst-case O(capacity).
 *   - a true miss enters T1 (recent, ref 0); a miss in b1 raises p and re-admits to T2, in b2
 *     lowers p and re-admits to T2 (ghost consumed). At capacity REPLACE evicts first, then the
 *     ghost directory is trimmed (drop b1 LRU when |T1|+|B1|==c, else drop b2 LRU when the
 *     directory total is 2c) -- and the SAME trim runs below capacity (delete-induced) before a
 *     new non-ghost T1 entry grows the directory. Resident capacity stays EXACTLY cap (D28.4).
 *   - has/peek: reference-neutral. delete: unlink, NOT ghosted, p unchanged. victim() replays
 *     the sweep on a CLONE (non-destructive) and returns the key it would evict.
 *
 * SameValueZero key equality (svz) mirrors JS Map/Set, matching the default backing.
 */

import { svz, oracleExpiry } from './lru.mjs';

const REF = 1; // per-node reference bit (mirrors CAR_REF)

/**
 * @param {number} cap
 * @param {{ttl?:number, clock?:()=>number}} [opts]  opt-in TTL (decisions/0017)
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeCarOracle(cap, opts) {
    const ttl = opts && opts.ttl;
    const clockFn = (opts && opts.clock) || (() => 0);
    const hasTtl = ttl !== undefined;

    const resident = new Map(); // key -> node {key, val, exp, ref}
    const t1 = []; // t1[0] = head (newest) .. last = tail (oldest)
    const t2 = [];
    let hand1 = -1, hand2 = -1;
    const b1 = []; // b1[0] = oldest key; push = newest. cap c.
    const b2 = []; // b2[0] = oldest key; push = newest. cap 2c.
    let p = 0;

    function ghostIndex(g, k) { for (let i = 0; i < g.length; i++) if (svz(g[i], k)) return i; return -1; }

    /** The hand index after removing the element at index h (the hand WAS at h) from an array
     *  that HAD length `len`: -1 if it emptied, 0 if h was the tail (wrap), else h (unchanged). */
    function succAfter(len, h) { return len === 1 ? -1 : (h === len - 1 ? 0 : h); }

    /**
     * Replay the REPLACE sweep on {t1, t2, hand1, hand2} (mutating: migrations physically move
     * nodes to t2 front and REMOVE the victim, repairing the hands). Returns {from, node}. `p`
     * is read from the closure. Used committed (on the real arrays) and non-destructively (on a
     * clone) by victim().
     */
    function sweep(st) {
        const pTarget = p > 1 ? p : 1; // max(1, p)
        for (;;) {
            // Branch to a clock, defensively total: prefer T1 when |T1| >= max(1,p), but a
            // referenced-only sweep can drain a clock -- always fall back to the non-empty one.
            let takeT1 = st.t1.length >= pTarget;
            if (st.t1.length === 0) takeT1 = false;
            else if (st.t2.length === 0) takeT1 = true;
            if (takeT1) {
                const h = st.hand1;
                const node = st.t1[h];
                if ((node.ref & REF) === 0) {
                    st.hand1 = succAfter(st.t1.length, h);
                    st.t1.splice(h, 1);
                    return { from: 't1', node };
                }
                node.ref = 0;
                const succ = succAfter(st.t1.length, h);
                const moved = st.t1.splice(h, 1)[0];
                st.hand1 = succ;
                st.t2.unshift(moved);
                if (st.hand2 >= 0) st.hand2++;
                if (st.t2.length === 1) st.hand2 = 0;
                continue;
            }
            const h = st.hand2;
            const node = st.t2[h];
            if ((node.ref & REF) === 0) {
                st.hand2 = succAfter(st.t2.length, h);
                st.t2.splice(h, 1);
                return { from: 't2', node };
            }
            node.ref = 0;
            st.hand2 = (h + 1) % st.t2.length;
        }
    }

    /** REPLACE on the committed state: evict one resident to a ghost. Returns nothing (the
     *  caller has already computed sizes it needs). */
    function replace() {
        const st = { t1, t2, hand1, hand2 };
        const r = sweep(st);
        hand1 = st.hand1; hand2 = st.hand2; // sweep mutated copies of the indices
        resident.delete(r.node.key);
        if (r.from === 't1') b1.push(r.node.key); else b2.push(r.node.key);
    }

    /** Insert a fresh node at the head (MRU) of a clock, tracking the hand index. */
    function insertHead(arr, node, isT1) {
        arr.unshift(node);
        if (isT1) { if (hand1 >= 0) hand1++; if (arr.length === 1) hand1 = 0; }
        else { if (hand2 >= 0) hand2++; if (arr.length === 1) hand2 = 0; }
    }

    /** Lazy TTL (decisions/0017, D17.3): reap a stale node from its clock (no promotion, no
     *  ghost, no p change) -- mirrors delete. Returns true if it reaped. */
    function reapIfStale(k) {
        const node = resident.get(k);
        if (!hasTtl || node.exp > clockFn()) return false;
        removeNode(node);
        resident.delete(k);
        return true;
    }

    /** Remove a resident node from whichever clock it is in, repairing the hand parked on it. */
    function removeNode(node) {
        let arr, hName;
        const i1 = t1.indexOf(node);
        if (i1 >= 0) { arr = t1; hName = 1; splice(arr, i1, hName); return; }
        const i2 = t2.indexOf(node);
        splice(t2, i2, 2);
    }
    function splice(arr, i, which) {
        const hand = which === 1 ? hand1 : hand2;
        let nh = hand;
        if (hand === i) nh = succAfter(arr.length, i);
        else if (hand > i) nh = hand - 1;
        arr.splice(i, 1);
        if (which === 1) hand1 = nh; else hand2 = nh;
    }

    return {
        get(k) {
            const node = resident.get(k);
            if (node === undefined) return undefined;
            if (reapIfStale(k)) return undefined; // stale = MISS, reap in place (D17.3)
            node.ref |= REF; // the whole hot path: set the reference bit
            return node.val;
        },
        put(k, v, ttlMs) {
            const exp = hasTtl ? oracleExpiry(clockFn, ttl, ttlMs) : undefined;
            const existing = resident.get(k);
            if (existing !== undefined) { existing.val = v; existing.exp = exp; existing.ref |= REF; return; }

            const iB1 = ghostIndex(b1, k);
            const iB2 = iB1 >= 0 ? -1 : ghostIndex(b2, k);
            const inGhost = iB1 >= 0 || iB2 >= 0;

            if (resident.size === cap) {
                replace();
                if (!inGhost) {
                    if (t1.length + b1.length === cap && b1.length > 0) b1.shift();
                    else if (t1.length + t2.length + b1.length + b2.length === 2 * cap && b2.length > 0) b2.shift();
                }
            } else {
                if (!inGhost) {
                    if (t1.length + b1.length === cap && b1.length > 0) b1.shift();
                    else if (t1.length + t2.length + b1.length + b2.length === 2 * cap && b2.length > 0) b2.shift();
                }
            }

            const node = { key: k, val: v, exp, ref: 0 };
            resident.set(k, node);
            if (iB1 >= 0) {
                let d = Math.floor(b2.length / b1.length); if (d < 1) d = 1;
                p = Math.min(p + d, cap);
                b1.splice(iB1, 1);
                insertHead(t2, node, false);
            } else if (iB2 >= 0) {
                let d = Math.floor(b1.length / b2.length); if (d < 1) d = 1;
                p = Math.max(p - d, 0);
                b2.splice(iB2, 1);
                insertHead(t2, node, false);
            } else {
                insertHead(t1, node, true);
            }
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
            removeNode(node);
            resident.delete(k);
            return true;
        },
        size() { return resident.size; },
        victim() {
            if (resident.size === 0) return undefined;
            const c1 = t1.map((n) => ({ key: n.key, ref: n.ref }));
            const c2 = t2.map((n) => ({ key: n.key, ref: n.ref }));
            const st = { t1: c1, t2: c2, hand1, hand2 };
            const r = sweep(st);
            return r.node.key;
        },
    };
}
