# 0030 -- benchmark review (bench record; for reuse in lite-logn / lite-loglogn)

> **Status (S17 S6).** This is the 2026-09-18 bench-review brief, moved verbatim from
> the repo-root `BRIEF.md` into the decision record. **Items 1-4** (DO -- alpha sweep,
> keyspace-ratio knob, ns/op median+p95 variance, trace loaders + a web-like synthetic
> generator) **SHIPPED in 1.18.0** (benchmark-only, no `Lru.js` change). **Items 5-7**
> (DECLINE -- vendored production traces, concurrency/multi-worker harness, "concurrency
> simulation" get-or-insert loops) **were declined**, for the reasons recorded below. The
> one still-open axis -- a hit-ratio-vs-capacity sweep (curve) -- is a ROADMAP follow-up
> item (S17 S6), not part of this record.

Date: 2026-09-18. Scope: `benchmark/Bench.mjs`. Verdict up front: the harness is
solid. It is not a generic speed harness -- it is an HONESTY-constrained tool
(header S9 rulings + suite law 8). Judge every proposed change through that lens.
Several popular "improvements" are really "market it like a Go QPS harness," which
would erode the one thing that makes it trustworthy.

This benchmark is the shared spine for the siblings. Keep the contract below stable
so lite-logn and lite-loglogn drop straight into it.

## The contract worth preserving verbatim across siblings

- Seeded xorshift32 PRNG -> every trace is byte-reproducible from its seed.
- Trace generators return plain integer-key arrays, fully determined by params.
- Belady OPT oracle (`beladyOpt`) as the reference denominator for %OPT. NOT a
  policy; differential-tested against brute-force O(N*C) in the torture gate.
- Two passes per member: untimed ratio/writes-per-hit (counting Proxy, off the
  hot path) + timed get/put loop (ns/op).
- Reporting rules: hit ratio ALWAYS against a NAMED trace ("on this trace, ..."),
  never a headline, never a cross-lib "beats X by N%". ns/op is machine-local and
  indicative only -- all members share call sites in one process (megamorphic bias).
- Structural facts (writes-per-hit, zero-GC budgets) are GATED in torture, not
  measured here. The bench is a tool: dependency-free, no global mutation, but
  zero-alloc is NOT required of the bench itself.
- `runBench(opts)` already accepts `capacity`, `length`, `seed`, AND arbitrary
  `workloads: [{name, capacity, trace}]`. Much "make it configurable" is already
  true; the gap is usually a named preset or an exposed knob, not new capability.

## Findings on the five researched suggestions (Go-harness comparison)

### DO -- adds honest information, no headline claim

1. Zipf alpha sweeps (best value/line). `zipfTrace` already takes `exponent`;
   `defaultWorkloads` hardcodes 1.0. Expose a sweep (0.7 / 0.9 / 1.0 / 1.2). Shows
   how each policy's edge over LRU moves with skew -- the axis web-cache literature
   cares about. ~10 lines, deterministic, zero honesty tension.

2. Scale sizing. Already configurable via `runBench({capacity, length})`. Real gaps:
   (a) keyspace:capacity ratio is hardcoded `*16` (~6.25% cache-of-keyspace) -- make
   it a knob; (b) add a documented "scale" preset. CEILING: `beladyOpt` allocates
   `Int32Array(n)` + a Map of next-use over the whole trace. Fine at ~5M ops, heavy
   toward ~50M. OPT is what caps scale mode -- document that cost.

3. ns/op variance (this is the honest core of the "QPS" suggestion, reframed).
   `measureTiming` does ONE warmup + ONE timed pass -> noisy. Report median + p95
   over N repeated passes. Strengthens the existing "reproduce on your hardware"
   caveat instead of fighting it. Do NOT add a single QPS headline number: it is
   redundant (QPS = 1e9/nsPerOp) and invites the one-big-number the law forbids.

4. Trace loaders + one more synthetic generator (partial of "real traces").
   Loader for a columnar/CSV integer-key format: pure glue, `runBench({workloads})`
   already eats arbitrary traces, stays zero-dep. Add one "web-like" synthetic
   generator (churn+zipf mix, or diurnal hot-set shift) beside zipf/loop/scan.

### DECLINE -- would measure something that is not the library

5. Bundling real production traces (Twitter / Wikipedia / Meta). Three independent
   blockers: NOT public-domain / MIT-incompatible for redistribution; GB-scale
   (kills package minimalism); contradicts zero-dep single-file ethos. Honest move:
   a loader + a docs pointer to where to download them.

6. Concurrency / multi-worker (Workers + SharedArrayBuffer) harness. Category error
   for a single-threaded, lock-free structure: it would measure V8's SAB / cross-
   isolate behavior, not the cache. Also breaks the one-process reproducibility
   guarantee. Only meaningful once a genuinely concurrent member (sharded/striped)
   ships -- revisit then, not before.

7. "Concurrency simulation" get-or-insert loops. The loop is ALREADY get-or-insert
   (`if (get()===undefined) put()`). Simulated concurrency on a single-threaded
   structure adds no signal.

## Through-line

The Go harnesses being compared to optimize a DIFFERENT claim ("fast under
concurrent QPS"). The surviving suggestions add axes of honest information
(skew, scale, variance, more workloads); the rejected ones add a bragging number
or a strawman measurement. Keep the bench's differentiator: outputs against named
traces, no headline claims.

## Cross-check vs known external harnesses (from knowledge, not live-searched)

- libCacheSim / Caffeine simulator / CacheLib CacheBench all lean on real traces +
  hit-ratio-vs-size CURVES and skew sweeps. That validates #1 (alpha sweep) and the
  loader half of #4, and confirms #5 (they ship LOADERS, and point at external trace
  repos; they do not vendor the GB traces into the tool).
- gocachemark-style tools headline QPS under concurrency -- exactly the framing to
  resist here (#3 caveat, #6/#7 declines).
- Missing axis worth considering later (all siblings): a hit-ratio-vs-capacity
  SWEEP (curve), not just a single capacity. This is the single most standard plot
  in the literature and is honest (per-trace, no cross-lib claim). Candidate for a
  follow-up if the alpha sweep lands well. (Deep-search deferred per weekly-limit.)

## Sibling notes (lite-logn / lite-loglogn)

- The harness spine (PRNG, generators, OPT oracle, two-pass measure, honesty rules)
  is structure-agnostic -> reuse as-is. Only `MEMBERS` and the ctor `(capacity)`
  shape are library-specific.
- If a sibling's members are NOT eviction caches (e.g. ordered-map / predecessor
  structures), %OPT and hit-ratio may not apply -- the reusable parts are then the
  seeded traces, the timed loop, and the median/p95 variance reporting. Decide the
  correct "correctness denominator" per sibling before copying %OPT blindly.
- Keep `beladyOpt`'s scale ceiling in mind before advertising a "scale" preset in a
  sibling with much longer traces.

## Recommended scope if pursued (pipeline: planner -> coder -> reviewer -> qa)

alpha-sweep + keyspace-ratio knob in `defaultWorkloads`; median/p95 in
`measureTiming`; a CSV/columnar trace loader; one synthetic web-like generator.
Decline concurrency harness, QPS headline, and vendored real traces.
