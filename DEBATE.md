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

## Summary of what I need from you

- **Item 1 (identity fork):** confirm B (reframe) or pick A (extend). Everything
  else assumes B.
- **Item 6 (CLOCK):** in or out? I lean out.
- Items 4/5/7/8/9 I have decided as above; veto any you dislike.
- Items 2/3 are not really debatable (they are corrections), but flagged so you
  see the reasoning that reshaped the roadmap.
