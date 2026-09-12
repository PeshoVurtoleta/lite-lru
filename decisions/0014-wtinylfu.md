# 0014 -- W-TinyLFU: the numeric-hash sketch, the SLRU admission, and aging, D14

Status: accepted (S6 -- the frequency-admission family member)

## Context

S6 adds W-TinyLFU (Einziger et al., "TinyLFU: A Highly Efficient Cache Admission
Policy"; the Caffeine variant), the fourth member of the family beyond the classic-LRU
reference (`LiteLru`), the SIEVE headline (`Sieve`), and the S3-FIFO admission member
(`S3Fifo`). Where S3-FIFO admits by a coarse in-cache/in-ghost signal, W-TinyLFU admits
by an ESTIMATED FREQUENCY drawn from a compact count-min sketch: a small admission
WINDOW (an LRU) sits in front of a segmented main cache (SLRU: a PROBATION segment + a
PROTECTED segment), and at capacity the window's victim is admitted into the main cache
only if the sketch says it is more frequent than the main cache's victim.

  - THREE LRU lists -- an admission WINDOW, an SLRU PROBATION segment, and an SLRU
    PROTECTED segment -- all threaded intrusively through the SAME shared `_next`/`_prev`
    columns (each list with its own head=MRU / tail=LRU endpoints). `_next` toward the
    tail (LRU), `_prev` toward the head (MRU). A slot is in exactly ONE list (or free) at
    a time; `_seg[slot]` tags which (D14).
  - a fixed COUNT-MIN SKETCH `_sk`: 4 rows of 4-bit saturating counters, aged in bulk.

`get`/`put(update)` bump the sketch by one and promote the entry within its segment (a
probation hit is PROMOTED to protected; a window/protected hit moves to that list's MRU).
New keys enter the WINDOW at MRU. Below capacity, window overflow sheds into probation
with no eviction. At capacity, adding a newcomer forces the window's LRU out as the
admission CANDIDATE, weighed against the probation LRU VICTIM: the candidate is admitted
(to probation) and the victim evicted iff `freq(candidate) > freq(victim)`; ties REJECT
(favor the incumbent), evicting the candidate. A distinct one-hit-wonder never
out-frequencies the proven-hot set -- scan- AND frequency-resistant, and typically closer
to Belady OPT than LRU/SIEVE on skewed (Zipf) traffic.

`WTinyLfu` ships as a FOURTH named export in the existing `Lru.js`, NOT a new file (the
same file-shape ruling as `Sieve`/`S3Fifo`: single PascalCase main file +
`sideEffects:false` + named exports already deliver the tree-shake moat). It rides the
SAME `SlotStore` substrate (decisions/0011) via the shared `newStore` factory: default
Map backing, opt-in `keys:'int'` strict-zero backing, the same `[lite-lru]`-tagged
int-key door, the shared conservation invariant, and the onEvict fire-after +
`_inOnEvict` reentrancy guard (decisions/0002). No change to `package.json` `files[]` or
`exports`. A W-TinyLFU HIT does MORE writes than SIEVE/S3-FIFO (a segment relink + a
sketch increment) BY DESIGN; the gate asserts zero-ALLOCATION, not minimal writes.

## The decision -- D14

### D14.1 -- the sketch is keyed by a NUMERIC hash; object keys hash by resident slot

The sketch is indexed by `_hashKey(key, slot)`, a numeric hash:

  - a `number` key hashes by VALUE (`(key | 0) >>> 0`), a `string` key by a rolling
    `Math.imul` char hash. Primitive keys are the PREFERRED case: their frequency is a
    stable function of the key, unchanged across residency.
  - an OBJECT (or any non-primitive) key has no zero-alloc stable numeric identity. A
    `WeakMap` from key -> id would give one, but a `WeakMap` is FORBIDDEN by the zero-GC
    law (it allocates per distinct key and is exactly the retention the suite exists to
    catch). So object keys hash by their RESIDENT SLOT index instead -- and are therefore
    bumped ONLY WHILE RESIDENT. No per-op object or closure is allocated on either path.

HONEST TRADEOFF: because an object key's sketch coordinate is its slot, its estimated
frequency is really the frequency of WHATEVER key has occupied that slot, and it is lost
the moment the key is evicted (the slot is reused for a different key). Object-keyed
W-TinyLFU thus DEGRADES toward window-LRU-with-SLRU behaviour: admission still works
while both candidate and victim are resident (they always are at decision time), but the
"remembered frequency of a recently-evicted key" that makes TinyLFU strong is only
available for PRIMITIVE keys. This is a deliberate, documented limitation, not a bug: the
alternative (a WeakMap or a per-key id map) violates the zero-GC law. The differential
fuzz drives INTEGER keys only, so the oracle reproduces `_hashKey` exactly and the
slot-hash path is proven zero-alloc separately (t6's 1e6-op object-key window), never
differential-checked (it cannot be -- the oracle has no matching slot layout).

### D14.2 -- the sketch shape: 4 rows of 4-bit counters, 8-per-Uint32, width pow2 >= cap

```
rows   = 4                       (SK_ROWS)
width  = smallest power of two >= capacity
_sk    = new Uint32Array((4 * width + 7) >> 3)   // 4-bit counters packed 8-per-Uint32
```

Four rows is the standard count-min accuracy/space point Caffeine uses. Each counter is
4 bits (0..15), so eight counters pack into one `Uint32` (`32 / 4`), and the whole sketch
is `(4 * width + 7) >> 3` Uint32 words -- for `capacity 4096`, `width 4096`, that is 2048
words = 8 KiB, fixed FOREVER. Width is a power of two so a per-row column is a single
`& (width - 1)` mask (no modulo). Per-row columns come from ONE base key hash mixed with a
distinct per-row seed and a `Math.imul` avalanche (`SK_SEEDS`), so the rows are decorrelated
without four independent hash functions. `_sketchFreq` returns the MIN over the four rows
(the count-min estimate -- never an over-count from a collision in one row). The buffer is
allocated ONCE at construction and NEVER grown; its `byteLength` is invariant start-to-
finish under churn (asserted by t6 Gate WTINYLFU and by `validate()`). Capacity is fixed
and load-bearing INCLUDING the sketch.

### D14.3 -- aging: halve every nibble in place at sampleSize = 10 * capacity

`_sketchInc` bumps one counter per row (saturating at 15) and increments a running
`_skSize`. When `_skSize >= sampleSize = 10 * capacity`, `_sketchAge` HALVES the entire
sketch in place and halves `_skSize`. The bulk halve is branch-free per word:

```
_sk[i] = (_sk[i] >>> 1) & 0x77777777;   // shift every nibble down 1, mask the carry
```

`>>> 1` shifts every nibble right by one; `& 0x77777777` clears the high bit each nibble
would otherwise steal from its neighbour's low bit, so all counters halve INDEPENDENTLY in
a single pass, zero-alloc. Aging is what keeps the sketch a FREQUENCY estimate (recent
popularity) rather than an ever-growing all-time histogram: without it every counter
saturates at 15 and admission degenerates to always-reject. `sampleSize = 10 * capacity`
is the Caffeine sample factor. Admission reads the sketch (`_admit`); it never triggers
aging -- only `_sketchInc` does, so the aging cadence is deterministic and the oracle
reproduces it exactly (`_skSize` counting + threshold + halve are byte-identical in the
brute reference).

### D14.4 -- the splits, and the degenerate small-cap edges

```
window    = Math.max(1, Math.round(capacity / 100));   // ~1% admission window
main      = capacity - window;
protected = Math.round(main * 0.8);                    // 80% of main is protected (SLRU)
// probation is the remainder of main; no hard insert-time cap -- the eviction path
// keeps main at its target, and protected overflow demotes protected's LRU to probation.
```

`Math.max(1, ...)` keeps the window non-empty so every newcomer routes through admission.
The edges are DERIVED FROM the formula and pinned by tests, not hardcoded:

  - `capacity 1`: `window 1`, `main 0`, `protected 0`. With no main region, admission is
    SKIPPED: the single window slot is the candidate, there is no probation victim, so the
    candidate is evicted and the newcomer takes the window -- a pure LRU of size 1.
  - `capacity 2`: `window 1`, `main 1`, `protected 1`, `probation 0`.
  - `capacity 3`: `window 1`, `main 2`, `protected 2` (`round(1.6) = 2`), `probation 0`.

When probation is empty at capacity (small caps, or a fully-protected main), the window
candidate has no probation victim to displace, so it loses and is evicted -- protected
entries are NEVER evicted directly (they can only be demoted to probation on a protected
overflow, then later become a probation victim). The implementation and the brute oracle
agree on every edge exactly, and `validate()` / conservation
(`windowSize + probationSize + protectedSize === size`) stay exact through them.

### D14.5 -- the doorkeeper is DEFERRED

Caffeine's W-TinyLFU fronts the sketch with a DOORKEEPER: a small bloom filter that
absorbs the first sighting of a key (so a one-hit-wonder never even reaches the 4-bit
counters, halving sketch pollution). We DEFER it. Rationale: the doorkeeper is a pure
accuracy optimisation, not a correctness requirement -- admission is already frequency-
gated and scan-resistant without it (proven by t0 W3 and t2 I). Adding it now would mean a
second fixed bit-array, a second per-op bit test/set on the hot path, and a second thing to
reset on aging -- extra hot-path bytes for a benefit that is only measurable on specific
skewed traces. It is a clean, additive, backward-compatible follow-up if the bench shows a
member would benefit; shipping the sketch + SLRU admission first keeps the hot body small
and the first W-TinyLFU release honest. Recorded here so the omission is a decision, not an
oversight.

### Uniform surface + policy law unchanged

`WTinyLfu` implements the SAME `LiteCache<K,V>` surface as `LiteLru`/`Sieve`/`S3Fifo`
(get/put/has/peek/delete/clear + size/capacity), so `new LiteLru(n)` swaps for
`new WTinyLfu(n)` and stays type-checked -- the admission policy is INTERNAL, never in the
surface. `has`/`peek` are frequency- AND recency-neutral (no sketch bump, no relink). The
onEvict reentrancy contract (decisions/0002) and the D7 undefined-value contract hold
unchanged. The `victim()` differential twin (`_peekVictim`) is TEST-ONLY and, unlike
S3-FIFO's clone-and-replay sweep, is a pure two-way compare (window LRU vs probation LRU
through the same `_admit`), so it is allocation-free AND cannot drift from the real
eviction; below capacity it returns undefined (a new key does not evict there).

## Consequences

  - The W-TinyLFU hit path relinks (recency within a segment, or a probation -> protected
    PROMOTION with a possible protected -> probation demotion) AND sets 4 sketch counters.
    That is MORE work per hit than SIEVE/S3-FIFO's single visited byte -- and it is fine:
    the gate asserts zero-ALLOCATION, not minimal writes. The one genuine 0-relink fast
    path (a re-hit of the window MRU) is pinned by `CountedWTinyLfu` in t6.
  - Two fixed structures are added at construction: `_seg` (one byte per slot, so
    `_detach` fixes the correct list's head/tail) and `_sk` (the packed count-min sketch).
    Both allocated once, never grown; their `byteLength` is unchanged start-to-finish under
    churn (t6 Gate WTINYLFU asserts `_seg`/`_sk`/`_next`/`_prev`/the int index all hold,
    and the object-key 1e6-op window re-asserts `_sk`/`_next`).
  - `delete` frees the slot and repairs its list; the sketch is untouched (frequency
    history persists). `clear` empties all three lists AND zeroes the sketch + `_skSize`.
  - Frequency admission is a NAMED, gated law: t0 W3 and t2 I prove a proven-hot key/set
    survives an unbounded one-hit-wonder flood (with a non-vacuity check that the cold keys
    really are evicted). t9 C9 (an admit-ALWAYS control that ignores the sketch) proves the
    differential/law gate REJECTS a policy that breaks frequency admission.
  - No value or key reference is retained by the sketch -- it holds only primitive counts,
    and object keys hash by slot (no WeakMap), so t7's WeakRef census confirms evicted /
    cleared VALUE objects are collectible.
  - The public API is additive; VERSION stays "1.1.0" (moves only at /release).
