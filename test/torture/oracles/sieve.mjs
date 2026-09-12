/**
 * Brute-force SIEVE reference oracle -- the differential ground truth for the
 * `Sieve` member (decisions/0012).
 *
 * Deliberately a DIFFERENT representation from Lru.js: a ring of plain node
 * objects ({key,val,visited,prev,next}) with head/tail/hand references and O(n)
 * linear key scans. It shares NO code with the Int32Array SoA implementation, so
 * it can never share a bug. Clarity over speed -- it is the oracle, not the product.
 *
 * SIEVE semantics mirrored EXACTLY so real and oracle stay in lockstep:
 *   - head = newest (insert here), tail = oldest; `prev` = toward head (newer),
 *     `next` = toward tail (older) -- the same orientation as Lru.js.
 *   - get(hit) / put(update) set `visited`; nothing structural.
 *   - at capacity, the hand sweeps from its current position (or the tail when
 *     unset), clears visited bits (second chance), evicts the first unvisited
 *     node, and parks toward the head (wrapping to the post-detach tail).
 *   - delete repairs the hand toward the head, else toward the tail, else null.
 *   - victim() predicts the next eviction WITHOUT mutating any bit or link.
 *
 * SameValueZero key equality (svz) mirrors JS Map, matching the default backing.
 */

import { svz, oracleExpiry } from './lru.mjs';

/**
 * @param {number} cap
 * @param {{ttl?:number, clock?:()=>number}} [opts]  opt-in TTL (decisions/0017)
 * @returns {{get,put,has,peek,delete,size,victim}}
 */
export function makeSieveOracle(cap, opts) {
    let head = null; // newest
    let tail = null; // oldest
    let hand = null; // the sweeping hand; null means "start from the tail"
    let size = 0;
    const ttl = opts && opts.ttl;
    const clock = (opts && opts.clock) || (() => 0);
    const hasTtl = ttl !== undefined;

    function find(k) {
        for (let n = head; n !== null; n = n.next) if (svz(n.key, k)) return n;
        return null;
    }

    function detach(n) {
        if (n.prev !== null) n.prev.next = n.next; else head = n.next;
        if (n.next !== null) n.next.prev = n.prev; else tail = n.prev;
        n.prev = null;
        n.next = null;
    }

    /** Lazy TTL (decisions/0017, D17.3): reap a stale node in place, mirroring the real
     *  Sieve delete (hand repair -> detach -> size--). No visited/second-chance change. */
    function reapIfStale(n) {
        if (!hasTtl || n.exp > clock()) return false;
        if (hand === n) { let h = n.prev; if (h === null) h = n.next; hand = h; }
        detach(n);
        size--;
        return true;
    }

    function pushFront(n) {
        n.prev = null;
        n.next = head;
        if (head !== null) head.prev = n;
        head = n;
        if (tail === null) tail = n;
    }

    /** Sweep for the victim, clearing visited bits (mutating). */
    function sweepVictim() {
        let o = hand !== null ? hand : tail;
        while (o.visited) {
            o.visited = false;
            o = o.prev !== null ? o.prev : tail;
        }
        return o;
    }

    return {
        get(k) {
            const n = find(k);
            if (n === null) return undefined;
            if (reapIfStale(n)) return undefined; // stale = MISS, no visited bump (D17.3)
            n.visited = true; // set visited only; nothing structural
            return n.val;
        },
        put(k, v, ttlMs) {
            const exp = hasTtl ? oracleExpiry(clock, ttl, ttlMs) : undefined;
            const n = find(k);
            if (n !== null) { n.val = v; n.visited = true; n.exp = exp; return; } // update + visit
            if (size === cap) {
                const victim = sweepVictim();
                const park = victim.prev; // toward the head
                detach(victim);
                hand = park !== null ? park : tail; // wrap to the post-detach tail
                size--;
            }
            pushFront({ key: k, val: v, visited: false, exp, prev: null, next: null });
            size++;
        },
        has(k) { const n = find(k); if (n === null) return false; return !reapIfStale(n); },
        peek(k) { const n = find(k); if (n === null) return undefined; if (reapIfStale(n)) return undefined; return n.val; },
        delete(k) {
            const n = find(k);
            if (n === null) return false;
            if (hand === n) {
                let h = n.prev;               // toward the head
                if (h === null) h = n.next;   // else toward the tail
                hand = h;                     // null when the ring empties
            }
            detach(n);
            size--;
            return true;
        },
        size() { return size; },
        victim() {
            if (size === 0) return undefined;
            const start = hand !== null ? hand : tail;
            let o = start;
            for (;;) {
                if (!o.visited) return o.key;
                o = o.prev !== null ? o.prev : tail;
                if (o === start) return start.key; // all visited -> start is the victim
            }
        },
    };
}
