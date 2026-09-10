/**
 * @zakkster/lite-lru -- Zero-dependency, zero-GC LRU cache
 *
 * A fixed-capacity Least-Recently-Used cache with O(1) get, put, delete, has
 * and peek. Built from two structures fused together (D1):
 *
 *   1. a Map<key, slot>            -- O(1) key -> slot lookup   (the hash table)
 *   2. an intrusive doubly-linked  -- O(1) recency reordering   (the DLL)
 *      list over preallocated slots    and O(1) eviction
 *
 * The DLL is not made of `{}` node objects. It is a set of parallel arrays
 * indexed by an integer SLOT (D2/D4): `_keys[]`, `_vals[]`, and two
 * `Int32Array` link columns `_next[]` / `_prev[]`. Because an LRU has a HARD
 * capacity ceiling by definition, all `capacity` slots are preallocated ONCE in
 * the constructor and reused forever -- no node is ever allocated on put, and
 * eviction repurposes the evicted slot in place. After warm-up the only
 * allocation frontier left is the Map's own internal growth (D3), which is why a
 * true integer-key zero-GC variant is a roadmap item, not this file's job.
 *
 * A slot is in exactly one of two intrusive lists at a time, both threaded
 * through `_next[]` (D5):
 *   - the ACTIVE list: the recency order, head = MRU, tail = LRU (uses next+prev)
 *   - the FREE list:   a stack of unused slots (uses next only, prev ignored)
 * This is the same intrusive free list lite-signal uses for its node pool.
 *
 * Laws honored (suite CLAUDE.md):
 *   - Zero allocation on any hot path (get/put/delete/has/peek). Measured by the
 *     torture gate; the DLL/slot layer is strictly zero-alloc.
 *   - Fail closed: an invalid capacity throws at the door; null is not zero.
 *   - ASCII-only source. Single file. Zero runtime deps.
 *
 * Design decisions live in decisions/ (D1..D10) and are summarized in ROADMAP.md.
 */

/** Shared no-op eviction callback, so a cache without an onEvict handler
 *  references one function instance instead of allocating a closure per
 *  constructor call (same pattern as lite-object-pool's NOOP). */
const NOOP = () => {};

/** Sentinel for "no slot" -- used for empty head/tail and free-list end.
 *  -1 because slots are non-negative indices, so it can never collide. */
const NIL = -1;

export const VERSION = "0.1.0";

export class LiteLru {
    /**
     * @param {number} capacity  Max entries. Must be an integer >= 1.
     * @param {{ onEvict?: (key: any, value: any) => void }} [options]
     */
    constructor(capacity, options) {
        // D9 -- fail closed. A non-integer or < 1 capacity is a caller bug, not
        // something to silently coerce. Throw a library-tagged error at the door.
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new RangeError(
                "[lite-lru] capacity must be an integer >= 1, got " + String(capacity)
            );
        }

        this._capacity = capacity;

        // The hash half (D1/D3): key -> slot index. JS Map handles arbitrary key
        // types and SameValueZero equality for free. It is amortized O(1); its
        // internal resize is the one thing outside our zero-GC control here.
        this._map = new Map();

        // The slot columns (D2/D4). Object arrays for the payload, Int32Array
        // link columns for the topology. Filling the object arrays makes them
        // PACKED_ELEMENTS rather than holey (V8 fast path -- see Learning/V8.md).
        this._keys = new Array(capacity).fill(undefined);
        this._vals = new Array(capacity).fill(undefined);
        this._next = new Int32Array(capacity); // active: toward LRU; free: next free
        this._prev = new Int32Array(capacity); // active: toward MRU (unused when free)

        // Build the initial FREE list: 0 -> 1 -> 2 -> ... -> capacity-1 -> NIL.
        // Every slot starts free; the active list starts empty.
        for (let i = 0; i < capacity; i++) this._next[i] = i + 1;
        this._next[capacity - 1] = NIL;
        this._free = 0;   // head of the free-slot stack

        this._head = NIL; // MRU end of the active list
        this._tail = NIL; // LRU end of the active list
        this._size = 0;

        // D8 -- optional zero-GC eviction hook (e.g. return the value to a pool).
        this._onEvict = (options && options.onEvict) || NOOP;
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- intrusive free-list helpers (D5) -------------------------------------

    /** Pop a fresh slot off the free stack. Caller must know one exists
     *  (size < capacity guarantees it). */
    _allocSlot() {
        const s = this._free;
        this._free = this._next[s]; // advance the free head
        return s;
    }

    /** Return a slot to the free stack and drop its payload refs so the cached
     *  key/value can be garbage-collected (retention hygiene -- a freed slot must
     *  not pin objects the cache no longer owns). */
    _freeSlot(s) {
        this._keys[s] = undefined;
        this._vals[s] = undefined;
        this._next[s] = this._free;
        this._free = s;
    }

    // --- intrusive doubly-linked-list helpers (D1) ----------------------------

    /** Unlink slot s from the ACTIVE list, fixing up its neighbours and the
     *  head/tail sentinels. O(1) precisely because prev is stored -- this is why
     *  the list is doubly, not singly, linked (D1). */
    _detach(s) {
        const p = this._prev[s];
        const n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._head = n; // s was head
        if (n !== NIL) this._prev[n] = p; else this._tail = p; // s was tail
    }

    /** Insert slot s at the head (MRU end) of the ACTIVE list. */
    _pushFront(s) {
        this._prev[s] = NIL;
        this._next[s] = this._head;
        if (this._head !== NIL) this._prev[this._head] = s;
        this._head = s;
        if (this._tail === NIL) this._tail = s; // first element -> also the tail
    }

    /** Promote s to MRU. No-op if it is already the head (the common re-hit). */
    _moveToFront(s) {
        if (this._head === s) return;
        this._detach(s);
        this._pushFront(s);
    }

    // --- public API (all O(1), all zero-alloc on the hot path) ----------------

    /**
     * Look up a key AND mark it most-recently-used.
     * @returns the value, or undefined if absent. NOTE: storing `undefined` as a
     *          value is therefore indistinguishable from a miss -- use has() to
     *          disambiguate, or peek(). (Roadmap S3 adds a get(key, default).)
     */
    get(key) {
        const s = this._map.get(key);
        // Slots are >= 0, so a strict `undefined` check is a clean miss test even
        // when the slot is 0 (which is falsy -- do NOT use truthiness here).
        if (s === undefined) return undefined;
        this._moveToFront(s);
        return this._vals[s];
    }

    /**
     * Insert or update. On a new key at full capacity, evicts the LRU entry
     * first (and fires onEvict). Amortized O(1).
     */
    put(key, value) {
        const existing = this._map.get(key);
        if (existing !== undefined) {         // update-in-place + promote
            this._vals[existing] = value;
            this._moveToFront(existing);
            return;
        }

        let s;
        if (this._size === this._capacity) {
            // D6 -- evict the LRU (tail) and REUSE its slot in place, skipping a
            // free-list round trip. One unlink, one map delete, one relink.
            s = this._tail;
            const evKey = this._keys[s];
            const evVal = this._vals[s];
            this._detach(s);
            this._map.delete(evKey);
            this._size--;
            this._onEvict(evKey, evVal); // after unlink, before reuse
        } else {
            s = this._allocSlot();
        }

        this._keys[s] = key;
        this._vals[s] = value;
        this._map.set(key, s);
        this._pushFront(s);
        this._size++;
    }

    /** True if key is present. Does NOT change recency (D7). */
    has(key) { return this._map.has(key); }

    /** Read a value WITHOUT changing recency. undefined if absent. */
    peek(key) {
        const s = this._map.get(key);
        return s === undefined ? undefined : this._vals[s];
    }

    /**
     * Remove a key. Returns true if it was present. Frees the slot back to the
     * free stack, so the cache can sit below capacity again.
     */
    delete(key) {
        const s = this._map.get(key);
        if (s === undefined) return false;
        this._detach(s);
        this._map.delete(key);
        this._freeSlot(s);
        this._size--;
        return true;
    }

    /** Empty the cache. Rebuilds the free list; allocates nothing. O(capacity). */
    clear() {
        this._map.clear();
        const cap = this._capacity;
        for (let i = 0; i < cap; i++) {
            this._keys[i] = undefined;
            this._vals[i] = undefined;
            this._next[i] = i + 1;
            this._prev[i] = NIL;
        }
        this._next[cap - 1] = NIL;
        this._free = 0;
        this._head = NIL;
        this._tail = NIL;
        this._size = 0;
    }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Walk the free stack and return its length. Used by the torture suite's
     *  conservation invariant: `size + _freeListLength() === capacity`. */
    _freeListLength() {
        let n = 0;
        for (let s = this._free; s !== NIL; s = this._next[s]) n++;
        return n;
    }
}

export default LiteLru;
