# lite-lru Research Notes

**Status**: Living research document  
**Scope**: Design decisions, theoretical anchors, and experimental directions for a tree-shakeable, zero-GC,
multi-policy cache family in JavaScript/TypeScript.

---

## 1. Core Identity

- Fixed capacity (entry count, not bytes)
- Zero garbage collection on the steady-state hot path
- Structure-of-Arrays (SoA) + `Map` substrate for O(1) lookup and excellent locality
- Tree-shakeable individual policies
- "Measure & Trust" as the primary product differentiator

The library intentionally avoids competing with `lru-cache` on feature breadth or with `quick-lru` on minimalism. It
wins on a different axis: a curated family of modern policies, strict performance discipline, and an authoritative
measurement harness.

---

## 2. The Analytical Anchor: Belady's OPT

### Why it belongs in the project

If the library ships a benchmark harness as a core feature, it needs an absolute reference point. Belady's Optimal
Algorithm (OPT / MIN) is the mathematically perfect offline eviction policy: it always evicts the item whose next use
lies furthest in the future.

**Where it lives**: Strictly inside the offline harness (`lite-lru-benchmark`). It must never appear in any production
policy.

**Why it is a killer feature**:

- "SIEVE achieved 82 %" is ambiguous.
- "SIEVE achieved 82 % while OPT achieved 84 % -> 97.6 % of optimal" is immediately actionable.
- Neither `lru-cache` nor `quick-lru` (nor most other JavaScript caches) can tell a user how close to theoretical
  perfection they are.

### Implementation notes

- Next-use precomputation via a reverse scan of the trace.
- Forward simulation with a lazy-deletion max-heap (bounded growth + periodic rebuild) keeps the implementation
  practical for multi-million-entry traces.
- Always report:
    - Hit rate of each online policy
    - Hit rate of OPT
    - Percentage of optimal
    - Absolute extra misses versus OPT

```js
/**
 * Calculates the mathematically optimal hit rate for a given trace (Belady's OPT).
 * Uses a zero-GC Lazy-Deletion Max-Heap with Amortized Rebuilding to prevent pollution.
 *
 * WARNING: This is an offline Oracle (clairvoyant) algorithm. It requires peering
 * into the future of the trace array. It cannot and must not be used as a production
 * cache policy. It exists strictly for benchmark normalization.
 *
 * @param {Uint32Array|Array<string|number>} trace - The sequence of accessed keys.
 * @param {number} capacity - The cache size limit.
 * @returns {{ hits: number, misses: number, hitRate: number }}
 */
function simulateBeladyOpt(trace, capacity) {
    const n = trace.length;
    if (n === 0) return {hits: 0, misses: 0, hitRate: 0};
    if (capacity <= 0) return {hits: 0, misses: n, hitRate: 0};

    // 1. Next-use precomputation (O(N) reverse pass)
    const nextUse = new Int32Array(n);
    const last = new Map();

    for (let i = n - 1; i >= 0; i--) {
        const key = trace[i];
        nextUse[i] = last.has(key) ? last.get(key) : n;
        last.set(key, i);
    }

    // 2. Memory-Bounded Heap Setup
    // Cap heap growth to 4x capacity. Minimum cap of 1024 prevents aggressive
    // rebuilding on very small cache sizes.
    const maxHeapCap = Math.max(capacity * 4, 1024);

    // Fast path: pure typed-array backing if trace is already Uint32Array.
    const heapKeys = trace instanceof Uint32Array
        ? new Uint32Array(maxHeapCap)
        : new Array(maxHeapCap);
    const heapNextUse = new Int32Array(maxHeapCap);
    let heapSize = 0;

    let poppedKey = 0;
    let poppedNu = 0;

    function heapPush(key, nu) {
        let idx = heapSize++;
        while (idx > 0) {
            const parentIdx = (idx - 1) >>> 1;
            const parentNu = heapNextUse[parentIdx];
            if (parentNu >= nu) break;

            heapKeys[idx] = heapKeys[parentIdx];
            heapNextUse[idx] = parentNu;
            idx = parentIdx;
        }
        heapKeys[idx] = key;
        heapNextUse[idx] = nu;
    }

    function heapPop() {
        poppedKey = heapKeys[0];
        poppedNu = heapNextUse[0];

        const lastKey = heapKeys[--heapSize];
        const lastNu = heapNextUse[heapSize];

        if (heapSize > 0) {
            let idx = 0;
            while (true) {
                const left = (idx << 1) + 1;
                const right = left + 1;
                let largest = idx;
                let largestNu = lastNu;

                if (left < heapSize && heapNextUse[left] > largestNu) {
                    largest = left;
                    largestNu = heapNextUse[left];
                }
                if (right < heapSize && heapNextUse[right] > largestNu) {
                    largest = right;
                    largestNu = heapNextUse[right];
                }

                if (largest === idx) break;

                heapKeys[idx] = heapKeys[largest];
                heapNextUse[idx] = heapNextUse[largest];
                idx = largest;
            }
            heapKeys[idx] = lastKey;
            heapNextUse[idx] = lastNu;
        }
    }

    function rebuildHeap(resident) {
        heapSize = 0;
        for (const [k, nu] of resident.entries()) {
            heapPush(k, nu);
        }
    }

    // 3. Forward simulation (Amortized O(N log C))
    let hits = 0;
    let misses = 0;
    const resident = new Map();

    for (let i = 0; i < n; i++) {
        const key = trace[i];
        const nu = nextUse[i];

        if (resident.has(key)) {
            hits++;
            resident.set(key, nu);
            heapPush(key, nu);
        } else {
            misses++;
            if (resident.size === capacity) {
                while (heapSize > 0) {
                    heapPop();
                    if (resident.get(poppedKey) === poppedNu) {
                        resident.delete(poppedKey);
                        break;
                    }
                }
            }
            resident.set(key, nu);
            heapPush(key, nu);
        }

        if (heapSize >= maxHeapCap) {
            rebuildHeap(resident);
        }
    }

    return {hits, misses, hitRate: hits / n};
}
```

### Important observation: when LRU's bookkeeping is pure overhead (the measured-environment case)

LRU pays its cost UNCONDITIONALLY but collects its benefit CONDITIONALLY. Every `get` relinks ~5 cells (detach 2 +
push-front 3) -- paid on every hit. But that bookkeeping only pays off at an EVICTION, and only if recency actually
predicts reuse. So the cost lands at the head (always); the benefit lands at the tail (conditionally). When the benefit
-> 0, the cost does not -- it is net overhead. Two regimes, both common in a measured/provisioned deployment, drive the
benefit to zero:

1. The cache rarely/never evicts. If capacity >= working set (which a measured deployment sizes for deliberately),
   recency order is never consulted, so every move-to-front is 100% waste. A plain hash map or insertion-order/FIFO is
   optimal there.
2. The access pattern is known/predictable. Then a policy that does NO per-hit reordering matches LRU's hit-ratio at a
   fraction of the writes: SIEVE (1 bit), S3-FIFO (~0 writes/hit, promotion deferred to eviction). The limit case is a
   fully known trace, where Belady OPT is the answer with ZERO online bookkeeping -- the ultimate measured-environment
   policy (sec 2, and why the bench tool reports "% of optimal").

Two honest refinements: (a) LRU is not globally obsolete -- it stays right for genuinely UNPREDICTABLE, recency-skewed,
chronically-at-capacity workloads (the case it was designed for); a measured environment is, almost by definition, not
that case. (b) Classic LRU already has a built-in predictability discount: re-hitting the MRU early-returns at 0 writes
(the `_moveToFront` head check; our writes-per-hit pin is head:0 / interior:5), so it sheds the relink for a hot key that
stays hot -- it just cannot shed it for interior re-hits.

Consequence for this project: this is exactly why LRU is the reference/floor (not the headline), why flag- and
lazy-promotion policies (SIEVE, S3-FIFO, generational designs) are the members, and why the shipped bench tool + OPT
exist -- to let a caller DISCOVER their environment is predictable and that a lazy/flag policy (or no eviction at all)
wins, turning "head/tail is overhead" from folklore into a measured recommendation. It is also the precise niche for the
v2 self-measuring meta-policy: detect that recency is not paying and drop the relink overhead automatically.

---

## 3. v1.0.0 Policy Roster

| Policy          | Role                                      | Notes                                      |
|-----------------|-------------------------------------------|--------------------------------------------|
| Classic LRU     | Honest baseline                           | Not the headline                           |
| **SIEVE**       | Headline policy                           | Simplest modern high-performer, 1-bit flag |
| S3-FIFO         | Strong general / CDN performer            | Queue-based, excellent one-hit filtering   |
| W-TinyLFU       | Skewed / Zipfian workloads                | Frequency sketch + window                  |
| 2Q / SLRU       | Simple scan-resistant baseline            | --                                          |
| ARC             | Deferred                                  | Ghost lists stress the fixed-capacity model|
| LIRS, CLOCK-Pro, LRU-K, pure CLOCK | Out of v1 family               | --                                          |

**Design principle**: FIFO-reinsertion / lazy promotion is treated as a principle already embodied by SIEVE and S3-FIFO,
not as a separate roster member.

### Cross-cutting features (v1)

- Zero-GC TTL (opt-in column)
- Zero-GC iteration
- Opt-in statistics (hits, misses, evictions, writes-per-hit)
- `onEvict` / dispose callbacks

### Explicit non-goals (v1)

- Reactive integration inside the core
- Dynamic capacity growth
- Heavy adaptive / multi-constraint policies that increase branching
- Feature parity with `lru-cache`
- Async fetch wrappers (belong in a separate thin package if ever needed)

---

## 4. Supporting Primitive

`@zakkster/lite-fastbit32` is optional and fits cleanly only for flag-centric policies (SIEVE, and CLOCK if ever added).
It must remain a policy-local dependency so that other algorithms stay ultra-light and tree-shakeable.

---

## 5. Quarantined v2 Ideas

### Self-Measuring Meta-Policy

A zero-GC controller that tracks live efficacy of the active policy and can optionally auto-switch between simple
modes (e.g. recency-biased SIEVE <-> frequency-biased mode). This is the only adaptive idea still considered genuinely
differentiated. It directly strengthens the "Measure & Trust" moat.

### Adaptive Light Hybrid / Shadow-OPT

Interesting on paper but high risk of destroying the throughput advantage of the zero-GC substrate through extra
branching and metadata. Kept strictly as research.

---

## 6. Experimental Direction: LiteMGLRU

Linux Multi-Gen LRU (MGLRU, merged in kernel 6.1) is the current production page-reclaim policy on a large fraction of
the world's Linux systems. A clean, userspace, zero-GC, fixed-capacity approximation has clear attention potential.

### Design goals of LiteMGLRU

- Fixed capacity
- SoA layout
- 4 generations (0 = oldest, 3 = youngest)
- 1-byte metadata per slot (bit 0 = visited, bits 1-2 = generation)
- Hot path (`get`) only sets a bit -- no list movement
- O(1) amortized eviction via cascading tail evaluation

### Reference Implementation

```js
/**
 * LiteMGLRU -- Zero-GC Userspace Multi-Gen LRU
 *
 * Simplified generational policy inspired by Linux MGLRU.
 * Experimental / v2 track only.
 */
export class LiteMGLRU {
    constructor(capacity) {
        if (!Number.isInteger(capacity) || capacity <= 0) {
            throw new TypeError("capacity must be a positive integer");
        }

        this.capacity = capacity;
        this._size = 0;

        this._map = new Map();

        this._keys = new Array(capacity);
        this._vals = new Array(capacity);
        this._next = new Int32Array(capacity).fill(-1);
        this._prev = new Int32Array(capacity).fill(-1);

        this._genHead = new Int32Array([-1, -1, -1, -1]);
        this._genTail = new Int32Array([-1, -1, -1, -1]);

        this._meta = new Uint8Array(capacity); // bit 0 = visited, bits 1-2 = gen

        // Free list
        this._freeHead = 0;
        for (let i = 0; i < capacity - 1; i++) {
            this._next[i] = i + 1;
        }
        this._next[capacity - 1] = -1;
    }

    get size() {
        return this._size;
    }

    get(key) {
        const s = this._map.get(key);
        if (s === undefined) return undefined;
        this._meta[s] |= 0b1; // set visited only
        return this._vals[s];
    }

    has(key) {
        return this._map.has(key);
    }

    peek(key) {
        const s = this._map.get(key);
        return s === undefined ? undefined : this._vals[s];
    }

    set(key, value) {
        let s = this._map.get(key);

        if (s !== undefined) {
            this._vals[s] = value;
            this._meta[s] |= 0b1;
            return this;
        }

        if (this._size === this.capacity) {
            s = this._evict();
        } else {
            s = this._allocSlot();
            this._size++;
        }

        this._keys[s] = key;
        this._vals[s] = value;
        this._map.set(key, s);

        // Insert into youngest generation, not visited
        this._meta[s] = (3 << 1) | 0;
        this._linkToGen(s, 3);

        return this;
    }

    delete(key) {
        const s = this._map.get(key);
        if (s === undefined) return false;

        this._map.delete(key);
        const gen = (this._meta[s] >> 1) & 0b11;
        this._unlinkFromGen(s, gen);
        this._freeSlot(s);
        this._size--;
        return true;
    }

    clear() {
        this._map.clear();
        this._size = 0;
        this._genHead.fill(-1);
        this._genTail.fill(-1);
        this._meta.fill(0);

        this._freeHead = 0;
        for (let i = 0; i < this.capacity - 1; i++) {
            this._next[i] = i + 1;
        }
        this._next[this.capacity - 1] = -1;
    }

    // Iteration order: Gen 3 -> Gen 0 (approximate MRU -> LRU)
    * keys() {
        for (let gen = 3; gen >= 0; gen--) {
            let s = this._genHead[gen];
            while (s !== -1) {
                yield this._keys[s];
                s = this._next[s];
            }
        }
    }

    * values() {
        for (let gen = 3; gen >= 0; gen--) {
            let s = this._genHead[gen];
            while (s !== -1) {
                yield this._vals[s];
                s = this._next[s];
            }
        }
    }

    * entries() {
        for (let gen = 3; gen >= 0; gen--) {
            let s = this._genHead[gen];
            while (s !== -1) {
                yield [this._keys[s], this._vals[s]];
                s = this._next[s];
            }
        }
    }

    [Symbol.iterator]() {
        return this.entries();
    }

    // -- Internal ------------------------------------------

    _allocSlot() {
        const s = this._freeHead;
        if (s === -1) throw new Error("internal: free list empty");
        this._freeHead = this._next[s];
        this._next[s] = -1;
        this._prev[s] = -1;
        return s;
    }

    _freeSlot(s) {
        this._keys[s] = undefined;
        this._vals[s] = undefined;
        this._meta[s] = 0;
        this._next[s] = this._freeHead;
        this._prev[s] = -1;
        this._freeHead = s;
    }

    _linkToGen(s, gen) {
        const head = this._genHead[gen];
        this._next[s] = head;
        this._prev[s] = -1;
        if (head !== -1) this._prev[head] = s;
        else this._genTail[gen] = s;
        this._genHead[gen] = s;
    }

    _unlinkFromGen(s, gen) {
        const p = this._prev[s];
        const n = this._next[s];
        if (p !== -1) this._next[p] = n;
        else this._genHead[gen] = n;
        if (n !== -1) this._prev[n] = p;
        else this._genTail[gen] = p;
        this._next[s] = -1;
        this._prev[s] = -1;
    }

    _moveToGen(s, fromGen, toGen) {
        if (fromGen === toGen) return;
        this._unlinkFromGen(s, fromGen);
        this._linkToGen(s, toGen);
    }

    /**
     * O(1) amortized eviction via cascading tail evaluation.
     * Only inspects the tail of the lowest non-empty generation.
     */
    _evict() {
        while (true) {
            let targetGen = -1;
            for (let g = 0; g < 4; g++) {
                if (this._genTail[g] !== -1) {
                    targetGen = g;
                    break;
                }
            }
            if (targetGen === -1) {
                throw new Error("internal: eviction failed -- no candidates");
            }

            const s = this._genTail[targetGen];
            const visited = this._meta[s] & 0b1;

            if (visited) {
                // Hot -> promote to youngest generation
                this._meta[s] = (3 << 1) | 0;
                this._moveToGen(s, targetGen, 3);
            } else if (targetGen === 0) {
                // Coldest item -- true eviction
                this._unlinkFromGen(s, 0);
                this._map.delete(this._keys[s]);
                return s;
            } else {
                // Age down one generation
                const newGen = targetGen - 1;
                this._meta[s] = (newGen << 1) | 0;
                this._moveToGen(s, targetGen, newGen);
            }
        }
    }
}
```

### Known limitations of the current LiteMGLRU

- No background aging (aging occurs under eviction pressure)
- No Bloom-filter refault protection
- No anonymous vs file distinction
- Single-threaded

These are intentional simplifications for a userspace, fixed-capacity experiment.

---

## 7. Recommended Path

1. Finalize the SoA + Map substrate and classic LRU.
2. Implement SIEVE as the headline policy (optionally using `lite-fastbit32` for the visited bit).
3. Add S3-FIFO, W-TinyLFU, and SLRU.
4. Ship zero-GC TTL, iteration, and stats.
5. Ship the benchmark harness with the Belady OPT implementation.
6. Keep LiteMGLRU, self-measuring meta-policy, and other adaptive ideas strictly on the v2 research track.

---

## 8. Open Questions

- How close can a carefully tuned SIEVE or S3-FIFO get to OPT on real production traces?
- Is a simplified generational policy (LiteMGLRU) competitive enough with SIEVE/S3-FIFO to justify inclusion, or does it
  mainly serve educational / attention value?
- What is the cleanest zero-GC way to expose live "distance to OPT" without harming the hot path?

---

## 9. Allocation and fail-closed audit of 1.18.0 (2026-09-23)

The audit record behind ROADMAP S17. It was a read-only audit: probes ran outside
the repo, and patched copies of Lru.js were used only to confirm the fixes.
Method: count minor GCs (scavenges) at N=200k and 8N under
`node --expose-gc --max-semi-space-size=4`, one config per process, with the
feature ON scaling compared against feature OFF. The same method is applied
across the suite (lite-hud M2, lite-sketch, lite-filter).

### 9.1 Why the gates passed

V8 boxes a fractional or large double (a ~16 B HeapNumber) when it is passed to,
or returned from, a call that V8 did not inline. Small integers (Smis) never box.
Every lite-lru gate lane fed Smis:
- the torture TTL clock counts up from 0 with ttl 8 (test/torture/t6-alloc.mjs:1089)
- the perf gate has no TTL or stats lane at all
- keys are always small and non-negative

A heap-delta gate cannot see transient allocation anyway. So a real clock
(an epoch-ms value like 1.7e12, or `performance.now()`) was never measured.

### 9.2 Measured findings

| id | owner | finding | numbers |
| --- | --- | --- | --- |
| A1 | library | `expiryFor` returns the expiry double from a call. V8 stops inlining it once a TTL-off instance of the same class ran in the process (the call site goes polymorphic), and from then on it boxes. | All 13 members' `put`: 0 scavenges at N, 12 at 8N (~31.5 B/op) with an epoch-sized or `performance.now` clock. 0 in a fresh process, 0 with a small-int clock, and 0/0 with the expiry maths inlined into `put`. |
| A2 | library (default) | `Date.now` as the default clock: a native call that returns a boxed double on every TTL touch. | get / has / put / iteration: 15.7-31.5 B/op on all 13 members, and it persists after the A1 fix. `timeOrigin + performance.now()` measured 0/0. |
| A8 | library | W-TinyLFU int keys below -2^30. Suspected cause (not verified): the unsigned 32-bit hash is passed into a non-inlined `_sketchInc`. | 6 scavenges at 8N (15.7 B/op), stable over 3 runs. Same keys on Sieve / S3Fifo / Arc / LiteLru: 0. Keys at or above 2^30, or near -1000: 0. |
| A7 | doc | Dense `clear()` is O(1) only for the index. `SlotStore.reset` is O(capacity). | 0.8 us (cap 16), 4.0 us (cap 4096), 644 us (cap 1M), each with 8 or fewer residents. |

Fail-open findings (A3 duplicate keys in restore, A4 DirectLru dropping unknown
options, A5 unvalidated restore expiry values, A6 unchecked clock return) are
reproduced exactly in ROADMAP S17 F3-F6. A3 and A4 were re-run independently
and reproduced.

### 9.3 Lessons (apply suite-wide)

1. **Never return a computed double from a helper on a hot path.** Compute it
   inline, or write it into a typed-array slot. "V8 will inline it" holds only
   while the call site stays monomorphic. One other instance of the same class
   with the feature OFF is enough to break it.
2. **A default argument is part of the hot path.** `Date.now` is a boxing source,
   so any zero-alloc claim has to be measured with the DEFAULT clock, not only
   with an injected one.
3. **Gate with realistic magnitudes:** epoch-ms clocks, fractional clocks, keys
   below -2^30. Warm up with the feature OFF in the same process before the ON
   lane.
4. **restore() is an input door.** Validate every field as strictly as the
   constructor does: unique keys, typed expiry values, unknown options. A wrapper
   that rebuilds an options object must run the same door first.

### 9.4 Checked clean

- onEvict reentrancy fuzz: 13 members x 300 trials, 60k steps each, 0 validate()
  failures.
- 19 key edge values on int / dense: all tagged rejections, no int32 fold.
- Counters and logical clocks above 2^30 / 2^32: 0 scavenges.
- TTL-off hot paths and string keys on Map: 0 scavenges.

---

## 10. Suite research intake (2026-10-18): cache tiers, layout, and the broken test generator

Sources, all in `../Research/`:

- `RESEARCH_EPOCH_O1.md` section 3 (2026-10-07; lite-lru 1.19.0 as the consumer);
- `CACHE_RESEARCH.md` sections 3.4 and 4 (2026-10-07);
- `BITWISE_RESEARCH.md` sections 1 and 8 (re-verified here 2026-10-18).

The plan these feed is `ROADMAP.md` section 8.

**Tier of every number below: REPORTED.** They were measured on a different
host from the suite's (4 vCPU Xeon @ 2.3 GHz, L2 2 MB/core, **L3 260 MB
shared**, Node 22.22.0, shared cloud VM; best of 5; no hardware counters).
Cells varied 30-50% run to run at >= 10^6 entries. None was re-measured this
cycle, so none may enter README or CHANGELOG as a measurement until a run of
this cycle reproduces it (ROADMAP 8, R2). The 260 MB L3 keeps even 4e6-entry
structures out of DRAM. On a 12-36 MB-L3 laptop the gaps below should be
larger. That is a hypothesis, not a measurement.

### 10.1 The hit cost is not flat as the cache grows (ns per hit, uniform random keys, 100% hits)

| capacity | random-read floor | `Map.get` | LRU / map | LRU / int | LRU / dense | SIEVE / map | SIEVE / int | SIEVE / dense |
|---|---|---|---|---|---|---|---|---|
| 1e3 | 1.0 | 16 | 25 | 13 | 8.6 | 25 | 12.5 | 7.9 |
| 1e4 | 0.9 | 14 | 29 | 20 | 12.8 | 25-28 | 17 | 9 |
| 1e5 | 1.0 | 26-31 | 107-129 | 48-61 | 27-41 | 50-74 | 26-40 | 13-17 |
| 1e6 | 2.8-4.5 | 63-66 | 176-180 | 102-128 | 84-109 | 100-129 | 42 | 43-50 |
| 4e6 | 4.7-5.8 | 81-96 | 430-439 | 151-181 | 140-166 | 307-310 | 99-143 | 70-105 |

Reading:

1. From 1e3 to 4e6 a hit gets 9-17x more expensive on every policy and
   backing. That rise is the cache-miss factor, and at scale it dwarfs the
   gaps between policies.
2. Up to ~1e4 entries everything fits in L1/L2 (8-29 ns per hit). Cache-miss
   engineering pays only for caches >= ~1e5 entries: server-side Node, large
   memo tables, asset / tile caches. Scope any layout work to that audience.
3. The biggest levers are already pulled:
   - writes per hit: SIEVE vs LRU is 1.4-2.6x at >= 1e5, which is DEBATE.md
     section 2's "fewer writes per hit", now with a locality reading;
   - a typed-array index instead of `Map`: 2-3x at >= 1e5 (SIEVE / int or
     dense vs SIEVE / map).
4. A Map-backed hit costs far more than `Map.get` alone at scale (307 vs
   81-96 ns at 4e6). Hypothesis, not measured with counters: the
   `_vis[s]` / `_vals[s]` loads depend on the slot the Map returns, so they
   cannot overlap with the lookup. Confirm with
   `perf stat -e cache-misses,LLC-load-misses` on bare metal.

### 10.2 Layout prototype: cache lines touched by a SIEVE int-key hit

Today's `IntSlotStore` (`Lru.js:511`) does
`_ixSlot[b] -> _ixKey[b] -> _vis[s] -> _vals[s]`: four arrays, up to four
lines. Prototype variants (same hash, load factor 0.75, linear probing,
single run, so indicative only):

| capacity | A: today | B: interleaved `[key, slot]` | C: B + visited bit in the slot word | D: one 16-byte record `[key, slot\|vis, value, -]` |
|---|---|---|---|---|
| 1e3 | 9.6 | 9.5 | 9.4 | 9.9 |
| 1e4 | 13.5 | 13.8 | 13.2 | 14.1 |
| 1e5 | 34.8 | 23.7 | 21.2 | 23.3 |
| 1e6 | 49.0 | 49.5 | 65.5 (noise?) | 39.9 |
| 4e6 | 107.7 | 97.2 | 67.8 | 73.5 |

- No gain at <= 1e4. About 1.3-1.6x at >= 1e5 from touching fewer lines.
- **B is the cheap one.** It interleaves `_ixSlot` / `_ixKey` into one
  `Int32Array(2 * size)`, changes no semantics, and is local to
  `IntSlotStore`.
- **C costs real writes.** SIEVE's hand walks slots, so a visited bit in the
  bucket needs a slot -> bucket back-pointer that backward-shift deletion
  must maintain. That is extra writes on put / delete to save one line per
  hit. Not recommended unless D's bare-metal numbers justify it.
- **D works only for numeric values**: an opt-in `values: 'f64' | 'i32'`
  lane. With object values the `_vals[s]` load (and then the object itself)
  cannot be avoided. Real use cases: memoizing numeric functions,
  id -> index maps, tile caches. It needs an ADR against the single-surface
  law.

### 10.3 Swiss / flat hashing for string keys: measured, a dead end

A pure-JS open-addressed table with a 7-bit tag byte per bucket loses to
native `Map` by **1.5-2.5x at every size** (1e3..1e6). The reasons are
structural:

- V8 caches each string's hash in the string header and `Map` uses it. JS
  cannot read it, so every lookup re-hashes the characters.
- There is no SIMD group probe in JS.

`IntSlotStore` / `DirectSlotStore` already avoid `Map` for integer keys. The
only route to a faster general-key index is to **not hash strings per
lookup**: callers intern keys to ints once and use `keys: 'int' | 'dense'`,
which gets the 2-3x from 10.1. That is API guidance, not a data structure
(ROADMAP 8, R5). `CACHE_RESEARCH.md` section 4 counts lite-lru's
typed-array SoA policies as the "flat eviction caches" item, already
shipped.

### 10.4 The broken mixed-stream generator (FIXED in the working tree, 2026-10-18)

Eleven test sites used `x = (x * 1103515245 + 12345) & 0x7fffffff` with
`k = x % 20` and `op = x % 5`:
`test/{Lru:321,663; S3Fifo:390,544; Sieve:377,549; WTinyLfu:469,781; TwoQ:318; Slru:277; Lfu:422}`.
Two independent defects:

1. **The multiply runs in doubles.** `x` near 2^31 times 1103515245 is near
   2^61, far past 2^53, so the low bits round away before the mask reads
   them. Re-verified 2026-10-18: from `x = 1` the generator enters a cycle at
   step 689 with **period 10,466** (a real LCG mod 2^31 has period 2^31).
2. **Key and op come from the same draw.** 20 is a multiple of 5, so
   `op === k % 5` always.

Effect: 500 ops reached **7 of 100 (key, op) pairs**, and `put` touched only
key 16. So the cap-8 "conservation invariant ... mixed op stream" tests,
including the four labelled heavy churn, never filled the cache and never
evicted. The Lfu degenerate-cap site draws kind, key and value separately,
so it was less affected: 10/40 pairs at cap 2, 40/70 at cap 4, 73/130 at
cap 8.

Fix: `../Research/lite-lru-test-generators.patch`, moved to
`.handoff/lite-lru-test-generators.patch` and applied with `patch -p1`.
- Use `Math.imul(x, 1103515245)`, which is exact 32-bit multiplication.
- Draw key and op from different high bit ranges: `k = (x >>> 16) % 20`,
  `op = (x >>> 8) % 5`.
- Lfu: `rnd` returns `x >>> 8`.

Result: 99/100 pairs, and `put` touches 19 keys. Lfu is at full coverage:
40/40, 70/70 and 130/130.

Gate with teeth: `test/Generators.test.js`, 5 tests.
- A source lint fails if any suite reintroduces `x * 1103515245`.
- Coverage (>= 90 pairs, more than 8 put keys) and an eviction check on a
  real cap-8 `LiteLru`.
- A period check.
- Each has a control that runs the OLD generator through the same predicate
  and must fail it (7 pairs, 1 put key, 0 evictions, period 10,466).

Revert check: restoring the old multiply in a test file makes the lint test
fail.

Suite: **2,359 / 2,359 before, 2,364 / 2,364 after** (`npm test`,
2026-10-18, Node 26.8.2). The ten affected tests now exercise eviction and
still pass, so no engine bug was hiding behind the gap.

Lesson for the suite: a generator is part of the oracle. Before trusting a
fuzz or soak run, measure the generator's period and its (key, op) coverage.
Production hashing in lite-lru already uses `Math.imul` throughout.

### 10.5 Bitwise notes that concern lite-lru (`BITWISE_RESEARCH.md` section 8)

- W-TinyLFU's eight 4-bit counters per `Uint32` (SWAR), halved with
  `(w >>> 1) & 0x77777777`, are done right. The trap to keep guarding is a
  carry crossing lanes: saturate before adding.
- Values >= 2^30 box in Chrome object fields under pointer compression
  (section 9's audit already applies this suite-wide). Keep bit words in
  typed arrays.

### 10.6 Cross-package notes

- **Dual index** (`CACHE_RESEARCH.md` section 5.5): for workloads that mix
  point gets with range scans, pair a lite-lru / lite-o1 hash with a
  lite-logn ordered side index over the same ids. Every mutation writes
  twice, and index memory doubles. It is a recipe for GUIDE.md, not a
  member.
- **A filter in front of the cache is not a miss reducer in memory**
  (`CACHE_RESEARCH.md` section 3.4). It pays off only in front of something
  much more expensive than a memory probe.
- **SharedArrayBuffer / cross-worker** (ROADMAP section 7, deferred item 11):
  the suite's lossless cross-thread queue research now lives in
  `../LiteWorker/RESEARCH.md`, built on Dmitry Vyukov's bounded MPMC queue.
  A cross-worker cache would sit on that transport, not inside this package.

---

*This document consolidates design discussion, theoretical grounding, and experimental code for the lite-lru project. It
is intended as an internal research reference.*
