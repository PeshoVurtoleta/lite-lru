/**
 * @zakkster/lite-lru -- ambient type surface.
 *
 * Hand-written to mirror EXACTLY the runtime exports of Lru.js. It carries no
 * version literal beyond declaring `VERSION`; the three-place version sync
 * (package.json / Lru.js VERSION / llms.txt) is enforced elsewhere, and
 * test/dts-drift.test.js keeps this file's export set and public class surface in
 * lock-step with Lru.js. ASCII-only.
 *
 * FAMILY CONTRACT (ROADMAP moat-pillar 1). `LiteCache<K, V>` is the uniform
 * surface EVERY member of the family implements. `LiteLru` is the reference
 * member; further members (`Sieve`, `S3Fifo`, ...) are each a
 * `class X<K, V> implements LiteCache<K, V>`, so a caller can swap
 * `new LiteLru(n)` for `new Sieve(n)` or `new S3Fifo(n)` and stay type-checked --
 * the policy difference (recency / admission / frequency) is INTERNAL, never in the
 * surface.
 *
 * @license MIT
 */

/**
 * Opt-in runtime counters (decisions/0019, D19), exposed by `stats()` on a cache
 * constructed with `{ stats: true }`. Four EXACT integers (plain JS numbers, exact to
 * 2^53 -- D19.4):
 *   - `hits`      -- a `get(key)` that found a LIVE resident entry.
 *   - `misses`    -- a `get(key)` that did not (absent, OR stale under TTL).
 *   - `evictions` -- an entry removed by the policy: a capacity eviction on `put`, or a
 *     stale reap. `has`/`peek` are hit/miss-NEUTRAL but a stale `has`/`peek` still reaps,
 *     which IS an eviction (D19.2).
 *   - `puts`      -- every `put(...)` call (insert OR update).
 */
export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  puts: number;
}

/**
 * A plain, structurally-cloneable snapshot of a cache (decisions/0021, D21), produced
 * by `dump()` and consumed by the static `restore()`. It is a plain object graph --
 * plain arrays + plain numbers/values, NO typed-array views -- so it round-trips through
 * `structuredClone` (and, for JSON-safe keys/values, through JSON). The shape is
 * member-specific; the shared, fail-closed tag is always present:
 *
 *   - `f`    -- the format tag, `"litelru/1"`. `restore()` rejects any other value.
 *   - `m`    -- the member name (`"LiteLru"` | `"Sieve"` | ...). A mismatch fails closed.
 *   - `cap`  -- the capacity the snapshot was taken at (drives the restored capacity).
 *   - `keys` -- the keyed-index backing: `"int"` or `null`.
 *   - `ttl`  -- whether an expiry column was present.
 *   - `t`    -- capture time in ms (D21: TTL expiries are captured VERBATIM, absolute).
 *
 * Treat it as opaque: do not hand-edit it. `restore()` validates every field and throws
 * a `[lite-lru]`-tagged Error on any corruption (null is not zero).
 */
export interface CacheSnapshot {
  f: "litelru/1";
  m: string;
  cap: number;
  keys: "int" | "dense" | null;
  ttl: boolean;
  t: number;
  /** Present ONLY on a `keys: "dense"` snapshot (decisions/0029): the dense domain
   *  upper bound `maxKey`, so `restore()` rebuilds the `[0, mk]` index at the right size. */
  mk?: number;
  [field: string]: unknown;
}

/**
 * The uniform cache surface shared by every member of the lite-lru family.
 *
 * Semantics are identical across members; only the INTERNAL eviction policy
 * differs. Two contracts cannot be expressed in the type system and are stated
 * here (they hold for every implementor):
 *
 * (D7) UNDEFINED-VALUE AMBIGUITY. `get(key)` and `peek(key)` return
 *   `V | undefined`, where `undefined` means EITHER "key is absent" OR "the
 *   stored value is literally `undefined`". These two cases are indistinguishable
 *   through the return value alone. To disambiguate, call `has(key)` (presence
 *   without touching recency) or `peek(key)` alongside it. `null` is a normal,
 *   distinguishable value; only `undefined` collides with the miss sentinel.
 */
export interface LiteCache<K, V> extends Iterable<[K, V]> {
  /**
   * Look up a key AND mark it most-recently-used (per the member's policy).
   * @returns the stored value, or `undefined` on a miss. See D7 above: a stored
   *          `undefined` is indistinguishable from a miss via `get` -- use `has`.
   */
  get(key: K): V | undefined;
  /**
   * Insert or update. At capacity a new key evicts the policy's victim first
   * (firing `onEvict`).
   *
   * (D17) OPTIONAL TTL. The positional `ttlMs` overrides the instance `ttl` default
   * for THIS entry (decisions/0017): a positive number of ms, `Infinity` for
   * never-expire, or omitted for the default. Passing `ttlMs` on a cache constructed
   * WITHOUT a `ttl` option throws a `[lite-lru]`-tagged Error (fail-closed); a
   * `<= 0` / `NaN` `ttlMs` throws a RangeError. TTL is LAZY: an entry expires on the
   * next `get`/`has`/`peek` that touches it (a stale touch is a MISS + reap), never on
   * a timer.
   */
  put(key: K, value: V, ttlMs?: number): void;
  /** True if the key is present. Does NOT change recency. A stale entry (TTL) is a
   *  MISS and is reaped in place. */
  has(key: K): boolean;
  /**
   * Read a value WITHOUT changing recency.
   * @returns the value, or `undefined` on a miss (see D7 -- pair with `has`). A stale
   *          entry (TTL) is a MISS and is reaped in place.
   */
  peek(key: K): V | undefined;
  /** Remove a key. @returns true if it was present. */
  delete(key: K): boolean;
  /** Empty the cache. Allocates nothing. */
  clear(): void;
  /**
   * Evict every currently-expired resident entry now (decisions/0017, D17.5). COLD,
   * O(size); fires `onEvict` per victim. @returns the number of entries evicted (0 on
   * a cache with no `ttl` configured).
   */
  purgeStale(): number;
  /**
   * The live runtime counters (decisions/0019, D19). Requires the cache to have been
   * constructed with `{ stats: true }`; on an instance without stats this throws a
   * `[lite-lru]`-tagged Error (fail-closed -- null is not zero, D19.5).
   *
   * BORROWED HOLDER (D19.3): the returned object is the live, per-instance holder BY
   * REFERENCE, NOT a snapshot -- its counters keep advancing as the cache is used, and
   * `resetStats()` zeroes THIS SAME object in place. Copy what you keep for a
   * point-in-time snapshot: `const snap = { ...cache.stats() }`. The holder identity is
   * stable for the lifetime of the instance.
   */
  stats(): CacheStats;
  /**
   * Zero the four runtime counters IN PLACE (decisions/0019, D19.3), so a previously
   * borrowed `stats()` holder stays valid and reads back zeros. Requires `{ stats: true }`;
   * throws a `[lite-lru]`-tagged Error on an instance without stats (fail-closed).
   */
  resetStats(): void;
  /**
   * Serialize this cache to a plain, structurally-cloneable snapshot (decisions/0021,
   * D21). COLD -- never a hot path -- and MAY allocate (an honest <= 96 B/entry budget;
   * there is no zero-GC claim on `dump()`). The result is a plain object graph (plain
   * arrays + plain numbers/values, no typed-array views), tagged with the member, the
   * capacity, the keyed-index backing, whether ttl was on, and the capture time.
   *
   * It captures ENOUGH to make a restored cache decide FUTURE evictions identically to
   * an un-snapshotted twin fed the same trace: every member's resident order + values,
   * plus its aux state (Sieve's hand + visited bits; S3Fifo/TwoQ's keys-only ghost;
   * W-TinyLFU's Count-Min sketch; Arc's adaptive `p` and both ghosts). Under `ttl` the
   * per-entry expiries are captured VERBATIM (absolute ms deadlines, NOT rebased).
   *
   * Restore with the static `restore()` on the SAME member class. A walk in progress is
   * unaffected -- `dump()` is read-only and does not invalidate a live iterator.
   */
  dump(): CacheSnapshot;
  /**
   * Iterate the keys in the member's iteration order (decisions/0018, D18). Zero-GC
   * per step: a hand-written iterator, no generator. The walk is recency-neutral (no
   * promote / visited / sketch / segment change -- like `peek`) and, under `ttl`,
   * SKIPS stale entries without reaping them (`size` is unchanged by a walk). Order is
   * per-member (only `LiteLru` is true recency); see each class for its order. Fail
   * closed: a structural mutation (put/delete/clear/evict/reap) mid-walk makes the
   * next step throw a `[lite-lru]`-tagged Error.
   */
  keys(): IterableIterator<K>;
  /** Iterate the values in iteration order (decisions/0018). Same contract as `keys`. */
  values(): IterableIterator<V>;
  /**
   * Iterate `[key, value]` pairs in iteration order (decisions/0018). CAVEAT: the
   * yielded 2-element tuple is BORROWED and reused across steps -- read it (or copy it)
   * before the next step. ONLY a copying map materializes:
   * `Array.from(cache.entries(), ([k, v]) => [k, v])` or a manual per-step copy. A plain
   * `[...cache.entries()]` / `Array.from(cache)` with no map fn collects N refs to the
   * one reused tuple, which the completed walk nulls -- every element reads
   * `[undefined, undefined]`. `keys()`/`values()` yield scalars, so their spreads are safe.
   */
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol: identical to `entries()` (matches `Map`). Same borrowed-tuple
   *  caveat as `entries()`. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  /** Current entry count (0 .. capacity). */
  readonly size: number;
  /** Fixed maximum entry count, set at construction. */
  readonly capacity: number;
}

/**
 * Construction options shared by every family member.
 */
export interface LiteCacheOptions<K, V> {
  /**
   * Called once per eviction with the evicted `(key, value)` -- e.g. to return
   * the value to a pool. Zero-GC: keep it a hoisted function, not a per-put
   * closure.
   *
   * REENTRANCY CONTRACT (decisions/0002, amends D8) -- types cannot express it:
   *   - The callback MUST NOT call `put`/`get`/`delete`/`clear` on the SAME
   *     instance; doing so THROWS a `[lite-lru]`-tagged Error (fail-closed). This
   *     prevents unbounded evict -> put -> evict recursion and mid-surgery
   *     corruption.
   *   - `has` and `peek` ARE allowed from within the callback (they cannot mutate
   *     the structure) -- they are the sanctioned way to inspect the cache here.
   *   - It fires LAST, AFTER the cache is fully consistent: the newcomer is
   *     already inserted and the victim already gone (`size === capacity`).
   */
  onEvict?: (key: K, value: V) => void;
  /**
   * Keyed-index backing, chosen ONCE at construction (decisions/0011, D11).
   *   - omitted (default): a JS `Map` -- arbitrary keys, honestly AMORTIZED (its
   *     internal resize can allocate); byte-identical to v0.1.0.
   *   - `"int"`: an open-addressed typed-array index for STRICT zero-alloc (even
   *     the keyed index never allocates). Keys MUST be 32-bit signed integers
   *     ([-2147483648, 2147483647]); a non-integer or out-of-range key throws a
   *     `[lite-lru]`-tagged `TypeError` (fail-closed; decisions/0011). Values
   *     remain arbitrary.
   *   - `"dense"`: a DIRECT-MAPPED, generation-stamped typed-array index for STRICT
   *     zero-alloc over a SMALL, DENSE integer key domain (decisions/0029). The hot
   *     body is a single array read (no hash, no probe): `_gen[k] === _epoch`. Keys
   *     MUST be integers in `[0, maxKey]`; out-of-range/non-integer keys throw a
   *     `[lite-lru]`-tagged `TypeError` (fail-closed). Space is O(maxKey), NOT
   *     O(entries) -- the honest co-headline; `clear()` is O(1) via an epoch bump.
   *     REQUIRES `maxKey`. Use `"int"` for large/sparse integer domains instead.
   */
  keys?: "int" | "dense";
  /**
   * REQUIRED with `keys: "dense"` (decisions/0029): the inclusive upper bound of the
   * dense integer key domain `[0, maxKey]`. Must be an integer in `[0, 2147483647]`;
   * an absent/out-of-range value throws a `[lite-lru]`-tagged `TypeError` (fail-closed).
   * Ignored by the `Map` and `"int"` backings.
   */
  maxKey?: number;
  /**
   * Opt-in TTL default in ms (decisions/0017, D17). PAY-FOR-WHAT-YOU-USE: supplying
   * `ttl` allocates one fixed `Float64Array` expiry column (8 bytes/slot); omitting it
   * keeps the ttl-OFF hot path byte-identical (no column, no per-op check that fires).
   * Must be a POSITIVE FINITE number, or `Infinity` for a never-expire default;
   * `<= 0` / `NaN` throw a `[lite-lru]` RangeError (fail-closed). Per-entry overrides
   * go through `put(key, value, ttlMs)`. TTL is LAZY: expiry happens on the next
   * `get`/`has`/`peek` touch (a stale touch is a MISS + reap), never on a timer -- no
   * timers, no async, no background sweep.
   */
  ttl?: number;
  /**
   * Injectable clock (decisions/0017, D17.2): a hoisted zero-arg function returning the
   * current time in ms. Defaults to `Date.now`. Only meaningful alongside `ttl`; a
   * non-function value throws a `[lite-lru]` TypeError (fail-closed). Keep it a hoisted
   * function, not a per-call closure (zero-GC).
   */
  clock?: () => number;
  /**
   * Opt-in runtime stats (decisions/0019, D19). PAY-FOR-WHAT-YOU-USE, mirroring `ttl`:
   * `true` mints a fresh per-instance counter holder and enables `stats()`/`resetStats()`;
   * omitting it keeps the stats-OFF hot path byte-identical (no holder, no counter writes
   * -- `_stats === null`). Any value OTHER than `true` (or omitted) throws a
   * `[lite-lru]`-tagged TypeError with a did-you-mean hint (fail-closed, D19.5).
   */
  stats?: true;
}

/**
 * A fixed-capacity Least-Recently-Used cache with O(1) get/put/has/peek/delete
 * over a preallocated intrusive doubly-linked list (Map + SoA slot columns).
 * The reference member of the family and the implementation of `LiteCache`.
 *
 * `get` and `put` promote to most-recently-used; `has` and `peek` do not touch
 * recency. See `LiteCache` for the D7 undefined-value contract and
 * `LiteCacheOptions.onEvict` for the reentrancy contract -- both hold here.
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class LiteLru<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /**
   * Reconstruct a FRESH `LiteLru` from a `dump()` snapshot (decisions/0021, D21). The
   * backing, capacity and ttl-presence come FROM the snapshot; `opts` re-derives the
   * cold construction options NOT encoded in it -- `onEvict`, `clock`, `stats` (a
   * restored instance starts with fresh zeroed stats) -- and MUST supply the `ttl`
   * default when the snapshot has ttl on (the future default is not encoded). Fail
   * closed: a wrong member/format tag, a capacity/keys/ttl conflict, a corrupt or short
   * field, or more entries than capacity all throw a `[lite-lru]`-tagged Error.
   */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): LiteLru<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * A fixed-capacity SIEVE cache with O(1) amortized get/put/has/peek/delete over a
 * preallocated intrusive FIFO ring (decisions/0012). The first modern eviction-
 * policy member of the family and an implementation of `LiteCache`.
 *
 * SIEVE (Zhang et al., NSDI'24) is lazy-promotion FIFO: `get` and `put(update)`
 * set a per-entry VISITED bit and do NOTHING structural (zero relinks -- the
 * headline); at capacity a moving hand sweeps FIFO order, grants each visited
 * entry a single second chance, and evicts the first unvisited entry in place.
 * `has` and `peek` are visited-neutral. Same `LiteCache` surface as `LiteLru`, so
 * `new LiteLru(n)` swaps for `new Sieve(n)` and stays type-checked -- the policy
 * difference is INTERNAL, never in the surface.
 *
 * See `LiteCache` for the D7 undefined-value contract and `LiteCacheOptions.onEvict`
 * for the reentrancy contract -- both hold here. The optional `keys: 'int'` backing
 * (decisions/0011) applies identically: 32-bit signed integer keys, strict zero-GC.
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class Sieve<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `Sieve` from a `dump()` snapshot (decisions/0021). Backing/
   *  capacity/ttl-presence come from the snapshot; `opts` re-derives onEvict/clock/stats
   *  and supplies the ttl default when ttl is on. Fail closed on any mismatch. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): Sieve<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * A fixed-capacity S3-FIFO cache with O(1) amortized get/put/has/peek/delete over
 * two preallocated intrusive FIFO rings plus a bounded keys-only ghost queue
 * (decisions/0013). The admission-controlled member of the family and an
 * implementation of `LiteCache`.
 *
 * S3-FIFO (Yang et al., SOSP'23) is quick-demotion + lazy-promotion: newcomers
 * enter a small probation FIFO; `get` and `put(update)` set a per-entry VISITED bit
 * and do NOTHING structural (zero relinks -- the headline). At capacity the small
 * queue's oldest entry either GRADUATES to the main FIFO (if proven, i.e. visited)
 * or is evicted with its key remembered in a ghost queue; a key seen again while in
 * ghost is admitted straight to main. A distinct one-hit-wonder never displaces the
 * proven-hot set -- scan-resistant. `has` and `peek` are visited-neutral. Same
 * `LiteCache` surface as `LiteLru`, so `new LiteLru(n)` swaps for `new S3Fifo(n)`
 * and stays type-checked -- the policy difference is INTERNAL, never in the surface.
 *
 * See `LiteCache` for the D7 undefined-value contract and `LiteCacheOptions.onEvict`
 * for the reentrancy contract -- both hold here. The optional `keys: 'int'` backing
 * (decisions/0011) applies identically: 32-bit signed integer keys, strict zero-GC
 * (including the int ghost ring + membership table).
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class S3Fifo<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `S3Fifo` from a `dump()` snapshot (decisions/0021), incl. the
   *  keys-only ghost (dropping it is a fail-OPEN admission bug). Fail closed on any mismatch. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): S3Fifo<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * A fixed-capacity W-TinyLFU cache with O(1) amortized get/put/has/peek/delete over a
 * small admission WINDOW (an LRU) in front of a segmented main cache (SLRU: a
 * PROBATION segment + a PROTECTED segment), gated by a fixed count-min frequency
 * sketch (decisions/0014). The frequency-admission member of the family and an
 * implementation of `LiteCache`.
 *
 * W-TinyLFU (the Caffeine approach) admits by ESTIMATED FREQUENCY: new keys enter the
 * window; `get` and `put(update)` bump the sketch and promote the entry within its
 * segment (a probation hit is promoted to protected). At capacity the window's LRU
 * becomes the admission candidate, weighed against the probation LRU victim -- the
 * candidate is admitted (and the victim evicted) iff it is estimated MORE frequent;
 * ties reject (favor the incumbent). A one-hit-wonder never out-frequencies the
 * proven-hot set -- scan- and frequency-resistant, and often closer to Belady OPT than
 * LRU on skewed (Zipf) traffic. `has` and `peek` are frequency- and recency-neutral.
 * Same `LiteCache` surface as `LiteLru`, so `new LiteLru(n)` swaps for
 * `new WTinyLfu(n)` and stays type-checked -- the policy difference is INTERNAL, never
 * in the surface.
 *
 * See `LiteCache` for the D7 undefined-value contract and `LiteCacheOptions.onEvict`
 * for the reentrancy contract -- both hold here. The optional `keys: 'int'` backing
 * (decisions/0011) applies identically: 32-bit signed integer keys, strict zero-GC
 * (including the fixed packed sketch). Object keys hash into the sketch by their
 * resident slot (no WeakMap; frequency is tracked only while resident -- decisions/0014).
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class WTinyLfu<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `WTinyLfu` from a `dump()` snapshot (decisions/0021), incl. the
   *  Count-Min sketch VERBATIM (dropping it silently changes admission = fail-OPEN). Fail
   *  closed on any mismatch. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): WTinyLfu<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * A fixed-capacity Segmented-LRU cache with O(1) get/put/has/peek/delete over a
 * probation FIFO (~20%) in front of a protected LRU (~80%), decisions/0015. The
 * simplest scan-resistant baseline member of the family and an implementation of
 * `LiteCache`.
 *
 * Newcomers enter probation. A probation entry is PROMOTED to protected on its SECOND
 * hit (`get` once leaves it in probation; `get` twice promotes it -- `put(update)`
 * counts as a hit); a promotion that overflows protected demotes protected's LRU tail
 * back to probation. A protected hit moves to protected MRU. At capacity a new key
 * evicts the probation tail (or the protected tail only when probation is empty), so a
 * distinct one-hit-wonder scan never displaces a protected entry. `has`/`peek` are
 * promotion-neutral. Same `LiteCache` surface as `LiteLru`, so `new LiteLru(n)` swaps
 * for `new Slru(n)` and stays type-checked -- the policy difference is INTERNAL.
 *
 * See `LiteCache` for the D7 undefined-value contract and `LiteCacheOptions.onEvict`
 * for the reentrancy contract -- both hold here. The optional `keys: 'int'` backing
 * (decisions/0011) applies identically: 32-bit signed integer keys, strict zero-GC.
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class Slru<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `Slru` from a `dump()` snapshot (decisions/0021), incl. each
   *  entry's promote-on-2nd-hit visited bit. Fail closed on any mismatch. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): Slru<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * A fixed-capacity 2Q cache (Johnson & Shasha, VLDB'94) with O(1) amortized
 * get/put/has/peek/delete over an A1in FIFO (~25%) + an Am LRU + a fixed A1out ghost
 * of keys evicted from A1in (decisions/0015). A scan-resistant baseline member of the
 * family and an implementation of `LiteCache`.
 *
 * Newcomers enter A1in UNLESS the key is in the A1out ghost (a second sighting of a
 * recently-A1in-evicted key) -> straight to Am, consumed from the ghost (the ONLY path
 * into Am). An A1in hit does NOTHING (pure FIFO probation -- no promotion); an Am hit
 * moves to Am MRU. At capacity one reclaim step evicts the A1in tail (recording its key
 * in the ghost) when A1in is over its target or Am is empty, else the Am LRU (not
 * ghosted). A distinct one-hit-wonder flood churns A1in only, never displacing Am.
 * `has`/`peek` are neutral; the ghost holds KEYS only, never values, and is bounded at
 * construction. Same `LiteCache` surface as `LiteLru`, so `new LiteLru(n)` swaps for
 * `new TwoQ(n)` and stays type-checked -- the policy difference is INTERNAL.
 *
 * See `LiteCache` for the D7 undefined-value contract and `LiteCacheOptions.onEvict`
 * for the reentrancy contract -- both hold here. The optional `keys: 'int'` backing
 * (decisions/0011) applies identically: 32-bit signed integer keys, strict zero-GC
 * (including the int A1out ghost ring + membership table).
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class TwoQ<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `TwoQ` from a `dump()` snapshot (decisions/0021), incl. the
   *  keys-only A1out ghost (dropping it is a fail-OPEN admission bug). Fail closed on mismatch. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): TwoQ<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * A fixed-capacity ARC (Adaptive Replacement Cache; Megiddo & Modha, FAST'03) with O(1)
 * amortized get/put/has/peek/delete over a RECENT list T1 + a FREQUENT list T2, plus two
 * bounded keys-only ghosts (B1, B2) driving a self-tuning integer `p` (decisions/0016).
 * The no-tuning adaptive member of the family and an implementation of `LiteCache`.
 *
 * ARC splits the resident set into T1 (seen once) and T2 (seen 2+) and ADAPTS the split
 * on its own -- no knobs. A hit (get or put-update) promotes to T2 (frequent). A new key
 * found in B1 (recent ghost) raises `p` and re-admits to T2; found in B2 (frequent ghost)
 * lowers `p` and re-admits to T2; otherwise it enters T1. At capacity REPLACE evicts the
 * T1 or T2 LRU (per `p` and a boundary rule) to the matching ghost, so the RESIDENT value
 * capacity stays EXACTLY `capacity` -- only the split adapts, never the total. `has`/`peek`
 * are neutral; the ghosts hold KEYS only, never values, and are bounded at construction.
 * Same `LiteCache` surface as `LiteLru`, so `new LiteLru(n)` swaps for `new Arc(n)` and
 * stays type-checked -- the policy difference is INTERNAL.
 *
 * See `LiteCache` for the D7 undefined-value contract and `LiteCacheOptions.onEvict` for
 * the reentrancy contract -- both hold here. The optional `keys: 'int'` backing
 * (decisions/0011) applies identically: 32-bit signed integer keys, strict zero-GC
 * (including the int B1/B2 ghost rings + membership tables).
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class Arc<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `Arc` from a `dump()` snapshot (decisions/0021), incl. the
   *  adaptive integer `p` and BOTH ghosts B1/B2 (dropping either is a fail-OPEN adaptation
   *  bug). Fail closed on any mismatch or ghost-bound violation. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): Arc<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * LIRS -- Low Inter-reference Recency Set (Jiang & Zhang, SIGMETRICS'02), decisions/0023.
 * The eighth family member: eviction by RECENCY-OF-RECENCY (IRR = distinct blocks between a
 * block's last two references), the strongest scan/loop resistance in the family. A hot LIR
 * set (low IRR) is protected; cold HIR blocks (high IRR) are the eviction candidates. The
 * resident value capacity is EXACTLY `capacity` (split L_hir = max(1, round(cap*0.01)) +
 * L_lir); the non-resident HIR history is a SEPARATE bounded keys-only ring (D23). Same
 * uniform `LiteCache<K, V>` surface as every other member -- the one-line policy swap.
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class Lirs<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `Lirs` from a `dump()` snapshot (decisions/0021 + 0023), incl. the
   *  stack S order, the per-slot LIR/inS bits, list Q, AND the bounded non-resident history
   *  (dropping any is a fail-OPEN future-eviction bug). Fail closed on any mismatch. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): Lirs<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * Lfu -- an O(1) EXACT Least-Frequently-Used cache (Shah-Matani), decisions/0024. The ninth
 * family member: eviction by EXACT access frequency, with an LRU tie-break within a frequency.
 * A doubly-linked list of frequency buckets (each a recency list of keys at that exact count);
 * a hit relinks the key to the freq+1 bucket -- O(1), zero-ALLOCATION but not zero-write. This
 * is the EXACT counterpart to the approximate-sketch `WTinyLfu`: when you need a provable "the
 * least-frequently-used key is the victim" guarantee, not a probabilistic one. Same uniform
 * `LiteCache<K, V>` surface as every other member -- the one-line policy swap.
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class Lfu<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `Lfu` from a `dump()` snapshot (decisions/0021 + 0024), incl. the
   *  frequency buckets, their EXACT per-bucket frequencies AND the full within-bucket key
   *  ordering (dropping the frequencies is a fail-OPEN future-eviction bug). Fail closed on
   *  any mismatch. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): Lfu<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * ClockPro -- CLOCK-Pro (Jiang, Chen & Zhang, USENIX ATC'05), decisions/0025. The tenth
 * family member: the CLOCK approximation of LIRS. It approximates recency-of-recency with
 * ONE circular list + per-page reference bits + three moving hands (HAND_cold eviction,
 * HAND_hot demotion, HAND_test test-period expiry), so -- like Sieve/S3Fifo -- a hit sets a
 * single reference bit and moves NOTHING (0 link writes, the headline). The hot/cold split
 * ADAPTS via an integer target (`_mHot`), raised when a non-resident test page is re-admitted
 * and lowered when a test page expires unreferenced; the resident value capacity stays EXACTLY
 * `capacity` (only the split moves). The non-resident test-page history is a SEPARATE bounded
 * keys-only ring (cap = capacity, drop-oldest), NOT interleaved into the clock -- the honest,
 * bounded deviation from the textbook interleaving (mirrors Lirs/Arc). Same uniform
 * `LiteCache<K, V>` surface as every other member -- the one-line policy swap.
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class ClockPro<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `ClockPro` from a `dump()` snapshot (decisions/0021 + 0025), incl.
   *  the full circular order, the per-page hot/ref/test bits, ALL THREE hand positions, the
   *  adaptive `mHot`, AND the bounded non-resident history (dropping any is a fail-OPEN
   *  future-eviction bug). Fail closed on any mismatch or bound violation. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): ClockPro<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * LruK -- LRU-K (O'Neil, O'Neil & Weikum, SIGMOD'93), K=2, decisions/0026. The eleventh
 * family member: recency-of-recency by the K-th BACKWARD DISTANCE. A page is COLD until its
 * 2nd reference, then WARM; it tracks the two most-recent reference timestamps in two Float64
 * columns (`r0`/`r1`) allocated WITH the store -- a warm hit is 2 stamps + 0 link writes, a
 * cold->warm promotion is 2 stamps + exactly 5 link writes (non-exceedable). Eviction takes
 * the OLDEST cold page first (infinite K-distance, O(1)); only when none exists it scans the
 * warm list for the smallest 2nd-reference time (honestly O(size) reads, O(1) writes -- NOT
 * amortized O(1)). Fixed K=2, no knob and no correlated-reference period (CRP); the bounded
 * keys-only history (cap = capacity, drop-oldest) re-admits a returning page as WARM. Same
 * uniform `LiteCache<K, V>` surface as every other member -- the one-line policy swap.
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class LruK<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `LruK` from a `dump()` snapshot (decisions/0021 + 0026), incl. the
   *  warm + cold lists, their per-slot reference-time columns (`r0`/`r1`), the logical clock,
   *  AND the bounded non-resident history (dropping any is a fail-OPEN future-eviction bug).
   *  Fail closed on any mismatch or bound violation. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): LruK<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * Mq -- Multi-Queue (Zhou, Philbin & Li, USENIX ATC'01), m = 8, decisions/0027. The twelfth
 * family member: rank by FREQUENCY BAND with LOGICAL-time decay. Each block carries a reference
 * count; its band is `q = min(floor(log2(rc)), 7)` over 8 LRU queues Q0..Q7. A hit bumps the
 * count, moves the block to the MRU of its band (0 link writes when already the band MRU, else
 * exactly 5) and stamps a logical expire time; every access then runs a FIXED 7-step aging sweep
 * that demotes each band's idle tail one level toward Q0 (<= 4 link writes each, reset-on-demote
 * forbids cascade -> <= 33 link writes + 3 metadata stamps per access, non-exceedable). Eviction
 * takes the LRU tail of the LOWEST non-empty queue; a bounded keys-only + refcount Qout history
 * (cap = capacity, drop-oldest) re-admits a returning block at its remembered frequency. Unlike
 * Sieve/ClockPro, an MQ hit is NOT a 0-write lazy-promotion hit -- moving to the band MRU is real
 * list surgery. The logical clock is SEPARATE from the wall-clock `ttl` option. Same uniform
 * `LiteCache<K, V>` surface as every other member -- the one-line policy swap.
 *
 * @typeParam K key type (any value; SameValueZero equality via the internal Map)
 * @typeParam V value type
 */
export class Mq<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `Mq` from a `dump()` snapshot (decisions/0021 + 0027), incl. the 8 band
   *  queues, their per-slot refcount + expire-time columns, the logical clock, AND the bounded
   *  Qout history (keys + refcounts) -- dropping any is a fail-OPEN future-eviction bug. Fail
   *  closed on any mismatch or bound violation. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): Mq<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * CAR -- Clock with Adaptive Replacement (Bansal & Modha, USENIX FAST'04), the THIRTEENTH member
 * (decisions/0028). The CLOCK reformulation of ARC: two reference-bit clocks T1 (recent) / T2
 * (frequent), keys-only ghosts B1/B2, one adaptive integer `p`, no knobs -- ARC's exact semantics
 * with a 0-link-write hit (a hit sets ONE reference bit and moves nothing). Completes the
 * CLOCK-approximation trio (SIEVE / ClockPro / CAR). Honest cost: a hit is amortized/worst-case
 * O(1); a miss+evict is amortized O(1) but WORST-CASE O(capacity) reference-bit clears on a
 * full-scan-then-insert (no constant miss+evict bound). Same uniform `LiteCache` surface.
 */
export class Car<K = unknown, V = unknown> implements LiteCache<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError,
   *                 fail-closed -- null is not zero).
   * @param options  optional `onEvict` hook + `keys` backing (see `LiteCacheOptions`).
   */
  constructor(capacity: number, options?: LiteCacheOptions<K, V>);
  /** Reconstruct a FRESH `Car` from a `dump()` snapshot (decisions/0021 + 0028), incl. the T1/T2
   *  clocks, each page's reference/inT2 bits, the two clock hands, the adaptive `p`, AND both
   *  keys-only ghosts B1/B2 -- dropping any is a fail-OPEN future-eviction bug. Fail closed on any
   *  mismatch or bound violation. */
  static restore<K = unknown, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): Car<K, V>;
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
  /** Live runtime counters (decisions/0019). BORROWED holder -- copy what you keep;
   *  throws on an instance built without { stats: true } (fail-closed). */
  stats(): CacheStats;
  /** Zero the four counters in place (decisions/0019); throws without { stats: true }. */
  resetStats(): void;
  /** Serialize to a plain, structurally-cloneable snapshot (decisions/0021). COLD, may
   *  allocate (honest <= 96 B/entry; no zero-GC claim). Restore with the static restore(). */
  dump(): CacheSnapshot;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
  /** Iterable protocol == entries(); the yielded [K, V] tuple is BORROWED/reused
   *  (decisions/0018) -- copy what you keep. Only a copying map materializes
   *  (Array.from(c.entries(), ([k,v])=>[k,v])); a bare spread reads all-undefined. */
  [Symbol.iterator](): IterableIterator<[K, V]>;
  get size(): number;
  get capacity(): number;
}

/**
 * DirectLru -- `LiteLru` pinned to the DIRECT-MAPPED dense backing (decisions/0029). A
 * thin convenience subclass that fixes `keys: "dense"` and forwards `maxKey`, so it is
 * byte-for-byte equivalent to `new LiteLru(cap, { keys: "dense", maxKey })` with ZERO
 * policy duplication -- every hot path, the DLL and dump/restore are inherited verbatim.
 *
 * Reach for it when the key domain is a small, dense integer range `[0, maxKey]`: the
 * hot body is a single array read (no hash, no probe) and `clear()` is O(1). The cost is
 * O(maxKey) space (two `Int32Array`s), NOT O(entries) -- the honest trade vs the default
 * `Map` (arbitrary keys, amortized) and `keys: "int"` (large/sparse integer domains).
 *
 * @typeParam K key type (a dense integer in `[0, maxKey]`)
 * @typeParam V value type
 */
export class DirectLru<K = number, V = unknown> extends LiteLru<K, V> {
  /**
   * @param capacity max entries; must be an integer >= 1 (else throws RangeError).
   * @param options  MUST include `maxKey` (the dense domain `[0, maxKey]`); a
   *                 conflicting `keys` value other than `"dense"` throws (fail-closed).
   */
  constructor(capacity: number, options: LiteCacheOptions<K, V> & { maxKey: number });
  /** Reconstruct a dense cache from a `dump()` snapshot (decisions/0021 + 0029); the
   *  snapshot carries `keys: "dense"` + `mk`. Delegates to `LiteLru.restore`. */
  static restore<K = number, V = unknown>(snap: CacheSnapshot, opts?: LiteCacheOptions<K, V>): LiteLru<K, V>;
}

/** The package version (kept in lock-step with package.json + Lru.js). */
export const VERSION: string;

export default LiteLru;
