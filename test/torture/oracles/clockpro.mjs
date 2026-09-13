/**
 * Brute-force ClockPro reference oracle (CLOCK-Pro; Jiang, Chen & Zhang, USENIX ATC'05)
 * -- the differential ground truth for the `ClockPro` member (decisions/0025, the
 * BOUNDED-history variant D25).
 *
 * Deliberately a DIFFERENT representation from Lru.js: a plain JS ARRAY of page nodes
 * `{key, val, exp, st}` in clock order (index 0 = head/newest .. last = tail/oldest), with
 * the three hands kept as plain ARRAY INDICES (handCold/handHot/handTest), a `resident` Map
 * for O(1) lookup, an integer `mHot`, and a bounded `hist` FIFO array (index 0 = oldest). It
 * shares NO code with the Int32Array SoA + wrap-around-DLL + typed-ring implementation
 * (no Int32Array, no `_next`/`_prev`, no open-addressed ring), so it can never share a bug.
 * The per-page state byte mirrors Lru.js: bit0 hot, bit1 referenced, bit2 test.
 *
 * BOUNDED-ClockPro semantics mirrored EXACTLY (decisions/0025, D25):
 *   - ONE circular clock of resident pages; a hit sets the reference bit ONLY (no move).
 *   - HAND_test (one step per eviction): a resident cold page in its test period whose ref
 *     bit is clear has its test period ended and LOWERS `mHot` (D25.3).
 *   - HAND_cold sweep: a referenced cold page in test -> promoted HOT; a referenced cold page
 *     not in test -> second chance (fresh test period); the first unreferenced cold page is
 *     the victim, evicted -> the bounded history iff it was in a test period (D25.2).
 *   - HAND_hot: demotes a hot page to cold (fresh test period) when the hot set exceeds the
 *     adaptive target, or when the clock would otherwise hold no cold victim.
 *   - a new key still in the bounded history is re-admitted HOT and RAISES `mHot` (D25.3); a
 *     brand-new key enters cold in a test period. Resident capacity stays EXACTLY cap (D25.4).
 *   - has/peek: reference-neutral. delete: unlink, NOT recorded in history. victim() replays
 *     the sweep on a CLONE (non-destructive) and returns the key it would evict.
 *
 * SameValueZero key equality (svz) mirrors JS Map/Set, matching the default backing.
 */

import { svz, oracleExpiry } from './lru.mjs';

const HOT = 1;  // bit0
const REF = 2;  // bit1
const TEST = 4; // bit2

/**
 * @param {number} cap
 * @param {{ttl?:number, clock?:()=>number}} [opts]  opt-in TTL (decisions/0017)
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeClockProOracle(cap, opts) {
    const ttl = opts && opts.ttl;
    const clockFn = (opts && opts.clock) || (() => 0);
    const hasTtl = ttl !== undefined;

    const resident = new Map(); // key -> node {key, val, exp, st}
    const hist = [];            // hist[0] = oldest; bounded to cap (non-resident test-page keys)

    // The mutable clock state (shared by the committed path and the non-destructive victim()).
    const state = {
        clock: [],   // clock[0] = head (newest) .. last = tail (oldest)
        handCold: -1,
        handHot: -1,
        handTest: -1,
        mHot: 0,
        nHot: 0,
        nCold: 0,
    };

    function advance(st, i) { return (i + 1) % st.clock.length; }

    /** Insert a node at the head (newest). Hands track their nodes across the shift. */
    function insertHead(st, node) {
        st.clock.unshift(node);
        if (st.handCold >= 0) st.handCold++;
        if (st.handHot >= 0) st.handHot++;
        if (st.handTest >= 0) st.handTest++;
        if (st.clock.length === 1) { st.handCold = 0; st.handHot = 0; st.handTest = 0; }
    }

    /** Remove the node at index r, repairing every hand (advance to its successor before the
     *  splice) and the hot/cold count. Returns the removed node. */
    function removeAt(st, r) {
        const cl = st.clock, wasLen = cl.length;
        const fix = (h) => {
            if (h === r) {
                if (wasLen === 1) return -1;
                return ((r + 1) % wasLen === 0) ? 0 : r; // r was tail -> wrap to head(0), else successor -> r
            }
            return h > r ? h - 1 : h;
        };
        st.handCold = fix(st.handCold);
        st.handHot = fix(st.handHot);
        st.handTest = fix(st.handTest);
        const node = cl[r];
        if (node.st & HOT) st.nHot--; else st.nCold--;
        cl.splice(r, 1);
        return node;
    }

    /** HAND_hot: demote exactly one hot page to cold (fresh test period). */
    function demoteHot(st) {
        for (;;) {
            const h = st.handHot;
            if (h < 0) return;
            const b = st.clock[h].st;
            if (b & HOT) {
                if (b & REF) { st.clock[h].st = HOT; st.handHot = advance(st, h); }
                else { st.clock[h].st = TEST; st.nHot--; st.nCold++; st.handHot = advance(st, h); return; }
            } else {
                st.handHot = advance(st, h);
            }
        }
    }

    /** ONE step of HAND_test: end the resident cold page's test period it points at, then
     *  advance. Stepped only on reference activity (mirrors the member), never on a plain evict. */
    function testStep(st) {
        const t = st.handTest;
        if (t < 0) return;
        const b = st.clock[t].st;
        if ((b & HOT) === 0 && (b & TEST) !== 0) {
            st.clock[t].st &= ~TEST;
            if (st.mHot > 0) st.mHot--; // a test period expired without earning hot status (D25.3)
        }
        st.handTest = advance(st, t);
    }

    /** Replay the eviction sweep on `st` (HAND_cold sweep with HAND_hot demotions + HAND_test
     *  steps on reference activity) and return the INDEX of the victim (an unreferenced cold
     *  page). Mutates the reference/hot/test bits, the hands and the counts -- but does NOT
     *  remove the victim (the caller does, so victim() can run it on a clone). */
    function sweep(st) {
        if (st.nCold === 0) demoteHot(st);
        for (;;) {
            const c = st.handCold;
            const b = st.clock[c].st;
            if (b & HOT) { st.handCold = advance(st, c); continue; }
            if (b & REF) {
                if (b & TEST) {
                    st.clock[c].st = HOT; st.nCold--; st.nHot++;
                    st.handCold = advance(st, c);
                    testStep(st);
                    if (st.nHot > st.mHot || st.nCold === 0) demoteHot(st);
                    continue;
                }
                st.clock[c].st = TEST; st.handCold = advance(st, c); testStep(st); continue;
            }
            return c;
        }
    }

    function cloneState() {
        const clock = new Array(state.clock.length);
        for (let i = 0; i < state.clock.length; i++) clock[i] = { key: state.clock[i].key, st: state.clock[i].st };
        return {
            clock, handCold: state.handCold, handHot: state.handHot, handTest: state.handTest,
            mHot: state.mHot, nHot: state.nHot, nCold: state.nCold,
        };
    }

    function histIndex(k) { for (let i = 0; i < hist.length; i++) if (svz(hist[i], k)) return i; return -1; }
    function histAdd(k) { if (hist.length >= cap) hist.shift(); hist.push(k); }

    function reapIfStale(k) {
        const node = resident.get(k);
        if (!hasTtl || node.exp > clockFn()) return false;
        const idx = state.clock.indexOf(node);
        removeAt(state, idx);
        resident.delete(k);
        return true;
    }

    return {
        get(k) {
            const node = resident.get(k);
            if (node === undefined) return undefined;
            if (reapIfStale(k)) return undefined; // stale = MISS, reap in place (D17.3)
            node.st |= REF; // the whole hot path: set the reference bit
            return node.val;
        },
        put(k, v, ttlMs) {
            const exp = hasTtl ? oracleExpiry(clockFn, ttl, ttlMs) : undefined;
            const existing = resident.get(k);
            if (existing !== undefined) { // update-in-place + set ref
                existing.val = v; existing.exp = exp; existing.st |= REF;
                return;
            }
            const inHist = histIndex(k) >= 0;
            if (resident.size === cap) {
                const idx = sweep(state);
                const evNode = state.clock[idx];
                const wasTest = (evNode.st & TEST) !== 0;
                removeAt(state, idx);
                resident.delete(evNode.key);
                if (wasTest) histAdd(evNode.key);
            }
            if (inHist) {
                // The re-admit decision is taken BEFORE the eviction; the eviction's
                // drop-oldest may already have forgotten this key, so the consume is a
                // no-op then (mirrors the member's ArcGhost.consume of an absent key).
                const hi = histIndex(k);
                if (hi >= 0) hist.splice(hi, 1);
                state.mHot++; if (state.mHot > cap) state.mHot = cap; // raise (D25.3)
            }
            const node = { key: k, val: v, exp, st: inHist ? HOT : TEST };
            resident.set(k, node);
            insertHead(state, node);
            if (inHist) {
                state.nHot++;
                if (state.nHot > state.mHot) demoteHot(state);
            } else {
                state.nCold++;
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
            removeAt(state, state.clock.indexOf(node));
            resident.delete(k);
            return true;
        },
        size() { return resident.size; },
        victim() {
            if (resident.size === 0) return undefined;
            const clone = cloneState();
            const idx = sweep(clone);
            return clone.clock[idx].key;
        },
    };
}
