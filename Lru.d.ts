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
   */
  keys?: "int";
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
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
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
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
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
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
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
  get(key: K): V | undefined;
  put(key: K, value: V, ttlMs?: number): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  purgeStale(): number;
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

/** The package version (kept in lock-step with package.json + Lru.js). */
export const VERSION: string;

export default LiteLru;
