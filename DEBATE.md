# @zakkster/lite-lru -- open debate

Things I (Claude) either ADD to the multi-strategy idea or where I DISAGREE with
the reasoning behind it. The ROADMAP is written as if these are settled the way I
recommend; each item below says what I chose and why, so you can veto any of them
and I re-cut the roadmap. Nothing here is code -- it is the argument BEFORE code.

Ordered by how much it moves the roadmap.

---

## 1. Identity fork: does the family REPLACE the v1.0.0 plan, or EXTEND past it?

**The fork.** The old roadmap targets v1.0.0 = one polished classic LRU + an
integer-key zero-GC variant. Your idea changes the *reason the package exists*.
Two ways to absorb that:

- **A. Extend.** Ship the current classic-LRU v1.0.0 first, then open a v2.0.0
  multi-strategy arc on top.
- **B. Reframe.** The family IS the identity from now on. Classic LRU stops being
  the headline and becomes the reference member + the differential oracle + the
  honest floor (exactly how lite-binary-reader treats a hand-written DataView
  loop). v1.0.0 ships a *differentiated slice* -- classic + the shared substrate
  + the harness + the first modern strategy (SIEVE) -- not a bare LRU.

**My call: B.** Your own words -- "if it's only the basic implementation, anyone
can build it from scratch" -- are an argument that a bare-LRU v1.0.0 has no moat.
Shipping one just to plant a 1.0.0 flag spends the version number on the thing you
already said is commodity. B keeps a shippable core (it does not chase all eight
strategies before releasing) while making the release *mean* something.

**This is genuinely your call, not mine** -- it is positioning, not code. If you
want A, say so and I move the family to a v2 track and leave S0-S6 as they were.

**RESOLVED (S1): B (reframe).** Confirmed by the maintainer. The family is the
identity from v1.0.0; classic LRU is the reference member + differential oracle +
honest floor. S1 accordingly builds the policy-parameterized oracle runner (proven
by a second stub policy), not a single-policy harness.

---

## 2. The "lock-free / scalable" argument does NOT transfer to this suite

The literature (and the pasted analysis) sells SIEVE and S3-FIFO heavily on
*scalability*: hits only set a bit, so there is no list-reordering lock on the
common path, so they scale across cores. **That is a systems-language, multi-core
argument. It is false-by-irrelevance here.** lite-lru is single-threaded
zero-GC JS. There is no lock to avoid.

What DOES transfer, and is the honest pitch:

- **Fewer writes per hit.** Classic LRU relinks ~6 typed-array cells on every
  `get` (detach: 2, push-front: 3-4). SIEVE sets **one bit**. S3-FIFO usually
  does **nothing** on a hit (it flips a bit at eviction time). Fewer stores ->
  fewer dirtied cache lines -> a measurable zero-GC hot-path win, especially on
  the re-hit-heavy workloads these algorithms target.
- **Better hit ratio on real traces** -- the actual reason to reach for them.

So the marketing line is "fewer pointer writes + better hit ratio on skewed/scan
workloads," never "lock-free" or "scales to N cores." If we ever ship a Worker/SAB
variant, the concurrency argument comes back -- but that is a separate package
(cf. lite-rollback-local / lite-worker), not a claim we borrow now.

**Consequence for the roadmap:** every strategy's PURPOSE is stated as a
JS-single-thread benefit (writes/hit + hit ratio), and the torture suite measures
*writes per hit* as a first-class number, not just allocation.

**The sharp form of the thesis (RESEARCH.md sec 2, "when LRU's bookkeeping is pure
overhead"):** LRU pays its relink cost UNCONDITIONALLY (every hit) but earns its
benefit CONDITIONALLY (only at an eviction, only if recency predicts reuse). In a
MEASURED environment -- cache sized >= working set (never evicts), or a known/
predictable pattern -- the benefit -> 0 while the cost remains, so head/tail work
becomes pure overhead. That asymmetry is why LRU is the floor and flag/lazy-promotion
policies are the members; the bench tool + OPT let a caller measure it, and the v2
meta-policy can shed the overhead at runtime.

---

## 3. The moat is the substrate + oracle + uniform API -- not any one algorithm

Each algorithm on the list has multiple public implementations. The differentiator
is the combination the suite is uniquely positioned to ship:

1. **Zero-alloc** implementations (the whole suite's law),
2. behind **one uniform interface** (`get/put/delete/has/peek/capacity`), so
   policy is a one-line swap,
3. all checked against **one parameterized differential oracle** and **one
   zero-alloc gate**, so a caller can trust every member equally and benchmark
   them on their own trace with the same harness.

That is why the **shared keyed-index substrate (old S4) moves to the FRONT**: it
is the single thing that makes every member zero-GC, and once it exists each
strategy is a thin policy over {keyed index -> slot, preallocated SoA slot
columns, intrusive Int32Array lists}. Building SIEVE before the substrate would
mean building the hard part (a zero-GC keyed index) twice.

I am confident in this one; it is a direct application of the blueprint's
"build the harness once, extend it each session" and "one invariant catches most
bugs." Flagging it here only because it inverts the old S0->S4 order.

---

## 4. Curation cuts -- what I would DEFER out of the v1.x family

The blueprint's own warning: "shipping 15 near-identical variants is noise." The
pasted analysis lists ~11 plus exotics. My v1.x family is **7** (classic + 6),
and even inside that I flag two. Deferred to this debate, not the roadmap:

- **LRU-K (LRU-2).** K timestamps per key + a correlated-reference period to tune.
  On the web/skew/scan workloads that motivate the family, SIEVE and S3-FIFO
  dominate it at lower metadata. Include only if a caller shows a trace where
  reuse-distance ranking beats them.
- **LIRS / ClockPro.** Genuinely high value (best scan resistance of the lot) but
  the stack-pruning is the fiddliest code in the family and the easiest to get
  subtly wrong. It is the natural *stretch* member -- ship it after the trio has
  proven the substrate + oracle carry a complex policy, or not at all.
- **LFU / Heap-LFU / aging.** O(log n) reheapify on the hot path (fights O(1)),
  and dynamic aging is a second tuning knob. W-TinyLFU already captures "frequency
  matters" with a fixed sketch and O(1) ops -- it dominates pure-LFU for this
  suite. Defer unless a pure-frequency workload appears.
- **MQ / CAR / sampling / size-aware.** Out of the v1.x family entirely; revisit
  only on a concrete request. (Size-aware is a different axis -- see item 8.)

If you want any of these promoted, name it and I add a brief.

---

## 5. W-TinyLFU ranks ABOVE ARC for THIS suite (the analysis ordered them the other way)

The pasted list puts ARC at #6 and W-TinyLFU at #7. For a zero-GC, fixed-capacity
library I would flip them:

- **W-TinyLFU's Count-Min sketch is a fixed-size typed array.** It is literally
  "bytes in a hot body": preallocate `Uint8Array`/`Uint16Array` counters at
  construction, increment on access, halve on reset. Zero allocation, bounded
  metadata, O(1). It is the *most* on-law member of the whole family.
- **ARC's two ghost lists roughly DOUBLE the key-index metadata**, and its
  adaptive parameter `p` means the effective split between recency and frequency
  moves at runtime. That is in direct tension with law 3 ("capacity is fixed and
  load-bearing"). ARC is still worth shipping -- it is the gold-standard adaptive
  baseline and the patent has expired -- but it is the member that STRESSES the
  laws, so it lands later and its decision record has to own the ghost-metadata
  and variable-split honesty up front.

Roadmap reflects this: W-TinyLFU is a headline (S6), ARC is a flagged later
member (S8).

---

## 6. CLOCK vs SIEVE -- is that two costumes for one idea?

SIEVE is, roughly, CLOCK with a smarter hand and no promotion. Both keep a ring
and a reference bit; both find a victim by sweeping a hand and clearing bits.
Shipping both risks exactly the "near-identical variant" noise the blueprint
warns about.

**My lean: SIEVE only in v1.x; CLOCK deferred.** SIEVE matches or beats CLOCK on
the web traces and is barely more code. CLOCK earns a slot only as the
"approximate-LRU teaching member" if you want the family to show the LRU->CLOCK->
SIEVE lineage explicitly. If you do, I add it as a small member between classic
and SIEVE; if not, it stays out. Your call -- this one is close.

**RESOLVED: OUT of the family.** Maintainer confirmed. CLOCK (and ClockPro) are
too close to SIEVE to earn a family slot; if ever wanted they ship on-demand as a
standalone module, not as a member here.

---

## 7. Packaging under the single-file law -- NO subpath-per-strategy

The pasted analysis assumes "separate entry points" for tree-shaking. The suite
law is "single PascalCase main file." These reconcile cleanly and I want it
settled so nobody later splits the package:

- **One `Lru.js`, N named exports** (`LiteLru`, `Sieve`, `S3Fifo`, `WTinyLfu`,
  ...). Tree-shaking already works via ESM named imports + `"sideEffects": false`
  (already set in package.json). Importing `{ Sieve }` drops every other
  strategy's body.
- The shared substrate is **internal**, not a second package and not an export.
- No `./sieve` subpath, no per-strategy file. That would be a different package
  shape than the rest of the suite and buys nothing over named exports.

Stated as law in the roadmap (section 1).

---

## 8. Size-aware / cost-aware is a real axis -- but it is a v2 TRACK, not a member

The one genuinely-different idea in the "exotic" list is size/cost-awareness:
when cached objects have very different byte sizes or refetch costs, "evict the
LRU entry" is the wrong question -- you want "evict to reclaim N bytes at least
cost." That changes the capacity model from *entries* to *bytes/cost*, which
touches the constructor contract (`capacity` becomes a budget) and the eviction
loop (evict until the budget fits, possibly several entries per put).

It is worth doing, but it is NOT a drop-in family member behind the same
interface -- it changes the interface. So: a separate v2 track (or even a sibling
package `lite-cache-budget`), not squeezed into the uniform-API family. Parked
here so it is not forgotten and not mis-scoped.

---

## 9. Hit-ratio honesty gate (borrowed from lite-binary-reader)

No hit-ratio or "beats ARC/LRU" number ships without (a) the named trace it was
measured on and (b) the oracle-checked benchmark that produced it, with the same
provenance stamp lite-binary-reader's bench uses. Paper claims ("SIEVE beats ARC
on web traces") are cited as *motivation*, never reproduced as *our* numbers until
we have run them on a trace in-repo. A benchmarked lie is worse than no benchmark.

---

## 10. The incumbents, and why zero-GC alone is NOT the moat (RESOLVED)

Maintainer research surfaced the two dominant packages; this pins the honest
competitive read so the pitch never overclaims.

- **`lru-cache` (isaacs), the gorilla.** v7+ is ALREADY typed-array-backed: a
  `Map` keyMap + preallocated Uint `keyList`/`valList`/`next`/`prev` link columns +
  a free list. Its steady-state get/set is already largely GC-friendly. It is also
  feature-maximal: TTL, size/cost-aware (`sizeCalculation`), async `fetchMethod`
  with in-flight dedup + stale-while-revalidate, `dispose`/`disposeAfter`,
  iteration, `dump`/`load`. ~1000+ lines, one module, LRU-only, not tree-shakeable
  to a subset.
- **`quick-lru` (sindresorhus), the minimalist.** Tiny two-`Map`-swap trick,
  minimal features, single naive policy. We beat it on zero-GC (the Map-swap
  churns) and on policy choice; it beats us on sheer simplicity.

**Consequence: "we are the zero-GC LRU" is FALSE-by-obsolescence against
`lru-cache` -- do NOT claim it.** And chasing its kitchen sink (TTL + fetch +
size-aware + dispose + ...) is a scope-exploding, losing game that also fights our
fixed-capacity / zero-GC identity. Win on a DIFFERENT axis. The moat is the
combination neither incumbent can copy:

1. **A family of policies under ONE swappable interface** (LRU + SIEVE + S3-FIFO +
   W-TinyLFU + ...). `lru-cache` is LRU-only; `quick-lru` is one naive policy.
2. **Tree-shake to ONE tiny policy** (`import { Sieve }` -> sub-KB). The edge /
   serverless / browser / game-loop story (Workers, Deno, bundle budgets).
3. **The shared harness SHIPPED as a user-facing tool** -- replay YOUR trace, get
   hit-ratio + writes-per-hit + alloc per policy. Turn "which eviction policy?"
   from folklore into measurement. This is the KILLER feature; lead the README
   with it. It is the natural product of the parameterized oracle S1 already built.

The "fewer writes per hit" micro-win (SIEVE 1 bit vs LRU ~5 relinks) is a real but
MINOR corroborator -- matters for GC-pause-sensitive realtime/game loops. Framed as
a micro-win, never "lock-free / scalable" (item 2).

## 11. The feature axis -- a FOCUSED set, not `lru-cache` parity (RESOLVED)

Add only features that serve the "measure & trust, zero-GC" thesis and stay on-law
(fixed capacity, pay-for-what-you-use, tree-shakeable). Each is cross-cutting
(shared by every member) and lands AFTER the substrate (S3) so members inherit it.

ADD:
- **Zero-GC TTL** -- the one table-stakes feature we cannot skip. An opt-in
  `Float64Array` expiry column in the SoA slot layout, checked lazily on get
  (expired -> miss), allocated ONLY when `ttl` is used. On-law where `lru-cache`
  allocates more freely.
- **Zero-GC iteration** (`keys`/`entries`/`values` in recency order) -- reuse the
  borrowed-tuple / hand-written-iterator pattern from `lite-binary-reader` S12
  (a generator would allocate an IteratorResult per step). `lru-cache`'s iterators
  allocate; ours will not. Direct suite synergy.
- **Opt-in stats** (hit / miss / evict / writes-per-hit) -- integer increments,
  zero-alloc, off by default. Feeds the measurement story; no incumbent gives
  hit-ratio out of the box.
- **onEvict** -- already shipped and hardened (0002). Keep.
- **Snapshot / restore** (warm-start) -- LATER/maybe: the SoA columns ARE the
  serial form, so `dump`/`load` is cheap; useful for edge cold-starts. Not v1.

EXCLUDE from the core (with landing spots, so they are not mis-scoped):
- **Async `fetchMethod` / dedup / stale-while-revalidate** -- Promises allocate and
  async fights zero-GC. If wanted: a thin separate composition package
  (`lite-lru-fetch`) or a documented recipe. NEVER in the hot core.
- **Size / cost-aware capacity** -- separate track / sibling `lite-cache-budget`
  (item 8): it changes the capacity model (entries -> bytes).
- **SharedArrayBuffer / cross-worker** -- a FUTURE separate package; the typed-array
  SoA makes it plausible, but it is a different concurrency contract. Do not claim
  it now.

## 12. FIFO-reinsertion / lazy-promotion is a PRINCIPLE, not a member (RESOLVED)

The "FIFO-reinsertion / lazy-promotion" idea in the survey is exactly what SIEVE
(set a bit, promote nothing) and S3-FIFO (promote at eviction) already embody. It
does not earn its own member slot; it is documented as the design principle
underlying the modern members, not shipped separately.

---

## 13. Belady's OPT as the harness reference point (RESOLVED, from RESEARCH.md)

The shipped benchmark tool (item 10, pillar 3) gets an ABSOLUTE reference: Belady's
OPT/MIN, the clairvoyant offline optimum (evict the entry whose next use is
farthest). It turns "SIEVE hit 82%" into "97.6% of optimal" -- the line no
incumbent can print. Lives STRICTLY in the offline harness (`lite-lru-benchmark`);
NEVER a production policy. RESEARCH.md carries a practical impl (reverse-scan
next-use + lazy-deletion max-heap with amortized rebuild, bounded to ~4x capacity).

**Non-negotiable gate:** because every "% of optimal" number leans on it, the OPT
implementation MUST be differential-tested against a brute-force O(N*C) OPT on
small seeded traces, replayable -- the same honesty discipline as item 9. A wrong
clairvoyant reference is worse than none.

## 14. Two v2 experimental tracks worth keeping (RESOLVED, from RESEARCH.md)

- **LiteMGLRU** -- a userspace, fixed-capacity, zero-GC approximation of Linux's
  Multi-Gen LRU (merged 6.1): 4 generations, 1 byte/slot (visited bit + 2 gen
  bits), `get` sets a bit only, cascading tail eviction. Genuine novelty/attention
  value. V2 EXPERIMENTAL. When built as a family member it MUST conform: `put` not
  `set` (LiteCache surface), the `[lite-lru]`-tagged `RangeError` not `TypeError`,
  and the "O(1) amortized eviction" claim softened (the all-visited cascade is
  amortized-bounded, not strictly O(1)).
- **Self-measuring meta-policy** -- a zero-GC controller that watches the live S12
  stats and auto-switches between simple modes (recency-biased <-> frequency-biased).
  The one adaptive idea still genuinely differentiated; it consumes the stats the
  family already exposes and strengthens the measure-&-trust moat. V2 research.

## 15. lite-fastbit32 is NOT a runtime dependency (RESOLVED)

RESEARCH.md floats `@zakkster/lite-fastbit32` for flag-centric policies (SIEVE's
visited bit). Maintainer confirmed: a runtime dep would BREAK the suite's zero-
runtime-deps law (the law that kept lite-binary-reader dep-free). Bit-packing, IF
T6 shows density matters, is INLINED into Lru.js (mask/shift, a few lines) and
decided at S4 (D12). `lite-fastbit32` may exist as a standalone package for other
consumers; lite-lru never imports it. Keep it a technique, not a dependency.

---

## Summary of what I need from you

- **Item 1 (identity fork):** RESOLVED = B (reframe). [[decisions in ROADMAP]]
- **Item 6 (CLOCK):** RESOLVED = out of family (on-demand standalone if ever).
- **Items 10/11/12:** RESOLVED (incumbent-aware thesis; focused feature axis;
  FIFO-reinsertion as principle) -- maintainer approved.
- **Items 13/14/15:** RESOLVED (Belady OPT in the harness + its correctness gate;
  LiteMGLRU + self-measuring meta-policy as v2 tracks; lite-fastbit32 inlined, not
  a dep) -- from RESEARCH.md, maintainer approved.
- Items 4/5/7/8/9 decided as written; 2/3 are corrections, not debatable.
- Nothing open. The roadmap is on the live path. Deep research reference: RESEARCH.md.
