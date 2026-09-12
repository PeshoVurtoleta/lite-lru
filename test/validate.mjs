/**
 * @zakkster/lite-lru -- the conservation invariant (test/debug only).
 *
 * O(capacity), NEVER on a hot path. It is the spine of the torture suite: almost
 * every free-list, DLL, or map bug violates it immediately (ROADMAP section 3).
 *
 * Written GENERALIZED so a future family member (SIEVE, S3-FIFO, ARC, ...) extends
 * it with ONE more term, not a rewrite. The invariant is a SUM over intrusive
 * active lists:
 *
 *   index buffers fixed (int backing)             (the substrate never resizes)
 *   size + freeListLength === capacity            (every slot accounted for)
 *   index.size === size                           (keyed index and lists agree)
 *   sum(length of every active list) === size     (no lost / duplicated links)
 *   prev/next reciprocity for every active DLL     (_prev[_next[s]] === s, NIL ends)
 *
 * The keyed index is read through the SlotStore surface (decisions/0011), so the
 * SAME checker validates BOTH backings -- the default Map AND the opt-in integer
 * open-addressed table -- unchanged. For the int backing the store also exposes
 * `checkStable()`: its ArrayBuffer byteLengths are fixed at construction and must
 * never grow (a "growing index" is a bug, caught here).
 *
 * `activeListsOf(cache)` returns the member's active-list descriptors. Classic LRU
 * has exactly one (the recency DLL, head=MRU .. tail=LRU). A member with N
 * intrusive lists returns N descriptors and the SAME checker sums over them.
 *
 * Zero dependency on the profiler so `node --test` can import it without pulling
 * the torture peers. Throws an Error naming the first violation, or returns void.
 */

const NIL = -1;

/**
 * The active-list descriptors for a cache. Each descriptor names a doubly-linked
 * intrusive list threaded through cache._next/_prev with head/tail endpoints.
 * Classic LRU: one list. Override/extend per member by branching on a member tag.
 * @param {object} cache
 * @returns {Array<{name:string, head:number, tail:number, doubly:boolean}>}
 */
export function activeListsOf(cache) {
    // Classic LRU exposes _head/_tail on a single doubly-linked recency list.
    return [{ name: 'recency', head: cache._head, tail: cache._tail, doubly: true }];
}

/**
 * Assert the conservation invariant. Throws on the first violation with a message
 * that names the failing term, or returns void when the cache is coherent.
 * @param {object} cache      a LiteLru (or any family member sharing the shape)
 * @param {(c:object)=>Array} [lists]  active-list descriptor factory (default: classic)
 */
export function validate(cache, lists) {
    const cap = cache._capacity;
    const size = cache._size;
    const store = cache._store;

    // --- term 0: the int-backing index buffers are fixed (never resize) ---------
    // A no-op for the Map backing (no checkStable). Runs FIRST so a "growing index"
    // is reported as exactly that, not as a downstream cross-check failure.
    if (typeof store.checkStable === 'function') store.checkStable();

    // --- term 1: every slot is in exactly one place (active + free == cap) ------
    const freeLen = cache._freeListLength();
    if (size + freeLen !== cap) {
        throw new Error(
            '[validate] conservation: size(' + size + ') + freeListLength(' + freeLen +
            ') != capacity(' + cap + ')');
    }

    // --- term 2: the keyed index agrees with the list population ----------------
    const ixSize = store.indexSize();
    if (ixSize !== size) {
        throw new Error('[validate] index.size(' + ixSize + ') != size(' + size + ')');
    }

    // --- term 3 + 4: sum of active-list lengths == size, with reciprocity -------
    const descriptors = (lists || activeListsOf)(cache);
    let total = 0;
    for (let li = 0; li < descriptors.length; li++) {
        const L = descriptors[li];
        let count = 0;
        let prev = NIL;
        for (let s = L.head; s !== NIL; s = cache._next[s]) {
            if (s < 0 || s >= cap) {
                throw new Error('[validate] list "' + L.name + '" reached out-of-range slot ' + s);
            }
            if (L.doubly && cache._prev[s] !== prev) {
                throw new Error(
                    '[validate] list "' + L.name + '" reciprocity broken at slot ' + s +
                    ': _prev=' + cache._prev[s] + ' expected ' + prev);
            }
            prev = s;
            count++;
            if (count > cap) {
                throw new Error('[validate] list "' + L.name + '" has a cycle (walked > capacity)');
            }
        }
        if (L.tail !== prev) {
            throw new Error('[validate] list "' + L.name + '" tail(' + L.tail + ') != last walked slot(' + prev + ')');
        }
        total += count;
    }
    if (total !== size) {
        throw new Error('[validate] sum of active-list lengths(' + total + ') != size(' + size + ')');
    }

    // --- term 5: the keyed index maps back into an active slot with the same key -
    // (cheap cross-check that keys in the index resolve to live slots holding them).
    // Read through the store surface so it holds for BOTH backings.
    store.indexEntries((key, slot) => {
        if (slot < 0 || slot >= cap) {
            throw new Error('[validate] index key resolves to out-of-range slot ' + slot);
        }
        const stored = cache._keys[slot];
        const same = stored === key || (stored !== stored && key !== key); // SameValueZero
        if (!same) {
            throw new Error('[validate] index key/slot disagree at slot ' + slot);
        }
    });
}
