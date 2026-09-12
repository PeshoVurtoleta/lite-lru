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
 * member; future members (`Sieve`, `S3Fifo`, `WTinyLfu`, ...) will each be a
 * `class X<K, V> implements LiteCache<K, V>`, so a caller can swap
 * `new LiteLru(n)` for `new Sieve(n)` and stay type-checked -- the policy
 * difference (recency / admission / frequency) is INTERNAL, never in the surface.
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
export interface LiteCache<K, V> {
  /**
   * Look up a key AND mark it most-recently-used (per the member's policy).
   * @returns the stored value, or `undefined` on a miss. See D7 above: a stored
   *          `undefined` is indistinguishable from a miss via `get` -- use `has`.
   */
  get(key: K): V | undefined;
  /** Insert or update. At capacity a new key evicts the policy's victim first
   *  (firing `onEvict`). */
  put(key: K, value: V): void;
  /** True if the key is present. Does NOT change recency. */
  has(key: K): boolean;
  /**
   * Read a value WITHOUT changing recency.
   * @returns the value, or `undefined` on a miss (see D7 -- pair with `has`).
   */
  peek(key: K): V | undefined;
  /** Remove a key. @returns true if it was present. */
  delete(key: K): boolean;
  /** Empty the cache. Allocates nothing. */
  clear(): void;
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
  put(key: K, value: V): void;
  has(key: K): boolean;
  peek(key: K): V | undefined;
  delete(key: K): boolean;
  clear(): void;
  get size(): number;
  get capacity(): number;
}

/** The package version (kept in lock-step with package.json + Lru.js). */
export const VERSION: string;

export default LiteLru;
