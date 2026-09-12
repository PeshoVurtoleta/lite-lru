/**
 * Brute-force S3-FIFO reference oracle -- the differential ground truth for the
 * `S3Fifo` member (decisions/0013).
 *
 * Deliberately a DIFFERENT representation from Lru.js: three plain JS containers --
 * a SMALL array, a MAIN array (each an ordered list of {key,val,visited} nodes,
 * index 0 = OLDEST = the eviction end, push = newest end), and a GHOST array of
 * keys (index 0 = oldest). It shares NO code with the Int32Array SoA + typed-ring
 * implementation, so it can never share a bug. Clarity over speed -- it is the
 * oracle, not the product.
 *
 * S3-FIFO semantics mirrored EXACTLY so real and oracle stay in lockstep:
 *   - sizing: smallCap = max(1, floor(cap/10)); mainCap = cap - smallCap;
 *     ghostCap = mainCap.
 *   - get(hit) / put(update) set `visited`; nothing structural.
 *   - put(new): decide admission from GHOST state at arrival (in ghost -> MAIN,
 *     consume it; else -> SMALL); then, if at capacity, run ONE eviction step; then
 *     admit the newcomer UNVISITED.
 *   - eviction step: SMALL over its target (len >= smallCap) -> take SMALL oldest:
 *     visited graduates to MAIN (bit cleared), unvisited is evicted + its key
 *     recorded in ghost. Else -> take MAIN oldest: visited gets a second chance
 *     (bit cleared, moved to MAIN head), unvisited is evicted (NOT ghosted). The
 *     below-capacity "main empty" case (only reachable via victim(), never a real
 *     eviction) degenerates to a Sieve-like second chance within SMALL.
 *   - delete removes from whichever queue; NOT recorded in ghost.
 *   - victim() replays the eviction step on COPIES -- non-mutating, matches _evict.
 *
 * SameValueZero key equality (svz) mirrors JS Map/Set, matching the default backing.
 */

import { svz } from './lru.mjs';

/**
 * @param {number} cap
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeS3FifoOracle(cap) {
    const smallCap = Math.max(1, Math.floor(cap / 10));
    const mainCap = cap - smallCap;
    const ghostCap = mainCap;

    const small = []; // small[0] = oldest (eviction end); push = newest
    const main = [];  // main[0]  = oldest;                push = newest
    const ghost = []; // ghost[0] = oldest key;            push = newest

    function findIn(list, k) {
        for (let i = 0; i < list.length; i++) if (svz(list[i].key, k)) return list[i];
        return null;
    }
    function find(k) { return findIn(small, k) || findIn(main, k); }

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

    /** One eviction step over the LIVE queues (mutating). Only called at capacity. */
    function evictStep() {
        for (;;) {
            if (small.length >= smallCap) {
                const t = small[0];
                if (t.visited) { t.visited = false; small.shift(); main.push(t); continue; }
                small.shift(); ghostAdd(t.key); return;
            }
            if (main.length > 0) {
                const t = main[0];
                if (t.visited) { t.visited = false; main.shift(); main.push(t); continue; }
                main.shift(); return;
            }
            // main empty (below capacity only): second chance within small
            const t = small[0];
            if (t.visited) { t.visited = false; small.shift(); small.push(t); continue; }
            small.shift(); ghostAdd(t.key); return;
        }
    }

    return {
        get(k) {
            const n = find(k);
            if (n === null) return undefined;
            n.visited = true; // set visited only; nothing structural
            return n.val;
        },
        put(k, v) {
            const n = find(k);
            if (n !== null) { n.val = v; n.visited = true; return; } // update + visit
            const toMain = ghostIndex(k) >= 0;
            if (toMain) ghostRemove(k);
            if (small.length + main.length === cap) evictStep();
            const entry = { key: k, val: v, visited: false };
            if (toMain) main.push(entry); else small.push(entry);
        },
        has(k) { return find(k) !== null; },
        peek(k) { const n = find(k); return n === null ? undefined : n.val; },
        delete(k) {
            for (let i = 0; i < small.length; i++) if (svz(small[i].key, k)) { small.splice(i, 1); return true; }
            for (let i = 0; i < main.length; i++) if (svz(main[i].key, k)) { main.splice(i, 1); return true; }
            return false;
        },
        size() { return small.length + main.length; },
        victim() {
            if (small.length + main.length === 0) return undefined;
            // Replay the eviction step on COPIES (visited flags + membership matter;
            // graduations/second chances move nodes). Non-mutating, so it matches the
            // real _peekVictim clone-and-replay exactly.
            const s = small.map((e) => ({ key: e.key, visited: e.visited }));
            const m = main.map((e) => ({ key: e.key, visited: e.visited }));
            for (;;) {
                if (s.length >= smallCap) {
                    const t = s[0];
                    if (t.visited) { t.visited = false; s.shift(); m.push(t); continue; }
                    return t.key;
                } else if (m.length > 0) {
                    const t = m[0];
                    if (t.visited) { t.visited = false; m.shift(); m.push(t); continue; }
                    return t.key;
                } else {
                    const t = s[0];
                    if (t.visited) { t.visited = false; s.shift(); s.push(t); continue; }
                    return t.key;
                }
            }
        },
    };
}
