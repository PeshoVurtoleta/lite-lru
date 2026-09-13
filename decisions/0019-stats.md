# 0019 -- Opt-in runtime stats: hits/misses/evictions/puts, D19

Status: accepted (S12 -- opt-in stats across all four members)

## Context

S12 adds an OPT-IN runtime counter surface to the whole family (`LiteLru`, `Sieve`,
`S3Fifo`, `WTinyLfu`) under the SAME `LiteCache<K,V>` surface: `stats()` and
`resetStats()`. The point is "measure your policy at runtime" -- a caller who wants
to know their live hit ratio, eviction pressure, or write volume gets exact counters
without reaching for the bench tool or a wrapper. The constraints are the suite's:

  - Zero allocation, zero counter WRITES on the hot path when stats are OFF (the
    default). A cache that never asks for stats must be byte-identical in effect to
    the pre-S12 build -- the same writes-per-hit baselines, no holder, no fields.
  - Fail closed on unverified state: `stats()`/`resetStats()` on a cache that was not
    constructed with `{ stats: true }` throw; an unknown `stats` value throws with a
    did-you-mean hint. null is not zero.
  - Pay-for-what-you-use, mirroring TTL (decisions/0017): the machinery only exists
    when opted into.

## The decision -- D19

### D19.1 -- the counted set: {hits, misses, evictions, puts}

Exactly four counters, chosen because each is (a) an EXACT integer the hot path
already reaches a decision point for, and (b) meaningful to a caller tuning a cache:

  - `hits`      -- a `get(key)` that found a LIVE resident entry.
  - `misses`    -- a `get(key)` that did not (absent, OR stale under TTL).
  - `evictions` -- an entry removed by the policy: a capacity eviction on `put`, or a
    stale reap (`_reap`). See D19.2.
  - `puts`      -- every SUCCESSFUL `put(key, value, ttlMs?)` operation (an insert OR
    an update -- an update is still a write). OUTCOME-BASED (see D19.2): a `put` that
    THROWS before the store mutation lands counts nothing.

`writesPerHit` is DELIBERATELY EXCLUDED from the runtime counters. It is
torture-MEASURED only (t6, via the Proxy-counted `CountedLru`/`CountedSieve`/... link
columns) and is member-specific (LiteLru relinks a small constant; Sieve/S3Fifo relink
nothing; W-TinyLFU relinks + bumps a sketch). Turning it into a runtime counter would
require a store on every hit -- exactly the hot-path write the zero-GC law forbids and
the writes-per-hit gate exists to catch. It stays a gated, out-of-band measurement.

### D19.2 -- what drives each counter (the counting law)

  - `get()` DRIVES hits/misses: a live hit -> `hits++`; an absent key (`s < 0`) ->
    `misses++`; a stale (TTL) hit -> `misses++` AND, via the reap below, an eviction.
  - `has()` / `peek()` are NEUTRAL for the hit/miss classification: they NEVER register
    a hit or a miss (they are inspections, not accesses -- the same reason they do not
    perturb recency). On a LIVE or ABSENT key they touch NO counter at all.
  - `put()` at capacity DRIVES evictions: a new key when `size === capacity` evicts the
    policy's victim in place -> `evictions++`. A SUCCESSFUL `put` (insert or update) ->
    `puts++`.
  - A stale-TTL `get()` is a MISS AND an EVICTION: it reaps the expired entry in place.
    The miss is counted in `get`; the eviction is counted at the single reap site
    (`_reap`), so the two are always consistent.

OUTCOME-BASED, uniformly. Every counter reflects an OUTCOME, not a call attempt:
`hits`/`misses` are counted AFTER the lookup resolves; `evictions` AFTER the victim is
removed; and `puts` AFTER the store mutation lands. The four `puts++` sites therefore
sit at the END of each member's `put` -- one on the update-in-place path (just before
its early `return`), one on the insert path (after the slot is written and any eviction
has occurred), both behind the same `this._stats === null` guard, still a pure integer
write. A `put` that THROWS before it mutates -- an invalid or out-of-range key under
`keys: 'int'`, a `ttlMs` passed to a non-ttl instance, or the onEvict-reentrancy guard
-- stores nothing and counts nothing, exactly like a `get` that never resolved a hit.
This is DISTINCT from `_store._ver++` (the iteration-invalidation counter), which is
deliberately bumped BEFORE the throw: a partially-attempted mutation must fail closed by
invalidating any live iterator (decisions/0018, D18.6). `_ver` guards structural safety
on any attempt; `puts` records a completed operation -- different jobs, different timing.

Eviction ACCOUNTING SITE. Evictions are counted in exactly two structural places: the
inline capacity eviction in `put`, and `_reap` (the one method every stale reap routes
through -- from `get`, `has`, `peek`, and `purgeStale`). Because `_reap` IS the single
reap site, a stale reap triggered by `has`/`peek` also registers as an eviction -- it
IS a genuine structural eviction. This does NOT violate has/peek neutrality: neutrality
is about the hit/miss classification (D19.2 above), and a `has`/`peek` on a live or
absent key touches nothing. The headline case in D19.2 is the stale `get` (miss+evict);
a stale `has`/`peek` reap is the same eviction mechanism, counted once, at `_reap`.

### D19.3 -- the holder is returned BY REFERENCE (borrowed; copy what you keep)

`stats()` returns the live, per-instance holder object BY REFERENCE -- it is NOT a
snapshot copy. The counters keep advancing in the object the caller holds. This mirrors
the S11 iteration borrowed tuple (decisions/0018, D18.2): zero allocation on read, at
the cost of a documented caveat -- copy what you keep (`{ ...cache.stats() }`) if you
need a point-in-time snapshot. `resetStats()` zeroes the SAME holder IN PLACE, so a
previously-borrowed reference stays valid and simply reads back zeros. The holder
identity is stable for the lifetime of the instance (gated: t6 Gate STATS asserts
`cache.stats() === cache.stats()` across a full churn run).

### D19.4 -- plain JS number fields, NOT a typed array

The four counters are plain JS `number` fields on a plain object, NOT an `Int32Array`.
Rationale: a JS number is an EXACT integer up to 2^53 (`Number.MAX_SAFE_INTEGER`),
which is the OVERFLOW BOUND for these counters -- past 2^53 increments lose precision.
At a sustained billion ops/second that is ~104 days of continuous counting on a single
counter; for any realistic cache it never overflows. An `Int32Array` would wrap at 2^31
(~2 seconds at that rate) -- far worse. Plain numbers also keep the holder a plain
object with no backing buffer that could ever reallocate (gated: t6 asserts the holder
is plain and its key set stays exactly the four names).

### D19.5 -- fail closed: the door and the accessors

  - The `stats: true` DOOR validates like the `keys` door (decisions/0011): `undefined`
    -> no stats (`_stats === null`); `true` -> a fresh zeroed holder; any OTHER value
    throws a `[lite-lru]`-tagged `TypeError` with a did-you-mean hint (`(did you mean
    true?)`) -- never a silent ignore.
  - `stats()` and `resetStats()` on a cache constructed WITHOUT `{ stats: true }` throw
    a `[lite-lru]`-tagged `Error` (there is no holder -- a caller bug, not a silent
    return of zeros). null is not zero.

### Hot-body cost (measured)

Each of `get` / `put` / `_reap` gates its counter writes behind the monomorphic
`this._stats === null` load. On the stats-OFF path every gate is a predicted-not-taken
branch that WRITES NOTHING -- no counter store, no holder, no field. Proven:

  - stats-OFF writes-per-hit UNCHANGED from the pre-S12 baselines: LiteLru
    head/interior/tail = 0 / 5 / 4; Sieve and S3Fifo hit = 0 links + 1 visited byte;
    W-TinyLFU window-MRU re-hit = 0. The `this._stats` load is not a `_next`/`_prev`/
    `_vis` link-column store, so the Proxy-counted baselines do not move.
  - `new X(n)._stats === null` when `stats` is not set (all four members).
  - stats-ON is strictly zero-alloc: t6 Gate STATS (`stats: true`, `keys: 'int'`,
    >= 60000 ops at capacity) measures maxMajor 0, maxPauseMs 4, retained <= 1 B/op,
    with the holder identity stable and its key set exactly the four names.

## Consequences

  - Each member gains one nullable field (`_stats`) and two cold methods
    (`stats`/`resetStats`). The counted public surface goes 12 -> 14 (the two named
    methods; `_stats` is underscore-invisible to the dts-drift enumerator).
  - `LiteCache<K,V>` gains `stats(): CacheStats` + `resetStats(): void`; the options
    type gains `stats?: true`; a new `CacheStats` type is exported. All four classes
    declare both methods (moat-pillar 1: the uniform surface).
  - Stats is a NAMED, gated law: Stats.test.js (counters exact vs a brute tally over
    the T5 corpus, the has/peek-neutral law, the stale-TTL miss+evict law, fail-closed
    accessors, the door), t6 Gate STATS (the 0-B/op gate + holder identity + plain
    holder), and t9 controls (`stats-double-count` and `stats-counts-peek` -- each
    diverges from the brute tally and fails).
  - The public API is additive; VERSION stays "1.4.0" (moves only at /release).
