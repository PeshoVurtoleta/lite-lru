# 0001 -- Structure: Map + intrusive preallocated doubly-linked list

Status: accepted (v0.1.0)

## Context

An LRU cache must answer two questions in O(1):
1. "Where is key K?" (lookup by arbitrary key)
2. "What is the least-recently-used entry, and re-order on every touch?"
   (recency maintenance + eviction)

No single structure does both. An array gives O(1) index access but O(n)
move-to-front. A plain linked list gives O(1) reorder but O(n) lookup.

## Decision

Fuse the two structures, each covering the other's weakness (D1):

- A **Map<key, slot>** answers question 1 in O(1) average -- it is a hash table
  (see Learning/HashTables.md), and JS `Map` handles arbitrary key types and
  SameValueZero equality for free.
- An **intrusive doubly-linked list** answers question 2: head = MRU, tail =
  LRU. Touch = unlink + push-front (O(1)); evict = drop tail (O(1)). It must be
  DOUBLY linked because unlinking an interior node in O(1) needs its predecessor.

## Zero-GC refinement (D2/D4/D5)

The list is NOT `{}` node objects. An LRU has a fixed capacity by definition, so
we preallocate exactly `capacity` **slots** once and reuse them forever:

- `_keys[]`, `_vals[]` -- object columns (payload), filled to stay PACKED (V8).
- `_next` / `_prev` -- `Int32Array` link columns; a slot is an index, links are
  indices, `NIL = -1` is the sentinel (slots are non-negative, so -1 never
  collides).
- A slot lives in exactly ONE intrusive list at a time, both threaded through
  `_next`: the ACTIVE recency list (uses next+prev) or the FREE stack (next
  only). This is the same intrusive free list lite-signal uses.

Result: after construction, get/put/delete/has/peek allocate **zero** bytes in
the DLL/slot layer. Eviction repurposes the evicted slot in place (D6) rather
than round-tripping the free list.

## The one thing this does NOT make zero-GC

`Map.set` / `Map.delete` can allocate on the Map's internal resize. For a
bounded map (<= capacity) this is amortized away after warm-up, but it is not
*strictly* zero. Making it strictly zero requires replacing the Map with an
open-addressed integer-key hash over typed arrays -- deferred to a roadmap
session (S4), because it only works for integer/hashable keys and would trade
generality for the last few bytes. v0.1.0 is honest about this in the torture
gate: the DLL layer is asserted strictly zero-alloc; the Map layer is asserted
amortized-stable, not zero.

## Consequences

- get/put/delete/has/peek are all O(1) (put/delete amortized via the Map).
- Memory is O(capacity) up front, flat forever -- no growth path exists (an LRU
  never exceeds capacity, so there is nothing to grow).
- The conservation invariant `size + freeListLength === capacity` and
  `map.size === size` hold after every operation, and are the spine of the
  torture suite.
