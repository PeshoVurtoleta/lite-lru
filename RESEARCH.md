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
- “Measure & Trust” as the primary product differentiator

The library intentionally avoids competing with `lru-cache` on feature breadth or with `quick-lru` on minimalism. It
wins on a different axis: a curated family of modern policies, strict performance discipline, and an authoritative
measurement harness.

---

## 2. The Analytical Anchor: Bélády’s OPT

### Why it belongs in the project

If the library ships a benchmark harness as a core feature, it needs an absolute reference point. Bélády’s Optimal
Algorithm (OPT / MIN) is the mathematically perfect offline eviction policy: it always evicts the item whose next use
lies furthest in the future.

**Where it lives**: Strictly inside the offline harness (`lite-lru-benchmark`). It must never appear in any production
policy.

**Why it is a killer feature**:

- “SIEVE achieved 82 %” is ambiguous.
- “SIEVE achieved 82 % while OPT achieved 84 % → 97.6 % of optimal” is immediately actionable.
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
 * Calculates the mathematically optimal hit rate for a given trace (Bélády's OPT).
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

### Important observation

In a measured environment with fixed capacity, there exist workloads (and prefixes of workloads) in which the cache
never fills. In that regime, classic doubly-linked-list move-to-front operations become pure overhead. Flag-based and
lazy-promotion policies (SIEVE, S3-FIFO, generational designs) naturally win.

---

## 3. v1.0.0 Policy Roster

| Policy          | Role                                      | Notes                                      |
|-----------------|-------------------------------------------|--------------------------------------------|
| Classic LRU     | Honest baseline                           | Not the headline                           |
| **SIEVE**       | Headline policy                           | Simplest modern high-performer, 1-bit flag |
| S3-FIFO         | Strong general / CDN performer            | Queue-based, excellent one-hit filtering   |
| W-TinyLFU       | Skewed / Zipfian workloads                | Frequency sketch + window                  |
| 2Q / SLRU       | Simple scan-resistant baseline            | —                                          |
| ARC             | Deferred                                  | Ghost lists stress the fixed-capacity model|
| LIRS, CLOCK-Pro, LRU-K, pure CLOCK | Out of v1 family               | —                                          |

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
modes (e.g. recency-biased SIEVE ↔ frequency-biased mode). This is the only adaptive idea still considered genuinely
differentiated. It directly strengthens the “Measure & Trust” moat.

### Adaptive Light Hybrid / Shadow-OPT

Interesting on paper but high risk of destroying the throughput advantage of the zero-GC substrate through extra
branching and metadata. Kept strictly as research.

---

## 6. Experimental Direction: LiteMGLRU

Linux Multi-Gen LRU (MGLRU, merged in kernel 6.1) is the current production page-reclaim policy on a large fraction of
the world’s Linux systems. A clean, userspace, zero-GC, fixed-capacity approximation has clear attention potential.

### Design goals of LiteMGLRU

- Fixed capacity
- SoA layout
- 4 generations (0 = oldest, 3 = youngest)
- 1-byte metadata per slot (bit 0 = visited, bits 1-2 = generation)
- Hot path (`get`) only sets a bit — no list movement
- O(1) amortized eviction via cascading tail evaluation

### Reference Implementation

```js
/**
 * LiteMGLRU – Zero-GC Userspace Multi-Gen LRU
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

    // Iteration order: Gen 3 → Gen 0 (approximate MRU → LRU)
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

    // ── Internal ──────────────────────────────────────────

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
                throw new Error("internal: eviction failed – no candidates");
            }

            const s = this._genTail[targetGen];
            const visited = this._meta[s] & 0b1;

            if (visited) {
                // Hot → promote to youngest generation
                this._meta[s] = (3 << 1) | 0;
                this._moveToGen(s, targetGen, 3);
            } else if (targetGen === 0) {
                // Coldest item – true eviction
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
5. Ship the benchmark harness with the Bélády OPT implementation.
6. Keep LiteMGLRU, self-measuring meta-policy, and other adaptive ideas strictly on the v2 research track.

---

## 8. Open Questions

- How close can a carefully tuned SIEVE or S3-FIFO get to OPT on real production traces?
- Is a simplified generational policy (LiteMGLRU) competitive enough with SIEVE/S3-FIFO to justify inclusion, or does it
  mainly serve educational / attention value?
- What is the cleanest zero-GC way to expose live “distance to OPT” without harming the hot path?

---

*This document consolidates design discussion, theoretical grounding, and experimental code for the lite-lru project. It
is intended as an internal research reference.*
