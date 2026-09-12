/**
 * @zakkster/lite-lru -- Zero-dependency, zero-GC LRU cache
 *
 * A fixed-capacity Least-Recently-Used cache with O(1) get, put, delete, has
 * and peek. Built from two structures fused together (D1):
 *
 *   1. a keyed index    -- O(1) key -> slot lookup   (the hash table)
 *   2. an intrusive      -- O(1) recency reordering   (the DLL)
 *      doubly-linked list    and O(1) eviction
 *      over preallocated slots
 *
 * S3 (decisions/0011, D11) factors the shared machinery -- the keyed index, the
 * SoA payload columns, the link columns, and the free stack -- into an internal
 * `SlotStore` substrate that `LiteLru` (and every future family member) composes.
 * The keyed index has TWO backings, chosen ONCE at construction so each hot path
 * is monomorphic (no per-op branch on backing type):
 *
 *   - DEFAULT (arbitrary keys): a JS `Map` (`MapSlotStore`). Honestly AMORTIZED
 *     (its internal resize can allocate) -- unchanged from v0.1.0. `new LiteLru(cap)`
 *     and `new LiteLru(cap, { onEvict })` behave BYTE-IDENTICALLY. Objects/strings
 *     cannot live in a typed array without a side Map, so arbitrary keys keep the
 *     Map by necessity, and D3's amortized caveat stands for this path.
 *   - OPT-IN `keys: 'int'` (integer keys): an OPEN-ADDRESSED typed-array index
 *     (`IntSlotStore`) for STRICT zero-alloc -- even the keyed index never
 *     allocates, with NO pre-fill caveat. This finally resolves D3 for integers.
 *
 * The DLL is not made of `{}` node objects. It is a set of parallel arrays indexed
 * by an integer SLOT (D2/D4): `_keys[]`, `_vals[]`, and two `Int32Array` link
 * columns `_next[]` / `_prev[]`. Because an LRU has a HARD capacity ceiling by
 * definition, all `capacity` slots are preallocated ONCE in the constructor and
 * reused forever -- no node is ever allocated on put, and eviction repurposes the
 * evicted slot in place. `LiteLru` is a THIN DLL policy over the store: it owns
 * `_head` / `_tail` / `_size`, caches references to the store's columns so the DLL
 * relinks stay direct, and calls the store for index and slot operations.
 *
 * A slot is in exactly one of two intrusive lists at a time, both threaded through
 * `_next[]` (D5):
 *   - the ACTIVE list: the recency order, head = MRU, tail = LRU (uses next+prev)
 *   - the FREE list:   a stack of unused slots (uses next only, prev ignored)
 * This is the same intrusive free list lite-signal uses for its node pool.
 *
 * Laws honored (suite CLAUDE.md):
 *   - Zero allocation on any hot path (get/put/delete/has/peek). Measured by the
 *     torture gate; the DLL/slot layer is strictly zero-alloc, and the int-key
 *     keyed index is strictly zero-alloc too (S3).
 *   - Fail closed: an invalid capacity throws at the door; an unknown `keys` value
 *     throws; a non-integer key in int mode throws; null is not zero.
 *   - ASCII-only source. Single file. Zero runtime deps.
 *
 * Design decisions live in decisions/ (D1..D10 in 0001; the onEvict reentrancy
 * contract in 0002; the substrate D11 in 0011) and are summarized in ROADMAP.md.
 */

/** Shared no-op eviction callback, so a cache without an onEvict handler
 *  references one function instance instead of allocating a closure per
 *  constructor call (same pattern as lite-object-pool's NOOP). */
const NOOP = () => {};

/** Sentinel for "no slot" -- used for empty head/tail, free-list end, and an
 *  empty open-addressed bucket. -1 because slots are non-negative indices, so it
 *  can never collide. */
const NIL = -1;

/** Message for the onEvict reentrancy guard (amends D8; decisions/0002). A mutating
 *  method called from within the onEvict callback would operate on the intrusive
 *  lists while an eviction is in flight; we fail CLOSED and reject it loudly
 *  rather than silently corrupt the structure. Built once, thrown only on misuse. */
const REENTRANT_MSG =
    "[lite-lru] a mutating method (put/get/delete/clear) was called from within " +
    "onEvict; the callback must not reenter this cache instance (use has/peek to read)";

/** Fail-closed message for a bad integer-mode key (decisions/0011). Built once. */
const INT_KEY_MSG =
    "[lite-lru] keys:'int' requires a 32-bit signed integer key, got ";

/** Accepted int-key domain bounds (decisions/0011): 32-bit signed integers. */
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

export const VERSION = "0.1.0";

/**
 * Fibonacci integer hash mix (decisions/0011). `Math.imul` is an EXACT 32-bit
 * multiply (zero-alloc), so sequential keys do not cluster; a shift-xor avalanche
 * spreads the high bits down. Returns a bucket index already masked to the table.
 */
function hashInt(key, mask) {
    let h = Math.imul(key | 0, 0x9e3779b1) >>> 0;
    h ^= h >>> 16;
    return h & mask;
}

/* -------------------------------------------------------------------------- *
 * SlotStore -- the shared substrate (decisions/0011, D11). INTERNAL, never an
 * export. Owns the SoA payload columns, the link columns a POLICY threads, and
 * the free stack. Subclasses supply the keyed index backing.
 * -------------------------------------------------------------------------- */

class SlotStore {
    constructor(capacity) {
        this._capacity = capacity;

        // The slot columns (D2/D4). Object arrays for the payload, Int32Array
        // link columns for the topology. Filling the object arrays makes them
        // PACKED_ELEMENTS rather than holey (V8 fast path -- see Learning/V8.md).
        this._keys = new Array(capacity).fill(undefined);
        this._vals = new Array(capacity).fill(undefined);
        this._next = new Int32Array(capacity); // active: toward LRU; free: next free
        this._prev = new Int32Array(capacity); // active: toward MRU (unused when free)

        // Build the initial FREE list: 0 -> 1 -> 2 -> ... -> capacity-1 -> NIL.
        for (let i = 0; i < capacity; i++) this._next[i] = i + 1;
        this._next[capacity - 1] = NIL;
        this._free = 0; // head of the free-slot stack
    }

    /** Pop a fresh slot off the free stack. Caller must know one exists
     *  (size < capacity guarantees it). */
    allocSlot() {
        const s = this._free;
        this._free = this._next[s]; // advance the free head
        return s;
    }

    /** Return a slot to the free stack and drop its payload refs so the cached
     *  key/value can be garbage-collected (retention hygiene -- a freed slot must
     *  not pin objects the cache no longer owns). */
    freeSlot(s) {
        this._keys[s] = undefined;
        this._vals[s] = undefined;
        this._next[s] = this._free;
        this._free = s;
    }

    /** Walk the free stack and return its length (test/debug only). */
    freeListLength() {
        let n = 0;
        for (let s = this._free; s !== NIL; s = this._next[s]) n++;
        return n;
    }

    /** Rebuild the free list, drop every payload ref, and clear the index.
     *  O(capacity); allocates nothing. */
    reset() {
        const cap = this._capacity;
        const keys = this._keys, vals = this._vals, next = this._next, prev = this._prev;
        for (let i = 0; i < cap; i++) {
            keys[i] = undefined;
            vals[i] = undefined;
            next[i] = i + 1;
            prev[i] = NIL;
        }
        next[cap - 1] = NIL;
        this._free = 0;
        this.clearIndex();
    }
}

/**
 * Map-backed keyed index (the DEFAULT, arbitrary keys). Honestly AMORTIZED: the
 * Map's internal resize can allocate. `get` returns NIL for an absent key so the
 * policy's miss test is a single `s < 0` for both backings.
 */
class MapSlotStore extends SlotStore {
    constructor(capacity) {
        super(capacity);
        // The hash half (D1/D3): key -> slot index. JS Map handles arbitrary key
        // types and SameValueZero equality for free. Amortized O(1).
        this._map = new Map();
    }
    get(key) { const s = this._map.get(key); return s === undefined ? NIL : s; }
    set(key, slot) { this._map.set(key, slot); }
    delete(key) { this._map.delete(key); }
    has(key) { return this._map.has(key); }
    clearIndex() { this._map.clear(); }
    indexSize() { return this._map.size; }
    indexEntries(cb) { for (const e of this._map) cb(e[0], e[1]); }
}

/**
 * Integer-key open-addressed keyed index (opt-in `keys: 'int'`), STRICT zero-alloc
 * (decisions/0011). Linear probing, backward-shift deletion (no tombstones), a
 * fixed table sized once at construction (load factor <= 0.75). Accepted domain:
 * 32-bit signed integers, validated at the door (fail-closed).
 */
class IntSlotStore extends SlotStore {
    constructor(capacity) {
        super(capacity);
        // Next power of two >= capacity / 0.75. Because size > capacity always, an
        // empty bucket ALWAYS exists (the cache holds <= capacity entries), so every
        // probe loop terminates.
        const need = Math.ceil(capacity / 0.75);
        let size = 1;
        while (size < need) size <<= 1;
        this._mask = size - 1;
        this._ixSlot = new Int32Array(size).fill(NIL); // bucket -> slot; NIL = empty
        this._ixKey = new Int32Array(size);            // bucket -> key (int32)
        this._count = 0;

        // The index never resizes: capacity is fixed, so the backing buffers are
        // fixed. Captured here; checkStable() asserts they never change.
        this._ixSlotBytes = this._ixSlot.buffer.byteLength;
        this._ixKeyBytes = this._ixKey.buffer.byteLength;
    }

    _ck(key) {
        if (!Number.isInteger(key) || key < INT_MIN || key > INT_MAX) {
            throw new TypeError(INT_KEY_MSG + String(key));
        }
    }

    get(key) {
        this._ck(key);
        const slots = this._ixSlot, ks = this._ixKey, mask = this._mask;
        let b = hashInt(key, mask);
        for (;;) {
            const s = slots[b];
            if (s === NIL) return NIL;   // empty bucket -> absent
            if (ks[b] === key) return s; // found
            b = (b + 1) & mask;          // linear probe
        }
    }

    set(key, slot) {
        this._ck(key);
        const slots = this._ixSlot, ks = this._ixKey, mask = this._mask;
        let b = hashInt(key, mask);
        for (;;) {
            const s = slots[b];
            if (s === NIL) { slots[b] = slot; ks[b] = key; this._count++; return; } // new
            if (ks[b] === key) { slots[b] = slot; return; }                          // update
            b = (b + 1) & mask;
        }
    }

    has(key) { return this.get(key) !== NIL; }

    delete(key) {
        this._ck(key);
        const slots = this._ixSlot, ks = this._ixKey, mask = this._mask;
        let b = hashInt(key, mask);
        for (;;) {
            const s = slots[b];
            if (s === NIL) return;      // absent
            if (ks[b] === key) break;   // found the bucket to empty
            b = (b + 1) & mask;
        }
        // Backward-shift deletion (no tombstones). `i` is the current hole; walk
        // the following cluster and pull back any entry whose ideal bucket `k` is
        // NOT cyclically within (i, j] -- otherwise it is already correctly placed.
        let i = b, j = b;
        for (;;) {
            j = (j + 1) & mask;
            const s = slots[j];
            if (s === NIL) break;       // end of the cluster
            const k = hashInt(ks[j], mask);
            const inRange = (j > i) ? (i < k && k <= j) : (i < k || k <= j);
            if (inRange) continue;      // entry j stays put
            slots[i] = s; ks[i] = ks[j];
            i = j;                      // the hole moves forward
        }
        slots[i] = NIL;
        this._count--;
    }

    clearIndex() { this._ixSlot.fill(NIL); this._count = 0; }
    indexSize() { return this._count; }
    indexEntries(cb) {
        const slots = this._ixSlot, ks = this._ixKey;
        for (let b = 0; b < slots.length; b++) if (slots[b] !== NIL) cb(ks[b], slots[b]);
    }

    /** validate() cross-check (decisions/0011): the index buffers are fixed at
     *  construction and must NEVER grow. Throws if either backing store resized. */
    checkStable() {
        if (this._ixSlot.buffer.byteLength !== this._ixSlotBytes ||
            this._ixKey.buffer.byteLength !== this._ixKeyBytes) {
            throw new Error(
                '[validate] int index buffer grew (must be fixed at construction)');
        }
    }
}

/* -------------------------------------------------------------------------- *
 * LiteLru -- a THIN doubly-linked-list POLICY over the store.
 * -------------------------------------------------------------------------- */

export class LiteLru {
    /**
     * @param {number} capacity  Max entries. Must be an integer >= 1.
     * @param {{ onEvict?: (key: any, value: any) => void, keys?: 'int' }} [options]
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

        // The keyed-index backing is chosen ONCE here (decisions/0011); each hot
        // path stays monomorphic. The store owns the columns + free stack.
        this._store = this._makeStore(capacity, options && options.keys);

        // Cache references to the store's columns so the DLL relinks stay direct
        // (and so test/debug introspection -- validate, torture -- keeps working).
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next; // active: toward LRU; free: next free
        this._prev = this._store._prev; // active: toward MRU (unused when free)

        this._head = NIL; // MRU end of the active list
        this._tail = NIL; // LRU end of the active list
        this._size = 0;

        // D8 -- optional zero-GC eviction hook (e.g. return the value to a pool).
        this._onEvict = (options && options.onEvict) || NOOP;

        // Reentrancy guard (amends D8; decisions/0002). True only while _onEvict is
        // executing. A mutating method entered during that window throws. A plain
        // boolean: zero allocation, one predicted-not-taken branch on the hot path.
        this._inOnEvict = false;
    }

    /** The store factory (decisions/0011). Fail closed on an unknown `keys` value.
     *  A member/control can override this to compose a different substrate. */
    _makeStore(capacity, keys) {
        if (keys === undefined) return new MapSlotStore(capacity);
        if (keys === 'int') return new IntSlotStore(capacity);
        throw new TypeError(
            "[lite-lru] unknown keys option " + String(keys) + " (did you mean 'int'?)");
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

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
     *          disambiguate, or peek().
     */
    get(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        // Slots are >= 0 and the store returns NIL (-1) for a miss, so `s < 0` is a
        // clean miss test for BOTH backings (do NOT use truthiness: slot 0 is valid).
        const s = this._store.get(key);
        if (s < 0) return undefined;
        this._moveToFront(s);
        return this._vals[s];
    }

    /**
     * Insert or update. On a new key at full capacity, evicts the LRU entry
     * first (and fires onEvict). Amortized O(1) (default backing) / O(1) (int).
     */
    put(key, value) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                  // update-in-place + promote
            this._vals[existing] = value;
            this._moveToFront(existing);
            return;
        }

        let s, evKey, evVal;
        let evicted = false;
        if (this._size === this._capacity) {
            // D6 -- evict the LRU (tail) and REUSE its slot in place, skipping a
            // free-list round trip. One unlink, one index delete, one relink.
            s = this._tail;
            evKey = this._keys[s];
            evVal = this._vals[s];
            this._detach(s);
            store.delete(evKey);
            this._size--;
            evicted = true;
        } else {
            s = store.allocSlot();
        }

        this._keys[s] = key;
        this._vals[s] = value;
        store.set(key, s);
        this._pushFront(s);
        this._size++;

        // Reentrancy fix (decisions/0002) -- fire onEvict LAST, when the cache is
        // fully consistent (the new entry is inserted, size restored). The guard
        // rejects any mutating reentry; because the cache is already consistent
        // here, that throw leaves it intact.
        if (evicted) {
            this._inOnEvict = true;
            try {
                this._onEvict(evKey, evVal);
            } finally {
                this._inOnEvict = false;
            }
        }
    }

    /** True if key is present. Does NOT change recency (D7). */
    has(key) { return this._store.has(key); }

    /** Read a value WITHOUT changing recency. undefined if absent. */
    peek(key) {
        const s = this._store.get(key);
        return s < 0 ? undefined : this._vals[s];
    }

    /**
     * Remove a key. Returns true if it was present. Frees the slot back to the
     * free stack, so the cache can sit below capacity again.
     */
    delete(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const store = this._store;
        const s = store.get(key);
        if (s < 0) return false;
        this._detach(s);
        store.delete(key);
        store.freeSlot(s);
        this._size--;
        return true;
    }

    /** Empty the cache. Rebuilds the free list; allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store.reset();
        this._head = NIL;
        this._tail = NIL;
        this._size = 0;
    }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store. Used by the torture suite's
     *  conservation invariant: `size + _freeListLength() === capacity`. */
    _freeListLength() {
        return this._store.freeListLength();
    }
}

export default LiteLru;
