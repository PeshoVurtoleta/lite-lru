# Changelog

All notable changes to `@zakkster/lite-lru` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `VERSION` constant, `package.json` `version`, and `llms.txt` are bumped
together (three-place version sync) at release.

## [1.8.0] - 2026-09-13

### Added

- **Snapshot / restore across all seven members** (decisions/0021, D21): a COLD
  `dump()` instance method and a static `restore(snap, opts?)` on `LiteLru`, `Sieve`,
  `S3Fifo`, `WTinyLfu`, `Slru`, `TwoQ`, and `Arc`. `dump()` returns a plain structural
  object (the SoA columns are the serial form, D21.1); `restore()` builds a FRESH
  instance. No field is added to the substrate and no branch is added to
  `get`/`put`/`has`/`peek`, so the existing hot paths stay byte-identical.
  - The serial form captures the slot layout verbatim plus every member's
    future-eviction aux state, so a restored cache makes identical future eviction
    decisions versus an un-snapshotted twin: the SIEVE hand + visited bits; the
    S3Fifo/TwoQ/Arc keys-only ghost rings; the WTinyLfu Count-Min sketch + aging
    counter; the Arc adaptive `p`; the `_seg` tags; and the `_exp` TTL column when ttl
    is on (D21.1).
  - Fail-closed via a `{f:'litelru/1', m, cap, keys, ttl, t}` tag (D21.3): a wrong or
    absent format tag, a member mismatch, a non-object snapshot, a capacity/keys/ttl
    conflict (both ttl directions), a corrupt/short/missing column (including the
    visited-bit column), an out-of-range or duplicate slot index, and
    `entries.length > cap` each throw a `[lite-lru]`-tagged Error; a snapshot is never
    silently truncated or coerced, and restored size is `<= capacity`.
  - TTL is captured verbatim -- absolute ms-epoch deadlines, not rebased; the capture
    time `t` is stamped, so a restored-later cache expires on the real deadline and a
    future opt-in rebase needs no format change (D21.5). A restored `stats` holder
    starts fresh, and `keys:'int'` ghost keys are validated on restore (D21.6).
- **`CacheSnapshot` type** on the `.d.ts`; `dump(): CacheSnapshot` on the
  `LiteCache<K,V>` interface and all seven classes, plus `static restore(...)` per
  class (dts-drift counted instance surface 14 -> 15; statics excluded).
- **`decisions/0021-snapshot-restore.md`** (D21.1..D21.6) and **`test/Snapshot.test.js`**
  (the snapshot boundary suite). Torture additions: a `runRoundTrip` differential
  (dump -> clone -> restore fixed point, plus a restored-vs-twin future-eviction leg)
  wired into t5 over the 100k-op corpus for 7 members x {Map, int} x {ttl off, on}; t0
  round-trip laws; t2 adversarial (empty / cap-1 / full / free-list boundary); `Gate
  SNAP` in t6; 4096 dump/restore cycles in t7; and three t9 controls (arc-p-dropped,
  sketch-dropped, ghost-omitted), each diverging and exiting non-zero.

### Changed

- Three-place version sync to 1.8.0 (`package.json`, the `VERSION` constant, `llms.txt`).
- Test suite 987 -> 1077 node:test cases (snapshot round-trip + the fail-closed
  rejection matrix + hand-derived post-restore structural assertions for
  Arc/WTinyLfu/S3Fifo). Gate SNAP: 0.00000 B/op on the restored hot path, dump
  26.12 B/entry (<= 96 budget); the `get`/`put`/`has`/`peek` writes-per-hit numbers
  (LiteLru 0/5/4, Sieve/S3Fifo 0 links + 1 visited byte, WTinyLfu window-MRU 0) are
  unchanged -- dump/restore are cold-only.

## [1.7.0] - 2026-09-13

### Added

- **`Arc` -- the Adaptive Replacement Cache** (Megiddo & Modha, FAST'03; patent
  expired), decisions/0016, D16, as ONE new named export over the shared substrate --
  NOT a member with a mode flag (D16.1), so the hot path stays monomorphic and the
  tree-shake stays clean. It implements the SAME `LiteCache<K,V>` surface, so
  `new LiteLru(n)` swaps for `new Arc(n)` and stays type-checked.
  - Splits the resident set into a RECENT list T1 (seen once) and a FREQUENT list T2
    (seen 2+), threaded through the shared `_next`/`_prev` columns and tagged per slot
    by `_seg`. A single integer `p` (the T1 target, `0..capacity`) ADAPTS the split at
    runtime -- no knobs. A hit (get or put-update) promotes to T2 (frequent);
    `has`/`peek` are neutral.
  - Two bounded, keys-only ghosts drive the adaptation, reusing the S3-FIFO/TwoQ ring
    pattern (`ArcGhost`): B1 (keys evicted from T1) and B2 (keys evicted from T2),
    strict zero-alloc on `keys: 'int'`, amortized on the default Map backing. On a new
    `put`, a key found in B1 raises `p` (`p += max(1, floor(|B2|/|B1|))`, capped at
    capacity) and re-admits to T2; a key found in B2 lowers `p`
    (`p -= max(1, floor(|B1|/|B2|))`, floored at 0) and re-admits to T2 (D16.3).
  - At capacity, REPLACE evicts the T1 LRU (to B1) when `|T1| > p` or the boundary
    `key-in-B2 && |T1| == p`, else the T2 LRU (to B2); the all-recent `|T1| == c` edge
    direct-evicts the T1 LRU with no ghost (D16.4). The RESIDENT value capacity stays
    EXACTLY `capacity` -- only the split adapts, never the total (D16.2, fixed-capacity
    honesty). The bounds `|T1|+|B1| <= c` and `|B1|+|B2| <= c` hold and are validated.
- **`decisions/0016-arc.md`** -- D16.1 one export (no sibling, no mode flag) + why;
  D16.2 fixed-capacity honesty + the two ghost bounds; D16.3 the `p` adaptation rule
  and direction; D16.4 REPLACE incl. the `|T1| == p` boundary and the all-T1 direct
  evict; D16.5 iteration order (T2 then T1); D16.6 outcome-based stats (ghost moves and
  `p` adaptation are NOT evictions).
- **`test/torture/oracles/arc.mjs`** -- an independent brute-force ARC reference (plain
  arrays for T1/T2/B1/B2 + an integer `p`), driving the differential on both backings.
- **`test/Arc.test.js`** -- a node:test boundary suite (the `p` rule at its edges,
  ghost-driven re-admission, the `|T1| == p` REPLACE boundary, degenerate caps 1/2/3 +
  a caps 1..4 sweep, has/peek neutrality, reentrancy, `keys: 'int'` parity).
- Torture coverage for `Arc`: t0 (promote-to-T2, `p`-adaptation DIRECTION on B1/B2 ghost
  hits, REPLACE victim, iteration order), t1 (degenerate keys/values), t2 (a cap-sized
  distinct-key scan evicts 0 T2 entries + degenerate caps + a PHASE-CHANGE law asserting
  `p` moves the right way), t5 (differential fuzz vs `arc.mjs`, both backings, caps
  1..9 + 64, +/- TTL), t6 (`Gate ARC`, strict zero-alloc mixed churn with non-vacuous
  lane coverage), t7 (build/clear soak + the ghost-retains-no-values census), and t9
  controls (`arc-p-frozen`, `arc-unbounded-ghost` -- each diverges/drifts and fails).

### Changed

- `LiteCache<K,V>` gains no members; `Lru.d.ts` adds `class Arc<K,V>` (the same
  14-member surface), and the dts-drift gate now counts it (test (i) + an
  implements-clause control). The named export set grows from six members to seven.
- **`benchmark/Bench.mjs` now rosters all seven members** (`LiteLru`, `Sieve`,
  `S3Fifo`, `WTinyLfu`, `Slru`, `TwoQ`, `Arc`); the `Bench.test.js` member-count/name
  contract moved from 6 to 7, so the shipped "measure your policy" tool never silently
  omits `Arc`.
- Tests: 888 -> 987 node:test cases (`Arc` added to the parameterized Stats / Ttl /
  Iteration suites, plus the dedicated `Arc` boundary suite -- including the independent
  hand-derived ghost-trim assertions -- and dts/types coverage).
  `README.md` and `llms.txt` gain an `Arc` section and the updated counts.

### Gated (measured this release)

- `Gate ARC`: 60,000 mixed int-key ops at capacity 4096 -> 0 major GC, `maxPauseMs 4`,
  0.00176 B/op retained, all backing typed-array byteLengths (`_seg` / `_next` /
  `_prev` / `_ixSlot` / both ghost rings + membership tables) invariant across the run,
  and `_b1.len + _b2.len <= capacity`, `_t1Size + _b1.len <= capacity` always. The
  workload provably drives the distinguishing lanes -- lane-coverage counts asserted:
  p-adapt 15173, B1-hit 7569, B2-hit 7604, REPLACE-of-T2 18926 -- so the near-zero
  figure is not vacuous on the adaptive paths.
- Differential: 100,000 ops per config across capacities 1..9 (including the degenerate
  small-cap edges) and 64, on both backings, plus TTL, with zero divergence in value /
  size / eviction victim against the independent oracle.
- Bench (seed 0x9e3779b9, capacity 256, 200,000 ops, node v26 arm64 -- MACHINE-LOCAL,
  reproduce on your own hardware): `Arc` hit% / %OPT / writes-per-hit -- zipf
  65.5 / 88.1 / 4.785, scan 49.9 / 100.0 / 4.949, loop 0.0 / 0.0 / 0.000 (the LRU-family
  loop pathology; only frequency-sketch W-TinyLFU survives a loop larger than the cache).

## [1.6.0] - 2026-09-13

### Added

- **Two scan-resistant baseline members, `Slru` and `TwoQ`** (decisions/0015, D15),
  as TWO thin named exports over the shared substrate -- NOT one member with a mode
  flag, so each hot path stays monomorphic and the tree-shake stays clean (law 7).
  Both implement the SAME `LiteCache<K,V>` surface, so `new LiteLru(n)` swaps for
  `new Slru(n)` or `new TwoQ(n)` and stays type-checked.
  - **`Slru`** -- Segmented LRU: a probation FIFO in front of a protected LRU
    (`protectedCap = round(capacity * 0.8)`). A newcomer enters probation; the
    promote-on-2nd-hit law (D15) holds -- `get(X)` once leaves X in probation (a
    visited bit set, no reorder), `get(X)` twice promotes X to protected
    (`put(update)` counts as a hit); a promotion that overflows protected demotes
    its LRU tail back to probation. A protected hit moves to protected MRU. Eviction
    ALWAYS prefers the probation tail, so a cap-sized distinct-key scan evicts 0
    protected entries. `has`/`peek` are promotion-neutral.
  - **`TwoQ`** -- the full 2Q (Johnson & Shasha, VLDB'94): an A1in FIFO
    (`a1inCap = max(1, round(capacity * 0.25))`) + an Am LRU + a fixed, keys-only
    A1out ghost (`ghostCap = capacity - a1inCap`) reusing the S3-FIFO `_gRing`
    pattern (strict zero-alloc on `keys: 'int'`, amortized on the default Map
    backing). A newcomer enters A1in unless the key is in the A1out ghost (a second
    sighting) -> straight to Am, consumed from the ghost (the ONLY path into Am). An
    A1in hit does NOTHING (pure FIFO probation); an Am hit moves to Am MRU. At
    capacity the reclaim step evicts the A1in tail (recording its key in the ghost)
    when A1in is over its target or Am is empty, else the Am LRU (not ghosted). A
    distinct one-hit-wonder flood churns A1in only, never displacing Am.
- **`decisions/0015-2q-slru.md`** -- D15.1 two exports (not a mode flag) + why;
  D15.2 the 80/20 and 25% splits and degenerate caps; D15.3 the A1out ghost bound
  (fixed ring, keys only, never values) + the promote-on-2nd-hit rule; D15.4
  iteration order; D15.5 the outcome-based stats counting (segment
  promotion/demotion/graduation are NOT evictions).
- **`test/torture/oracles/slru.mjs` + `test/torture/oracles/twoq.mjs`** -- independent
  brute-force references (plain arrays), driving the differential on both backings.
- **`test/Slru.test.js` + `test/TwoQ.test.js`** -- node:test boundary suites (policy
  laws, fail-closed doors, degenerate caps 1/2/3, TTL/iteration/stats interop,
  `keys: 'int'` parity, and a self-contained oracle cross-check on both backings).
- Torture coverage for both members: t0 (promote-on-2nd-hit + iteration order laws),
  t2 (a cap-sized distinct-key scan evicts 0 protected/Am entries + degenerate caps),
  t5 (differential fuzz vs the new oracles, both backings, caps 1..9 + 64, + TTL),
  t6 (`Gate SLRU` / `Gate TWOQ`, strict zero-alloc int churn), t7 (build/clear soak +
  value-retention census), and t9 controls (`slru-promote-on-first-hit`,
  `twoq-unbounded-ghost` -- each diverges from its oracle and fails).

### Changed

- `LiteCache<K,V>` gains no members; `Lru.d.ts` adds `class Slru<K,V>` and
  `class TwoQ<K,V>` (each the same 14-member surface), and the dts-drift gate now
  counts both (tests (g)/(h) + implements-clause controls). The named export set
  grows from four members to six.
- **`benchmark/Bench.mjs` now rosters all six members** (`LiteLru`, `Sieve`,
  `S3Fifo`, `WTinyLfu`, `Slru`, `TwoQ`); the `Bench.test.js` member-count/name
  contract moved from 4 to 6, so the shipped "measure your policy" tool never
  silently omits a member.
- Tests: 612 -> 888 node:test cases (both new members added to the parameterized
  Stats / Ttl / Iteration suites, plus dedicated `Slru`/`TwoQ` boundary suites).
  `README.md` and `llms.txt` gain `Slru`/`TwoQ` sections and the updated counts.

### Gated (measured this release)

- `Gate SLRU` / `Gate TWOQ`: >= 60,000 mixed int-key ops at capacity 4096 -> 0 major
  GC, `maxPauseMs 4`, 0.00000 B/op, all backing typed-array byteLengths
  (`_seg` / `_vis` / `_gRing` / `_ixSlot` / ...) invariant across the run, and
  `_gLen <= _ghostCap` always. The workload provably drives the promote / demote /
  ghost-admit / Am-hit lanes (lane-coverage counts asserted nonzero), so the
  0.00000 B/op figure is not vacuous on the segment-transition paths.
- Differential: 100,000 ops per config across capacities 1..9 (including the
  degenerate `protectedCap == capacity` and `ghostCap == 0` edges) and 64, on both
  backings, plus TTL, with zero divergence in value / size / eviction victim against
  the independent oracles.
- npm test 888/888; `test:types` clean; torture "ok" (exit 0); controls all fail.

## [1.5.0] - 2026-09-13

### Added

- **Opt-in zero-GC stats across all four members** (`LiteLru`, `Sieve`, `S3Fifo`,
  `WTinyLfu`) behind the same `LiteCache<K,V>` surface: a per-instance counter
  holder `{ hits, misses, evictions, puts }`, enabled with the `stats: true`
  construction option and read through a cold `stats()` accessor, with
  `resetStats()` to zero it in place. The holder is plain JS numbers (exact to
  2^53, not an `Int32Array` that would wrap at 2^31) and is allocated only when
  `stats: true`; when off, `_stats` is `null` and no holder exists.
- `stats()` and `resetStats()` on the `LiteCache<K,V>` interface and all four
  classes; a `CacheStats` type and the `stats?: true` option in `Lru.d.ts`.

### Changed

- Counting is **uniformly outcome-based**: `get()` drives `hits`/`misses` after the
  lookup resolves; `put()` drives `puts` only after the store mutation lands (a
  `put` that throws -- an invalid/out-of-range key under `keys: 'int'`, or `ttlMs`
  on a non-ttl instance -- counts nothing) and drives exactly one `eviction` per
  real victim; `has()`/`peek()` are `hit`/`miss`-neutral; a stale-TTL `get()` is a
  miss and an eviction. `S3Fifo` graduation (SMALL->MAIN) and `WTinyLfu`
  window->probation demotion are not evictions and are not counted. `writesPerHit`
  is deliberately excluded from the runtime holder (it stays a torture-measured,
  member-specific property).
- Each hot-path increment sits behind a single monomorphic `this._stats === null`
  guard, so the **stats-OFF hot path is byte-identical** to 1.4.0: writes-per-hit
  unchanged (`LiteLru` 0/5/4, `Sieve`/`S3Fifo` 0 links + 1 visited byte, `WTinyLfu`
  window-MRU 0). With stats ON the hot path stays zero-allocation (measured
  **0.00032 B/op** over a 60,000-op window at capacity 4096; `gc maxMajor 0`,
  `maxPauseMs 4`; holder byteLength and identity stable).
- `stats()` returns the holder **by reference** (borrowed -- copy what you keep;
  it holds no reference back to the cache, so retaining it pins only four numbers).
- Fail-closed: `stats()`/`resetStats()` on a non-`stats` instance throw a
  `[lite-lru]` Error; the `stats` option rejects a non-`true` value with a
  `[lite-lru]` `TypeError` and a did-you-mean hint.
- Tests: 548 -> 612 node:test cases (adds `test/Stats.test.js`, four members
  parameterized: brute-tally parity over the fuzz corpus, has/peek-neutrality,
  outcome-based puts, stale-TTL and iteration interop, degenerate capacities,
  re-entrant `resetStats()` in `onEvict`, fail-closed doors). Torture adds the
  `t6 Gate STATS` allocation gate and two `t9` controls (`stats-double-count`,
  `stats-counts-peek`). `Lru.d.ts` drift-counted surface 12 -> 14. No `Bench.mjs`
  change (stats is not a bench member).

## [1.4.0] - 2026-09-13

### Added

- **Zero-GC iteration across all four members** (`LiteLru`, `Sieve`, `S3Fifo`,
  `WTinyLfu`) behind the same `LiteCache<K,V>` surface: `keys()`, `values()`,
  `entries()`, and `[Symbol.iterator]` (identical to `entries()`, matching `Map`).
  Each is a hand-written iterator (not a generator, which would allocate an
  `IteratorResult` per yield): a single `{ value, done }` result and, for
  `entries()`, one borrowed `[key, value]` tuple, both reused and mutated in place.
  Measured **0.00000 B/op per `next()`** on all four members (>= 10,000 steps
  prefilled at capacity 4096; `gc maxMajor 0`, `maxPauseMs 4`). The iterator object
  and its head roster are allocated once per call (cold), never per step.
- **Defined per-member iteration order** -- pinned, and NOT a universal recency
  claim (only `LiteLru` is true recency): `LiteLru` MRU..LRU; `Sieve` newest->oldest
  (FIFO insertion); `S3Fifo` MAIN newest->oldest THEN SMALL newest->oldest (the
  keys-only ghost is excluded); `WTinyLfu` WINDOW then PROTECTED then PROBATION,
  each MRU..LRU (three segments concatenated).
- `purgeStale()` remains the reclamation path; iteration is recency-neutral (a walk
  applies no LRU promotion, visited bit, sketch bump, or segment relink) and, under
  `ttl`, SKIPS stale entries without reaping them (no structural mutation mid-walk;
  `size` is unchanged by a walk).
- Fail-closed mutation-during-iteration: a single integer version counter on the
  shared slot store, bumped only by `put`/`delete`/`clear`/eviction/reap (never on
  the `get` path); an iterator captures it at creation and `next()` throws a
  `[lite-lru]`-tagged `Error` on a mid-walk structural mutation.
- `decisions/0018-iteration.md` (D18.1..D18.6); `test/Iteration.test.js` (+119
  node:test cases, four members parameterized); torture tier additions (t0
  iteration-order laws, t6 `Gate ITER` zero-alloc gate, three t9 controls:
  per-step-allocating iterator, promote-on-walk, reap-mid-walk -- each fails).

### Changed

- `LiteCache<K,V>` now extends `Iterable<[K, V]>` and declares `keys`/`values`/
  `entries`/`[Symbol.iterator]` on the interface and all four classes (additive; the
  dts-drift counted surface moved 9 -> 12). No change to any existing method's
  behavior or signature.
- Test suite 429 -> 548 node:test cases. The `get` writes-per-hit baselines are
  unchanged after adding the version counter (`LiteLru` head/interior/tail 0/5/4,
  `Sieve`/`S3Fifo` 0 links + 1 visited byte, `WTinyLfu` window-MRU 0), confirmed by
  the t6 gate.
- Borrowed-tuple documentation corrected: only a copying map materializes
  (`Array.from(cache.entries(), ([k, v]) => [k, v])`); a bare `[...cache.entries()]`
  / `Array.from(cache)` collects references to the one reused tuple, which the
  completed walk nulls, so it reads all-`[undefined, undefined]`. `keys()`/`values()`
  yield scalars, so their spreads materialize correctly. (The earlier "`Array.from`
  materializes" phrasing was inaccurate for the tuple-yielding iterators.)

## [1.3.0] - 2026-09-13

### Added

- **Opt-in TTL across all four members** (`LiteLru`, `Sieve`, `S3Fifo`, `WTinyLfu`)
  behind the same `LiteCache<K,V>` surface. A new `ttl` construction option
  (milliseconds) adds a lazy time-to-live stored in an optional `_exp`
  `Float64Array` allocated ONLY when `ttl` is configured -- a cache without `ttl`
  carries zero extra bytes and `_exp === null`. A resident slot's expiry is
  `clock() + ttlMs`; the never-expire sentinel is `Infinity`, never `0` (a `0`
  timestamp reads as already expired). Expiry is checked LAZILY on `get`/`peek`/
  `has`, BEFORE each member's hit policy: a stale entry is a MISS (no LRU
  promotion, no visited bit, no sketch bump), is evicted in place (firing
  `onEvict`), and reads as `undefined` (`get`/`peek`) or `false` (`has`). No
  timers and no background sweep on the hot path. Untouched-stale entries count
  toward `size` until touched or purged; capacity eviction ignores staleness.
- **Injectable `clock` option** -- a zero-argument function returning milliseconds,
  defaulting to `Date.now()`. Validated at construction (a non-function throws a
  `[lite-lru]` error). Enables deterministic expiry in tests and the oracle.
- **Per-entry TTL override** -- `put(key, value, ttlMs?)` takes an optional
  positional milliseconds argument overriding the instance default for that entry
  (`Infinity` = never expire). Positional, not an options object, so the call
  allocates nothing. Passing `ttlMs` to an instance with no `ttl` throws
  `[lite-lru]` (fail-closed).
- **`purgeStale(): number`** -- a cold, `O(size)` bulk reclamation that evicts every
  currently-expired resident (firing `onEvict` per victim) and returns the count.
  Returns `0` on a cache with no `ttl`. Not a hot path.
- **`decisions/0017-ttl.md`** -- D17.1 the expiry column + `Infinity` sentinel; D17.2
  the clock source + injection; D17.3 lazy-only semantics and how a stale hit
  interacts with each member's policy; D17.4 the per-instance default + per-put
  override with fail-closed validation (`ttl`/`ttlMs` <= 0, `NaN`, or non-number
  throw `RangeError`); D17.5 `purgeStale` including the fail-closed
  purge-under-reentrancy contract; plus the off-path decision resolved by
  measurement (a single monomorphic `this._exp === null` guard, kept).
- **`test/Ttl.test.js`** -- 117 node:test boundary cases parameterized over all four
  members: fail-closed construction, lazy miss + slot free, the no-rescue law, the
  per-put override, D7-under-TTL (stored-`undefined` vs stale), the `<=` expiry
  boundary, `keys:'int'` + ttl, and `purgeStale` incl. the reentrancy-abort
  regression pin.
- TTL torture coverage in tiers t0/t1/t2/t5/t6/t7/t9: ttl laws; fail-closed throws;
  the lazy-semantics triple as executable laws; a virtual-clock differential vs
  each member's brute oracle; the ttl-OFF byte-identical + ttl-ON strict-zero
  allocation gates; expiry-churn soak; and three new controls (skip-gate,
  stale-promotes, growing-`_exp`), each of which fails.

### Changed

- `LiteCache<K,V>` (`Lru.d.ts`) is additive: `put` gains an optional trailing
  `ttlMs`, the options gain `ttl?` and `clock?`, and `purgeStale(): number` joins
  the surface (all four members implement it). The one-line policy swap stays
  type-checked; `dts-drift` pins the enlarged surface.
- Test suite grows from 312 to 429 node:test cases. `README.md` and `llms.txt` gain
  a TTL section and the updated count.
- The four brute-force oracles (`lru`, `sieve`, `s3fifo`, `wtinylfu`) and the
  differential harness now drive a virtual clock and mirror the lazy expiry rule;
  `validate()` conservation gains a free-slot `_exp === Infinity` term.
- Clarified (not changed): when an `onEvict` illegally re-enters the instance during
  `purgeStale()`, the reentrancy guard throws and the sweep aborts, leaving later
  stale residents in place; the cache stays structurally consistent and they are
  reaped lazily on next touch. This is intended fail-closed behavior (`decisions/
  0002`, D17.5), recorded and regression-pinned rather than altered.

### Gated (measured this release)

- writes-per-hit unchanged with ttl OFF: `LiteLru` 0/5/4 (head/interior/tail),
  `Sieve` 0/1, `S3Fifo` 0/1, `WTinyLfu` window-MRU 0; a non-ttl cache has
  `_exp === null`.
- ttl ON strict zero-alloc: gc major 0, minor 0, maxPauseMs 0.00, ~0.0003 B/op;
  `_exp.byteLength` stable (32768 = capacity * 8) over a 100000-op churn at capacity.
- npm test 429/429; `test:types` clean; torture "ok" (exit 0); controls all fail.

## [1.2.0] - 2026-09-13

### Added

- **`WTinyLfu`** -- the frequency-admission member (W-TinyLFU, Einziger et al.; the
  Caffeine approach) on the same substrate: a small admission WINDOW (an LRU,
  `window = max(1, round(capacity/100))`) in front of a segmented main cache (SLRU:
  a probation segment + a protected segment `= round(mainCap * 0.8)`), gated by a
  fixed 4-row 4-bit saturating Count-Min frequency sketch. A hit bumps the sketch
  and relinks within its segment (a probation hit is promoted to protected,
  demoting protected's LRU tail on overflow). At capacity the window's LRU tail is
  the candidate and the probation LRU tail is the victim; the candidate is admitted
  to main (evicting the victim) iff its estimated frequency is strictly greater,
  ties reject (favor the incumbent). The sketch is aged (every counter halved in
  place) every `10 * capacity` bumps. Same `LiteCache<K,V>` surface, `onEvict`
  fire-after + reentrancy guard, and `keys: 'int'` strict-zero backing as the other
  members. Completes the headline trio (SIEVE / S3-FIFO / W-TinyLFU).
- **`decisions/0014-wtinylfu.md`** -- records D14: the key-to-sketch hashing
  (numeric hash by value for primitives, by resident slot index for object keys --
  no `WeakMap`, frequency tracked only while resident); the counter width and fixed
  dimensions (4 rows of 4-bit counters packed 8-per-`Uint32`, width a power of two
  `>= capacity`, sized once and never grown); the aging budget; the window/main and
  protected/probation splits and the degenerate small-capacity edges
  (`capacity == 1` -> `mainCap == 0`, admission skipped); and the deferred
  doorkeeper.
- **`test/torture/oracles/wtinylfu.mjs`** -- an independent brute-force reference
  (window + SLRU + sketch + aging + admission; shares no code with `Lru.js`),
  driving the differential.
- **Torture coverage for `WTinyLfu`** -- `wtinylfuPolicy` + `wtinylfuIntPolicy`
  registered across tiers `t0`/`t2`/`t5`/`t6`/`t7`, plus a `t9` admit-always
  control proven to diverge. `validate()` extended to sum the window + probation +
  protected segments (reciprocity each) and hold the fixed sketch `byteLength`.
- **`test/WTinyLfu.test.js`** -- the `node:test` boundary suite for the member
  (admission accept/reject + ties, window->probation->protected promotion and
  protected-overflow demotion, scan/one-hit-wonder resistance, `has`/`peek`
  neutrality, delete + segment repair, the small/degenerate capacities, fail-closed
  capacity, the unknown-`keys` and `keys: 'int'` doors, `onEvict` fire-after +
  reentrancy, D7).

### Changed

- Test suite grows to **312** `node:test` cases (from 228). `README.md`, `llms.txt`,
  and `Lru.d.ts` (the `WTinyLfu<K,V>` declaration + dts-drift coverage) updated for
  the fourth member.
- **`benchmark/Bench.mjs` now rosters all four members** (`LiteLru`, `Sieve`,
  `S3Fifo`, `WTinyLfu`). The `Bench.test.js` member-count/name contract moved from
  2 to 4.

### Fixed

- **Shipped bench omitted members.** `benchmark/Bench.mjs` measured only `LiteLru`
  and `Sieve` -- `S3Fifo` (shipped in 1.1.0) and `WTinyLfu` were absent from the
  "measure your policy" tool. Both added so the shipped bench measures the whole
  family.

### Gated numbers

- Writes per hit (`WTinyLfu`, via `CountedWTinyLfu`): window-MRU rehit 0 link
  writes; a probation->protected promoting hit 9 (interior) / 8 (probation tail)
  link writes, plus a 4-counter sketch bump. Higher than `Sieve`/`S3Fifo` by design
  (a segment relink + the sketch bump per hit) -- still zero allocation.
- Zero-GC (int backing, including the sketch increment and one bulk aging pass):
  `maxMajor` 0, `maxPauseMs` 4, retained `maxBytesPerCall` 1, `arrayBuffers` growth
  0; the `_sk` / `_seg` buffer `byteLength` is invariant under 1e6 ops (int and
  object-key backings).
- Differential: 100000 ops per config across capacities 1..9 (including the
  `mainCap == 0` degenerate edge) and 64, on both backings, with zero divergence in
  value / size / eviction victim / admission decision against the brute oracle.
- Bench (`capacity 256`, `ops 200000`, `seed 0x9e3779b9`): zipf hit ratio
  `WTinyLfu` 65.7% (88.3% of Belady OPT) vs `LiteLru` 57.4% (77.2%); loop
  `WTinyLfu` 23.5% (94.4% of OPT) where `LiteLru` / `Sieve` / `S3Fifo` are 0.0%;
  scan `WTinyLfu` 49.9% (99.9% of OPT). ns/op is machine-local and not a claim.

## [1.1.0] - 2026-09-12

### Added

- **`S3Fifo`** -- the S3-FIFO member (Yang et al., SOSP'23) on the same substrate:
  quick-demotion + lazy-promotion over a SMALL probation FIFO
  (`smallCap = max(1, floor(capacity/10))`), a MAIN FIFO
  (`mainCap = capacity - smallCap`), and a bounded keys-only GHOST queue
  (`ghostCap = mainCap`), all sized once at construction. A hit sets the visited
  byte and relinks nothing (0 link writes + exactly 1 visited-byte store, same as
  `Sieve`). A newcomer enters SMALL unvisited; a key seen in the ghost enters MAIN.
  At capacity one eviction step: the SMALL oldest graduates to MAIN if visited,
  else is evicted and its key remembered in the ghost; otherwise the MAIN oldest
  gets one second chance or is evicted (MAIN evictions are not ghosted). Same
  `LiteCache<K,V>` surface, `onEvict` fire-after + reentrancy guard, and
  `keys: 'int'` strict-zero backing as the other members.
- **`decisions/0013-s3fifo.md`** -- records D13: the small/main split and the
  `capacity == 1` degenerate edge (`mainCap == 0`, `ghostCap == 0`); the ghost
  representation (a strict-zero-alloc open-addressed Int32 table + FIFO ring on the
  `keys: 'int'` backing; an amortized `Set` + ring on the default `Map` backing),
  which retains bounded KEYS only, never values; and the unchanged uniform surface
  and policy law.
- **`test/torture/oracles/s3fifo.mjs`** -- an independent brute-force three-structure
  S3-FIFO oracle (shares no code with `Lru.js`), driving the differential.
- **Torture coverage for `S3Fifo`** -- `s3fifoPolicy` + `s3fifoIntPolicy` registered
  across tiers `t0`/`t2`/`t5`/`t6`/`t7`, plus a `t9` graduate-on-first-touch control
  proven to diverge. `validate()` extended to sum the SMALL + MAIN rings (reciprocity
  each) and bound the ghost (`ghostCount <= ghostCap`).
- **`test/S3Fifo.test.js`** -- 67 `node:test` boundary cases (admission to SMALL,
  ghost-routes-to-MAIN, prove-then-graduate, scan resistance, `has`/`peek`
  visited-neutrality, delete + queue repair, `capacity == 1` and small caps,
  fail-closed capacity, `onEvict` fire-after + reentrancy, D7, the `keys: 'int'`
  door).

### Changed

- Test suite grows to **228** `node:test` cases (from 160). `README.md`, `llms.txt`,
  and `Lru.d.ts` (the `S3Fifo<K,V>` declaration + dts-drift coverage) updated for
  the third member. `package.json` `description` unchanged (already family-accurate).

### Fixed

- **Missing fail-closed door test** -- the `newStore` "unknown `keys` value" branch
  (throws a `[lite-lru]`-tagged `TypeError` with a did-you-mean hint) had no test
  for any member; added 10 parameterized cases.

### Gated numbers

- Writes per hit: `S3Fifo` = 0 link writes + exactly 1 visited byte, measured at the
  head / interior / tail of SMALL (matches `Sieve`; the strongest zero-GC posture).
- Zero-GC (int backing, including the ghost ring + membership table): `maxMajor` 0,
  `maxPauseMs` 4, retained `maxBytesPerCall` 1, `arrayBuffers` growth 0.
- Differential: 100000 ops per config across capacities 1..9 (including the
  `mainCap == 0` / `ghostCap == 0` degenerate edge) and 64, on both backings, with
  zero divergence in value / size / eviction victim against the brute oracle.

## [1.0.0] - 2026-09-12

### Added

- **`LiteLru`** -- the classic Least-Recently-Used reference member: a `Map` fused
  with an intrusive, preallocated doubly-linked list over structure-of-arrays slot
  columns (`_keys` / `_vals` object columns, `Int32Array` `_next` / `_prev` link
  columns). O(1) `get` / `put` / `has` / `peek` / `delete` / `clear`; eviction
  reuses the LRU tail slot in place. Fail-closed `capacity` (integer `>= 1`, else a
  `[lite-lru]`-tagged `RangeError`).
- **`onEvict(key, value)`** -- optional zero-GC eviction hook. Fires LAST, after the
  cache is fully consistent, with a fail-closed reentrancy guard: a mutating call
  (`put`/`get`/`delete`/`clear`) from within the callback throws a
  `[lite-lru]`-tagged `Error`; `has` / `peek` are allowed.
- **Shared keyed-index substrate (`SlotStore`, internal)** -- the keyed index, SoA
  slot columns, and free stack factored into one internal substrate both members
  compose; the backing is chosen once at construction so each hot path stays
  monomorphic.
- **`keys: 'int'` backing** -- opt-in open-addressed typed-array keyed index (linear
  probing, backward-shift deletion, fixed load factor `<= 0.75`, Fibonacci hash
  mix) for STRICT zero allocation with no pre-fill caveat. Accepted key domain:
  32-bit signed integers `[-2147483648, 2147483647]`, validated at the door
  (a non-integer or out-of-range key throws a `[lite-lru]`-tagged `TypeError`). An
  unknown `keys` value throws with a did-you-mean hint.
- **`Sieve`** -- the first modern eviction-policy member (SIEVE, Zhang et al.,
  NSDI'24) on the same substrate: a lazy-promotion FIFO ring with a one-byte
  visited column and a persistent moving hand. A hit sets the visited byte and
  relinks nothing; at capacity the hand sweeps, grants one second chance per
  visited entry, and evicts the first unvisited entry in place. Same
  `LiteCache<K,V>` surface as `LiteLru`.
- **`Lru.d.ts`** -- ambient TypeScript surface: the `LiteCache<K,V>` interface both
  members implement, `LiteCacheOptions<K,V>`, and the `VERSION` declaration. A
  drift gate keeps the export set and public class surface in lock-step with
  `Lru.js`.
- **`Bench.mjs`** -- a runnable (`node benchmark/Bench.mjs` / `npm run bench`) AND importable
  (`import { runBench, beladyOpt } from '@zakkster/lite-lru/benchmark/Bench.mjs'`)
  measurement tool that imports only `Lru.js` (zero runtime deps). Reports, per
  seeded workload (`zipf` / `loop` / `scan`) per member: hit ratio, writes-per-hit,
  machine-local ns/op, and percentage of Belady OPT. Added to `package.json`
  `files[]`, the `exports` map (`"./benchmark/Bench.mjs"`), and a `bench` script.
- **`beladyOpt(trace, capacity)`** -- Belady's clairvoyant offline optimum (evict
  the resident whose next use is farthest away), exported from `Bench.mjs` as a
  reference oracle only; never a production policy.
- **Torture tier `t8` (Belady OPT gate)** -- differential-tests the shipped
  `beladyOpt` against a brute-force O(N*C) OPT on small seeded traces, and asserts
  the optimality bound `optHits >= memberHits` for both `LiteLru` and `Sieve` on
  every trace (fail-closed, replay-seeded).
- **`README.md` and `llms.txt`** -- documenting both members under one
  `LiteCache<K,V>` surface, the tree-shake story, the `keys: 'int'` backing and its
  TypeError door, the `onEvict` fire-after + reentrancy contract, the D7
  undefined-value contract, the gated writes-per-hit and zero-GC numbers, and the
  `Measure & Trust` bench workflow.
- **Test + torture suite** -- 160 `node:test` cases; a policy-parameterized
  differential runner with independent brute-force oracles for both members on both
  backings; torture tiers `t0`/`t1`/`t2`/`t5`/`t6`/`t7`/`t8`/`t9` plus out-of-process
  must-fail controls; a `validate()` conservation invariant.

### Changed

- `package.json` `description` now reflects the family (LiteLru reference + SIEVE
  headline under one `LiteCache<K,V>` surface + the shipped bench/OPT tool).

### Fixed

- **onEvict reentrancy defect** (found by qa during S1). Firing `onEvict` while the
  intrusive lists were mid-eviction let a reentrant mutating call corrupt the
  structure (`size > capacity`, a phantom slot, a hung `validate()`). Fixed by
  firing `onEvict` LAST, after the cache is consistent, plus the fail-closed
  reentrancy guard on `put` / `get` / `delete` / `clear`. Recorded in
  `decisions/0002` (amends D8); the regression is pinned by the torture gate.

### Gated numbers

- Zero-GC: `maxMajor` 0, `maxPauseMs` 4, retained `maxBytesPerCall` 1,
  `arrayBuffers` growth 0.
- Writes per hit: `LiteLru` head / interior / tail = 0 / 5 / 4 index stores;
  `Sieve` = 0 link writes + exactly 1 visited byte.
