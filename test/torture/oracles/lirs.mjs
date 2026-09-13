/**
 * Brute-force LIRS reference oracle (Low Inter-reference Recency Set; Jiang & Zhang
 * SIGMETRICS'02) -- the differential ground truth for the `Lirs` member
 * (decisions/0023, the BOUNDED-history variant D23).
 *
 * Deliberately a DIFFERENT representation from Lru.js: plain JS arrays of {key,val,exp}
 * / key nodes -- `S` (the stack: index 0 = bottom/LRU, push = top/MRU; resident-in-S
 * only), `Q` (resident HIR eviction order: index 0 = front/oldest, push = tail), a
 * `resident` Map, and a bounded `hist` FIFO array (index 0 = oldest). It shares NO code
 * with the Int32Array SoA + typed-ring implementation, so it can never share a bug.
 *
 * BOUNDED-LIRS semantics mirrored EXACTLY (D23):
 *   - resident split L_hir = max(1, round(cap*0.01)), L_lir = cap - L_hir; |LIR| +
 *     |resident HIR| == size <= cap; the non-resident `hist` is bounded to cap (drop
 *     OLDEST) and STANDS IN for the non-resident portion of the stack S ("still in S"
 *     iff still in hist).
 *   - LIR hit: move to top of S; if it was the bottom, prune.
 *   - resident-HIR hit: move to top of S; if it was IN S -> reclassify to LIR (demote the
 *     bottom LIR to Q, prune); else stay HIR and move to Q's tail.
 *   - insert (new key): free a slot by evicting Q's front (a resident HIR -> non-resident;
 *     if it was in S its key enters hist). Then if the key is a non-resident HIR still in
 *     hist -> admit as LIR (demote bottom LIR, prune); else if the LIR set is still filling
 *     -> admit as LIR; else admit as a new resident HIR (top of S + tail of Q).
 *   - has/peek: neutral. delete: unlink, NOT ghosted. victim() = Q's front key.
 *
 * SameValueZero key equality (svz) mirrors JS Map/Set, matching the default backing.
 */

import { svz, oracleExpiry } from './lru.mjs';

/**
 * @param {number} cap
 * @param {{ttl?:number, clock?:()=>number}} [opts]  opt-in TTL (decisions/0017)
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeLirsOracle(cap, opts) {
    const ttl = opts && opts.ttl;
    const clock = (opts && opts.clock) || (() => 0);
    const hasTtl = ttl !== undefined;

    const Lhir = Math.max(1, Math.round(cap * 0.01));
    const Llir = cap - Lhir;

    const resident = new Map(); // key -> {key, val, exp, lir, inS}
    const S = [];               // S[0] = bottom (LRU), S[last] = top (MRU); resident-in-S keys
    const Q = [];               // Q[0] = front (oldest/evict), Q[last] = tail; resident HIR keys
    const hist = [];            // hist[0] = oldest; bounded to cap (non-resident HIR keys)
    let lirCount = 0;

    function sIndex(k) { for (let i = 0; i < S.length; i++) if (svz(S[i], k)) return i; return -1; }
    function qIndex(k) { for (let i = 0; i < Q.length; i++) if (svz(Q[i], k)) return i; return -1; }
    function histIndex(k) { for (let i = 0; i < hist.length; i++) if (svz(hist[i], k)) return i; return -1; }

    function sRemove(k) { const i = sIndex(k); if (i >= 0) S.splice(i, 1); }
    function qRemove(k) { const i = qIndex(k); if (i >= 0) Q.splice(i, 1); }
    function histRemove(k) { const i = histIndex(k); if (i >= 0) hist.splice(i, 1); }

    function histAdd(k) { if (hist.length >= cap) hist.shift(); hist.push(k); }

    /** Drop HIR from the bottom of S until the bottom is a LIR (or S empty). */
    function prune() {
        while (S.length > 0) {
            const b = resident.get(S[0]);
            if (b.lir) break;
            b.inS = false;
            S.shift();
        }
    }

    /** Demote the bottom LIR of S to a resident HIR (onto Q's tail), then prune. */
    function demoteBottomLir() {
        const bKey = S[0];              // the invariant keeps this a LIR
        const b = resident.get(bKey);
        S.shift();
        b.inS = false;
        b.lir = false;
        lirCount--;
        Q.push(bKey);
        prune();
    }

    function promoteToLir(k) {
        qRemove(k);
        const node = resident.get(k);
        node.lir = true;               // inS already true (caller moved it to top)
        lirCount++;
        if (lirCount > Llir) demoteBottomLir();
    }

    /** The access policy for a resident key (get hit / put update). */
    function access(k) {
        const node = resident.get(k);
        if (node.lir) {
            if (svz(S[S.length - 1], k)) return; // already the top
            const wasBottom = svz(S[0], k);
            sRemove(k); S.push(k);
            if (wasBottom) prune();
        } else {
            const inSbefore = node.inS;
            sRemove(k); S.push(k); node.inS = true;
            if (inSbefore && Llir > 0) promoteToLir(k);
            else { qRemove(k); Q.push(k); }
        }
    }

    /** Evict Q's front (a resident HIR) to free a slot; if it was in S its key enters hist. */
    function replace() {
        const vKey = Q.shift();
        const v = resident.get(vKey);
        resident.delete(vKey);
        if (v.inS) { sRemove(vKey); histAdd(vKey); }
    }

    function reapIfStale(k) {
        const node = resident.get(k);
        if (!hasTtl || node.exp > clock()) return false;
        // unlink resident (mirrors _unlinkResident): from S, and LIR/HIR bookkeeping.
        if (node.inS) sRemove(k);
        if (node.lir) lirCount--; else qRemove(k);
        resident.delete(k);
        return true;
    }

    return {
        get(k) {
            if (!resident.has(k)) return undefined;
            if (reapIfStale(k)) return undefined;
            const val = resident.get(k).val;
            access(k);
            return val;
        },
        put(k, v, ttlMs) {
            const exp = hasTtl ? oracleExpiry(clock, ttl, ttlMs) : undefined;
            if (resident.has(k)) {
                const node = resident.get(k);
                node.val = v; node.exp = exp;
                access(k);
                return;
            }
            const inHist = histIndex(k) >= 0;
            if (resident.size === cap) replace();
            if (inHist) histRemove(k);
            const node = { key: k, val: v, exp, lir: false, inS: false };
            resident.set(k, node);
            if (inHist && Llir > 0) {
                node.lir = true; node.inS = true; S.push(k); lirCount++;
                if (lirCount > Llir) demoteBottomLir();
            } else if (lirCount < Llir) {
                node.lir = true; node.inS = true; S.push(k); lirCount++;
            } else {
                node.inS = true; S.push(k); Q.push(k);
            }
        },
        has(k) { if (!resident.has(k)) return false; return !reapIfStale(k); },
        peek(k) {
            if (!resident.has(k)) return undefined;
            if (reapIfStale(k)) return undefined;
            return resident.get(k).val;
        },
        delete(k) {
            if (!resident.has(k)) return false;
            const node = resident.get(k);
            if (node.inS) sRemove(k);
            if (node.lir) lirCount--; else qRemove(k);
            resident.delete(k);
            return true;
        },
        size() { return resident.size; },
        victim() { return Q.length ? Q[0] : undefined; },
    };
}
