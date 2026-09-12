# Changelog

All notable changes to `@zakkster/lite-lru` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `VERSION` constant, `package.json` `version`, and `llms.txt` are bumped
together (three-place version sync) at release.

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
