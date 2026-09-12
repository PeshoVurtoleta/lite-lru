# 0011 -- The shared keyed-index substrate (SlotStore), D11

Status: accepted (v0.3.0, S3 -- the keystone)

## Context

D3 (0001) named the one allocation frontier classic `LiteLru` could not close: the
`Map`. `Map.set`/`Map.delete` can allocate on the Map's internal resize, so the
keyed index is only AMORTIZED zero-GC, never STRICT. S3 removes that frontier for
the integer-key case AND factors the shared machinery (keyed index + SoA slot
columns + free stack) into an internal substrate every future family member
composes -- built ONCE, so SIEVE / S3-FIFO / W-TinyLFU / 2Q / ARC all stand on a
strictly zero-GC keyed index for free.

## The decision -- D11 = A

A shared internal `SlotStore`, composed by `LiteLru` (and every future member). It
is an INTERNAL, never an export. The keyed index has TWO backings, chosen ONCE at
construction, so each hot path is monomorphic (no per-op branch on backing type,
"bytes in a hot body"):

  - DEFAULT (arbitrary keys): a JS `Map` (`MapSlotStore`). Honestly AMORTIZED --
    its resize can allocate. This is unchanged from v0.1.0: `new LiteLru(cap)` and
    `new LiteLru(cap, { onEvict })` behave BYTE-IDENTICALLY. Arbitrary keys keep
    the Map by necessity: objects/strings cannot live in a typed array without a
    side Map/WeakMap, which would re-introduce the very allocation frontier we set
    out to remove. D3's amortized-Map caveat therefore stands for the default path.

  - OPT-IN `keys: 'int'` (integer keys): an OPEN-ADDRESSED typed-array index
    (`IntSlotStore`) for STRICT zero-alloc. This finally resolves D3 for the
    integer path -- even the keyed index never allocates, with NO pre-fill caveat.

Rejected D11 = B (one store, a pluggable key strategy behind a single code path):
a per-op branch on the key strategy puts both strategies' bytes in one hot body.
Two backing classes chosen at construction keep the int hot path free of any
Map-related bytes and vice versa.

## Integer index technique (IntSlotStore)

  - Open addressing with LINEAR PROBING. Bucket = `hashInt(key) & mask`. Table size
    is the next power of two `>= capacity / 0.75` (fixed load factor <= 0.75), so
    `mask = size - 1` and, because an LRU never holds more than `capacity` entries
    while `size > capacity`, an empty bucket ALWAYS exists -- every probe loop
    terminates.
  - Integer hash MIX so sequential keys do not cluster: Fibonacci
    `Math.imul(key, 0x9e3779b1) >>> 0` (exact 32-bit multiply, zero-alloc) then a
    shift-xor avalanche (`h ^= h >>> 16`).
  - Occupancy WITHOUT a key sentinel: `_ixSlot` (Int32Array) is initialized to
    `NIL` (-1); a bucket is EMPTY iff `_ixSlot[bucket] === -1`. The key lives in a
    parallel `_ixKey` (Int32Array). Occupancy is `slot !== -1`, so ANY integer key
    value -- including 0 -- is storable.
  - DELETE via BACKWARD-SHIFT (no tombstones -> no probe-chain degradation under
    churn, zero-alloc): after removing a bucket, walk the following cluster and
    shift back any entry whose ideal bucket is not cyclically within `(hole, j]`.
  - The index NEVER resizes: capacity is fixed, so the table size is fixed at
    construction. `_ixSlotBytes` / `_ixKeyBytes` are captured at construction and
    `checkStable()` asserts the ArrayBuffer byteLengths never change.
  - Accepted key domain: 32-bit SIGNED integers, [-2147483648, 2147483647].
    Validated at the door (fail-closed): a non-integer or out-of-range key in
    `keys: 'int'` mode throws a `[lite-lru]`-tagged `TypeError`. `null` is not
    zero; an unverified key is rejected, never silently coerced.

## SlotStore contract (internal)

`SlotStore` (base) owns the SoA payload columns (`_keys` / `_vals`), the
`Int32Array` link columns (`_next` / `_prev`) that a POLICY threads, and the free
stack (`_free`, threaded through `_next`). It exposes a small monomorphic surface:

  - index: `get(key) -> slot | NIL`, `set(key, slot)`, `delete(key)`, `has(key)`,
    `clearIndex()`, `indexSize()`, `indexEntries(cb)` (debug/validate only).
  - slots: `allocSlot() -> slot`, `freeSlot(slot)`, `freeListLength()` (debug).
  - `reset()` (clear index + rebuild the free list + drop payload refs).
  - `checkStable()` on the int backing only (validate cross-check).

`MapSlotStore` / `IntSlotStore` extend the base and supply the index methods.
`LiteLru` is a THIN doubly-linked-list POLICY over the store: it owns
`_head` / `_tail` / `_size`, caches references to the store's columns
(`_keys` / `_vals` / `_next` / `_prev`) so the DLL relinks stay direct, and calls
the store for index and slot operations. Move-to-front / evict-tail semantics are
unchanged; the onEvict fire-after + reentrancy guard (0002) are preserved exactly.
`_makeStore(capacity, keys)` is the internal factory a member/control can override.

## Consequences

  - `new LiteLru(cap)` is byte-identical to v0.1.0 (oracle-proven across the full
    T5 corpus, both backings against the SAME lru oracle).
  - `keys: 'int'` is STRICTLY zero-alloc with NO pre-fill caveat -- the index
    buffers never grow under a 100k-op churn at capacity (T6 int gate + `checkStable`).
  - The public API is unchanged except the additive `keys` construction option.
    VERSION stays "0.1.0" (moves at /release).
  - Every later member inherits the substrate: a strict zero-GC keyed index for the
    integer path, and the shared conservation invariant, for free.
