# 0012 -- Sieve: the visited column is a Uint8Array, D12

Status: accepted (S4 -- the first modern eviction-policy family member)

## Context

S4 adds SIEVE (Zhang et al., NSDI'24 -- "SIEVE is simpler than LRU") as the first
member of the family beyond the classic-LRU reference. SIEVE is a FIFO-order ring
with ONE visited bit per entry and ONE moving hand:

  - a HIT sets the entry's visited bit and does NOTHING structural (zero relinks --
    the headline; classic LRU relinks a small constant per interior/tail hit).
  - new entries insert at the HEAD of FIFO order.
  - on insert-at-capacity the hand sweeps from its CURRENT position (it does NOT
    reset): a visited entry gets a SECOND CHANCE (bit cleared, hand advances toward
    the head); the first UNVISITED entry is the victim, evicted in place; the hand
    parks where it stopped and persists across evictions.

`Sieve` ships as a SECOND named export in the existing `Lru.js` (the lead's file-
shape ruling), NOT a new file: the Suite Law "single PascalCase main file" +
`sideEffects: false` + named exports already deliver the tree-shake moat -- a
bundler drops unused `LiteLru` when a caller imports only `Sieve`. No change to
`package.json` `files[]` or `exports`. `Sieve` rides the SAME `SlotStore` substrate
(decisions/0011) via the shared `newStore` factory: default Map backing, opt-in
`keys:'int'` strict-zero backing, the same `[lite-lru]`-tagged int-key door, the
shared conservation invariant, and the onEvict fire-after + `_inOnEvict`
reentrancy guard (decisions/0002).

## The decision -- D12 = A: a Uint8Array visited column

The visited column is a `Uint8Array _vis`, one byte per slot, indexed by the same
integer SLOT as the SoA payload/link columns. A hit is a SINGLE store:

```js
get(key) { const s = this._store.get(key); if (s < 0) return undefined;
           this._vis[s] = 1; return this._vals[s]; }
```

Rejected D12 = B: bit-packing the visited flags into a `Uint32Array` (32 slots per
word). Packing would turn the one headline store into a load + mask + shift + or +
store (`w[s>>5] |= 1 << (s & 31)`) and every read into a load + shift + mask. That
is INSTRUCTIONS in a hot body to save BYTES that are not scarce here -- exactly the
trade the Suite Law forbids ("bytes in a hot body, not instructions"). One byte per
slot at a fixed capacity is a bounded, preallocated, zero-GC cost measured by the
torture gate; the hit path stays a single unconditional store with no mask/shift.

Packing is recorded as INLINE-ONLY if ever adopted (e.g. for a cache-line-density
experiment on a huge-capacity variant), and NEVER as a dependency -- not a runtime
dep and not an OPTIONAL peerDep on `@zakkster/lite-fastbit32`. That library earns
its keep in MULTI-FLAG systems (many independent boolean dimensions per entry,
packed into words, tested/set with masks); SIEVE needs ONE bit per entry on the
single hottest path, which is the wrong shape for it. An optional peerDep would also
leave the tree-shake moat and the zero-runtime-deps guarantee hostage to whether the
consumer installed it -- a fail-open dependency on absence, which the Law forbids.
Zero runtime deps stands (see DEBATE item 15, the fastbit32-inline law).

## Consequences

  - The SIEVE hit path relinks NOTHING (0 `_next`/`_prev` stores at head, interior
    AND tail) and sets exactly ONE `_vis` byte -- strictly cheaper than classic
    LRU's interior/tail relink (5/4), pinned by `CountedSieve` in the torture gate.
  - `_vis` is a fixed `Uint8Array(capacity)`: allocated once at construction, never
    grown; its `byteLength` is unchanged start-to-finish under churn (t6 Gate SIEVE).
  - `delete`/`clear` zero `_vis` on free/reset, and repair `_hand` when the hand's
    slot dies (advance to a valid neighbor, or NIL when the ring empties) -- fail
    closed: a dangling hand is never left behind. `null` is not zero.
  - The public API is unchanged and additive: `Sieve` implements the same
    `LiteCache<K,V>` surface as `LiteLru`, so `new LiteLru(n)` swaps for
    `new Sieve(n)` and stays type-checked. VERSION stays "0.1.0" (moves at /release).
