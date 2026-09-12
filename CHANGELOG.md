# Changelog

All notable changes to `@zakkster/lite-lru` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `VERSION` constant, `package.json` `version`, and `llms.txt` are bumped
together (three-place version sync) at release.

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
