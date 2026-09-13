# 0021 -- Snapshot / restore: dump() + static restore(), D21

Status: accepted (S-next -- snapshot/restore across all seven members)

## Context

S-next adds a CROSS-CUTTING serialize/reconstruct pair to the whole family (`LiteLru`,
`Sieve`, `S3Fifo`, `WTinyLfu`, `Slru`, `TwoQ`, `Arc`) under the SAME `LiteCache<K,V>`
surface: an instance `dump()` and a static `Member.restore(snap, opts?)`. The point is
"persist a warm cache and bring it back warm" -- write the whole cache to disk / IPC / a
worker and reconstruct it so it keeps making the SAME eviction decisions, instead of
cold-starting. It follows the exact template of the shipped S10 (TTL) / S11 (iteration) /
S12 (stats) cross-cutting sessions. The constraints are the suite's:

  - Zero allocation on every EXISTING hot path (get/put/has/peek), for ALL SEVEN
    members. dump/restore are COLD -- no substrate field is added, and no new branch
    enters a hot method. A cache that never calls dump/restore is byte-identical to the
    pre-S-next build.
  - Fail closed on unverified state: a corrupt / mismatched / oversize snapshot throws a
    `[lite-lru]`-tagged Error at `restore()`, never a silently-truncated or empty cache.
    null is not zero.
  - EXACT round-trip: dropping aux state (a ghost, the sketch, ARC's `p`) is a fail-OPEN
    correctness bug -- a restored cache would evict differently. Round-trip must be exact.

## The decision -- D21

### D21.1 -- surface: cold `dump()` + static `restore()`, exact by preserving slots

`dump()` is an instance method returning a plain, structurally-cloneable object graph
(plain arrays + plain numbers/values, NO typed-array views), so it round-trips through
`structuredClone` (and, for JSON-safe keys/values, through JSON). It is COLD and MAY
allocate -- an HONEST budget of <= 96 bytes/entry, with NO zero-alloc claim (measured
26.12 B/entry for LiteLru at capacity 4096; t6 Gate SNAP gates <= 96). It captures each
member's resident lists walked in its ITERATION order (the same roster `_iterHeads`
enumerates), plus per-member aux state.

`restore(snap, opts?)` is STATIC and targets a FRESH instance (`new Member(...)`), NOT a
clear+fill of an existing one -- a factory, mirroring how `from`/statics sit outside the
counted instance surface (dts-drift excludes statics).

Reconstruction preserves the EXACT slot layout captured in the snapshot: restore writes
each entry back into its ORIGINAL slot, relinks the intrusive lists in captured order,
re-stamps the constant segment/queue tag + per-entry visited bits + the `_exp` column,
and rebuilds the free stack over the complement. REJECTED alternative: replay via `put()`
in order. Replay cannot reproduce visited bits / the hand / the sketch / `p` / ghost FIFO
order, and -- decisively -- W-TinyLFU hashes OBJECT keys by their RESIDENT SLOT (no
WeakMap, decisions/0014), so a slot reassignment would silently corrupt object-key
frequency. Preserving slots verbatim makes the round-trip exact for every member and
makes dump -> restore -> dump a fixed point (the t5/t9 differential proves it).

### D21.2 -- opts: backing/capacity/ttl-presence FROM the snapshot; onEvict/clock/stats RE-DERIVED

The snapshot encodes what defines the STRUCTURE; `opts` supplies what does not:

  - FROM the snapshot: `cap` (capacity), `keys` (the backing kind), and ttl-PRESENCE.
    A conflicting `opts.capacity` or `opts.keys` is a fail-closed error (D21.3).
  - RE-DERIVED from `opts`: `onEvict` and `clock` (behavioural callbacks that cannot be
    serialized), and `stats` -- a restored instance requested with `{ stats: true }`
    starts with FRESH ZEROED counters (the `_stats` holder is NOT captured; a snapshot is
    a structural state, not a metrics log).
  - REQUIRED in `opts` when the snapshot has ttl on: the `ttl` DEFAULT. The per-entry
    expiries are captured, but the instance default that governs FUTURE puts is not
    encoded, so `restore()` demands it. Omitting it is fail-closed.

REJECTED alternative: encode onEvict/clock/ttl-default in the snapshot. Functions are not
structurally-cloneable, and a serialized ttl default would drift from the caller's intent
on reload; keeping behaviour in `opts` and structure in the snapshot is the clean split.

### D21.3 -- fail-closed tag + rejection matrix (null is not zero)

Every snapshot carries `{ f:'litelru/1', m:<member>, cap, keys:'int'|null, ttl:<bool>,
t:<captureMs>, ... }`. `restore()` throws a `[lite-lru]`-tagged Error on:

  1. a non-object snapshot;
  2. a wrong or absent format tag `f` (the version handle -- the ONLY compatible way to
     change the shape later is to bump it);
  3. a member mismatch (`m` != the class restoring it);
  4. a bad capacity tag;
  5. a capacity conflict vs an explicit `opts.capacity`;
  6. a keys-backing conflict vs an explicit `opts.keys`;
  7. a ttl on/off mismatch (a ttl option on a non-ttl snapshot, or a ttl snapshot with no
     ttl option);
  8. a corrupt / short / missing field (a malformed list, a column-length mismatch, an
     exp column present iff ttl);
  and the CAPACITY LAW (below): a slot index out of `[0, cap)`, a duplicate slot, or
  resident entries exceeding `cap`.

CAPACITY LAW ON LOAD (law 3): `entries > cap` is REJECTED, never silently truncated. A
duplicate slot or an out-of-range slot is caught before any state is written; restored
size is always `<= capacity`. REJECTED alternative: clamp/truncate to fit -- that is
fail-OPEN (it would silently drop a caller's data and hide a corrupt snapshot).

### D21.4 -- what each member captures (dropping aux = fail-OPEN)

Round-trip must reproduce IDENTICAL FUTURE eviction decisions vs an un-snapshotted twin
fed the same trace, so every member captures ALL policy-relevant aux state:

  - LiteLru: the recency DLL MRU..LRU + values.
  - Sieve: the FIFO ring newest..oldest + values + per-slot visited bit + the hand.
  - S3Fifo: MAIN + SMALL rings + values + visited bits + the keys-only ghost FIFO.
  - WTinyLfu: window + protected + probation + values + the Count-Min sketch AND its
    aging counter, VERBATIM (dropping the sketch silently changes admission).
  - Slru: protected + probation + values + the promote-on-2nd-hit visited bits.
  - TwoQ: Am + A1in + values + the keys-only A1out ghost.
  - Arc: T2 + T1 + values + the adaptive integer `p` + BOTH ghosts B1/B2.

Ghosts are captured KEYS-only (never values -- retention hygiene) in FIFO order and
REPLAYED oldest..newest on restore, so their eviction order is exact without persisting
raw ring indices. The sketch and `p` are copied verbatim. t9 pins three controls --
arc-p-dropped, sketch-dropped, ghost-omitted -- each of which MUST diverge from the twin
(and does).

### D21.5 -- TTL captured VERBATIM (absolute deadlines), owner ruling

Under `ttl` the `_exp` column is captured VERBATIM: absolute ms-epoch deadlines, NOT
rebased to the restore time. OWNER RULING: verbatim is the fail-closed HONEST choice -- a
restored entry expires EXACTLY when it would have without the snapshot, so a snapshot
neither extends nor shortens any entry's life. The tag records capture time `t`, so a
FUTURE opt-in rebase (shift every deadline by `now - t`) is possible WITHOUT a format
bump -- but rebase is a NON-GOAL this session and is deliberately not built. REJECTED
alternative: rebase-on-restore by default -- that silently changes expiry semantics and
is fail-open (a long-persisted snapshot would resurrect entries that should be dead).

### D21.6 -- interop with iteration/stats holds

  - Iteration (S11): `dump()` is READ-ONLY -- it does not bump the store's `_ver`, so a
    walk in progress is NOT invalidated by a concurrent `dump()` (t0 SN2 pins it). A
    structural mutation still fails a live iterator closed, unchanged.
  - Stats (S12): the `_stats` holder is NOT captured; a restored `{ stats: true }`
    instance starts fresh-zeroed (D21.2).

### Hot-body cost (measured)

dump/restore add NO field to `SlotStore` (only a cold `rebuildFreeList` method, used
solely by restore) and NO branch to get/put/has/peek. Proven (t6 Gate SNAP):

  - writes-per-hit UNCHANGED from every prior baseline: LiteLru head/interior/tail =
    0 / 5 / 4; Sieve/S3Fifo hit = 0 links + 1 visited byte; W-TinyLFU window-MRU re-hit
    = 0. The snapshot code is entirely cold.
  - a RESTORED cache's hot path is STRICT zero-alloc: 0.00000 B/op for both the get
    re-hit loop and a fresh-key insert/evict churn (int backing), with every backing
    `byteLength` invariant across the window (the restore path leaves the free list +
    index in a grow-free steady state).
  - dump budget honest and honored: 26.12 B/entry (<= 96), measured retained.

## Consequences

  - Each member gains two cold methods (`dump` instance + `restore` static). The counted
    INSTANCE surface goes 14 -> 15 (only `dump`; `restore` is static and, like `from`,
    excluded from the dts-drift instance count -- the extractor now skips statics).
  - `LiteCache<K,V>` gains `dump(): CacheSnapshot`; a new `CacheSnapshot` type is
    exported; every class declares `dump()` + a `static restore(...)`.
  - `SlotStore` gains one cold method (`rebuildFreeList`); NO new field, NO hot-path
    change.
  - Snapshot is a NAMED, gated law: Snapshot.test.js (round-trip identity, the eight
    fail-closed rejections, the capacity law on load, TTL-verbatim / fresh-stats /
    dump-mid-iteration interop, degenerate caps 1/2/3/4, degenerate keys/values, all
    seven members), t0 SN1..SN4, t2 N (empty / cap-1 / full / free-list-boundary), t5
    (the round-trip differential over the 100k corpus, every member x both backings x
    ttl off/on), t6 Gate SNAP (0-B/op restored hot path + dump budget + writes-per-hit),
    t7 (4096 dump/restore cycles conserve + tracker to 0 + value census), and t9 controls
    (arc-p-dropped, sketch-dropped, ghost-omitted -- each diverges).
  - The public API is additive; VERSION stays "1.7.0" (moves only at /release).
  - benchmark/Bench.mjs is UNCHANGED: snapshot adds no bench MEMBER (the memory-noted
    rule -- a new cache member must touch Bench.mjs MEMBERS + Bench.test.js counts --
    does not apply here; snapshot is a cross-cutting feature, not a member).
