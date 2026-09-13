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
 * This file also ships `Sieve` (decisions/0012), `S3Fifo` (decisions/0013) and
 * `WTinyLfu` (decisions/0014) as further named exports: modern eviction-policy
 * family members over the SAME substrate. They are NOT separate files -- single main
 * file + sideEffects:false + named exports already tree-shake away whichever member a
 * caller does not import.
 *
 * Design decisions live in decisions/ (D1..D10 in 0001; the onEvict reentrancy
 * contract in 0002; the substrate D11 in 0011; Sieve/D12 in 0012; S3-FIFO/D13 in
 * 0013; W-TinyLFU/D14 in 0014) and are summarized in ROADMAP.md.
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

/** S3-FIFO (decisions/0013) queue tags: which of the two intrusive rings a slot is
 *  in. Stored one byte per slot in `_q` so `_detach` can fix the RIGHT ring's
 *  head/tail without a per-slot object. A slot is in exactly one ring at a time. */
const Q_SMALL = 0;
const Q_MAIN = 1;

/** W-TinyLFU (decisions/0014) segment tags: which of the three intrusive LRU lists a
 *  slot is in (admission WINDOW / SLRU PROBATION / SLRU PROTECTED). Stored one byte
 *  per slot in `_seg` so `_detach` fixes the RIGHT list's head/tail without a per-slot
 *  object. A slot is in exactly one list at a time. */
const SEG_WINDOW = 0;
const SEG_PROBATION = 1;
const SEG_PROTECTED = 2;

/** W-TinyLFU count-min sketch shape (decisions/0014, D14.2): 4 rows of 4-bit
 *  saturating counters packed 8-per-Uint32. One per-row seed spreads a key across the
 *  rows; `Math.imul` keeps each mix an EXACT 32-bit multiply (zero-alloc). Built once. */
const SK_ROWS = 4;
const SK_SEEDS = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f];

/** SameValueZero key comparison (mirrors JS Map/Set): `===` plus NaN matches NaN,
 *  and -0 matches +0. Used only on the COLD S3-FIFO ghost-consume scan for the
 *  default (arbitrary-key) backing, never on a hot path. */
function sameKey(a, b) { return a === b || (a !== a && b !== b); }

/** TTL (decisions/0017). A per-put `ttlMs` on a cache that was NOT constructed with a
 *  `ttl` option is a caller bug: no `_exp` column exists to stamp it. Fail closed.
 *  Built once, thrown only on misuse. */
const TTL_NO_COLUMN_MSG =
    "[lite-lru] put(key, value, ttlMs) requires the cache to be constructed with a " +
    "{ ttl } option; this instance has no ttl configured";

/**
 * Validate the optional injectable `clock` (decisions/0017, D17.2): a hoisted zero-arg
 * function returning ms, or `undefined` for the `Date.now` default. Anything else fails
 * closed at the door. Returns the resolved clock function.
 */
function validateClock(clock) {
    if (clock === undefined) return Date.now;
    if (typeof clock !== "function") {
        throw new TypeError(
            "[lite-lru] clock must be a zero-arg function returning ms, got " + String(clock));
    }
    return clock;
}

/**
 * Validate a ttl duration in ms (decisions/0017, D17.1/D17.4): a POSITIVE FINITE number,
 * or `Infinity` for never-expire. `<= 0` / `NaN` / non-number fail closed (RangeError).
 * `undefined` means "no ttl default" and is returned as-is (the caller decides).
 */
function validateTtl(ttl) {
    if (ttl === undefined) return undefined;
    if (ttl === Infinity) return Infinity;
    if (typeof ttl !== "number" || !(ttl > 0) || !Number.isFinite(ttl)) {
        throw new RangeError(
            "[lite-lru] ttl must be a positive number of ms or Infinity, got " + String(ttl));
    }
    return ttl;
}

/**
 * Compute the absolute expiry timestamp for a put (decisions/0017, D17.1/D17.4). `ttlMs`
 * omitted -> the instance default `ttl`; `Infinity` -> never (Infinity, NEVER 0); else
 * `now() + ttlMs`. A per-put `ttlMs` is validated fail-closed (positive-finite-or-Infinity).
 * Only ever called when a `_exp` column exists (the ttl-on path).
 */
function expiryFor(clock, ttl, ttlMs) {
    if (ttlMs === undefined) return ttl === Infinity ? Infinity : clock() + ttl;
    if (ttlMs === Infinity) return Infinity;
    if (typeof ttlMs !== "number" || !(ttlMs > 0) || !Number.isFinite(ttlMs)) {
        throw new RangeError(
            "[lite-lru] ttlMs must be a positive number of ms or Infinity, got " + String(ttlMs));
    }
    return clock() + ttlMs;
}

/** Iteration modes (decisions/0018, D18.2). The ONE shared hand-written iterator
 *  branches on these instead of shipping three near-identical walkers. */
const ITER_KEYS = 0;
const ITER_VALUES = 1;
const ITER_ENTRIES = 2;

/** Fail-closed message for mutation-during-iteration (decisions/0018, D18.6). Built
 *  once, thrown only when a walk observes a structural mutation (a bumped `_ver`). */
const ITER_MUTATED_MSG =
    "[lite-lru] cache was structurally mutated during iteration " +
    "(put/delete/clear/evict/reap); an iterator is invalid after any such change";

export const VERSION = "1.4.0";

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
    constructor(capacity, hasTtl) {
        this._capacity = capacity;

        // The slot columns (D2/D4). Object arrays for the payload, Int32Array
        // link columns for the topology. Filling the object arrays makes them
        // PACKED_ELEMENTS rather than holey (V8 fast path -- see Learning/V8.md).
        this._keys = new Array(capacity).fill(undefined);
        this._vals = new Array(capacity).fill(undefined);
        this._next = new Int32Array(capacity); // active: toward LRU; free: next free
        this._prev = new Int32Array(capacity); // active: toward MRU (unused when free)

        // TTL expiry column (decisions/0017, D17.1). PAY-FOR-WHAT-YOU-USE: allocated
        // ONLY when a `ttl` option was supplied; `null` otherwise so the ttl-OFF hot
        // path stays byte-identical. A ms timestamp per slot; never-expire = Infinity
        // (NEVER 0), so a fresh/freed slot defaults to never-expire, not expired-at-0.
        this._exp = hasTtl ? new Float64Array(capacity).fill(Infinity) : null;

        // Build the initial FREE list: 0 -> 1 -> 2 -> ... -> capacity-1 -> NIL.
        for (let i = 0; i < capacity; i++) this._next[i] = i + 1;
        this._next[capacity - 1] = NIL;
        this._free = 0; // head of the free-slot stack

        // Structural-mutation version (decisions/0018, D18.6). A monotone integer bumped
        // ONLY by structural mutations (put/delete/clear/_reap/_evict on the composing
        // policy), NEVER on the get/has/peek read path. An iterator captures it at
        // construction and re-checks it in next() to fail closed on mutation-mid-walk.
        this._ver = 0;
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
        if (this._exp !== null) this._exp[s] = Infinity; // drop the expiry (decisions/0017)
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
        if (this._exp !== null) this._exp.fill(Infinity); // reset expiries (decisions/0017)
        this.clearIndex();
    }
}

/**
 * Map-backed keyed index (the DEFAULT, arbitrary keys). Honestly AMORTIZED: the
 * Map's internal resize can allocate. `get` returns NIL for an absent key so the
 * policy's miss test is a single `s < 0` for both backings.
 */
class MapSlotStore extends SlotStore {
    constructor(capacity, hasTtl) {
        super(capacity, hasTtl);
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
    constructor(capacity, hasTtl) {
        super(capacity, hasTtl);
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

/**
 * The shared store factory (decisions/0011). Fail closed on an unknown `keys`
 * value. Both `LiteLru` and `Sieve` (decisions/0012) ride this ONE factory so the
 * keyed-index backing choice + int-key door stay identical across the family.
 */
function newStore(capacity, keys, hasTtl) {
    if (keys === undefined) return new MapSlotStore(capacity, hasTtl);
    if (keys === 'int') return new IntSlotStore(capacity, hasTtl);
    throw new TypeError(
        "[lite-lru] unknown keys option " + String(keys) + " (did you mean 'int'?)");
}

/* -------------------------------------------------------------------------- *
 * CacheIterator -- the ONE shared, hand-written, zero-GC iterator every member
 * composes (decisions/0018, D18). INTERNAL, never an export.
 *
 * D18.2 -- NO generators: a generator allocates an IteratorResult per yield. This
 * reuses a SINGLE `{value,done}` result object across every next() call; `entries`
 * additionally reuses a BORROWED 2-element `[key,value]` tuple (copy what you keep;
 * `Array.from`/a manual copy materializes -- a plain spread aliases the last pair).
 * `keys`/`values` yield the scalar directly. The iterator OBJECT itself is allocated
 * ONCE per keys()/values()/entries() call (cold), never per step.
 *
 * The walk is uniform: a per-member ROSTER of head slots (mirrors how validate()'s
 * activeListsOf enumerates the intrusive lists), each walked head -> _next -> NIL.
 * D18.4 recency-neutral: the walk applies NO promote / visited bump / sketch bump /
 * segment relink (exactly like peek). D18.5 TTL: a stale slot is SKIPPED (invisible)
 * but never reaped -- iteration performs no structural mutation, so `size` is
 * unchanged by a walk (use purgeStale() to reclaim). D18.6 fail-closed: the store's
 * `_ver` is captured here and re-checked in next(); any structural mutation bumps it
 * and the next step throws.
 * -------------------------------------------------------------------------- */

class CacheIterator {
    constructor(cache, mode, heads) {
        this._store = cache._store;
        this._ver = cache._store._ver;   // D18.6 -- captured once, re-checked per step
        this._nextCol = cache._next;
        this._keysCol = cache._keys;
        this._valsCol = cache._vals;
        this._exp = cache._exp;          // ttl expiry column; null when ttl is off (D17)
        this._clock = cache._clock;
        this._mode = mode;
        this._heads = heads;             // roster of head slots (built once per call, cold)
        this._hi = 0;                    // index into the roster
        this._slot = NIL;                // current slot; NIL -> advance to the next head
        this._result = { value: undefined, done: false }; // reused across every next()
        this._pair = mode === ITER_ENTRIES ? [undefined, undefined] : null; // borrowed tuple
    }

    next() {
        // D18.6 -- fail closed on a structural mutation observed mid-walk.
        if (this._store._ver !== this._ver) throw new Error(ITER_MUTATED_MSG);
        const res = this._result;
        const nextCol = this._nextCol, keys = this._keysCol, exp = this._exp, heads = this._heads;
        let s = this._slot;
        for (;;) {
            if (s === NIL) {
                if (this._hi >= heads.length) {
                    res.value = undefined; res.done = true;
                    // D18.2 -- an exhausted iterator must pin NOTHING (null is not zero):
                    // release the borrowed tuple's refs so a retained-but-drained iterator
                    // holds no key/value. Cold: once per walk, zero per-step cost.
                    const p = this._pair;
                    if (p !== null) { p[0] = undefined; p[1] = undefined; }
                    return res;
                }
                s = heads[this._hi++]; // start the next roster list (may itself be NIL/empty)
                continue;
            }
            const nx = nextCol[s];
            // D18.5 -- SKIP a stale entry (invisible to iteration); NEVER reap it here.
            if (exp !== null && exp[s] <= this._clock()) { s = nx; continue; }
            this._slot = nx;
            const mode = this._mode;
            if (mode === ITER_KEYS) res.value = keys[s];
            else if (mode === ITER_VALUES) res.value = this._valsCol[s];
            else { const p = this._pair; p[0] = keys[s]; p[1] = this._valsCol[s]; res.value = p; }
            res.done = false;
            return res;
        }
    }

    [Symbol.iterator]() { return this; }
}

/** Build a keys/values/entries iterator over a member (decisions/0018). The roster is
 *  the member's `_iterHeads()`; the shared CacheIterator does the rest. Cold (called
 *  once per keys()/values()/entries()); never a hot path. */
function iterKeys(cache) { return new CacheIterator(cache, ITER_KEYS, cache._iterHeads()); }
function iterValues(cache) { return new CacheIterator(cache, ITER_VALUES, cache._iterHeads()); }
function iterEntries(cache) { return new CacheIterator(cache, ITER_ENTRIES, cache._iterHeads()); }

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

        // TTL (decisions/0017). Validated fail-closed at the door. `_ttl === undefined`
        // means no ttl (the `_exp` column is never allocated -- pay-for-what-you-use).
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // The keyed-index backing is chosen ONCE here (decisions/0011); each hot
        // path stays monomorphic. The store owns the columns + free stack (and the
        // opt-in `_exp` ttl column).
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined);

        // Cache references to the store's columns so the DLL relinks stay direct
        // (and so test/debug introspection -- validate, torture -- keeps working).
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next; // active: toward LRU; free: next free
        this._prev = this._store._prev; // active: toward MRU (unused when free)
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

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

    /** The store factory (decisions/0011), delegating to the shared `newStore` so
     *  every family member composes the SAME substrate + int-key door. A
     *  member/control can override this to compose a different substrate. */
    _makeStore(capacity, keys, hasTtl) {
        return newStore(capacity, keys, hasTtl);
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
        // TTL gate (decisions/0017, D17.3): a stale hit is a MISS -- no promotion,
        // reaped in place (fires onEvict). Only reached when ttl is configured.
        if (this._exp !== null && this._exp[s] <= this._clock()) { this._reap(s); return undefined; }
        this._moveToFront(s);
        return this._vals[s];
    }

    /**
     * Insert or update. On a new key at full capacity, evicts the LRU entry
     * first (and fires onEvict). Amortized O(1) (default backing) / O(1) (int).
     * The optional positional `ttlMs` (decisions/0017, D17.4) overrides the instance
     * ttl default for THIS entry: a positive number of ms, `Infinity` for never, or
     * omitted for the default. Passing `ttlMs` on a non-ttl instance fails closed.
     */
    put(key, value, ttlMs) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        let expiresAt;
        if (this._exp !== null) expiresAt = expiryFor(this._clock, this._ttl, ttlMs);
        else if (ttlMs !== undefined) throw new Error(TTL_NO_COLUMN_MSG); // fail closed (D17.4)
        this._store._ver++; // D18.6 -- put mutates (update/insert/evict); invalidate iterators
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                  // update-in-place + promote
            this._vals[existing] = value;
            if (this._exp !== null) this._exp[existing] = expiresAt; // restamp (D17)
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
        if (this._exp !== null) this._exp[s] = expiresAt; // stamp the expiry (D17)
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

    /** True if key is present. Does NOT change recency (D7). A stale entry is a MISS
     *  and is reaped in place (decisions/0017, D17.3). */
    has(key) {
        const s = this._store.get(key);
        if (s < 0) return false;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s); // never nest onEvict (fail closed)
            return false;
        }
        return true;
    }

    /** Read a value WITHOUT changing recency. undefined if absent. A stale entry is a
     *  MISS and is reaped in place (decisions/0017, D17.3). */
    peek(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return undefined;
        }
        return this._vals[s];
    }

    /** Reap an expired slot in place (decisions/0017): unlink, drop from the index,
     *  free the slot, and fire onEvict LAST via the 0002 guard (cache consistent). */
    _reap(s) {
        this._store._ver++; // D18.6 -- a reap is a structural mutation; invalidate iterators
        const evKey = this._keys[s];
        const evVal = this._vals[s];
        this._detach(s);
        this._store.delete(evKey);
        this._store.freeSlot(s);
        this._size--;
        this._inOnEvict = true;
        try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
    }

    /**
     * Evict every expired resident entry now (decisions/0017, D17.5). COLD, O(size):
     * never a hot path, so it MAY allocate a small victim list. Fires onEvict per
     * victim (0002 fire-after + reentrancy guard) and returns the count evicted.
     */
    purgeStale() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG);
        if (this._exp === null) return 0;
        const now = this._clock();
        const exp = this._exp;
        const victims = [];
        this._store.indexEntries((key, slot) => { if (exp[slot] <= now) victims.push(slot); });
        for (let i = 0; i < victims.length; i++) this._reap(victims[i]);
        return victims.length;
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
        store._ver++; // D18.6 -- a real delete is a structural mutation; invalidate iterators
        this._detach(s);
        store.delete(key);
        store.freeSlot(s);
        this._size--;
        return true;
    }

    /** Empty the cache. Rebuilds the free list; allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._head = NIL;
        this._tail = NIL;
        this._size = 0;
    }

    // --- iteration (decisions/0018, D18): zero-GC keys/values/entries ----------

    /** The per-member iteration ROSTER (decisions/0018, D18.1). LiteLru is one recency
     *  DLL walked MRU (head) -> LRU (tail): the ONLY member whose order is true recency. */
    _iterHeads() { return [this._head]; }

    /** Keys in iteration order (decisions/0018). Zero-GC per step; yields the key
     *  scalar directly. Recency-neutral (D18.4); skips stale entries (D18.5). */
    keys() { return iterKeys(this); }
    /** Values in iteration order (decisions/0018). Zero-GC per step; yields the value
     *  directly. Recency-neutral (D18.4); skips stale entries (D18.5). */
    values() { return iterValues(this); }
    /** [key, value] pairs in iteration order (decisions/0018). Zero-GC per step: the
     *  yielded 2-element tuple is BORROWED and reused -- copy what you keep. */
    entries() { return iterEntries(this); }
    /** Iterable protocol: identical to entries() (matches Map). */
    [Symbol.iterator]() { return iterEntries(this); }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store. Used by the torture suite's
     *  conservation invariant: `size + _freeListLength() === capacity`. */
    _freeListLength() {
        return this._store.freeListLength();
    }
}

/* -------------------------------------------------------------------------- *
 * Sieve -- a lazy-promotion FIFO policy over the SAME SlotStore substrate
 * (decisions/0012, D12). The first modern eviction-policy family member; ships as
 * a SECOND named export in this file (the file-shape ruling: single main file +
 * sideEffects:false + named exports already deliver the tree-shake moat).
 *
 * SIEVE (Zhang et al., NSDI'24 -- "SIEVE is simpler than LRU") is a FIFO-order
 * ring with ONE visited bit per entry and ONE moving hand:
 *   - a HIT sets the entry's visited bit and does NOTHING structural (zero
 *     relinks -- the headline; classic LRU relinks a small constant per interior
 *     or tail hit). "Bytes in a hot body, not instructions" -> D12 keeps the
 *     visited column a `Uint8Array`, so a hit is ONE store, no mask/shift.
 *   - new entries insert at the HEAD of FIFO order (the newest end).
 *   - on insert-at-capacity the hand sweeps from its CURRENT position (it does
 *     NOT reset): a visited entry gets a SECOND CHANCE (bit cleared, hand
 *     advances toward the head); the first UNVISITED entry is the victim, evicted
 *     in place; the hand parks where it stopped and persists across evictions.
 *
 * Rides the SAME substrate as LiteLru: default Map backing, opt-in `keys:'int'`
 * strict-zero backing (via the shared `newStore` factory + the same
 * `[lite-lru]`-tagged int-key door), the shared conservation invariant, and the
 * onEvict fire-after + `_inOnEvict` reentrancy guard (decisions/0002). The ring is
 * threaded through the SAME `_next`/`_prev` columns: `_next` toward the tail
 * (older), `_prev` toward the head (newer).
 * -------------------------------------------------------------------------- */

export class Sieve {
    /**
     * @param {number} capacity  Max entries. Must be an integer >= 1.
     * @param {{ onEvict?: (key: any, value: any) => void, keys?: 'int' }} [options]
     */
    constructor(capacity, options) {
        // Fail closed (D9), identical to LiteLru: a non-integer or < 1 capacity is
        // a caller bug, thrown at the door with a library-tagged error.
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new RangeError(
                "[lite-lru] capacity must be an integer >= 1, got " + String(capacity)
            );
        }

        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed at the door -- identical to LiteLru.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as LiteLru (decisions/0011, 0012).
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined);

        // Cache the store's columns so the ring relinks stay direct (and so the
        // conservation invariant + torture introspection keep working).
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next; // toward the tail (older)
        this._prev = this._store._prev; // toward the head (newer)
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // D12 -- the visited column: one byte per slot, so a hit is a single store
        // with no mask/shift. Fixed size, allocated once, never grown.
        this._vis = new Uint8Array(capacity);

        this._head = NIL; // FIFO head -- the newest insertion point
        this._tail = NIL; // FIFO tail -- the oldest
        this._hand = NIL;  // the sweeping hand; NIL means "start from the tail"
        this._size = 0;

        this._onEvict = (options && options.onEvict) || NOOP;
        this._inOnEvict = false;
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl) {
        return newStore(capacity, keys, hasTtl);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- intrusive ring helpers (same shape as LiteLru's DLL) -----------------

    /** Unlink slot s from the ring, fixing neighbours + head/tail sentinels. */
    _detach(s) {
        const p = this._prev[s];
        const n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._head = n; // s was head
        if (n !== NIL) this._prev[n] = p; else this._tail = p; // s was tail
    }

    /** Insert slot s at the head (newest end) of the ring. */
    _pushFront(s) {
        this._prev[s] = NIL;
        this._next[s] = this._head;
        if (this._head !== NIL) this._prev[this._head] = s;
        this._head = s;
        if (this._tail === NIL) this._tail = s; // first element -> also the tail
    }

    /**
     * The SIEVE sweep: from the hand (or the tail when the hand is unset), grant
     * each visited entry a SECOND CHANCE (clear its bit, advance toward the head,
     * wrapping to the tail), and return the first UNVISITED slot -- the victim.
     * Terminates: each step either exits or clears a bit, and after a full ring
     * traversal every bit is 0, so a cleared slot is reached. Zero-alloc.
     */
    _sweepVictim() {
        let o = this._hand !== NIL ? this._hand : this._tail;
        while (this._vis[o] === 1) {
            this._vis[o] = 0;
            o = this._prev[o] !== NIL ? this._prev[o] : this._tail;
        }
        return o;
    }

    // --- public API (all O(1) amortized, all zero-alloc on the hot path) -------

    /**
     * Look up a key AND mark it visited (SIEVE's second-chance flag). Unlike LRU's
     * get this does NOTHING structural -- one `_vis` store, no relink, hand
     * untouched (the headline). @returns the value, or undefined if absent (see D7).
     */
    get(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const s = this._store.get(key);
        if (s < 0) return undefined;
        // TTL gate (decisions/0017, D17.3): a stale hit is a MISS -- no visited bump,
        // reaped in place. Only reached when ttl is configured.
        if (this._exp !== null && this._exp[s] <= this._clock()) { this._reap(s); return undefined; }
        this._vis[s] = 1; // the whole hot path: a single byte store
        return this._vals[s];
    }

    /**
     * Insert or update. An update rewrites the value and sets visited (an update is
     * a write -> it matches a hit). A new key at capacity sweeps for the victim
     * (second chance for visited entries), evicts it in place, and inserts the
     * newcomer UNVISITED at the head. onEvict fires LAST (decisions/0002). The optional
     * positional `ttlMs` (decisions/0017, D17.4) overrides the instance ttl default.
     */
    put(key, value, ttlMs) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        let expiresAt;
        if (this._exp !== null) expiresAt = expiryFor(this._clock, this._ttl, ttlMs);
        else if (ttlMs !== undefined) throw new Error(TTL_NO_COLUMN_MSG); // fail closed (D17.4)
        this._store._ver++; // D18.6 -- put mutates (update/insert/evict); invalidate iterators
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                 // update-in-place + mark visited
            this._vals[existing] = value;
            if (this._exp !== null) this._exp[existing] = expiresAt; // restamp (D17)
            this._vis[existing] = 1;
            return;
        }

        let s, evKey, evVal;
        let evicted = false;
        if (this._size === this._capacity) {
            // SIEVE eviction: sweep for the first unvisited slot, then reuse it in
            // place for the newcomer (D6 -- skip a free-list round trip).
            const victim = this._sweepVictim();
            evKey = this._keys[victim];
            evVal = this._vals[victim];
            const parkTarget = this._prev[victim]; // toward the head
            this._detach(victim);
            store.delete(evKey);
            // Park the hand toward the head, wrapping to the (post-detach) tail; it
            // PERSISTS across evictions (it does not reset). NIL only when the ring
            // just emptied (a capacity-1 cache), repaired by the reinsert below.
            this._hand = parkTarget !== NIL ? parkTarget : this._tail;
            this._size--;
            s = victim;
            evicted = true;
        } else {
            s = store.allocSlot();
        }

        this._keys[s] = key;
        this._vals[s] = value;
        if (this._exp !== null) this._exp[s] = expiresAt; // stamp the expiry (D17)
        this._vis[s] = 0; // a newcomer starts UNVISITED
        store.set(key, s);
        this._pushFront(s);
        this._size++;

        // Fire onEvict LAST, cache fully consistent (decisions/0002). The guard
        // rejects any mutating reentry; the cache is already whole here.
        if (evicted) {
            this._inOnEvict = true;
            try {
                this._onEvict(evKey, evVal);
            } finally {
                this._inOnEvict = false;
            }
        }
    }

    /** True if key is present. Visited-NEUTRAL: it does NOT grant a second chance. A
     *  stale entry is a MISS and is reaped in place (decisions/0017, D17.3). */
    has(key) {
        const s = this._store.get(key);
        if (s < 0) return false;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return false;
        }
        return true;
    }

    /** Read a value WITHOUT setting visited. undefined if absent (see D7). A stale entry
     *  is a MISS and is reaped in place (decisions/0017, D17.3). */
    peek(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return undefined;
        }
        return this._vals[s];
    }

    /** Reap an expired slot in place (decisions/0017): repair the hand (mirrors delete),
     *  unlink, drop from the index, zero the visited byte, free the slot, and fire
     *  onEvict LAST via the 0002 guard (cache consistent). */
    _reap(s) {
        this._store._ver++; // D18.6 -- a reap is a structural mutation; invalidate iterators
        const evKey = this._keys[s];
        const evVal = this._vals[s];
        if (this._hand === s) {
            let h = this._prev[s];
            if (h === NIL) h = this._next[s];
            this._hand = h;
        }
        this._detach(s);
        this._store.delete(evKey);
        this._vis[s] = 0;
        this._store.freeSlot(s);
        this._size--;
        this._inOnEvict = true;
        try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
    }

    /** Evict every expired resident entry now (decisions/0017, D17.5). COLD, O(size);
     *  fires onEvict per victim (0002) and returns the count evicted. */
    purgeStale() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG);
        if (this._exp === null) return 0;
        const now = this._clock();
        const exp = this._exp;
        const victims = [];
        this._store.indexEntries((key, slot) => { if (exp[slot] <= now) victims.push(slot); });
        for (let i = 0; i < victims.length; i++) this._reap(victims[i]);
        return victims.length;
    }

    /**
     * Remove a key. Returns true if it was present. Frees the slot, zeroes its
     * visited byte, and REPAIRS the hand when the hand's own slot dies (advance to
     * a valid neighbour, or NIL when the ring empties) -- fail closed, never a
     * dangling hand.
     */
    delete(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const store = this._store;
        const s = store.get(key);
        if (s < 0) return false;
        store._ver++; // D18.6 -- a real delete is a structural mutation; invalidate iterators
        // Repair the hand BEFORE detaching (its links are read here): move toward
        // the head, else toward the tail, else NIL when this was the only slot.
        if (this._hand === s) {
            let h = this._prev[s];
            if (h === NIL) h = this._next[s];
            this._hand = h;
        }
        this._detach(s);
        store.delete(key);
        this._vis[s] = 0;
        store.freeSlot(s);
        this._size--;
        return true;
    }

    /** Empty the cache. Rebuilds the free list, zeroes visited, resets the hand.
     *  Allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._vis.fill(0);
        this._head = NIL;
        this._tail = NIL;
        this._hand = NIL;
        this._size = 0;
    }

    // --- iteration (decisions/0018, D18): zero-GC keys/values/entries ----------

    /** The per-member iteration ROSTER (decisions/0018, D18.1). SIEVE is one FIFO ring
     *  walked newest (head) -> oldest (tail) -- FIFO insertion order, NOT recency. */
    _iterHeads() { return [this._head]; }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store (conservation invariant). */
    _freeListLength() {
        return this._store.freeListLength();
    }

    /**
     * The key the NEXT over-capacity insert would evict, computed WITHOUT mutating
     * any bit or link (the sweep's non-destructive twin). Same victim `_sweepVictim`
     * would pick: the first unvisited slot from the hand, or the hand/tail start
     * itself when every entry is visited. Drives the torture differential.
     */
    _peekVictim() {
        if (this._size === 0) return undefined;
        const start = this._hand !== NIL ? this._hand : this._tail;
        let o = start;
        for (;;) {
            if (this._vis[o] === 0) return this._keys[o];
            o = this._prev[o] !== NIL ? this._prev[o] : this._tail;
            if (o === start) return this._keys[start]; // all visited -> start is the victim
        }
    }
}

/* -------------------------------------------------------------------------- *
 * S3Fifo -- the S3-FIFO admission policy (Yang et al., SOSP'23), 1-bit visited
 * variant, over the SAME SlotStore substrate (decisions/0013, D13). The third
 * named export in this file (same file-shape ruling as Sieve: single main file +
 * sideEffects:false + named exports = the tree-shake moat).
 *
 * S3-FIFO is THREE FIFO structures with a per-entry visited bit:
 *   - SMALL (probation) ring + MAIN ring, both threaded intrusively through the
 *     shared `_next`/`_prev` columns (two separate rings, each with its own
 *     head/tail). `_next` toward the tail (older), `_prev` toward the head (newer).
 *     A slot is in exactly ONE ring (or free); `_q[slot]` tags which (D13).
 *   - `_vis` Uint8Array: one visited byte per slot (a hit is a single store, the
 *     Sieve headline -- see decisions/0012's Uint8Array-over-bitpack ruling).
 *   - GHOST: a keys-only, bounded FIFO of recently small-evicted keys. NEVER stores
 *     values (retention hygiene, D13). Its job is admission: a key seen again while
 *     still in ghost is deemed hot and enters MAIN directly, skipping probation.
 *
 * Sizing (D13, frozen in the constructor):
 *   smallCap = max(1, floor(capacity/10));  mainCap = capacity - smallCap;
 *   ghostCap = mainCap.
 * Capacity 1 (smallCap 1, mainCap 0, ghostCap 0) degenerates to a 1-bit
 * second-chance FIFO over SMALL: a visited single entry graduates into a
 * zero-capacity MAIN and is evicted from there in the same eviction step, so it can
 * never retain more than one key -- impl and oracle agree on this edge (D13).
 *
 * Hot paths (get / put-update / has / peek): a resident hit sets `_vis[s]=1` and
 * MOVES NOTHING (0 relinks -- the headline). has/peek are visited-NEUTRAL. All
 * strictly zero-alloc; the int-key ghost is strict-zero too (typed-array ring +
 * open-addressed membership table, sized once). The default (Map) backing's ghost
 * is a Set + array ring: honestly AMORTIZED (a Set resize can allocate), the SAME
 * caveat D3/D11 already state for the Map keyed index.
 *
 * Rides the shared `newStore` factory: default Map backing, opt-in `keys:'int'`
 * strict-zero backing, the same `[lite-lru]`-tagged int-key door, the shared
 * conservation invariant, and the onEvict fire-after + `_inOnEvict` reentrancy
 * guard (decisions/0002).
 * -------------------------------------------------------------------------- */

export class S3Fifo {
    /**
     * @param {number} capacity  Max entries. Must be an integer >= 1.
     * @param {{ onEvict?: (key: any, value: any) => void, keys?: 'int' }} [options]
     */
    constructor(capacity, options) {
        // Fail closed (D9), identical to LiteLru/Sieve.
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new RangeError(
                "[lite-lru] capacity must be an integer >= 1, got " + String(capacity)
            );
        }

        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed at the door -- identical to LiteLru.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as the rest of the family.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined);

        // Cache the store's columns so the ring relinks stay direct (and so the
        // conservation invariant + torture introspection keep working).
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next; // toward the tail (older)
        this._prev = this._store._prev; // toward the head (newer)
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // D13 -- one visited byte per slot (a hit is a single store, no mask/shift),
        // and one queue tag per slot so `_detach` fixes the correct ring. Both fixed
        // size, allocated once, never grown.
        this._vis = new Uint8Array(capacity);
        this._q = new Uint8Array(capacity);

        // D13 -- the SMALL/MAIN split. smallCap is at least 1; mainCap/ghostCap are 0
        // only at capacity 1 (the degenerate second-chance-FIFO edge, documented above).
        this._smallCap = Math.max(1, Math.floor(capacity / 10));
        this._mainCap = capacity - this._smallCap;
        this._ghostCap = this._mainCap;

        this._sHead = NIL; this._sTail = NIL; this._sSize = 0; // SMALL ring
        this._mHead = NIL; this._mTail = NIL; this._mSize = 0; // MAIN ring
        this._size = 0;                                        // _sSize + _mSize

        // Ghost backing (D13): int -> strict-zero open-addressed membership table +
        // a pow2 Int32 FIFO ring (masked indices). default -> a Set membership +
        // arbitrary-key array ring (amortized: a Set resize can allocate).
        this._ghostInt = (options && options.keys) === 'int';
        if (this._ghostCap > 0) {
            if (this._ghostInt) {
                const need = Math.ceil(this._ghostCap / 0.75);
                let gs = 1;
                while (gs < need) gs <<= 1;
                this._gixMask = gs - 1;
                this._gixKey = new Int32Array(gs);
                this._gixState = new Uint8Array(gs); // 0 = empty, 1 = occupied
                let rs = 1;
                while (rs < this._ghostCap) rs <<= 1; // pow2 ring so indices mask
                this._gRingMask = rs - 1;
                this._gRing = new Int32Array(rs);
            } else {
                this._gSet = new Set();                     // key -> nothing (membership)
                this._gRingArr = new Array(this._ghostCap).fill(undefined); // FIFO order
            }
        }
        this._gHead = 0; // ring index of the OLDEST ghost key
        this._gLen = 0;  // live ghost entries (0 .. ghostCap)

        this._onEvict = (options && options.onEvict) || NOOP;
        this._inOnEvict = false;
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl) {
        return newStore(capacity, keys, hasTtl);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- intrusive ring helpers (size accounting lives here) ------------------

    /** Unlink slot s from WHICHEVER ring it is in (per `_q[s]`), fixing that ring's
     *  neighbours + head/tail sentinels + size. */
    _detach(s) {
        const p = this._prev[s];
        const n = this._next[s];
        if (this._q[s] === Q_SMALL) {
            if (p !== NIL) this._next[p] = n; else this._sHead = n;
            if (n !== NIL) this._prev[n] = p; else this._sTail = p;
            this._sSize--;
        } else {
            if (p !== NIL) this._next[p] = n; else this._mHead = n;
            if (n !== NIL) this._prev[n] = p; else this._mTail = p;
            this._mSize--;
        }
    }

    /** Insert slot s at the head (newest end) of the SMALL ring. */
    _pushSmall(s) {
        this._q[s] = Q_SMALL;
        this._prev[s] = NIL;
        this._next[s] = this._sHead;
        if (this._sHead !== NIL) this._prev[this._sHead] = s;
        this._sHead = s;
        if (this._sTail === NIL) this._sTail = s;
        this._sSize++;
    }

    /** Insert slot s at the head (newest end) of the MAIN ring. */
    _pushMain(s) {
        this._q[s] = Q_MAIN;
        this._prev[s] = NIL;
        this._next[s] = this._mHead;
        if (this._mHead !== NIL) this._prev[this._mHead] = s;
        this._mHead = s;
        if (this._mTail === NIL) this._mTail = s;
        this._mSize++;
    }

    // --- ghost helpers (keys only, bounded; int path strictly zero-alloc) -----

    /** True if key is a recently-evicted-from-small ghost key (admission -> MAIN). */
    _ghostHas(key) {
        if (this._ghostCap === 0) return false;
        if (this._ghostInt) {
            const st = this._gixState, ks = this._gixKey, mask = this._gixMask;
            let b = hashInt(key, mask);
            for (;;) {
                if (st[b] === 0) return false;
                if (ks[b] === key) return true;
                b = (b + 1) & mask;
            }
        }
        return this._gSet.has(key);
    }

    /** Record a small-evicted key in the ghost FIFO, evicting the oldest ghost key
     *  first when full. Zero-alloc on the int path. */
    _ghostAdd(key) {
        const cap = this._ghostCap;
        if (cap === 0) return;
        if (this._gLen === cap) {
            // bounded: drop the oldest ghost key (both membership and ring slot).
            if (this._ghostInt) {
                this._ghostMemDel(this._gRing[this._gHead]);
                this._gHead = (this._gHead + 1) & this._gRingMask;
            } else {
                const old = this._gRingArr[this._gHead];
                this._gSet.delete(old);
                this._gRingArr[this._gHead] = undefined; // drop the key ref
                this._gHead = (this._gHead + 1) % cap;
            }
            this._gLen--;
        }
        if (this._ghostInt) {
            const pos = (this._gHead + this._gLen) & this._gRingMask;
            this._gRing[pos] = key;
            this._ghostMemAdd(key);
        } else {
            const pos = (this._gHead + this._gLen) % cap;
            this._gRingArr[pos] = key;
            this._gSet.add(key);
        }
        this._gLen++;
    }

    /** Remove a key from the ghost (it has just been re-admitted into MAIN). The
     *  ring shift is COLD -- only when admitting a key that was in ghost, never on
     *  the sequential-key hot path. */
    _ghostConsume(key) {
        const cap = this._ghostCap;
        if (cap === 0) return;
        if (this._ghostInt) {
            const mask = this._gRingMask;
            let idx = -1;
            for (let i = 0; i < this._gLen; i++) {
                if (this._gRing[(this._gHead + i) & mask] === key) { idx = i; break; }
            }
            if (idx >= 0) {
                for (let i = idx; i < this._gLen - 1; i++) {
                    this._gRing[(this._gHead + i) & mask] = this._gRing[(this._gHead + i + 1) & mask];
                }
                this._gLen--;
            }
            this._ghostMemDel(key);
        } else {
            let idx = -1;
            for (let i = 0; i < this._gLen; i++) {
                if (sameKey(this._gRingArr[(this._gHead + i) % cap], key)) { idx = i; break; }
            }
            if (idx >= 0) {
                for (let i = idx; i < this._gLen - 1; i++) {
                    this._gRingArr[(this._gHead + i) % cap] = this._gRingArr[(this._gHead + i + 1) % cap];
                }
                this._gRingArr[(this._gHead + this._gLen - 1) % cap] = undefined;
                this._gLen--;
            }
            this._gSet.delete(key);
        }
    }

    /** Int ghost membership insert (open-addressed, no-op if already present). */
    _ghostMemAdd(key) {
        const st = this._gixState, ks = this._gixKey, mask = this._gixMask;
        let b = hashInt(key, mask);
        for (;;) {
            if (st[b] === 0) { st[b] = 1; ks[b] = key; return; }
            if (ks[b] === key) return;
            b = (b + 1) & mask;
        }
    }

    /** Int ghost membership delete (backward-shift, no tombstones -- mirrors
     *  IntSlotStore.delete over a state byte instead of a slot sentinel). */
    _ghostMemDel(key) {
        const st = this._gixState, ks = this._gixKey, mask = this._gixMask;
        let b = hashInt(key, mask);
        for (;;) {
            if (st[b] === 0) return;
            if (ks[b] === key) break;
            b = (b + 1) & mask;
        }
        let i = b, j = b;
        for (;;) {
            j = (j + 1) & mask;
            if (st[j] === 0) break;
            const k = hashInt(ks[j], mask);
            const inRange = (j > i) ? (i < k && k <= j) : (i < k || k <= j);
            if (inRange) continue;
            st[i] = 1; ks[i] = ks[j];
            i = j;
        }
        st[i] = 0;
    }

    // --- the eviction sweep (D13) ---------------------------------------------

    /**
     * Free exactly ONE slot and return it for reuse. Graduations (visited SMALL ->
     * MAIN) and second chances (visited MAIN -> MAIN head) free no slot, so the loop
     * keeps stepping until a slot is actually evicted. Only ever called at capacity,
     * where SMALL is non-empty whenever `_sSize >= smallCap` and MAIN is non-empty
     * whenever `_sSize < smallCap` -- so neither branch reads an empty ring here.
     */
    _evict() {
        this._store._ver++; // D18.6 -- eviction sweep mutates the rings; invalidate iterators
        const vis = this._vis;
        for (;;) {
            if (this._sSize >= this._smallCap) {
                const t = this._sTail; // SMALL oldest
                if (vis[t] === 1) {    // proven -> graduate to MAIN (may exceed mainCap;
                    vis[t] = 0;        // a later step reclaims it -- D13)
                    this._detach(t);
                    this._pushMain(t);
                    continue;
                }
                const k = this._keys[t]; // unproven -> evict in place, remember in ghost
                this._detach(t);
                this._store.delete(k);
                this._ghostAdd(k);
                return t;
            }
            const t = this._mTail; // MAIN oldest
            if (vis[t] === 1) {    // second chance -> clear + reinsert at MAIN head
                vis[t] = 0;
                this._detach(t);
                this._pushMain(t);
                continue;
            }
            const k = this._keys[t]; // evict in place (MAIN evictions are NOT ghosted)
            this._detach(t);
            this._store.delete(k);
            return t;
        }
    }

    // --- public API (all zero-alloc on the hot path) --------------------------

    /**
     * Look up a key AND mark it visited. Like Sieve this does NOTHING structural --
     * one `_vis` store, no relink, no queue move (the headline). @returns the value,
     * or undefined if absent (see D7).
     */
    get(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const s = this._store.get(key);
        if (s < 0) return undefined;
        // TTL gate (decisions/0017, D17.3): a stale hit is a MISS -- no visited bump,
        // reaped in place. Only reached when ttl is configured.
        if (this._exp !== null && this._exp[s] <= this._clock()) { this._reap(s); return undefined; }
        this._vis[s] = 1; // the whole hot path: a single byte store
        return this._vals[s];
    }

    /**
     * Insert or update. An update rewrites the value and sets visited (a write ->
     * matches a hit). A new key at capacity runs one eviction step, then is admitted:
     * to MAIN if it was in ghost (proven-hot on a second sighting), else to SMALL
     * (probation). New entries start UNVISITED. onEvict fires LAST (decisions/0002). The
     * optional positional `ttlMs` (decisions/0017, D17.4) overrides the ttl default.
     */
    put(key, value, ttlMs) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        let expiresAt;
        if (this._exp !== null) expiresAt = expiryFor(this._clock, this._ttl, ttlMs);
        else if (ttlMs !== undefined) throw new Error(TTL_NO_COLUMN_MSG); // fail closed (D17.4)
        this._store._ver++; // D18.6 -- put mutates (update/insert/evict); invalidate iterators
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                 // update-in-place + mark visited
            this._vals[existing] = value;
            if (this._exp !== null) this._exp[existing] = expiresAt; // restamp (D17)
            this._vis[existing] = 1;
            return;
        }

        // Admission decision uses the ghost state AT ARRIVAL (before this eviction's
        // own ghost write), so an eviction that happens to bump this key from ghost
        // cannot flip the decision -- keeps impl and oracle in lockstep (D13).
        const toMain = this._ghostHas(key);
        if (toMain) this._ghostConsume(key);

        let s, evKey, evVal;
        let evicted = false;
        if (this._size === this._capacity) {
            s = this._evict();          // frees exactly one slot (reused in place, D6)
            evKey = this._keys[s];
            evVal = this._vals[s];
            evicted = true;
        } else {
            s = store.allocSlot();
        }

        this._keys[s] = key;
        this._vals[s] = value;
        if (this._exp !== null) this._exp[s] = expiresAt; // stamp the expiry (D17)
        this._vis[s] = 0;               // a newcomer starts UNVISITED
        store.set(key, s);
        if (toMain) this._pushMain(s); else this._pushSmall(s);
        this._size = this._sSize + this._mSize;

        // Fire onEvict LAST, cache fully consistent (decisions/0002).
        if (evicted) {
            this._inOnEvict = true;
            try {
                this._onEvict(evKey, evVal);
            } finally {
                this._inOnEvict = false;
            }
        }
    }

    /** True if key is present (RESIDENT). Visited-NEUTRAL; ghost keys are NOT present. A
     *  stale entry is a MISS and is reaped in place (decisions/0017, D17.3). */
    has(key) {
        const s = this._store.get(key);
        if (s < 0) return false;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return false;
        }
        return true;
    }

    /** Read a value WITHOUT setting visited. undefined if absent (see D7). A stale entry
     *  is a MISS and is reaped in place (decisions/0017, D17.3). */
    peek(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return undefined;
        }
        return this._vals[s];
    }

    /** Reap an expired slot in place (decisions/0017): unlink from whichever ring,
     *  drop from the index, zero the visited byte, free the slot, and fire onEvict LAST
     *  via the 0002 guard. A reap is NOT an eviction, so it is never ghosted (like delete). */
    _reap(s) {
        this._store._ver++; // D18.6 -- a reap is a structural mutation; invalidate iterators
        const evKey = this._keys[s];
        const evVal = this._vals[s];
        this._detach(s);
        this._store.delete(evKey);
        this._vis[s] = 0;
        this._store.freeSlot(s);
        this._size = this._sSize + this._mSize;
        this._inOnEvict = true;
        try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
    }

    /** Evict every expired resident entry now (decisions/0017, D17.5). COLD, O(size);
     *  fires onEvict per victim (0002) and returns the count evicted. */
    purgeStale() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG);
        if (this._exp === null) return 0;
        const now = this._clock();
        const exp = this._exp;
        const victims = [];
        this._store.indexEntries((key, slot) => { if (exp[slot] <= now) victims.push(slot); });
        for (let i = 0; i < victims.length; i++) this._reap(victims[i]);
        return victims.length;
    }

    /**
     * Remove a key. Returns true if it was present. Frees the slot, zeroes its
     * visited byte, repairs the ring it was in. An explicit delete is NOT an
     * eviction, so it is never recorded in ghost.
     */
    delete(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const store = this._store;
        const s = store.get(key);
        if (s < 0) return false;
        store._ver++; // D18.6 -- a real delete is a structural mutation; invalidate iterators
        this._detach(s);
        store.delete(key);
        this._vis[s] = 0;
        store.freeSlot(s);
        this._size = this._sSize + this._mSize;
        return true;
    }

    /** Empty the cache. Rebuilds the free list, zeroes visited, empties both rings
     *  and the ghost. Allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._vis.fill(0);
        this._sHead = NIL; this._sTail = NIL; this._sSize = 0;
        this._mHead = NIL; this._mTail = NIL; this._mSize = 0;
        this._size = 0;
        if (this._ghostCap > 0) {
            if (this._ghostInt) this._gixState.fill(0);
            else { this._gSet.clear(); this._gRingArr.fill(undefined); }
        }
        this._gHead = 0;
        this._gLen = 0;
    }

    // --- iteration (decisions/0018, D18): zero-GC keys/values/entries ----------

    /** The per-member iteration ROSTER (decisions/0018, D18.1): MAIN (newest->oldest)
     *  THEN SMALL (newest->oldest). The keys-only GHOST is EXCLUDED (it holds no
     *  resident entry). NOT recency order -- two FIFO rings concatenated. */
    _iterHeads() { return [this._mHead, this._sHead]; }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store (conservation invariant). */
    _freeListLength() {
        return this._store.freeListLength();
    }

    /**
     * The key the NEXT over-capacity insert would evict, computed WITHOUT mutating
     * any bit, link, size or ghost. It replays the exact `_evict` sweep on CLONES of
     * the four mutable columns + ring endpoints, so it can never drift from the real
     * eviction (same code shape). This is TEST-ONLY (drives the torture differential)
     * and NOT a hot path, so the clones are allowed. It also covers the below-capacity
     * "main empty" case (a Sieve-like second chance within SMALL) that `_evict` itself
     * never reaches, since `_evict` runs only at capacity.
     *
     * GUARD (reviewer nit, S5): this method is wired SOLELY through the differential
     * harness's `victim()` twin (test/torture/harness.mjs `wrapS3Fifo`) and the
     * boundary suite's oracle cross-check -- never from `get`/`put`/`has`/`peek`/
     * `delete`/`clear`/`_evict`. It MAY allocate (it slices four ring columns on
     * every call) precisely because it is never a measured or hot path; keep it that
     * way -- if a future change ever calls `_peekVictim` from inside `_evict` or any
     * public method, the t6 zero-alloc gates (decisions/0013, D3/D11) must catch it.
     */
    _peekVictim() {
        if (this._size === 0) return undefined;
        const next = this._next.slice();
        const prev = this._prev.slice();
        const q = this._q.slice();
        const vis = this._vis.slice();
        const keys = this._keys;
        const smallCap = this._smallCap;
        let sHead = this._sHead, sTail = this._sTail, sSize = this._sSize;
        let mHead = this._mHead, mTail = this._mTail, mSize = this._mSize;
        const detach = (s) => {
            const p = prev[s], n = next[s];
            if (q[s] === Q_SMALL) {
                if (p !== NIL) next[p] = n; else sHead = n;
                if (n !== NIL) prev[n] = p; else sTail = p;
                sSize--;
            } else {
                if (p !== NIL) next[p] = n; else mHead = n;
                if (n !== NIL) prev[n] = p; else mTail = p;
                mSize--;
            }
        };
        const pushSmall = (s) => {
            q[s] = Q_SMALL; prev[s] = NIL; next[s] = sHead;
            if (sHead !== NIL) prev[sHead] = s;
            sHead = s; if (sTail === NIL) sTail = s; sSize++;
        };
        const pushMain = (s) => {
            q[s] = Q_MAIN; prev[s] = NIL; next[s] = mHead;
            if (mHead !== NIL) prev[mHead] = s;
            mHead = s; if (mTail === NIL) mTail = s; mSize++;
        };
        for (;;) {
            if (sSize >= smallCap) {
                const t = sTail;
                if (vis[t] === 1) { vis[t] = 0; detach(t); pushMain(t); continue; }
                return keys[t];
            } else if (mSize > 0) {
                const t = mTail;
                if (vis[t] === 1) { vis[t] = 0; detach(t); pushMain(t); continue; }
                return keys[t];
            } else {
                const t = sTail; // main empty (only reachable below capacity)
                if (vis[t] === 1) { vis[t] = 0; detach(t); pushSmall(t); continue; }
                return keys[t];
            }
        }
    }
}

/* -------------------------------------------------------------------------- *
 * WTinyLfu -- the W-TinyLFU admission policy (the Caffeine approach: Einziger et
 * al., "TinyLFU: A Highly Efficient Cache Admission Policy"), over the SAME
 * SlotStore substrate (decisions/0014, D14). The fourth named export in this file
 * (same file-shape ruling as Sieve/S3Fifo: single main file + sideEffects:false +
 * named exports = the tree-shake moat).
 *
 * W-TinyLFU is a small admission WINDOW (an LRU) in front of a segmented main cache
 * (SLRU: a PROBATION segment + a PROTECTED segment), gated by a frequency sketch:
 *   - THREE LRU lists threaded intrusively through the shared `_next`/`_prev` columns
 *     (window / probation / protected), each with its own head=MRU / tail=LRU
 *     endpoints. `_next` toward the tail (LRU), `_prev` toward the head (MRU). A slot
 *     is in exactly ONE list; `_seg[slot]` tags which (D14).
 *   - a fixed count-min sketch `_sk` (D14.2): 4 rows of 4-bit SATURATING counters,
 *     width = pow2 >= capacity, packed 8-per-Uint32. Aged (halved in place) every
 *     sampleSize = 10*capacity increments (D14.3). get/put bump it by one; admission
 *     reads it. Fixed size, allocated once, NEVER grown.
 *
 * New keys enter the WINDOW at MRU. On a HIT: a window entry moves to window MRU; a
 * probation entry is PROMOTED to protected (demoting protected's LRU back to probation
 * when protected is full); a protected entry moves to protected MRU. At capacity,
 * adding a newcomer forces the window's LRU out as the admission CANDIDATE, weighed
 * against the probation LRU VICTIM (D14.3): the candidate is admitted (to probation)
 * and the victim evicted iff freq(candidate) > freq(victim); ties REJECT (favor the
 * incumbent), evicting the candidate. A one-hit-wonder never out-frequencies the
 * proven-hot set -- scan- AND frequency-resistant.
 *
 * Sizing (D14.4, frozen in the constructor):
 *   window    = Math.max(1, Math.round(capacity / 100));
 *   main      = capacity - window;
 *   protected = Math.round(main * 0.8);   (probation is the remainder of main)
 * Degenerate small caps (main == 0, e.g. capacity 1) skip admission entirely and
 * degenerate to a window-only LRU -- impl and oracle agree on the edge.
 *
 * SKETCH HASHING (D14.1): the sketch is indexed by a NUMERIC hash of the key. Primitive
 * keys (number/string) hash by VALUE, so their frequency is stable across residency.
 * Object keys have no zero-alloc stable numeric identity (a WeakMap is forbidden by the
 * zero-GC law), so they hash by their RESIDENT SLOT index -- their frequency is tracked
 * only WHILE resident. No per-op object or closure is ever allocated on either path.
 *
 * Rides the shared `newStore` factory (default Map / opt-in `keys:'int'` strict-zero
 * backing, the `[lite-lru]` int-key door), the conservation invariant, and the onEvict
 * fire-after + `_inOnEvict` reentrancy guard (decisions/0002). A HIT does MORE writes
 * than Sieve/S3Fifo (a segment relink + a sketch increment) BY DESIGN -- the gate
 * asserts zero-ALLOCATION, not minimal writes.
 * -------------------------------------------------------------------------- */

export class WTinyLfu {
    /**
     * @param {number} capacity  Max entries. Must be an integer >= 1.
     * @param {{ onEvict?: (key: any, value: any) => void, keys?: 'int' }} [options]
     */
    constructor(capacity, options) {
        // Fail closed (D9), identical to the rest of the family.
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new RangeError(
                "[lite-lru] capacity must be an integer >= 1, got " + String(capacity)
            );
        }

        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed at the door -- identical to LiteLru.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as the rest of the family.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined);

        // Cache the store's columns so the list relinks stay direct.
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next; // toward the tail (LRU)
        this._prev = this._store._prev; // toward the head (MRU)
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // D14 -- one segment tag per slot so `_detach` fixes the correct list.
        // Fixed size, allocated once, never grown.
        this._seg = new Uint8Array(capacity);

        // D14.4 -- the window / SLRU split, frozen here. `main == 0` (capacity 1)
        // degenerates to a window-only LRU (admission is skipped).
        this._windowCap = Math.max(1, Math.round(capacity / 100));
        this._mainCap = capacity - this._windowCap;
        this._protectedCap = Math.round(this._mainCap * 0.8);

        this._wHead = NIL; this._wTail = NIL; this._wSize = 0;   // admission WINDOW (LRU)
        this._prHead = NIL; this._prTail = NIL; this._prSize = 0; // SLRU PROBATION (LRU)
        this._ptHead = NIL; this._ptTail = NIL; this._ptSize = 0; // SLRU PROTECTED (LRU)
        this._size = 0;                                           // _wSize + _prSize + _ptSize

        // D14.2 -- the count-min frequency sketch: 4 rows of 4-bit counters, width a
        // power of two >= capacity, packed 8-per-Uint32. Fixed size, never grown.
        let w = 1;
        while (w < capacity) w <<= 1;
        this._skWidth = w;
        this._skMask = w - 1;
        this._sk = new Uint32Array((SK_ROWS * w + 7) >> 3);
        this._skSample = 10 * capacity; // D14.3 -- age (halve) after this many bumps
        this._skSize = 0;

        this._onEvict = (options && options.onEvict) || NOOP;
        this._inOnEvict = false;
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl) {
        return newStore(capacity, keys, hasTtl);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- the frequency sketch (D14.1/D14.2/D14.3) -----------------------------

    /** A numeric hash of the key for the sketch (D14.1). Primitive keys hash by VALUE
     *  (stable frequency); object keys have no zero-alloc stable identity (no WeakMap),
     *  so they hash by their RESIDENT SLOT -- bumped only while resident. Zero-alloc. */
    _hashKey(key, slot) {
        const t = typeof key;
        if (t === 'number') return (key | 0) >>> 0;
        if (t === 'string') {
            let h = 0;
            for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
            return h >>> 0;
        }
        return slot >>> 0; // object/other: bump only while resident (D14.1)
    }

    /** The sketch column for row `r` of a key hash, masked to the fixed width. */
    _skCol(h, r) {
        let x = (h ^ SK_SEEDS[r]) >>> 0;
        x = Math.imul(x, 0x9e3779b1) >>> 0;
        x ^= x >>> 16;
        return x & this._skMask;
    }

    /** Estimated frequency of a key hash: the MIN over the 4 rows (count-min). */
    _sketchFreq(h) {
        const sk = this._sk, width = this._skWidth;
        let min = 15;
        for (let r = 0; r < SK_ROWS; r++) {
            const nib = r * width + this._skCol(h, r);
            const v = (sk[nib >> 3] >>> ((nib & 7) << 2)) & 15;
            if (v < min) min = v;
        }
        return min;
    }

    /** Bump a key hash's counters (one per row, saturating at 15) and age the whole
     *  sketch in place once the sample budget is spent. Zero-alloc. */
    _sketchInc(h) {
        const sk = this._sk, width = this._skWidth;
        for (let r = 0; r < SK_ROWS; r++) {
            const nib = r * width + this._skCol(h, r);
            const wi = nib >> 3;
            const sh = (nib & 7) << 2;
            const cur = (sk[wi] >>> sh) & 15;
            if (cur < 15) sk[wi] = ((sk[wi] & ~(15 << sh)) | ((cur + 1) << sh)) >>> 0;
        }
        if (++this._skSize >= this._skSample) this._sketchAge();
    }

    /** Halve every 4-bit counter in place (D14.3). `>>> 1` shifts every nibble down;
     *  `& 0x77777777` clears the top bit each nibble stole from its neighbour, so the
     *  counters halve independently. Then halve the sample counter. Zero-alloc. */
    _sketchAge() {
        const sk = this._sk;
        for (let i = 0; i < sk.length; i++) sk[i] = (sk[i] >>> 1) & 0x77777777;
        this._skSize >>>= 1;
    }

    // --- intrusive LRU-list helpers (per-segment size accounting) -------------

    /** Unlink slot s from WHICHEVER list it is in (per `_seg[s]`), fixing that list's
     *  neighbours + head/tail sentinels + size. */
    _detach(s) {
        const p = this._prev[s], n = this._next[s], seg = this._seg[s];
        if (seg === SEG_WINDOW) {
            if (p !== NIL) this._next[p] = n; else this._wHead = n;
            if (n !== NIL) this._prev[n] = p; else this._wTail = p;
            this._wSize--;
        } else if (seg === SEG_PROBATION) {
            if (p !== NIL) this._next[p] = n; else this._prHead = n;
            if (n !== NIL) this._prev[n] = p; else this._prTail = p;
            this._prSize--;
        } else {
            if (p !== NIL) this._next[p] = n; else this._ptHead = n;
            if (n !== NIL) this._prev[n] = p; else this._ptTail = p;
            this._ptSize--;
        }
    }

    /** Insert slot s at the head (MRU end) of the WINDOW list. */
    _pushWindow(s) {
        this._seg[s] = SEG_WINDOW;
        this._prev[s] = NIL; this._next[s] = this._wHead;
        if (this._wHead !== NIL) this._prev[this._wHead] = s;
        this._wHead = s; if (this._wTail === NIL) this._wTail = s;
        this._wSize++;
    }

    /** Insert slot s at the head (MRU end) of the PROBATION list. */
    _pushProbation(s) {
        this._seg[s] = SEG_PROBATION;
        this._prev[s] = NIL; this._next[s] = this._prHead;
        if (this._prHead !== NIL) this._prev[this._prHead] = s;
        this._prHead = s; if (this._prTail === NIL) this._prTail = s;
        this._prSize++;
    }

    /** Insert slot s at the head (MRU end) of the PROTECTED list. */
    _pushProtected(s) {
        this._seg[s] = SEG_PROTECTED;
        this._prev[s] = NIL; this._next[s] = this._ptHead;
        if (this._ptHead !== NIL) this._prev[this._ptHead] = s;
        this._ptHead = s; if (this._ptTail === NIL) this._ptTail = s;
        this._ptSize++;
    }

    /** On a HIT: window -> window MRU; probation -> PROMOTE to protected (demoting
     *  protected's LRU back to probation on overflow); protected -> protected MRU. */
    _onHit(s) {
        const seg = this._seg[s];
        if (seg === SEG_WINDOW) {
            if (this._wHead !== s) { this._detach(s); this._pushWindow(s); }
        } else if (seg === SEG_PROBATION) {
            this._detach(s);
            this._pushProtected(s);
            if (this._ptSize > this._protectedCap) { // protected full -> demote its LRU
                const d = this._ptTail;
                this._detach(d);
                this._pushProbation(d);
            }
        } else { // SEG_PROTECTED
            if (this._ptHead !== s) { this._detach(s); this._pushProtected(s); }
        }
    }

    /** Admission (D14.3): admit the window CANDIDATE over the probation VICTIM iff its
     *  estimated frequency is strictly greater; ties reject (favor the incumbent). A
     *  seam a control can override to prove the differential has teeth. */
    _admit(candSlot, victimSlot) {
        const fc = this._sketchFreq(this._hashKey(this._keys[candSlot], candSlot));
        const fv = this._sketchFreq(this._hashKey(this._keys[victimSlot], victimSlot));
        return fc > fv;
    }

    // --- public API (all zero-alloc on the hot path) --------------------------

    /**
     * Look up a key AND record a frequency bump + recency promotion. @returns the
     * value, or undefined if absent (see D7). A HIT bumps the sketch and relinks the
     * entry within its segment (or promotes probation -> protected).
     */
    get(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const s = this._store.get(key);
        if (s < 0) return undefined;
        // TTL gate (decisions/0017, D17.3): a stale hit is a MISS -- no sketch bump, no
        // promotion, reaped in place. Only reached when ttl is configured.
        if (this._exp !== null && this._exp[s] <= this._clock()) { this._reap(s); return undefined; }
        this._sketchInc(this._hashKey(key, s));
        this._onHit(s);
        return this._vals[s];
    }

    /**
     * Insert or update. An update rewrites the value, bumps the sketch and promotes
     * (like a hit). A new key enters the WINDOW at MRU; below capacity the window sheds
     * its overflow into probation, at capacity exactly one entry is evicted via the
     * admission compare (D14.3). onEvict fires LAST (decisions/0002). The optional
     * positional `ttlMs` (decisions/0017, D17.4) overrides the instance ttl default.
     */
    put(key, value, ttlMs) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        let expiresAt;
        if (this._exp !== null) expiresAt = expiryFor(this._clock, this._ttl, ttlMs);
        else if (ttlMs !== undefined) throw new Error(TTL_NO_COLUMN_MSG); // fail closed (D17.4)
        this._store._ver++; // D18.6 -- put mutates (update/insert/evict); invalidate iterators
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                 // update-in-place + bump + promote
            this._vals[existing] = value;
            if (this._exp !== null) this._exp[existing] = expiresAt; // restamp (D17)
            this._sketchInc(this._hashKey(key, existing));
            this._onHit(existing);
            return;
        }

        let s, evKey, evVal, evicted = false;
        if (this._size < this._capacity) {
            // Below capacity: no eviction. Admit to the window, then shed any window
            // overflow into probation (main is below its target, so nothing evicts).
            s = store.allocSlot();
            this._keys[s] = key; this._vals[s] = value;
            store.set(key, s);
            this._pushWindow(s);
            this._size++;
            while (this._wSize > this._windowCap) {
                const v = this._wTail;      // window LRU
                this._detach(v);
                this._pushProbation(v);
            }
        } else {
            // At capacity: a newcomer joins the window, forcing the window LRU out as
            // the admission CANDIDATE. Exactly one entry is evicted (candidate or the
            // probation victim), and its slot is reused in place for the newcomer (D6).
            const cand = this._wTail;       // window LRU (window is non-empty at capacity)
            this._detach(cand);             // out of the window, floating
            const victim = this._prTail;    // probation LRU (NIL when probation is empty)
            let loser;
            if (victim !== NIL && this._admit(cand, victim)) {
                this._pushProbation(cand);  // candidate admitted to probation MRU
                loser = victim;
                this._detach(loser);
            } else {
                loser = cand;               // rejected (or no victim): evict the candidate
            }
            evKey = this._keys[loser];
            evVal = this._vals[loser];
            store.delete(evKey);
            s = loser;                      // reuse the evicted slot in place (D6)
            this._keys[s] = key; this._vals[s] = value;
            store.set(key, s);
            this._pushWindow(s);
            evicted = true;
        }

        if (this._exp !== null) this._exp[s] = expiresAt; // stamp the expiry (D17)

        // Record the newcomer's own access AFTER the admission decision, so the decision
        // reads the pre-bump sketch (keeps impl and oracle in lockstep).
        this._sketchInc(this._hashKey(key, s));

        // Fire onEvict LAST, cache fully consistent (decisions/0002).
        if (evicted) {
            this._inOnEvict = true;
            try { this._onEvict(evKey, evVal); }
            finally { this._inOnEvict = false; }
        }
    }

    /** True if key is present (RESIDENT). Frequency- and recency-NEUTRAL. A stale entry
     *  is a MISS and is reaped in place (decisions/0017, D17.3). */
    has(key) {
        const s = this._store.get(key);
        if (s < 0) return false;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return false;
        }
        return true;
    }

    /** Read a value WITHOUT bumping frequency or recency. undefined if absent (D7). A
     *  stale entry is a MISS and is reaped in place (decisions/0017, D17.3). */
    peek(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return undefined;
        }
        return this._vals[s];
    }

    /** Reap an expired slot in place (decisions/0017): unlink from its segment, drop from
     *  the index, free the slot, and fire onEvict LAST via the 0002 guard. The sketch is
     *  untouched (frequency history persists), same as delete. */
    _reap(s) {
        this._store._ver++; // D18.6 -- a reap is a structural mutation; invalidate iterators
        const evKey = this._keys[s];
        const evVal = this._vals[s];
        this._detach(s);
        this._store.delete(evKey);
        this._store.freeSlot(s);
        this._size--;
        this._inOnEvict = true;
        try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
    }

    /** Evict every expired resident entry now (decisions/0017, D17.5). COLD, O(size);
     *  fires onEvict per victim (0002) and returns the count evicted. */
    purgeStale() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG);
        if (this._exp === null) return 0;
        const now = this._clock();
        const exp = this._exp;
        const victims = [];
        this._store.indexEntries((key, slot) => { if (exp[slot] <= now) victims.push(slot); });
        for (let i = 0; i < victims.length; i++) this._reap(victims[i]);
        return victims.length;
    }

    /**
     * Remove a key. Returns true if it was present. Frees the slot and repairs the
     * list it was in. The sketch is untouched (frequency history persists).
     */
    delete(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const store = this._store;
        const s = store.get(key);
        if (s < 0) return false;
        store._ver++; // D18.6 -- a real delete is a structural mutation; invalidate iterators
        this._detach(s);
        store.delete(key);
        store.freeSlot(s);
        this._size--;
        return true;
    }

    /** Empty the cache. Rebuilds the free list, empties all three lists, and zeroes
     *  the frequency sketch. Allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._wHead = NIL; this._wTail = NIL; this._wSize = 0;
        this._prHead = NIL; this._prTail = NIL; this._prSize = 0;
        this._ptHead = NIL; this._ptTail = NIL; this._ptSize = 0;
        this._size = 0;
        this._sk.fill(0);
        this._skSize = 0;
    }

    // --- iteration (decisions/0018, D18): zero-GC keys/values/entries ----------

    /** The per-member iteration ROSTER (decisions/0018, D18.1): WINDOW (MRU->LRU) THEN
     *  PROTECTED (MRU->LRU) THEN PROBATION (MRU->LRU). Three segments concatenated --
     *  NOT global recency order. */
    _iterHeads() { return [this._wHead, this._ptHead, this._prHead]; }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store (conservation invariant). */
    _freeListLength() {
        return this._store.freeListLength();
    }

    /**
     * The key the NEXT over-capacity insert would evict, computed WITHOUT mutating any
     * counter, link, size or the sketch. Below capacity a new key does not evict, so it
     * returns undefined. At capacity it replays the exact admission compare (candidate
     * = window LRU, victim = probation LRU) that `put` runs -- so it can never drift
     * from the real eviction. TEST-ONLY (drives the torture differential).
     */
    _peekVictim() {
        if (this._size < this._capacity || this._size === 0) return undefined;
        const cand = this._wTail;
        if (cand === NIL) return undefined; // defensive: window is non-empty at capacity
        const victim = this._prTail;
        if (victim === NIL) return this._keys[cand];
        return this._admit(cand, victim) ? this._keys[victim] : this._keys[cand];
    }
}

export default LiteLru;
