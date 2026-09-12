/**
 * Brute-force W-TinyLFU reference oracle -- the differential ground truth for the
 * `WTinyLfu` member (decisions/0014).
 *
 * Deliberately a DIFFERENT representation from Lru.js: three plain JS arrays (window,
 * probation, protected -- each an ordered list of {key,val} nodes, index 0 = LRU =
 * the eviction end, push = MRU end) plus a plain per-counter frequency sketch (a flat
 * Array of 4-bit counts). It shares NO code with the Int32Array SoA + packed-Uint32
 * sketch implementation, so it can never share a bug. Clarity over speed -- it is the
 * oracle, not the product.
 *
 * W-TinyLFU semantics mirrored EXACTLY so real and oracle stay in lockstep:
 *   - sizing: window = max(1, round(cap/100)); main = cap - window;
 *     protected = round(main*0.8); probation = the remainder of main.
 *   - sketch: 4 rows of 4-bit saturating counters, width = pow2 >= cap, same per-row
 *     seeds + `Math.imul` column mix as Lru.js; aged (halved) every 10*cap bumps.
 *   - get(hit) / put(update): bump the sketch, then promote (window -> window MRU;
 *     probation -> protected, demoting protected's LRU on overflow; protected -> MRU).
 *   - put(new): below capacity admit to window + shed window overflow into probation;
 *     at capacity, force the window LRU out as the CANDIDATE, admit it over the
 *     probation VICTIM (evicting the victim) iff freq(cand) > freq(victim) else evict
 *     the candidate (ties reject). Then bump the newcomer's sketch AFTER the decision.
 *   - delete removes from whichever list; the sketch is untouched.
 *   - victim() replays the eviction compare on the LIVE state, non-mutating; below
 *     capacity a new key does not evict, so it returns undefined.
 *
 * The sketch key hash mirrors Lru.js's `_hashKey` for the NUMERIC keys the fuzz uses
 * (`(key | 0) >>> 0`); the object-key slot-hash path of Lru.js is never exercised by
 * the differential (the fuzz drives integer keys only).
 *
 * SameValueZero key equality (svz) mirrors JS Map/Set, matching the default backing.
 */

import { svz } from './lru.mjs';

const SK_ROWS = 4;
const SK_SEEDS = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f];

/**
 * @param {number} cap
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeWTinyLfuOracle(cap) {
    const windowCap = Math.max(1, Math.round(cap / 100));
    const mainCap = cap - windowCap;
    const protectedCap = Math.round(mainCap * 0.8);

    const window = [];    // window[0] = LRU (eviction end); push = MRU
    const probation = [];
    const protectedL = [];

    // The frequency sketch: a flat Array of 4-bit counts (r*width + col).
    let width = 1;
    while (width < cap) width <<= 1;
    const mask = width - 1;
    const sk = new Array(SK_ROWS * width).fill(0);
    const sample = 10 * cap;
    let skSize = 0;

    function hashKey(k) { return (k | 0) >>> 0; } // numeric keys only in the fuzz

    function skCol(h, r) {
        let x = (h ^ SK_SEEDS[r]) >>> 0;
        x = Math.imul(x, 0x9e3779b1) >>> 0;
        x ^= x >>> 16;
        return x & mask;
    }

    function sketchFreq(h) {
        let min = 15;
        for (let r = 0; r < SK_ROWS; r++) {
            const v = sk[r * width + skCol(h, r)];
            if (v < min) min = v;
        }
        return min;
    }

    function sketchInc(h) {
        for (let r = 0; r < SK_ROWS; r++) {
            const idx = r * width + skCol(h, r);
            if (sk[idx] < 15) sk[idx]++;
        }
        if (++skSize >= sample) {
            for (let i = 0; i < sk.length; i++) sk[i] = sk[i] >> 1;
            skSize >>>= 1;
        }
    }

    function findIn(list, k) {
        for (let i = 0; i < list.length; i++) if (svz(list[i].key, k)) return i;
        return -1;
    }

    /** Locate a key across the three lists. Returns {list, idx} or null. */
    function find(k) {
        let i = findIn(window, k);
        if (i >= 0) return { list: window, idx: i };
        i = findIn(probation, k);
        if (i >= 0) return { list: probation, idx: i };
        i = findIn(protectedL, k);
        if (i >= 0) return { list: protectedL, idx: i };
        return null;
    }

    /** Promote on a hit, mirroring Lru.js `_onHit`. */
    function promote(loc) {
        const node = loc.list[loc.idx];
        if (loc.list === window) {
            window.splice(loc.idx, 1);
            window.push(node);            // window MRU
        } else if (loc.list === probation) {
            probation.splice(loc.idx, 1);
            protectedL.push(node);        // promote to protected MRU
            if (protectedL.length > protectedCap) {
                probation.push(protectedL.shift()); // demote protected LRU to probation
            }
        } else {
            protectedL.splice(loc.idx, 1);
            protectedL.push(node);        // protected MRU
        }
    }

    return {
        get(k) {
            const loc = find(k);
            if (loc === null) return undefined;
            const val = loc.list[loc.idx].val;
            sketchInc(hashKey(k));
            promote(loc);
            return val;
        },
        put(k, v) {
            const loc = find(k);
            if (loc !== null) {           // update + bump + promote
                loc.list[loc.idx].val = v;
                sketchInc(hashKey(k));
                promote(loc);
                return;
            }
            const size = window.length + probation.length + protectedL.length;
            if (size < cap) {
                window.push({ key: k, val: v });
                while (window.length > windowCap) probation.push(window.shift());
            } else {
                const cand = window.shift(); // window LRU = candidate
                const victim = probation.length ? probation[0] : null;
                if (victim !== null && sketchFreq(hashKey(cand.key)) > sketchFreq(hashKey(victim.key))) {
                    probation.push(cand);    // candidate admitted to probation MRU
                    probation.shift();       // evict the victim (probation LRU)
                }
                // else: ties/no-victim -> candidate evicted (already removed from window)
                window.push({ key: k, val: v });
            }
            sketchInc(hashKey(k)); // bump the newcomer AFTER the decision
        },
        has(k) { return find(k) !== null; },
        peek(k) { const loc = find(k); return loc === null ? undefined : loc.list[loc.idx].val; },
        delete(k) {
            let i = findIn(window, k);
            if (i >= 0) { window.splice(i, 1); return true; }
            i = findIn(probation, k);
            if (i >= 0) { probation.splice(i, 1); return true; }
            i = findIn(protectedL, k);
            if (i >= 0) { protectedL.splice(i, 1); return true; }
            return false;
        },
        size() { return window.length + probation.length + protectedL.length; },
        victim() {
            const size = window.length + probation.length + protectedL.length;
            if (size < cap || size === 0) return undefined; // no eviction below capacity
            const cand = window[0];                         // window LRU (non-empty at cap)
            if (cand === undefined) return undefined;
            const victim = probation.length ? probation[0] : null;
            if (victim === null) return cand.key;
            return sketchFreq(hashKey(cand.key)) > sketchFreq(hashKey(victim.key))
                ? victim.key : cand.key;
        },
    };
}
