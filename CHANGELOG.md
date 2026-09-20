# Changelog

All notable changes to `@zakkster/lite-lru` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/); this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `VERSION` constant, `package.json` `version`, and `llms.txt` are bumped
together (three-place version sync) at release.

## [1.18.0] - 2026-09-20

### Added

- `benchmark/Bench.mjs` skew + variance axes (BRIEF findings 1-4), all additive and
  deterministic; the default `runBench()` still emits exactly `['zipf','loop','scan']`
  with byte-identical traces and unchanged `config` `{capacity,length,seed}`:
  - `runBench` / `defaultWorkloads` gain `alphas` (zipf exponent sweep, default
    `[1.0]`) and `keyspaceRatio` (keyspace = `capacity*ratio`, default 16 -- was a
    hardcoded `*16`). `alphas: [1.0]` keeps the workload named `zipf`; any other set
    names each `zipf-a<A>` (e.g. `zipf-a0.7`). Per-alpha seed is derived
    deterministically, so `zipf-a1.0` reproduces the default `zipf` trace exactly.
  - `ZIPF_ALPHAS = [0.7, 0.9, 1.0, 1.2]` -- the opt-in skew-sweep constant.
  - `measureTiming` gains a `repeats` param (default 5): one warmup + `repeats` timed
    passes. Members now surface `nsPerOpMedian` and `nsPerOpP95` (nearest-rank);
    `nsPerOp === nsPerOpMedian` for back-compat. The printed table gains ONE `p95`
    column. No single-throughput headline number is introduced.
  - `runBench` echoes the new knobs (`alphas`, `keyspaceRatio`, `repeats`) in a NEW
    top-level `tuning` object; `config` is left untouched at three keys.
  - `webTrace(opts)` -- a seeded, deterministic "web-like" generator: a diurnal hot
    set that slowly rotates across the keyspace interleaved with a zipf tail.
    Exported; NOT added to the default workload set.
  - `parseIntTrace(text, opts?)` -- a columnar/CSV text -> integer Array loader
    (`delimiter`, `column`, `comment` prefix, `skipHeader`). Takes a STRING, not a
    path (no `node:fs`); throws a `[lite-lru]`-tagged `RangeError` on a non-integer
    token. Feed the result to `runBench({ workloads })` to replay your own trace.
  - Documented `beladyOpt`'s scale ceiling: it allocates an `Int32Array(n)` next-use
    table + a `Map` over the whole trace, so OPT (not the caches) caps a "scale" run
    -- fine at ~5M ops, heavy toward ~50M.

## [1.17.0] - 2026-09-20

### Added

- A THIRD keyed-index backing, `keys: 'dense'` (decisions/0029): a DIRECT-MAPPED,
  generation-stamped typed-array index for a SMALL, DENSE integer key domain
  `[0, maxKey]`. The hot body is a single array read --
  `_gen[k] === _epoch ? _ixSlot[k] : NIL` -- with NO hash, NO probe, and NO per-op
  init. STRICT zero-alloc on every hot path (get/put/delete/has/peek, measured
  0.00000 B/op), and `clear()` is genuinely O(1) via an epoch bump (only a disclosed-
  amortized O(U) reset when the epoch would overflow `INT_MAX`). The no-init trick
  borrows the sparse-set discipline: `_gen` is a zero-initialized `Int32Array` and
  `_epoch` starts at 1, so a never-written key reads absent with no O(U) pre-fill and
  `0` is a legal key. Requires `maxKey` (an integer in `[0, 2147483647]`); a key
  outside `[0, maxKey]`, a non-integer key, or a missing/bad `maxKey` fails closed with
  a `[lite-lru]`-tagged `TypeError` (typeof guard first). The honest co-headline is
  SPACE: O(maxKey), NOT O(entries) -- two `[0, maxKey]` `Int32Array`s. Use `keys: 'int'`
  for large/sparse integer domains instead.
- `DirectLru` -- a thin `LiteLru` subclass pinned to the dense backing.
  `new DirectLru(cap, { maxKey })` is byte-identical to
  `new LiteLru(cap, { keys: 'dense', maxKey })` with ZERO policy duplication (every hot
  path, the DLL, and dump/restore are inherited).
- `benchmark/Bench.mjs` gains an exported `backingCompare()` lane (+ CLI print)
  measuring the SAME LRU policy over its three index backings on an integer,
  dense-domain zipf workload (identical hit ratio; only ns/op + space/allocation
  posture differ). Representative capacity-256 numbers: `keys:'dense'` ~40 ns/op,
  `keys:'int'` ~50 ns/op, default `Map` ~64 ns/op.
- `test/Direct.test.js` (oracle-vs-Map eviction-order identity, dump/restore incl.
  `maxKey`, `DirectLru` == `LiteLru` + `{ keys:'dense', maxKey }`, no-init safety, O(1)
  clear correctness, the fail-closed doors); dense door cases across all thirteen
  members in `test/Options.test.js`; a t6 dense 0-B/op lane (incl. O(1) clear cycles)
  and Sieve dense factory-path lane; two dense perf-gate scenarios. Test count
  1754 -> 1886.

### Changed

- `snapBase` now reads an explicit `_store._kind` tag (`'map'|'int'|'dense'`) instead
  of duck-typing on `checkStable` (which the dense store ALSO has), so a dense cache
  dumps as `keys:'dense'` + `mk` (maxKey) and restores exactly. The snapshot tag,
  `restore()` validation, and the `.d.ts` `CacheSnapshot` gain `'dense'` + the optional
  `mk` field. All thirteen members thread `maxKey` through store construction; the
  default `Map` and `keys:'int'` hot paths are byte-unchanged.

## [1.16.1] - 2026-09-15

### Changed

- Completed the v1.16.0 shape-hygiene pass: `ClockPro` and `Lirs` now initialize
  the `onEvict` fire-after fields (`_evKey`/`_evVal`) in their constructors, matching
  `Car`, `LruK`, and `Mq`. Previously these two acquired the fields lazily on first
  eviction, causing a one-time hidden-class transition on the eviction path (no
  retention, no measured allocation -- the fields are snapshotted and cleared before
  `onEvict` fires -- but an inconsistency across the five members that use them). All
  five now declare the fields at construction with an identical comment; the prior
  comment on `Car`/`LruK`/`Mq` naming `ClockPro` as the precedent (which did not
  initialize them at construction) was corrected to a precedent-neutral note.

### Added

- `test/Options.test.js` -- a 287-case boundary suite parameterized over all thirteen
  members, locking the v1.16.0 constructor doors that previously had no regression test
  (the v1.16.0 additions were the CAR/ClockPro victim-order suites): unknown option key
  rejection with a did-you-mean hint, non-object options-bag rejection (including `null`),
  non-function `onEvict` rejection (and acceptance of `undefined` / a real callback), and
  the Symbol/BigInt options footgun (a clean `[lite-lru]` error, never a raw `TypeError`).
- One `beladyOpt` boundary case (`test/Bench.test.js`): an `Infinity` capacity throws a
  tagged `RangeError`. Test count 1466 -> 1754 (node:test).

## [1.16.0] - 2026-09-15

### Added

- Fail-closed constructor door for unknown option keys plus `onEvict` validation.
  Every member now validates its `options` bag at construction: a non-object bag, an
  unknown key (with a nearest-known-key did-you-mean hint), or a non-function
  `onEvict` throws a `[lite-lru]`-tagged error at the door. Behavioral change: a
  typo'd option key that was previously ignored silently now throws.
- Torture orchestrator per-tier liveness counts. Every tier's `run()` returns a
  positive work-unit count and `test/torture.mjs` fails closed if a tier reports no
  work, so a silently-empty gate can no longer pass.
- Hand-derived CAR/ClockPro victim-order suites (`test/Car.test.js`, `test/ClockPro.test.js`):
  three cases each, derived by hand from decisions/0028 D28 and decisions/0025 D25 (never by
  running the implementation and transcribing), pinning the EXACT eviction order and victim
  identity for a no-reference clock rotation, the reference-bit second chance, and the
  T1-survivor-to-T2 / bounded-history-re-admit adaptation that changes the next victim.
- Boundary tests for the new fail-closed doors (`test/Lru.test.js`, `test/Bench.test.js`):
  the unknown-option-key door (family-wide, proven on a second member), `options: null`/`42`,
  a fully-populated options bag, the `onEvict` non-function door and its silent-NOOP default,
  and `beladyOpt`'s `NaN`/`undefined`/non-integer capacity door.
- Test count 1449 -> 1466 (node:test).

### Changed

- Seeded traces: for a given seed the bench/harness PRNG streams differ from 1.15.0
  (a consequence of the xorshift32 fix below). The README bench table is regenerated
  from the corrected default trace, and the two stream-dependent t6 lane floors are
  re-derived under the new streams: CLOCKPRO cold->hot promotions floor 1 -> 200 (the
  `cpStream` coverage window now periodically re-references recently-inserted cold
  keys so promotions land in-window; observed 865, was 2) and LFU bucket-relabel
  floor 50 -> 20 (observed 45). Zero-GC budgets are unchanged.

### Fixed

- xorshift32 PRNG in the bench + test harness now uses a logical `>>> 17` shift
  instead of the arithmetic `>> 17` (the arithmetic shift made the state map 2-to-1
  with a reachable all-zero absorbing state, voiding the full-period guarantee). The
  `Car.test.js` LCG (which overflowed the 2^53 float mantissa) is replaced with the
  same xorshift32 stream the sibling suites use.
- `beladyOpt` rejects a non-numeric / NaN capacity (and a positive non-integer)
  with a `[lite-lru]`-tagged `RangeError`, before the documented degenerate fallbacks.
- LruK/Mq eviction-field constructor init: both constructors now initialize
  `_evKey`/`_evVal` at construction time for hidden-class shape stability, matching Car.
- t7 soak: the churn-growth baseline is now sampled after a forced GC, and a tracked
  heap peak is bounded alongside the end sample (the 64 MB backstop is unchanged);
  the dead `heapLast` sample is removed.

## [1.15.0] - 2026-09-14

### Added

- **CAR / Clock with Adaptive Replacement (`Car`) -- the thirteenth cache member**
  (decisions/0028, D28; Bansal & Modha, "CAR: Clock with Adaptive Replacement", USENIX
  FAST'04): the CLOCK reformulation of ARC, on the same `LiteCache<K,V>` surface, so
  `new LiteLru(n)` swaps for `new Car(n)` type-checked. Completes the CLOCK-approximation
  trio: `ClockPro` is to `Lirs` what `Car` is to `Arc`.
  - Patent cleared before implementation (research spike): the direct CAR/CART filing
    US 2006/0069876 A1 (Bansal & Modha / IBM) was abandoned and never granted; the adjacent
    temporal-filtering patents US 7,058,766 and US 7,096,321 expired 2024; ARC's US 6,996,676
    expired 2024-02-22. Due-diligence, not legal advice; US filings only.
  - Two reference-bit CLOCK lists `T1` (recency) and `T2` (frequency) ride the shared
    `_next`/`_prev` columns, each walked by a hand (`_hT1`/`_hT2`); a per-slot `_st` byte
    carries bit0 reference + bit1 inT2. Two keys-only bounded ghosts `B1` (cap = capacity) and
    `B2` (cap = 2*capacity) via `CarHistory extends ArcGhost`, and an adaptive integer target
    `p` for `|T1|` that a B1 hit raises and a B2 hit lowers (ARC's self-tuning split, no knobs).
  - Hot path: a hit sets one reference bit (`_st |= CAR_REF`) -- 0 link writes, exactly 1 `_st`
    store, and never calls `_replace` (the Sieve/ClockPro 0-link-write hit; CAR never promotes
    on hit). Eviction: `_replace` rotates the T1/T2 hands, migrating a referenced page to T2 and
    clearing its bit, and evicts the first page with reference bit 0.
  - Honest bound (no ClockPro-S18-style overclaim): eviction is amortized O(1) per miss but
    worst-case O(capacity) reference-bit clears + link writes on a full-scan-then-insert. NO
    pinned constant miss+evict bound -- the t6 `carStream` worst-observed (109; tripwire 288) is
    a per-stream regression tripwire, not a cap, unlike `Lfu`'s proven <= 14 or `Mq`'s proven
    <= 33. Stated identically in code, decisions/0028, `llms.txt`, `GUIDE.md`, and `README.md`.
  - Directory invariants (validate.mjs term 17): `|T1|+|T2| == size <= capacity`,
    `|T1|+|B1| <= capacity`, total `<= 2*capacity`, a key in exactly one of T1/T2/B1/B2;
    resident value capacity stays exactly capacity. Gate CAR 0.00000 B/op strict `keys:'int'`
    (writes/hit links=0 state=1), `maxPauseMs` 0.000.
  - `Car` inherits TTL, zero-GC iteration (T2 MRU..LRU then T1, ghost-excluded, recency-neutral,
    fail-closed mid-walk), opt-in stats, and snapshot/restore (tag `m:'Car'`; both clocks +
    per-slot ref bits + T1/T2 membership + B1/B2 ghosts + adaptive `p` + both hand positions
    captured verbatim; fail-closed restore). CART deferred: its T1-vs-T2 entry rule is a tuning
    delta, not a distinct mental model -- the family is declared complete at thirteen members.

### Changed

- Roster twelve -> thirteen members. `validate.mjs` adds term 17 (CAR directory invariants).
  Test count 1427 -> 1449 (node:test). The dev-only `lite-perf-gate` gate extends 24 -> 26
  int-backed scenarios (all thirteen members x get-hit + put-churn). The repo-only `GUIDE.md`
  gains a `Car` decision-table row, a per-member mental model, and a synced mermaid branch;
  `README.md`, `llms.txt`, the bench (`benchmark/Bench.mjs`), and the demo extend to `Car`.

## [1.14.0] - 2026-09-14

### Added

- **MQ / Multi-Queue (`Mq`) -- the twelfth cache member** (decisions/0027, D27; Zhou,
  Philbin & Li, "The Multi-Queue Replacement Algorithm for Second Level Buffer Caches",
  USENIX ATC'01): frequency bands with logical-time decay, built for second-level / server
  buffer caches, on the same `LiteCache<K,V>` surface, so `new LiteLru(n)` swaps for
  `new Mq(n)` type-checked.
  - m=8 fixed LRU queues Q0..Q7 (D27.1) banded by `band(rc) = min(floor(log2(rc)), 7)` --
    the highest set bit of the reference count, clamped so `rc >= 128` saturates to Q7
    (D27.3, a fail-closed guard). Per-slot columns `_rc`/`_exq` (Float64) + `_qn` (Uint8);
    `_qHead`/`_qTail` `Int32Array(8)`; queues ride the shared `_next`/`_prev` columns.
  - Hot path (honest, D27.6): a hit bumps `_rc`, re-bands, and moves the block to its band's
    MRU -- 0 link writes when already the band MRU, else at most 5 (4..5) -- then stamps
    `_exq = _t + lifeTime` (lifeTime = capacity, on a logical clock `_t` SEPARATE from the
    wall-clock `ttl`, D27.2), then runs a fixed 7-step aging sweep demoting each band's idle
    tail one level toward Q0 (<= 4 links each). This is NOT a 0-write lazy-promotion hit.
    The per-access cost is a PROVEN non-exceedable <= 33 link writes (5 relink + 7x4 aging)
    + 3 stamps: reset-on-demote forbids cascade (a demoted block lands at the head of an
    already-visited lower band with a fresh `_exq`, never re-examined that sweep), a real
    constant like `Lfu`'s proven 14 -- pinned and measured by `CountedMq` (worst-observed 17
    links, max 3 demotions/sweep). It is the highest writes/hit in the family by design.
  - Eviction (D27.4): the LRU tail of the lowest non-empty queue, so a decayed once-hot
    block in Q0 is evicted before a still-hot high-band block. Bounded keys-only + refcount
    history `MqHistory` (`ArcGhost` + a parallel Float64 refcount ring, cap = capacity,
    drop-oldest, D27.5); a `put` of a key still in the history re-admits it at
    `rc = savedRc + 1` (an evicted rc-5 block re-enters at band(6) = Q2). Unlike `Lfu`, `Mq`
    forgets via logical decay. Gate MQ 0.00000 B/op strict `keys:'int'`, `maxPauseMs` 0.000.
  - `Mq` inherits TTL, zero-GC iteration, opt-in stats, and snapshot/restore (tag `m:'Mq'`;
    the 8 queues + the `_rc`/`_exq` columns + the logical clock + the Qout keys+refcounts
    captured verbatim, fail-closed on restore -- dropping any is a divergence caught by the
    t9 `mq-no-aging` / `mq-drop-rc` controls). `Mq` in the shipped bench (`MEMBERS` 11 -> 12),
    the demo (a `Mq` renderer), the `Mq` class on `Lru.d.ts`, and two new
    `test/perf/PerfGate.test.mjs` scenarios (`Mq` get-hit + put-churn, 22 -> 24).
- **`GUIDE.md` -- a repo-only "which member do I pick" field guide.** A decision table + a
  mermaid decision flowchart + a per-member mental model of all twelve members + measured,
  seeded bench numbers (capacity 256, seed 0x9e3779b9). Its golden rule is to MEASURE your
  own trace with `runBench` + `beladyOpt` rather than choose by theory, and it documents the
  honest finding that `ClockPro` scores 0% of Belady optimal on a pure loop (where `Lirs`
  hits 99.2% and `WTinyLfu` 94.4%) despite being the CLOCK approximation of LIRS -- theory
  is not measurement. Referenced from `README.md` and `llms.txt`; NOT in the npm tarball
  (`files[]` unchanged), consistent with `demo/` and `decisions/` being repo-only.

### Changed

- Cache-member roster eleven -> twelve (`LiteLru`, `Sieve`, `S3Fifo`, `WTinyLfu`, `Slru`,
  `TwoQ`, `Arc`, `Lirs`, `Lfu`, `ClockPro`, `LruK`, `Mq`); README + `llms.txt` positioning
  of `Mq` as the frequency-bands-with-logical-decay member for second-level buffer caches.
- `validate()` term 16, the torture harness, and an independent Multi-Queue oracle extended
  to `Mq`; `test/{Snapshot,Stats,Ttl,Iteration}.test.js` `MEMBERS` extended.
- Test count 1324 -> 1427 node:test cases (the new `Mq` boundary suite incl. hand-computed
  decay/victim/re-admit traces, plus the extended cross-member suites); the lite-perf-gate
  suite 22 -> 24 scenarios.

## [1.13.0] - 2026-09-14

### Added

- **LRU-K (`LruK`) -- the eleventh cache member** (decisions/0026, D26; O'Neil, O'Neil &
  Weikum, "The LRU-K Page Replacement Algorithm For Database Disk Buffering", SIGMOD'93):
  the original recency-of-recency policy -- evict by the K-th backward distance (the time of
  a page's K-th-most-recent reference), the freq-aware ancestor of 2Q and ARC -- on the same
  `LiteCache<K,V>` surface, so `new LiteLru(n)` swaps for `new LruK(n)` type-checked.
  - Fixed **K=2** (LRU-2), no knob and no correlated-reference period (D26.1, D26.6). A page
    is COLD until its 2nd reference, then WARM. Two `Float64Array` columns `_r0` (most-recent
    reference time) and `_r1` (2nd-most-recent = the K=2 backward distance) are allocated WITH
    the store, never per-key. A cold page's `_r1` is the `-Infinity` sentinel (D26.3: null is
    not zero -- a cold page is K-distance infinite and is evicted first).
  - Hot path: a warm hit slides `_r1=_r0` then stamps `_r0=++_t` -- 0 link writes, exactly 2
    stamps (the `Sieve`/`S3Fifo` 0-link-write headline). A cold->warm promotion unlinks the
    cold list and pushes the warm list -- at most 5 (2..5) link writes, non-exceedable (up to
    2 cold-detach + up to 3 warm-push; 5 is the reachable maximum, verified by static counting
    and pinned by `CountedLruK`) + 2 stamps. `has`/`peek` are reference-neutral.
  - Two disjoint lists (COLD, WARM) over the shared `_next`/`_prev` columns. Eviction: the
    cold tail first (O(1)); only when no cold page exists, a linear min-`_r1` scan over the
    warm list -- honestly O(size) reads, O(1) writes, NOT amortized O(1) and with no claimed
    bound (t6 measures the all-warm worst-observed scan length as a per-stream regression
    tripwire, never a cap; the true worst case is O(capacity)). Resident value capacity stays
    EXACTLY capacity (`|cold|+|warm|==size`).
  - Bounded keys-only non-resident history (`LruKHistory extends ArcGhost`, cap = capacity,
    drop-oldest, D26.4 -- an honest bounded variant like LIRS D23 / ClockPro D25.2, not the
    paper's unbounded timestamped HIST(p)); a `put` of a key still in it re-admits the page
    WARM at `_r1=_r0=++_t`. Gate LRUK strict zero-alloc on `keys:'int'` (0.00000 B/op;
    Map-backing 0.00032 B/op amortized), `maxPauseMs` 0.000.
  - `LruK` inherits TTL, zero-GC iteration (resident-only, warm->cold order), opt-in stats,
    and snapshot/restore (tag `m:'LruK'`; both lists + the `r0`/`r1` columns + the logical
    clock + the bounded history captured verbatim, fail-closed on restore -- dropping the
    `_r1` column, the clock, or the history is rejected as a divergence). A snapshot with COLD
    pages is not plain-JSON round-trippable (the `-Infinity` sentinel degrades to `null` under
    `JSON.stringify`, and restore then fails closed with a numeric-column error; `structuredClone`
    round-trips fine, D26.7).
- `LruK` in the shipped bench (`MEMBERS` 10 -> 11) and the policy-visualization demo (a
  `LruK` renderer drawing the cold/warm lists strictly from `dump()`); the `LruK` class on
  `Lru.d.ts`. Two new `test/perf/PerfGate.test.mjs` scenarios (`LruK` get-hit + put-churn,
  20 -> 22).

### Changed

- Cache-member roster ten -> eleven (`LiteLru`, `Sieve`, `S3Fifo`, `WTinyLfu`, `Slru`,
  `TwoQ`, `Arc`, `Lirs`, `Lfu`, `ClockPro`, `LruK`); README + `llms.txt` positioning of
  `LruK` as the original recency-of-recency policy (the ancestor of 2Q/ARC).
- `test/Snapshot.test.js` `MEMBERS` extended to all eleven members; `validate()` term,
  torture harness, and an independent LRU-K oracle extended to `LruK`.
- Test count 1212 -> 1324 node:test cases (the new `LruK` boundary suite incl. two
  hand-computed victim traces with a pure-LRU control, plus the extended cross-member suites).

## [1.12.0] - 2026-09-14

### Added

- **ClockPro (`ClockPro`) -- the tenth cache member** (decisions/0025, D25; Jiang, Chen &
  Zhang, "CLOCK-Pro: An Effective Improvement of the CLOCK Replacement", USENIX ATC'05):
  the CLOCK approximation of LIRS -- recency-of-recency (IRR) expressed on a clock instead
  of LIRS's lists + interleaved stack -- on the same `LiteCache<K,V>` surface, so
  `new LiteLru(n)` swaps for `new ClockPro(n)` type-checked.
  - One resident list threaded through the shared `_next`/`_prev` columns and walked as a
    clock (a NIL-terminated DLL with wrap-around hand advance, D25.1, so it reuses the
    family's shared iteration / conservation / snapshot machinery unchanged), three hands
    (hand_cold / hand_hot / hand_test), and a per-slot `_st` byte (bit0 hot/cold, bit1
    referenced, bit2 in-test).
  - Hot path is lazy promotion: a `get` (or `put`-update) sets ONE reference bit and does
    NOTHING structural -- 0 link writes, exactly 1 `_st` store (the same headline as
    `Sieve`/`S3Fifo`), pinned by the torture gate. `has`/`peek` are reference-neutral.
  - Eviction is honestly NOT a constant: amortized O(1) per miss (the classic CLOCK
    amortization) but worst-case O(capacity) `_st` writes on a full-scan-then-insert
    (~2*capacity; ~134 at cap 64, ~518 at 256, ~2054 at 1024). No constant miss+evict bound
    is pinned; the t6 per-stream worst-observed is a regression tripwire, not a cap.
  - The hot/cold split ADAPTS via an integer `_mHot` (D25.3): a `put` re-admitting a key
    still in the bounded non-resident history raises it, a test period ending without a hit
    lowers it. The non-resident history is a SEPARATE bounded keys-only ring (cap =
    capacity, drop-oldest, D25.2 -- an honest bounded variant like LIRS D23, not textbook
    interleaving). Resident value capacity stays EXACTLY capacity (only the split moves,
    D25.4). Gate CLOCKPRO 0.00032 B/op mixed churn (Map-backing amortization; `keys:'int'`
    strictly 0 B/op), `maxPauseMs` 0.000.
  - `ClockPro` inherits TTL, zero-GC iteration (resident-only, clock order newest->oldest),
    opt-in stats, and snapshot/restore (tag `m:'ClockPro'`; the full clock order + per-slot
    `_st` bits + all three hands + `_mHot` + the bounded history captured verbatim,
    fail-closed on restore -- dropping the hands, `_mHot`, or the test bits is rejected as a
    divergence).
- `ClockPro` in the shipped bench (`MEMBERS` 9 -> 10) and the policy-visualization demo (a
  `ClockPro` renderer drawing the clock + hands + hot/cold strictly from `dump()`); the
  `ClockPro` class on `Lru.d.ts`.
- **`@zakkster/lite-perf-gate` integrated as a node:test zero-allocation gate** (dev-only
  devDependency; zero RUNTIME dependencies unchanged). New `npm run test:perf` script
  (`node --expose-gc --max-semi-space-size=4 --test test/perf/PerfGate.test.mjs`), folded
  into `npm run verify` and deliberately outside the `npm test` (`test/*.test.js`) glob so
  the main suite is untouched. 20 int-backed scenarios (all ten members x get-hit +
  put-churn) gated at 0 scavenges / 0 old-gen / 0 arrayBuffers across N=200000 and
  k*N=1.6M, a `mustFail` self-test proving the gate has teeth, and a writes-per-hit
  cross-check pinned to the torture harness constants. Complements torture t6 (the hard perf
  gate covers `keys:'int'` strict zero-alloc; Map-backing is amortized, still covered by
  t6). Ships nothing to the tarball (`test/` is not in `files[]`).

### Changed

- Cache-member roster nine -> ten (`LiteLru`, `Sieve`, `S3Fifo`, `WTinyLfu`, `Slru`,
  `TwoQ`, `Arc`, `Lirs`, `Lfu`, `ClockPro`); README + `llms.txt` positioning of `ClockPro`
  as the CLOCK approximation of LIRS.
- `test/Snapshot.test.js` `MEMBERS` extended to all ten members (was the original seven).
- Test count 1155 -> 1212 node:test cases (the new `ClockPro` boundary suite + the extended
  snapshot suite); torture harness, oracle, and `validate()` term extended to `ClockPro`.

## [1.11.0] - 2026-09-13

### Added

- **LFU (`Lfu`) -- the ninth cache member** (decisions/0024, D24; Shah, Matani &
  Kumar, "An O(1) algorithm for implementing the LFU cache eviction scheme", 2010):
  EXACT Least-Frequently-Used at O(1), the exact-frequency counterpart to `WTinyLfu`'s
  approximate Count-Min sketch, on the same `LiteCache<K,V>` surface, so
  `new LiteLru(n)` swaps for `new Lfu(n)` type-checked.
  - A doubly-linked list OF frequency buckets, each bucket a doubly-linked list of keys
    at that exact frequency; the frequency lives on the bucket. Within a bucket the order
    is recency (LRU tie-break): a new key (freq 1) and a just-promoted key attach at MRU,
    eviction takes the LRU key of the lowest-frequency bucket.
  - Buckets come from a preallocated pool sized to capacity: a `_bFreq` `Float64Array`
    (exact counts to 2^53, no `Int32` wrap) + `_bNext`/`_bPrev`/`_bHead`/`_bTail`
    `Int32Array` columns + a `_bFree` stack. A bucket is NEVER allocated with `new` on the
    hot path; pool exhaustion is provably unreachable (live buckets partition the
    `<= capacity` resident keys) and fail-closed regardless.
  - Hot path is zero-ALLOCATION but NOT zero-write: a frequency bump relinks a key across
    buckets -- fast-path relabel 1 write, worst-case relink 14 (a non-exceedable bound,
    pinned by the torture gate). `put(update)` counts as a hit; `has`/`peek` are
    frequency-neutral. Gate LFU 0.00032 B/op mixed churn (Map-backing amortization;
    `keys:'int'` strictly 0 B/op), `maxPauseMs` 0.000.
  - `Lfu` inherits TTL, zero-GC iteration (ascending frequency, MRU->LRU within each
    bucket), opt-in stats, and snapshot/restore (tag `m:'Lfu'`; exact per-bucket
    frequencies + the full key ordering captured verbatim, fail-closed on restore -- a
    dropped or compacted frequency is rejected as a divergence).
- `Lfu` in the shipped bench (`MEMBERS` 8 -> 9) and the policy-visualization demo (a
  `Lfu` renderer drawing the frequency buckets strictly from `dump()`); the `Lfu` class on
  `Lru.d.ts`.

### Changed

- Roster docs eight -> nine members (README, `llms.txt`). The exact-LFU need now points
  at `Lfu`; `WTinyLfu` stays positioned as approximate frequency-ADMISSION (aged Count-Min
  sketch), and a "Choosing a member" row distinguishes exact `Lfu` from approximate
  `WTinyLfu`.
- Test suite 1110 -> 1155 `node:test` cases (a 44-case `test/Lfu.test.js` boundary suite
  covering the LFU law + LRU tie-break, exact frequency, TTL, iteration order, snapshot
  round-trip + fail-closed, and degenerate caps 1..4 / keys / values).
- Torture harness extended for `Lfu`: an independent from-scratch differential oracle
  (`test/torture/oracles/lfu.mjs`), tiers t0/t2/t5/t6 (Gate LFU zero-alloc + pinned
  writes-per-hit)/t7 (soak: a 4096-cycle dump/restore + `clear()` leg with a standalone
  bucket-pool free-length == capacity assertion)/t9 (two must-fail controls,
  `lfu-approx-freq` and `lfu-freq-dropped`), and a `validate()` conservation term 13
  (bucket list ascending, pool conserved `live + free == capacity`, column byteLengths
  fixed).

## [1.10.0] - 2026-09-13

### Added

- **LIRS (`Lirs`) -- the eighth cache member** (decisions/0023, D23; Jiang & Zhang,
  SIGMETRICS'02): eviction by recency-of-recency (inter-reference recency). A LIR set
  + a resident-HIR list `Q` + a bounded non-resident history, on the same
  `LiteCache<K,V>` surface, so `new LiteLru(n)` swaps for `new Lirs(n)` type-checked.
  - Hot path is strict zero-alloc: one `_st` byte per slot (bit0 LIR, bit1 in-stack);
    a LIR hit at the stack top early-returns with 0 writes, an interior hit relinks 5
    (pinned by the torture gate). `L_hir = max(1, round(capacity * 0.01))`,
    `L_lir = capacity - L_hir`. Resident value capacity stays EXACTLY capacity
    (`|LIR| + |resident HIR| == size`); the non-resident history is bounded separately.
  - The non-resident history is a keys-only ring generalizing the ARC ghost
    (`class LirsHistory extends ArcGhost`, cap = capacity, drop-oldest). Because it is a
    SEPARATE ring rather than interleaved into the linked stack, a single access prunes
    at most `L_hir` -- `O(0.01*capacity)`, not the textbook `O(capacity)` (measured
    adversarial max prune length 41 at capacity 4096, worst-case op ~0.02 ms,
    `maxPauseMs` 0.000). This makes `Lirs` a BOUNDED LIRS VARIANT, not bit-exact
    textbook LIRS: membership is eviction-recency (ring) rather than stack-position. The
    deviation is documented in D23 with the rejected unbounded-stack alternative on record.
  - Best scan/loop resister in the family: on a loop larger than capacity, `Lirs`
    holds 99.2% of the Belady optimum (bench `loop`), where every other member scores
    ~0; `scan` 100% of optimal. `Lirs` inherits TTL, zero-GC iteration, opt-in stats,
    and snapshot/restore (tag `m:'Lirs'`; stack + `Q` + `_st` + history captured
    verbatim, fail-closed on restore). `has`/`peek` are neutral.
- `Lirs` in the shipped bench (`MEMBERS` 7 -> 8) and the policy-visualization demo
  (a `Lirs` renderer drawn strictly from `dump()`); the `Lirs` class on `Lru.d.ts`.

### Changed

- Three-place version sync to 1.10.0 (`VERSION`, `package.json`, `llms.txt`), plus the
  seven existing member `VERSION` asserts and the README constants table.
- Roster documentation updated from seven to eight members across `README.md` and
  `llms.txt` (members list, uniform surface, iteration order, "Choosing a member" guide).
- Test suite 1077 -> 1110 (`test/Lirs.test.js` boundary suite + the LIRS differential
  oracle, torture tiers t0/t2/t5/t6/t7/t9, and the two new must-fail controls); Gate
  LIRS 0.00000 B/op on the hot path, dump/restore round-trip exact.

## [1.9.1] - 2026-09-13

### Changed

- **The visualization demo fails closed** (S15): when `/trace.json` cannot be loaded --
  the page opened as a static file, via an IDE static preview, or with the Node server
  down -- `demo/` now renders an actionable message ("run `npm run demo:serve` and open
  http://localhost:8013/; a static file or IDE preview will not work: `/trace.json` is a
  dynamic route") instead of a permanent "loading...". The fetch path is a pure,
  never-throwing `fetchTrace()` seam that returns a payload only when it is well-shaped
  (array `trace`, integer `cap >= 1`, `opt.hitRate` numeric); a rejected fetch, a non-OK
  status, an `{error}` body, or a malformed 200 all fail closed. The render path is
  unchanged (still drawn strictly from `dump()`).
- **Docs**: README "Watch the policies" states the demo must run via its Node server (not
  a static file or IDE preview, because `/trace.json` is a dynamic route and ES modules
  need an http origin); a new "Choosing a member" guide maps workload to member and directs
  to the bench tool for real measurement.
- Three-place version sync to 1.9.1 (`VERSION`, `package.json`, `llms.txt`), plus the seven
  member `VERSION` asserts and the README constants table.

The shipped surface is unchanged from 1.8.0/1.9.0: `Lru.js`, `Lru.d.ts`, and
`benchmark/Bench.mjs` are byte-identical, so the published tarball differs from 1.9.0 only
in version strings and documentation. The demo is a dev artifact excluded from the tarball.

## [1.9.0] - 2026-09-13

### Added

- **Animated policy-visualization demo** (decisions/0022, D22; ROADMAP S13): a
  never-shipped in-repo `demo/` that steps ONE seeded trace through all seven members
  and renders each member's structure live, drawn STRICTLY from that member's `dump()`
  snapshot -- the snapshot is the visualization model, with no shadow re-implementation
  of policy mechanics -- and a running "% of Belady optimal" readout per member.
  - `demo/Visualize.mjs` (a headless engine and the `npm run demo` entry; members are
    built with a fixed clock so frames are deterministic), `demo/renderers.mjs` (one
    renderer per member, each projecting only fields present in `dump()`),
    `demo/visuals.html` (the browser page; the full redraw is throttled while
    op-stepping runs at the speed control), and `demo/serve.mjs` (a zero-dependency Node
    server that computes the trace and Belady OPT server-side and serves the page;
    fail-closed on bad query params, static route confined to the repo root, `/`
    redirects to the page).
  - `demo/Demo.test.mjs`: 24 dev-only `node:test` cases (run via
    `node --test demo/Demo.test.mjs`; NOT part of `npm test`) proving the rendered model
    deep-equals `dump()` for all seven members, live hit/miss parity versus a
    from-scratch replay, the `pctOptimal` formula (fail-closed to 0 when the optimum is
    0), bounded allocation, determinism, and the `/` entry-URL redirect.

### Changed

- Three-place version sync to 1.9.0 (`VERSION`, `package.json`, `llms.txt`), plus the
  seven member `VERSION` asserts and the README constants table.
- The shipped surface is unchanged from 1.8.0: `Lru.js`, `Lru.d.ts`, and
  `benchmark/Bench.mjs` are byte-identical, so the published tarball differs from 1.8.0
  only in version strings and documentation. The demo is a dev artifact excluded from
  the tarball (the pack gate asserts `demo/` absent), and zero runtime dependencies are
  preserved (the browser path imports only `../Lru.js`).

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
