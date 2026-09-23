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

*This document consolidates design discussion, theoretical grounding, and experimental code for the lite-lru project. It
is intended as an internal research reference.*
