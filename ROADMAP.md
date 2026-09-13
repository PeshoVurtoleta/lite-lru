# @zakkster/lite-lru -- enriched roadmap (multi-strategy family)

A greenfield package built to the suite's laws from commit one. Modeled on
`../BLUEPRINT_ROADMAP.md`: shared law, design decisions on the record, session
briefs anchored to a decision (not a finding -- there is no legacy code to
reproduce bugs in), a torture-suite spec, and one conservation invariant that
catches most structural bugs at once.

---

## 0. Why this roadmap changed (read this first)

The previous roadmap scoped the package as ONE polished classic LRU (Map +
intrusive DLL) plus an integer-key zero-GC variant, targeting v1.0.0. That plan
is not wrong -- it is just not a *moat*. "A basic doubly-linked-list + hashmap LRU
is a solved problem; anyone can build it." Shipping one as the headline spends the
version number on the commodity.

**The new identity: a tree-shakeable family of zero-GC cache-replacement
strategies, each anchored to a workload problem classic LRU handles badly.** The
differentiator is NOT any single algorithm (each has public implementations). It
is the combination this suite is uniquely positioned to ship:

1. **zero-alloc** implementations (the suite law),
2. behind **one uniform interface** -- policy is a one-line swap,
3. all checked against **one parameterized differential oracle** and **one
   zero-alloc gate**, so every member is trustworthy equally and a caller
   benchmarks them on their OWN trace with the same harness.

**Against the incumbents (DEBATE item 10).** `lru-cache` (isaacs) is ALREADY
typed-array-backed (Map + preallocated Uint link columns + free list) and
feature-maximal (TTL, size-aware, async fetch, dispose) -- so "we are the zero-GC
LRU" is FALSE against it and must never be the pitch. `quick-lru` is tiny but a
single naive Map-swap policy. The moat is what neither can copy: (1) a FAMILY of
policies behind one swappable interface, (2) tree-shake to ONE sub-KB policy
(`import { Sieve }`) for edge/serverless/browser/game budgets, and (3) the shared
harness SHIPPED as a user-facing tool -- replay YOUR trace, get hit-ratio +
writes-per-hit + alloc per policy. That measurement tool is the KILLER feature and
the README lead; the "fewer writes per hit" edge is a real but MINOR corroborator,
never "lock-free" (item 2).

Two structural consequences follow, and they reorder the whole plan:

- **Classic LRU is demoted from headline to reference member + differential
  oracle + honest floor** -- exactly how `lite-binary-reader` treats a
  hand-written DataView loop as the floor every contender is measured against.
- **The shared keyed-index substrate (old S4) moves to the FRONT.** It is the one
  thing that makes EVERY member zero-GC; once it exists, each strategy is a thin
  policy over it. Building a modern strategy before the substrate means building a
  zero-GC keyed index twice.

Open questions and the points where I diverge from the originating analysis are in
`DEBATE.md`. This roadmap is written as if those are settled the recommended way;
`DEBATE.md` item 1 (does the family REPLACE or EXTEND the v1.0.0 plan) is now
RESOLVED = REPLACE (B), confirmed at S1 -- everything below is on the live path.

**State.** Committed: the classic core `Lru.js` (Map + intrusive preallocated DLL,
onEvict reentrancy-hardened 0002), the S1 node:test + torture harness + parameterized
oracle, and (staged) the S2 `Lru.d.ts` + `LiteCache<K,V>` interface + dts-drift gate
+ tsc type-test. VERSION still 0.1.0 (moves at /release). Ahead: the substrate (S3),
every modern strategy (S4-S8), the cross-cutting features (S10-S12), and the docs +
shipped bench tool (S9). Deep research reference: `RESEARCH.md` (Belady OPT,
LiteMGLRU, meta-policy; distilled into DEBATE items 13-15).

| Piece | State |
| --- | --- |
| `Lru.js` classic core (get/put/delete/has/peek/clear) | **built, smoke-verified** |
| package scaffold (package.json, LICENSE) | **built** |
| decisions/0001-structure | **written** |
| node:test suite + torture harness + oracle | **built + gated (S1)** |
| Lru.js onEvict reentrancy fix (decisions/0002, amends D8) | **built + gated (S1)** |
| `Lru.d.ts` + family interface | S2 |
| shared keyed-index substrate (was S4, now the keystone) | **built + gated (S3)** |
| SIEVE | **built + gated (S4)** |
| S3-FIFO | **built + gated (S5)** |
| W-TinyLFU | **built + gated (S6)** |
| 2Q / SLRU | S7 |
| ARC (flagged -- stresses the fixed-capacity law) | S8 |
| README + llms.txt + CHANGELOG + shipped benchmark/trace-replay tool | **built + gated (S9)** |
| zero-GC TTL (opt-in expiry column) -- cross-cutting | **built + gated (S10)** |
| zero-GC iteration (keys/entries/values, per-member defined order) -- cross-cutting | **built + gated (S11)** |
| opt-in stats (hit/miss/evict; writes-per-hit stays torture-only) -- cross-cutting | **built + gated (S12)** |
| snapshot / restore (dump/load; SoA columns are the serial form) | later/maybe (DEBATE 11) |
| LRU-K, LIRS/ClockPro, LFU, MQ/CAR | `DEBATE.md` item 4 (deferred) |
| CLOCK/ClockPro (out of family), async fetch (-> `lite-lru-fetch`), size-aware (-> `lite-cache-budget`) | `DEBATE.md` items 6/8/11 (out of core) |
| Belady OPT reference (offline harness normalization) | **built + gated (S9, t8 gate + Bench.mjs)** |
| LiteMGLRU (userspace Multi-Gen LRU) + self-measuring meta-policy | v2 research (DEBATE 14, RESEARCH.md) |
| animated policy-visualization demo (each member's mechanics on one trace + % of optimal; in-repo demo/, never shipped) | post-1.0.0 S13 (DEBATE 16) |

---

## 1. Shared law (holds every session)

Inherited from `../CLAUDE.md`, plus LRU-family-specific rules:

1. **Zero allocation on any hot path.** get/put/delete/has/peek, for EVERY member.
   The slot/list layer is *strictly* zero-alloc and must be proven so. Any hash
   layer that resizes (the v0.1.0 `Map`) is *amortized* -- that asymmetry is
   stated, not hidden (D3). The substrate (S3) removes it for good.
2. **Fail closed.** An invalid capacity throws at the door (D9). null is not zero.
   A miss is `undefined`; the `undefined`-value ambiguity is documented (D7).
3. **Capacity is fixed and load-bearing.** No member ever exceeds capacity; there
   is NO growth path. All slots preallocated once. A member's AUXILIARY metadata
   (ghost lists, frequency sketch) is ALSO fixed at construction -- a growing
   sketch or ghost list is a rejected design. A member that cannot bound its
   metadata is deferred or documented as amortized in its decision record.
4. **One slot, one list.** A slot is in exactly one intrusive list (or the free
   stack) at a time. The conservation invariant (section 3) makes it checkable,
   generalized across however many lists a member keeps.
5. **The member's policy is explicit and pinned.** Which operations touch recency/
   admission/frequency is a spec choice PER MEMBER (classic LRU: get+put promote,
   has+peek do not; SIEVE: get sets a bit, promotes nothing; S3-FIFO: get sets a
   bit, moves nothing until eviction). Pin each member's policy with named tests
   so a refactor cannot silently flip it.
6. **Uniform interface.** Every member exposes the SAME surface --
   `get/put/delete/has/peek`, `size`, `capacity`, `clear`, optional zero-GC
   `onEvict` -- with the SAME hit/miss semantics. The recency/admission/frequency
   difference is INTERNAL. A caller swaps `new LiteLru(n)` for `new Sieve(n)` and
   nothing else changes. Divergence in surface is a rejected design.
7. **Single file, named exports (NOT subpath-per-strategy).** One PascalCase
   `Lru.js`; each member is a named export (`LiteLru`, `Sieve`, `S3Fifo`,
   `WTinyLfu`, ...). Tree-shaking is via ESM named imports + `"sideEffects":
   false` (already set): `import { Sieve }` drops every other member's body. The
   shared substrate is INTERNAL -- not an export, not a second package. (See
   `DEBATE.md` item 7.)
8. **Honest workload claims.** No hit-ratio or "beats X" number ships without the
   named trace it was measured on AND the oracle-checked benchmark that produced
   it, with a provenance stamp (the `lite-binary-reader` bench precedent). Paper
   claims are cited as MOTIVATION, never reproduced as our numbers until run
   in-repo. The pitch is "fewer writes per hit + better hit ratio on skewed/scan
   workloads" -- NEVER "lock-free / scalable," which is a multi-core systems-
   language argument that does not transfer to single-threaded JS (`DEBATE.md`
   item 2).
9. **Every gate must be able to fail.** Each torture tier ships a deliberately
   broken control variant that exits non-zero.

---

## 2. The workload map + strategy roster (decisions on the record)

Greenfield: no bugs to reproduce, so this section is the roster and the WHY, the
analogue of the blueprint's "verified findings." Each member earns its slot by
occupying a DISTINCT point on the workload map at bounded, zero-GC metadata cost.

| Member | Uniquely solves | Per-entry / aux metadata | Writes per hit | Zero-GC posture | Slot |
| --- | --- | --- | --- | --- | --- |
| **LiteLru** (classic) | strong temporal locality; the reference + oracle + floor | 2 links | ~6 relinks | strict on slot layer (Map amortized until S3) | built (S0), floor |
| **Sieve** | one-hit-wonder-heavy web/CDN; simplest modern high-performer | 1 visited bit + 1 hand index | **1 bit** | strict (S3 substrate) | S4 (headline) |
| **S3Fifo** | general-purpose + scan resistance; strong hit ratio, low metadata | 3 FIFO queues + small ghost | **~0** (bit at eviction) | strict | S5 (headline) |
| **WTinyLfu** | skewed / Zipf popularity + admission control | window + SLRU + **fixed CM sketch** | 1 bit + 1 counter inc | strict (sketch is a fixed typed array -- the MOST on-law member) | S6 (headline) |
| **TwoQ / Slru** | scan / one-hit filtering, the simplest scan-resistant baseline | 2 lists (probation + protected) | ~6 (protected) / 0 (probation) | strict | S7 |
| **Arc** | phase-changing workloads; self-tuning, no knobs | 2 lists + **2 ghost lists** + adaptive `p` | ~6 relinks | strict, but FLAGGED: ghost metadata + variable split stress law 3 | S8 (flagged) |

Deferred to `DEBATE.md` (not in v1.x): **CLOCK** (likely one idea in two costumes
with SIEVE), **LRU-K** (K timestamps/key, dominated by SIEVE/S3-FIFO here),
**LIRS/ClockPro** (best scan resistance but the fiddliest code -- stretch member),
**LFU/Heap-LFU** (O(log n) hot path; W-TinyLFU captures frequency at O(1)),
**size/cost-aware** (a different capacity model -- a v2 track, not a member).

**Release framing.** v1.0.0 = classic + substrate + **SIEVE** + the **shipped
benchmark/trace-replay tool** + docs (a differentiated, measurable family, not a
bare LRU). Each further member is an additive minor -> v1.x. The cross-cutting
FEATURE axis (DEBATE item 11) -- zero-GC TTL (S10), zero-GC iteration (S11),
opt-in stats (S12) -- lands as v1.x minors AFTER the substrate so every member
inherits it; TTL is table-stakes and should land early in the v1.x train. ARC and
the deferred set only land on a real request or a trace that justifies them.
async-fetch, size-aware, and CLOCK are out of the core (separate packages /
on-demand -- DEBATE items 6/8/11).

---

## 3. The conservation invariant (catches most structural bugs at once)

Stated for classic LRU, generalized per member:

```
size + freeListLength() === capacity          (every slot accounted for)
index.size === size                            (keyed index and list agree)
sum(length of every intrusive list) === size   (no lost/duplicated links)
prev/next reciprocal for every active DLL slot  (doubly-linked members)
ghost.size <= ghostCapacity                     (ARC/S3-FIFO: ghosts bounded)
```

O(capacity) to check, so it lives in `validate()` and between torture phases,
never on a hot path. Any free-list, DLL, queue, or ghost-list bug violates it
immediately. It is the centrepiece of S1 and every member extends it with its own
list count -- the same helper, one more term.

---

## 4. The torture suite (`test/torture.mjs`) -- spec

One harness, tiers in order, prints exactly "ok" / exits 0-1. Built in S1,
extended by every member. `test/` never enters `package.json` `files[]`
(`npm pack --dry-run` proves it). The KEY design that makes a family affordable:
the oracle is **parameterized by policy**, so one harness checks every member.

### Layout
```
test/
  Lru.test.js         # node:test boundary suite (classic semantics)
  <Member>.test.js    # one per member (S4+): its own policy laws
  torture.mjs         # entry: runs tiers in order for every registered member
  torture/
    harness.mjs       # scratch pool, zero-alloc asserts, seeded xorshift32 PRNG,
                      #   the PARAMETERIZED oracle runner (policy plugged in)
    oracles/          # one brute-force reference per policy:
      lru.mjs         #   array-scan recency
      sieve.mjs       #   brute hand + visited bits
      s3fifo.mjs      #   brute three-queue + ghost
      wtinylfu.mjs    #   brute sketch + SLRU admission
    t0-laws.mjs       # metamorphic laws, per-member policy
    t1-degenerate.mjs # nasty keys/values
    t2-adversarial.mjs# sequences crafted to break the member's structure
    t5-fuzz.mjs       # differential fuzz vs the member's brute oracle
    t6-alloc.mjs      # zero-alloc gate + writes-per-hit counter
    t7-soak.mjs       # churn + conservation invariant per cycle
    t9-controls.mjs   # every gate above, deliberately broken, must fail
  controls.mjs        # entry for the control (must-fail) variants
```

### Tier T0 -- metamorphic laws (per member)
The member's own policy, stated as laws. Classic LRU: get/put promote, has/peek
neutral, exactly the first-inserted evicted at cap+1. SIEVE: a hit sets the bit,
the hand evicts the first unvisited; a visited entry survives exactly one sweep.
S3-FIFO: a hit is recorded but does not move the entry; promotion small->main
happens only at eviction; a one-hit wonder leaves via the small queue. Each member
ships its law set; the runner asserts them over the fuzz corpus.

### Tier T1 -- degenerate keys/values
Cross ops with keys `0`, `-0`, `NaN` (SameValueZero -> one key), `""`, `undefined`,
`null`, object identity, long string; values `undefined` (the has()-disambiguation
case, D7), `null`, `0`, `NaN`, object. Pin the actual answer for each, as contract.

### Tier T2 -- adversarial sequences (per member)
- Always re-hit the MRU / the hand position N times: the promote/no-op fast path
  must do the minimum writes (LRU early-returns; SIEVE just sets a bit).
- Always hit the tail then insert: exercises detach-tail + evict repeatedly.
- Alternate insert/delete at the free-list boundary (0<->1, cap-1<->cap).
- Fill, delete-all (insertion / reverse / random), refill -- conservation each phase.
- Single-capacity member (`new X(1)`): every put evicts; head===tail always.
- Scan flood (S3-FIFO/2Q/SIEVE): a burst of distinct one-hit keys must NOT evict
  the proven-hot set -- the scan-resistance claim, as an executable assertion.

### Tier T5 -- differential fuzz vs the member's brute oracle
100k mixed ops (get/put/delete/has/peek) against the parameterized brute oracle.
After each: same value returned AND same eviction victim on the next
over-capacity put. Divergence prints seed + op index for one-env-var replay.

### Tier T6 -- the zero-alloc gate (+ writes-per-hit)
```js
// slot/list layer: STRICT zero on every member.
const summary = await measureOps(runHotOpsPrefilled, { stabilize: 'deep', ... });
checkNoGc(summary, { maxMajor: 0, maxPauseMs: 4 });
// backing stores never grow:
assert.equal(x._next.buffer.byteLength, BYTES_BEFORE);
// and the honest zero-GC pitch, measured (DEBATE item 2):
assert.ok(writesPerHit(Sieve)  <  writesPerHit(LiteLru)); // 1 bit vs ~6 relinks
```
Run the hot loop on a PRE-FILLED, at-capacity member so no hash resize is in play,
isolating the strict-zero claim. Post-S3 (substrate) the pre-fill caveat is gone.

### Tier T7 -- soak & conservation
`leak_cycles` build-up / tear-down cycles. After each: `size===0` post-clear, or
the (generalized) conservation invariant mid-life. Sample the heap across cycles.

### Tier T9 -- controls (the gate must fail)
Per member: a broken `_detach` that dangles a prev; an evict that forgets the
index delete (leaks a key); a `get` that skips the member's policy step (breaks
recency/admission); a hot loop that allocates a `{}` per op; a sketch/ghost that
grows. If a control passes, the gate is decorative.

---

## 5. Session order

```
S0 (done) --> S1 (done) --> S2 --> S3 (substrate/keystone) --> S4 (SIEVE) --> S5 --> S6
                            \--> S9 (docs + shipped bench tool, parallel)  |    |     |
                                                          [v1.0.0 gate here: S4]
S7 (2Q/SLRU) and S8 (ARC) are additive minors after S6.
Cross-cutting FEATURE axis (after S3, inherited by all members): S10 TTL, S11
zero-GC iteration, S12 stats -- v1.x minors; TTL lands early in the train.
```

S1 (tests + torture + oracle) blocks everything and is DONE (gated green;
onEvict-reentrancy defect found + fixed, 0002). **S3 (the shared keyed-index
substrate) is the keystone**: it removes the Map allocation frontier and gives
every later member a strictly zero-GC keyed index for free. S4 (SIEVE) is the first
member built ON the substrate and proves the oracle is parameterizable. v1.0.0
releases at S4 -- a family with a floor + a modern headline + the shipped
measurement tool, not a bare LRU. S5/S6 add the rest of the headline trio; S7/S8
fill out the map; S9 (docs + promoting the S1 harness to a user-facing bench tool)
runs parallel from S2; S10-S12 add the feature axis once the substrate exists.

---

## 6. The briefs

===============================================================================
# S0 -- v0.1.0 -- classic core structure  [DONE]
===============================================================================
```markdown
package: "@zakkster/lite-lru"
version_target: 0.1.0
status: done
decisions: [D1, D2, D4, D5, D6, D7, D8, D9]
blocks: [S1]
```
Built: `Lru.js` (Map + intrusive preallocated DLL; get/put/delete/has/peek/clear;
onEvict; fail-closed capacity), `package.json`, `LICENSE`,
`decisions/0001-structure.md`. Smoke-verified across 8 invariants. In the new
framing this is the REFERENCE member + the differential oracle, not the headline.
NON-GOALS met: no tests yet, no docs, no d.ts.

===============================================================================
# S1 -- v0.1.1 -- node:test suite + torture harness + parameterized oracle
===============================================================================
```markdown
version_target: 0.1.1
status: implemented -- gated green, awaiting /release 0.1.1
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0   # slot layer strict; Map layer amortized until S3 (D3)
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
decisions: [D10, "0002 (onEvict reentrancy, amends D8)"]
depends_on: [S0]
blocks: [S2, S3]
```
WHAT LANDED (S1, working tree, uncommitted; VERSION still 0.1.0 until /release):
  - test/: node:test suite (32 cases) + torture harness with the POLICY-PARAMETERIZED
    differential runner (drives LiteLru + a FIFO seam policy) + oracles + T0/T1/T2/T5/T6/T7/T9
    + out-of-process must-fail controls. validate() = the generalized conservation invariant.
  - Gates: npm test 32/32; torture prints "ok"/exit 0; controls "ok"/exit 0; npm pack excludes
    test/ + decisions/. Writes-per-hit baseline pinned: head 0 / interior 5 / tail 4.
  - DEFECT FOUND + FIXED (qa): onEvict reentrancy corrupted the lists (size>capacity, phantom
    slot -1, validate() hang). Fix = fire onEvict LAST (cache consistent) + fail-closed guard on
    put/get/delete/clear (has/peek stay open). Recorded in decisions/0002 (amends D8). Regression
    pinned; reviewer verified the tests fail against the pre-fix code (real teeth).
PURPOSE
  Prove the classic structure AND build the harness the whole family leans on.
  Highest priority; nothing else starts until the gate is green and controls fail.
TASKS
  - `test/Lru.test.js` (node:test): every public method, every recency law (T0),
    the D7 undefined-value case, fail-closed capacity, clear.
  - `validate()` (test/debug only): the conservation invariant (section 3),
    written GENERALIZED (a list-count sum) so members extend it with one term.
  - `test/torture.mjs` + `harness.mjs`: wire T0, T1, T2, T5, T6, T7, T9 for
    classic LRU. Build the **parameterized oracle runner** now, even though only
    the LRU oracle exists -- the seam is the point.
  - `test/torture/oracles/lru.mjs`: the brute-force array-scan reference.
  - `test/controls.mjs`: the broken variants from T9.
  - **T6 asymmetry**: strict-zero gate on a PRE-FILLED at-capacity cache (no Map
    resize in scope); assert backing-store byteLength unchanged; add the
    writes-per-hit counter (foundational for the DEBATE-item-2 honest pitch).
ASSERTIONS
  - `node --test` green; every recency law named and passing.
  - `node --expose-gc test/torture.mjs` prints exactly "ok", exit 0.
  - Every T9 control exits non-zero.
  - Conservation invariant holds after every T2 sequence.
  - The oracle runner accepts a policy argument (LRU today) -- proven by a second
    trivial policy stub it also drives.
  - `npm pack --dry-run` excludes test/.
DONE WHEN
  tests green; torture "ok"; controls fail; conservation proven under adversary;
  the oracle runner is policy-parameterized

===============================================================================
# S2 -- v0.2.0 -- Lru.d.ts + the family interface
===============================================================================
```markdown
version_target: 0.2.0
status: planned
depends_on: [S1]
```
The shared TypeScript surface EVERY member implements: a `LiteCache<K, V>`
interface (get/put/delete/has/peek/clear, size, capacity, onEvict) that
`LiteLru<K,V>` -- and later `Sieve`, `S3Fifo`, ... -- all satisfy, so the one-line
policy swap is type-checked. `VERSION`. Assert `.d.ts` matches the runtime (no
drift -- the blueprint lists d.ts drift as a recurring finding class). Add to
`files[]`. Defining the interface HERE, before the members, is what keeps law 6
(uniform surface) enforceable rather than aspirational.

===============================================================================
# S3 -- v0.3.0 -- the shared keyed-index substrate (THE KEYSTONE)
===============================================================================
```markdown
version_target: 0.3.0
status: implemented -- gated green (74 tests, int strict-zero Gate INT, +33 int-backing node:tests), awaiting /release 0.3.0
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
decisions: [D3, D11]
depends_on: [S1]
blocks: [S4, S5, S6, S7, S8]
```
PURPOSE
  Remove the last allocation frontier (D3): the `Map`. Replace it with an
  open-addressed hash over typed arrays (linear probing / Robin Hood, tombstones,
  fixed load factor -- see Learning/HashTables.md). Then classic get/put/delete
  are STRICTLY zero-alloc, not just amortized -- AND every later member inherits a
  zero-GC keyed index for free. This is why it moved from the old S4 tail to the
  front: it is built ONCE and every headline member stands on it.
THE DECISION (record in decisions/0011-substrate.md BEFORE coding)
  A. Integer (or hash-to-integer) keys only, in a shared internal `SlotStore`
     (keyed index + SoA slot columns + a free stack) that classic LRU and every
     member compose. Arbitrary-key members keep the Map path as a documented
     amortized fallback; integer-key members get strict zero.
  B. A pluggable key strategy on a single store (more surface, one code path).
  Recommendation: A. A shared internal substrate with a typed-array index for the
  integer path and a Map fallback for arbitrary keys is honest and keeps each hot
  method monomorphic. Record the arbitrary-key amortized caveat explicitly.
TASKS
  - Build the internal `SlotStore` substrate: keyed index (typed-array open
    addressing + Map fallback), preallocated SoA slot columns, one free stack.
  - Refactor classic `LiteLru` onto it with ZERO semantic change -- the S1 suite
    must pass byte-for-identical-results (the oracle proves it).
  - Generalize `validate()` and the conservation invariant onto the substrate.
  - Extend T6: the integer-key path is STRICT (maxMajor:0 AND no ArrayBuffer
    growth) with NO pre-fill caveat -- the whole point is even the index never
    allocates.
ASSERTIONS
  - Classic LRU on the substrate: identical results vs the S1 oracle across the
    full T5 corpus.
  - Integer-key path: strict-zero T6 with no pre-fill caveat; index buffer never
    grows under a 100k-op churn at capacity.
  - Differential fuzz: substrate-backed LiteLru vs Map-backed reference, identical.
  - torture "ok"; controls fail (a growing index control must fail).
NON-GOALS
  No new member yet (S4). No behaviour change to the LRU policy -- substrate only.
DONE WHEN
  classic LRU rides the substrate with identical results; integer path strictly
  zero-alloc with no caveat; every later member has a zero-GC index to build on

===============================================================================
# S4 -- v1.0.0 -- SIEVE (first modern member + the v1.0.0 release)
===============================================================================
```markdown
version_target: 1.0.0
status: implemented -- gated green (143 node:tests incl. 40 Sieve boundary cases; hit = 0 link writes / 1 vis byte at head+interior+tail vs LRU 0/5/4; sieveIntPolicy differential clean 100k ops; A3 int strict-zero, no backing grows; A4 4096 clear-cycles conserve; C7 promote-on-hit teeth diverge; torture + controls ok). Still gated behind S9 docs for /release 1.0.0. VERSION stays 0.1.0 until /release.
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
decisions: [D12]
depends_on: [S3, S2, S9]
blocks: []
```
PURPOSE
  The headline that makes v1.0.0 mean something: SIEVE (2023/2024) -- a single
  FIFO-ish queue + one visited bit + a moving hand. On a hit it sets the bit and
  does NOTHING else (no promotion, no relink). It matches or beats LRU on real web
  traces while writing ONE bit per hit where LRU rewrites ~6 links. Proves the
  substrate carries a second policy and the oracle is parameterizable.
THE ALGORITHM (short)
  Entries sit in insertion order. A "hand" points into the ring. On insert at
  capacity, the hand sweeps: a visited entry is given a second chance (bit
  cleared, hand advances); the first unvisited entry is evicted and the newcomer
  takes its place. get() sets visited=1; that is the entire hot path.
THE DECISION (record in decisions/0012-sieve.md BEFORE coding)
  How the visited bit and hand live on the substrate: a `Uint8Array` visited
  column (simplest, 1 byte/slot) vs a bit-packed `Uint32Array` (8x denser, a
  mask/shift per access). Recommendation: `Uint8Array` first (monomorphic, the
  byte is in a hot body); measure, and only bit-pack if T6 shows the density
  matters. Record the choice and the measured writes-per-hit vs classic LRU.
  If bit-packing is adopted it is INLINED into Lru.js (mask/shift) -- NOT a
  dependency on `@zakkster/lite-fastbit32` or any package, which would break the
  suite's zero-runtime-deps law (DEBATE item 15).
TASKS
  - `Sieve` as a named export composing the substrate; the uniform `LiteCache`
    surface (law 6); `onEvict`.
  - `test/Sieve.test.js`: the SIEVE policy laws (T0) -- visited survives exactly
    one sweep; a one-hit key is evicted before a re-hit key; the hand wraps.
  - `test/torture/oracles/sieve.mjs`: brute hand + visited bits; wire it into the
    parameterized runner so T5 fuzzes SIEVE against it.
  - T2 scan flood: a distinct-key burst does not evict the proven-hot set.
  - `README`/`llms.txt`: the SIEVE section + the "fewer writes per hit" pitch with
    the measured number (NOT "lock-free" -- DEBATE item 2).
ASSERTIONS
  - SIEVE vs its brute oracle: identical values + identical eviction victims over
    the 100k-op T5 corpus.
  - writes-per-hit(SIEVE) < writes-per-hit(LiteLru), measured and asserted.
  - Strict-zero T6 on the substrate; no backing store grows.
  - Scan-flood assertion passes (scan resistance is executable, not claimed).
  - torture "ok"; T9 control (a SIEVE that promotes on hit, i.e. accidental LRU)
    diverges from the oracle and fails.
NON-GOALS
  No S3-FIFO / W-TinyLFU yet. No bit-packing unless T6 demands it. No hit-ratio
  claim without an in-repo trace (law 8).
DONE WHEN
  SIEVE passes its oracle + zero-alloc + scan-flood gates; writes-per-hit proven
  below LRU; v1.0.0 ships a floor + a differentiated headline; metadata/URLs point
  at lite-lru (verify homepage/repository/bugs -- the blueprint caught cross-wired
  lite-scheduler URLs across the ecosystem)

===============================================================================
# S5 -- v1.1.0 -- S3-FIFO
===============================================================================
```markdown
version_target: 1.1.0
status: built + gated (VERSION stays 1.0.0 until /release 1.1.0)
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
decisions: [D13]
depends_on: [S3, S4]
```
PURPOSE
  General-purpose + scan resistance with excellent hit ratio and low metadata:
  three FIFO queues -- a small (~10%) probation queue, a main queue, and a small
  GHOST queue of recently-evicted keys. A newcomer enters small; only an entry
  that proves itself (a hit while in small, or a ghost hit) graduates to main. A
  hit usually moves NOTHING (a bit is flipped, promotion happens at eviction) --
  ~0 writes per hit, the strongest zero-GC posture in the family.
THE DECISION (decisions/0013-s3fifo.md)
  Ghost queue sizing and representation (keys only, no values -- a small
  typed-array ring of hashes) so it stays bounded (law 3). Record the small/main
  split and the ghost capacity; both are fixed at construction.
TASKS
  - `S3Fifo` on the substrate (three intrusive queues threaded through the slot
    columns + a bounded ghost ring); uniform surface; onEvict.
  - `oracles/s3fifo.mjs` (brute three-queue + ghost) into the runner; extend
    `validate()`/conservation with the ghost-bound term.
  - T2 scan flood + a "prove-then-graduate" law in T0.
ASSERTIONS
  - vs oracle over T5: identical values + victims incl. ghost-driven promotions.
  - ghost.size <= ghostCapacity always (conservation extended).
  - ~0 writes per hit measured; strict-zero T6.
  - torture "ok"; control (graduation on first touch instead of at eviction) fails.
DONE WHEN
  S3-FIFO oracle-identical; ghost bounded and conserved; zero-alloc proven

===============================================================================
# S6 -- v1.2.0 -- W-TinyLFU (the best-fit member)
===============================================================================
```markdown
version_target: 1.2.0
status: built + gated (VERSION stays 1.1.0 until /release 1.2.0)
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
decisions: [D14]
depends_on: [S3, S4, S5]
```
WHAT LANDED (S6, working tree, uncommitted; VERSION still 1.1.0 until /release):
  - `WTinyLfu` on the substrate: window-LRU + SLRU(probation/protected) threaded
    through `_next`/`_prev` tagged per slot by a `_seg` Uint8; a fixed 4-row 4-bit
    Count-Min sketch (`_sk`, 8 counters/Uint32, width pow2>=cap, aged by halving
    every 10*cap bumps); admission candidate=window tail vs victim=probation tail,
    admit iff freq(cand)>freq(victim), ties reject. Uniform LiteCache surface,
    onEvict fire-after + reentrancy guard, keys:'int' strict path. D14.1 object-key
    hashing = resident slot index (no WeakMap, tracked while resident).
  - decisions/0014-wtinylfu.md (D14.1..D14.5); Lru.d.ts WTinyLfu<K,V> + dts-drift;
    test/torture/oracles/wtinylfu.mjs (independent brute); harness/validate + tiers
    t0/t2/t5/t6/t7/t9 (t9 control = admit-always, diverges + fails); README/llms.txt
    member sections.
  - BENCH ROSTER FIX (in-scope correction): benchmark/Bench.mjs shipped only
    LiteLru+Sieve since S5 -- S3Fifo AND WTinyLfu were missing from the shipped
    measurement tool. Added both to the MEMBERS roster + import (and updated the
    Bench.test.js member-count/name assertion 2->4). The shipped tool now measures
    the whole family.
  - Gates: npm test 312/312 (incl. test/WTinyLfu.test.js boundary suite + the
    4-member bench contract); test:types (tsc) clean; torture "ok"/exit 0; controls
    "ok"/exit 0. Reviewer APPROVED (hot-path zero-alloc incl. sketch inc/aging +
    object-key path; retention; fail-closed doors; degenerate caps 1/2/3 all
    verified). Measured (bench, cap 256, ops 200000, seed 0x9e3779b9): zipf hit%
    WTinyLfu 65.7 (88.3% OPT) vs LiteLru 57.4 (77.2%); loop WTinyLfu 23.5 (94.4%
    OPT) where LRU/Sieve/S3Fifo all 0.0; scan WTinyLfu 49.9 (99.9% OPT).
    Writes-per-hit (CountedWTinyLfu): window-MRU 0 / probation->protected interior 9
    / probation tail 8 -- higher than Sieve/S3Fifo by design (segment relink + a
    4-counter sketch bump), still zero allocation.
PURPOSE
  Highly skewed / Zipf popularity + admission control (the Caffeine approach): a
  small window (LRU/FIFO) absorbs bursts, a main SLRU holds the hot set, and a
  fixed Count-Min sketch gives cheap frequency estimates for admission. The
  sketch is a PREALLOCATED typed array -- literally "bytes in a hot body" -- which
  makes W-TinyLFU the most on-law member of the family (DEBATE item 5), ranked
  above ARC for this suite.
THE DECISION (decisions/0014-wtinylfu.md)
  Sketch shape: 4-row Count-Min over a `Uint8Array` (or `Uint16Array`) with a
  reset/halving policy at a fixed increment budget (the "aging" step, done in
  bulk, off the hot path). Record counter width, row count, and the reset budget;
  all fixed at construction -- a growing sketch is rejected (law 3). Record the
  window:main split (default ~1%:99%, SLRU inside main).
TASKS
  - `WTinyLfu` on the substrate: window LRU + SLRU main + the fixed CM sketch;
    admission = compare newcomer's estimated frequency to the SLRU victim's.
  - `oracles/wtinylfu.mjs` (brute sketch + SLRU admission) into the runner.
  - The sketch reset/halving as a bulk, off-hot-path op; proven zero-alloc.
ASSERTIONS
  - vs oracle over T5: identical admission decisions + victims.
  - sketch buffer byteLength never changes; reset halves counters deterministically.
  - Zipfian corpus: measured hit ratio >= classic LRU on the SAME in-repo trace
    (law 8 -- trace + provenance stamp shipped with the number).
  - strict-zero T6 incl. the increment + the bulk reset.
  - torture "ok"; control (admit-always, i.e. no frequency gate) diverges + fails.
DONE WHEN
  W-TinyLFU oracle-identical; sketch fixed + zero-alloc; a real Zipf trace shows
  the win with provenance; the headline trio (SIEVE/S3-FIFO/W-TinyLFU) is complete

===============================================================================
# S7 -- v1.3.0 -- 2Q / SLRU (the simplest scan-resistant baseline)
===============================================================================
```markdown
version_target: 1.3.0
status: planned
depends_on: [S3, S4]
```
PURPOSE
  The classic, well-understood scan/one-hit filter that sits between LRU and the
  modern trio: a probationary segment (FIFO or short LRU) for newcomers, a
  protected LRU segment for entries that earn a second hit. Cheap, obvious, and a
  good honest baseline for the benchmark story ("here is the textbook
  scan-resistant one; here is what SIEVE/S3-FIFO buy over it").
THE DECISION (decisions/0015-2q-slru.md)
  Whether to ship ONE member with a mode flag or two thin named exports (`TwoQ`,
  `Slru`). Lean: two tiny named exports over a shared body -- keeps each hot path
  monomorphic and the tree-shake clean (law 7). Record the probation:protected
  split.
TASKS / ASSERTIONS / DONE WHEN
  Member(s) on the substrate; oracle(s) into the runner; the promote-on-second-hit
  law pinned; scan flood; strict-zero T6; oracle-identical over T5; controls fail.

===============================================================================
# S8 -- v1.4.0 -- ARC (flagged: stresses the fixed-capacity law)
===============================================================================
```markdown
version_target: 1.4.0
status: planned
depends_on: [S3, S5]
```
PURPOSE
  The gold-standard adaptive baseline (patent expired): two lists (recent /
  frequent) + two GHOST lists driving a self-tuning parameter `p`. No knobs -- it
  adapts between recency- and frequency-friendly phases on its own. Worth shipping
  as the "no-tuning adaptive" member, but it is the one that STRESSES the laws.
THE DECISION (decisions/0016-arc.md -- own the tension up front)
  The ghost lists roughly DOUBLE the key-index metadata, and `p` moves the
  effective recency/frequency split at runtime -- in tension with law 3 (fixed,
  load-bearing capacity). Record: ghost lists are bounded typed-array rings
  (fixed), `p` is a single integer that never allocates, and "effective capacity"
  for VALUES stays exactly `capacity` -- only the recency/frequency SPLIT adapts,
  not the total. State this so the fixed-capacity law is honored in letter and the
  adaptivity is honest about what it moves.
TASKS / ASSERTIONS / DONE WHEN
  ARC on the substrate; brute oracle (two lists + two ghosts + `p`) into the
  runner; `p` adaptation pinned by a phase-change law (recency phase then
  frequency phase, assert `p` moves the right way); ghost-bound conservation;
  strict-zero T6; oracle-identical over T5; control (`p` frozen) fails the
  phase-change law.

===============================================================================
# S9 -- v0.x.. -- README + llms.txt + CHANGELOG + shipped bench tool (parallel from S2)
===============================================================================
```markdown
status: implemented -- gated green (160 node:tests incl. +17 Bench boundary cases; README on the LiteSepforge spine, both members, every cited number traced to a harness const/Lru.js door; Bench.mjs shipped as runnable + importable (runBench/beladyOpt), imports only ./Lru.js; t8 OPT gate: beladyOpt differential-tested vs independent brute farthest-next-use OPT + OPT>=each member, teeth proven; bench hit%/%OPT/wr deterministic across runs, ns/op machine-local; pack = 8 files incl README.md/llms.txt/CHANGELOG.md/Bench.mjs). VERSION stays 0.1.0 until /release. This clears the last /release 1.0.0 blocker (the three files[] docs now exist).
depends_on: [S1]
```
README modeled on `../LiteSepforge/README.md` (the suite blueprint spine, in
order). The positioning H2 is the family AND the measurement tool: lead with "stop
guessing your eviction policy -- measure it on your trace" (DEBATE item 10), then a
workload-map table (which member for which trace), the uniform one-line-swap API,
the tree-shake-to-one-tiny-policy size story, and the honest "fewer-writes-per-hit,
NOT lock-free" framing (item 2). An explicit "vs lru-cache / quick-lru" section:
what we deliberately do NOT do (TTL parity race, async fetch, size-aware) and why,
with landing spots. llms.txt mirrors it. CHANGELOG from S0.

SHIP THE HARNESS AS A TOOL (item 10, the killer feature): promote the S1
parameterized oracle/replay harness to a documented, user-facing entry -- feed it a
trace, get per-policy hit-ratio + writes-per-hit + alloc, oracle-checked. This is
the thing neither incumbent offers; it is part of the v1.0.0 story. Keep it out of
the runtime `files[]` hot path if it pulls dev peers; expose it as a documented
script / small entry per the suite's bench precedent (lite-binary-reader).

BELADY OPT as the absolute reference (DEBATE item 13, RESEARCH.md sec 2): the bench
tool reports each policy's hit-ratio AND the clairvoyant offline optimum (evict the
entry whose next use is farthest), so a caller sees "% of optimal" and "extra misses
vs OPT", not a bare percentage. OPT lives STRICTLY in the offline harness, NEVER a
production policy. Impl: reverse-scan next-use + lazy-deletion max-heap with
amortized rebuild (RESEARCH.md carries a working version). GATE (non-negotiable):
differential-test the OPT impl against a brute-force O(N*C) OPT on small seeded
traces -- every "% of optimal" claim depends on it being exactly right (item 9).

ASCII-only; grep new files for stray tool-call tags. Add README + llms.txt to
`files[]` (and Lru.d.ts from S2). Grows one section per member as S4-S8 land, and
one per feature as S10-S12 land; the release gate for each minor updates it.

===============================================================================
# S10 -- v1.3.0 -- zero-GC TTL (opt-in expiry column) [cross-cutting]
===============================================================================
```markdown
version_target: 1.3.0
status: built + gated (VERSION stays 1.2.0 until /release 1.3.0)
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
depends_on: [S3]
decisions: [D17]
```
WHAT LANDED (S10, working tree, uncommitted; VERSION still 1.2.0 until /release 1.3.0):
  - Opt-in TTL across ALL FOUR members on the shared substrate: an optional `_exp`
    Float64Array (ms expiry), allocated ONLY when `ttl` is configured (null off ->
    zero extra bytes). expiresAt = clock()+ttlMs; never-expire = Infinity, NEVER 0
    ("null is not zero" -- a 0 stamp reads as expired). Injectable `clock` option
    (default Date.now()), validated fail-closed. Lazy check on get/peek/has BEFORE
    each member's hit policy: a stale touch is a MISS (no promote/visited/sketch
    bump), evicts in place firing onEvict. Untouched-stale counts toward size until
    touched or purgeStale()'d; capacity eviction ignores staleness. Positional
    `put(key,value,ttlMs?)` per-entry override; `purgeStale(): number` cold reclaim.
    Fail-closed: ttl/ttlMs <=0|NaN|non-number throw, non-function clock throws, ttlMs
    on a non-ttl instance throws [lite-lru].
  - THE off-path decision RESOLVED BY MEASUREMENT: option (a) a single monomorphic
    `this._exp === null` guard per hot method -- KEPT (no constructor-time method
    specialization needed). ttl-OFF writes-per-hit UNCHANGED (LiteLru 0/5/4, Sieve
    0/1, S3Fifo 0/1, WTinyLfu window-MRU 0); ttl-ON strict zero-alloc (gc major 0 /
    maxMs 0.00 / 0.00032 B/op), `_exp.byteLength` stable over 100k churn.
  - decisions/0017-ttl.md (D17.1..D17.5, incl. the fail-closed purgeStale-under-
    reentrancy contract); Lru.d.ts (`ttl?`/`clock?`, put arity, purgeStale on
    LiteCache + all four); oracles x4 extended with per-key expiry + a virtual clock
    (lazy rule mirrored exactly); harness runDifferential drives the clock; validate
    `_exp` conservation term; tiers t0/t1/t2/t5/t6/t7/t9 (t9 controls: skip-gate /
    stale-promotes / growing-_exp, each fails); README + llms.txt TTL sections.
  - RULING (owner): the qa-found purgeStale-under-onEvict-reentrancy "abort early"
    is INTENDED fail-closed behavior (0002), not a defect -- continuing past a
    contract violation would be fail-OPEN; the cache stays structurally consistent
    and un-reaped stales are reaped lazily. Recorded in D17.5, regression-pinned in
    test/Ttl.test.js section H. (The over-specified "completes all victims" line in
    the session brief was the thing that was wrong.)
  - Gates: npm test 429/429 (+117 TTL boundary cases in test/Ttl.test.js, four
    members parameterized); test:types (tsc) clean; torture "ok"/exit 0; controls
    "ok"/exit 0. Reviewer APPROVED (zero-alloc ttl on+off all four, retention on
    reap, fail-closed validation, the !_inOnEvict has/peek gate leaks nothing, lazy
    oracle mirror by logic, WTinyLfu two-branch stamp).
PURPOSE
  The one table-stakes feature vs the incumbents (DEBATE item 11). An opt-in
  per-instance `ttl` adds a `Float64Array` (or Uint32 ms) EXPIRY column to the SoA
  slot layout, allocated ONLY when ttl is used (pay-for-what-you-use, tree-shakeable
  -- a cache without ttl carries zero extra bytes and zero extra branches proven by
  T6). Expiry is checked LAZILY on get/peek/has (expired -> treated as a miss and
  evicted in place); no timers, no background sweep on the hot path. Optional
  `purgeStale()` is a cold bulk op.
THE DECISION (decisions/0017-ttl.md)
  Column width + clock source (ms epoch vs monotonic), lazy-only vs optional sweep,
  and whether ttl is per-instance only or also per-entry. Recommend: Float64 ms
  expiry, lazy-only on the hot path, per-instance default with optional per-put
  override. Record how a stale hit interacts with each member's policy (a stale get
  is a miss for recency/admission purposes).
ASSERTIONS
  ttl-off path byte-identical to pre-S10 (T6 zero-alloc, no new hot branch when
  unused); a stale entry reads as a miss and frees its slot; strict-zero T6 with ttl
  on; oracle extended with a virtual clock; control (a ttl that never expires) fails.

===============================================================================
# S11 -- v1.4.0 -- zero-GC iteration (keys / entries / values) [cross-cutting]
===============================================================================
```markdown
version_target: 1.4.0
status: built + gated (VERSION stays 1.3.0 until /release 1.4.0)
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
depends_on: [S3]
decisions: [D18]
```
WHAT LANDED (S11, working tree, uncommitted; VERSION still 1.3.0 until /release 1.4.0):
  - keys()/values()/entries()/[Symbol.iterator] on ALL FOUR members over the shared
    substrate, at ZERO allocation per step (measured 0.00000 B/op per next(), all four,
    >=10k steps prefilled at capacity 4096). ONE shared hand-written CacheIterator (NO
    generator -- a generator allocates an IteratorResult per yield); a reused
    {value,done} result + a borrowed [k,v] tuple, both mutated in place; the iterator
    OBJECT is allocated once per call (cold), never per step.
  - PER-MEMBER ITERATION ORDER (D18.1), defined + pinned -- NOT a universal "recency
    order" (only LiteLru is true recency): LiteLru _head.._tail (MRU..LRU); Sieve
    _head.._tail (FIFO newest->oldest); S3Fifo main (_mHead.._mTail) THEN small
    (_sHead.._sTail), the keys-only ghost EXCLUDED; WTinyLfu window THEN protected THEN
    probation (_wHead/_ptHead/_prHead .._..Tail), each MRU..LRU. A small per-member
    _iterHeads() roster the shared iterator walks (mirrors validate()'s list roster).
  - [Symbol.iterator] === entries() (matches Map); Iterable<[K,V]>. Recency-neutral
    (D18.4): a walk applies no promote / visited bump / sketch bump / segment relink.
  - TTL (D18.5, S10 interop): a walk SKIPS stale entries (invisible) but does NOT reap
    them -- no structural mutation mid-walk; size unchanged by iterating; purgeStale()
    stays the reclaim path.
  - FAIL-CLOSED mutation (D18.6): a single integer SlotStore._ver, bumped ONLY by
    put/delete/clear/_reap/_evict (NEVER on the get/has/peek hit path). The iterator
    captures _ver at construction; next() throws a [lite-lru] Error on a mid-walk
    structural mutation. The get writes-per-hit baselines are UNCHANGED (LiteLru 0/5/4,
    Sieve/S3Fifo 0 links + 1 vis, WTinyLfu window-MRU 0). A get()-induced access-order
    reorder mid-walk is documented-unsupported (not caught -- catching it would cost a
    hot-GET write).
  - RETENTION HARDENING (reviewer-found, owner-applied): the terminal next() (done)
    nulls the reused result value AND the borrowed tuple's slots, so a drained-but-
    retained iterator pins nothing ("null is not zero"). Consequence, documented: a bare
    [...cache.entries()] / Array.from(cache) with no map fn reads all-[undefined,
    undefined] (N refs to the one nulled tuple) -- it fails LOUDLY, on-law. Only a
    copying map materializes: Array.from(cache.entries(), ([k,v])=>[k,v]). keys()/values()
    yield scalars, so their spreads materialize correctly.
  - RULING (owner): the qa-found "Array.from(cache) materializes" claim in the original
    brief was WRONG -- borrowed-tuple + default iterator aliases, and after the retention
    nulling reads all-undefined. The zero-alloc borrowed-tuple design + the retention
    hardening both STAND (they are the fail-closed / zero-retention choice); the DOCS
    were corrected (README/llms.txt/Lru.d.ts/0018) and the MEASURED behaviour is pinned
    as regression tests. This is the honest cost of zero-alloc iteration (lru-cache's
    iterators allocate and so avoid the trap; ours do not allocate and so carry it).
  - decisions/0018-iteration.md (D18.1..D18.6); Lru.d.ts (LiteCache extends
    Iterable<[K,V]> + 4 signatures on the interface and all four classes, borrowed-tuple
    caveat); test/dts-drift.test.js counted surface 9 -> 12 ([Symbol.iterator] and
    _iterHeads stay invisible to classMembers); test/torture t0 iterationOrder laws +
    t6 Gate ITER + 3 t9 controls (generator-allocs / promotes-on-walk / reaps-mid-walk,
    each fails); test/Iteration.test.js (+119 node:test cases, four members
    parameterized); README + llms.txt Iteration sections. NO Bench.mjs change (iteration
    is not a bench member).
  - Gates: npm test 548/548 (429 + 119); test:types (tsc) exit 0; torture "ok"/exit 0
    (t6 Gate ITER 0.00000 B/op all four); controls "ok"/exit 0. Reviewer APPROVED
    (roster correctness incl. degenerate caps 1/2/3 + empty; _ver fail-open complete
    across every eviction path; TTL skip-no-reap; the iterStep control is honest, not
    decorative). ASCII-only clean.
PURPOSE
  Iterate the cache with ZERO per-step allocation, reusing the hand-written-iterator +
  borrowed-tuple pattern from lite-binary-reader S12 (a generator allocates an
  IteratorResult per yield -- the trap). lru-cache's iterators allocate; ours do not.
  `keys()`, `values()`, `entries()`, and `[Symbol.iterator]`; the yielded entry pair is
  BORROWED and reused -- copy what you keep (only a copying Array.from map materializes;
  a bare entries spread reads all-undefined). Order is DEFINED PER MEMBER (D18.1), not a
  single global recency order -- only LiteLru is true MRU..LRU.
ASSERTIONS
  0 B/op per step (torture gate, retaining-generator control for teeth); each member's
  documented order correct vs an independent roster oracle; iteration does NOT change
  recency (a read-only walk); TTL stale-skip-without-reap; fail-closed on mutation;
  break-early safe; borrowed-tuple aliasing + retention-nulling pinned.

===============================================================================
# S12 -- v1.5.0 -- opt-in stats (hit / miss / evict / puts) [cross-cutting]
===============================================================================
```markdown
version_target: 1.5.0          # renumbered from the placeholder "v1.x" (S10 took
                               # 1.3.0, S11 took 1.4.0). S7 (2Q/SLRU, target still
                               # 1.3.0) and S8 (ARC, target still 1.4.0) remain STALE
                               # + unbuilt -- renumber when one is actually planned.
status: built + gated (VERSION stays 1.4.0 until /release 1.5.0)
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
depends_on: [S1, S3]
decisions: [D19]
```
WHAT LANDED (S12, working tree, uncommitted; VERSION still 1.4.0 until /release 1.5.0):
  - Opt-in `stats:true` across ALL FOUR members on the shared substrate: a per-instance
    plain-object holder `{hits,misses,evictions,puts}` (plain JS numbers, exact to 2^53 --
    NOT an Int32Array, which would wrap at 2^31), allocated ONLY when stats is on (`_stats`
    null off -> zero extra bytes). Every hit/miss/put/eviction increment sits behind ONE
    monomorphic `this._stats===null` guard in each get/put/_reap (mirrors the D17 TTL
    off-path). stats-OFF is byte-neutral: writes-per-hit UNCHANGED (LiteLru 0/5/4,
    Sieve/S3Fifo 0 links + 1 vis, WTinyLfu window-MRU 0), and `new X(n)._stats===null`.
  - THE COUNTING LAW (D19.2), OUTCOME-based and uniform: get() drives hits/misses (after
    the lookup resolves); has()/peek() are hit/miss-NEUTRAL; put() at capacity drives
    exactly one eviction, counted at the single real-victim site (S3Fifo graduation and
    WTinyLfu window->probation demotion do NOT count; admission-reject counts the CANDIDATE
    as victim); a stale-TTL get() is a MISS + an EVICTION (the _reap site), no double-count
    with a later put-site eviction; a stale has()/peek() reap ticks evictions++ but stays
    hit/miss-neutral. writesPerHit is DELIBERATELY EXCLUDED from the runtime holder -- it
    stays a member-specific torture-measured property (the counted-subclass harness).
  - OWNER RULING (outcome-based puts): the reviewer flagged (non-blocking) that puts++ ran
    BEFORE the store mutation, so a put() that throws (invalid/out-of-range int key under
    keys:'int', or ttlMs on a non-ttl instance) still ticked puts. Ruled to FIX rather than
    accept: puts is now counted at the success sites (after the store mutation lands), making
    all four counters uniformly outcome-based -- honest for a "measure your policy" tool.
    `_store._ver++` (D18.6) deliberately STAYS before the throw (fail-closed iteration
    invalidation guards any attempt; puts records a completed operation). A throwing put
    now counts nothing; a valid insert AND a valid update each count one.
  - stats() returns the holder BY REFERENCE (borrowed; copy what you keep -- like the S11
    iteration tuple, but the holder has no back-reference to the instance, so retaining it
    pins only 4 numbers, not the cache). resetStats() zeroes IN PLACE (same holder
    identity). FAIL-CLOSED (D19.5): stats()/resetStats() on a non-stats instance throw
    [lite-lru]; the stats door rejects a bad value ('yes'/1/0/{}/null/false) with a
    [lite-lru] TypeError + did-you-mean hint (mirrors the `keys` door).
  - decisions/0019-stats.md (D19.1..D19.5); Lru.d.ts (CacheStats type + stats()/resetStats()
    on the LiteCache interface AND all four classes + `stats?: true`, borrowed-holder
    caveat); test/dts-drift.test.js counted surface 12 -> 14; test/Stats.test.js (NEW,
    four members parameterized: brute-tally parity over the T5 corpus, has/peek-neutral,
    stale miss+evict, outcome-based puts, degenerate caps 1/2/3, S10 TTL + S11 iteration
    interop, onEvict-during-put, re-entrant resetStats-in-onEvict, fail-closed doors);
    test/torture t6 Gate STATS + two t9 controls (stats-double-count, stats-counts-peek,
    each fails); README + llms.txt Stats sections. NO Bench.mjs change (stats is not a
    bench member). NO VERSION/test-count doc edits (those move at /release).
  - Gates: npm test 612/612; test:types (tsc) exit 0; torture "ok"/exit 0 (t6 Gate STATS
    0.00032 B/op, within the <=1 B/op budget, holder identity + 4-key shape stable);
    controls "ok"/exit 0. Reviewer APPROVED (hot-path zero-alloc ON + byte-neutral OFF;
    eviction counted exactly once per real victim across all four distinct paths incl.
    degenerate caps; borrowed holder pins nothing; fail-closed doors; honest control
    teeth; S10/S11 interop clean). qa: no defects; all five planner assertions PASS, the
    owner change CONFIRMED-CLEAN by code read, the two D19.2 edge cases pinned with teeth.
PURPOSE
  Opt-in integer counters (hits, misses, evictions, puts) exposed via a COLD stats()
  accessor. Off by default; when on, pure integer increments -- zero allocation, no
  hot-path branch when off. Feeds the "measure your policy" identity (DEBATE items 10/11);
  no incumbent gives hit-ratio out of the box. stats() returns a reused holder by reference
  (cold accessor only, no per-call object churn).
ASSERTIONS
  stats-off byte-identical to pre-S12 (T6); counters exact vs an independent brute tally
  over the T5 corpus (all four members); strict-zero T6 with stats on (holder byteLength/
  identity stable); fail-closed stats() on a non-stats instance; controls (double-count,
  counts-peek) diverge from the tally and fail.

---

## 7. Decision-record index (decisions/)

| ID | Decision | Session |
| --- | --- | --- |
| D1-D10 | classic structure (Map+DLL, slots, links, free stack, evict-in-place, miss policy, onEvict, fail-closed capacity, test-only introspection) | 0001 (S0) |
| D8+ | onEvict reentrancy contract: fire-after ordering + fail-closed guard (amends D8; found by S1 qa) | 0002 (S1) |
| D11 | shared keyed-index substrate (open-addressed typed-array index + Map fallback) | 0011 (S3) |
| D12 | SIEVE (visited bit + hand; Uint8Array vs bit-pack) | 0012 (S4) |
| D13 | S3-FIFO (three queues + bounded ghost ring) | 0013 (S5) |
| D14 | W-TinyLFU (fixed CM sketch + SLRU admission + bulk reset) | 0014 (S6) |
| D15 | 2Q / SLRU (probation/protected split; one member or two) | 0015 (S7) |
| D16 | ARC (ghost metadata + adaptive `p`; fixed-capacity honesty) | 0016 (S8) |
| D17 | zero-GC TTL (opt-in expiry column; lazy check) | 0017 (S10) |
| D18 | zero-GC iteration (borrowed-tuple hand-written iterator) | 0018 (S11) |
| D19 | opt-in stats (integer counters; off by default) | 0019 (S12) |
| D20 | Belady OPT reference in the bench tool (offline only; brute-force correctness gate) | 0020 (S9) |
| (law) | bit-packing (if any) INLINED, never a `lite-fastbit32`/package runtime dep (item 15) | 0012 (S4) |

Deferred / out-of-core (get a decision record only if `DEBATE.md` promotes them):
LRU-K, LIRS/ClockPro, LFU, MQ/CAR (deferred members, item 4); CLOCK/ClockPro (out
of family -> on-demand standalone, item 6); async fetch (-> `lite-lru-fetch`, item
11); size/cost-aware (-> `lite-cache-budget`, item 8); SharedArrayBuffer/cross-
worker (future separate package, item 11); snapshot/restore (later, item 11).
FIFO-reinsertion / lazy-promotion is a PRINCIPLE embodied by SIEVE/S3-FIFO, not a
member (item 12). V2 EXPERIMENTAL research (item 14, RESEARCH.md): LiteMGLRU
(userspace Multi-Gen LRU) and the self-measuring meta-policy.
