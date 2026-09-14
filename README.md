# @zakkster/lite-lru

> A zero-GC cache FAMILY under one `LiteCache<K,V>` surface: a classic LRU reference member and the modern SIEVE headline, one-line swappable, tree-shakeable to a single policy, with a shipped bench + Belady OPT tool so you stop guessing your eviction policy and measure it on your own trace.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-lru.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-lru)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-lru?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-lru)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-lru?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-lru)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-lru?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-lru)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The cache family the ecosystem was missing

Every JavaScript cache picks ONE eviction policy for you and hides it. `lru-cache` is LRU, forever; `quick-lru` is a naive two-Map swap, forever. But the RIGHT policy is a property of YOUR access pattern, not of the library -- classic LRU thrashes on a scan, a FIFO wastes memory on a skewed workload, and on a well-provisioned cache the per-hit bookkeeping is pure overhead. `lite-lru` ships a **curated family of policies behind one identical interface**, so switching is a one-line swap, plus **the measurement tool that tells you which one to pick**: replay your trace, get each policy's hit ratio as a percentage of Belady's clairvoyant optimum.

```bash
npm install @zakkster/lite-lru
```

```js
import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro, LruK, Mq, Car } from '@zakkster/lite-lru';

// Same surface, different eviction policy. Swap the constructor, nothing else.
const cache = new LiteLru(3);            // classic recency (the reference member)
// const cache = new Sieve(3);           // <- modern lazy-promotion FIFO (the headline)
// const cache = new S3Fifo(3);          // <- admission-controlled FIFO + ghost queue
// const cache = new WTinyLfu(3);        // <- frequency admission (window + SLRU + Count-Min)
// const cache = new Slru(3);            // <- Segmented LRU (probation FIFO + protected LRU)
// const cache = new TwoQ(3);            // <- 2Q (A1in FIFO + Am LRU + A1out ghost)
// const cache = new Arc(3);             // <- Adaptive Replacement Cache (self-tuning, no knobs)
// const cache = new Lirs(3);            // <- LIRS (recency-of-recency; best loop/scan resistance)
// const cache = new Lfu(3);             // <- EXACT LFU (O(1) least-frequently-used, LRU tie-break)
// const cache = new ClockPro(3);        // <- CLOCK-Pro (recency-of-recency on a clock; 0-link-write hit, adaptive)
// const cache = new LruK(3);            // <- LRU-K (K=2; the original recency-of-recency; evict by K-th backward distance)
// const cache = new Mq(3);              // <- Multi-Queue (m=8 frequency bands + logical-time decay; evict lowest queue)
// const cache = new Car(3);             // <- CAR (Clock with Adaptive Replacement; ARC on clocks; 0-link-write hit, self-tuning)

cache.put('a', 1);
cache.put('b', 2);
cache.put('c', 3);
cache.get('a');                          // 'a' is now most-recently-used
cache.put('d', 4);                       // at capacity -> evicts the LRU ('b')

cache.has('b');                          // false (evicted; has() never touches recency)
cache.get('a');                          // 1  (still hot)
cache.size;                              // 3  (never exceeds capacity)
```

Then measure, do not guess:

```bash
npm run bench     # per-policy hit ratio + % of Belady OPT + writes/hit on seeded traces
```

One `LiteCache<K,V>` surface, `get`/`put`/`has`/`peek`/`delete`/`clear`, all O(1), zero allocation on every hot path after construction. `import { Sieve }` alone drops `LiteLru`'s body from your bundle (`sideEffects: false`). Integer keys opt into a strict-zero-alloc typed-array backing.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [LRU vs SIEVE vs S3-FIFO -- which member, and when](#lru-vs-sieve-vs-s3-fifo----which-member-and-when)
- [Choosing a member](#choosing-a-member)
- [API reference](#api-reference)
  - [The members](#the-members)
  - [Construction options](#construction-options)
  - [TTL -- opt-in, lazy expiry](#ttl----opt-in-lazy-expiry)
  - [Iteration -- zero-GC keys/values/entries](#iteration----zero-gc-keysvaluesentries)
  - [Stats -- opt-in runtime counters](#stats----opt-in-runtime-counters)
  - [Snapshot -- dump / restore](#snapshot----dump--restore)
  - [The bench tool](#the-bench-tool)
  - [Constants](#constants)
- [Composability](#composability)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Measure & Trust](#measure--trust)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

---

## Why this exists

Two problems no small cache library solves at once:

1. **The policy is the caller's, not the library's.** LRU is the right answer for genuinely unpredictable, recency-skewed, chronically-at-capacity workloads -- the case it was designed for. It is the WRONG answer for a scan (a sequential sweep larger than the cache evicts its own future), and it is overhead for a cache sized at or above its working set (recency order is consulted only on eviction; if you never evict, every move-to-front is wasted work). `lite-lru` treats the policy as a swappable choice: `LiteLru` for recency, `Sieve` for one-hit-wonder-heavy web/CDN traffic, `S3Fifo` for skewed traffic with a heavy one-hit-wonder tail, more members to come -- all `class X implements LiteCache<K,V>`, so `new LiteLru(n)` swaps for `new Sieve(n)` or `new S3Fifo(n)` and nothing else in your code changes.

2. **"Which policy?" is folklore, not measurement.** Neither incumbent can tell you how close you are to the theoretical best. `lite-lru` ships the measurement tool the family is built around: it replays a trace against every member AND against Belady's OPT -- the clairvoyant offline optimum that evicts the entry whose next use is farthest away -- and reports each policy's hit ratio as a **percentage of optimal**. "SIEVE hit 66.8%" is ambiguous; "SIEVE hit 66.8%, which is 89.8% of the offline optimum on this trace" is actionable.

The honest competitive read: `lru-cache` is already typed-array-backed and feature-maximal (TTL, size-aware, async fetch, dispose); "we are the zero-GC LRU" would be false against it, so that is never the pitch. `lite-lru` wins on a different axis -- a family under one interface, tree-shakeable to a sub-policy for edge/serverless/browser/game budgets, and the shipped measurement tool neither incumbent offers.

---

## What you get

- **`LiteLru`** -- the classic Least-Recently-Used reference member: a `Map` (or a typed-array index for integer keys) fused with an intrusive, preallocated doubly-linked list. `get` and `put` promote to most-recently-used; at capacity a new key evicts the LRU tail. The honest floor every other member is measured against.
- **`Sieve`** -- the modern headline (Zhang et al., NSDI'24, "SIEVE is simpler than LRU"): a lazy-promotion FIFO ring with one visited bit per entry and a single moving hand. A hit sets the bit and does **nothing structural** -- zero relinks -- where classic LRU rewrites a small constant number of links. At capacity the hand sweeps FIFO order, grants each visited entry one second chance, and evicts the first unvisited entry in place.
- **`S3Fifo`** -- the admission-controlled member (Yang et al., SOSP'23, "FIFO queues are all you need for cache eviction"): quick-demotion + lazy-promotion over a small probation FIFO, a main FIFO, and a bounded keys-only ghost queue. A hit sets a visited bit and does **nothing structural** (zero relinks). Newcomers enter the small queue; a proven entry graduates to main, an unproven one is evicted with its key remembered in the ghost, and a key seen again while in the ghost is admitted straight to main. Scan-resistant, and often closer to Belady OPT than LRU on skewed/web traffic.
- **`WTinyLfu`** -- the frequency-admission member (Einziger et al., "TinyLFU"; the Caffeine approach): a small admission WINDOW (an LRU, ~1% of capacity) in front of a segmented main cache (SLRU: a probation segment + a protected segment), gated by a fixed 4-row 4-bit Count-Min frequency sketch. `get`/`put` bump the sketch and promote within the segment (a probation hit is promoted to protected). At capacity the window's victim is admitted into the main cache only if the sketch estimates it MORE frequent than the main cache's victim; ties reject (favor the incumbent). A one-hit-wonder never out-frequencies the proven-hot set -- scan- AND frequency-resistant, the best fit for skewed (Zipf) traffic. A hit does slightly MORE work than SIEVE/S3-FIFO (a segment relink + a sketch bump) -- still zero allocation.
- **`Slru`** -- the simplest scan-resistant baseline (Segmented LRU): a probation FIFO (~20%) in front of a protected LRU (~80%). A newcomer enters probation; the **promote-on-2nd-hit** rule holds -- `get(X)` once leaves X in probation, `get(X)` twice promotes X to protected (a promotion that overflows protected demotes its LRU tail back to probation). A protected hit moves to protected MRU. Eviction ALWAYS prefers the probation tail, so a cap-sized distinct-key scan evicts **zero** protected entries. The textbook "here is what SIEVE/S3-FIFO/W-TinyLFU buy over the obvious one."
- **`TwoQ`** -- the full 2Q (Johnson & Shasha, VLDB'94): an A1in FIFO (~25%) + an Am LRU + a fixed, keys-only A1out ghost of keys evicted from A1in. A newcomer enters A1in unless the key is in the ghost (a second sighting) -- then it goes straight to Am and is consumed from the ghost (the only path into Am). An A1in hit does **nothing** (pure FIFO probation); an Am hit moves to Am MRU. At capacity the reclaim step evicts the A1in tail (recording its key in the ghost) when A1in is over its target, else the Am LRU (not ghosted). A one-hit-wonder flood churns A1in only, never displacing Am.
- **`Arc`** -- the Adaptive Replacement Cache (Megiddo & Modha, FAST'03; patent expired), the **no-tuning adaptive** member: a RECENT list T1 (seen once) + a FREQUENT list T2 (seen 2+), plus two bounded keys-only ghosts (B1, B2) that drive a single self-tuning integer `p` -- the T1/T2 split target. A hit promotes to T2. A miss whose key is remembered in B1 means "a recent page was dropped too soon" and raises `p`; in B2, "a frequent page was dropped too soon" and lowers `p`. No knobs -- it adapts between recency- and frequency-friendly phases on its own. The RESIDENT capacity stays EXACTLY `capacity`; only the split adapts, never the total.
- **`Lirs`** -- LIRS (Jiang & Zhang, SIGMETRICS'02), the **recency-of-recency** member and the strongest loop/scan resister in the family: eviction is driven by a block's IRR (inter-reference recency -- the count of DISTINCT blocks referenced between its last two accesses), not plain recency. Low-IRR blocks form the hot **LIR set**; high-IRR blocks are **HIR** (a small resident reserve = list Q, the eviction candidates, plus non-resident metadata). A returning key whose metadata is still remembered is re-admitted as LIR, so a loop LARGER than capacity keeps its hot set where LRU thrashes it (bench loop = 99.2% of Belady OPT, where the other members are ~0%). Split: `L_hir = max(1, round(capacity*0.01))` resident-HIR slots, `L_lir = capacity - L_hir`; RESIDENT capacity stays EXACTLY `capacity`. **Honest deviation (decisions/0023):** the non-resident history is a SEPARATE bounded keys-only ring (drop-oldest at `capacity`) rather than metadata interleaved in the stack, so this is a bounded LIRS variant (eviction-recency membership, and stack pruning bounded to `O(L_hir)` -- measured 41 at cap 4096, never `O(capacity)`), NOT textbook-exact LIRS.
- **`Lfu`** -- the **exact frequency** member (Shah-Matani O(1) LFU): eviction by EXACT access count, with an **LRU tie-break** within a frequency. A doubly-linked list OF frequency buckets (each a recency list of the keys at that exact count) keeps get/put/increment/evict all **O(1)** -- not O(log n), no heap. A hit relinks the key to the freq+1 bucket (zero-ALLOCATION but not zero-write -- a bucket relink, pinned at <= 14 index stores/hit; a single-key bucket with no freq+1 neighbour is relabelled in place at 1 write). Frequencies are stored per bucket in a `Float64Array` (**exact to 2^53**, no 2^31 wrap). `put`-update counts as a hit; `has`/`peek` are frequency-neutral. This is the EXACT counterpart to `WTinyLfu`'s approximate sketch: reach for it when you need a **provable** "the least-frequently-used key is the victim," not a statistical estimate (audits, quota fairness, deterministic replay).
- **`ClockPro`** -- the **CLOCK approximation of LIRS** (Jiang, Chen & Zhang, USENIX ATC'05): recency-of-recency on a CLOCK. One circular list of resident pages + per-page reference bits + three moving hands (HAND_cold eviction, HAND_hot demotion, HAND_test test-period expiry) approximate LIRS's inter-reference-recency ordering, so -- like Sieve/S3-FIFO -- a hit sets a single reference bit and moves NOTHING (**0 link writes, 1 state store** -- the headline; pinned in the gate). The hot/cold split SELF-TUNES via an integer target (`_mHot`), raised when a page still in the bounded non-resident history is re-admitted and lowered when a test page expires unreferenced; RESIDENT capacity stays EXACTLY `capacity` (only the split moves). This is the exact/approximate pair with `Lirs` the way `Lfu`/`WTinyLfu` are for frequency: `Lirs` is the exact IRR ordering with a multi-write stack move on a hit and a fixed reserve; `ClockPro` is the clock approximation with the family's cheapest hot path and no knobs. **Honest deviation (decisions/0025):** the non-resident test-page history is a SEPARATE bounded keys-only ring (drop-oldest at `capacity`), NOT interleaved into the clock -- a bounded ClockPro variant (mirroring `Lirs`), NOT textbook-exact.
- **`LruK`** -- LRU-K (O'Neil, O'Neil & Weikum, SIGMOD'93), K=2, the **original recency-of-recency** member: eviction by the **K-th backward distance** -- the time of a page's K-th-most-recent reference -- so a page must prove itself with `>= K` references before it is protected. Fixed **K=2** (LRU-2), no knob and no correlated-reference period (CRP). A page is **cold** until its 2nd reference, then **warm**; two `Float64` columns track the two most-recent reference times (`_r0`, `_r1`), allocated WITH the store (never per-key). The hot path is cheap and byte-countable: a **warm hit is 0 link writes + 2 stamps**; a **cold->warm promotion is at most 5 (2..5) link writes, non-exceedable** (up to 2 cold-detach + up to 3 warm-push; 5 is the reachable maximum) **+ 2 stamps**. A cold page's `_r1` is the `-Infinity` **sentinel** (null is not zero -- a cold page is K-distance *infinite*, so it is evicted first). Eviction takes the **oldest cold page first** (O(1)); only when none exists it **linearly scans the warm list for the smallest `_r1`** -- honestly **O(size) reads**, NOT amortized O(1) and NO claimed bound (the gate measures the all-warm worst-observed scan length as a per-stream regression tripwire, never a cap). vs LRU: `put X,Y,Z; get Y,Z,X` -> the next insert evicts **X** (its 2nd-most-recent reference is furthest in the past), where classic LRU evicts **Y**. **Honest deviation (decisions/0026):** the non-resident history is a bounded keys-only ring (drop-oldest at `capacity`) that re-admits a returning page as WARM, rather than the paper's unbounded timestamped `HIST(p)` -- a bounded LRU-2 variant (mirroring `Lirs`/`ClockPro`), NOT textbook-exact.
- **`Mq`** -- Multi-Queue (Zhou, Philbin & Li, USENIX ATC'01), **m=8**: rank by **frequency band** with **logical-time decay**. Each block carries a reference count; its band is `q = min(floor(log2(rc)), 7)` -- the highest set bit of `rc`, clamped -- across 8 LRU queues Q0..Q7 threaded through the shared columns. A hit bumps the count, moves the block to the **MRU of its band** and stamps a logical expire time (`_t + lifeTime`, lifeTime = capacity, on a LOGICAL clock SEPARATE from the wall-clock `ttl`); every access then runs a **FIXED 7-step aging sweep** that demotes each band's idle tail **one level toward Q0**, so a once-hot block that goes cold decays and becomes evictable. Eviction takes the **LRU tail of the lowest non-empty queue** (O(1)). A bounded keys-only **+ refcount** Qout (drop-oldest at `capacity`) re-admits a returning block at its remembered frequency (an evicted rc-5 block re-enters at Q2). **Honest hot path (decisions/0027):** unlike Sieve/ClockPro/LruK-warm, an MQ hit is **NOT a 0-write lazy-promotion hit** -- moving to the band MRU is real list surgery (**0 link writes** when already the band MRU, else **at most 5 (4..5)**), PLUS the fixed aging sweep (<= 7 demotions x <= 4 = 28). The whole per-access cost is a **PROVEN non-exceedable <= 33 link writes + 3 metadata stamps** (reset-on-demote forbids cascade -- pinned + measured by `CountedMq`, worst-observed 17), never a false zero. **Honest deviation:** the Qout is bounded keys-only + refcount (drop-oldest), NOT the paper's unbounded descriptor history -- a bounded MQ variant (mirroring `Lirs`/`ClockPro`/`LruK`).
- **`Car`** -- CAR, Clock with Adaptive Replacement (Bansal & Modha, USENIX FAST'04). The **CLOCK reformulation of ARC** -- ARC's exact semantics (two lists T1 recent / T2 frequent, keys-only ghosts B1/B2, one adaptive integer `p`, no knobs) realized on **reference-bit clocks** instead of LRU lists, so a HIT sets **ONE reference bit and moves NOTHING** (the Sieve/S3-FIFO/ClockPro **0-link-write** hit) where ARC relinks to the T2 MRU. Two circular clocks ride the shared `_next`/`_prev` columns (`_st` bit0 = reference, bit1 = inT2), with a hand per clock. **REPLACE** rotates the hands: a referenced page earns a second chance -- a T1 survivor MIGRATES to T2 (its ref cleared), a T2 survivor rotates -- and the first UNREFERENCED page found is the victim, demoted to B1 (from T1) or B2 (from T2). A B1 (recent) ghost hit RAISES `p`, a B2 (frequent) ghost hit LOWERS it; a ghost re-admit re-enters T2. Completes the **CLOCK-approximation trio** (SIEVE / ClockPro / CAR), sibling to `ClockPro` (the CLOCK approximation of LIRS). **Honest cost (decisions/0028):** the HIT is a genuine 0-link-write, exactly-1-`_st`-store reference-bit set (pinned + measured by `CountedCar`); the miss+EVICT is **amortized O(1)** (classic CLOCK) but **worst-case O(capacity)** reference-bit clears on a full-scan-then-insert -- **NO pinned constant bound**, exactly like ClockPro. **Honest deviation:** B1/B2 are bounded keys-only ghosts (|T1|+|B1| <= c, directory total <= 2c), mirroring the family's bounded-history members.
- **One `LiteCache<K,V>` surface** -- all thirteen members expose exactly `get` / `put` / `has` / `peek` / `delete` / `clear`, plus `size` and `capacity`. The recency/lazy-promotion/admission/adaptive/frequency difference is INTERNAL. Types ship in [`Lru.d.ts`](./Lru.d.ts); the interface is the type-checked contract that makes the one-line swap safe.
- **`Bench.mjs`** -- a runnable ESM tool AND an importable module: `runBench(opts)` and `beladyOpt(trace, capacity)`. Feed it a trace, get per-policy hit ratio, writes-per-hit, machine-local ns/op, and percentage of Belady OPT.
- **A `keys: 'int'` backing** -- opt in and the keyed index becomes an open-addressed typed-array table for STRICT zero allocation (even the index never allocates), with a fail-closed door for 32-bit signed integer keys.
- **A zero-GC `onEvict` hook** -- fired once per eviction with the evicted `(key, value)`, e.g. to return the value to a pool.

---

## LRU vs SIEVE vs S3-FIFO -- which member, and when

<details>
<summary>What each member does on a hit and at eviction, and the workload it is for.</summary>

All three members share the exact same surface and the same hit/miss semantics. They differ only in what happens on the hot path and how the victim is chosen.

### `LiteLru` -- classic recency

`get(key)` and `put(key, value)` promote the entry to the most-recently-used end of a doubly-linked list; `has` and `peek` do not touch recency. At capacity, a new key evicts the least-recently-used (tail) entry and reuses its slot in place. This is the right policy when reuse really is governed by recency and the cache is chronically at capacity -- and it is the reference member and the differential oracle every other member is checked against.

The cost is unconditional: every hit relinks the list. Re-hitting the entry that is ALREADY the MRU head early-returns at zero writes; an interior or tail re-hit relinks a small constant. That per-hit work only pays off at an eviction, and only if recency predicts reuse -- so on a cache that rarely evicts, or a predictable pattern, it is net overhead.

### `Sieve` -- lazy-promotion FIFO (the headline)

`get(key)` sets a single visited byte and returns -- no relink, the hand untouched. New entries insert at the head of FIFO order, unvisited. At capacity the hand sweeps from its current position (it persists across evictions): a visited entry gets a second chance (bit cleared, hand advances), and the first unvisited entry is the victim, evicted in place. `has` and `peek` are visited-neutral.

Because a hit does nothing structural and a fresh key enters unvisited, a burst of distinct one-hit-wonder keys sweeps straight back out without displacing the proven-hot set -- SIEVE is scan-resistant where LRU is not, at a fraction of the per-hit writes. It matches or beats LRU on real web/CDN traces. Reach for it on one-hit-wonder-heavy or skewed traffic, and anywhere per-hit GC pressure matters (realtime, game loops).

### `S3Fifo` -- admission-controlled FIFO

`get(key)` sets a single visited byte and returns -- no relink (the same 1-bit hit as SIEVE). New keys enter a small probation FIFO (~10% of capacity) unvisited, UNLESS the key is currently in a bounded keys-only ghost queue of recently-evicted keys -- a second sighting -- in which case it is admitted straight to the main FIFO. At capacity one eviction step runs: the small queue's oldest entry either graduates to main (if it was proven, i.e. visited) or is evicted with its key recorded in the ghost; otherwise the main queue's oldest entry gets one second chance or is evicted. `has` and `peek` are visited-neutral.

The ghost is what sets S3-FIFO apart: a one-hit-wonder is demoted out of the small queue almost immediately (quick demotion), while a key that proves itself -- either by being visited or by reappearing while still in the ghost -- reaches the long-lived main queue (lazy promotion). This makes S3-FIFO strongly scan-resistant and, on skewed and web/CDN traffic, frequently closer to Belady OPT than either LRU or SIEVE. Reach for it when your working set is skewed with a heavy one-hit-wonder tail.

Pick with the [bench tool](#measure--trust), not by intuition -- the whole point of the family is that this is a measurable choice on YOUR trace.

</details>

---

## Choosing a member

A starting point by workload -- not a verdict. Every member shares the same surface, so the choice is a one-line swap.

> For the long form -- a decision flowchart, measured bench numbers (including where a member's paper pedigree does *not* predict its number on a real trace), the write-cost axis, and a one-paragraph mental model of all thirteen members -- see **[GUIDE.md](./GUIDE.md)** (repo only).

| Your workload | Start with | Why |
| --- | --- | --- |
| Strong temporal locality; the reference / floor | `LiteLru` | Classic recency; the differential oracle every other member is checked against. |
| One-hit-wonder-heavy web / CDN traffic | `Sieve` | Lazy-promotion FIFO: 1 visited bit per hit, scan-resistant, matches or beats LRU on real web traces. |
| General-purpose with scan resistance | `S3Fifo` | Quick-demotion + a bounded ghost queue; strong hit ratio at near-zero per-hit writes. |
| Skewed / Zipf popularity where frequency matters (APPROXIMATE) | `WTinyLfu` | Admission control via a fixed Count-Min sketch (sub-linear memory, probabilistic frequency); the best fit when a few keys dominate and an estimate is enough. |
| EXACT least-frequently-used required (audits, quota fairness, deterministic replay) | `Lfu` | O(1) exact-frequency eviction with an LRU tie-break -- a provable "the least-frequently-used key is the victim," not a sketch estimate. The exact counterpart to `WTinyLfu`. |
| A simple, textbook scan-resistant baseline | `Slru` | Probation + protected LRU segments, promote on the 2nd hit; the honest baseline the modern trio is measured against. |
| A one-hit filter with a recently-evicted memory | `TwoQ` | A1in FIFO for newcomers + Am LRU for the hot set + a keys-only A1out ghost that admits a re-seen key straight to Am; the other textbook scan-resistant baseline. |
| Phase-changing traffic with no time to tune | `Arc` | Self-tuning recency/frequency split, no knobs. |
| Loop / scan-heavy access (loops LARGER than capacity, repeated full scans) | `Lirs` | Eviction by recency-of-recency (IRR): keeps a stable hot LIR set through a loop that thrashes LRU. The best loop-resister in the family (bench loop = 99.2% of Belady OPT, where the others are ~0%). Ships a bounded non-resident history (an honest, documented deviation from textbook LIRS -- see below). |
| Loop/scan resistance with the CHEAPEST possible hot path + no tuning | `ClockPro` | The CLOCK approximation of LIRS: recency-of-recency on a clock with a 0-link-write hit (a reference bit, like Sieve/S3-FIFO) and a self-tuning hot/cold split. Reach for it over `Lirs` when the hot-path write cost matters and an approximation is enough; ships the same bounded non-resident history deviation. |
| Protect pages only after they PROVE reuse (>= K references), the classic way | `LruK` | LRU-K (K=2): eviction by the K-th backward distance -- a page stays cold until its 2nd reference, then warm. The original recency-of-recency policy; simpler than `Lirs`/`ClockPro`. Cheap hot path (warm hit 0 links + 2 stamps); the all-warm victim is an honest O(size) min-scan (documented, not a bound). |
| Grade frequency into bands AND forget cold-but-once-hot blocks (logical-time decay) | `Mq` | Multi-Queue (m=8): rank by frequency band (highest set bit of the refcount) across 8 LRU queues, with a fixed aging sweep that decays idle bands toward Q0 so a once-hot-now-cold block becomes evictable. Reach for it over `Lfu` (which never forgets) when recency should reclaim decayed frequency. Honest hot path: a band relink (0, or at most 5 (4..5), writes) + a fixed 7-step sweep (<= 33 writes, proven non-exceedable), NOT a 0-write hit. |
| Self-tuning recency/frequency balance (like ARC) with the CHEAPEST possible hot path | `Car` | CAR (Clock with Adaptive Replacement): ARC's exact semantics -- T1/T2 lists, B1/B2 ghosts, one adaptive `p`, no knobs -- on reference-bit clocks, so a hit is a **0-link-write** reference bit (like Sieve/ClockPro) where `Arc` relinks to the T2 MRU. Reach for it over `Arc` when the hit-path write cost matters and over `ClockPro` when you want ARC's recency/frequency adaptation rather than LIRS's. Honest cost: hit 0 links + 1 `_st` store; miss+evict amortized O(1), worst-case O(capacity), no pinned constant. |

Then **measure your own trace with the [bench tool](#measure--trust)** -- hit ratio, % of Belady optimal, writes per hit, and alloc, all oracle-checked. The measured policy is the shipped policy.

---

## API reference

### The members

All thirteen classes implement `LiteCache<K,V>`. Every method is O(1) (amortized on the default `Map` backing; see [construction options](#construction-options)) -- except `LruK`'s all-warm eviction victim, an honest O(size) min-`_r1` scan (documented, never a claimed bound). `Mq`'s hot path is O(1) but honestly heavier than a lazy-promotion hit: a band relink (0, or at most 5 (4..5), writes) plus a FIXED 7-step aging sweep (<= 33 writes total, non-exceedable).

```ts
new LiteLru<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new Sieve<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new S3Fifo<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new WTinyLfu<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new Slru<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new TwoQ<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new Arc<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new Lirs<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new Lfu<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new ClockPro<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new LruK<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new Mq<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new Car<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)

cache.get(key: K): V | undefined            // returns the value AND applies the member's hit policy
cache.put(key: K, value: V, ttlMs?): void   // insert/update (+ optional per-entry TTL); evicts the victim at capacity
cache.has(key: K): boolean                  // presence test; NEVER changes recency / visited state
cache.peek(key: K): V | undefined           // read without applying the hit policy
cache.delete(key: K): boolean               // remove; true if it was present
cache.clear(): void                         // empty the cache; allocates nothing
cache.purgeStale(): number                  // evict every currently-expired entry now; returns the count (TTL)
cache.stats(): CacheStats                   // live counters {hits,misses,evictions,puts}; requires { stats: true }
cache.resetStats(): void                    // zero the four counters in place; requires { stats: true }
cache.dump(): CacheSnapshot                 // serialize to a plain, structurally-cloneable snapshot (cold, may allocate)
Member.restore(snap, opts?): Member<K, V>   // STATIC: reconstruct a fresh instance from a snapshot (fail-closed)
cache.size: number                          // current entry count, 0 .. capacity (getter)
cache.capacity: number                      // fixed maximum, set at construction (getter)
```

- **`capacity`** -- must be an integer `>= 1`. Anything else throws a `[lite-lru]`-tagged `RangeError` at the door (fail-closed -- `null` is not zero).
- **The undefined-value contract (D7).** `get` and `peek` return `V | undefined`, where `undefined` means EITHER "absent" OR "the stored value is literally `undefined`". These are indistinguishable through the return value alone. To disambiguate, call `has(key)`. `null` is a normal, distinguishable value; only `undefined` collides with the miss sentinel.
- **`get` vs `has`/`peek`.** `get` applies the member's hit policy (`LiteLru`: promote to MRU; `Sieve`: set the visited bit). `has` and `peek` never do -- they are the sanctioned way to inspect without perturbing eviction order.

### Construction options

```ts
interface LiteCacheOptions<K, V> {
  onEvict?: (key: K, value: V) => void;
  keys?: "int";
  ttl?: number;            // opt-in TTL default in ms (Infinity = never); see below
  clock?: () => number;    // injectable clock, defaults to Date.now
  stats?: true;            // opt into runtime counters; see Stats below
}
```

- **`onEvict(key, value)`** -- called once per eviction with the evicted pair (e.g. to return a value to a pool). Zero-GC: pass a hoisted function, not a fresh closure per construction.
  - **Reentrancy contract (fires LAST, fail-closed).** `onEvict` fires AFTER the cache is fully consistent -- the newcomer already inserted, the victim already gone. It MUST NOT call `put`/`get`/`delete`/`clear` on the same instance; doing so throws a `[lite-lru]`-tagged `Error` rather than corrupting the intrusive lists mid-eviction. `has` and `peek` ARE allowed from within the callback (they cannot mutate) -- use them to inspect. An expiry reap fires `onEvict` under the same contract.
- **`keys: "int"`** -- opt into the open-addressed typed-array keyed index for STRICT zero allocation (even the index never allocates -- no pre-fill caveat). Keys MUST be 32-bit signed integers in `[-2147483648, 2147483647]`; a non-integer or out-of-range key throws a `[lite-lru]`-tagged `TypeError` (fail-closed). Values remain arbitrary. Omitted, the default is a JS `Map`: arbitrary keys, honestly AMORTIZED (its internal resize can allocate), byte-identical to the pre-`keys` behavior. An unknown `keys` value throws with a did-you-mean hint.
- **`ttl` / `clock`** -- opt into time-to-live (see [TTL](#ttl----opt-in-lazy-expiry) below). Both are validated fail-closed at the door.
- **`stats: true`** -- opt into runtime counters (see [Stats](#stats----opt-in-runtime-counters) below). Any value other than `true` (or omitted) throws a `[lite-lru]`-tagged `TypeError` with a did-you-mean hint.

### TTL -- opt-in, lazy expiry

TTL is **opt-in, lazy, and pay-for-what-you-use**. A cache that never asks for it is byte-identical to the pre-TTL build -- no extra column, no per-op check that costs anything. When you do opt in, expiry is **lazy**: an entry expires the next time a `get`/`has`/`peek` touches it (a stale touch is a MISS and reaps the entry in place, firing `onEvict`). **No timers. No async. No background sweep.** All thirteen members support it identically (decisions/0017).

```ts
import { LiteLru } from '@zakkster/lite-lru';

const cache = new LiteLru<string, Buf>(1024, { ttl: 60_000 }); // 60s default TTL
cache.put('a', bufA);              // expires 60s from now (the default)
cache.put('b', bufB, 5_000);       // per-entry override: 5s
cache.put('c', bufC, Infinity);    // never expires

cache.get('a');   // within 60s -> bufA; after -> undefined (reaped in place)
cache.purgeStale(); // OPTIONAL: evict every currently-expired entry now, returns the count
```

- **Per-instance default + per-entry override.** `{ ttl }` sets the default in ms; the positional `put(key, value, ttlMs)` overrides it for one entry. `Infinity` means never-expire (`NEVER 0`). Omit `ttlMs` to use the default.
- **Fail-closed.** `ttl`/`ttlMs` must be positive-finite-or-`Infinity` -- `<= 0`, `NaN`, and non-numbers throw a `[lite-lru]` `RangeError`. Passing a `ttlMs` to a cache built **without** a `ttl` option throws a `[lite-lru]` `Error` (there is no expiry column to stamp -- a caller bug, not a silent no-op).
- **Deterministic + testable.** Inject a `clock: () => number` (defaults to `Date.now`) to drive expiry from your own time source; the torture differential runs the whole feature against a brute oracle on a virtual clock.
- **Zero-GC on both paths.** The expiry column is one fixed `Float64Array` (8 bytes/slot), allocated only when `ttl` is set, never grown. Stamping on `put` and reaping on a stale touch are strictly zero-allocation; a freed slot's timestamp is dropped so no value is pinned.
- **`purgeStale(): number`** -- the explicit, cold reclamation path (walks the index once, reaps every expired resident, returns the count). Lazy expiry already reclaims on touch; call this when you want eager reclamation. Returns `0` on a cache with no `ttl`.

**vs `lru-cache`.** This is deliberately narrower and cheaper: **lazy TTL only** (no `ttlAutopurge` timer thread), **no async `fetch`/`fetchMethod`**, and **no size-aware `maxSize`/`sizeCalculation`**. If you need clairvoyant fetch coalescing or byte-budgeted caches, reach for `lru-cache`. If you need a zero-GC fixed-capacity cache with optional lazy TTL and no background work, this is the smaller tool.

### Iteration -- zero-GC keys/values/entries

Every member is iterable: `keys()`, `values()`, `entries()` and `[Symbol.iterator]` (== `entries()`, matching `Map`), all part of the uniform `LiteCache<K,V>` surface (decisions/0018).

```ts
for (const [k, v] of cache) { /* ... */ }        // [Symbol.iterator] === entries()
for (const k of cache.keys()) { /* ... */ }
for (const v of cache.values()) { /* ... */ }
```

**Our iterators allocate nothing per step; `lru-cache`'s allocate.** There is no generator anywhere (a generator allocates an `IteratorResult` object per `yield`). Instead a single hand-written iterator reuses one `{ value, done }` result, mutated in place, across every `next()`. The gate proves it: `>= 10,000` `next()` steps at capacity measure **0 B/op per step** on all thirteen members. (Not "lock-free" -- just zero per-step allocation.)

**Per-member iteration order** (only `LiteLru` is true recency):

| Member | Order | Note |
| --- | --- | --- |
| `LiteLru` | MRU -> LRU | true recency order |
| `Sieve` | newest -> oldest | FIFO insertion order, NOT recency |
| `S3Fifo` | MAIN newest->oldest, THEN SMALL newest->oldest | two FIFO rings; the keys-only ghost is excluded |
| `WTinyLfu` | WINDOW, THEN PROTECTED, THEN PROBATION (each MRU->LRU) | three segments concatenated, not one global order |
| `Slru` | PROTECTED, THEN PROBATION (each MRU->LRU) | two segments concatenated, not one global order |
| `TwoQ` | Am, THEN A1in (each MRU->LRU) | two queues concatenated; the keys-only A1out ghost is excluded |
| `Arc` | T2 (frequent), THEN T1 (recent) (each MRU->LRU) | two lists concatenated; the keys-only B1/B2 ghosts are excluded |
| `Lirs` | LIR list, THEN Q (resident HIR) | resident only; the non-resident history is excluded |
| `Lfu` | ascending frequency (lowest first), MRU->LRU per bucket | frequency-bucket order, not recency |
| `ClockPro` | clock newest -> oldest | clock order, resident only; the non-resident history is excluded |
| `LruK` | WARM (>= K refs), THEN COLD (< K refs) | two disjoint lists concatenated, resident only; the non-resident history is excluded |
| `Mq` | band Q7 (highest frequency) DOWN to Q0 | eight disjoint band queues concatenated, resident only; the non-resident Qout is excluded |
| `Car` | T2 (frequent), THEN T1 (recent) (each MRU->LRU) | two clocks concatenated, resident only; the keys-only B1/B2 ghosts are excluded |

- **Borrowed-tuple caveat (`entries()` / `[Symbol.iterator]`).** The yielded `[key, value]` tuple is **borrowed and reused** across steps -- read it (or copy it) before the next step. **Only a copying map materializes:** `Array.from(cache.entries(), ([k, v]) => [k, v])` or a manual per-step `[k, v]` copy. A plain `[...cache.entries()]` / `Array.from(cache)` with **no map function** collects N references to the *same* reused tuple, which the completed walk then nulls -- so every element reads `[undefined, undefined]`, not the data. A bare spread of `entries()` is a bug; copy the pair. `keys()` and `values()` yield the scalar directly, so `[...cache.keys()]` and `[...cache.values()]` **do** materialize correctly (no aliasing hazard).
- **Recency-neutral.** A walk is a read, like `peek`: it applies no promotion / visited bump / sketch bump / segment relink, so iterating does not change the next eviction victim.
- **TTL: skip, don't reap.** Under `ttl`, iteration **skips** stale entries (they are invisible) but does **not** reap them -- a walk performs no structural mutation, so `size` is unchanged by iterating. Use `purgeStale()` to reclaim.
- **Fail closed on mutation-during-iteration.** A structural mutation (`put`/`delete`/`clear`/eviction/reap) mid-walk makes the next `next()` throw a `[lite-lru]`-tagged `Error` (a single integer version counter, bumped only by mutations, never on the `get` path -- so the hot `get` writes-per-hit are unchanged). A `get()`-induced reorder mid-walk is documented-unsupported (not caught -- catching it would cost a write per hit).

### Stats -- opt-in runtime counters

Stats are **opt-in, zero-cost-when-off, and pay-for-what-you-use** (decisions/0019). A cache constructed without `{ stats: true }` writes **nothing** on the hot path -- byte-identical to the pre-stats build (same writes-per-hit, no holder, no fields). Opt in and you get four exact counters via `stats()`, on every member under the same `LiteCache<K,V>` surface:

```ts
const cache = new WTinyLfu<number, Buf>(1024, { stats: true });
// ... run traffic ...
const s = cache.stats();                 // { hits, misses, evictions, puts }
const hitRatio = s.hits / (s.hits + s.misses);
cache.resetStats();                      // zero the four counters in place
```

```ts
interface CacheStats { hits: number; misses: number; evictions: number; puts: number; }
```

- **`hits`** -- a `get(key)` that found a live resident entry. **`misses`** -- a `get(key)` that did not (absent, or stale under TTL). **`evictions`** -- an entry removed by the policy: a capacity eviction on `put`, or a stale reap. **`puts`** -- every `put(...)` call (insert or update).
- **Exact integers to 2^53.** Plain JS number fields (not an `Int32Array` that would wrap at 2^31). For any realistic cache they never overflow.
- **`has`/`peek` are hit/miss-neutral.** They are inspections, not accesses -- they never register a hit or a miss. (A stale `has`/`peek` under TTL still reaps the expired entry, which is a genuine eviction and is counted as one.)
- **A stale-TTL `get` is a MISS and an EVICTION.** It counts one miss and reaps the expired entry in place (one eviction) -- consistent across all thirteen members.
- **The holder is borrowed (copy what you keep).** `stats()` returns the live per-instance holder **by reference**, not a snapshot -- its counters keep advancing and `resetStats()` zeroes that same object in place (a previously borrowed reference stays valid and reads back zeros). For a point-in-time snapshot, copy it: `const snap = { ...cache.stats() }`.
- **Fail closed.** `stats()` / `resetStats()` on a cache built without `{ stats: true }` throw a `[lite-lru]`-tagged `Error` (there is no holder -- a caller bug, not a silent return of zeros). `null` is not zero.
- **`writesPerHit` is not here.** It is a member-specific, out-of-band **measured** number (see below), not a runtime counter -- turning it into one would require a store on every hit, exactly the hot-path write the zero-GC law forbids.

The stats-ON hot path is still strictly zero-alloc: the torture Gate STATS churns `>= 60,000` ops at capacity with `{ stats: true }` and measures **0 B/op**, holder identity stable, holder plain with exactly the four counter names.

### Snapshot -- dump / restore

Persist a warm cache and bring it back **warm** (decisions/0021). `dump()` serializes the whole cache to a plain, structurally-cloneable object; the static `restore()` reconstructs a fresh instance that keeps making the **same** eviction decisions -- no cold start. All thirteen members, one `LiteCache<K,V>` surface. It is **cold**: no substrate field, no hot-path branch, so a cache that never dumps is byte-identical to the pre-snapshot build.

```ts
const cache = new WTinyLfu<number, string>(1024);
// ... a day of traffic warms the window, the SLRU segments and the frequency sketch ...

const snap = cache.dump();                 // a plain object graph: arrays + numbers/values
await fs.writeFile('cache.json', JSON.stringify(snap));   // or structuredClone to a worker

// later, in a fresh process:
const raw = JSON.parse(await fs.readFile('cache.json', 'utf8'));
const warm = WTinyLfu.restore(raw);        // same residents, same sketch, same decisions
```

- **Exact round-trip.** A restored cache decides FUTURE evictions identically to the un-snapshotted twin fed the same trace. Every member captures ALL policy state: Sieve's hand + visited bits; S3-FIFO/2Q's keys-only ghost; W-TinyLFU's Count-Min sketch + aging counter; ARC's adaptive `p` and both ghosts. Dropping any of these would be a fail-OPEN correctness bug (three torture controls -- `arc-p-dropped`, `sketch-dropped`, `ghost-omitted` -- prove each diverges).
- **A plain graph.** Plain arrays + plain numbers/values, no typed-array views, so it round-trips through `structuredClone` and (for JSON-safe keys/values) through JSON. NOTE: object keys are cloned by `structuredClone` (new identity) -- documented, not a bug; pass the `dump()` result directly to `restore()` to keep object-key identity. NOTE (`LruK`): a snapshot containing COLD pages is NOT plain-JSON round-trippable -- a cold page's `_r1` is the `-Infinity` sentinel (decisions/0026 D26.3), and `JSON.stringify` silently degrades `-Infinity` to `null`; `restore()` then fails CLOSED with a numeric-column error rather than admitting a corrupt cold page. `structuredClone` preserves `-Infinity` exactly and round-trips fine -- a documented, fail-closed limitation of the JSON path, not a bug.
- **Cold, honest budget.** `dump()` MAY allocate -- there is NO zero-GC claim on it. The budget is `<= 96 bytes/entry` (measured 26.12 B/entry for `LiteLru` at capacity 4096). A **restored** cache's hot path is strict zero-alloc again (0 B/op), and `dump()` is read-only -- it does not invalidate a walk in progress.
- **`opts` re-derives what a snapshot can't hold.** Backing, capacity and TTL-presence come FROM the snapshot; `restore(snap, opts?)` re-derives `onEvict` / `clock` / `stats` (a restored `{ stats: true }` instance starts fresh-zeroed) and REQUIRES the `ttl` default when the snapshot has TTL on.
- **TTL is verbatim.** Per-entry expiries are captured as ABSOLUTE deadlines and are NOT rebased -- a restored entry expires exactly when it would have without the snapshot.
- **Fail closed.** `restore()` throws a `[lite-lru]`-tagged `Error` on a wrong/absent format tag, a member mismatch, a capacity/keys/TTL conflict with `opts`, a corrupt or short field, or a snapshot whose residents exceed capacity (REJECT -- never silently truncate; restored size is always `<= capacity`). `null` is not zero.

### The bench tool

`Bench.mjs` ships in the tarball as both a runnable and a subpath import. It imports ONLY the cache implementation -- zero runtime deps, no test-only devDeps.

```ts
import { runBench, beladyOpt } from '@zakkster/lite-lru/benchmark/Bench.mjs';

runBench(opts?): BenchResult
// opts: { capacity?, length?, seed?, workloads?: [{ name, capacity, trace: number[] }] }
// Returns structured per-workload, per-member results (hitRatio, writesPerHit,
// nsPerOp, pctOptimal) plus each workload's OPT. Deterministic for a given seed.
// Pass your own `workloads` to replay YOUR trace.

beladyOpt(trace: number[] | Uint32Array, capacity: number): { hits, misses, hitRate }
// Belady's clairvoyant offline optimum: evict the resident whose NEXT use is
// farthest away. A REFERENCE ORACLE, never a cache policy.
```

Run directly, it prints a table; imported, it returns structured results and prints nothing. See [Measure & Trust](#measure--trust).

### Constants

| Constant  | Value     | Meaning                                                       |
| --------- | --------- | ------------------------------------------------------------ |
| `VERSION` | `'1.15.0'` | Package version string (in lock-step with `package.json` and `llms.txt`). |

All thirteen members and `VERSION` are named exports; `LiteLru` is also the default export.

---

## Composability

The end-to-end "measure, then deploy" loop the family is built for -- pick a policy by replaying a trace, then run that policy in production, all through one interface:

```js
import { LiteLru, Sieve } from '@zakkster/lite-lru';
import { runBench, beladyOpt } from '@zakkster/lite-lru/benchmark/Bench.mjs';

// 1. Capture (or synthesize) YOUR access trace as an array of integer keys.
const trace = /* e.g. request key per event, in order */ [];

// 2. Measure every candidate policy against Belady OPT on that exact trace.
const opt = beladyOpt(trace, 1024).hits;
const result = runBench({
  workloads: [{ name: 'prod', capacity: 1024, trace }],
});
for (const m of result.workloads[0].members) {
  console.log(`${m.name}: ${(m.hitRatio * 100).toFixed(1)}% ` +
              `(${m.pctOptimal.toFixed(1)}% of OPT), ${m.writesPerHit.toFixed(2)} writes/hit`);
}

// 3. Deploy the winner behind the SAME interface. If SIEVE measured closer to OPT
//    with fewer writes per hit, this is the only line that changes:
const Policy = result.workloads[0].members
  .reduce((a, b) => (b.pctOptimal > a.pctOptimal ? b : a)).name === 'Sieve' ? Sieve : LiteLru;

const cache = new Policy(1024, {
  keys: 'int',                                   // integer keys -> strict zero-alloc backing
  onEvict: (k, v) => pool.release(v),            // hoisted, zero-GC, fires fail-closed
});

// 4. Steady state: O(1), zero allocation on every hot path.
for (const key of liveRequests) {
  let v = cache.get(key);
  if (v === undefined) { v = load(key); cache.put(key, v); }
  use(v);
}
```

The measurement pass and the deployed cache read the same policies from the same file: the number the bench reports is the behavior you ship, by construction.

---

## Zero-GC design notes

<details>
<summary>What the hot path allocates (nothing), and how it stays that way.</summary>

An LRU has a hard capacity ceiling by definition, so all `capacity` slots are preallocated ONCE in the constructor and reused forever. The doubly-linked list is not made of `{}` node objects -- it is a set of parallel arrays indexed by an integer slot: object columns `_keys[]` / `_vals[]` for the payload, and two `Int32Array` link columns `_next[]` / `_prev[]` for the topology. A slot is in exactly one intrusive list at a time (the active recency/FIFO list, or the free stack), both threaded through `_next[]`. Eviction repurposes the evicted slot in place -- no node is ever allocated on `put`, and a freed slot drops its payload refs so the cache never pins a value it no longer owns.

| Operation                          | Steady-state allocations |
| ---------------------------------- | ------------------------ |
| `get` / `put` / `delete` / `has` / `peek` (slot + list layer) | **0** |
| keyed index, `keys: 'int'`         | **0** (open-addressed typed arrays, fixed at construction) |
| keyed index, default `Map`         | amortized (the Map's internal resize can allocate) |
| construction                       | once (all slots + columns, then reused) |

`SIEVE` adds one fixed `Uint8Array` visited column, one byte per slot, allocated once and never grown -- a hit is a single unconditional byte store, no mask or shift. `S3Fifo` adds two fixed byte columns (a visited column and a queue tag naming which of its two rings a slot is in) plus a bounded keys-only ghost queue -- on the `keys: 'int'` backing the ghost is a fixed open-addressed membership table + a power-of-two typed-array ring, all sized once and never grown (strict zero-alloc, proven by t6 Gate S3FIFO); on the default backing the ghost is a `Set` + array ring (amortized, the same caveat as the default `Map` index). The ghost stores KEYS only, never values -- proven by a WeakRef census in the soak tier.

`WTinyLfu` adds one fixed byte column (`_seg`, naming which of its three LRU lists -- window / probation / protected -- a slot is in, so a detach fixes the correct list) plus one fixed Count-Min sketch: 4 rows of 4-bit saturating counters packed eight-per-`Uint32`, width a power of two `>= capacity`, sized once and NEVER grown (its `byteLength` is invariant under churn -- asserted by t6 Gate WTINYLFU on both the `keys: 'int'` churn and a 1e6-op object-key run). A hit bumps four counters and relinks within a segment -- more work than SIEVE/S3-FIFO's single byte, still strictly zero allocation. The sketch is aged (every counter halved in place) every `10 * capacity` bumps so it tracks recent frequency, and it retains only PRIMITIVE counts -- no key or value reference (object keys hash into the sketch by their resident slot, no WeakMap -- decisions/0014), so the WeakRef soak census confirms evicted values are collectible.

The torture harness (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`, under `--expose-gc`) commits the zero-GC posture as GATED numbers -- a regression fails as loudly as a leak:

- **No major GC** across the hot loop (`maxMajor: 0`).
- **Pause ceiling** of `maxPauseMs: 4` on the measured window.
- **Retained bytes per call** below `maxBytesPerCall: 1` (under one heap object, above measurement noise).
- **No backing-store growth** (`maxArrayBuffersGrowth: 0`) -- the typed-array columns and the integer index never resize under churn at capacity.

### Writes per hit -- the honest micro-win (measured, not "lock-free")

The literature sells SIEVE on scalability, but that is a multi-core systems argument that does not transfer to single-threaded JS -- there is no lock to avoid. What DOES transfer, and is pinned as a gated number, is **fewer metadata writes per hit** (fewer dirtied cache lines):

| Member    | Hit on the MRU/head | Interior hit | Tail hit | Metadata written |
| --------- | ------------------- | ------------ | -------- | ---------------- |
| `LiteLru` | **0** link writes   | **5** link writes | **4** link writes | intrusive-list relinks |
| `Sieve`   | **0** link writes   | **0** link writes | **0** link writes | exactly **1** visited byte |
| `S3Fifo`  | **0** link writes   | **0** link writes | **0** link writes | exactly **1** visited byte |
| `WTinyLfu` | **0** link writes (window MRU) | **9** link writes (probation -> protected promotion, steady state) | **8** link writes (same, at the probation tail) | segment relink + a 4-counter sketch bump |
| `ClockPro` | **0** link writes | **0** link writes | **0** link writes | exactly **1** state byte (the reference bit) |
| `LruK` | **0** link writes (warm hit) | **5** link writes (cold->warm promotion) | **5** link writes (cold->warm promotion) | 2 reference-time stamps (`_r0`/`_r1`); +5 links only on the K-th (cold->warm) reference |
| `Mq` | **0** link writes (already band MRU) | **5** link writes (re-band / non-MRU move) | **5** link writes (re-band / non-MRU move) | 3 metadata stamps (`_rc`/`_qn`/`_exq`) + a FIXED 7-step aging sweep (<= 28 links); **<= 33 links/access, proven non-exceedable** |
| `Car` | **0** link writes | **0** link writes | **0** link writes | exactly **1** state byte (the reference bit) |

`LruK`'s warm hit is **0 link writes + 2 stamps**; a page's K-th (2nd) reference promotes it cold->warm at **at most 5 (2..5) link writes, non-exceedable** (up to 2 cold-detach + up to 3 warm-push; 5 is the reachable maximum, pinned by `CountedLruK`) + the same 2 stamps -- so "interior"/"tail" here means "the promoting reference," not a position (a warm re-hit relinks nothing wherever it sits). Its EVICTION is honestly **not** a constant when the resident set is all-warm: the cold tail is O(1), but the all-warm min-`_r1` victim is a **linear O(size) scan** (reads, not writes) -- the gate measures the worst-observed scan length as a per-stream regression tripwire, never a claimed bound.

`ClockPro` joins Sieve/S3-FIFO on the cheapest hot path: a hit is 0 `_next`/`_prev` writes + exactly 1 `_st` reference-bit store, regardless of where the page sits (a `CountedClockPro` proxy pins it -- a real gate). Its EVICTION is honestly **not** a constant: it is **amortized O(1)** per miss (the classic CLOCK amortization -- HAND_cold and HAND_hot each clear at most one reference bit per step), but **worst-case O(capacity)** writes on a full-scan-then-insert (fill to capacity, reference every resident page, then insert one new key -- the sweep must clear every reference bit). We do NOT pin a constant miss+evict bound; the torture gate's per-stream "worst-observed" number is a regression tripwire on that corpus, not a cap -- exactly as `Lfu` documents its hit as zero-ALLOCATION-but-not-zero-write and `Lirs` documents its bounded-variant honesty. A `CountedLru` / `CountedSieve` / `CountedS3Fifo` / `CountedWTinyLfu` / `CountedClockPro` / `CountedLruK` / `CountedMq` / `CountedCar` proxy tallies every index store in the torture gate, so these counts are a regression tripwire, not a claim. `Car` (CAR) shares `ClockPro`'s exact honest posture -- a hit is 0 `_next`/`_prev` writes + exactly 1 `_st` reference-bit store (`CountedCar` pins it PER CALL SITE: the hit path touches only `_st[s] |= CAR_REF`, and the reference-bit CLEARS live entirely on the miss/evict path in REPLACE, never the hit budget), and the miss+evict is **amortized O(1)** but **worst-case O(capacity)** reference-bit clears on a full-scan-then-insert, with NO pinned constant bound (the torture `carStream` worst-observed is a per-stream tripwire, not a cap). `Mq` is deliberately the HONEST counter-example to a 0-write hit: it does real band-relink surgery (0, or at most 5 (4..5), link writes) PLUS a fixed 7-step aging sweep (<= 7 demotions x <= 4 = 28), for a per-access total that is a **proven non-exceedable <= 33 link writes + 3 metadata stamps** -- `CountedMq` measures the worst-observed (17) and asserts the ceiling holds because reset-on-demote forbids cascade (decisions/0027), never claiming a false zero. This is a real but minor corroborator -- it matters most for GC-pause-sensitive realtime and game loops -- and it is never framed as "lock-free" or as a cross-library throughput win. `WTinyLfu` deliberately does NOT compete on writes-per-hit: it trades a segment relink + a 4-counter sketch bump per hit for better admission accuracy on skewed traffic -- still zero allocation, and the honest pitch is hit ratio (measure it with the bench), not fewer writes. The "Interior hit"/"Tail hit" cells are MEASURED (via `CountedWTinyLfu`, S6) for the steady-state cost once `protected` has filled to its cap: a probation hit promotes to protected AND demotes protected's LRU back to probation (two relinks in one hit) -- 9 writes for an interior probation entry, 8 for the probation tail (one fewer detach write, the same interior/tail delta as classic LRU). A window or protected-segment hit (not shown as its own row) costs the SAME 5/4 as classic LRU's interior/tail relink, since both segments use the identical move-to-head mechanic -- pinned in `test/WTinyLfu.test.js`.

</details>

---

## Measure & Trust

Hit ratio and throughput are OUTPUTS of your trace, never headline claims. The bench is how you get them -- for the members AND for Belady's clairvoyant optimum, so you see how much room is actually left:

```bash
npm run bench     # or: node benchmark/Bench.mjs
```

The default run reports each member on three named, seeded workloads -- `zipf` (skewed popularity), `loop` (a sequential scan larger than the cache), and `scan` (a one-hit-wonder flood over a stable hot set) -- as a fraction of OPT. On the default seeded trace in this repo (capacity 256, 200000 ops, seed `0x9e3779b9`), the deterministic outputs are:

| Workload | Policy    | Hit % | % of OPT | Writes/hit |
| -------- | --------- | ----- | -------- | ---------- |
| `zipf`   | OPT       | 74.4  | 100.0    | -          |
| `zipf`   | `LiteLru` | 57.4  | 77.2     | 4.824      |
| `zipf`   | `Sieve`   | 66.8  | 89.8     | 1.000      |
| `loop`   | OPT       | 24.9  | 100.0    | -          |
| `loop`   | `LiteLru` | 0.0   | 0.0      | 0.000      |
| `loop`   | `Sieve`   | 0.0   | 0.0      | 0.000      |
| `scan`   | OPT       | 49.9  | 100.0    | -          |
| `scan`   | `LiteLru` | 36.0  | 72.1     | 4.967      |
| `scan`   | `Sieve`   | 49.9  | 100.0    | 1.000      |

Hit % and % of OPT are deterministic (seeded trace, deterministic policies); `ns/op` is wall-clock and MACHINE-LOCAL -- the tool prints it with a `node`/`arch` fingerprint, and it is an example only, not a comparable number across machines. These are outputs of these specific traces, not general claims: the `loop` row is exactly why LRU is a floor and not a headline, and the `scan` row is the scan-resistance story as a measurement. Replay YOUR trace by passing `workloads` to `runBench`, and trust the number because the bench drives the same policies the package ships.

---

## Design decisions worth knowing

- **Classic LRU is the reference member, not the headline.** LRU pays its relink cost unconditionally (every hit) but earns its benefit conditionally (only at an eviction, only if recency predicts reuse). On a cache sized at or above its working set, or on a predictable pattern, that benefit goes to zero while the cost remains -- so LRU is the honest floor and the differential oracle, and lazy-promotion policies like SIEVE are the members. The bench + OPT let you discover which regime you are in.
- **One file, named exports -- NOT a subpath per policy.** A single `Lru.js` exports every member; `sideEffects: false` + ESM named imports mean `import { Sieve }` drops `LiteLru`'s body from your bundle. The shared substrate is internal, never a second package. `Bench.mjs` is a separate runnable tool, deliberately NOT a `bin` and NOT a second implementation.
- **A shared substrate, chosen once at construction.** The keyed index, the SoA slot columns, and the free stack are factored into an internal `SlotStore` all members compose. The backing (default `Map`, or the `keys: 'int'` typed-array index) is chosen once so each hot path is monomorphic -- no per-op branch on backing type.
- **Integer keys get a strict-zero-alloc index with no tombstones.** `keys: 'int'` is open-addressed with linear probing and backward-shift deletion, a fixed table (load factor <= 0.75) sized once at construction, never resized. A Fibonacci hash mix (`Math.imul(key, 0x9e3779b1)`) keeps sequential keys from clustering. The accepted domain is validated at the door.
- **`onEvict` fires LAST and fails closed.** Firing after the cache is fully consistent, plus a reentrancy guard that rejects mutation from within the callback, prevents evict -> put -> evict recursion and mid-surgery corruption. `has`/`peek` stay open inside the callback.
- **Belady OPT lives strictly offline.** OPT is clairvoyant -- it peers into the future of the trace -- so it can never be a production policy and lives only in `Bench.mjs`. Its practical heap implementation is differential-tested against a brute-force O(N*C) OPT in the torture gate, because every "% of optimal" figure depends on it being exactly right.
- **Fail closed, name the value.** A bad capacity, an unknown `keys` value, or an out-of-range integer key all throw a `[lite-lru]`-tagged error at the door; `null` is never coerced to zero.

---

## Testing

**1322 deterministic tests, all pass**, plus a torture gate that proves both leak-freedom and the zero-GC quality numbers, and a shipped bench.

```bash
npm test               # 1446 node:test cases (all members, laws, TTL, iteration, stats, snapshot round-trip, boundary, dts drift)
npm run test:types     # tsc: the LiteCache<K,V> surface + one-line-swap type-check
npm run torture        # @zakkster/lite-leak + lite-gc-profiler: 0 B/op + gated numbers
npm run torture:controls  # the deliberately-broken variants -- every gate must fail
npm run test:perf      # @zakkster/lite-perf-gate: node:test hard zero-alloc gate (keys:'int')
npm run bench          # per-policy hit ratio + % of Belady OPT + writes/hit
npm run verify         # test + test:types + torture + controls + test:perf, the publish gate
```

`npm run test:perf` is a `node:test`-native hard gate (`@zakkster/lite-perf-gate`, a dev-only devDependency -- it ships NOTHING to the tarball) that COMPLEMENTS torture `t6`. It runs 26 scenarios -- a get-hit and a put-churn for each of the thirteen members -- on the `keys: 'int'` backing, and proves each hot path holds at **0 scavenges across N=200000 and k*N=1.6M** (scavenge scaling is the only reliable transient-allocation detector in V8), with old-gen activity, external / arrayBuffers growth, and the int-index-backing `grows` counter all pinned to **0**. A `mustFail` object-key churn that allocates one `{ id }` per op MUST trip the gate, so the teeth are proven every run. The hard gate deliberately covers ONLY the `keys: 'int'` backing (strict zero-alloc, decisions/0011); the Map-backing hot paths are honestly **AMORTIZED** (their internal resize may scavenge) and are covered by torture `t6`, NOT by this hard gate. The retained-heap lane keeps the tool's default 64 KB because a `heapUsed` delta is inherently noisy; the zero-alloc proof lives in the scavenge / old-gen / external / counter lanes at strict 0.

The torture suite runs tiers strictly sequentially: `t0` recency/policy laws, `t1` degenerate keys/values (the D7 undefined-value case included), `t2` adversarial sequences + the conservation invariant, `t5` differential fuzz of all members (on the default AND `keys: 'int'` backings) against independent brute-force oracles, `t6` the zero-alloc gate + the writes-per-hit counter, `t7` a ~4096-cycle soak with a WeakRef reachability census, `t8` the Belady OPT gate (the shipped `beladyOpt` differential-tested against a brute-force OPT, plus the optimality bound `optHits >= memberHits` for every member on every trace), and `t9` the controls -- each gate driven by a deliberately-broken variant that MUST fail, so no gate is decorative. `test/` and `decisions/` never enter the tarball (`npm pack --dry-run` proves it). No gate output is a FAIL.

---

## Watch the policies

A **dev-only** demo (in `demo/`, **never in the npm tarball**) animates ONE shared trace through all thirteen members side by side, drawing each panel STRICTLY from that member's live `dump()` snapshot after every op -- the Sieve hand + visited bits, the S3-FIFO / 2Q / ARC ghost rings, the W-TinyLFU sketch heat, the ARC adaptive `p` bar, the LIRS LIR set / Q / bounded history -- with a running **% of Belady optimal** line per member. No shadow state: what you see is literally the cache's own snapshot (the same serial form `restore()` consumes). The "one interface, different policy" thesis, seen rather than read.

```bash
npm run demo           # headless: prints per-member hit% + %-of-optimal for one trace
npm run demo:serve     # zero-dep Node server, then open http://localhost:8013/
```

The browser page (`demo/visuals.html`) imports only `../Lru.js`; a tiny zero-dep server (`demo/serve.mjs`) computes the trace + Belady OPT with `Bench.mjs` and serves them as JSON, because the page cannot import `Bench.mjs` (it uses a Node builtin). See `decisions/0022-demo.md` for the "dump() IS the visualization model" ruling.

**Run it through the Node server, not as a static file.** `/trace.json` is a dynamic route, and ES modules need an http origin, so opening `demo/visuals.html` directly (`file://`) or through an IDE static preview (WebStorm et al., on some other port) will not work -- the page fails closed with an actionable message instead of loading. Always start `npm run demo:serve` and open `http://localhost:8013/`.

---

## What this is not

- **Not "the zero-GC LRU."** `lru-cache` is already typed-array-backed; that is not the moat and is never the claim. The moat is the family + the interface + the measurement tool.
- **Not feature parity with `lru-cache`.** TTL ships as an opt-in, lazy, pay-for-what-you-use column (see [TTL](#ttl----opt-in-lazy-expiry)) -- but deliberately lazy-only: no autopurge timer thread. Still out of the core: size/cost-aware capacity, async `fetchMethod`, and `dispose`. Async fetch and size-aware capacity change the model and belong in separate packages, not this hot core; zero-GC iteration remains on the roadmap.
- **Not a growable cache.** Capacity is fixed and load-bearing -- there is no growth path. An LRU never exceeds capacity, so there is nothing to grow.
- **Not lock-free or multi-core.** This is single-threaded zero-GC JavaScript; there is no lock to avoid. The measured win is fewer writes per hit, not scalability.
- **Not a concurrency primitive.** No atomics, no cross-worker synchronization. Coordinate shared access yourself.
- **Not clairvoyant in production.** Belady OPT is an offline reference oracle only; it never ships as a policy.

---

## Ecosystem

Part of the **@zakkster** zero-GC stack:

- [`lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal) -- zero-GC reactive graph for hot paths
- [`lite-binary-reader`](https://www.npmjs.com/package/@zakkster/lite-binary-reader) -- zero-GC reader for raw / foreign binary buffers
- [`lite-sepforge`](https://www.npmjs.com/package/@zakkster/lite-sepforge) -- zero-GC halftone and color-separation kernels
- **`lite-lru`** -- this package

---

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
