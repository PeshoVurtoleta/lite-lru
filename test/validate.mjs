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
    // An S3-FIFO member (decisions/0013) threads TWO doubly-linked rings through the
    // shared _next/_prev columns (detected by its `_sHead` SMALL-ring endpoint):
    // SMALL (probation) and MAIN. The SAME checker sums over both descriptors.
    if (cache._sHead !== undefined) {
        return [
            { name: 's3fifo-small', head: cache._sHead, tail: cache._sTail, doubly: true },
            { name: 's3fifo-main', head: cache._mHead, tail: cache._mTail, doubly: true },
        ];
    }
    // A SIEVE member (decisions/0012) exposes _head/_tail on a single doubly-linked
    // FIFO ring (detected by its moving `_hand`). Classic LRU exposes the same shape
    // as a recency DLL. Both are ONE doubly-linked list -> one descriptor.
    if (cache._hand !== undefined) {
        return [{ name: 'sieve-fifo', head: cache._head, tail: cache._tail, doubly: true }];
    }
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

    // --- term 6 (S3-FIFO members, decisions/0013): visited range + ghost bound --
    // A no-op for LiteLru/Sieve. For an S3Fifo: every visited byte is 0 or 1, and the
    // ghost never exceeds its bound (ghostCount <= ghostCap). The two-ring population
    // is already summed by term 3/4 via activeListsOf above.
    if (cache._sHead !== undefined) {
        for (let i = 0; i < cap; i++) {
            if (cache._vis[i] > 1) {
                throw new Error('[validate] s3fifo _vis[' + i + '] = ' + cache._vis[i] + ' > 1');
            }
        }
        if (cache._gLen > cache._ghostCap) {
            throw new Error(
                '[validate] s3fifo ghostCount(' + cache._gLen + ') > ghostCap(' + cache._ghostCap + ')');
        }
        if (cache._sSize + cache._mSize !== size) {
            throw new Error(
                '[validate] s3fifo sSize(' + cache._sSize + ') + mSize(' + cache._mSize +
                ') != size(' + size + ')');
        }
    }

    // --- term 7 (SIEVE members, decisions/0012): hand + visited-column ----------
    // A no-op for LiteLru (no `_hand`). For a Sieve: the hand is in range or NIL,
    // every visited byte is 0 or 1, an empty ring's hand is NIL, and a set hand
    // points at a slot that is actually in the ring (never dangling -- fail closed).
    if (cache._hand !== undefined) {
        const hand = cache._hand;
        if (hand !== NIL && (hand < 0 || hand >= cap)) {
            throw new Error('[validate] sieve hand ' + hand + ' out of range [0,' + cap + ')');
        }
        if (size === 0 && hand !== NIL) {
            throw new Error('[validate] sieve hand ' + hand + ' set on an empty ring (expected NIL)');
        }
        for (let i = 0; i < cap; i++) {
            if (cache._vis[i] > 1) {
                throw new Error('[validate] sieve _vis[' + i + '] = ' + cache._vis[i] + ' > 1');
            }
        }
        if (hand !== NIL) {
            let inRing = false;
            for (let s = cache._head; s !== NIL; s = cache._next[s]) {
                if (s === hand) { inRing = true; break; }
            }
            if (!inRing) {
                throw new Error('[validate] sieve hand ' + hand + ' is not a live ring slot (dangling)');
            }
        }
    }
}
