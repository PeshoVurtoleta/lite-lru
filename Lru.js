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

/** Slru (decisions/0015, D15) segment tags: which of the two intrusive lists a slot is
 *  in (PROBATION FIFO / PROTECTED LRU). Stored one byte per slot in `_seg` so `_detach`
 *  fixes the RIGHT list's head/tail. A slot is in exactly one list at a time. */
const SLRU_PROBATION = 0;
const SLRU_PROTECTED = 1;

/** TwoQ (decisions/0015, D15) segment tags: which of the two intrusive queues a resident
 *  slot is in (A1in FIFO / Am LRU). Stored one byte per slot in `_seg`. The A1out ghost
 *  is keys-only and holds no resident slot, so it needs no tag. */
const TWOQ_A1IN = 0;
const TWOQ_AM = 1;

/** ARC (decisions/0016, D16) segment tags: which of the two intrusive LRU lists a resident
 *  slot is in (T1 recent / T2 frequent). Stored one byte per slot in `_seg` so `_detach`
 *  fixes the RIGHT list's head/tail. The keys-only B1/B2 ghosts hold no resident slot. */
const ARC_T1 = 0;
const ARC_T2 = 1;

/** LIRS (decisions/0023, D23) per-slot state bits, packed in a member-specific `_st`
 *  Uint8 column (like W-TinyLFU's sketch -- NOT a field on the shared SlotStore, so the
 *  other members' hot paths stay byte-identical). bit0 = LIR (low IRR, hot/resident);
 *  bit1 = the slot is currently in the LIRS stack S. The whole LIRS hot test is a single
 *  `_st[s]` read (`& LIRS_LIR`, `& LIRS_INS`). */
const LIRS_LIR = 1; // bit0: 1 = LIR block, 0 = HIR block
const LIRS_INS = 2; // bit1: slot is currently a member of the stack S

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

/** Fail-closed message for stats()/resetStats() on a non-stats instance (decisions/0019,
 *  D19.5). Built once, thrown only when the accessor is used on a cache that was not
 *  constructed with `{ stats: true }` (there is no holder -- a caller bug, not zeros). */
const STATS_OFF_MSG =
    "[lite-lru] stats()/resetStats() require the cache to be constructed with " +
    "{ stats: true }; this instance has no stats configured";

/**
 * Validate the optional `stats` door and mint the per-instance counter holder
 * (decisions/0019, D19). Mirrors the `keys` door (decisions/0011): `undefined` -> no
 * stats (`null`); `true` -> a fresh zeroed holder of plain-number fields (D19.4,
 * exact to 2^53); any other value fails closed with a did-you-mean hint (D19.5).
 * Cold: called once per constructor, never on a hot path.
 */
function validateStats(stats) {
    if (stats === undefined) return null;
    if (stats === true) return { hits: 0, misses: 0, evictions: 0, puts: 0 };
    throw new TypeError(
        "[lite-lru] unknown stats option " + String(stats) + " (did you mean true?)");
}

export const VERSION = "1.10.0";

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

    /** Rebuild the free stack over the slots NOT marked occupied (decisions/0021, D21).
     *  COLD -- used only by `restore()`, never on a hot path -- so it may take an
     *  `occupied` Uint8Array. Threads the free list highest-slot-first so the head pops
     *  the lowest free slot first (mirrors the constructor's 0 -> 1 -> ... order). Frees
     *  read Infinity in `_exp` because `restore` only ever writes occupied slots. */
    rebuildFreeList(occupied) {
        const cap = this._capacity, next = this._next;
        let head = NIL;
        for (let s = cap - 1; s >= 0; s--) {
            if (occupied[s] === 0) { next[s] = head; head = s; }
        }
        this._free = head;
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
 * Snapshot / restore -- the shared COLD (dump/restore) machinery (decisions/0021,
 * D21). INTERNAL, never an export. dump() and restore() NEVER touch the hot body:
 * no field is added to the substrate, and get/put/has/peek gain NO branch. Every
 * function here is cold -- it MAY allocate (the honest <= 96 B/entry dump budget).
 *
 * A snapshot is a plain, structurally-cloneable object graph (plain arrays + plain
 * numbers/values, NO typed-array views), tagged fail-closed with:
 *   { f:'litelru/1', m:<member>, cap, keys:'int'|null, ttl:<bool>, t:<captureMs>, ... }
 * plus per-member resident lists (walked in the member's iteration order, one
 * ordered `slots`/`k`/`v`(/`e`/`vis`) column set per intrusive list) and per-member
 * aux state (Sieve hand, S3Fifo/TwoQ/Arc ghosts, W-TinyLFU sketch, Arc `p`).
 *
 * D21.1 -- EXACT round-trip: restore reconstructs the SAME slot layout, links, per-
 * slot aux bits, and verbatim aux state, so a restored cache makes IDENTICAL future
 * eviction decisions vs an un-snapshotted twin fed the same trace. Preserving slots
 * verbatim is what keeps W-TinyLFU's slot-hashed object-key frequency exact.
 * -------------------------------------------------------------------------- */

/** The snapshot format tag (decisions/0021, D21.3). A version bump here is the ONLY
 *  compatible way to change the on-the-wire shape; restore rejects any other value. */
const SNAP_FORMAT = "litelru/1";

/** Fail-closed prefix for every restore rejection (decisions/0021, D21.3). "null is
 *  not zero": a corrupt/mismatched snapshot is a caller bug, never a silent empty cache. */
const SNAP_BAD = "[lite-lru] cannot restore snapshot: ";

/** Base tag for a dump (decisions/0021, D21.3). `keys` is the backing kind ('int' for
 *  the open-addressed typed-array index, else null for the Map backing), `ttl` records
 *  whether an `_exp` column exists, and `t` stamps capture time (D21 TTL-verbatim note). */
function snapBase(cache, member) {
    return {
        f: SNAP_FORMAT,
        m: member,
        cap: cache._capacity,
        keys: (typeof cache._store.checkStable === "function") ? "int" : null,
        ttl: cache._exp !== null,
        t: cache._clock(),
    };
}

/** Capture one intrusive list (head -> _next -> NIL) as aligned plain arrays: the
 *  ordered `slots`, keys `k`, values `v`, plus `e` (expiry) when ttl is on and `vis`
 *  (visited byte) when the member has a `_vis` column. Cold; MAY allocate (D21). */
function snapList(cache, head, withVis) {
    const next = cache._next, keys = cache._keys, vals = cache._vals, exp = cache._exp;
    const slots = [], k = [], v = [];
    const e = exp !== null ? [] : null;
    const vis = withVis ? [] : null;
    for (let s = head; s !== NIL; s = next[s]) {
        slots.push(s); k.push(keys[s]); v.push(vals[s]);
        if (e !== null) e.push(exp[s]);
        if (vis !== null) vis.push(cache._vis[s]);
    }
    const o = { slots, k, v };
    if (e !== null) o.e = e;
    if (vis !== null) o.vis = vis;
    return o;
}

/** Capture the S3-FIFO / TwoQ keys-only ghost FIFO oldest -> newest (decisions/0013,
 *  0015). KEYS only, never values (retention hygiene). Cold. */
function snapGhostRing(cache) {
    const out = [];
    const cap = cache._ghostCap, len = cache._gLen, head = cache._gHead;
    if (cap === 0 || len === 0) return out;
    if (cache._ghostInt) {
        const mask = cache._gRingMask;
        for (let i = 0; i < len; i++) out.push(cache._gRing[(head + i) & mask]);
    } else {
        for (let i = 0; i < len; i++) out.push(cache._gRingArr[(head + i) % cap]);
    }
    return out;
}

/** Capture an ArcGhost (B1/B2) oldest -> newest (decisions/0016). KEYS only. Cold. */
function snapArcGhost(g) {
    const out = [];
    if (g._cap === 0 || g._len === 0) return out;
    if (g._int) {
        const mask = g._ringMask;
        for (let i = 0; i < g._len; i++) out.push(g._ring[(g._head + i) & mask]);
    } else {
        for (let i = 0; i < g._len; i++) out.push(g._ringArr[(g._head + i) % g._cap]);
    }
    return out;
}

/** Validate + reject a snapshot's shared tag, cross-check it against the restore opts,
 *  and return the capacity (decisions/0021, D21.3). Fail closed (throws a
 *  `[lite-lru]`-tagged Error) on: a non-object; a wrong/absent format tag `f`; a member
 *  mismatch `m`; a bad capacity; a bad keys/ttl flag; a capacity/keys/ttl conflict with
 *  an opt actually passed; and a missing ttl option when the snapshot needs one. */
function snapRead(snap, member, opts) {
    if (snap === null || typeof snap !== "object") {
        throw new Error(SNAP_BAD + "snapshot must be a plain object, got " + String(snap));
    }
    if (snap.f !== SNAP_FORMAT) {
        throw new Error(SNAP_BAD + "format tag f must be '" + SNAP_FORMAT + "', got " + String(snap.f));
    }
    if (snap.m !== member) {
        throw new Error(SNAP_BAD + "member mismatch: snapshot is " + String(snap.m) + ", restoring " + member);
    }
    const cap = snap.cap;
    if (!Number.isInteger(cap) || cap < 1) {
        throw new Error(SNAP_BAD + "capacity must be an integer >= 1, got " + String(cap));
    }
    if (snap.keys !== "int" && snap.keys !== null) {
        throw new Error(SNAP_BAD + "keys backing must be 'int' or null, got " + String(snap.keys));
    }
    if (typeof snap.ttl !== "boolean") {
        throw new Error(SNAP_BAD + "ttl flag must be a boolean, got " + String(snap.ttl));
    }
    const o = opts || {};
    if (o.capacity !== undefined && o.capacity !== cap) {
        throw new Error(SNAP_BAD + "capacity opt (" + String(o.capacity) + ") conflicts with the snapshot (" + cap + ")");
    }
    if (o.keys !== undefined && ((o.keys === "int") !== (snap.keys === "int"))) {
        throw new Error(SNAP_BAD + "keys opt (" + String(o.keys) + ") conflicts with the snapshot backing (" + String(snap.keys) + ")");
    }
    if (snap.ttl) {
        if (o.ttl === undefined) {
            throw new Error(SNAP_BAD + "snapshot has ttl on; restore requires a { ttl } option (the future default is not encoded)");
        }
    } else if (o.ttl !== undefined) {
        throw new Error(SNAP_BAD + "a { ttl } option was given but the snapshot has ttl off (presence mismatch)");
    }
    return cap;
}

/** Build the constructor options for a fresh restore target from the snapshot tag +
 *  the passed opts (decisions/0021, D21.2): backing + ttl-presence come FROM the
 *  snapshot; onEvict/clock/stats are RE-DERIVED from opts; stats starts fresh-zeroed. */
function snapOpts(snap, opts) {
    const o = opts || {};
    const c = {};
    if (snap.keys === "int") c.keys = "int";
    if (snap.ttl) c.ttl = o.ttl;             // required (validated in snapRead); sets the future default
    if (o.clock !== undefined) c.clock = o.clock;
    if (o.onEvict !== undefined) c.onEvict = o.onEvict;
    if (o.stats !== undefined) c.stats = o.stats;
    return c;
}

/** Validate one captured list's shape (decisions/0021, D21.3). Rejects a malformed /
 *  short / column-length-mismatched list, an exp column present iff ttl, a `vis` column
 *  present iff `withVis` (with each byte 0/1), and any slot index out of [0, cap).
 *  `withVis` is driven off the SAME per-member roster that WRITES vis (snapCheckOccupy's
 *  pairs), so a missing/short/non-binary vis column fails closed instead of coercing to
 *  0 -- "null is not zero". Returns the list length. */
function snapCheckList(list, cap, ttl, label, withVis) {
    if (list === null || typeof list !== "object" ||
        !Array.isArray(list.slots) || !Array.isArray(list.k) || !Array.isArray(list.v)) {
        throw new Error(SNAP_BAD + "malformed list '" + label + "'");
    }
    const n = list.slots.length;
    if (list.k.length !== n || list.v.length !== n) {
        throw new Error(SNAP_BAD + "list '" + label + "' column length mismatch");
    }
    if (ttl) {
        if (!Array.isArray(list.e) || list.e.length !== n) {
            throw new Error(SNAP_BAD + "ttl snapshot list '" + label + "' missing/short exp column");
        }
    } else if (list.e !== undefined) {
        throw new Error(SNAP_BAD + "non-ttl snapshot list '" + label + "' carries an exp column");
    }
    if (withVis) {
        if (!Array.isArray(list.vis) || list.vis.length !== n) {
            throw new Error(SNAP_BAD + "list '" + label + "' missing/short visited (vis) column");
        }
        for (let i = 0; i < n; i++) {
            const b = list.vis[i];
            if (b !== 0 && b !== 1) {
                throw new Error(SNAP_BAD + "list '" + label + "' vis[" + i + "] = " + String(b) + " (must be 0 or 1)");
            }
        }
    } else if (list.vis !== undefined) {
        throw new Error(SNAP_BAD + "list '" + label + "' carries a visited (vis) column it must not");
    }
    for (let i = 0; i < n; i++) {
        const s = list.slots[i];
        if (!Number.isInteger(s) || s < 0 || s >= cap) {
            throw new Error(SNAP_BAD + "list '" + label + "' slot " + String(s) + " out of range [0," + cap + ")");
        }
    }
    return n;
}

/** Mark every captured list's slots occupied, rejecting a duplicate slot (which would
 *  corrupt) and a total that exceeds capacity -- capacity law 3, REJECT never truncate
 *  (decisions/0021, D21.3). Returns the occupied Uint8Array for rebuildFreeList. */
function snapOccupied(cap, lists) {
    const occ = new Uint8Array(cap);
    let total = 0;
    for (let li = 0; li < lists.length; li++) {
        const slots = lists[li].slots;
        for (let i = 0; i < slots.length; i++) {
            const s = slots[i];
            if (occ[s] !== 0) throw new Error(SNAP_BAD + "duplicate slot " + s + " across lists");
            occ[s] = 1; total++;
        }
    }
    if (total > cap) {
        throw new Error(SNAP_BAD + "resident entries (" + total + ") exceed capacity (" + cap + ")");
    }
    return occ;
}

/** Write one captured list's payload + keyed index into its (preserved) slots
 *  (decisions/0021, D21.1). Sets `_vis` when the list carries it. Does NOT link -- see
 *  snapLink -- and does NOT set the segment tag -- see snapSeg. Cold. */
function snapWriteList(cache, list) {
    const store = cache._store, keys = cache._keys, vals = cache._vals, exp = cache._exp;
    const slots = list.slots, k = list.k, v = list.v, e = list.e, vis = list.vis;
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        keys[s] = k[i];
        vals[s] = v[i];
        if (exp !== null && e !== undefined) exp[s] = e[i];
        if (vis !== undefined) cache._vis[s] = vis[i];
        store.set(k[i], s);
    }
}

/** Thread one intrusive list through _prev/_next in the captured order and return its
 *  { head, tail } endpoints (decisions/0021, D21.1). Cold. */
function snapLink(cache, slots) {
    const next = cache._next, prev = cache._prev;
    const n = slots.length;
    let head = NIL, tail = NIL;
    for (let i = 0; i < n; i++) {
        const s = slots[i];
        prev[s] = i === 0 ? NIL : slots[i - 1];
        next[s] = i === n - 1 ? NIL : slots[i + 1];
        if (i === 0) head = s;
        tail = s;
    }
    return { head, tail };
}

/** Stamp a constant segment/queue tag on one list's slots (decisions/0021, D21.1). The
 *  tag is constant per list (all T1 slots are ARC_T1, etc.), so it is set here rather
 *  than captured per entry. Cold. */
function snapSeg(cache, col, slots, val) {
    const arr = cache[col];
    for (let i = 0; i < slots.length; i++) arr[slots[i]] = val;
}

/** Validate every captured list then mark occupancy in ONE cold pass (decisions/0021),
 *  returning the occupied Uint8Array. `pairs` is [[list, label, withVis], ...], where
 *  `withVis` MUST match whether that member's dump() emitted a vis column for the list. */
function snapCheckOccupy(cap, ttl, pairs) {
    const lists = [];
    for (let i = 0; i < pairs.length; i++) {
        snapCheckList(pairs[i][0], cap, ttl, pairs[i][1], pairs[i][2] === true);
        lists.push(pairs[i][0]);
    }
    return snapOccupied(cap, lists);
}

/** Restore one captured list into a fresh cache in ONE cold pass (decisions/0021,
 *  D21.1): write payload + keyed index into the preserved slots, stamp the constant
 *  segment/queue tag (when `segCol` is non-null), thread the intrusive links, and return
 *  the list's { head, tail, size }. */
function snapRestoreList(cache, list, segCol, segVal) {
    snapWriteList(cache, list);
    if (segCol !== null) snapSeg(cache, segCol, list.slots, segVal);
    const ends = snapLink(cache, list.slots);
    return { head: ends.head, tail: ends.tail, size: list.slots.length };
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

        // Opt-in runtime stats (decisions/0019). `null` when off (the default) so the
        // hot path writes NOTHING; a fresh per-instance holder of plain-number fields
        // when `{ stats: true }`. The `stats` door fails closed on an unknown value.
        this._stats = validateStats(options && options.stats);
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
        if (s < 0) { if (this._stats !== null) this._stats.misses++; return undefined; } // miss (decisions/0019)
        // TTL gate (decisions/0017, D17.3): a stale hit is a MISS -- no promotion,
        // reaped in place (fires onEvict). Only reached when ttl is configured.
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (this._stats !== null) this._stats.misses++; // stale = miss (+ evict via _reap; D19.2)
            this._reap(s);
            return undefined;
        }
        this._moveToFront(s);
        if (this._stats !== null) this._stats.hits++; // live hit (decisions/0019)
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
            if (this._stats !== null) this._stats.puts++; // successful update (outcome-based); decisions/0019
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
        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); decisions/0019

        // Reentrancy fix (decisions/0002) -- fire onEvict LAST, when the cache is
        // fully consistent (the new entry is inserted, size restored). The guard
        // rejects any mutating reentry; because the cache is already consistent
        // here, that throw leaves it intact.
        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (decisions/0019)
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
        if (this._stats !== null) this._stats.evictions++; // reap = eviction (decisions/0019, D19.2)
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

    // --- opt-in runtime stats (decisions/0019, D19): cold accessors -----------

    /** The live stats holder (decisions/0019, D19.3). Returned BY REFERENCE (borrowed --
     *  copy what you keep, like the S11 iteration tuple); the counters keep advancing in
     *  the object you hold. Fail closed: throws on an instance built without { stats: true }. */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE (decisions/0019), so a previously-borrowed holder
     *  stays valid. Fail closed on a non-stats instance. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        const st = this._stats;
        st.hits = 0; st.misses = 0; st.evictions = 0; st.puts = 0;
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

    // --- snapshot / restore (decisions/0021, D21): COLD, may allocate --------

    /** Serialize this cache to a plain, structurally-cloneable snapshot (decisions/0021).
     *  COLD (never a hot path); MAY allocate (budget <= 96 B/entry). Captures the recency
     *  DLL in MRU..LRU order + values (+ per-entry expiry when ttl is on). */
    dump() {
        const snap = snapBase(this, "LiteLru");
        snap.list = snapList(this, this._head, false);
        return snap;
    }

    /** Reconstruct a FRESH LiteLru from a snapshot (decisions/0021). Fail closed on any
     *  tag/shape/capacity/keys/ttl mismatch. `opts` re-derives onEvict/clock/stats (and
     *  the required ttl DEFAULT when the snapshot has ttl on); backing + ttl-presence +
     *  capacity come FROM the snapshot. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "LiteLru", opts);
        const inst = new LiteLru(cap, snapOpts(snap, opts));
        const occ = snapCheckOccupy(cap, snap.ttl, [[snap.list, "list"]]);
        const L = snapRestoreList(inst, snap.list, null, 0);
        inst._head = L.head; inst._tail = L.tail; inst._size = L.size;
        inst._store.rebuildFreeList(occ);
        return inst;
    }

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

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
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
        if (s < 0) { if (this._stats !== null) this._stats.misses++; return undefined; } // miss (decisions/0019)
        // TTL gate (decisions/0017, D17.3): a stale hit is a MISS -- no visited bump,
        // reaped in place. Only reached when ttl is configured.
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (this._stats !== null) this._stats.misses++; // stale = miss (+ evict via _reap; D19.2)
            this._reap(s);
            return undefined;
        }
        this._vis[s] = 1; // the whole hot path: a single byte store
        if (this._stats !== null) this._stats.hits++; // live hit (decisions/0019)
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
            if (this._stats !== null) this._stats.puts++; // successful update (outcome-based); decisions/0019
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
        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); decisions/0019

        // Fire onEvict LAST, cache fully consistent (decisions/0002). The guard
        // rejects any mutating reentry; the cache is already whole here.
        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (decisions/0019)
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
        if (this._stats !== null) this._stats.evictions++; // reap = eviction (decisions/0019, D19.2)
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

    // --- opt-in runtime stats (decisions/0019, D19): cold accessors -----------

    /** The live stats holder (decisions/0019, D19.3), returned BY REFERENCE (borrowed --
     *  copy what you keep). Fail closed on an instance built without { stats: true }. */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE (decisions/0019); a borrowed holder stays valid.
     *  Fail closed on a non-stats instance. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        const st = this._stats;
        st.hits = 0; st.misses = 0; st.evictions = 0; st.puts = 0;
    }

    // --- iteration (decisions/0018, D18): zero-GC keys/values/entries ----------

    /** The per-member iteration ROSTER (decisions/0018, D18.1). SIEVE is one FIFO ring
     *  walked newest (head) -> oldest (tail) -- FIFO insertion order, NOT recency. */
    _iterHeads() { return [this._head]; }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- snapshot / restore (decisions/0021, D21): COLD, may allocate --------

    /** Serialize to a plain snapshot (decisions/0021): the FIFO ring newest..oldest +
     *  values (+ per-entry expiry when ttl is on) + each entry's visited bit + the
     *  parked hand slot. COLD; may allocate. */
    dump() {
        const snap = snapBase(this, "Sieve");
        snap.list = snapList(this, this._head, true);
        snap.hand = this._hand;
        return snap;
    }

    /** Reconstruct a FRESH Sieve from a snapshot (decisions/0021). Fail closed on any
     *  mismatch, and on a hand that does not reference a resident slot. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "Sieve", opts);
        const inst = new Sieve(cap, snapOpts(snap, opts));
        const occ = snapCheckOccupy(cap, snap.ttl, [[snap.list, "list", true]]);
        const L = snapRestoreList(inst, snap.list, null, 0);
        inst._head = L.head; inst._tail = L.tail; inst._size = L.size;
        const hand = snap.hand;
        if (hand !== NIL && (!Number.isInteger(hand) || hand < 0 || hand >= cap || occ[hand] === 0)) {
            throw new Error(SNAP_BAD + "sieve hand " + String(hand) + " does not reference a resident slot");
        }
        inst._hand = hand;
        inst._store.rebuildFreeList(occ);
        return inst;
    }

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

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
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
        if (s < 0) { if (this._stats !== null) this._stats.misses++; return undefined; } // miss (decisions/0019)
        // TTL gate (decisions/0017, D17.3): a stale hit is a MISS -- no visited bump,
        // reaped in place. Only reached when ttl is configured.
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (this._stats !== null) this._stats.misses++; // stale = miss (+ evict via _reap; D19.2)
            this._reap(s);
            return undefined;
        }
        this._vis[s] = 1; // the whole hot path: a single byte store
        if (this._stats !== null) this._stats.hits++; // live hit (decisions/0019)
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
            if (this._stats !== null) this._stats.puts++; // successful update (outcome-based); decisions/0019
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
        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); decisions/0019

        // Fire onEvict LAST, cache fully consistent (decisions/0002).
        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (decisions/0019)
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
        if (this._stats !== null) this._stats.evictions++; // reap = eviction (decisions/0019, D19.2)
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

    // --- opt-in runtime stats (decisions/0019, D19): cold accessors -----------

    /** The live stats holder (decisions/0019, D19.3), returned BY REFERENCE (borrowed --
     *  copy what you keep). Fail closed on an instance built without { stats: true }. */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE (decisions/0019); a borrowed holder stays valid.
     *  Fail closed on a non-stats instance. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        const st = this._stats;
        st.hits = 0; st.misses = 0; st.evictions = 0; st.puts = 0;
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

    // --- snapshot / restore (decisions/0021, D21): COLD, may allocate --------

    /** Serialize to a plain snapshot (decisions/0021): the MAIN + SMALL rings (each
     *  newest..oldest) + values (+ expiry) + per-entry visited bits, AND the keys-only
     *  ghost FIFO (oldest..newest). Dropping the ghost is a fail-OPEN admission bug, so
     *  it is captured. COLD; may allocate. */
    dump() {
        const snap = snapBase(this, "S3Fifo");
        snap.main = snapList(this, this._mHead, true);
        snap.small = snapList(this, this._sHead, true);
        snap.ghost = snapGhostRing(this);
        return snap;
    }

    /** Reconstruct a FRESH S3Fifo from a snapshot (decisions/0021). Fail closed on any
     *  mismatch. The ghost is replayed oldest..newest so its FIFO order (and thus future
     *  admission) is exact. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "S3Fifo", opts);
        const inst = new S3Fifo(cap, snapOpts(snap, opts));
        if (!Array.isArray(snap.ghost)) throw new Error(SNAP_BAD + "s3fifo snapshot missing ghost array");
        if (snap.ghost.length > inst._ghostCap) {
            throw new Error(SNAP_BAD + "s3fifo ghost (" + snap.ghost.length + ") exceeds ghostCap (" + inst._ghostCap + ")");
        }
        const occ = snapCheckOccupy(cap, snap.ttl, [[snap.main, "main", true], [snap.small, "small", true]]);
        const M = snapRestoreList(inst, snap.main, "_q", Q_MAIN);
        inst._mHead = M.head; inst._mTail = M.tail; inst._mSize = M.size;
        const S = snapRestoreList(inst, snap.small, "_q", Q_SMALL);
        inst._sHead = S.head; inst._sTail = S.tail; inst._sSize = S.size;
        inst._size = inst._sSize + inst._mSize;
        const gInt = typeof inst._store._ck === "function";
        for (let i = 0; i < snap.ghost.length; i++) {
            if (gInt) inst._store._ck(snap.ghost[i]); // fail closed on a non-int ghost key (D21.3, NIT2)
            inst._ghostAdd(snap.ghost[i]);
        }
        inst._store.rebuildFreeList(occ);
        return inst;
    }

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

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
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
        if (s < 0) { if (this._stats !== null) this._stats.misses++; return undefined; } // miss (decisions/0019)
        // TTL gate (decisions/0017, D17.3): a stale hit is a MISS -- no sketch bump, no
        // promotion, reaped in place. Only reached when ttl is configured.
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (this._stats !== null) this._stats.misses++; // stale = miss (+ evict via _reap; D19.2)
            this._reap(s);
            return undefined;
        }
        this._sketchInc(this._hashKey(key, s));
        this._onHit(s);
        if (this._stats !== null) this._stats.hits++; // live hit (decisions/0019)
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
            if (this._stats !== null) this._stats.puts++; // successful update (outcome-based); decisions/0019
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
        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); decisions/0019

        // Fire onEvict LAST, cache fully consistent (decisions/0002).
        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (decisions/0019)
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
        if (this._stats !== null) this._stats.evictions++; // reap = eviction (decisions/0019, D19.2)
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

    // --- opt-in runtime stats (decisions/0019, D19): cold accessors -----------

    /** The live stats holder (decisions/0019, D19.3), returned BY REFERENCE (borrowed --
     *  copy what you keep). Fail closed on an instance built without { stats: true }. */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE (decisions/0019); a borrowed holder stays valid.
     *  Fail closed on a non-stats instance. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        const st = this._stats;
        st.hits = 0; st.misses = 0; st.evictions = 0; st.puts = 0;
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

    // --- snapshot / restore (decisions/0021, D21): COLD, may allocate --------

    /** Serialize to a plain snapshot (decisions/0021): the WINDOW + PROTECTED + PROBATION
     *  segments (each MRU..LRU) + values (+ expiry), AND the Count-Min sketch `_sk` (as a
     *  plain number array) with its aging counter `_skSize` VERBATIM. Dropping the sketch
     *  silently changes admission = fail-OPEN, so it is captured. COLD; may allocate. */
    dump() {
        const snap = snapBase(this, "WTinyLfu");
        snap.window = snapList(this, this._wHead, false);
        snap.prot = snapList(this, this._ptHead, false);
        snap.prob = snapList(this, this._prHead, false);
        snap.sk = Array.from(this._sk);
        snap.skSize = this._skSize;
        return snap;
    }

    /** Reconstruct a FRESH WTinyLfu from a snapshot (decisions/0021). Fail closed on any
     *  mismatch, incl. a sketch of the wrong length. The sketch + aging counter are
     *  restored VERBATIM so future admission decisions are exact. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "WTinyLfu", opts);
        const inst = new WTinyLfu(cap, snapOpts(snap, opts));
        if (!Array.isArray(snap.sk) || snap.sk.length !== inst._sk.length) {
            throw new Error(SNAP_BAD + "wtinylfu sketch length mismatch (expected " + inst._sk.length + ")");
        }
        if (!Number.isInteger(snap.skSize) || snap.skSize < 0) {
            throw new Error(SNAP_BAD + "wtinylfu skSize invalid: " + String(snap.skSize));
        }
        const occ = snapCheckOccupy(cap, snap.ttl, [[snap.window, "window"], [snap.prot, "prot"], [snap.prob, "prob"]]);
        const W = snapRestoreList(inst, snap.window, "_seg", SEG_WINDOW);
        inst._wHead = W.head; inst._wTail = W.tail; inst._wSize = W.size;
        const PT = snapRestoreList(inst, snap.prot, "_seg", SEG_PROTECTED);
        inst._ptHead = PT.head; inst._ptTail = PT.tail; inst._ptSize = PT.size;
        const PR = snapRestoreList(inst, snap.prob, "_seg", SEG_PROBATION);
        inst._prHead = PR.head; inst._prTail = PR.tail; inst._prSize = PR.size;
        inst._size = inst._wSize + inst._prSize + inst._ptSize;
        inst._sk.set(snap.sk);
        inst._skSize = snap.skSize;
        inst._store.rebuildFreeList(occ);
        return inst;
    }

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

/* -------------------------------------------------------------------------- *
 * Slru -- Segmented LRU (decisions/0015, D15): a probation FIFO (~20%) in front of a
 * protected LRU (~80%), the simplest scan-resistant baseline. The FIFTH named export
 * in this file (same file-shape ruling: single main file + sideEffects:false + named
 * exports = the tree-shake moat; D15.1 -- two thin exports, NOT one member with a mode
 * flag, so each hot path stays monomorphic).
 *
 * Two intrusive lists threaded through the shared `_next`/`_prev` columns, tagged per
 * slot by `_seg` (0 = probation, 1 = protected). `_next` toward the tail (LRU/oldest),
 * `_prev` toward the head (MRU/newest). A newcomer enters PROBATION unvisited. A hit
 * PROMOTES on the SECOND touch (D15): the first hit sets `_vis[s]` and does NOTHING
 * structural (probation is FIFO -- no reorder); the second hit clears the bit and moves
 * the entry to PROTECTED MRU, demoting protected's LRU tail back to probation MRU on
 * overflow (`_protSize > protectedCap`). A protected hit moves to protected MRU.
 * has/peek are neutral. At capacity a new key evicts the PROBATION tail (oldest), or --
 * only when probation is empty -- the protected tail; because eviction ALWAYS prefers
 * probation, a distinct one-hit-wonder scan never displaces a protected entry.
 *
 * Rides the shared `newStore` factory (default Map / opt-in keys:'int' strict-zero),
 * the conservation invariant, the onEvict fire-after + `_inOnEvict` guard (0002), TTL
 * (0017), zero-GC iteration (0018), and opt-in stats (0019).
 * -------------------------------------------------------------------------- */

export class Slru {
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
        this._next = this._store._next; // toward the tail (LRU/oldest)
        this._prev = this._store._prev; // toward the head (MRU/newest)
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // D15 -- one segment tag per slot so `_detach` fixes the correct list, and one
        // visited byte per slot for the promote-on-2nd-hit rule (probation only). Both
        // fixed size, allocated once, never grown.
        this._seg = new Uint8Array(capacity);
        this._vis = new Uint8Array(capacity);

        // D15.2 -- the 80/20 split, frozen here. protectedCap == capacity at cap 1/2
        // (probation transiently holds newcomers; eviction still prefers probation).
        this._protectedCap = Math.round(capacity * 0.8);

        this._probHead = NIL; this._probTail = NIL; this._probSize = 0; // PROBATION FIFO
        this._protHead = NIL; this._protTail = NIL; this._protSize = 0; // PROTECTED LRU
        this._size = 0;                                                 // _probSize + _protSize

        this._onEvict = (options && options.onEvict) || NOOP;
        this._inOnEvict = false;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl) {
        return newStore(capacity, keys, hasTtl);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- intrusive list helpers (per-segment size accounting) -----------------

    /** Unlink slot s from WHICHEVER list it is in (per `_seg[s]`), fixing that list's
     *  neighbours + head/tail sentinels + size. */
    _detach(s) {
        const p = this._prev[s], n = this._next[s];
        if (this._seg[s] === SLRU_PROBATION) {
            if (p !== NIL) this._next[p] = n; else this._probHead = n;
            if (n !== NIL) this._prev[n] = p; else this._probTail = p;
            this._probSize--;
        } else {
            if (p !== NIL) this._next[p] = n; else this._protHead = n;
            if (n !== NIL) this._prev[n] = p; else this._protTail = p;
            this._protSize--;
        }
    }

    /** Insert slot s at the head (MRU/newest end) of the PROBATION FIFO. */
    _pushProbation(s) {
        this._seg[s] = SLRU_PROBATION;
        this._prev[s] = NIL; this._next[s] = this._probHead;
        if (this._probHead !== NIL) this._prev[this._probHead] = s;
        this._probHead = s; if (this._probTail === NIL) this._probTail = s;
        this._probSize++;
    }

    /** Insert slot s at the head (MRU end) of the PROTECTED LRU. */
    _pushProtected(s) {
        this._seg[s] = SLRU_PROTECTED;
        this._prev[s] = NIL; this._next[s] = this._protHead;
        if (this._protHead !== NIL) this._prev[this._protHead] = s;
        this._protHead = s; if (this._protTail === NIL) this._protTail = s;
        this._protSize++;
    }

    /** On a HIT (get or put-update): protected -> protected MRU; probation -> set the
     *  visited bit on the FIRST hit (FIFO, no reorder), PROMOTE to protected on the
     *  SECOND hit, demoting protected's LRU tail back to probation on overflow (D15). */
    _touch(s) {
        if (this._seg[s] === SLRU_PROTECTED) {
            if (this._protHead !== s) { this._detach(s); this._pushProtected(s); }
        } else if (this._vis[s] === 0) {
            this._vis[s] = 1; // first hit: mark, stay in probation (FIFO)
        } else {
            this._vis[s] = 0; // second hit: promote to protected
            this._detach(s);
            this._pushProtected(s);
            if (this._protSize > this._protectedCap) { // protected full -> demote its LRU
                const d = this._protTail;
                this._detach(d);
                this._vis[d] = 0;
                this._pushProbation(d);
            }
        }
    }

    /** Free exactly ONE slot and return it for reuse. Evicts the PROBATION tail
     *  (oldest), or -- only when probation is empty -- the PROTECTED LRU tail. Only
     *  ever called at capacity, where at least one list is non-empty. */
    _evict() {
        const t = this._probSize > 0 ? this._probTail : this._protTail;
        const k = this._keys[t];
        this._detach(t);
        this._store.delete(k);
        return t;
    }

    // --- public API (all zero-alloc on the hot path) --------------------------

    /** Look up a key AND apply the promote-on-2nd-hit rule. @returns the value, or
     *  undefined if absent (see D7). */
    get(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const s = this._store.get(key);
        if (s < 0) { if (this._stats !== null) this._stats.misses++; return undefined; } // miss (0019)
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (this._stats !== null) this._stats.misses++; // stale = miss (+ evict via _reap; D19.2)
            this._reap(s);
            return undefined;
        }
        this._touch(s);
        if (this._stats !== null) this._stats.hits++; // live hit (0019)
        return this._vals[s];
    }

    /**
     * Insert or update. An update rewrites the value and counts as a hit for the
     * promote-on-2nd-hit rule. A new key enters PROBATION; at capacity one entry is
     * evicted (probation tail, or protected tail when probation is empty) and its slot
     * reused in place. onEvict fires LAST (0002). The positional `ttlMs` (0017, D17.4)
     * overrides the instance ttl default.
     */
    put(key, value, ttlMs) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        let expiresAt;
        if (this._exp !== null) expiresAt = expiryFor(this._clock, this._ttl, ttlMs);
        else if (ttlMs !== undefined) throw new Error(TTL_NO_COLUMN_MSG); // fail closed (D17.4)
        this._store._ver++; // D18.6 -- put mutates (update/insert/evict); invalidate iterators
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                 // update-in-place + touch
            this._vals[existing] = value;
            if (this._exp !== null) this._exp[existing] = expiresAt; // restamp (D17)
            this._touch(existing);
            if (this._stats !== null) this._stats.puts++; // successful update (outcome-based); 0019
            return;
        }

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
        this._vis[s] = 0;               // a newcomer starts UNVISITED in probation
        store.set(key, s);
        this._pushProbation(s);         // newcomers ALWAYS enter probation
        this._size = this._probSize + this._protSize;
        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); 0019

        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (0019)
            this._inOnEvict = true;
            try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
        }
    }

    /** True if key is present (RESIDENT). Promotion-NEUTRAL. A stale entry is a MISS and
     *  is reaped in place (decisions/0017, D17.3). */
    has(key) {
        const s = this._store.get(key);
        if (s < 0) return false;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return false;
        }
        return true;
    }

    /** Read a value WITHOUT promoting. undefined if absent (see D7). A stale entry is a
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

    /** Reap an expired slot in place (decisions/0017): unlink from its segment, drop from
     *  the index, zero the visited byte, free the slot, and fire onEvict LAST via the
     *  0002 guard. A reap is NOT an eviction victim, so it is never counted as promotion. */
    _reap(s) {
        this._store._ver++; // D18.6 -- a reap is a structural mutation; invalidate iterators
        const evKey = this._keys[s];
        const evVal = this._vals[s];
        this._detach(s);
        this._store.delete(evKey);
        this._vis[s] = 0;
        this._store.freeSlot(s);
        this._size = this._probSize + this._protSize;
        if (this._stats !== null) this._stats.evictions++; // reap = eviction (0019, D19.2)
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

    /** Remove a key. Returns true if it was present. Frees the slot, zeroes its visited
     *  byte, repairs the segment it was in. A delete is NOT an eviction. */
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
        this._size = this._probSize + this._protSize;
        return true;
    }

    /** Empty the cache. Rebuilds the free list, zeroes visited, empties both segments.
     *  Allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._vis.fill(0);
        this._probHead = NIL; this._probTail = NIL; this._probSize = 0;
        this._protHead = NIL; this._protTail = NIL; this._protSize = 0;
        this._size = 0;
    }

    // --- opt-in runtime stats (decisions/0019, D19): cold accessors -----------

    /** The live stats holder (decisions/0019, D19.3), returned BY REFERENCE (borrowed --
     *  copy what you keep). Fail closed on an instance built without { stats: true }. */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE (decisions/0019); a borrowed holder stays valid.
     *  Fail closed on a non-stats instance. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        const st = this._stats;
        st.hits = 0; st.misses = 0; st.evictions = 0; st.puts = 0;
    }

    // --- iteration (decisions/0018, D18): zero-GC keys/values/entries ----------

    /** The per-member iteration ROSTER (decisions/0018, D18.1 / 0015 D15.4): PROTECTED
     *  (MRU->LRU) THEN PROBATION (MRU->LRU). Two segments concatenated -- NOT global
     *  recency order. */
    _iterHeads() { return [this._protHead, this._probHead]; }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- snapshot / restore (decisions/0021, D21): COLD, may allocate --------

    /** Serialize to a plain snapshot (decisions/0021): the PROTECTED + PROBATION segments
     *  (each MRU..LRU) + values (+ expiry) + per-entry visited bits (the promote-on-2nd-hit
     *  state). COLD; may allocate. */
    dump() {
        const snap = snapBase(this, "Slru");
        snap.prot = snapList(this, this._protHead, true);
        snap.prob = snapList(this, this._probHead, true);
        return snap;
    }

    /** Reconstruct a FRESH Slru from a snapshot (decisions/0021). Fail closed on any mismatch. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "Slru", opts);
        const inst = new Slru(cap, snapOpts(snap, opts));
        const occ = snapCheckOccupy(cap, snap.ttl, [[snap.prot, "prot", true], [snap.prob, "prob", true]]);
        const PT = snapRestoreList(inst, snap.prot, "_seg", SLRU_PROTECTED);
        inst._protHead = PT.head; inst._protTail = PT.tail; inst._protSize = PT.size;
        const PR = snapRestoreList(inst, snap.prob, "_seg", SLRU_PROBATION);
        inst._probHead = PR.head; inst._probTail = PR.tail; inst._probSize = PR.size;
        inst._size = inst._probSize + inst._protSize;
        inst._store.rebuildFreeList(occ);
        return inst;
    }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store (conservation invariant). */
    _freeListLength() {
        return this._store.freeListLength();
    }

    /**
     * The key the NEXT over-capacity insert would evict, computed WITHOUT mutating any
     * link, size or bit (the non-destructive twin of `_evict`). Same victim `_evict`
     * would pick: the probation tail, or the protected tail when probation is empty.
     * TEST-ONLY (drives the torture differential); never a hot path.
     */
    _peekVictim() {
        if (this._size === 0) return undefined;
        return this._probSize > 0 ? this._keys[this._probTail] : this._keys[this._protTail];
    }
}

/* -------------------------------------------------------------------------- *
 * TwoQ -- the full 2Q (Johnson & Shasha, VLDB'94), decisions/0015, D15: an A1in FIFO
 * (~25%) + an Am LRU + a fixed A1out ghost of keys evicted from A1in. The SIXTH named
 * export in this file (same file-shape ruling as Slru).
 *
 * Two intrusive queues threaded through the shared `_next`/`_prev` columns, tagged per
 * slot by `_seg` (0 = A1in, 1 = Am). `_next` toward the tail (oldest/LRU), `_prev`
 * toward the head (newest/MRU). A newcomer enters A1in (FIFO) UNLESS the key is in the
 * A1out ghost -- a second sighting of a recently-A1in-evicted key -- in which case it
 * is admitted straight to Am and consumed from the ghost (the ONLY path into Am). An
 * A1in hit does NOTHING (A1in is pure FIFO probation -- no promotion); an Am hit moves
 * the entry to Am MRU. has/peek are neutral. At capacity one reclaim step frees a slot:
 * if A1in is at/over its target (`_a1Size > a1inCap`) OR Am is empty, evict the A1in
 * tail and record its key in the ghost; else evict the Am LRU tail (NOT ghosted). A
 * distinct one-hit-wonder flood churns through A1in only, never displacing Am.
 *
 * The A1out ghost reuses the S3-FIFO `_gRing` pattern (decisions/0013): keys only,
 * bounded at construction (D15.3), strict zero-alloc on keys:'int', amortized on the
 * default Map backing. Rides the shared `newStore` factory, the conservation invariant,
 * the onEvict guard (0002), TTL (0017), iteration (0018), and stats (0019).
 * -------------------------------------------------------------------------- */

export class TwoQ {
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

        // Cache the store's columns so the queue relinks stay direct.
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next; // toward the tail (oldest/LRU)
        this._prev = this._store._prev; // toward the head (newest/MRU)
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // D15 -- one segment tag per slot so `_detach` fixes the correct queue. Fixed
        // size, allocated once, never grown. (TwoQ needs no visited bit -- A1in never
        // promotes internally; Am promotion is via the ghost path only.)
        this._seg = new Uint8Array(capacity);

        // D15.2 -- the splits, frozen here. a1inCap is at least 1; ghostCap is 0 only at
        // capacity 1 (the degenerate A1in-only edge).
        this._a1inCap = Math.max(1, Math.round(capacity * 0.25));
        this._amCap = capacity - this._a1inCap;
        this._ghostCap = this._amCap;

        this._a1Head = NIL; this._a1Tail = NIL; this._a1Size = 0; // A1in FIFO
        this._amHead = NIL; this._amTail = NIL; this._amSize = 0; // Am LRU
        this._size = 0;                                           // _a1Size + _amSize

        // A1out ghost backing (D15.3): mirrors S3-FIFO (decisions/0013) exactly. int ->
        // strict-zero open-addressed membership table + a pow2 Int32 FIFO ring. default
        // -> a Set membership + arbitrary-key array ring (amortized: a Set resize can
        // allocate).
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

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl) {
        return newStore(capacity, keys, hasTtl);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- intrusive queue helpers (per-segment size accounting) ----------------

    /** Unlink slot s from WHICHEVER queue it is in (per `_seg[s]`), fixing that queue's
     *  neighbours + head/tail sentinels + size. */
    _detach(s) {
        const p = this._prev[s], n = this._next[s];
        if (this._seg[s] === TWOQ_A1IN) {
            if (p !== NIL) this._next[p] = n; else this._a1Head = n;
            if (n !== NIL) this._prev[n] = p; else this._a1Tail = p;
            this._a1Size--;
        } else {
            if (p !== NIL) this._next[p] = n; else this._amHead = n;
            if (n !== NIL) this._prev[n] = p; else this._amTail = p;
            this._amSize--;
        }
    }

    /** Insert slot s at the head (newest end) of the A1in FIFO. */
    _pushA1in(s) {
        this._seg[s] = TWOQ_A1IN;
        this._prev[s] = NIL; this._next[s] = this._a1Head;
        if (this._a1Head !== NIL) this._prev[this._a1Head] = s;
        this._a1Head = s; if (this._a1Tail === NIL) this._a1Tail = s;
        this._a1Size++;
    }

    /** Insert slot s at the head (MRU end) of the Am LRU. */
    _pushAm(s) {
        this._seg[s] = TWOQ_AM;
        this._prev[s] = NIL; this._next[s] = this._amHead;
        if (this._amHead !== NIL) this._prev[this._amHead] = s;
        this._amHead = s; if (this._amTail === NIL) this._amTail = s;
        this._amSize++;
    }

    // --- A1out ghost helpers (keys only, bounded; int path strictly zero-alloc) --

    /** True if key is a recently-A1in-evicted ghost key (admission -> Am). */
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

    /** Record an A1in-evicted key in the ghost FIFO, evicting the oldest ghost key
     *  first when full. Zero-alloc on the int path. */
    _ghostAdd(key) {
        const cap = this._ghostCap;
        if (cap === 0) return;
        if (this._gLen === cap) {
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

    /** Remove a key from the ghost (it has just been re-admitted into Am). The ring
     *  shift is COLD -- only when admitting a key that was in ghost. */
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

    /** Int ghost membership delete (backward-shift, no tombstones). */
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

    /** Free exactly ONE slot and return it for reuse (the 2Q reclaim step). Evicts the
     *  A1in tail (recording its key in the ghost) when A1in is at/over its target OR Am
     *  is empty; else evicts the Am LRU tail (NOT ghosted). Only ever called at
     *  capacity, where the chosen queue is non-empty. */
    _evict() {
        if (this._a1Size > this._a1inCap || this._amSize === 0) {
            const t = this._a1Tail;
            const k = this._keys[t];
            this._detach(t);
            this._store.delete(k);
            this._ghostAdd(k); // A1in evictions -> ghost
            return t;
        }
        const t = this._amTail;
        this._detach(t);
        this._store.delete(this._keys[t]); // Am evictions are NOT ghosted
        return t;
    }

    // --- public API (all zero-alloc on the hot path) --------------------------

    /** Look up a key. An A1in hit does NOTHING (no promotion); an Am hit moves to Am
     *  MRU. @returns the value, or undefined if absent (see D7). */
    get(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const s = this._store.get(key);
        if (s < 0) { if (this._stats !== null) this._stats.misses++; return undefined; } // miss (0019)
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (this._stats !== null) this._stats.misses++; // stale = miss (+ evict via _reap; D19.2)
            this._reap(s);
            return undefined;
        }
        // Am hit: move to MRU. A1in hit: nothing (pure FIFO probation).
        if (this._seg[s] === TWOQ_AM && this._amHead !== s) { this._detach(s); this._pushAm(s); }
        if (this._stats !== null) this._stats.hits++; // live hit (0019)
        return this._vals[s];
    }

    /**
     * Insert or update. An update rewrites the value (an Am update moves to Am MRU; an
     * A1in update does not reorder). A new key enters A1in, UNLESS it is in the A1out
     * ghost (proven on a second sighting) -> straight to Am, consumed from ghost. At
     * capacity one reclaim step evicts + reuses a slot in place. onEvict fires LAST
     * (0002). The positional `ttlMs` (0017, D17.4) overrides the instance ttl default.
     */
    put(key, value, ttlMs) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        let expiresAt;
        if (this._exp !== null) expiresAt = expiryFor(this._clock, this._ttl, ttlMs);
        else if (ttlMs !== undefined) throw new Error(TTL_NO_COLUMN_MSG); // fail closed (D17.4)
        this._store._ver++; // D18.6 -- put mutates (update/insert/evict); invalidate iterators
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                 // update-in-place
            this._vals[existing] = value;
            if (this._exp !== null) this._exp[existing] = expiresAt; // restamp (D17)
            if (this._seg[existing] === TWOQ_AM && this._amHead !== existing) {
                this._detach(existing); this._pushAm(existing); // Am update -> MRU
            }
            if (this._stats !== null) this._stats.puts++; // successful update (outcome-based); 0019
            return;
        }

        // Admission decision uses the ghost state AT ARRIVAL (before this eviction's own
        // ghost write), so an eviction that bumps this key from ghost cannot flip it.
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
        store.set(key, s);
        if (toMain) this._pushAm(s); else this._pushA1in(s);
        this._size = this._a1Size + this._amSize;
        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); 0019

        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (0019)
            this._inOnEvict = true;
            try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
        }
    }

    /** True if key is present (RESIDENT). Ghost keys are NOT present. A stale entry is a
     *  MISS and is reaped in place (decisions/0017, D17.3). */
    has(key) {
        const s = this._store.get(key);
        if (s < 0) return false;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return false;
        }
        return true;
    }

    /** Read a value WITHOUT reordering. undefined if absent (see D7). A stale entry is a
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

    /** Reap an expired slot in place (decisions/0017): unlink from whichever queue, drop
     *  from the index, free the slot, and fire onEvict LAST via the 0002 guard. A reap is
     *  NOT an eviction, so it is never ghosted (like delete). */
    _reap(s) {
        this._store._ver++; // D18.6 -- a reap is a structural mutation; invalidate iterators
        const evKey = this._keys[s];
        const evVal = this._vals[s];
        this._detach(s);
        this._store.delete(evKey);
        this._store.freeSlot(s);
        this._size = this._a1Size + this._amSize;
        if (this._stats !== null) this._stats.evictions++; // reap = eviction (0019, D19.2)
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

    /** Remove a key. Returns true if it was present. Frees the slot, repairs the queue
     *  it was in. A delete is NOT an eviction, so it is never recorded in ghost. */
    delete(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const store = this._store;
        const s = store.get(key);
        if (s < 0) return false;
        store._ver++; // D18.6 -- a real delete is a structural mutation; invalidate iterators
        this._detach(s);
        store.delete(key);
        store.freeSlot(s);
        this._size = this._a1Size + this._amSize;
        return true;
    }

    /** Empty the cache. Rebuilds the free list, empties both queues and the ghost.
     *  Allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._a1Head = NIL; this._a1Tail = NIL; this._a1Size = 0;
        this._amHead = NIL; this._amTail = NIL; this._amSize = 0;
        this._size = 0;
        if (this._ghostCap > 0) {
            if (this._ghostInt) this._gixState.fill(0);
            else { this._gSet.clear(); this._gRingArr.fill(undefined); }
        }
        this._gHead = 0;
        this._gLen = 0;
    }

    // --- opt-in runtime stats (decisions/0019, D19): cold accessors -----------

    /** The live stats holder (decisions/0019, D19.3), returned BY REFERENCE (borrowed --
     *  copy what you keep). Fail closed on an instance built without { stats: true }. */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE (decisions/0019); a borrowed holder stays valid.
     *  Fail closed on a non-stats instance. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        const st = this._stats;
        st.hits = 0; st.misses = 0; st.evictions = 0; st.puts = 0;
    }

    // --- iteration (decisions/0018, D18): zero-GC keys/values/entries ----------

    /** The per-member iteration ROSTER (decisions/0018, D18.1 / 0015 D15.4): Am
     *  (MRU->LRU) THEN A1in (newest->oldest). The keys-only A1out ghost is EXCLUDED. */
    _iterHeads() { return [this._amHead, this._a1Head]; }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- snapshot / restore (decisions/0021, D21): COLD, may allocate --------

    /** Serialize to a plain snapshot (decisions/0021): the Am + A1in queues (each
     *  newest..oldest) + values (+ expiry), AND the keys-only A1out ghost FIFO
     *  (oldest..newest). Dropping the ghost is a fail-OPEN admission bug. COLD; may allocate. */
    dump() {
        const snap = snapBase(this, "TwoQ");
        snap.am = snapList(this, this._amHead, false);
        snap.a1in = snapList(this, this._a1Head, false);
        snap.ghost = snapGhostRing(this);
        return snap;
    }

    /** Reconstruct a FRESH TwoQ from a snapshot (decisions/0021). Fail closed on any
     *  mismatch. The ghost is replayed oldest..newest so its FIFO order is exact. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "TwoQ", opts);
        const inst = new TwoQ(cap, snapOpts(snap, opts));
        if (!Array.isArray(snap.ghost)) throw new Error(SNAP_BAD + "twoq snapshot missing ghost array");
        if (snap.ghost.length > inst._ghostCap) {
            throw new Error(SNAP_BAD + "twoq ghost (" + snap.ghost.length + ") exceeds ghostCap (" + inst._ghostCap + ")");
        }
        const occ = snapCheckOccupy(cap, snap.ttl, [[snap.am, "am"], [snap.a1in, "a1in"]]);
        const AM = snapRestoreList(inst, snap.am, "_seg", TWOQ_AM);
        inst._amHead = AM.head; inst._amTail = AM.tail; inst._amSize = AM.size;
        const A1 = snapRestoreList(inst, snap.a1in, "_seg", TWOQ_A1IN);
        inst._a1Head = A1.head; inst._a1Tail = A1.tail; inst._a1Size = A1.size;
        inst._size = inst._a1Size + inst._amSize;
        const gInt = typeof inst._store._ck === "function";
        for (let i = 0; i < snap.ghost.length; i++) {
            if (gInt) inst._store._ck(snap.ghost[i]); // fail closed on a non-int ghost key (D21.3, NIT2)
            inst._ghostAdd(snap.ghost[i]);
        }
        inst._store.rebuildFreeList(occ);
        return inst;
    }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store (conservation invariant). */
    _freeListLength() {
        return this._store.freeListLength();
    }

    /**
     * The key the NEXT over-capacity insert would evict, computed WITHOUT mutating any
     * link, size or the ghost (the non-destructive twin of `_evict`). Same victim
     * `_evict` would pick: the A1in tail when A1in is at/over its target or Am is empty,
     * else the Am LRU tail. TEST-ONLY (drives the torture differential); never a hot path.
     */
    _peekVictim() {
        if (this._size === 0) return undefined;
        if (this._a1Size > this._a1inCap || this._amSize === 0) return this._keys[this._a1Tail];
        return this._keys[this._amTail];
    }
}

/* -------------------------------------------------------------------------- *
 * ArcGhost -- one bounded, keys-only ghost list for ARC (decisions/0016, D16.2).
 * INTERNAL, never an export. The two-ghost realization of the S3-FIFO/TwoQ `_gRing`
 * pattern (decisions/0013, 0015): a FIFO ring of KEYS (NEVER values) with O(1)
 * membership, bounded to `cap` at construction and NEVER grown. `keys:'int'` -> strict
 * zero-alloc (a pow2 Int32 ring + an open-addressed Int32 membership table with
 * backward-shift deletion, no tombstones); the default Map backing -> a Set membership
 * + an Array ring (honestly AMORTIZED -- a Set resize can allocate, the D3/D11 caveat).
 * MRU add at the tail, LRU drop/peek at the head; `consume(key)` removes a specific key
 * on re-admission (a COLD ring shift, never on the sequential-key hot path). Every
 * method is zero-alloc on the int path.
 * -------------------------------------------------------------------------- */

class ArcGhost {
    constructor(cap, isInt) {
        this._cap = cap;
        this._int = isInt;
        this._len = 0;   // live ghost keys (0 .. cap)
        this._head = 0;  // ring index of the OLDEST (LRU) key
        if (cap > 0) {
            if (isInt) {
                const need = Math.ceil(cap / 0.75);
                let gs = 1;
                while (gs < need) gs <<= 1;
                this._ixMask = gs - 1;
                this._ixKey = new Int32Array(gs);
                this._ixState = new Uint8Array(gs); // 0 = empty, 1 = occupied
                let rs = 1;
                while (rs < cap) rs <<= 1; // pow2 ring so indices mask
                this._ringMask = rs - 1;
                this._ring = new Int32Array(rs);
            } else {
                this._set = new Set();                        // key -> nothing (membership)
                this._ringArr = new Array(cap).fill(undefined); // FIFO order
            }
        }
    }

    /** True if key is a ghost key (int path is open-addressed, zero-alloc). */
    has(key) {
        if (this._cap === 0) return false;
        if (this._int) {
            const st = this._ixState, ks = this._ixKey, mask = this._ixMask;
            let b = hashInt(key, mask);
            for (;;) {
                if (st[b] === 0) return false;
                if (ks[b] === key) return true;
                b = (b + 1) & mask;
            }
        }
        return this._set.has(key);
    }

    /** Add key at the MRU (tail) end. Caller GUARANTEES room (_len < cap). */
    addMRU(key) {
        if (this._cap === 0) return;
        if (this._int) {
            const pos = (this._head + this._len) & this._ringMask;
            this._ring[pos] = key;
            this._memAdd(key);
        } else {
            const pos = (this._head + this._len) % this._cap;
            this._ringArr[pos] = key;
            this._set.add(key);
        }
        this._len++;
    }

    /** Drop the LRU (oldest, head) key and return it. Caller GUARANTEES _len > 0. */
    delLRU() {
        if (this._int) {
            const key = this._ring[this._head];
            this._memDel(key);
            this._head = (this._head + 1) & this._ringMask;
            this._len--;
            return key;
        }
        const key = this._ringArr[this._head];
        this._set.delete(key);
        this._ringArr[this._head] = undefined; // drop the key ref (retention hygiene)
        this._head = (this._head + 1) % this._cap;
        this._len--;
        return key;
    }

    /** Remove a SPECIFIC key (re-admission). COLD ring shift; never a hot path. */
    consume(key) {
        if (this._cap === 0) return;
        if (this._int) {
            const mask = this._ringMask;
            let idx = -1;
            for (let i = 0; i < this._len; i++) {
                if (this._ring[(this._head + i) & mask] === key) { idx = i; break; }
            }
            if (idx >= 0) {
                for (let i = idx; i < this._len - 1; i++) {
                    this._ring[(this._head + i) & mask] = this._ring[(this._head + i + 1) & mask];
                }
                this._len--;
            }
            this._memDel(key);
        } else {
            const cap = this._cap;
            let idx = -1;
            for (let i = 0; i < this._len; i++) {
                if (sameKey(this._ringArr[(this._head + i) % cap], key)) { idx = i; break; }
            }
            if (idx >= 0) {
                for (let i = idx; i < this._len - 1; i++) {
                    this._ringArr[(this._head + i) % cap] = this._ringArr[(this._head + i + 1) % cap];
                }
                this._ringArr[(this._head + this._len - 1) % cap] = undefined;
                this._len--;
            }
            this._set.delete(key);
        }
    }

    /** Empty the ghost (retention hygiene: drop every key ref). */
    clear() {
        if (this._cap > 0) {
            if (this._int) this._ixState.fill(0);
            else { this._set.clear(); this._ringArr.fill(undefined); }
        }
        this._head = 0;
        this._len = 0;
    }

    /** Int membership insert (open-addressed, no-op if already present). */
    _memAdd(key) {
        const st = this._ixState, ks = this._ixKey, mask = this._ixMask;
        let b = hashInt(key, mask);
        for (;;) {
            if (st[b] === 0) { st[b] = 1; ks[b] = key; return; }
            if (ks[b] === key) return;
            b = (b + 1) & mask;
        }
    }

    /** Int membership delete (backward-shift, no tombstones). */
    _memDel(key) {
        const st = this._ixState, ks = this._ixKey, mask = this._ixMask;
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
}

/* -------------------------------------------------------------------------- *
 * Arc -- the Adaptive Replacement Cache (Megiddo & Modha, FAST'03), decisions/0016,
 * D16. The seventh named export in this file (same file-shape ruling: single main file
 * + sideEffects:false + named exports = the tree-shake moat; D16.1 -- ONE adaptive
 * member, no sibling and no mode flag, so each hot path stays monomorphic).
 *
 * ARC splits the resident set into a RECENT list T1 (seen once) and a FREQUENT list T2
 * (seen 2+), threaded through the shared `_next`/`_prev` columns, tagged per slot by
 * `_seg` (0 = T1, 1 = T2). `_next` toward the tail (LRU/oldest), `_prev` toward the head
 * (MRU/newest). A single integer `p` (the T1 target size, 0..c) ADAPTS the split on its
 * own -- no knobs. Two bounded keys-only ghosts drive it: B1 (keys evicted from T1) and
 * B2 (keys evicted from T2). A miss whose key is found in B1 means "a RECENT page was
 * evicted too soon" -> raise `p`; found in B2 means "a FREQUENT page was evicted too
 * soon" -> lower `p` (D16.3). At capacity a new resident is admitted only after REPLACE
 * evicts one (D16.4), so the RESIDENT value capacity stays EXACTLY `capacity` -- only the
 * split adapts, never the total (D16.2, fixed-capacity honesty).
 *
 * A hit (get or put-update) promotes the entry to T2 MRU (ARC promotes any hit to
 * frequent). `has`/`peek` are neutral. A `get` never touches the ghosts (ghost
 * interaction is a cold `put`-only path, so the get hot path carries no ghost branch).
 *
 * Rides the shared `newStore` factory (default Map / opt-in keys:'int' strict-zero), the
 * conservation invariant, the onEvict fire-after + `_inOnEvict` guard (0002), TTL (0017),
 * zero-GC iteration (0018), and opt-in stats (0019). The two ghosts reuse the S3-FIFO/
 * TwoQ ring pattern (ArcGhost above): keys only, bounded at construction, strict-zero on
 * keys:'int', amortized on the Map backing.
 * -------------------------------------------------------------------------- */

export class Arc {
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
        this._next = this._store._next; // toward the tail (LRU/oldest)
        this._prev = this._store._prev; // toward the head (MRU/newest)
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // D16 -- one segment tag per slot (0 = T1, 1 = T2) so `_detach` fixes the correct
        // list. Fixed size, allocated once, never grown.
        this._seg = new Uint8Array(capacity);

        this._t1Head = NIL; this._t1Tail = NIL; this._t1Size = 0; // T1 (recent) LRU
        this._t2Head = NIL; this._t2Tail = NIL; this._t2Size = 0; // T2 (frequent) LRU
        this._size = 0;                                           // _t1Size + _t2Size

        // D16.3 -- the adaptive target size for T1, a single integer (0..capacity). Never
        // allocates. Starts recency-neutral at 0.
        this._p = 0;

        // D16.2 -- the two bounded keys-only ghosts, each sized to hold up to `capacity`
        // keys (|B1| <= c and |B2| <= c follow from the invariants). Combined budget is c.
        this._ghostCap = capacity;
        this._ghostInt = (options && options.keys) === 'int';
        this._b1 = new ArcGhost(capacity, this._ghostInt);
        this._b2 = new ArcGhost(capacity, this._ghostInt);

        this._onEvict = (options && options.onEvict) || NOOP;
        this._inOnEvict = false;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl) {
        return newStore(capacity, keys, hasTtl);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- intrusive LRU-list helpers (per-list size accounting) ----------------

    /** Unlink slot s from WHICHEVER list it is in (per `_seg[s]`), fixing that list's
     *  neighbours + head/tail sentinels + size. */
    _detach(s) {
        const p = this._prev[s], n = this._next[s];
        if (this._seg[s] === ARC_T1) {
            if (p !== NIL) this._next[p] = n; else this._t1Head = n;
            if (n !== NIL) this._prev[n] = p; else this._t1Tail = p;
            this._t1Size--;
        } else {
            if (p !== NIL) this._next[p] = n; else this._t2Head = n;
            if (n !== NIL) this._prev[n] = p; else this._t2Tail = p;
            this._t2Size--;
        }
    }

    /** Insert slot s at the head (MRU end) of T1 (recent). */
    _pushT1(s) {
        this._seg[s] = ARC_T1;
        this._prev[s] = NIL; this._next[s] = this._t1Head;
        if (this._t1Head !== NIL) this._prev[this._t1Head] = s;
        this._t1Head = s; if (this._t1Tail === NIL) this._t1Tail = s;
        this._t1Size++;
    }

    /** Insert slot s at the head (MRU end) of T2 (frequent). */
    _pushT2(s) {
        this._seg[s] = ARC_T2;
        this._prev[s] = NIL; this._next[s] = this._t2Head;
        if (this._t2Head !== NIL) this._prev[this._t2Head] = s;
        this._t2Head = s; if (this._t2Tail === NIL) this._t2Tail = s;
        this._t2Size++;
    }

    /** A HIT (get or put-update) promotes the entry to T2 MRU (ARC promotes any hit to
     *  frequent). A T2-head re-hit early-returns (no relink). */
    _onHit(s) {
        if (this._seg[s] === ARC_T2) {
            if (this._t2Head !== s) { this._detach(s); this._pushT2(s); }
        } else { // T1 -> promote to frequent
            this._detach(s);
            this._pushT2(s);
        }
    }

    /** Ensure the combined ghost has room (|B1|+|B2| < c) before an add: drop one LRU
     *  ghost key from the larger list (ties -> B1). Only entered when combined >= c. */
    _ghostRoom() {
        if (this._b1._len + this._b2._len < this._ghostCap) return;
        if (this._b1._len >= this._b2._len && this._b1._len > 0) this._b1.delLRU();
        else if (this._b2._len > 0) this._b2.delLRU();
        else if (this._b1._len > 0) this._b1.delLRU();
    }

    /**
     * REPLACE(xInB2) (decisions/0016, D16.4): evict exactly ONE resident to a ghost and
     * return its (reused-in-place) slot. Evict T1 LRU -> B1 when |T1| >= 1 and (|T1| > p
     * OR the boundary case xInB2 && |T1| == p); else evict T2 LRU -> B2. Defensively
     * total: if the chosen list is empty, evict the other. Only ever called at capacity.
     */
    _replace(xInB2) {
        let evictT1 = (this._t1Size >= 1) &&
            (this._t1Size > this._p || (xInB2 && this._t1Size === this._p));
        if (!evictT1 && this._t2Size === 0) evictT1 = true;   // T2 empty -> must take T1
        if (evictT1 && this._t1Size === 0) evictT1 = false;   // T1 empty -> must take T2
        let t;
        if (evictT1) {
            t = this._t1Tail;                 // T1 LRU
            const k = this._keys[t];
            this._detach(t);
            this._store.delete(k);
            this._ghostRoom();
            this._b1.addMRU(k);               // T1 eviction -> B1
        } else {
            t = this._t2Tail;                 // T2 LRU
            const k = this._keys[t];
            this._detach(t);
            this._store.delete(k);
            this._ghostRoom();
            this._b2.addMRU(k);               // T2 eviction -> B2
        }
        return t;
    }

    // --- public API (all zero-alloc on the hot path) --------------------------

    /** Look up a key. A hit promotes to T2 MRU (ARC: any hit -> frequent). @returns the
     *  value, or undefined if absent (see D7). A get never touches the ghosts. */
    get(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const s = this._store.get(key);
        if (s < 0) { if (this._stats !== null) this._stats.misses++; return undefined; } // miss (0019)
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (this._stats !== null) this._stats.misses++; // stale = miss (+ evict via _reap; D19.2)
            this._reap(s);
            return undefined;
        }
        this._onHit(s);
        if (this._stats !== null) this._stats.hits++; // live hit (0019)
        return this._vals[s];
    }

    /**
     * Insert or update. An update rewrites the value and promotes to T2 (like a hit). A
     * new key that is in B1 raises `p` and re-admits to T2; in B2 lowers `p` and re-admits
     * to T2; otherwise enters T1. At capacity one resident is evicted via REPLACE (or the
     * direct T1 evict) and its slot reused in place. onEvict fires LAST (0002). The
     * positional `ttlMs` (0017, D17.4) overrides the instance ttl default.
     */
    put(key, value, ttlMs) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        let expiresAt;
        if (this._exp !== null) expiresAt = expiryFor(this._clock, this._ttl, ttlMs);
        else if (ttlMs !== undefined) throw new Error(TTL_NO_COLUMN_MSG); // fail closed (D17.4)
        this._store._ver++; // D18.6 -- put mutates (update/insert/evict); invalidate iterators
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                 // update-in-place + promote to T2
            this._vals[existing] = value;
            if (this._exp !== null) this._exp[existing] = expiresAt; // restamp (D17)
            this._onHit(existing);
            if (this._stats !== null) this._stats.puts++; // successful update (outcome-based); 0019
            return;
        }

        const c = this._capacity;
        const inB1 = this._b1.has(key);
        const inB2 = inB1 ? false : this._b2.has(key);
        let s, evKey, evVal;
        let evicted = false;

        if (inB1) {
            // recency ghost hit (D16.3): raise p using the CURRENT ghost sizes (|B1| >= 1
            // since key is still in B1), consume the key, re-admit into T2.
            const b1 = this._b1._len, b2 = this._b2._len;
            let d = Math.floor(b2 / b1); if (d < 1) d = 1;
            this._p += d; if (this._p > c) this._p = c;
            this._b1.consume(key);
            if (this._size === c) { s = this._replace(false); evKey = this._keys[s]; evVal = this._vals[s]; evicted = true; }
            else s = store.allocSlot();
            this._keys[s] = key; this._vals[s] = value;
            if (this._exp !== null) this._exp[s] = expiresAt;
            store.set(key, s);
            this._pushT2(s);
        } else if (inB2) {
            // frequency ghost hit (D16.3): lower p, consume the key, re-admit into T2. The
            // boundary REPLACE (|T1| == p) tips toward evicting T1 (xInB2 = true).
            const b1 = this._b1._len, b2 = this._b2._len;
            let d = Math.floor(b1 / b2); if (d < 1) d = 1;
            this._p -= d; if (this._p < 0) this._p = 0;
            this._b2.consume(key);
            if (this._size === c) { s = this._replace(true); evKey = this._keys[s]; evVal = this._vals[s]; evicted = true; }
            else s = store.allocSlot();
            this._keys[s] = key; this._vals[s] = value;
            if (this._exp !== null) this._exp[s] = expiresAt;
            store.set(key, s);
            this._pushT2(s);
        } else {
            // true miss -> enters T1 (recent).
            if (this._t1Size === c) {
                // all resident in T1 (T2 empty, B1 empty): direct evict T1 LRU, NO ghost
                // (D16.4) -- pushT1 would otherwise overflow |T1| + |B1|.
                s = this._t1Tail;
                evKey = this._keys[s]; evVal = this._vals[s];
                this._detach(s);
                store.delete(evKey);
                evicted = true;
            } else {
                // keep |T1| + |B1| <= c: free an L1 slot before we push into T1 (D16.4).
                if (this._t1Size + this._b1._len === c) this._b1.delLRU();
                if (this._size === c) { s = this._replace(false); evKey = this._keys[s]; evVal = this._vals[s]; evicted = true; }
                else s = store.allocSlot();
            }
            this._keys[s] = key; this._vals[s] = value;
            if (this._exp !== null) this._exp[s] = expiresAt;
            store.set(key, s);
            this._pushT1(s);
        }

        this._size = this._t1Size + this._t2Size;
        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); 0019

        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (0019)
            this._inOnEvict = true;
            try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
        }
    }

    /** True if key is present (RESIDENT). Ghost keys are NOT present. Promotion-NEUTRAL. A
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

    /** Read a value WITHOUT promoting. undefined if absent (see D7). A stale entry is a
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

    /** Reap an expired slot in place (decisions/0017): unlink from its list, drop from the
     *  index, free the slot, and fire onEvict LAST via the 0002 guard. A reap is NOT a
     *  capacity victim, so it is never ghosted and never moves `p` (like delete). */
    _reap(s) {
        this._store._ver++; // D18.6 -- a reap is a structural mutation; invalidate iterators
        const evKey = this._keys[s];
        const evVal = this._vals[s];
        this._detach(s);
        this._store.delete(evKey);
        this._store.freeSlot(s);
        this._size = this._t1Size + this._t2Size;
        if (this._stats !== null) this._stats.evictions++; // reap = eviction (0019, D19.2)
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

    /** Remove a key. Returns true if it was present. Frees the slot, repairs the list it
     *  was in. A delete is NOT an eviction, so it is never recorded in a ghost and never
     *  moves `p`. */
    delete(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const store = this._store;
        const s = store.get(key);
        if (s < 0) return false;
        store._ver++; // D18.6 -- a real delete is a structural mutation; invalidate iterators
        this._detach(s);
        store.delete(key);
        store.freeSlot(s);
        this._size = this._t1Size + this._t2Size;
        return true;
    }

    /** Empty the cache. Rebuilds the free list, empties both lists and both ghosts, and
     *  resets `p`. Allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._t1Head = NIL; this._t1Tail = NIL; this._t1Size = 0;
        this._t2Head = NIL; this._t2Tail = NIL; this._t2Size = 0;
        this._size = 0;
        this._p = 0;
        this._b1.clear();
        this._b2.clear();
    }

    // --- opt-in runtime stats (decisions/0019, D19): cold accessors -----------

    /** The live stats holder (decisions/0019, D19.3), returned BY REFERENCE (borrowed --
     *  copy what you keep). Fail closed on an instance built without { stats: true }. */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE (decisions/0019); a borrowed holder stays valid.
     *  Fail closed on a non-stats instance. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        const st = this._stats;
        st.hits = 0; st.misses = 0; st.evictions = 0; st.puts = 0;
    }

    // --- iteration (decisions/0018, D18): zero-GC keys/values/entries ----------

    /** The per-member iteration ROSTER (decisions/0018, D18.1 / 0016 D16.5): T2 (frequent,
     *  MRU->LRU) THEN T1 (recent, MRU->LRU). Two segments concatenated -- NOT global
     *  recency order. The keys-only B1/B2 ghosts are EXCLUDED. */
    _iterHeads() { return [this._t2Head, this._t1Head]; }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- snapshot / restore (decisions/0021, D21): COLD, may allocate --------

    /** Serialize to a plain snapshot (decisions/0021): the T2 + T1 lists (each MRU..LRU)
     *  + values (+ expiry), the adaptive integer `p`, AND BOTH keys-only ghosts B1/B2
     *  (each oldest..newest). Dropping `p` or a ghost is a fail-OPEN adaptation bug, so
     *  all three are captured. COLD; may allocate. */
    dump() {
        const snap = snapBase(this, "Arc");
        snap.t2 = snapList(this, this._t2Head, false);
        snap.t1 = snapList(this, this._t1Head, false);
        snap.p = this._p;
        snap.b1 = snapArcGhost(this._b1);
        snap.b2 = snapArcGhost(this._b2);
        return snap;
    }

    /** Reconstruct a FRESH Arc from a snapshot (decisions/0021). Fail closed on any
     *  mismatch, a `p` out of [0,cap], or a ghost that would break a conservation bound
     *  (|T1|+|B1| <= c, |B1|+|B2| <= c). Ghosts are replayed oldest..newest. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "Arc", opts);
        const inst = new Arc(cap, snapOpts(snap, opts));
        const occ = snapCheckOccupy(cap, snap.ttl, [[snap.t2, "t2"], [snap.t1, "t1"]]);
        if (!Number.isInteger(snap.p) || snap.p < 0 || snap.p > cap) {
            throw new Error(SNAP_BAD + "arc p out of [0," + cap + "]: " + String(snap.p));
        }
        if (!Array.isArray(snap.b1) || !Array.isArray(snap.b2)) {
            throw new Error(SNAP_BAD + "arc snapshot missing a ghost array (b1/b2)");
        }
        if (snap.b1.length + snap.b2.length > cap) {
            throw new Error(SNAP_BAD + "arc |B1|+|B2| (" + (snap.b1.length + snap.b2.length) + ") exceeds capacity (" + cap + ")");
        }
        if (snap.t1.slots.length + snap.b1.length > cap) {
            throw new Error(SNAP_BAD + "arc |T1|+|B1| (" + (snap.t1.slots.length + snap.b1.length) + ") exceeds capacity (" + cap + ")");
        }
        const T2 = snapRestoreList(inst, snap.t2, "_seg", ARC_T2);
        inst._t2Head = T2.head; inst._t2Tail = T2.tail; inst._t2Size = T2.size;
        const T1 = snapRestoreList(inst, snap.t1, "_seg", ARC_T1);
        inst._t1Head = T1.head; inst._t1Tail = T1.tail; inst._t1Size = T1.size;
        inst._size = inst._t1Size + inst._t2Size;
        inst._p = snap.p;
        const gInt = typeof inst._store._ck === "function";
        for (let i = 0; i < snap.b1.length; i++) {
            if (gInt) inst._store._ck(snap.b1[i]); // fail closed on a non-int ghost key (D21.3, NIT2)
            inst._b1.addMRU(snap.b1[i]);
        }
        for (let i = 0; i < snap.b2.length; i++) {
            if (gInt) inst._store._ck(snap.b2[i]);
            inst._b2.addMRU(snap.b2[i]);
        }
        inst._store.rebuildFreeList(occ);
        return inst;
    }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store (conservation invariant). */
    _freeListLength() {
        return this._store.freeListLength();
    }

    /**
     * The key the NEXT over-capacity insert would evict, computed WITHOUT mutating any
     * link, size, `p` or ghost (the non-destructive twin of `_replace`). Mirrors
     * `_replace(false)` (the true-miss / B1-hit convention), so real + oracle agree on a
     * single, deterministic victim regardless of the incoming key. TEST-ONLY (drives the
     * torture differential); never a hot path.
     */
    _peekVictim() {
        if (this._size === 0) return undefined;
        let evictT1 = (this._t1Size >= 1) && (this._t1Size > this._p);
        if (!evictT1 && this._t2Size === 0) evictT1 = true;
        if (evictT1 && this._t1Size === 0) evictT1 = false;
        return evictT1 ? this._keys[this._t1Tail] : this._keys[this._t2Tail];
    }
}

/* -------------------------------------------------------------------------- *
 * LirsHistory -- the bounded, keys-only non-resident HIR history for LIRS
 * (decisions/0023, D23). A GENERALIZATION of ArcGhost: same open-addressed int ring
 * (strict zero-alloc on keys:'int') / Set + FIFO array (amortized on the Map backing),
 * bounded at construction to `capacity`. It stands in for the non-resident portion of
 * the textbook LIRS stack S: a non-resident HIR block is "still in S" iff its key is
 * still in this bounded ring; when the bound is hit we drop the OLDEST key -- a bounded,
 * honest deviation from the unbounded textbook stack (D23). INTERNAL, never exported.
 * -------------------------------------------------------------------------- */

class LirsHistory extends ArcGhost {}

/* -------------------------------------------------------------------------- *
 * Lirs -- Low Inter-reference Recency Set (Jiang & Zhang, SIGMETRICS'02),
 * decisions/0023, D23. The EIGHTH named export in this file (same file-shape ruling:
 * single main file + sideEffects:false + named exports = the tree-shake moat).
 *
 * LIRS evicts by RECENCY-OF-RECENCY: a block's IRR (inter-reference recency) is the
 * count of DISTINCT blocks referenced between its last two accesses. A LOW-IRR block is
 * "hot" (LIR set, resident); a HIGH-IRR block is "cold" (HIR -- resident metadata in a
 * small reserve, or non-resident metadata only). This is the strongest scan/loop
 * resistance in the family and a genuinely NEW mechanism vs recency/frequency/adaptation.
 *
 * Fixed-capacity honesty (D23, restating Arc's D16.2): the RESIDENT value capacity is
 * EXACTLY `capacity`. It is split L_hir = max(1, round(capacity * 0.01)) resident HIR
 * slots + L_lir = capacity - L_hir LIR slots; only the split is fixed, |LIR| + |resident
 * HIR| == size always. The non-resident history is bounded SEPARATELY (LirsHistory,
 * cap = capacity, drop-oldest -- D23).
 *
 * STRUCTURES (all fixed at construction, zero-alloc on the hot path):
 *   - Stack S (member `_sNext`/`_sPrev`, `_sTop` MRU .. `_sBot` LRU): the resident blocks
 *     currently IN S (every LIR block + the resident HIR blocks not yet pruned). Subject
 *     to STACK PRUNING: HIR blocks are dropped from the bottom until the bottom is a LIR.
 *   - List Q (the SHARED `_next`/`_prev`, `_qHead` front/oldest .. `_qTail`): ALL resident
 *     HIR blocks, in eviction (FIFO) order -- the eviction candidates.
 *   - The LIR list (the SHARED `_next`/`_prev`, `_lirHead`/`_lirTail`): ALL LIR blocks.
 *     The LIR list + Q are a DISJOINT partition of the resident set over the shared link
 *     columns (a slot is LIR xor resident-HIR), so validate()/iteration reuse the shared
 *     machinery unchanged; the interleaved stack S rides its OWN member columns.
 *   - `_st` Uint8: bit0 LIR, bit1 inS (the single hot-path test).
 *   - `_hist` (LirsHistory): the bounded non-resident HIR keys.
 *
 * HOT PATHS (proven zero-alloc by the torture gate): a LIR hit at the top of S early-
 * returns with 0 link writes; a LIR hit elsewhere is the 5-write "move to top of S". The
 * resident-HIR hit + the miss/replace paths reach the cold, allocation-free helpers
 * `_prune` / `_promoteToLir` / `_demoteBottomLir` / `_replace` -- never inlined into the
 * LIR-hit body. Rides the shared newStore factory, the onEvict fire-after + `_inOnEvict`
 * guard (0002), TTL (0017), zero-GC iteration (0018), stats (0019), snapshot (0021).
 * -------------------------------------------------------------------------- */

export class Lirs {
    /**
     * @param {number} capacity  Max resident entries. Must be an integer >= 1.
     * @param {{ onEvict?: (key: any, value: any) => void, keys?: 'int' }} [options]
     */
    constructor(capacity, options) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new RangeError(
                "[lite-lru] capacity must be an integer >= 1, got " + String(capacity)
            );
        }

        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed -- identical to the rest of the family.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as every other member.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined);

        // Cache the store's columns so the relinks stay direct.
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next; // SHARED: threads the LIR list AND Q (disjoint) + free stack
        this._prev = this._store._prev;
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // The interleaved stack S rides its OWN member link columns (D23): a slot may be in
        // BOTH the shared list (LIR list / Q) and S at once, so S needs separate links.
        this._sNext = new Int32Array(capacity);
        this._sPrev = new Int32Array(capacity);
        this._sTop = NIL; // MRU end of the stack
        this._sBot = NIL; // LRU end of the stack (kept a LIR by pruning)

        // Per-slot state (bit0 LIR, bit1 inS). Member-specific, fixed, never grown.
        this._st = new Uint8Array(capacity);

        // The LIR list (shared columns): all LIR blocks. `_lirHead` MRU-ish (order does not
        // steer policy -- only S + Q orders do -- it exists for conservation + iteration).
        this._lirHead = NIL; this._lirTail = NIL; this._lirCount = 0;

        // The list Q (shared columns): all resident HIR blocks, FIFO eviction order.
        this._qHead = NIL; this._qTail = NIL;

        this._size = 0; // resident = |LIR| + |resident HIR| = _lirCount + |Q|

        // The resident split (D23). cap 1 -> L_hir 1, L_lir 0 (all-HIR window edge).
        this._Lhir = Math.max(1, Math.round(capacity * 0.01));
        this._Llir = capacity - this._Lhir;

        // The bounded non-resident HIR history (D23): keys only, cap = capacity, drop-oldest.
        this._histCap = capacity;
        this._histInt = (options && options.keys) === 'int';
        this._hist = new LirsHistory(capacity, this._histInt);

        this._onEvict = (options && options.onEvict) || NOOP;
        this._inOnEvict = false;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl) {
        return newStore(capacity, keys, hasTtl);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- stack S helpers (member `_sNext`/`_sPrev`) ---------------------------

    /** Unlink slot s from the stack S. */
    _sDetach(s) {
        const p = this._sPrev[s], n = this._sNext[s];
        if (p !== NIL) this._sNext[p] = n; else this._sTop = n;
        if (n !== NIL) this._sPrev[n] = p; else this._sBot = p;
    }

    /** Push slot s at the top (MRU end) of S. Caller sets the inS bit. */
    _sPushTop(s) {
        this._sPrev[s] = NIL; this._sNext[s] = this._sTop;
        if (this._sTop !== NIL) this._sPrev[this._sTop] = s;
        this._sTop = s; if (this._sBot === NIL) this._sBot = s;
    }

    /** Move an already-in-S slot to the top. No-op (0 writes) if already the top -- the
     *  pinned LIR-hit fast path. */
    _sMoveTop(s) {
        if (this._sTop === s) return;
        this._sDetach(s);
        this._sPushTop(s);
    }

    /** STACK PRUNING (D23): drop HIR blocks from the bottom of S until the bottom is a LIR
     *  (or S is empty). A pruned block stays RESIDENT (in Q); it just leaves S (inS cleared).
     *  COLD / out-of-line, allocation-free; amortized O(1), worst-case O(size) (an inherent
     *  LIRS characteristic -- MEASURED + pinned by the torture gate, never silently capped). */
    _prune() {
        let b = this._sBot;
        while (b !== NIL && (this._st[b] & LIRS_LIR) === 0) {
            const p = this._sPrev[b];       // next candidate up
            this._sNext[b] = NIL;           // (detach bottom)
            if (p !== NIL) this._sNext[p] = NIL; else this._sTop = NIL;
            this._sBot = p;
            this._st[b] &= ~LIRS_INS;       // left S, still resident in Q
            b = p;
        }
    }

    // --- the LIR list + Q helpers (shared `_next`/`_prev`) --------------------

    /** Push slot s at the head of the LIR list. */
    _lirPush(s) {
        this._prev[s] = NIL; this._next[s] = this._lirHead;
        if (this._lirHead !== NIL) this._prev[this._lirHead] = s;
        this._lirHead = s; if (this._lirTail === NIL) this._lirTail = s;
    }

    /** Unlink slot s from the LIR list. */
    _lirDetach(s) {
        const p = this._prev[s], n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._lirHead = n;
        if (n !== NIL) this._prev[n] = p; else this._lirTail = p;
    }

    /** Push slot s at the tail (newest) of Q. */
    _qPushTail(s) {
        this._next[s] = NIL; this._prev[s] = this._qTail;
        if (this._qTail !== NIL) this._next[this._qTail] = s;
        this._qTail = s; if (this._qHead === NIL) this._qHead = s;
    }

    /** Unlink slot s from Q. */
    _qDetach(s) {
        const p = this._prev[s], n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._qHead = n;
        if (n !== NIL) this._prev[n] = p; else this._qTail = p;
    }

    // --- the LIRS policy core (COLD helpers, allocation-free) ------------------

    /** Demote the bottom LIR of S to a resident HIR: move it out of S + off the LIR list,
     *  onto Q's tail, then prune. Called ONLY when a promotion pushed `_lirCount` past
     *  `_Llir` (D23). COLD / out-of-line. */
    _demoteBottomLir() {
        const b = this._sBot; // the invariant keeps this a LIR
        this._sDetach(b);
        this._st[b] &= ~LIRS_INS;
        this._st[b] &= ~LIRS_LIR;
        this._lirDetach(b);
        this._lirCount--;
        this._qPushTail(b);
        this._prune();
    }

    /** Reclassify a resident HIR slot (already moved to the top of S) to LIR: drop it from
     *  Q, add to the LIR list, and demote the bottom LIR if the LIR set overflowed. COLD. */
    _promoteToLir(s) {
        this._qDetach(s);
        this._st[s] |= LIRS_LIR; // inS already set by the caller
        this._lirPush(s);
        this._lirCount++;
        if (this._lirCount > this._Llir) this._demoteBottomLir();
    }

    /** Add a key to the bounded non-resident history, dropping the OLDEST at the bound
     *  (D23). COLD (only the eviction path reaches it). */
    _histAdd(key) {
        if (this._hist._len >= this._histCap) this._hist.delLRU();
        this._hist.addMRU(key);
    }

    /** Evict Q's front (the LRU resident HIR) to free a resident slot, returning that slot
     *  for in-place reuse (D6-style, no free-list round trip). If the victim was in S it
     *  becomes a non-resident HIR (its key enters the bounded history); otherwise it is
     *  simply forgotten. Sets `_evKey`/`_evVal` for the onEvict fire-after. COLD; only ever
     *  called at capacity, where Q is guaranteed non-empty (|Q| >= L_hir >= 1). */
    _replace() {
        const s = this._qHead;
        this._evKey = this._keys[s];
        this._evVal = this._vals[s];
        this._qDetach(s);
        const wasInS = (this._st[s] & LIRS_INS) !== 0;
        if (wasInS) this._sDetach(s);
        this._store.delete(this._evKey);
        if (wasInS) this._histAdd(this._evKey);
        this._st[s] = 0;
        this._size--;
        return s;
    }

    /** The per-access recency step for a RESIDENT slot (get hit / put update). Bit0/bit1 of
     *  `_st[s]` decide the branch; the LIR-hit-at-top case does 0 writes. */
    _access(s) {
        const st = this._st[s];
        if (st & LIRS_LIR) {
            // LIR hit.
            if (this._sTop === s) return;      // pinned 0-write fast path
            const wasBottom = (this._sBot === s);
            this._sMoveTop(s);                 // the 5-write "move to top of S"
            if (wasBottom) this._prune();      // bottom changed -> re-prune (cold)
        } else {
            // Resident HIR hit.
            const inSbefore = (st & LIRS_INS) !== 0;
            if (inSbefore) this._sMoveTop(s);
            else { this._sPushTop(s); this._st[s] |= LIRS_INS; }
            if (inSbefore && this._Llir > 0) {
                this._promoteToLir(s);         // in-S -> reclassify to LIR (cold)
            } else {
                this._qDetach(s); this._qPushTail(s); // stays HIR -> Q MRU end
            }
        }
    }

    // --- public API (all zero-alloc on the hot path) --------------------------

    /** Look up a key AND apply the LIRS access policy. @returns the value, or undefined if
     *  absent (see D7). A get never consults the non-resident history (a missing key is a
     *  plain miss; reclassification happens only on a put that re-admits the key). */
    get(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const s = this._store.get(key);
        if (s < 0) { if (this._stats !== null) this._stats.misses++; return undefined; } // miss (0019)
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (this._stats !== null) this._stats.misses++; // stale = miss (+ evict via _reap; D19.2)
            this._reap(s);
            return undefined;
        }
        this._access(s);
        if (this._stats !== null) this._stats.hits++; // live hit (0019)
        return this._vals[s];
    }

    /**
     * Insert or update. An update rewrites the value and applies the access policy (like a
     * hit). A new key that is a non-resident HIR STILL in the bounded history is re-admitted
     * as LIR (recency-of-recency); a brand-new key enters as LIR while the LIR set is filling
     * else as HIR. At capacity one resident HIR is evicted from Q's front first (its slot
     * reused in place); onEvict fires LAST (0002). The positional `ttlMs` (0017) overrides
     * the instance ttl default.
     */
    put(key, value, ttlMs) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        let expiresAt;
        if (this._exp !== null) expiresAt = expiryFor(this._clock, this._ttl, ttlMs);
        else if (ttlMs !== undefined) throw new Error(TTL_NO_COLUMN_MSG); // fail closed (D17.4)
        this._store._ver++; // D18.6 -- put mutates; invalidate iterators
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                  // update-in-place + access policy
            this._vals[existing] = value;
            if (this._exp !== null) this._exp[existing] = expiresAt; // restamp (D17)
            this._access(existing);
            if (this._stats !== null) this._stats.puts++; // successful update (outcome-based); 0019
            return;
        }

        const inHist = this._hist.has(key);
        let s;
        let evicted = false;
        if (this._size === this._capacity) {
            s = this._replace();              // evict Q front -> reuse its slot; sets _evKey/_evVal
            evicted = true;
        } else {
            s = store.allocSlot();
        }

        if (inHist) this._hist.consume(key);  // it is being re-admitted (resident again)
        this._keys[s] = key;
        this._vals[s] = value;
        if (this._exp !== null) this._exp[s] = expiresAt; // stamp the expiry (D17)
        store.set(key, s);

        if (inHist && this._Llir > 0) {
            // non-resident HIR still "in S" -> re-admit as LIR (the LIRS win).
            this._st[s] = LIRS_LIR | LIRS_INS;
            this._sPushTop(s);
            this._lirPush(s);
            this._lirCount++;
            this._size++;
            if (this._lirCount > this._Llir) this._demoteBottomLir();
        } else if (this._lirCount < this._Llir) {
            // still filling the LIR set -> admit as LIR (LIRS warm-up).
            this._st[s] = LIRS_LIR | LIRS_INS;
            this._sPushTop(s);
            this._lirPush(s);
            this._lirCount++;
            this._size++;
        } else {
            // a new resident HIR -> top of S + tail of Q.
            this._st[s] = LIRS_INS;
            this._sPushTop(s);
            this._qPushTail(s);
            this._size++;
        }

        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); 0019

        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (0019)
            const evKey = this._evKey, evVal = this._evVal;
            this._evKey = undefined; this._evVal = undefined; // retention hygiene
            this._inOnEvict = true;
            try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
        }
    }

    /** True if key is present (RESIDENT). History keys are NOT present. Policy-NEUTRAL. A
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

    /** Read a value WITHOUT applying the policy. undefined if absent (see D7). A stale entry
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

    /** Unlink a resident slot from whatever structures hold it (LIR list or Q, and S when
     *  inS), dropping its counts. Shared by delete + reap; NOT ghosted (like the rest of the
     *  family, a delete/reap keeps no non-resident metadata). */
    _unlinkResident(s) {
        if (this._st[s] & LIRS_INS) this._sDetach(s);
        if (this._st[s] & LIRS_LIR) { this._lirDetach(s); this._lirCount--; }
        else this._qDetach(s);
        this._st[s] = 0;
        this._size--;
    }

    /** Reap an expired slot in place (decisions/0017): unlink, drop from the index, free the
     *  slot, and fire onEvict LAST via the 0002 guard. Not ghosted, never re-splits. */
    _reap(s) {
        this._store._ver++; // D18.6 -- a reap is a structural mutation; invalidate iterators
        const evKey = this._keys[s];
        const evVal = this._vals[s];
        this._unlinkResident(s);
        this._store.delete(evKey);
        this._store.freeSlot(s);
        if (this._stats !== null) this._stats.evictions++; // reap = eviction (0019, D19.2)
        this._inOnEvict = true;
        try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
    }

    /** Evict every expired resident entry now (decisions/0017, D17.5). COLD, O(size). */
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

    /** Remove a key. Returns true if it was present. Frees the slot; NOT ghosted. */
    delete(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const store = this._store;
        const s = store.get(key);
        if (s < 0) return false;
        store._ver++; // D18.6 -- a real delete is a structural mutation; invalidate iterators
        this._unlinkResident(s);
        store.delete(key);
        store.freeSlot(s);
        return true;
    }

    /** Empty the cache. Rebuilds the free list, empties S/Q/LIR-list + the history, and
     *  resets the per-slot state. Allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._sTop = NIL; this._sBot = NIL;
        this._lirHead = NIL; this._lirTail = NIL; this._lirCount = 0;
        this._qHead = NIL; this._qTail = NIL;
        this._size = 0;
        this._st.fill(0);
        this._hist.clear();
    }

    // --- opt-in runtime stats (decisions/0019, D19): cold accessors -----------

    /** The live stats holder (decisions/0019, D19.3), returned BY REFERENCE (borrowed).
     *  Fail closed on an instance built without { stats: true }. */
    stats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        return this._stats;
    }

    /** Zero the four counters IN PLACE (decisions/0019). Fail closed on a non-stats instance. */
    resetStats() {
        if (this._stats === null) throw new Error(STATS_OFF_MSG);
        const st = this._stats;
        st.hits = 0; st.misses = 0; st.evictions = 0; st.puts = 0;
    }

    // --- iteration (decisions/0018, D18): zero-GC keys/values/entries ----------

    /** The per-member iteration ROSTER (decisions/0018 / 0023): the LIR list THEN Q, both
     *  threaded through the shared `_next` columns -- RESIDENT only (LIR + resident HIR),
     *  the non-resident history EXCLUDED. Recency-neutral, stale-skipping, fail-closed via
     *  `_ver` -- the shared CacheIterator walks it unchanged. */
    _iterHeads() { return [this._lirHead, this._qHead]; }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- snapshot / restore (decisions/0021, D21): COLD, may allocate --------

    /** Serialize to a plain snapshot (decisions/0021, D21 + D23): the LIR list + Q (each
     *  with values/expiry), the per-Q inS bit, the stack S order (slot indices top..bottom),
     *  AND the bounded non-resident history (keys only, oldest..newest). Dropping the stack
     *  order/bits or the history is a fail-OPEN future-eviction bug, so all are captured. */
    dump() {
        const snap = snapBase(this, "Lirs");
        snap.lir = snapList(this, this._lirHead, false);
        snap.q = snapList(this, this._qHead, false);
        const qins = [];
        for (let i = 0; i < snap.q.slots.length; i++) {
            qins.push((this._st[snap.q.slots[i]] & LIRS_INS) ? 1 : 0);
        }
        snap.qins = qins;
        const s = [];
        for (let x = this._sTop; x !== NIL; x = this._sNext[x]) s.push(x);
        snap.s = s;
        snap.hist = snapArcGhost(this._hist);
        return snap;
    }

    /** Reconstruct a FRESH Lirs from a snapshot (decisions/0021, D21 + D23). Fail closed on
     *  any tag/shape mismatch, a malformed inS/stack/history column, a stack slot that is not
     *  a resident LIR/inS-HIR, or a history that would exceed its bound. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "Lirs", opts);
        const inst = new Lirs(cap, snapOpts(snap, opts));
        const occ = snapCheckOccupy(cap, snap.ttl, [[snap.lir, "lir"], [snap.q, "q"]]);
        // Shape the LIRS-specific aux (fail closed -- "null is not zero").
        if (!Array.isArray(snap.qins) || snap.qins.length !== snap.q.slots.length) {
            throw new Error(SNAP_BAD + "lirs qins must be an array aligned to q");
        }
        for (let i = 0; i < snap.qins.length; i++) {
            const b = snap.qins[i];
            if (b !== 0 && b !== 1) throw new Error(SNAP_BAD + "lirs qins[" + i + "] = " + String(b) + " (must be 0 or 1)");
        }
        if (!Array.isArray(snap.s)) throw new Error(SNAP_BAD + "lirs stack (s) must be an array");
        if (!Array.isArray(snap.hist)) throw new Error(SNAP_BAD + "lirs history (hist) must be an array");
        if (snap.hist.length > cap) {
            throw new Error(SNAP_BAD + "lirs history (" + snap.hist.length + ") exceeds capacity (" + cap + ")");
        }

        const L = snapRestoreList(inst, snap.lir, null, 0);
        for (let i = 0; i < snap.lir.slots.length; i++) inst._st[snap.lir.slots[i]] = LIRS_LIR | LIRS_INS;
        inst._lirHead = L.head; inst._lirTail = L.tail; inst._lirCount = L.size;

        const Q = snapRestoreList(inst, snap.q, null, 0);
        for (let i = 0; i < snap.q.slots.length; i++) inst._st[snap.q.slots[i]] = snap.qins[i] ? LIRS_INS : 0;
        inst._qHead = Q.head; inst._qTail = Q.tail;

        inst._size = L.size + Q.size;

        // Rebuild the stack S from the captured slot order, verifying membership fail-closed.
        let expectS = 0;
        for (let i = 0; i < inst._st.length; i++) if (inst._st[i] & LIRS_INS) expectS++;
        if (snap.s.length !== expectS) {
            throw new Error(SNAP_BAD + "lirs stack length (" + snap.s.length + ") != in-S slots (" + expectS + ")");
        }
        // Track slots already used in THIS stack walk: a duplicate index in `snap.s` would
        // corrupt the linked list (mirrors snapOccupied's cross-list duplicate rejection,
        // which the hand-rolled stack rebuild does not go through). REJECT, never truncate.
        const seenS = new Uint8Array(cap);
        let prev = NIL;
        for (let i = 0; i < snap.s.length; i++) {
            const x = snap.s[i];
            if (!Number.isInteger(x) || x < 0 || x >= cap || occ[x] === 0) {
                throw new Error(SNAP_BAD + "lirs stack slot " + String(x) + " out of range or not resident");
            }
            if (seenS[x] !== 0) {
                throw new Error(SNAP_BAD + "duplicate slot " + x + " in the stack (s)");
            }
            seenS[x] = 1;
            if ((inst._st[x] & LIRS_INS) === 0) {
                throw new Error(SNAP_BAD + "lirs stack slot " + x + " is not marked in-S");
            }
            inst._sPrev[x] = prev;
            if (prev === NIL) inst._sTop = x; else inst._sNext[prev] = x;
            prev = x;
        }
        if (prev !== NIL) inst._sNext[prev] = NIL;
        inst._sBot = prev;

        const gInt = typeof inst._store._ck === "function";
        for (let i = 0; i < snap.hist.length; i++) {
            if (gInt) inst._store._ck(snap.hist[i]); // fail closed on a non-int history key
            inst._histAdd(snap.hist[i]);
        }

        inst._store.rebuildFreeList(occ);
        return inst;
    }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store (conservation invariant). */
    _freeListLength() {
        return this._store.freeListLength();
    }

    /** The key the NEXT over-capacity insert would evict (Q's front), WITHOUT mutating.
     *  TEST-ONLY (drives the torture differential); never a hot path. */
    _peekVictim() {
        return this._qHead === NIL ? undefined : this._keys[this._qHead];
    }
}

export default LiteLru;
