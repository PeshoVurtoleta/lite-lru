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

/** Fail-closed message for a bad dense-mode key (decisions/0029). Built once. Typeof
 *  is guarded FIRST at the call site (null is not zero); this message carries the value. */
const DENSE_KEY_MSG =
    "[lite-lru] keys:'dense' requires an integer key in [0, maxKey], got ";

/** Fail-closed message for a bad/absent `maxKey` on the dense backing (decisions/0029).
 *  Built once. The dense backing direct-maps k -> slot over a fixed [0, maxKey] domain,
 *  so `maxKey` is REQUIRED and must be a non-negative int32 (null is not zero). */
const MAX_KEY_MSG =
    "[lite-lru] keys:'dense' requires a maxKey integer in [0, " + INT_MAX + "], got ";

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

/** CAR (decisions/0028, D28) per-slot state bits, packed in a member-specific `_st` Uint8
 *  column (mirrors LIRS/ClockPro `_st`, NOT a field on the shared SlotStore -- the other
 *  members' hot paths stay byte-identical). bit0 = reference (the ONLY bit a get/put-update
 *  touches -- CAR's CLOCK reformulation of ARC: a hit sets a reference bit and moves NOTHING,
 *  the 0-link-write headline); bit1 = inT2 (the slot rides the FREQUENT clock T2, else the
 *  RECENT clock T1). The two clocks T1/T2 ride the shared `_next`/`_prev` columns; the inT2
 *  bit tells `_detach`/`_removeResident`/`_reap` which clock a slot is in. */
const CAR_REF = 1; // bit0: referenced since the last hand pass (the hot-path store)
const CAR_T2 = 2;  // bit1: 1 = in the frequent clock T2, 0 = in the recent clock T1

/** LIRS (decisions/0023, D23) per-slot state bits, packed in a member-specific `_st`
 *  Uint8 column (like W-TinyLFU's sketch -- NOT a field on the shared SlotStore, so the
 *  other members' hot paths stay byte-identical). bit0 = LIR (low IRR, hot/resident);
 *  bit1 = the slot is currently in the LIRS stack S. The whole LIRS hot test is a single
 *  `_st[s]` read (`& LIRS_LIR`, `& LIRS_INS`). */
const LIRS_LIR = 1; // bit0: 1 = LIR block, 0 = HIR block
const LIRS_INS = 2; // bit1: slot is currently a member of the stack S

/** Lfu (decisions/0024, D24) sentinel for "no bucket" -- a bucket id is a non-negative
 *  pool index, so -1 can never collide (the bucket-pool mirror of NIL for slots). Used for
 *  the empty bucket list (_bMin), the bucket free-stack end, and empty per-bucket key
 *  lists (_bHead/_bTail). */
const LFU_NIL = -1;

/** Fail-closed message for Lfu bucket-pool exhaustion (decisions/0024, D24). The pool is
 *  sized to `capacity`: at most `capacity` distinct frequencies can exist among <= capacity
 *  keys (every live bucket holds >= 1 key), so this is provably unreachable in a coherent
 *  cache. If it ever fires an invariant broke -- we fail CLOSED rather than `new` a bucket
 *  on a hot path. Built once, thrown only on misuse. */
const LFU_POOL_MSG =
    "[lite-lru] Lfu bucket pool exhausted (more than capacity distinct frequencies); " +
    "this is an invariant violation, not a capacity condition";

/** ClockPro (decisions/0025, D25) per-slot state bits, packed in a member-specific `_st`
 *  Uint8 column (mirrors LIRS's `_st`, NOT a field on the shared SlotStore -- the other
 *  members' hot paths stay byte-identical). bit0 = hot (1) / cold (0); bit1 = referenced
 *  (the ONLY bit a get/put-update touches -- the Sieve/S3Fifo 0-link-write headline);
 *  bit2 = test (a cold page in its test period). A page is hot XOR cold; a hot page is
 *  never in a test period, so `HOT | TEST` is an invalid combination (validate rejects it). */
const CLOCKPRO_HOT = 1;  // bit0: 1 = hot page, 0 = cold page
const CLOCKPRO_REF = 2;  // bit1: referenced since the last hand pass (the hot-path store)
const CLOCKPRO_TEST = 4; // bit2: a cold page currently in its test period

/** LRU-K (decisions/0026, D26) per-slot state bit, packed in a member-specific `_st` Uint8
 *  column (mirrors LIRS/ClockPro `_st`, NOT a field on the shared SlotStore -- the other
 *  members' hot paths stay byte-identical). bit0 = warm: the page has reached K=2 references
 *  (its K-th backward distance is finite). A cold page (0 = < K references) has `_r1` at the
 *  -Infinity sentinel and lives in the cold list; a warm page lives in the warm list. The
 *  whole per-access branch is a single `_st[s] & LRUK_WARM` test. */
const LRUK_WARM = 1; // bit0: 1 = warm (>= K=2 refs), 0 = cold (< K refs)

/** MQ (decisions/0027, D27) fixed queue count m = 8 (D27.1): Q0..Q7 frequency bands, one LRU
 *  list per band threaded through the shared `_next`/`_prev` columns (a slot is in exactly one).
 *  The band of a block with reference count `rc` is `min(floor(log2(rc)), 7)` = the highest set
 *  bit of `rc` clamped to 7. `MQ_MAXBAND` is the top band index (m - 1); `MQ_BAND_SAT` is the rc
 *  at/above which the band SATURATES to 7 (2^7 = 128): the fail-closed guard the RISK note names,
 *  so `Math.clz32` (which coerces `rc` mod 2^32 and would otherwise wrap a huge rc to a NEGATIVE
 *  or > 7 band) is never consulted for rc >= 128 -> `_qn`/`_qHead`/`_qTail` can never index out of
 *  range. `MQ_DEMOTE_STEPS` = the fixed aging sweep length (Q1..Q7, one demotion each, m - 1). */
const MQ_M = 8;
const MQ_MAXBAND = 7;
const MQ_BAND_SAT = 128;
const MQ_DEMOTE_STEPS = 7;

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

/** The option keys every constructor understands. An unknown key is a caller typo,
 *  and a typo is an error with a hint -- never a silent ignore (the fail-closed law). */
const KNOWN_OPTS = ["onEvict", "keys", "ttl", "clock", "stats", "maxKey"];

/**
 * Suggest the closest known option key to an unknown one (cold, throw-path only).
 * A case-insensitive exact match wins first; else the key sharing the most leading
 * characters; else we list every valid key. Clarity over cleverness -- this only ever
 * runs while building a fail-closed error message.
 */
function nearestOpt(key) {
    const lower = String(key).toLowerCase();
    for (const k of KNOWN_OPTS) {
        if (k.toLowerCase() === lower) return k;
    }
    let best = null, bestScore = 0;
    for (const k of KNOWN_OPTS) {
        const kl = k.toLowerCase();
        const max = Math.min(kl.length, lower.length);
        let n = 0;
        while (n < max && kl[n] === lower[n]) n++;
        if (n > bestScore) { bestScore = n; best = k; }
    }
    return bestScore > 0 ? best : KNOWN_OPTS.join(", ");
}

/**
 * Validate the options bag itself (the fail-closed law): reject a non-object, and
 * reject any unknown key with a did-you-mean hint rather than silently ignoring a
 * typo. Cold: called once per constructor, right after the capacity door.
 */
function validateOptions(options) {
    if (options === undefined) return;
    if (options === null || typeof options !== "object") {
        throw new TypeError(
            "[lite-lru] options must be an object, got " + String(options));
    }
    for (const k in options) {
        if (!KNOWN_OPTS.includes(k)) {
            throw new TypeError(
                "[lite-lru] unknown option " + k + " (did you mean " + nearestOpt(k) + "?)");
        }
    }
}

/**
 * Validate the optional `onEvict` callback (the fail-closed law). Mirrors validateClock:
 * `undefined` -> the shared NOOP; a function -> itself; anything else fails closed at the
 * door. Cold: called once per constructor.
 */
function validateOnEvict(onEvict) {
    if (onEvict === undefined) return NOOP;
    if (typeof onEvict !== "function") {
        throw new TypeError(
            "[lite-lru] onEvict must be a function, got " + String(onEvict));
    }
    return onEvict;
}

export const VERSION = "1.18.0";

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
        // Explicit backing tag (decisions/0029). snapBase reads this instead of
        // duck-typing on `checkStable` (which DirectSlotStore also has).
        this._kind = "map";
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

        // Explicit backing tag (decisions/0029). See MapSlotStore._kind.
        this._kind = "int";
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
 * Direct-mapped, generation-stamped keyed index (opt-in `keys: 'dense'`), STRICT
 * zero-alloc (decisions/0029). For a DENSE small-integer key domain [0, maxKey] the
 * index is a DIRECT map k -> slot: no hash, no probe, no collision handling -- the
 * hot body is a single `_gen[k] === _epoch ? _ixSlot[k] : NIL` array read.
 *
 * The no-init trick (borrowed from the sparse-set / SparseSet family): `_gen` is a
 * zero-initialized Int32Array and `_epoch` starts at 1, so a NEVER-WRITTEN key reads
 * `_gen[k] === 0 !== _epoch` = absent with NO O(U) pre-fill. clearIndex bumps the
 * epoch (genuinely O(1)), which makes EVERY previously-stamped key read absent at once;
 * the epoch domain is [1, INT_MAX] and 0 is the reserved DEAD sentinel (a deleted key).
 * On the disclosed-amortized epoch overflow the `_gen` array is filled back to 0 and
 * the epoch reset to 1 (a single O(U) event roughly every 2^31 clears).
 *
 * Space is O(maxKey), NOT O(entries): the two [0, maxKey] Int32Arrays are the honest
 * co-headline (decisions/0029). Use this when the key domain is small and dense; use
 * `keys: 'int'` when it is large/sparse.
 */
class DirectSlotStore extends SlotStore {
    constructor(capacity, hasTtl, maxKey) {
        super(capacity, hasTtl);
        this._maxKey = maxKey;
        // Direct map over the whole [0, maxKey] domain. `_ixSlot[k]` is the slot;
        // `_gen[k]` is the generation stamp that makes it live iff it equals _epoch.
        const span = maxKey + 1;
        this._ixSlot = new Int32Array(span); // k -> slot (only meaningful when live)
        this._gen = new Int32Array(span);    // k -> generation stamp; 0 = never/dead
        this._epoch = 1;                     // current generation; 0 is the dead sentinel
        this._count = 0;

        // The index never resizes: the domain is fixed at construction. Captured here;
        // checkStable() asserts the backing buffers never grow (mirrors IntSlotStore).
        this._ixSlotBytes = this._ixSlot.buffer.byteLength;
        this._genBytes = this._gen.buffer.byteLength;

        // Explicit backing tag (decisions/0029). See MapSlotStore._kind.
        this._kind = "dense";
    }

    _ck(key) {
        if (typeof key !== "number" || !Number.isInteger(key) || key < 0 || key > this._maxKey) {
            throw new TypeError(DENSE_KEY_MSG + String(key));
        }
    }

    get(key) {
        this._ck(key);
        return this._gen[key] === this._epoch ? this._ixSlot[key] : NIL;
    }

    set(key, slot) {
        this._ck(key);
        if (this._gen[key] === this._epoch) {
            this._ixSlot[key] = slot; // live update: same key, new slot
            return;
        }
        this._gen[key] = this._epoch; // new stamp
        this._ixSlot[key] = slot;
        this._count++;
    }

    has(key) { return this.get(key) !== NIL; }

    delete(key) {
        this._ck(key);
        if (this._gen[key] !== this._epoch) return; // absent
        this._gen[key] = 0; // invalidate: 0 is the dead sentinel, never a live epoch
        this._count--;
    }

    clearIndex() {
        // Bumping the epoch makes every previously-stamped key read absent at once -- a
        // genuine O(1) clear. Only on the disclosed-amortized wrap past INT_MAX do we pay
        // one O(U) fill to reclaim the epoch domain (roughly once per 2^31 clears).
        if (++this._epoch > INT_MAX) { this._gen.fill(0); this._epoch = 1; }
        this._count = 0;
    }

    indexSize() { return this._count; }

    indexEntries(cb) {
        // O(U) -- cold path (dump only), never a hot path.
        const slots = this._ixSlot, gen = this._gen, epoch = this._epoch;
        for (let k = 0; k <= this._maxKey; k++) if (gen[k] === epoch) cb(k, slots[k]);
    }

    /** validate() cross-check (decisions/0029): the index buffers are fixed at
     *  construction and must NEVER grow. Throws if either backing store resized. */
    checkStable() {
        if (this._ixSlot.buffer.byteLength !== this._ixSlotBytes ||
            this._gen.buffer.byteLength !== this._genBytes) {
            throw new Error(
                '[validate] dense index buffer grew (must be fixed at construction)');
        }
    }
}

/** Validate a dense-backing `maxKey` (decisions/0029). Fail closed at the door: a
 *  non-number / non-integer / out-of-[0, INT_MAX] value throws (null is not zero).
 *  Cold, called once per dense-store construction. */
function validateMaxKey(maxKey) {
    if (typeof maxKey !== "number" || !Number.isInteger(maxKey) || maxKey < 0 || maxKey > INT_MAX) {
        throw new TypeError(MAX_KEY_MSG + String(maxKey));
    }
    return maxKey;
}

/**
 * The shared store factory (decisions/0011 + 0029). Fail closed on an unknown `keys`
 * value. Both `LiteLru` and `Sieve` (decisions/0012) ride this ONE factory so the
 * keyed-index backing choice + int-key door stay identical across the family.
 */
function newStore(capacity, keys, hasTtl, maxKey) {
    if (keys === undefined) return new MapSlotStore(capacity, hasTtl);
    if (keys === 'int') return new IntSlotStore(capacity, hasTtl);
    if (keys === 'dense') return new DirectSlotStore(capacity, hasTtl, validateMaxKey(maxKey));
    throw new TypeError(
        "[lite-lru] unknown keys option " + String(keys) + " (did you mean 'int' or 'dense'?)");
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
    constructor(cache, mode, heads, nextCol) {
        this._store = cache._store;
        this._ver = cache._store._ver;   // D18.6 -- captured once, re-checked per step
        // The column each roster list is threaded through. Defaults to the shared `_next`
        // (every recency/segment member); a member whose active lists ride a DIFFERENT link
        // column (Lfu's per-bucket key lists on `_fNext`, decisions/0024) passes it here.
        this._nextCol = nextCol !== undefined ? nextCol : cache._next;
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

/** Base tag for a dump (decisions/0021 + 0029, D21.3). `keys` is the backing kind read
 *  from the store's explicit `_kind` tag -- 'int' (open-addressed typed-array index),
 *  'dense' (direct-mapped index; also emits `mk` = maxKey so restore rebuilds the right
 *  size), else null for the Map backing. Reading `_kind` (not duck-typing on `checkStable`,
 *  which BOTH the int AND dense stores have) is what keeps the two typed-array backings
 *  distinct. `ttl` records whether an `_exp` column exists; `t` stamps capture time. */
function snapBase(cache, member) {
    const store = cache._store;
    const kind = store._kind;
    const o = {
        f: SNAP_FORMAT,
        m: member,
        cap: cache._capacity,
        keys: kind === "map" ? null : kind,
        ttl: cache._exp !== null,
        t: cache._clock(),
    };
    if (kind === "dense") o.mk = store._maxKey; // maxKey: restore rebuilds the [0, mk] domain
    return o;
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
    if (snap.keys !== "int" && snap.keys !== "dense" && snap.keys !== null) {
        throw new Error(SNAP_BAD + "keys backing must be 'int', 'dense' or null, got " + String(snap.keys));
    }
    if (snap.keys === "dense") {
        // The dense backing direct-maps over [0, mk]; restore MUST know mk to size the
        // index (null is not zero -- a missing/bad mk fails closed, decisions/0029).
        if (!Number.isInteger(snap.mk) || snap.mk < 0 || snap.mk > INT_MAX) {
            throw new Error(SNAP_BAD + "dense snapshot mk (maxKey) must be an integer in [0, " + INT_MAX + "], got " + String(snap.mk));
        }
    } else if (snap.mk !== undefined) {
        throw new Error(SNAP_BAD + "non-dense snapshot carries an mk (maxKey) field it must not");
    }
    if (typeof snap.ttl !== "boolean") {
        throw new Error(SNAP_BAD + "ttl flag must be a boolean, got " + String(snap.ttl));
    }
    const o = opts || {};
    if (o.capacity !== undefined && o.capacity !== cap) {
        throw new Error(SNAP_BAD + "capacity opt (" + String(o.capacity) + ") conflicts with the snapshot (" + cap + ")");
    }
    // The backing kind the opts would build must match the snapshot's backing exactly.
    const wantKind = o.keys === undefined ? undefined : (o.keys === "int" || o.keys === "dense" ? o.keys : "map");
    const snapKind = snap.keys === null ? "map" : snap.keys;
    if (wantKind !== undefined && wantKind !== snapKind) {
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
    if (snap.keys === "dense") { c.keys = "dense"; c.maxKey = snap.mk; } // rebuild the [0, mk] domain
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017). Validated fail-closed at the door. `_ttl === undefined`
        // means no ttl (the `_exp` column is never allocated -- pay-for-what-you-use).
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // The keyed-index backing is chosen ONCE here (decisions/0011); each hot
        // path stays monomorphic. The store owns the columns + free stack (and the
        // opt-in `_exp` ttl column).
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

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
        this._onEvict = validateOnEvict(options && options.onEvict);

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
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
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
 * DirectLru -- LiteLru pinned to the DIRECT-MAPPED dense backing (decisions/0029).
 * A THIN convenience subclass: it fixes `keys: 'dense'` and forwards `maxKey` to the
 * SAME LiteLru constructor, so there is ZERO policy duplication -- every hot path
 * (get/put/delete/has/peek/clear), the DLL, and dump/restore are inherited verbatim.
 * `new DirectLru(cap, { maxKey })` is byte-for-byte equivalent to
 * `new LiteLru(cap, { keys: 'dense', maxKey })`.
 * -------------------------------------------------------------------------- */

/** Merge the caller's options with the fixed `keys: 'dense'` (decisions/0029). COLD
 *  (one object built at construction, never on a hot path). Fail closed on a
 *  contradictory `keys` value (null is not zero); everything else forwards unchanged
 *  and LiteLru's own `validateOptions` vets the rest. An explicit build (not a spread)
 *  keeps the options object a stable, monomorphic shape. */
function denseOptions(options) {
    if (options !== undefined && (options === null || typeof options !== "object")) {
        throw new TypeError("[lite-lru] options must be an object, got " + String(options));
    }
    const o = options || {};
    if (o.keys !== undefined && o.keys !== "dense") {
        throw new TypeError(
            "[lite-lru] DirectLru fixes keys:'dense'; got a conflicting keys option " + String(o.keys));
    }
    return {
        keys: "dense",
        maxKey: o.maxKey,
        onEvict: o.onEvict,
        ttl: o.ttl,
        clock: o.clock,
        stats: o.stats,
    };
}

export class DirectLru extends LiteLru {
    /**
     * @param {number} capacity  Max entries. Must be an integer >= 1.
     * @param {{ maxKey: number, onEvict?, ttl?, clock?, stats? }} options  `maxKey` is
     *        REQUIRED (the dense key domain [0, maxKey]); the rest match LiteCacheOptions.
     */
    constructor(capacity, options) {
        super(capacity, denseOptions(options));
    }

    /** Reconstruct from a dense `dump()` snapshot (decisions/0021 + 0029). Delegates to
     *  LiteLru.restore: the snapshot already carries keys:'dense' + mk, so the rebuilt
     *  instance is a LiteLru with the dense backing (a DirectLru is exactly that). */
    static restore(snap, opts) {
        return LiteLru.restore(snap, opts);
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed at the door -- identical to LiteLru.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as LiteLru (decisions/0011, 0012).
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

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

        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed at the door -- identical to LiteLru.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as the rest of the family.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

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

        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed at the door -- identical to LiteLru.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as the rest of the family.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

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

        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed at the door -- identical to LiteLru.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as the rest of the family.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

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

        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed at the door -- identical to LiteLru.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as the rest of the family.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

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

        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed at the door -- identical to LiteLru.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as the rest of the family.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

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

        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed -- identical to the rest of the family.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as every other member.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

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

        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Retention hygiene for the onEvict fire-after: declared at construction so the object shape never transitions on first eviction.
        this._evKey = undefined;
        this._evVal = undefined;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
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

/* -------------------------------------------------------------------------- *
 * Lfu -- an O(1) EXACT Least-Frequently-Used cache (Shah-Matani), decisions/0024,
 * D24. The NINTH named export in this file (same single-file ruling as the rest).
 *
 * Structure: a doubly-linked list OF frequency BUCKETS in ASCENDING frequency order
 * (`_bMin` = head = the LOWEST frequency = the eviction end). Each bucket owns a recency
 * list of resident key-slots threaded through the member columns `_fNext` (toward LRU) /
 * `_fPrev` (toward MRU), with `_bHead` = MRU and `_bTail` = LRU. The frequency lives ON
 * the bucket (`_bFreq`, a Float64Array -- EXACT to 2^53, no 2^31 wrap, same rationale as
 * stats D19.4): every key in a bucket shares it. `_kB[s]` records which bucket owns slot s.
 *
 * WITHIN-BUCKET TIE-BREAK = LRU (D24): a newcomer (freq 1) and a just-promoted key attach
 * at the MRU (head) end; eviction removes the LRU-end key (`_bTail`) of the lowest-frequency
 * bucket (`_bMin`). This is LFU-with-LRU-tiebreak.
 *
 * The bucket POOL is a fixed set of `capacity` nodes (at most `capacity` distinct
 * frequencies can exist among <= capacity keys -- provably enough); bucket nodes come from
 * the `_bFree` stack, NEVER `new` per bucket. Exhaustion fails CLOSED (LFU_POOL_MSG).
 *
 * A HIT (get, or a put-UPDATE -- D24) increments the slot's frequency by one and relinks it
 * to the MRU end of the freq+1 bucket. This is ZERO-ALLOCATION but NOT zero-write (honestly
 * stated, DEBATE): a hit does a bucket relink, pinned at <= 14 index stores in the T6 gate.
 * A single-key bucket that has no freq+1 neighbour is RELABELLED in place (1 write, the fast
 * path). has()/peek() are frequency-NEUTRAL (inspections, not accesses), matching every
 * member. Iteration is frequency-neutral (D18.4). This EXACT frequency counting is what
 * distinguishes Lfu from the approximate-sketch WTinyLfu (decisions/0014).
 *
 * Rides the shared substrate (decisions/0011), TTL (0017), the zero-GC iterator (0018),
 * opt-in stats (0019), snapshot/restore (0021), the onEvict reentrancy guard (0002) and the
 * conservation invariant -- exactly like the other eight members.
 * -------------------------------------------------------------------------- */

export class Lfu {
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed at the door -- identical to LiteLru.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as the rest of the family.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

        // Cache the store's columns. Lfu's ACTIVE key lists ride the member columns
        // `_fNext`/`_fPrev` (below), NOT the shared `_next`/`_prev`; the store's `_next`
        // still threads the FREE stack (allocSlot/freeSlot), so a resident slot leaves
        // `_next`/`_prev` untouched -- kept here only for substrate parity + conservation.
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next;
        this._prev = this._store._prev;
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // D24 -- key-slot columns. Each resident key is in exactly ONE bucket's recency list,
        // threaded `_fNext` (toward LRU) / `_fPrev` (toward MRU). `_kB[s]` = the owning bucket
        // id. Fixed size, allocated once, never grown.
        this._fNext = new Int32Array(capacity);
        this._fPrev = new Int32Array(capacity);
        this._kB = new Int32Array(capacity);

        // D24 -- the bucket pool: a doubly-linked list of frequency buckets in ASCENDING
        // frequency order. `_bFreq` (Float64Array, EXACT to 2^53) is the frequency shared by
        // every key in a bucket; `_bNext`/`_bPrev` link the bucket list; `_bHead`/`_bTail`
        // are the MRU/LRU ends of the bucket's key list. All sized to capacity, never grown.
        this._bFreq = new Float64Array(capacity);
        this._bNext = new Int32Array(capacity);
        this._bPrev = new Int32Array(capacity);
        this._bHead = new Int32Array(capacity);
        this._bTail = new Int32Array(capacity);
        // The bucket free stack: 0 -> 1 -> ... -> capacity-1 -> LFU_NIL, chained via `_bNext`.
        for (let i = 0; i < capacity; i++) this._bNext[i] = i + 1;
        this._bNext[capacity - 1] = LFU_NIL;
        this._bFreeHead = 0;
        this._bMin = LFU_NIL; // head of the bucket list (lowest frequency); LFU_NIL when empty

        this._size = 0;
        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- bucket-pool helpers (create/destroy on frequency transitions) --------

    /** Pop a bucket off the free stack, stamped with `freq` and an empty key list. Fail
     *  CLOSED (D24) if the pool is exhausted -- provably unreachable in a coherent cache. */
    _bAlloc(freq) {
        const b = this._bFreeHead;
        if (b === LFU_NIL) throw new Error(LFU_POOL_MSG); // fail closed (D24)
        this._bFreeHead = this._bNext[b];
        this._bFreq[b] = freq;
        this._bHead[b] = LFU_NIL;
        this._bTail[b] = LFU_NIL;
        return b;
    }

    /** Return a bucket (now empty) to the free stack. */
    _bRelease(b) {
        this._bNext[b] = this._bFreeHead;
        this._bFreeHead = b;
    }

    /** Insert bucket `nb` immediately AFTER bucket `b` in the ascending bucket list. */
    _bInsertAfter(b, nb) {
        const n = this._bNext[b];
        this._bPrev[nb] = b;
        this._bNext[nb] = n;
        this._bNext[b] = nb;
        if (n !== LFU_NIL) this._bPrev[n] = nb;
    }

    /** Insert bucket `nb` at the HEAD (new minimum frequency) of the bucket list. */
    _bInsertHead(nb) {
        this._bPrev[nb] = LFU_NIL;
        this._bNext[nb] = this._bMin;
        if (this._bMin !== LFU_NIL) this._bPrev[this._bMin] = nb;
        this._bMin = nb;
    }

    /** Unlink bucket `b` (being destroyed -- it just became empty), fixing `_bMin`. */
    _bUnlink(b) {
        const p = this._bPrev[b], n = this._bNext[b];
        if (p !== LFU_NIL) this._bNext[p] = n; else this._bMin = n;
        if (n !== LFU_NIL) this._bPrev[n] = p;
    }

    // --- within-bucket recency-list helpers -----------------------------------

    /** Push key-slot s at the MRU (head) end of bucket b's recency list. */
    _kPushHead(b, s) {
        this._kB[s] = b;
        this._fPrev[s] = LFU_NIL;
        const h = this._bHead[b];
        this._fNext[s] = h;
        if (h !== LFU_NIL) this._fPrev[h] = s; else this._bTail[b] = s;
        this._bHead[b] = s;
    }

    /** Unlink key-slot s from bucket b's recency list, fixing b's head/tail. */
    _kUnlink(b, s) {
        const p = this._fPrev[s], n = this._fNext[s];
        if (p !== LFU_NIL) this._fNext[p] = n; else this._bHead[b] = n;
        if (n !== LFU_NIL) this._fPrev[n] = p; else this._bTail[b] = p;
    }

    /** A HIT (get or put-UPDATE, D24): increment slot s's frequency by one and relink it to
     *  the MRU end of the freq+1 bucket. Zero-ALLOCATION, NOT zero-write (a bucket relink;
     *  DEBATE-honest). Fast path: if s is the ONLY key in b and no bucket sits at freq+1,
     *  RELABEL b in place (1 write) -- s stays put at MRU, the bucket list stays ascending. */
    _touch(s) {
        const b = this._kB[s];
        const target = this._bFreq[b] + 1;
        const nb = this._bNext[b];
        // Fast path: b holds only s and there is no freq+1 bucket above it -> relabel b.
        // Ascending order holds: b's prev freq < target, and nb (if any) has freq != target
        // and > b's old freq, hence >= target+1 > target.
        if (this._bHead[b] === s && this._fNext[s] === LFU_NIL &&
            (nb === LFU_NIL || this._bFreq[nb] !== target)) {
            this._bFreq[b] = target;
            return;
        }
        // General path: move s up to the (found or freshly-created) freq+1 bucket.
        let dest;
        if (nb !== LFU_NIL && this._bFreq[nb] === target) {
            dest = nb;
        } else {
            dest = this._bAlloc(target);
            this._bInsertAfter(b, dest);
        }
        this._kUnlink(b, s);
        if (this._bHead[b] === LFU_NIL) { this._bUnlink(b); this._bRelease(b); } // b emptied -> destroy
        this._kPushHead(dest, s);
    }

    /** Insert a NEWCOMER (frequency 1) at the MRU end of the freq-1 bucket, creating that
     *  bucket at the head of the list when it does not yet exist. */
    _insertFreq1(s) {
        let b = this._bMin;
        if (b === LFU_NIL || this._bFreq[b] !== 1) {
            b = this._bAlloc(1);
            this._bInsertHead(b);
        }
        this._kPushHead(b, s);
    }

    /** Free exactly ONE slot and return it for reuse. Evicts the LRU-end key (`_bTail`) of
     *  the lowest-frequency bucket (`_bMin`) -- LFU with LRU tie-break (D24). Only ever called
     *  at capacity, where `_bMin` is non-empty. Decrements `_size` (the caller re-inserts). */
    _evict() {
        const b = this._bMin;
        const s = this._bTail[b];
        const k = this._keys[s];
        this._kUnlink(b, s);
        if (this._bHead[b] === LFU_NIL) { this._bUnlink(b); this._bRelease(b); }
        this._store.delete(k);
        this._size--;
        return s;
    }

    // --- public API (all O(1); the hot path is zero-alloc, NOT zero-write) -----

    /** Look up a key AND count a frequency hit. @returns the value, or undefined if absent
     *  (see D7). A stale entry is a MISS and is reaped in place (decisions/0017, D17.3). */
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
     * Insert or update. An update rewrites the value and COUNTS as a frequency hit (D24). A
     * new key enters the freq-1 bucket at MRU; at capacity the LRU-end key of the lowest-
     * frequency bucket is evicted and its slot reused in place. onEvict fires LAST (0002).
     * The positional `ttlMs` (0017, D17.4) overrides the instance ttl default.
     */
    put(key, value, ttlMs) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        let expiresAt;
        if (this._exp !== null) expiresAt = expiryFor(this._clock, this._ttl, ttlMs);
        else if (ttlMs !== undefined) throw new Error(TTL_NO_COLUMN_MSG); // fail closed (D17.4)
        this._store._ver++; // D18.6 -- put mutates (update/insert/evict); invalidate iterators
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                 // update-in-place + count a hit
            this._vals[existing] = value;
            if (this._exp !== null) this._exp[existing] = expiresAt; // restamp (D17)
            this._touch(existing);
            if (this._stats !== null) this._stats.puts++; // successful update (outcome-based); 0019
            return;
        }

        let s, evKey, evVal;
        let evicted = false;
        if (this._size === this._capacity) {
            s = this._evict();          // frees exactly one slot (reused in place, D6); _size--
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
        this._insertFreq1(s);           // a newcomer enters the freq-1 bucket at MRU
        this._size++;
        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); 0019

        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (0019)
            this._inOnEvict = true;
            try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
        }
    }

    /** True if key is present (RESIDENT). Frequency-NEUTRAL. A stale entry is a MISS and is
     *  reaped in place (decisions/0017, D17.3). */
    has(key) {
        const s = this._store.get(key);
        if (s < 0) return false;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return false;
        }
        return true;
    }

    /** Read a value WITHOUT counting a frequency hit. undefined if absent (see D7). A stale
     *  entry is a MISS and is reaped in place (decisions/0017, D17.3). */
    peek(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return undefined;
        }
        return this._vals[s];
    }

    /** Reap an expired slot in place (decisions/0017): unlink from its bucket (destroy the
     *  bucket if it empties), drop from the index, free the slot, fire onEvict LAST (0002). */
    _reap(s) {
        this._store._ver++; // D18.6 -- a reap is a structural mutation; invalidate iterators
        const evKey = this._keys[s];
        const evVal = this._vals[s];
        const b = this._kB[s];
        this._kUnlink(b, s);
        if (this._bHead[b] === LFU_NIL) { this._bUnlink(b); this._bRelease(b); }
        this._store.delete(evKey);
        this._store.freeSlot(s);
        this._size--;
        if (this._stats !== null) this._stats.evictions++; // reap = eviction (0019, D19.2)
        this._inOnEvict = true;
        try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
    }

    /** Evict every expired resident entry now (decisions/0017, D17.5). COLD, O(size); fires
     *  onEvict per victim (0002) and returns the count evicted. */
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

    /** Remove a key. Returns true if it was present. Frees the slot, repairs its bucket
     *  (destroying it if it empties). A delete is NOT an eviction. */
    delete(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const store = this._store;
        const s = store.get(key);
        if (s < 0) return false;
        store._ver++; // D18.6 -- a real delete is a structural mutation; invalidate iterators
        const b = this._kB[s];
        this._kUnlink(b, s);
        if (this._bHead[b] === LFU_NIL) { this._bUnlink(b); this._bRelease(b); }
        store.delete(key);
        store.freeSlot(s);
        this._size--;
        return true;
    }

    /** Empty the cache. Rebuilds the slot free list + the bucket free stack. Allocates
     *  nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        const cap = this._capacity;
        for (let i = 0; i < cap; i++) this._bNext[i] = i + 1;
        this._bNext[cap - 1] = LFU_NIL;
        this._bFreeHead = 0;
        this._bMin = LFU_NIL;
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

    /** The per-member iteration ROSTER (decisions/0018, D18.1 / 0024 D24): the bucket heads
     *  in ASCENDING frequency (`_bMin` up), each walked MRU->LRU. NOT recency order. Cold. */
    _iterHeads() {
        const heads = [];
        for (let b = this._bMin; b !== LFU_NIL; b = this._bNext[b]) heads.push(this._bHead[b]);
        return heads;
    }

    /** Keys in iteration order (ascending frequency, MRU->LRU per bucket). Frequency-neutral
     *  (D18.4); skips stale entries (D18.5). The shared iterator walks the `_fNext` column. */
    keys() { return new CacheIterator(this, ITER_KEYS, this._iterHeads(), this._fNext); }
    values() { return new CacheIterator(this, ITER_VALUES, this._iterHeads(), this._fNext); }
    entries() { return new CacheIterator(this, ITER_ENTRIES, this._iterHeads(), this._fNext); }
    [Symbol.iterator]() { return this.entries(); }

    // --- snapshot / restore (decisions/0021, D21): COLD, may allocate --------

    /** Capture one bucket's recency list (MRU..LRU over `_fNext`) as aligned plain arrays:
     *  ordered `slots`, keys `k`, values `v`, plus `e` (expiry) when ttl is on. Cold. */
    _snapBucketList(head) {
        const fNext = this._fNext, keys = this._keys, vals = this._vals, exp = this._exp;
        const slots = [], k = [], v = [];
        const e = exp !== null ? [] : null;
        for (let s = head; s !== LFU_NIL; s = fNext[s]) {
            slots.push(s); k.push(keys[s]); v.push(vals[s]);
            if (e !== null) e.push(exp[s]);
        }
        const o = { slots, k, v };
        if (e !== null) o.e = e;
        return o;
    }

    /** Serialize to a plain snapshot (decisions/0021): the frequency BUCKETS ascending, each
     *  carrying its EXACT `freq` + its recency list (MRU..LRU) + values (+ expiry). Capturing
     *  the frequencies VERBATIM is what makes a restored cache evict IDENTICALLY (D21.1);
     *  dropping them would be a fail-OPEN bug. COLD; may allocate. */
    dump() {
        const snap = snapBase(this, "Lfu");
        const buckets = [];
        for (let b = this._bMin; b !== LFU_NIL; b = this._bNext[b]) {
            buckets.push({ freq: this._bFreq[b], list: this._snapBucketList(this._bHead[b]) });
        }
        snap.buckets = buckets;
        return snap;
    }

    /** Reconstruct a FRESH Lfu from a snapshot (decisions/0021). Fail closed on any mismatch:
     *  a non-array `buckets`, a bad/absent/non-ascending frequency, an empty bucket, a
     *  duplicate/out-of-range slot, or resident entries > capacity (REJECT, never truncate). */
    static restore(snap, opts) {
        const cap = snapRead(snap, "Lfu", opts);
        const inst = new Lfu(cap, snapOpts(snap, opts));
        if (!Array.isArray(snap.buckets)) {
            throw new Error(SNAP_BAD + "lfu buckets must be an array");
        }
        // Validate each bucket's frequency (positive integer, strictly ascending) + list shape.
        const pairs = [];
        let prevFreq = 0;
        for (let i = 0; i < snap.buckets.length; i++) {
            const bk = snap.buckets[i];
            if (bk === null || typeof bk !== "object") {
                throw new Error(SNAP_BAD + "lfu bucket " + i + " must be an object");
            }
            const f = bk.freq;
            if (typeof f !== "number" || !Number.isFinite(f) || f <= 0 || Math.floor(f) !== f) {
                throw new Error(SNAP_BAD + "lfu bucket " + i + " freq must be a positive integer, got " + String(f));
            }
            if (!(f > prevFreq)) {
                throw new Error(SNAP_BAD + "lfu bucket frequencies must be strictly ascending (bucket " +
                    i + " freq " + f + " <= previous " + prevFreq + ")");
            }
            prevFreq = f;
            if (bk.list === null || typeof bk.list !== "object" || !Array.isArray(bk.list.slots)) {
                throw new Error(SNAP_BAD + "lfu bucket " + i + " has a malformed list");
            }
            if (bk.list.slots.length === 0) {
                throw new Error(SNAP_BAD + "lfu bucket " + i + " is empty (a bucket must hold >= 1 key)");
            }
            pairs.push([bk.list, "bucket" + i, false]);
        }
        const occ = snapCheckOccupy(cap, snap.ttl, pairs);
        // Reconstruct buckets + their key lists in ascending order, threading `_fNext`/`_fPrev`.
        let size = 0;
        let prevB = LFU_NIL;
        for (let i = 0; i < snap.buckets.length; i++) {
            const bk = snap.buckets[i];
            const b = inst._bAlloc(bk.freq);
            inst._bPrev[b] = prevB;
            inst._bNext[b] = LFU_NIL;
            if (prevB === LFU_NIL) inst._bMin = b; else inst._bNext[prevB] = b;
            void snapWriteList(inst, bk.list); // payload + keyed index into the preserved slots
            const slots = bk.list.slots;
            let head = LFU_NIL, tail = LFU_NIL;
            for (let j = 0; j < slots.length; j++) {
                const s = slots[j];
                inst._kB[s] = b;
                inst._fPrev[s] = j === 0 ? LFU_NIL : slots[j - 1];
                inst._fNext[s] = j === slots.length - 1 ? LFU_NIL : slots[j + 1];
                if (j === 0) head = s;
                tail = s;
            }
            inst._bHead[b] = head;
            inst._bTail[b] = tail;
            size += slots.length;
            prevB = b;
        }
        inst._size = size;
        inst._store.rebuildFreeList(occ);
        return inst;
    }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store (conservation invariant). */
    _freeListLength() {
        return this._store.freeListLength();
    }

    /** The key the NEXT over-capacity insert would evict (the LRU-end key of the lowest-
     *  frequency bucket), WITHOUT mutating. TEST-ONLY (drives the torture differential). */
    _peekVictim() {
        if (this._bMin === LFU_NIL) return undefined;
        return this._keys[this._bTail[this._bMin]];
    }
}

/* -------------------------------------------------------------------------- *
 * ClockProHistory -- the bounded, keys-only non-resident test-page history for
 * ClockPro (decisions/0025, D25.2). A GENERALIZATION of ArcGhost (exactly like
 * LirsHistory, decisions/0023): the same open-addressed int ring (strict zero-alloc on
 * keys:'int') / Set + FIFO array (amortized on the Map backing), bounded at construction
 * to `capacity`, drop-oldest. It stands in for the non-resident cold pages of the
 * textbook interleaved ClockPro clock: a non-resident cold page is "still remembered"
 * (its test period has not been forgotten) iff its key is still in this bounded ring. It
 * is NOT interleaved into the circular clock (the D25.2 honest, bounded deviation from
 * the textbook interleaving). INTERNAL, never exported.
 * -------------------------------------------------------------------------- */

class ClockProHistory extends ArcGhost {}

/* -------------------------------------------------------------------------- *
 * ClockPro -- CLOCK-Pro (Jiang, Chen & Zhang, USENIX ATC'05), decisions/0025, D25.
 * The TENTH named export in this file (same single-file ruling as the rest of the
 * family: single main file + sideEffects:false + named exports = the tree-shake moat).
 *
 * ClockPro is the CLOCK approximation of LIRS: it approximates recency-of-recency (the
 * inter-reference recency LIRS orders exactly) with ONE circular list + reference bits +
 * three moving hands, so it needs no O(1) stack surgery on a hit -- a hit sets a single
 * reference bit and moves NOTHING (the Sieve/S3Fifo 0-link-write headline, D25.5).
 *
 * STRUCTURE (all fixed at construction, zero-alloc on the hot path):
 *   - ONE circular list of RESIDENT pages threaded through the shared `_next`/`_prev`
 *     columns (D25.1). REALIZATION NOTE (documented deviation, decisions/0025): the clock
 *     is realized as a NIL-terminated doubly-linked list (`_head` = newest .. `_tail` =
 *     oldest) whose hands WRAP (`_advance(_tail) -> _head`) -- the TRAVERSAL is circular
 *     (a clock has no ends), while the NIL terminus lets the member reuse the family's
 *     shared iteration (CacheIterator), conservation (validate's default recency
 *     descriptor) and snapshot (snapList/snapLink) machinery BYTE-FOR-BYTE. validate()
 *     asserts the logical closure (every hand resident, hot+cold == size).
 *   - `_st` Uint8: bit0 hot, bit1 referenced, bit2 test (D25.1). A hit is a single
 *     `_st[s] |= REF` -- 0 link writes, exactly 1 state store (D25.5, pinned in t6).
 *   - THREE hands as Int32 slot pointers (D25.1): `_handCold` (the eviction hand -- finds
 *     an unreferenced resident cold page), `_handHot` (demotes a hot page to cold when the
 *     hot set exceeds its adaptive target), `_handTest` (ends the test period of a resident
 *     cold page, lowering the adaptive hot target when a test page expires unreferenced).
 *   - `_mHot` (0..capacity): the ADAPTIVE integer hot-page target (D25.3). A re-admit of a
 *     key still in the bounded history RAISES it (the page proved worthy); `_handTest`
 *     ending a test period unreferenced LOWERS it. O(1) updates.
 *   - `_hist` (ClockProHistory): the bounded non-resident test-page history (D25.2), keys
 *     only, cap = capacity, drop-oldest -- NOT interleaved into the clock.
 *
 * Fixed-capacity honesty (D25.4, restating Arc D16.2 / Lirs D23): the RESIDENT value
 * capacity is EXACTLY `capacity`; only the hot/cold split moves, |hot| + |cold| == size.
 *
 * Rides the shared newStore factory (default Map / opt-in keys:'int' strict-zero), the
 * onEvict fire-after + `_inOnEvict` guard (0002), TTL (0017), zero-GC iteration (0018),
 * stats (0019), snapshot (0021). A hit is proven zero-alloc + 0-link-write by the t6 gate.
 * -------------------------------------------------------------------------- */

export class ClockPro {
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed -- identical to the rest of the family.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as every other member.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

        // Cache the store's columns so the ring relinks stay direct. `_next` toward the
        // tail (older), `_prev` toward the head (newer); the hands WRAP `_next[tail] -> head`.
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next;
        this._prev = this._store._prev;
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // Per-slot state (bit0 hot, bit1 referenced, bit2 test). Member-specific, fixed,
        // never grown -- the other members' hot paths carry no new column (like LIRS `_st`).
        this._st = new Uint8Array(capacity);

        this._head = NIL; // the newest resident page (the insertion end)
        this._tail = NIL; // the oldest resident page

        // The three hands (D25.1), Int32 slot pointers; NIL only when the clock is empty.
        this._handCold = NIL; // eviction hand
        this._handHot = NIL;  // hot-demotion hand
        this._handTest = NIL; // test-period-expiry hand

        this._nHot = 0;  // resident hot pages
        this._nCold = 0; // resident cold pages (|hot| + |cold| == size, D25.4)
        this._size = 0;

        // The adaptive integer hot-page target (D25.3), 0..capacity. Starts cold-favouring at 0.
        this._mHot = 0;

        // The bounded non-resident test-page history (D25.2): keys only, cap = capacity, drop-oldest.
        this._histCap = capacity;
        this._histInt = (options && options.keys) === 'int';
        this._hist = new ClockProHistory(capacity, this._histInt);

        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Retention hygiene for the onEvict fire-after: declared at construction so the object shape never transitions on first eviction.
        this._evKey = undefined;
        this._evVal = undefined;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- the circular ring (NIL-terminated DLL + wrap-around hand advance) -----

    /** Advance one step around the clock: toward the tail, wrapping tail -> head (D25.1). */
    _advance(s) {
        const n = this._next[s];
        return n !== NIL ? n : this._head;
    }

    /** The ring successor of `s` used when `s` is being removed: its `_next`, else the head
     *  (wrap), else NIL when `s` is the sole resident. Computed BEFORE the detach. */
    _ringSucc(s) {
        const n = this._next[s];
        if (n !== NIL) return n;
        return this._head === s ? NIL : this._head;
    }

    /** Insert slot s at the head (newest end) of the ring. Sets all three hands when the
     *  ring was empty (the sole page is where every hand parks). */
    _pushFront(s) {
        this._prev[s] = NIL;
        this._next[s] = this._head;
        if (this._head !== NIL) this._prev[this._head] = s;
        this._head = s;
        if (this._tail === NIL) {
            this._tail = s;
            this._handCold = s;
            this._handHot = s;
            this._handTest = s;
        }
    }

    /** Unlink slot s from the ring, fixing neighbours + head/tail sentinels. */
    _detach(s) {
        const p = this._prev[s], n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._head = n;
        if (n !== NIL) this._prev[n] = p; else this._tail = p;
    }

    /** Remove a resident slot: repair any hand parked on it (advance to its successor),
     *  unlink it, and drop the matching hot/cold count. Does NOT touch the index / free
     *  stack / `_st` / `_size` (the caller finishes those). */
    _removeSlot(s) {
        const succ = this._ringSucc(s);
        if (this._handCold === s) this._handCold = succ;
        if (this._handHot === s) this._handHot = succ;
        if (this._handTest === s) this._handTest = succ;
        this._detach(s);
        if (this._st[s] & CLOCKPRO_HOT) this._nHot--; else this._nCold--;
    }

    // --- the ClockPro hands (COLD helpers, allocation-free) --------------------

    /** Add a key to the bounded non-resident history, dropping the OLDEST at the bound
     *  (D25.2). COLD (only the eviction path reaches it). */
    _histAdd(key) {
        if (this._hist._len >= this._histCap) this._hist.delLRU();
        this._hist.addMRU(key);
    }

    /** ONE step of HAND_test: end the test period of the resident cold page it points at (so a
     *  long-resident page whose test period lapsed is NOT remembered when later evicted) and
     *  LOWER the adaptive hot target (D25.3 -- a test page expired without earning hot status),
     *  then advance. Stepped ONLY on reference activity (a HAND_cold promotion / second chance),
     *  never on a plain eviction -- so it neither runs in lockstep with HAND_cold (which would
     *  starve the non-resident history) nor lowers `_mHot` on every eviction (which would pin it
     *  to 0 and make the adaptation vacuous). Amortized O(1). */
    _handTestStep() {
        const t = this._handTest;
        if (t === NIL) return;
        const st = this._st[t];
        if ((st & CLOCKPRO_HOT) === 0 && (st & CLOCKPRO_TEST) !== 0) {
            this._st[t] &= ~CLOCKPRO_TEST;         // the resident test period is over
            if (this._mHot > 0) this._mHot--;      // ... LOWER the adaptive hot target (D25.3)
        }
        this._handTest = this._advance(this._handTest);
    }

    /** HAND_hot: demote exactly ONE hot page to cold. A hot page whose reference bit is set
     *  gets a second chance (bit cleared, advance); the first unreferenced hot page is
     *  demoted to a cold page in a fresh test period. Only called when a hot page exists.
     *  COLD / out-of-line. */
    _handHotDemote() {
        for (;;) {
            const h = this._handHot;
            if (h === NIL) return; // defensive (never on a coherent clock with a hot page)
            const st = this._st[h];
            if (st & CLOCKPRO_HOT) {
                if (st & CLOCKPRO_REF) {
                    this._st[h] = CLOCKPRO_HOT;                 // second chance: clear ref, stay hot
                    this._handHot = this._advance(this._handHot);
                } else {
                    this._st[h] = CLOCKPRO_TEST;               // demote: cold, in a fresh test period
                    this._nHot--; this._nCold++;
                    this._handHot = this._advance(this._handHot);
                    return;
                }
            } else {
                this._handHot = this._advance(this._handHot);  // skip cold pages
            }
        }
    }

    /** Promote a referenced resident cold page (found in its test period by HAND_cold) to a
     *  hot page. Split into a helper so a subclass (torture lane coverage) can count it. */
    _promoteCold(c) {
        this._st[c] = CLOCKPRO_HOT; // hot, ref cleared, test cleared
        this._nCold--; this._nHot++;
    }

    /**
     * Free exactly ONE resident slot and return it for in-place reuse (D6-style). Runs one
     * HAND_test step, ensures a cold page exists (demoting a hot page if the clock is all
     * hot), then sweeps HAND_cold: a referenced cold page in its test period is PROMOTED to
     * hot; a referenced cold page not in test gets a second chance (a fresh test period); the
     * first UNREFERENCED cold page is evicted -- to the bounded history iff it was in a test
     * period. Sets `_evKey`/`_evVal` for the onEvict fire-after. Only ever called at capacity.
     */
    _evictOne() {
        if (this._nCold === 0) this._handHotDemote(); // guarantee an eviction candidate exists
        for (;;) {
            const c = this._handCold;
            const st = this._st[c];
            if (st & CLOCKPRO_HOT) {
                this._handCold = this._advance(this._handCold); // the cold hand skips hot pages
                continue;
            }
            if (st & CLOCKPRO_REF) {
                if (st & CLOCKPRO_TEST) {
                    // referenced during its test period -> the page earned hot status.
                    this._promoteCold(c);
                    this._handCold = this._advance(this._handCold);
                    this._handTestStep();               // reference activity -> step the test hand
                    if (this._nHot > this._mHot || this._nCold === 0) this._handHotDemote();
                    continue;
                }
                // referenced, not in test -> second chance, restart the test period.
                this._st[c] = CLOCKPRO_TEST;
                this._handCold = this._advance(this._handCold);
                this._handTestStep();                   // reference activity -> step the test hand
                continue;
            }
            // an unreferenced cold page -> the victim.
            this._evKey = this._keys[c];
            this._evVal = this._vals[c];
            const wasTest = (st & CLOCKPRO_TEST) !== 0;
            this._removeSlot(c);                    // repair hands + unlink + nCold--
            this._store.delete(this._evKey);
            if (wasTest) this._histAdd(this._evKey); // a test page leaves as a non-resident test page
            this._st[c] = 0;
            this._size--;
            return c;
        }
    }

    // --- public API (all zero-alloc on the hot path) --------------------------

    /** Look up a key AND set its reference bit (ClockPro's second-chance flag). The whole
     *  hot path is a single `_st` store -- 0 link writes (D25.5). @returns the value, or
     *  undefined if absent (see D7). A get never consults the non-resident history. */
    get(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const s = this._store.get(key);
        if (s < 0) { if (this._stats !== null) this._stats.misses++; return undefined; } // miss (0019)
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (this._stats !== null) this._stats.misses++; // stale = miss (+ evict via _reap; D19.2)
            this._reap(s);
            return undefined;
        }
        this._st[s] |= CLOCKPRO_REF; // the whole hot path: one state store, no relink
        if (this._stats !== null) this._stats.hits++; // live hit (0019)
        return this._vals[s];
    }

    /**
     * Insert or update. An update rewrites the value and sets the reference bit (like a hit,
     * D25.5). A new key still in the bounded non-resident history is re-admitted as a HOT
     * page and RAISES the adaptive hot target (D25.3); a brand-new key enters as a cold page
     * in a test period. At capacity one resident is evicted first (its slot reused in place).
     * onEvict fires LAST (0002). The positional `ttlMs` (0017) overrides the ttl default.
     */
    put(key, value, ttlMs) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        let expiresAt;
        if (this._exp !== null) expiresAt = expiryFor(this._clock, this._ttl, ttlMs);
        else if (ttlMs !== undefined) throw new Error(TTL_NO_COLUMN_MSG); // fail closed (D17.4)
        this._store._ver++; // D18.6 -- put mutates; invalidate iterators
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                  // update-in-place + set the reference bit
            this._vals[existing] = value;
            if (this._exp !== null) this._exp[existing] = expiresAt; // restamp (D17)
            this._st[existing] |= CLOCKPRO_REF;
            if (this._stats !== null) this._stats.puts++; // successful update (outcome-based); 0019
            return;
        }

        const inHist = this._hist.has(key);
        let s;
        let evicted = false;
        if (this._size === this._capacity) {
            s = this._evictOne();             // evict one resident -> reuse its slot; sets _evKey/_evVal
            evicted = true;
        } else {
            s = store.allocSlot();
        }

        if (inHist) {
            this._hist.consume(key);
            this._mHot++; if (this._mHot > this._capacity) this._mHot = this._capacity; // raise (D25.3)
        }
        this._keys[s] = key;
        this._vals[s] = value;
        if (this._exp !== null) this._exp[s] = expiresAt; // stamp the expiry (D17)
        store.set(key, s);
        this._pushFront(s);

        if (inHist) {
            // a non-resident test page re-referenced -> re-admit as HOT (the recency win).
            this._st[s] = CLOCKPRO_HOT;
            this._nHot++;
            if (this._nHot > this._mHot) this._handHotDemote();
        } else {
            // a brand-new page -> cold, in a test period.
            this._st[s] = CLOCKPRO_TEST;
            this._nCold++;
        }
        this._size++;
        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); 0019

        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (0019)
            const evKey = this._evKey, evVal = this._evVal;
            this._evKey = undefined; this._evVal = undefined; // retention hygiene
            this._inOnEvict = true;
            try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
        }
    }

    /** True if key is present (RESIDENT). History keys are NOT present. Reference-NEUTRAL. A
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

    /** Read a value WITHOUT setting the reference bit. undefined if absent (see D7). A stale
     *  entry is a MISS and is reaped in place (decisions/0017, D17.3). */
    peek(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return undefined;
        }
        return this._vals[s];
    }

    /** Reap an expired slot in place (decisions/0017): repair hands, unlink from the ring,
     *  drop from the index, free the slot, and fire onEvict LAST via the 0002 guard. A reap
     *  is NOT a capacity victim, so it is never recorded in the history (like delete). */
    _reap(s) {
        this._store._ver++; // D18.6 -- a reap is a structural mutation; invalidate iterators
        const evKey = this._keys[s];
        const evVal = this._vals[s];
        this._removeSlot(s);
        this._store.delete(evKey);
        this._st[s] = 0;
        this._store.freeSlot(s);
        this._size--;
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

    /** Remove a key. Returns true if it was present. Frees the slot; NOT recorded in history. */
    delete(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const store = this._store;
        const s = store.get(key);
        if (s < 0) return false;
        store._ver++; // D18.6 -- a real delete is a structural mutation; invalidate iterators
        this._removeSlot(s);
        store.delete(key);
        this._st[s] = 0;
        store.freeSlot(s);
        this._size--;
        return true;
    }

    /** Empty the cache. Rebuilds the free list, empties the ring + history, resets the hands,
     *  the counts and the adaptive target. Allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._head = NIL; this._tail = NIL;
        this._handCold = NIL; this._handHot = NIL; this._handTest = NIL;
        this._nHot = 0; this._nCold = 0; this._size = 0;
        this._mHot = 0;
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

    /** The per-member iteration ROSTER (decisions/0018 / 0025): the clock walked newest
     *  (`_head`) -> oldest (`_tail`) over the shared `_next` column -- RESIDENT only (the
     *  non-resident history is EXCLUDED). NOT recency order (a clock does not track it);
     *  recency-neutral, stale-skipping, fail-closed via `_ver` -- the shared CacheIterator
     *  walks it unchanged (the NIL terminus, not the wrap, is what iteration follows). */
    _iterHeads() { return [this._head]; }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- snapshot / restore (decisions/0021, D21 + 0025): COLD, may allocate --

    /** Serialize to a plain snapshot (decisions/0021, D21 + D25.6): the clock newest..oldest
     *  (values/expiry) + each page's per-slot `_st` byte, the THREE hand positions, the
     *  adaptive `_mHot`, AND the bounded non-resident history (keys only, oldest..newest).
     *  Dropping the hands, `_mHot`, the test bits or the history is a fail-OPEN future-
     *  eviction bug, so ALL are captured (the t9 controls prove the round-trip catches it). */
    dump() {
        const snap = snapBase(this, "ClockPro");
        snap.ring = snapList(this, this._head, false);
        const st = [];
        for (let i = 0; i < snap.ring.slots.length; i++) st.push(this._st[snap.ring.slots[i]]);
        snap.st = st;
        snap.handCold = this._handCold;
        snap.handHot = this._handHot;
        snap.handTest = this._handTest;
        snap.mHot = this._mHot;
        snap.hist = snapArcGhost(this._hist);
        return snap;
    }

    /** Reconstruct a FRESH ClockPro from a snapshot (decisions/0021, D21 + D25.6). Fail
     *  closed on any tag/shape mismatch, a malformed/short `st` column, a `_st` byte that is
     *  not a valid tag (0..7, never HOT|TEST), an `mHot` out of [0,cap], a hand that does not
     *  reference a resident slot (or is set on an empty clock), or a history over its bound. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "ClockPro", opts);
        const inst = new ClockPro(cap, snapOpts(snap, opts));
        const occ = snapCheckOccupy(cap, snap.ttl, [[snap.ring, "ring"]]);
        // Shape the ClockPro-specific aux (fail closed -- "null is not zero").
        if (!Array.isArray(snap.st) || snap.st.length !== snap.ring.slots.length) {
            throw new Error(SNAP_BAD + "clockpro st must be an array aligned to the ring");
        }
        for (let i = 0; i < snap.st.length; i++) {
            const b = snap.st[i];
            if (!Number.isInteger(b) || b < 0 || b > 7) {
                throw new Error(SNAP_BAD + "clockpro st[" + i + "] = " + String(b) + " (must be an integer 0..7)");
            }
            if ((b & CLOCKPRO_HOT) && (b & CLOCKPRO_TEST)) {
                throw new Error(SNAP_BAD + "clockpro st[" + i + "] is both hot and in a test period (invalid)");
            }
        }
        if (!Number.isInteger(snap.mHot) || snap.mHot < 0 || snap.mHot > cap) {
            throw new Error(SNAP_BAD + "clockpro mHot out of [0," + cap + "]: " + String(snap.mHot));
        }
        if (!Array.isArray(snap.hist)) throw new Error(SNAP_BAD + "clockpro history (hist) must be an array");
        if (snap.hist.length > cap) {
            throw new Error(SNAP_BAD + "clockpro history (" + snap.hist.length + ") exceeds capacity (" + cap + ")");
        }

        const R = snapRestoreList(inst, snap.ring, null, 0);
        inst._head = R.head; inst._tail = R.tail; inst._size = R.size;
        let nHot = 0, nCold = 0;
        for (let i = 0; i < snap.ring.slots.length; i++) {
            const s = snap.ring.slots[i];
            inst._st[s] = snap.st[i];
            if (snap.st[i] & CLOCKPRO_HOT) nHot++; else nCold++;
        }
        inst._nHot = nHot; inst._nCold = nCold;

        // The three hands: NIL iff the clock is empty, else a resident slot (fail closed).
        const hands = [["handCold", snap.handCold], ["handHot", snap.handHot], ["handTest", snap.handTest]];
        for (let i = 0; i < hands.length; i++) {
            const nm = hands[i][0], h = hands[i][1];
            if (R.size === 0) {
                if (h !== NIL) throw new Error(SNAP_BAD + "clockpro " + nm + " set on an empty clock");
            } else if (!Number.isInteger(h) || h < 0 || h >= cap || occ[h] === 0) {
                throw new Error(SNAP_BAD + "clockpro " + nm + " " + String(h) + " does not reference a resident slot");
            }
        }
        inst._handCold = snap.handCold;
        inst._handHot = snap.handHot;
        inst._handTest = snap.handTest;

        const gInt = typeof inst._store._ck === "function";
        for (let i = 0; i < snap.hist.length; i++) {
            if (gInt) inst._store._ck(snap.hist[i]); // fail closed on a non-int history key
            inst._histAdd(snap.hist[i]);
        }
        // Set the adaptive target AFTER replaying the history so a bounded-history drop during
        // replay (which lowers _mHot) cannot perturb the captured value.
        inst._mHot = snap.mHot;

        inst._store.rebuildFreeList(occ);
        return inst;
    }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store (conservation invariant). */
    _freeListLength() {
        return this._store.freeListLength();
    }

    /**
     * The key the NEXT over-capacity insert would evict, computed WITHOUT mutating any link,
     * bit, hand, count or `_mHot` (the non-destructive twin of `_evictOne`). It clones the
     * `_st` bytes and copies the hands / counts / `_mHot` into locals, then replays the EXACT
     * `_evictOne` sweep (HAND_test step + HAND_cold sweep with HAND_hot demotions) reading the
     * unchanged `_next` topology, returning the victim's key. TEST-ONLY (drives the torture
     * differential); it MAY allocate (the `_st` clone) precisely because it is never a hot or
     * measured path.
     */
    _peekVictim() {
        if (this._size === 0) return undefined;
        const next = this._next, keys = this._keys, st = this._st.slice();
        const head = this._head;
        let handCold = this._handCold, handHot = this._handHot, handTest = this._handTest;
        let nHot = this._nHot, nCold = this._nCold, mHot = this._mHot;
        const advance = (s) => { const n = next[s]; return n !== NIL ? n : head; };
        const demote = () => {
            for (;;) {
                const h = handHot;
                if (h === NIL) return;
                const s = st[h];
                if (s & CLOCKPRO_HOT) {
                    if (s & CLOCKPRO_REF) { st[h] = CLOCKPRO_HOT; handHot = advance(handHot); }
                    else { st[h] = CLOCKPRO_TEST; nHot--; nCold++; handHot = advance(handHot); return; }
                } else { handHot = advance(handHot); }
            }
        };
        const testStep = () => {
            if (handTest === NIL) return;
            const s = st[handTest];
            if ((s & CLOCKPRO_HOT) === 0 && (s & CLOCKPRO_TEST) !== 0) {
                st[handTest] &= ~CLOCKPRO_TEST; if (mHot > 0) mHot--;
            }
            handTest = advance(handTest);
        };
        if (nCold === 0) demote();
        for (;;) {
            const c = handCold;
            const s = st[c];
            if (s & CLOCKPRO_HOT) { handCold = advance(handCold); continue; }
            if (s & CLOCKPRO_REF) {
                if (s & CLOCKPRO_TEST) {
                    st[c] = CLOCKPRO_HOT; nCold--; nHot++;
                    handCold = advance(handCold);
                    testStep();
                    if (nHot > mHot || nCold === 0) demote();
                    continue;
                }
                st[c] = CLOCKPRO_TEST; handCold = advance(handCold); testStep(); continue;
            }
            return keys[c];
        }
    }
}

/* -------------------------------------------------------------------------- *
 * LruKHistory -- the bounded, keys-only non-resident history for LruK (decisions/0026,
 * D26.4). Reuses the ArcGhost ring VERBATIM (like LirsHistory / ClockProHistory): a
 * drop-oldest FIFO of at most `capacity` recently-evicted keys, strict-zero on keys:'int'.
 * A brand-name subclass keeps the member roster + snapshot code self-documenting.
 * -------------------------------------------------------------------------- */
class LruKHistory extends ArcGhost {}

/* -------------------------------------------------------------------------- *
 * LruK -- LRU-K (O'Neil, O'Neil & Weikum, SIGMOD'93), K=2, decisions/0026, D26. The
 * ELEVENTH named export in this file (same single-file ruling as the rest of the family:
 * single main file + sideEffects:false + named exports = the tree-shake moat).
 *
 * LRU-K evicts by the K-th BACKWARD DISTANCE: the time of a page's K-th-most-recent
 * reference. A page with FEWER than K references has an INFINITE backward K-distance and is
 * evicted first (its K-th reference never happened); among finite-distance pages the one
 * whose K-th reference is furthest in the past (the SMALLEST K-th-reference timestamp) is
 * the victim. This member fixes K=2 (the canonical, best-studied setting -- LRU-2): a page
 * is COLD until its 2nd reference, then WARM. There is NO knob and NO correlated-reference
 * period (CRP): the deviations from the 1993 paper are documented in decisions/0026 (D26.1
 * K=2, D26.6 no-CRP, D26.4 keys-only bounded history) and do NOT change which resident the
 * policy evicts for the classic (no-CRP) LRU-2 model.
 *
 * STRUCTURE (all fixed at construction, zero-alloc on the hot path):
 *   - TWO disjoint intrusive lists over the SHARED `_next`/`_prev` columns (a slot is in
 *     exactly one): the COLD list (`_coldHead` newest .. `_coldTail` oldest = the O(1)
 *     eviction end) holds pages with < K references; the WARM list (`_warmHead`..`_warmTail`)
 *     holds pages with >= K references. Because the two lists partition the resident set over
 *     the shared columns, validate()/iteration/snapshot reuse the shared machinery unchanged.
 *   - `_r0` / `_r1` Float64 columns (allocated WITH the store, never per key): `_r0[s]` is the
 *     most-recent reference timestamp, `_r1[s]` the SECOND-most-recent (the K=2 backward
 *     distance). A cold page has only one reference, so `_r1[s]` sits at the -Infinity SENTINEL
 *     (D26.3: "null is not zero" -- a cold page is not "K-distance 0", it is K-distance
 *     infinity, and -Infinity as the stored 2nd-reference time makes a stray unified scan
 *     rank it for eviction FIRST, exactly matching the two-phase rule).
 *   - `_st` Uint8: bit0 warm. A warm hit is 2 stamps + 0 link writes; a cold->warm promotion
 *     is 2 stamps + at most 5 (2..5) link writes, non-exceedable (D26.2, pinned + proven in t6).
 *   - `_t`: a monotone Float64 logical clock (a plain number field, exact to 2^53), bumped
 *     `++this._t` on every reference so timestamps never collide across pages.
 *   - `_hist` (LruKHistory): the bounded keys-only non-resident history (D26.4); a put of a
 *     key still in it re-admits the page as WARM at `_r1 = _r0 = ++_t` (it has proven >= K
 *     references over time -- the LRU-K recency-of-recency win).
 *
 * VICTIM (D26.5): the cold list is checked FIRST -- its tail is an O(1) infinite-K-distance
 * victim. Only when NO cold page exists is a LINEAR min-`_r1` scan run over the warm list:
 * O(size) READS, O(1) writes. This is honestly NOT amortized O(1): an all-warm steady state
 * scans the whole warm list on every eviction (t6 MEASURES the worst-observed scan length
 * and a LRUK_EVICT_SCAN_TRIPWIRE catches regressions -- it is never claimed as a bound).
 *
 * Rides the shared newStore factory (default Map / opt-in keys:'int' strict-zero), the
 * onEvict fire-after + `_inOnEvict` guard (0002), TTL (0017), zero-GC iteration (0018),
 * stats (0019), snapshot (0021). A hit is proven zero-alloc + <= 5-link-write by the t6 gate.
 * -------------------------------------------------------------------------- */

export class LruK {
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed -- identical to the rest of the family.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as every other member.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

        // Cache the store's columns so the relinks stay direct. `_next` toward the tail
        // (older), `_prev` toward the head (newer); the two lists are disjoint over them.
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next; // SHARED: threads the COLD list AND the WARM list (disjoint) + free stack
        this._prev = this._store._prev;
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // The two reference-time columns (D26.3): most-recent (`_r0`) and second-most-recent
        // (`_r1`, the K=2 backward distance). Member-specific, allocated WITH the store, fixed,
        // never grown -- the other members' hot paths carry no new column (like LIRS `_st`).
        // `_r1` starts at the -Infinity sentinel: a fresh/cold slot has no 2nd reference.
        this._r0 = new Float64Array(capacity);
        this._r1 = new Float64Array(capacity).fill(-Infinity);

        // Per-slot state (bit0 warm). Fixed, never grown.
        this._st = new Uint8Array(capacity);

        // The COLD list (< K refs): `_coldHead` = newest, `_coldTail` = oldest = eviction end.
        this._coldHead = NIL; this._coldTail = NIL;
        // The WARM list (>= K refs): the min-`_r1` scan walks it; order does not steer policy.
        this._warmHead = NIL; this._warmTail = NIL;

        this._size = 0; // resident = |cold| + |warm|

        // The monotone logical clock (D26.3): a plain number field (Float64 semantics), bumped
        // on every reference so no two stamped timestamps collide -> the min-`_r1` victim is unique.
        this._t = 0;

        // The bounded non-resident history (D26.4): keys only, cap = capacity, drop-oldest.
        this._histCap = capacity;
        this._histInt = (options && options.keys) === 'int';
        this._hist = new LruKHistory(capacity, this._histInt);

        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Retention hygiene for the onEvict fire-after: declared at construction so the object shape never transitions on first eviction.
        this._evKey = undefined;
        this._evVal = undefined;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- the two intrusive lists (shared `_next`/`_prev`) ----------------------

    /** Push slot s at the head (newest) of the COLD list. */
    _coldPush(s) {
        this._prev[s] = NIL; this._next[s] = this._coldHead;
        if (this._coldHead !== NIL) this._prev[this._coldHead] = s;
        this._coldHead = s; if (this._coldTail === NIL) this._coldTail = s;
    }

    /** Unlink slot s from the COLD list (2 link writes for an interior slot). */
    _coldDetach(s) {
        const p = this._prev[s], n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._coldHead = n;
        if (n !== NIL) this._prev[n] = p; else this._coldTail = p;
    }

    /** Push slot s at the head (newest) of the WARM list (3 link writes when warm non-empty). */
    _warmPush(s) {
        this._prev[s] = NIL; this._next[s] = this._warmHead;
        if (this._warmHead !== NIL) this._prev[this._warmHead] = s;
        this._warmHead = s; if (this._warmTail === NIL) this._warmTail = s;
    }

    /** Unlink slot s from the WARM list. */
    _warmDetach(s) {
        const p = this._prev[s], n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._warmHead = n;
        if (n !== NIL) this._prev[n] = p; else this._warmTail = p;
    }

    // --- the LRU-K policy core (COLD helpers, allocation-free) ------------------

    /** Add a key to the bounded non-resident history, dropping the OLDEST at the bound
     *  (D26.4). COLD (only the eviction path reaches it). */
    _histAdd(key) {
        if (this._hist._len >= this._histCap) this._hist.delLRU();
        this._hist.addMRU(key);
    }

    /** Scan the WARM list for the min-`_r1` victim (the largest K=2 backward distance). O(size)
     *  READS, 0 writes. `_t` is strictly monotone so every warm `_r1` is distinct -> the min is
     *  unique and the scan is order-independent. Factored out so a torture subclass can MEASURE
     *  the scan length (the honest O(size) characterization -- never a claimed bound). */
    _scanWarmVictim() {
        let best = this._warmHead;
        let bestR1 = this._r1[best];
        for (let s = this._next[best]; s !== NIL; s = this._next[s]) {
            const r = this._r1[s];
            if (r < bestR1) { bestR1 = r; best = s; }
        }
        return best;
    }

    /** Free exactly ONE resident slot and return it for in-place reuse (D6-style). Evicts the
     *  cold tail when a cold page exists (O(1) -- infinite K-distance goes first, D26.5); else
     *  the min-`_r1` warm page. The evicted key enters the bounded history (D26.4). Sets
     *  `_evKey`/`_evVal` for the onEvict fire-after. COLD; only ever called at capacity. */
    _evictOne() {
        let s;
        if (this._coldTail !== NIL) {
            s = this._coldTail;
            this._evKey = this._keys[s]; this._evVal = this._vals[s];
            this._coldDetach(s);
        } else {
            s = this._scanWarmVictim();
            this._evKey = this._keys[s]; this._evVal = this._vals[s];
            this._warmDetach(s);
        }
        this._store.delete(this._evKey);
        this._histAdd(this._evKey);
        this._st[s] = 0;
        this._r1[s] = -Infinity; // back to the cold sentinel (the slot is about to be reused)
        this._size--;
        return s;
    }

    /** The per-access recency step for a RESIDENT slot (get hit / put update). A warm hit is 2
     *  stamps + 0 link writes; a cold->warm promotion is 2 stamps + at most 5 (2..5) link writes,
     *  non-exceedable (D26.2: up to 2 for the cold detach + up to 3 for the warm push). */
    _access(s) {
        this._r1[s] = this._r0[s];   // the 2nd-most-recent reference time slides down (stamp 1)
        this._r0[s] = ++this._t;     // the new most-recent reference time (stamp 2)
        if ((this._st[s] & LRUK_WARM) === 0) {
            // cold -> warm: this was the K-th (2nd) reference. Move lists + set the warm bit.
            this._coldDetach(s);     // 2 link writes (interior)
            this._st[s] |= LRUK_WARM;
            this._warmPush(s);       // 3 link writes (warm non-empty)
        }
    }

    // --- public API (all zero-alloc on the hot path) --------------------------

    /** Look up a key AND apply the LRU-K access policy (stamp the reference times; promote to
     *  warm on the K-th reference). @returns the value, or undefined if absent (see D7). A get
     *  never consults the non-resident history (a missing key is a plain miss). */
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
     * hit -- a cold update becomes its K-th reference and promotes to warm). A new key still in
     * the bounded non-resident history is re-admitted as WARM at `_r1 = _r0 = ++_t` (it has
     * proven >= K references over time); a brand-new key enters COLD. At capacity one resident
     * is evicted first (its slot reused in place); onEvict fires LAST (0002). The positional
     * `ttlMs` (0017) overrides the instance ttl default.
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
            s = this._evictOne();             // evict one resident -> reuse its slot; sets _evKey/_evVal
            evicted = true;
        } else {
            s = store.allocSlot();
        }

        if (inHist) this._hist.consume(key);  // it is being re-admitted (resident again)
        this._keys[s] = key;
        this._vals[s] = value;
        if (this._exp !== null) this._exp[s] = expiresAt; // stamp the expiry (D17)
        store.set(key, s);

        const t = ++this._t;
        this._r0[s] = t;
        if (inHist) {
            // a proven page (>= K references over time) -> re-admit WARM at r1 = r0 = t (D26.4).
            this._r1[s] = t;
            this._st[s] = LRUK_WARM;
            this._warmPush(s);
        } else {
            // a brand-new page -> COLD, its 2nd-reference time is the -Infinity sentinel (D26.3).
            this._r1[s] = -Infinity;
            this._st[s] = 0;
            this._coldPush(s);
        }
        this._size++;

        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); 0019

        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (0019)
            const evKey = this._evKey, evVal = this._evVal;
            this._evKey = undefined; this._evVal = undefined; // retention hygiene
            this._inOnEvict = true;
            try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
        }
    }

    /** True if key is present (RESIDENT). History keys are NOT present. Policy-NEUTRAL. A stale
     *  entry is a MISS and is reaped in place (decisions/0017, D17.3). */
    has(key) {
        const s = this._store.get(key);
        if (s < 0) return false;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return false;
        }
        return true;
    }

    /** Read a value WITHOUT applying the policy. undefined if absent (see D7). A stale entry is
     *  a MISS and is reaped in place (decisions/0017, D17.3). */
    peek(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return undefined;
        }
        return this._vals[s];
    }

    /** Unlink a resident slot from its list (cold or warm), dropping the size. Shared by delete
     *  + reap; NOT ghosted (a delete/reap keeps no non-resident metadata, like the family). */
    _unlinkResident(s) {
        if (this._st[s] & LRUK_WARM) this._warmDetach(s); else this._coldDetach(s);
        this._st[s] = 0;
        this._r1[s] = -Infinity;
        this._size--;
    }

    /** Reap an expired slot in place (decisions/0017): unlink, drop from the index, free the
     *  slot, and fire onEvict LAST via the 0002 guard. Not ghosted (like delete). */
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

    /** Empty the cache. Rebuilds the free list, empties both lists + the history, and resets the
     *  per-slot state + the logical clock. Allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._coldHead = NIL; this._coldTail = NIL;
        this._warmHead = NIL; this._warmTail = NIL;
        this._size = 0;
        this._t = 0;
        this._st.fill(0);
        this._r1.fill(-Infinity);
        this._hist.clear();
    }

    // --- opt-in runtime stats (decisions/0019, D19): cold accessors -----------

    /** The live stats holder (decisions/0019, D19.3), returned BY REFERENCE (borrowed). Fail
     *  closed on an instance built without { stats: true }. */
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

    /** The per-member iteration ROSTER (decisions/0018 / 0026): the WARM list THEN the COLD
     *  list, both threaded through the shared `_next` column -- RESIDENT only, the non-resident
     *  history EXCLUDED. Recency-neutral, stale-skipping, fail-closed via `_ver` -- the shared
     *  CacheIterator walks it unchanged. */
    _iterHeads() { return [this._warmHead, this._coldHead]; }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- snapshot / restore (decisions/0021, D21 + 0026): COLD, may allocate --

    /** Serialize to a plain snapshot (decisions/0021, D21 + D26.7): the WARM + COLD lists (each
     *  with values/expiry), their aligned `_r0`/`_r1` reference-time columns, the logical clock
     *  `_t`, AND the bounded non-resident history (keys only, oldest..newest). Dropping the
     *  reference times, the clock or the history is a fail-OPEN future-eviction bug, so all are
     *  captured (the t9 controls prove the round-trip catches it). */
    dump() {
        const snap = snapBase(this, "LruK");
        snap.warm = snapList(this, this._warmHead, false);
        snap.cold = snapList(this, this._coldHead, false);
        snap.warmR0 = []; snap.warmR1 = [];
        for (let i = 0; i < snap.warm.slots.length; i++) {
            const s = snap.warm.slots[i];
            snap.warmR0.push(this._r0[s]); snap.warmR1.push(this._r1[s]);
        }
        snap.coldR0 = []; snap.coldR1 = [];
        for (let i = 0; i < snap.cold.slots.length; i++) {
            const s = snap.cold.slots[i];
            snap.coldR0.push(this._r0[s]); snap.coldR1.push(this._r1[s]);
        }
        snap.tick = this._t;
        snap.hist = snapArcGhost(this._hist);
        return snap;
    }

    /** Reconstruct a FRESH LruK from a snapshot (decisions/0021, D21 + D26.7). Fail closed on
     *  any tag/shape mismatch; a malformed/short/mis-aligned reference-time column; a
     *  non-finite `_r0` (or a `_r1` that is neither finite nor the -Infinity sentinel); a cold
     *  page whose `_r1` is not the -Infinity sentinel; a `tick` that is not a non-negative
     *  finite number; or a history over its bound. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "LruK", opts);
        const inst = new LruK(cap, snapOpts(snap, opts));
        const occ = snapCheckOccupy(cap, snap.ttl, [[snap.warm, "warm"], [snap.cold, "cold"]]);

        // Shape the LRU-K-specific aux (fail closed -- "null is not zero").
        const ckCol = (arr, n, label, allowNegInf) => {
            if (!Array.isArray(arr) || arr.length !== n) {
                throw new Error(SNAP_BAD + "lruk " + label + " must be an array aligned to its list");
            }
            for (let i = 0; i < n; i++) {
                const x = arr[i];
                if (typeof x !== "number") {
                    throw new Error(SNAP_BAD + "lruk " + label + "[" + i + "] = " + String(x) + " (must be a number)");
                }
                if (Number.isNaN(x)) {
                    throw new Error(SNAP_BAD + "lruk " + label + "[" + i + "] is NaN");
                }
                if (!Number.isFinite(x) && !(allowNegInf && x === -Infinity)) {
                    throw new Error(SNAP_BAD + "lruk " + label + "[" + i + "] = " + String(x) + " (must be finite)");
                }
            }
        };
        const nWarm = snap.warm.slots.length, nCold = snap.cold.slots.length;
        ckCol(snap.warmR0, nWarm, "warmR0", false);
        ckCol(snap.warmR1, nWarm, "warmR1", false); // warm pages have a finite 2nd-reference time
        ckCol(snap.coldR0, nCold, "coldR0", false);
        ckCol(snap.coldR1, nCold, "coldR1", true);  // cold pages: -Infinity sentinel only
        for (let i = 0; i < nCold; i++) {
            if (snap.coldR1[i] !== -Infinity) {
                throw new Error(SNAP_BAD + "lruk coldR1[" + i + "] = " + String(snap.coldR1[i]) + " (a cold page must sit at the -Infinity sentinel)");
            }
        }
        if (typeof snap.tick !== "number" || !Number.isFinite(snap.tick) || snap.tick < 0) {
            throw new Error(SNAP_BAD + "lruk tick must be a non-negative finite number, got " + String(snap.tick));
        }
        if (!Array.isArray(snap.hist)) throw new Error(SNAP_BAD + "lruk history (hist) must be an array");
        if (snap.hist.length > cap) {
            throw new Error(SNAP_BAD + "lruk history (" + snap.hist.length + ") exceeds capacity (" + cap + ")");
        }

        const W = snapRestoreList(inst, snap.warm, null, 0);
        for (let i = 0; i < nWarm; i++) {
            const s = snap.warm.slots[i];
            inst._st[s] = LRUK_WARM;
            inst._r0[s] = snap.warmR0[i];
            inst._r1[s] = snap.warmR1[i];
        }
        inst._warmHead = W.head; inst._warmTail = W.tail;

        const C = snapRestoreList(inst, snap.cold, null, 0);
        for (let i = 0; i < nCold; i++) {
            const s = snap.cold.slots[i];
            inst._st[s] = 0;
            inst._r0[s] = snap.coldR0[i];
            inst._r1[s] = snap.coldR1[i];
        }
        inst._coldHead = C.head; inst._coldTail = C.tail;

        inst._size = W.size + C.size;
        inst._t = snap.tick;

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

    /** The key the NEXT over-capacity insert would evict, WITHOUT mutating (D26.5): the cold
     *  tail when a cold page exists, else the min-`_r1` warm page. TEST-ONLY (drives the torture
     *  differential); never a hot path. */
    _peekVictim() {
        if (this._size === 0) return undefined;
        if (this._coldTail !== NIL) return this._keys[this._coldTail];
        return this._keys[this._scanWarmVictim()];
    }
}

/* -------------------------------------------------------------------------- *
 * MqHistory -- the bounded, keys-only + refcount non-resident history for MQ
 * (decisions/0027, D27.5). A GENERALIZATION of ArcGhost (like LirsHistory /
 * ClockProHistory / LruKHistory): the SAME drop-oldest FIFO ring of at most
 * `capacity` recently-evicted keys, strict-zero on keys:'int' -- PLUS a PARALLEL
 * Float64 refcount ring aligned to the key ring (int: the pow2 `_ring`; Map: the
 * `_ringArr`). MQ's Qout retains each evicted block's reference COUNT so a returning
 * block resumes at its remembered frequency band (the multi-queue "frequency memory"
 * win). The refcount ring is fixed-size at construction and NEVER a per-key array;
 * dropping the oldest key drops its rc slot with it. `addMRU`/`consume` keep the two
 * rings in lockstep; `rcOf` is a COLD membership scan (never a hot path).
 * -------------------------------------------------------------------------- */
class MqHistory extends ArcGhost {
    constructor(cap, isInt) {
        super(cap, isInt);
        // The parallel refcount ring, aligned to the key ring: int -> the pow2 `_ring`
        // (indexed by (head+i) & ringMask); Map -> the `_ringArr` (indexed by (head+i) % cap).
        this._rcRing = cap > 0 ? new Float64Array(isInt ? this._ring.length : cap) : null;
    }

    /** Add key at the MRU (tail) end WITH its refcount. Caller GUARANTEES room (_len < cap). */
    addMRU(key, rc) {
        if (this._cap === 0) return;
        if (this._int) {
            const pos = (this._head + this._len) & this._ringMask;
            this._ring[pos] = key;
            this._rcRing[pos] = rc;
            this._memAdd(key);
        } else {
            const pos = (this._head + this._len) % this._cap;
            this._ringArr[pos] = key;
            this._rcRing[pos] = rc;
            this._set.add(key);
        }
        this._len++;
    }

    /** The refcount stored for a PRESENT key (COLD membership scan; returns -1 if absent). */
    rcOf(key) {
        if (this._cap === 0) return -1;
        if (this._int) {
            const mask = this._ringMask;
            for (let i = 0; i < this._len; i++) {
                const p = (this._head + i) & mask;
                if (this._ring[p] === key) return this._rcRing[p];
            }
        } else {
            const cap = this._cap;
            for (let i = 0; i < this._len; i++) {
                const p = (this._head + i) % cap;
                if (sameKey(this._ringArr[p], key)) return this._rcRing[p];
            }
        }
        return -1;
    }

    /** Remove a SPECIFIC key (re-admission), shifting BOTH rings in lockstep. COLD; never hot. */
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
                    const a = (this._head + i) & mask, b = (this._head + i + 1) & mask;
                    this._ring[a] = this._ring[b];
                    this._rcRing[a] = this._rcRing[b];
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
                    const a = (this._head + i) % cap, b = (this._head + i + 1) % cap;
                    this._ringArr[a] = this._ringArr[b];
                    this._rcRing[a] = this._rcRing[b];
                }
                this._ringArr[(this._head + this._len - 1) % cap] = undefined;
                this._len--;
            }
            this._set.delete(key);
        }
    }
}

/* -------------------------------------------------------------------------- *
 * Mq -- Multi-Queue (Zhou, Philbin & Li, USENIX ATC'01), decisions/0027, D27. The
 * TWELFTH named export in this file (same single-file ruling as the rest of the
 * family: single main file + sideEffects:false + named exports = the tree-shake moat).
 *
 * MQ ranks blocks by a FREQUENCY BAND and demotes idle blocks over LOGICAL time. Each
 * block carries a reference count `rc`; its band is `q = min(floor(log2(rc)), m-1)`
 * (the highest set bit of rc, clamped -- D27.3, the fail-closed clz32 saturation). The
 * resident set is partitioned into m = 8 LRU queues Q0..Q7 (D27.1) threaded through the
 * SHARED `_next`/`_prev` columns; a hit moves the block to the MRU (head) of its band
 * and stamps an EXPIRE time `_exq = _t + lifeTime` on a LOGICAL clock `_t` (D27.2,
 * lifeTime = capacity). A block that sits untouched past its expire time is DEMOTED one
 * band toward Q0 by the aging sweep, so a once-hot block that goes cold decays and
 * becomes evictable. Eviction takes the LRU (tail) of the LOWEST non-empty queue
 * (D27.4). An evicted block's key + rc enter the bounded Qout history (MqHistory); a put
 * of a key still in Qout re-admits it at its remembered rc (D27.5).
 *
 * HONESTY (D27.6). Unlike Sieve/S3Fifo/ClockPro/LruK-warm, an MQ hit is NOT a
 * 0-link-write lazy-promotion hit: moving the block to its band's MRU is REAL list
 * surgery -- 0 link writes when it is already the MRU of its (unchanged) band, else
 * AT MOST 5 (4..5: a <= 2-write detach + a <= 3-write head push). On top of that EVERY access
 * runs a FIXED m-1 = 7-step aging sweep: for each of Q1..Q7 it demotes the queue's tail
 * IF expired, at most 4 link writes each (a <= 1-write tail detach + a <= 3-write head
 * push into the band below). The sweep is a REAL CONSTANT, not an amortized bound,
 * because RESET-ON-DEMOTE forbids cascade: a demoted block lands at the HEAD of an
 * ALREADY-VISITED lower queue with a fresh `_exq`, so it can never be re-examined or
 * re-demoted within the same access (proven by walking the sweep; PINNED + measured by
 * `CountedMq` in t6). Worst case per access: 5 + 7*4 = 33 link writes + 3 metadata
 * stamps (`_rc`, `_qn`, `_exq` on the accessed slot), NON-EXCEEDABLE.
 *
 * STRUCTURE (all fixed at construction, zero-alloc on the hot path):
 *   - `_rc` / `_exq` Float64 columns (allocated WITH the store, never per key): the
 *     reference count and the logical expire time per slot.
 *   - `_qn` Uint8 column: which band (0..7) a slot's queue is -- kept <= band(rc)
 *     because aging can demote a high-rc block below its natural band (the decay).
 *   - `_qHead` / `_qTail` Int32Array(m): the MRU/LRU endpoint of each of the 8 queues.
 *   - `_t`: a monotone Float64 logical clock (a plain number field, exact to 2^53),
 *     bumped `++this._t` on every reference; SEPARATE from the wall-clock TTL option.
 *   - `_hist` (MqHistory): the bounded keys-only + refcount Qout (D27.5).
 *
 * Rides the shared newStore factory (default Map / opt-in keys:'int' strict-zero), the
 * onEvict fire-after + `_inOnEvict` guard (0002), TTL (0017 -- the WALL-CLOCK ttl,
 * distinct from the logical `_t`), zero-GC iteration (0018), stats (0019), snapshot
 * (0021). The hot path is proven zero-alloc + <= 33-link-write + 3-stamp by the t6 gate.
 * -------------------------------------------------------------------------- */

export class Mq {
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017) -- the WALL-CLOCK ttl, validated fail-closed, identical to the
        // rest of the family. NOTE: this is DISTINCT from the logical clock `_t` below (D27.2).
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as every other member.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

        // Cache the store's columns so the relinks stay direct. The 8 queues are DISJOINT over
        // the shared `_next`/`_prev` columns (a slot is in exactly one), so validate()/iteration/
        // snapshot reuse the shared machinery unchanged.
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next; // SHARED: threads all 8 queues (disjoint) + the free stack
        this._prev = this._store._prev;
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // Member-specific columns, allocated WITH the store, fixed, never grown (like LIRS `_st`).
        this._rc = new Float64Array(capacity);  // reference count per slot
        this._exq = new Float64Array(capacity); // logical expire time per slot (_t + lifeTime)
        this._qn = new Uint8Array(capacity);    // band (0..7) the slot's queue currently is

        // The 8 LRU queues' endpoints: head = MRU, tail = LRU (the eviction end of each band).
        this._qHead = new Int32Array(MQ_M).fill(NIL);
        this._qTail = new Int32Array(MQ_M).fill(NIL);

        this._size = 0; // resident = sum(|Q0..Q7|)

        // The monotone logical clock (D27.2): a plain number field (Float64 semantics), bumped on
        // every reference; lifeTime = capacity. SEPARATE from the wall-clock `_clock`/`_ttl` above.
        this._t = 0;

        // The bounded Qout history (D27.5): keys + refcount, cap = capacity, drop-oldest.
        this._histCap = capacity;
        this._histInt = (options && options.keys) === 'int';
        this._hist = new MqHistory(capacity, this._histInt);

        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Retention hygiene for the onEvict fire-after: declared at construction so the object shape never transitions on first eviction.
        this._evKey = undefined;
        this._evVal = undefined;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- the m intrusive band queues (shared `_next`/`_prev`) ------------------

    /** The band of a reference count `rc` (D27.3): min(floor(log2(rc)), 7) = the highest set bit
     *  of rc, clamped to 7. `rc >= 128` short-circuits to 7 so `Math.clz32` (which coerces rc mod
     *  2^32 and would wrap a huge rc to a negative or > 7 band) is NEVER consulted out of the
     *  1..127 domain -> the band is always a valid 0..7 index (fail-closed, the RISK guard). */
    _band(rc) {
        return rc >= MQ_BAND_SAT ? MQ_MAXBAND : (31 - Math.clz32(rc));
    }

    /** Push slot s at the head (MRU) of band q. Up to 3 link writes (non-empty band). */
    _qPushHead(q, s) {
        const h = this._qHead[q];
        this._prev[s] = NIL; this._next[s] = h;
        if (h !== NIL) this._prev[h] = s;
        this._qHead[q] = s; if (this._qTail[q] === NIL) this._qTail[q] = s;
    }

    /** Unlink slot s from band q. Up to 2 link writes for an interior slot; a tail detach is 1. */
    _qDetach(q, s) {
        const p = this._prev[s], n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._qHead[q] = n;
        if (n !== NIL) this._prev[n] = p; else this._qTail[q] = p;
    }

    /** The FIXED m-1 = 7-step aging sweep (D27.6). For each band Q1..Q7 (ASCENDING) demote its
     *  LRU (tail) IF its logical expire time has passed, resetting the demoted block's `_exq` and
     *  placing it at the HEAD (MRU) of the band below. Because a demoted block lands in an
     *  ALREADY-VISITED lower band with a fresh (non-expired) `_exq`, it can NEVER be re-examined
     *  or re-demoted within this sweep -- reset-on-demote forbids cascade, so this is a REAL
     *  constant: at most 7 demotions x <= 4 link writes = <= 28. */
    _ageSweep() {
        const t = this._t, exq = this._exq, tailC = this._qTail;
        for (let q = 1; q < MQ_M; q++) {
            const tail = tailC[q];
            if (tail === NIL) continue;
            if (exq[tail] < t) {              // expired -> demote one band toward Q0
                this._qDetach(q, tail);        // <= 1 link write (tail detach)
                const nq = q - 1;
                this._qn[tail] = nq;           // 1 stamp (its band decays)
                exq[tail] = t + this._capacity; // 1 stamp: reset -> forbids cascade this sweep
                this._qPushHead(nq, tail);     // <= 3 link writes
            }
        }
    }

    // --- the MQ policy core (allocation-free) ---------------------------------

    /** Add a key + its refcount to the bounded Qout history, dropping the OLDEST at the bound
     *  (D27.5). COLD (only the eviction path reaches it). */
    _histAdd(key, rc) {
        if (this._hist._len >= this._histCap) this._hist.delLRU();
        this._hist.addMRU(key, rc);
    }

    /** Free exactly ONE resident slot and return it for in-place reuse (D6-style). The victim is
     *  the LRU (tail) of the LOWEST non-empty queue (D27.4). The evicted key + its refcount enter
     *  the bounded Qout history (D27.5). Sets `_evKey`/`_evVal` for the onEvict fire-after. COLD;
     *  only ever called at capacity (so a non-empty queue always exists). */
    _evictOne() {
        let q = 0;
        while (q < MQ_M && this._qTail[q] === NIL) q++;
        const s = this._qTail[q];
        this._evKey = this._keys[s]; this._evVal = this._vals[s];
        this._qDetach(q, s);
        this._store.delete(this._evKey);
        this._histAdd(this._evKey, this._rc[s]);
        this._rc[s] = 0; this._exq[s] = 0; this._qn[s] = 0; // reset for reuse
        this._size--;
        return s;
    }

    /** The per-access recency + aging step for a RESIDENT slot (get hit / put update). Advances
     *  the logical clock, increments the refcount, re-bands, moves the block to the MRU of its
     *  band (0 link writes when already the MRU of its unchanged band, else at most 5 (4..5)), stamps its
     *  logical expire time, then runs the fixed 7-step aging sweep. Exactly 3 metadata stamps
     *  (`_rc`, `_qn`, `_exq`) on the accessed slot; <= 33 link writes total (D27.6). */
    _access(s) {
        this._t++;
        const rc = ++this._rc[s];              // stamp 1: refcount++
        const q = this._band(rc);
        const oldQ = this._qn[s];
        this._qn[s] = q;                        // stamp 2: (re)band
        this._exq[s] = this._t + this._capacity; // stamp 3: logical expire time
        if (!(oldQ === q && this._qHead[q] === s)) {
            // NOT already the MRU of its unchanged band -> real list surgery (at most 5 (4..5) links):
            this._qDetach(oldQ, s);            // <= 2 link writes
            this._qPushHead(q, s);             // <= 3 link writes
        }
        this._ageSweep();
    }

    // --- public API (all zero-alloc on the hot path) --------------------------

    /** Look up a key AND apply the MQ access policy (refcount++, re-band to MRU, stamp expire,
     *  age). @returns the value, or undefined if absent (see D7). A get never consults Qout (a
     *  missing key is a plain miss). */
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
     * Insert or update. An update rewrites the value and applies the access policy (like a hit).
     * A new key still in the bounded Qout history is re-admitted at its remembered refcount + 1
     * (D27.5); a brand-new key enters at rc = 1 (band Q0). At capacity one resident is evicted
     * first (its slot reused in place); onEvict fires LAST (0002). The positional `ttlMs` (0017)
     * overrides the instance ttl default. Every insert is a reference: it advances the logical
     * clock and runs the aging sweep, exactly like a hit.
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
        const savedRc = inHist ? this._hist.rcOf(key) : 0; // read BEFORE the evict may drop it
        let s;
        let evicted = false;
        if (this._size === this._capacity) {
            s = this._evictOne();             // evict one resident -> reuse its slot; sets _evKey/_evVal
            evicted = true;
        } else {
            s = store.allocSlot();
        }

        if (inHist) this._hist.consume(key);  // it is being re-admitted (resident again)
        this._keys[s] = key;
        this._vals[s] = value;
        if (this._exp !== null) this._exp[s] = expiresAt; // stamp the wall-clock expiry (D17)
        store.set(key, s);

        this._t++;
        const rc = savedRc + 1;               // the insert is a reference (brand-new -> rc 1)
        this._rc[s] = rc;
        const q = this._band(rc);
        this._qn[s] = q;
        this._exq[s] = this._t + this._capacity;
        this._qPushHead(q, s);
        this._size++;
        this._ageSweep();                     // an insert ages like any other reference (D27.6)

        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); 0019

        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (0019)
            const evKey = this._evKey, evVal = this._evVal;
            this._evKey = undefined; this._evVal = undefined; // retention hygiene
            this._inOnEvict = true;
            try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
        }
    }

    /** True if key is present (RESIDENT). Qout keys are NOT present. Policy-NEUTRAL. A stale entry
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

    /** Read a value WITHOUT applying the policy. undefined if absent (see D7). A stale entry is a
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

    /** Unlink a resident slot from its band, dropping the size. Shared by delete + reap; NOT
     *  ghosted (a delete/reap keeps no non-resident metadata, like the family). */
    _unlinkResident(s) {
        this._qDetach(this._qn[s], s);
        this._rc[s] = 0; this._exq[s] = 0; this._qn[s] = 0;
        this._size--;
    }

    /** Reap an expired slot in place (decisions/0017): unlink, drop from the index, free the
     *  slot, and fire onEvict LAST via the 0002 guard. Not ghosted (like delete). */
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

    /** Empty the cache. Rebuilds the free list, empties every queue + the history, and resets the
     *  per-slot state + the logical clock. Allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._qHead.fill(NIL); this._qTail.fill(NIL);
        this._size = 0;
        this._t = 0;
        this._rc.fill(0); this._exq.fill(0); this._qn.fill(0);
        this._hist.clear();
    }

    // --- opt-in runtime stats (decisions/0019, D19): cold accessors -----------

    /** The live stats holder (decisions/0019, D19.3), returned BY REFERENCE (borrowed). Fail
     *  closed on an instance built without { stats: true }. */
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

    /** The per-member iteration ROSTER (decisions/0018 / 0027): the 8 band queues Q7 (highest
     *  frequency) DOWN to Q0, each threaded through the shared `_next` column -- RESIDENT only,
     *  the non-resident Qout history EXCLUDED. Recency-neutral, stale-skipping, fail-closed via
     *  `_ver` -- the shared CacheIterator walks it unchanged. */
    _iterHeads() {
        const h = this._qHead;
        return [h[7], h[6], h[5], h[4], h[3], h[2], h[1], h[0]];
    }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- snapshot / restore (decisions/0021, D21 + 0027): COLD, may allocate --

    /** Serialize to a plain snapshot (decisions/0021, D21 + D27.7): the 8 band queues (each with
     *  values/expiry via the shared snapList), their aligned `_rc`/`_exq` columns, the logical
     *  clock `_t` (as `tick`), and the bounded Qout history (keys + refcounts, oldest..newest).
     *  Dropping the refcounts, the expire times, the clock or the history is a fail-OPEN
     *  future-eviction bug, so all are captured (the t9 controls prove the round-trip catches it). */
    dump() {
        const snap = snapBase(this, "Mq");
        snap.queues = [];
        snap.rc = [];
        snap.exq = [];
        for (let q = 0; q < MQ_M; q++) {
            const list = snapList(this, this._qHead[q], false);
            const rc = [], exq = [];
            for (let i = 0; i < list.slots.length; i++) {
                const s = list.slots[i];
                rc.push(this._rc[s]); exq.push(this._exq[s]);
            }
            snap.queues.push(list); snap.rc.push(rc); snap.exq.push(exq);
        }
        snap.tick = this._t;
        snap.hist = snapArcGhost(this._hist);
        snap.histRc = [];
        if (this._hist._cap > 0 && this._hist._len > 0) {
            const g = this._hist;
            if (g._int) {
                const mask = g._ringMask;
                for (let i = 0; i < g._len; i++) snap.histRc.push(g._rcRing[(g._head + i) & mask]);
            } else {
                for (let i = 0; i < g._len; i++) snap.histRc.push(g._rcRing[(g._head + i) % g._cap]);
            }
        }
        return snap;
    }

    /** Reconstruct a FRESH Mq from a snapshot (decisions/0021, D21 + D27.7). Fail closed on any
     *  tag/shape mismatch; a malformed/mis-aligned rc or exq column; a non-finite rc/exq; a `tick`
     *  that is not a non-negative finite number; a history/histRc length mismatch or over-bound
     *  history. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "Mq", opts);
        const inst = new Mq(cap, snapOpts(snap, opts));

        if (!Array.isArray(snap.queues) || snap.queues.length !== MQ_M) {
            throw new Error(SNAP_BAD + "mq queues must be an array of " + MQ_M + " band lists");
        }
        if (!Array.isArray(snap.rc) || snap.rc.length !== MQ_M ||
            !Array.isArray(snap.exq) || snap.exq.length !== MQ_M) {
            throw new Error(SNAP_BAD + "mq rc/exq must each be an array of " + MQ_M + " aligned columns");
        }
        const pairs = [];
        for (let q = 0; q < MQ_M; q++) pairs.push([snap.queues[q], "q" + q]);
        const occ = snapCheckOccupy(cap, snap.ttl, pairs);

        // Shape the MQ-specific aux columns (fail closed -- "null is not zero").
        const ckCol = (arr, n, label) => {
            if (!Array.isArray(arr) || arr.length !== n) {
                throw new Error(SNAP_BAD + "mq " + label + " must be an array aligned to its queue");
            }
            for (let i = 0; i < n; i++) {
                const x = arr[i];
                if (typeof x !== "number" || !Number.isFinite(x)) {
                    throw new Error(SNAP_BAD + "mq " + label + "[" + i + "] = " + String(x) + " (must be a finite number)");
                }
            }
        };
        for (let q = 0; q < MQ_M; q++) {
            const n = snap.queues[q].slots.length;
            ckCol(snap.rc[q], n, "rc[" + q + "]");
            ckCol(snap.exq[q], n, "exq[" + q + "]");
        }
        if (typeof snap.tick !== "number" || !Number.isFinite(snap.tick) || snap.tick < 0) {
            throw new Error(SNAP_BAD + "mq tick must be a non-negative finite number, got " + String(snap.tick));
        }
        if (!Array.isArray(snap.hist)) throw new Error(SNAP_BAD + "mq history (hist) must be an array");
        if (!Array.isArray(snap.histRc)) throw new Error(SNAP_BAD + "mq history refcounts (histRc) must be an array");
        if (snap.hist.length !== snap.histRc.length) {
            throw new Error(SNAP_BAD + "mq history (" + snap.hist.length + ") and histRc (" + snap.histRc.length + ") length mismatch");
        }
        if (snap.hist.length > cap) {
            throw new Error(SNAP_BAD + "mq history (" + snap.hist.length + ") exceeds capacity (" + cap + ")");
        }

        let total = 0;
        for (let q = 0; q < MQ_M; q++) {
            const list = snap.queues[q];
            const ends = snapRestoreList(inst, list, null, 0);
            for (let i = 0; i < list.slots.length; i++) {
                const s = list.slots[i];
                inst._qn[s] = q;
                inst._rc[s] = snap.rc[q][i];
                inst._exq[s] = snap.exq[q][i];
            }
            inst._qHead[q] = ends.head; inst._qTail[q] = ends.tail;
            total += ends.size;
        }
        inst._size = total;
        inst._t = snap.tick;

        const gInt = typeof inst._store._ck === "function";
        for (let i = 0; i < snap.hist.length; i++) {
            const rc = snap.histRc[i];
            if (typeof rc !== "number" || !Number.isFinite(rc)) {
                throw new Error(SNAP_BAD + "mq histRc[" + i + "] = " + String(rc) + " (must be a finite number)");
            }
            if (gInt) inst._store._ck(snap.hist[i]); // fail closed on a non-int history key
            inst._histAdd(snap.hist[i], rc);
        }

        inst._store.rebuildFreeList(occ);
        return inst;
    }

    // --- test/debug only (never call on a hot path) ---------------------------

    /** Free-stack length, delegated to the store (conservation invariant). */
    _freeListLength() {
        return this._store.freeListLength();
    }

    /** The key the NEXT over-capacity insert would evict, WITHOUT mutating (D27.4): the LRU (tail)
     *  of the lowest non-empty queue. TEST-ONLY (drives the torture differential); never a hot
     *  path. */
    _peekVictim() {
        if (this._size === 0) return undefined;
        let q = 0;
        while (q < MQ_M && this._qTail[q] === NIL) q++;
        return this._keys[this._qTail[q]];
    }
}

/* -------------------------------------------------------------------------- *
 * CarHistory -- the bounded, keys-only ghost list for CAR's B1/B2 (decisions/0028,
 * D28.2). A GENERALIZATION of ArcGhost (exactly like LirsHistory / ClockProHistory /
 * LruKHistory / MqHistory): the SAME open-addressed int ring (strict zero-alloc on
 * keys:'int') / Set + FIFO array (amortized on the Map backing), bounded at construction,
 * drop-oldest / consume-specific. B1 is sized to `capacity` (|T1|+|B1| <= c) and B2 to
 * `2*capacity` (|T2|+|B2| <= 2c). INTERNAL, never exported.
 * -------------------------------------------------------------------------- */

class CarHistory extends ArcGhost {}

/* -------------------------------------------------------------------------- *
 * Car -- CAR, Clock with Adaptive Replacement (Bansal & Modha, USENIX FAST'04),
 * decisions/0028, D28. The THIRTEENTH named export in this file (same single-file ruling
 * as the rest of the family: single main file + sideEffects:false + named exports = the
 * tree-shake moat). CAR completes the CLOCK-approximation trio: SIEVE (CLOCK-ish FIFO),
 * ClockPro (the CLOCK approximation of LIRS), and CAR (the CLOCK reformulation of ARC).
 * It is ARC's exact semantics -- two lists T1 (recent) / T2 (frequent), keys-only ghosts
 * B1/B2, one adaptive integer `p`, no knobs -- realized on ClockPro-style reference-bit
 * clocks instead of ARC's LRU lists, so a HIT sets ONE reference bit and MOVES NOTHING
 * (the Sieve/S3Fifo/ClockPro 0-link-write headline, D28.5) where ARC relinks to T2 MRU.
 *
 * STRUCTURE (all fixed at construction, zero-alloc on the hot path):
 *   - TWO circular clocks T1 (recent) and T2 (frequent) threaded through the shared
 *     `_next`/`_prev` columns (D28.1). Each is realized as a NIL-terminated DLL (`_headTx`
 *     = newest .. `_tailTx` = oldest) whose hand WRAPS (`_advance(_tail) -> _head`) -- the
 *     TRAVERSAL is circular (a clock has no ends), while the NIL terminus lets the member
 *     reuse the family's shared iteration (CacheIterator), conservation (validate's CAR
 *     term) and snapshot (snapList/snapLink) machinery. A slot is in EXACTLY one clock,
 *     tagged by `_st` bit1 (CAR_T2).
 *   - `_st` Uint8: bit0 reference, bit1 inT2 (D28.1). A hit is a single `_st[s] |= CAR_REF`
 *     -- 0 link writes, exactly 1 state store (D28.5, pinned in t6).
 *   - TWO hands `_hT1`/`_hT2` as Int32 slot pointers (D28.1), NIL only when that clock is
 *     empty: the eviction/rotation position in each clock. `_replace()` rotates them.
 *   - `_p` (0..capacity): the ADAPTIVE integer target size for T1 (D28.3). A B1 (recent)
 *     ghost hit RAISES it, a B2 (frequent) ghost hit LOWERS it. O(1) updates, no knobs.
 *   - `_b1`/`_b2` (CarHistory): the two bounded keys-only ghosts (D28.2), B1 sized to c,
 *     B2 to 2c, drop-oldest / consume-on-readmit.
 *
 * `_replace()` (D28.4) is the whole cold cost: from the T1 hand (when |T1| >= max(1,p))
 * or the T2 hand, a REFERENCED page has its reference bit CLEARED and MIGRATES to the T2
 * clock (a T1 survivor) or rotates within T2 (a T2 survivor); the FIRST UNREFERENCED page
 * found is the victim, demoted to B1 (from T1) or B2 (from T2). This is amortized O(1) per
 * miss (classic CLOCK) but WORST-CASE O(capacity) `_st` writes on a full-scan-then-insert
 * (every resident referenced -> the whole clock's reference bits are cleared before a
 * victim is found) -- EXACTLY ClockPro's honest characterization (D28.6). There is NO
 * pinned constant miss+evict bound; the t6 carStream worst-observed scan length is a
 * per-stream regression TRIPWIRE, not a cap. The ref-bit CLEARS live entirely on this
 * miss/evict path, NEVER the hit path (the 0-link-write / 1-`_st`-store hit is real).
 *
 * Fixed-capacity honesty (D28.4, restating Arc D16.2 / ClockPro D25.4): the RESIDENT
 * value capacity is EXACTLY `capacity`; only the T1/T2 split adapts, |T1|+|T2| == size.
 *
 * Rides the shared newStore factory (default Map / opt-in keys:'int' strict-zero), the
 * onEvict fire-after + `_inOnEvict` guard (0002), TTL (0017), zero-GC iteration (0018,
 * order T2 then T1 -- mirrors Arc D16.5), stats (0019), snapshot (0021). A hit is proven
 * zero-alloc + 0-link-write by the t6 gate.
 * -------------------------------------------------------------------------- */

export class Car {
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

        void validateOptions(options);
        this._capacity = capacity;

        // TTL (decisions/0017), validated fail-closed -- identical to the rest of the family.
        this._clock = validateClock(options && options.clock);
        this._ttl = validateTtl(options && options.ttl);

        // Same shared substrate + int-key door as every other member.
        this._store = this._makeStore(capacity, options && options.keys, this._ttl !== undefined, options && options.maxKey);

        // Cache the store's columns so the clock relinks stay direct. `_next` toward the
        // tail (older), `_prev` toward the head (newer); the hands WRAP `_next[tail] -> head`.
        this._keys = this._store._keys;
        this._vals = this._store._vals;
        this._next = this._store._next;
        this._prev = this._store._prev;
        this._exp = this._store._exp;   // ttl expiry column; null when ttl is off (D17)

        // Per-slot state (bit0 reference, bit1 inT2). Member-specific, fixed, never grown.
        this._st = new Uint8Array(capacity);

        // The two clocks, each a NIL-terminated DLL (head = newest .. tail = oldest).
        this._headT1 = NIL; this._tailT1 = NIL; this._t1Size = 0; // T1 (recent) clock
        this._headT2 = NIL; this._tailT2 = NIL; this._t2Size = 0; // T2 (frequent) clock
        this._size = 0;                                           // _t1Size + _t2Size

        // The two clock hands (D28.1), Int32 slot pointers; NIL only when that clock is empty.
        this._hT1 = NIL; // the recent-clock hand
        this._hT2 = NIL; // the frequent-clock hand

        // The adaptive integer target size for T1 (D28.3), 0..capacity. Starts at 0.
        this._p = 0;

        // The two bounded keys-only ghosts (D28.2): B1 sized to c (|T1|+|B1| <= c), B2 to 2c
        // (|T2|+|B2| <= 2c). keys:'int' -> strict zero-alloc; default Map -> amortized.
        this._ghostInt = (options && options.keys) === 'int';
        this._b1 = new CarHistory(capacity, this._ghostInt);
        this._b2 = new CarHistory(2 * capacity, this._ghostInt);

        this._onEvict = validateOnEvict(options && options.onEvict);
        this._inOnEvict = false;

        // Retention hygiene for the onEvict fire-after: declared at construction so the object shape never transitions on first eviction.
        this._evKey = undefined;
        this._evVal = undefined;

        // Opt-in runtime stats (decisions/0019): null when off, a fresh holder when on.
        this._stats = validateStats(options && options.stats);
    }

    /** The store factory, delegating to the shared `newStore` (decisions/0011). */
    _makeStore(capacity, keys, hasTtl, maxKey) {
        return newStore(capacity, keys, hasTtl, maxKey);
    }

    get size() { return this._size; }
    get capacity() { return this._capacity; }

    // --- the two circular clocks (NIL-terminated DLL + wrap-around hand advance) ---

    /** Advance one step around clock T1: toward the tail, wrapping tail -> head. */
    _advanceT1(s) { const n = this._next[s]; return n !== NIL ? n : this._headT1; }
    /** Advance one step around clock T2. */
    _advanceT2(s) { const n = this._next[s]; return n !== NIL ? n : this._headT2; }

    /** The ring successor of `s` in T1 used when `s` is removed: its `_next`, else the head
     *  (wrap), else NIL when `s` is the sole T1 resident. Computed BEFORE the detach. */
    _ringSuccT1(s) { const n = this._next[s]; if (n !== NIL) return n; return this._headT1 === s ? NIL : this._headT1; }
    /** The ring successor of `s` in T2 (as above). */
    _ringSuccT2(s) { const n = this._next[s]; if (n !== NIL) return n; return this._headT2 === s ? NIL : this._headT2; }

    /** Unlink slot s from T1, fixing neighbours + head/tail sentinels + size. */
    _detachT1(s) {
        const p = this._prev[s], n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._headT1 = n;
        if (n !== NIL) this._prev[n] = p; else this._tailT1 = p;
        this._t1Size--;
    }
    /** Unlink slot s from T2. */
    _detachT2(s) {
        const p = this._prev[s], n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._headT2 = n;
        if (n !== NIL) this._prev[n] = p; else this._tailT2 = p;
        this._t2Size--;
    }

    /** Insert slot s at the head (newest / MRU) of T1. Sets the hand when the clock was empty. */
    _pushT1(s) {
        this._prev[s] = NIL; this._next[s] = this._headT1;
        if (this._headT1 !== NIL) this._prev[this._headT1] = s;
        this._headT1 = s;
        if (this._tailT1 === NIL) { this._tailT1 = s; this._hT1 = s; }
        this._t1Size++;
    }
    /** Insert slot s at the head (newest / MRU) of T2. Sets the hand when the clock was empty. */
    _pushT2(s) {
        this._prev[s] = NIL; this._next[s] = this._headT2;
        if (this._headT2 !== NIL) this._prev[this._headT2] = s;
        this._headT2 = s;
        if (this._tailT2 === NIL) { this._tailT2 = s; this._hT2 = s; }
        this._t2Size++;
    }

    /** Remove a resident slot from WHICHEVER clock it is in (per `_st` bit1), repairing the
     *  hand parked on it. Does NOT touch `_st` / the index / the free stack / `_size` (the
     *  caller finishes those). Used by _reap and delete (NOT _replace, which drives its own
     *  hand rotation). */
    _removeResident(s) {
        if (this._st[s] & CAR_T2) {
            const succ = this._ringSuccT2(s);
            if (this._hT2 === s) this._hT2 = succ;
            this._detachT2(s);
        } else {
            const succ = this._ringSuccT1(s);
            if (this._hT1 === s) this._hT1 = succ;
            this._detachT1(s);
        }
    }

    /**
     * REPLACE (decisions/0028, D28.4): evict exactly ONE resident to a ghost and return its
     * (reused-in-place) slot, leaving `_keys[slot]`/`_vals[slot]` intact for the onEvict
     * fire-after. From the T1 hand (when |T1| >= max(1,p)) or the T2 hand: a REFERENCED page
     * has its ref bit CLEARED and MIGRATES to T2 (a T1 survivor) or rotates within T2 (a T2
     * survivor); the first UNREFERENCED page is the victim -> B1 (from T1) or B2 (from T2).
     * Amortized O(1); worst-case O(capacity) ref-bit clears (D28.6). Only called at capacity.
     */
    _replace() {
        const pTarget = this._p > 1 ? this._p : 1; // max(1, p)
        for (;;) {
            // Branch to a clock, defensively total: prefer T1 when |T1| >= max(1,p), but a
            // referenced-only sweep can drain a clock -- always fall back to the non-empty one.
            let takeT1 = this._t1Size >= pTarget;
            if (this._t1Size === 0) takeT1 = false;
            else if (this._t2Size === 0) takeT1 = true;
            if (takeT1) {
                const h = this._hT1;
                if ((this._st[h] & CAR_REF) === 0) {
                    // unreferenced T1 head -> the victim, demoted to B1.
                    const key = this._keys[h];
                    this._hT1 = this._ringSuccT1(h);
                    this._detachT1(h);
                    this._store.delete(key);
                    this._b1.addMRU(key);
                    this._st[h] = 0;
                    return h;
                }
                // referenced T1 head -> clear ref, migrate to T2 MRU, advance the hand.
                const succ = this._ringSuccT1(h);
                this._detachT1(h);
                this._hT1 = succ;
                this._st[h] = CAR_T2; // ref cleared, now in the frequent clock
                this._pushT2(h);
                continue;
            }
            const h = this._hT2;
            if ((this._st[h] & CAR_REF) === 0) {
                // unreferenced T2 head -> the victim, demoted to B2.
                const key = this._keys[h];
                this._hT2 = this._ringSuccT2(h);
                this._detachT2(h);
                this._store.delete(key);
                this._b2.addMRU(key);
                this._st[h] = 0;
                return h;
            }
            // referenced T2 head -> clear ref, rotate within T2 (advance the hand).
            this._st[h] &= ~CAR_REF;
            this._hT2 = this._advanceT2(h);
        }
    }

    // --- public API (all zero-alloc on the hot path) --------------------------

    /** Look up a key AND set its reference bit (CAR's second-chance flag). The whole hot
     *  path is a single `_st` store -- 0 link writes (D28.5). @returns the value, or
     *  undefined if absent (see D7). A get never consults the ghosts. */
    get(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const s = this._store.get(key);
        if (s < 0) { if (this._stats !== null) this._stats.misses++; return undefined; } // miss (0019)
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (this._stats !== null) this._stats.misses++; // stale = miss (+ evict via _reap; D19.2)
            this._reap(s);
            return undefined;
        }
        this._st[s] |= CAR_REF; // the whole hot path: one state store, no relink
        if (this._stats !== null) this._stats.hits++; // live hit (0019)
        return this._vals[s];
    }

    /**
     * Insert or update. An update rewrites the value and sets the reference bit (like a hit,
     * D28.5). A true miss enters T1 (recent, ref 0). A miss whose key is in B1 raises `p` and
     * re-admits into T2; in B2 lowers `p` and re-admits into T2 (D28.3). At capacity one
     * resident is evicted first via REPLACE (its slot reused in place) and the ghost directory
     * is trimmed (D28.4). onEvict fires LAST (0002). The positional `ttlMs` (0017) overrides
     * the ttl default.
     */
    put(key, value, ttlMs) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        let expiresAt;
        if (this._exp !== null) expiresAt = expiryFor(this._clock, this._ttl, ttlMs);
        else if (ttlMs !== undefined) throw new Error(TTL_NO_COLUMN_MSG); // fail closed (D17.4)
        this._store._ver++; // D18.6 -- put mutates; invalidate iterators
        const store = this._store;
        const existing = store.get(key);
        if (existing >= 0) {                  // update-in-place + set the reference bit
            this._vals[existing] = value;
            if (this._exp !== null) this._exp[existing] = expiresAt; // restamp (D17)
            this._st[existing] |= CAR_REF;
            if (this._stats !== null) this._stats.puts++; // successful update (outcome-based); 0019
            return;
        }

        const c = this._capacity;
        const inB1 = this._b1.has(key);
        const inB2 = inB1 ? false : this._b2.has(key);
        const inGhost = inB1 || inB2;
        let s, evKey, evVal;
        let evicted = false;

        if (this._size === c) {
            s = this._replace();                 // evict one resident -> reuse its slot
            evKey = this._keys[s]; evVal = this._vals[s];
            evicted = true;
            // directory replacement (D28.4): trim a ghost when a new (non-ghost) directory
            // entry is about to be added and the bounds are tight.
            if (!inGhost) {
                if (this._t1Size + this._b1._len === c && this._b1._len > 0) this._b1.delLRU();
                else if (this._t1Size + this._t2Size + this._b1._len + this._b2._len === 2 * c && this._b2._len > 0) this._b2.delLRU();
            }
        } else {
            // below capacity (delete-induced): preserve the SAME directory bounds before a new
            // (non-ghost) T1 entry grows the directory.
            if (!inGhost) {
                if (this._t1Size + this._b1._len === c && this._b1._len > 0) this._b1.delLRU();
                else if (this._t1Size + this._t2Size + this._b1._len + this._b2._len === 2 * c && this._b2._len > 0) this._b2.delLRU();
            }
            s = store.allocSlot();
        }

        this._keys[s] = key; this._vals[s] = value;
        if (this._exp !== null) this._exp[s] = expiresAt;
        store.set(key, s);

        if (inB1) {
            const b1 = this._b1._len, b2 = this._b2._len; // b1 >= 1 (key still in B1)
            let d = Math.floor(b2 / b1); if (d < 1) d = 1;
            this._p += d; if (this._p > c) this._p = c;   // recency ghost hit -> raise p (D28.3)
            this._b1.consume(key);
            this._st[s] = CAR_T2; this._pushT2(s);        // re-admit into T2, ref 0
        } else if (inB2) {
            const b1 = this._b1._len, b2 = this._b2._len; // b2 >= 1 (key still in B2)
            let d = Math.floor(b1 / b2); if (d < 1) d = 1;
            this._p -= d; if (this._p < 0) this._p = 0;    // frequency ghost hit -> lower p (D28.3)
            this._b2.consume(key);
            this._st[s] = CAR_T2; this._pushT2(s);        // re-admit into T2, ref 0
        } else {
            this._st[s] = 0; this._pushT1(s);             // true miss -> T1 (recent), ref 0
        }

        this._size = this._t1Size + this._t2Size;
        if (this._stats !== null) this._stats.puts++; // successful insert (outcome-based); 0019

        if (evicted) {
            if (this._stats !== null) this._stats.evictions++; // capacity eviction (0019)
            this._inOnEvict = true;
            try { this._onEvict(evKey, evVal); } finally { this._inOnEvict = false; }
        }
    }

    /** True if key is present (RESIDENT). Ghost keys are NOT present. Reference-NEUTRAL. A
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

    /** Read a value WITHOUT setting the reference bit. undefined if absent (see D7). A stale
     *  entry is a MISS and is reaped in place (decisions/0017, D17.3). */
    peek(key) {
        const s = this._store.get(key);
        if (s < 0) return undefined;
        if (this._exp !== null && this._exp[s] <= this._clock()) {
            if (!this._inOnEvict) this._reap(s);
            return undefined;
        }
        return this._vals[s];
    }

    /** Reap an expired slot in place (decisions/0017): repair the hand, unlink from its clock,
     *  drop from the index, free the slot, and fire onEvict LAST via the 0002 guard. A reap is
     *  NOT a capacity victim, so it is never recorded in a ghost and never moves `p` (like
     *  delete). */
    _reap(s) {
        this._store._ver++; // D18.6 -- a reap is a structural mutation; invalidate iterators
        const evKey = this._keys[s];
        const evVal = this._vals[s];
        this._removeResident(s);
        this._store.delete(evKey);
        this._st[s] = 0;
        this._store.freeSlot(s);
        this._size = this._t1Size + this._t2Size;
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

    /** Remove a key. Returns true if it was present. Frees the slot; NOT recorded in a ghost
     *  and never moves `p`. */
    delete(key) {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        const store = this._store;
        const s = store.get(key);
        if (s < 0) return false;
        store._ver++; // D18.6 -- a real delete is a structural mutation; invalidate iterators
        this._removeResident(s);
        store.delete(key);
        this._st[s] = 0;
        store.freeSlot(s);
        this._size = this._t1Size + this._t2Size;
        return true;
    }

    /** Empty the cache. Rebuilds the free list, empties both clocks + both ghosts, resets the
     *  hands, the counts and `p`. Allocates nothing. O(capacity). */
    clear() {
        if (this._inOnEvict) throw new Error(REENTRANT_MSG); // reentrancy: decisions/0002
        this._store._ver++; // D18.6 -- clear is a structural mutation; invalidate iterators
        this._store.reset();
        this._headT1 = NIL; this._tailT1 = NIL; this._t1Size = 0;
        this._headT2 = NIL; this._tailT2 = NIL; this._t2Size = 0;
        this._hT1 = NIL; this._hT2 = NIL;
        this._size = 0;
        this._p = 0;
        this._st.fill(0);
        this._b1.clear();
        this._b2.clear();
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

    /** The per-member iteration ROSTER (decisions/0018 / 0028): T2 (frequent, MRU->LRU) THEN
     *  T1 (recent, MRU->LRU) -- mirrors Arc's D16.5. Two clocks concatenated, RESIDENT only;
     *  the keys-only B1/B2 ghosts are EXCLUDED. NOT global recency order. */
    _iterHeads() { return [this._headT2, this._headT1]; }

    keys() { return iterKeys(this); }
    values() { return iterValues(this); }
    entries() { return iterEntries(this); }
    [Symbol.iterator]() { return iterEntries(this); }

    // --- snapshot / restore (decisions/0021, D21 + 0028): COLD, may allocate --

    /** Serialize to a plain snapshot (decisions/0021, D21 + D28.6): the T2 + T1 clocks (each
     *  newest..oldest, values/expiry) + each page's per-slot `_st` byte, the TWO hand
     *  positions, the adaptive `p`, AND BOTH keys-only ghosts B1/B2 (each oldest..newest).
     *  Dropping the hands, `p`, the reference bits or a ghost is a fail-OPEN future-eviction
     *  bug, so ALL are captured (the t9 controls prove the round-trip catches it). */
    dump() {
        const snap = snapBase(this, "Car");
        snap.t2 = snapList(this, this._headT2, false);
        snap.t1 = snapList(this, this._headT1, false);
        const st2 = []; for (let i = 0; i < snap.t2.slots.length; i++) st2.push(this._st[snap.t2.slots[i]]);
        const st1 = []; for (let i = 0; i < snap.t1.slots.length; i++) st1.push(this._st[snap.t1.slots[i]]);
        snap.st2 = st2;
        snap.st1 = st1;
        snap.hT1 = this._hT1;
        snap.hT2 = this._hT2;
        snap.p = this._p;
        snap.b1 = snapArcGhost(this._b1);
        snap.b2 = snapArcGhost(this._b2);
        return snap;
    }

    /** Reconstruct a FRESH Car from a snapshot (decisions/0021, D21 + D28.6). Fail closed on
     *  any tag/shape mismatch, a malformed/short `st1`/`st2` column, a `_st` byte that is not a
     *  valid 2-bit tag (0..3) or whose inT2 bit disagrees with the list it was captured in, a
     *  `p` out of [0,cap], a hand that does not reference a resident slot of its clock (or is
     *  set on an empty clock), or a ghost that would break a conservation bound. */
    static restore(snap, opts) {
        const cap = snapRead(snap, "Car", opts);
        const inst = new Car(cap, snapOpts(snap, opts));
        const occ = snapCheckOccupy(cap, snap.ttl, [[snap.t2, "t2"], [snap.t1, "t1"]]);
        // Shape the CAR-specific aux (fail closed -- "null is not zero").
        if (!Array.isArray(snap.st2) || snap.st2.length !== snap.t2.slots.length) {
            throw new Error(SNAP_BAD + "car st2 must be an array aligned to the T2 list");
        }
        if (!Array.isArray(snap.st1) || snap.st1.length !== snap.t1.slots.length) {
            throw new Error(SNAP_BAD + "car st1 must be an array aligned to the T1 list");
        }
        for (let i = 0; i < snap.st2.length; i++) {
            const b = snap.st2[i];
            if (!Number.isInteger(b) || b < 0 || b > 3) {
                throw new Error(SNAP_BAD + "car st2[" + i + "] = " + String(b) + " (must be an integer 0..3)");
            }
            if ((b & CAR_T2) === 0) throw new Error(SNAP_BAD + "car st2[" + i + "] is missing the inT2 bit");
        }
        for (let i = 0; i < snap.st1.length; i++) {
            const b = snap.st1[i];
            if (!Number.isInteger(b) || b < 0 || b > 3) {
                throw new Error(SNAP_BAD + "car st1[" + i + "] = " + String(b) + " (must be an integer 0..3)");
            }
            if (b & CAR_T2) throw new Error(SNAP_BAD + "car st1[" + i + "] carries the inT2 bit");
        }
        if (!Number.isInteger(snap.p) || snap.p < 0 || snap.p > cap) {
            throw new Error(SNAP_BAD + "car p out of [0," + cap + "]: " + String(snap.p));
        }
        if (!Array.isArray(snap.b1) || !Array.isArray(snap.b2)) {
            throw new Error(SNAP_BAD + "car snapshot missing a ghost array (b1/b2)");
        }
        if (snap.t1.slots.length + snap.b1.length > cap) {
            throw new Error(SNAP_BAD + "car |T1|+|B1| (" + (snap.t1.slots.length + snap.b1.length) + ") exceeds capacity (" + cap + ")");
        }
        if (snap.t1.slots.length + snap.t2.slots.length + snap.b1.length + snap.b2.length > 2 * cap) {
            throw new Error(SNAP_BAD + "car directory total exceeds 2*capacity (" + (2 * cap) + ")");
        }

        const T2 = snapRestoreList(inst, snap.t2, null, 0);
        inst._headT2 = T2.head; inst._tailT2 = T2.tail; inst._t2Size = T2.size;
        for (let i = 0; i < snap.t2.slots.length; i++) inst._st[snap.t2.slots[i]] = snap.st2[i];
        const T1 = snapRestoreList(inst, snap.t1, null, 0);
        inst._headT1 = T1.head; inst._tailT1 = T1.tail; inst._t1Size = T1.size;
        for (let i = 0; i < snap.t1.slots.length; i++) inst._st[snap.t1.slots[i]] = snap.st1[i];
        inst._size = inst._t1Size + inst._t2Size;
        inst._p = snap.p;

        // The two hands: NIL iff that clock is empty, else a resident slot of that clock.
        if (inst._t1Size === 0) {
            if (snap.hT1 !== NIL) throw new Error(SNAP_BAD + "car hT1 set on an empty T1 clock");
        } else if (!Number.isInteger(snap.hT1) || snap.hT1 < 0 || snap.hT1 >= cap || occ[snap.hT1] === 0 || (inst._st[snap.hT1] & CAR_T2)) {
            throw new Error(SNAP_BAD + "car hT1 " + String(snap.hT1) + " does not reference a resident T1 slot");
        }
        if (inst._t2Size === 0) {
            if (snap.hT2 !== NIL) throw new Error(SNAP_BAD + "car hT2 set on an empty T2 clock");
        } else if (!Number.isInteger(snap.hT2) || snap.hT2 < 0 || snap.hT2 >= cap || occ[snap.hT2] === 0 || (inst._st[snap.hT2] & CAR_T2) === 0) {
            throw new Error(SNAP_BAD + "car hT2 " + String(snap.hT2) + " does not reference a resident T2 slot");
        }
        inst._hT1 = snap.hT1;
        inst._hT2 = snap.hT2;

        const gInt = typeof inst._store._ck === "function";
        for (let i = 0; i < snap.b1.length; i++) {
            if (gInt) inst._store._ck(snap.b1[i]); // fail closed on a non-int ghost key
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
     * The key the NEXT over-capacity insert would evict, computed WITHOUT mutating any link,
     * bit, hand, count or `p` (the non-destructive twin of `_replace`). It builds local slot
     * arrays for the two clocks (T2/T1 head..tail), clones the reference bits, records the
     * hand indices, then replays the EXACT `_replace` sweep (referenced T1 pages migrate to
     * T2, referenced T2 pages rotate, the first unreferenced page found is the victim).
     * TEST-ONLY (drives the torture differential); it MAY allocate precisely because it is
     * never a hot or measured path.
     */
    _peekVictim() {
        if (this._size === 0) return undefined;
        // Build arrays: index 0 = head (MRU) .. last = tail (LRU); ref bit per element.
        const l1 = [], r1 = [], l2 = [], r2 = [];
        let h1 = -1, h2 = -1;
        for (let s = this._headT1; s !== NIL; s = this._next[s]) { if (s === this._hT1) h1 = l1.length; l1.push(s); r1.push(this._st[s] & CAR_REF); }
        for (let s = this._headT2; s !== NIL; s = this._next[s]) { if (s === this._hT2) h2 = l2.length; l2.push(s); r2.push(this._st[s] & CAR_REF); }
        const keys = this._keys;
        const pTarget = this._p > 1 ? this._p : 1;
        // succ index after removing element `h` from an array of length `len` when the hand was AT h.
        const succAfter = (len, h) => (len === 1 ? -1 : (h === len - 1 ? 0 : h));
        for (;;) {
            let takeT1 = l1.length >= pTarget;
            if (l1.length === 0) takeT1 = false;
            else if (l2.length === 0) takeT1 = true;
            if (takeT1) {
                if (r1[h1] === 0) return keys[l1[h1]];
                // migrate l1[h1] to l2 MRU (front); advance the hand.
                const succ = succAfter(l1.length, h1);
                const slot = l1.splice(h1, 1)[0];
                r1.splice(h1, 1);
                h1 = succ;
                l2.unshift(slot); r2.unshift(0);
                if (h2 >= 0) h2++;
                if (l2.length === 1) h2 = 0;
                continue;
            }
            if (r2[h2] === 0) return keys[l2[h2]];
            r2[h2] = 0;
            h2 = (h2 + 1) % l2.length;
        }
    }
}

export default LiteLru;
