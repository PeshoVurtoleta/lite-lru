# 0018 -- Iteration: zero-GC keys/values/entries + [Symbol.iterator], D18

Status: accepted (S11 -- iteration across all four members)

## Context

S11 adds iteration to the whole family (`LiteLru`, `Sieve`, `S3Fifo`, `WTinyLfu`)
under the SAME `LiteCache<K,V>` surface: `keys()`, `values()`, `entries()` and
`[Symbol.iterator]`. The design constraints are the suite's, not `Map`'s convenience:

  - Zero allocation on EVERY iteration STEP (`next()`), for ALL FOUR members.
  - Recency-neutral: a walk is a read, like `peek` -- it must not change what the
    next eviction would pick.
  - Lazy TTL (decisions/0017) holds: a walk sees only live entries, but a walk is not
    a reclamation path.
  - Fail closed on unverified state: an iterator over a structure that changed under it
    is invalid, and the next step says so loudly. null is not zero.

The iterator is ONE internal `CacheIterator` composed by every member -- the same
composition move Sieve/S3Fifo/WTinyLfu/TTL already make over the shared substrate.

## The decision -- D18

### D18.1 -- per-member iteration ORDER, defined and documented (NOT "recency")

Each member walks a ROSTER of its intrusive lists, each list head -> `_next` -> ... ->
NIL, concatenated in this order (mirrors `validate()`'s `activeListsOf`):

  - `LiteLru`: `_head` .. `_tail` -- MRU -> LRU. The ONLY member whose iteration order
    is TRUE RECENCY.
  - `Sieve`: `_head` .. `_tail` -- FIFO insertion order, newest -> oldest. NOT recency
    (a hit sets a visited bit, it does not move the entry).
  - `S3Fifo`: `_mHead` .. `_mTail` (MAIN) THEN `_sHead` .. `_sTail` (SMALL), each
    newest -> oldest. The keys-only GHOST is EXCLUDED (it fingerprints evicted keys; it
    holds no resident entry and no value). Two FIFO rings concatenated, NOT recency.
  - `WTinyLfu`: `_wHead` .. `_wTail` (WINDOW) THEN `_ptHead` .. `_ptTail` (PROTECTED)
    THEN `_prHead` .. `_prTail` (PROBATION), each MRU -> LRU. Three segments
    concatenated, NOT a single global recency order.

There is deliberately NO universal "recency order" claim across the family -- only
`LiteLru` is true recency. Each member's order is documented on its class and in the
README order table so a caller never assumes a guarantee a policy does not make.

### D18.2 -- zero-GC mechanism: NO generators, one shared hand-written iterator

A generator (`function*`) allocates a fresh `IteratorResult` object per `yield` -- that
is per STEP, which fails the gate. So iteration is a hand-written `CacheIterator`:

  - a SINGLE `{ value, done }` result object, allocated once in the constructor and
    MUTATED in place, returned from every `next()`.
  - `entries()` additionally reuses a BORROWED 2-element `[key, value]` tuple, mutated
    in place each step. CAVEAT, documented everywhere: copy what you keep. ONLY a
    copying map materializes -- a manual per-step `[k, v]` copy or
    `Array.from(cache.entries(), ([k, v]) => [k, v])`. A plain `[...cache.entries()]` /
    `Array.from(cache)` with NO map fn collects N references to the ONE reused tuple,
    which the completed walk then nulls (the retention hardening in D18.2 below), so
    every element reads `[undefined, undefined]` -- not "the last pair", and not the
    data. This makes a bare spread of entries fail LOUDLY (all-undefined) rather than
    silently-plausibly, which is on-law (fail closed). `keys()`/`values()` yield the
    scalar directly, so `[...cache.keys()]` / `[...cache.values()]` materialize
    correctly (no aliasing hazard).
  - the iterator OBJECT itself (and its small head-roster array) is allocated ONCE per
    `keys()`/`values()`/`entries()` call -- COLD, never per step.
  - RETENTION HARDENING (reviewer-found): on the terminal `next()` (`done === true`) the
    iterator nulls both `_result.value` AND the borrowed `[k, v]` tuple's two slots. A
    drained iterator therefore pins NOTHING -- so a caller who retains an exhausted
    iterator cannot keep the last-yielded key/value alive after those slots are evicted
    ("null is not zero", zero retention). This is what makes a bare `[...cache.entries()]`
    read back all-`[undefined, undefined]` (see the caveat above); the two behaviours are
    the same one nulling, and it is intended. Cost: one cold null-out per walk, zero per
    step.

The result: iterator construction allocates a handful of objects (cold); `next()`
allocates NOTHING. The t6 iterStep gate proves it (>= 10,000 `next()` steps at
capacity: `maxBytesPerCall 1`, `maxMajor 0`, `maxPauseMs 4`).

### D18.3 -- [Symbol.iterator] === entries() (matches Map); Iterable<[K,V]>

`cache[Symbol.iterator]()` returns `entries()`, so `for (const [k, v] of cache)` works
exactly like a `Map`. `LiteCache<K,V> extends Iterable<[K,V]>` in the type surface, and
each member `implements LiteCache<K,V>`, so the one-line policy swap still type-checks.

### D18.4 -- recency-neutral: iteration applies NO policy side effect

A walk applies NO promotion, NO SIEVE/S3-FIFO visited bump, NO W-TinyLFU sketch bump or
segment relink -- exactly like `peek`. It reads `_keys`/`_vals` columns directly and
follows `_next`; it never routes through `get`/`_onHit`/`_moveToFront`. So iterating a
cache does not change which entry the next over-capacity insert evicts. (A caller who
interleaves `get()` calls WITH a walk is out of contract -- see D18.6.)

### D18.5 -- TTL: iteration SKIPS stale entries but does NOT reap them

Under `ttl` (decisions/0017) a walk uses the SAME staleness predicate the hot paths use
(`_exp !== null && _exp[s] <= _clock()`) to SKIP a stale slot -- a stale entry is
invisible to iteration. But iteration performs NO structural mutation: it does not reap
the stale slot (unlike a stale `get`/`has`/`peek`). Consequences:

  - `size` is UNCHANGED by a walk -- iterating an all-stale cache yields nothing yet
    leaves every stale entry resident and counted.
  - iteration is not a reclamation path: use `purgeStale()` (D17.5) to reap.

Reaping mid-walk is rejected on purpose: a structural mutation mid-walk would either
corrupt the walk or force the fail-closed throw (D18.6). Skipping is the read-only,
zero-mutation choice consistent with D18.4.

### D18.6 -- mutation-during-iteration -> fail closed via a single `_ver`

`SlotStore` gains one integer `_ver`, bumped ONLY by structural mutations:

  - each member's `put` (covers update / insert / evict), `delete` (on an actual hit),
    `clear`, and `_reap`; and `S3Fifo._evict` (redundant with `put`'s bump, which is its
    only caller -- kept explicit as the eviction-path marker; a double bump is harmless,
    `_ver` is only ever compared for equality).

`_ver` is NEVER bumped on the get/has/peek READ path: a plain (non-stale) `get`'s
recency reorder does not touch it. A `CacheIterator` captures `_ver` at construction and
re-checks it at the TOP of every `next()`; on a mismatch it throws a `[lite-lru]`-tagged
Error. So a `put`/`delete`/`clear`/eviction/reap that lands mid-walk makes the next step
throw -- unverified state fails closed rather than silently yielding garbage.

DELIBERATELY NOT CAUGHT: a `get()`-induced access-order reorder mid-walk (LiteLru
promotion, W-TinyLFU segment relink). Catching it would require a `_ver` bump on the HOT
get path, which would cost a write per hit and move the measured writes-per-hit
baselines. So a `get` mid-walk is DOCUMENTED-UNSUPPORTED (the walk may skip or repeat an
entry) but not an error -- the honest trade: the fail-closed guard covers structural
mutation, not benign reorder, so the hot path stays byte-identical.

### Writes-per-hit unchanged (measured)

The `_ver` bump lives on structural mutations, not hits, and `_ver` is a plain integer
field on the store -- NOT one of the Proxy-counted `_next`/`_prev`/`_vis` link columns.
So after adding it, the t6 writes-per-hit baselines are UNCHANGED: LiteLru head/interior/
tail = 0 / 5 / 4; Sieve and S3Fifo hit = 0 links + 1 visited byte; W-TinyLFU window-MRU
re-hit = 0. The get path performs zero `_ver` writes.

## Consequences

  - `SlotStore` gains one integer field (`_ver`); no new column, no per-slot cost.
  - Four public methods join the `LiteCache<K,V>` surface on every member
    (`keys`/`values`/`entries`/`[Symbol.iterator]`), all zero-GC per step. `_iterHeads`
    (the roster) and `[Symbol.iterator]` are invisible to the dts-drift `classMembers`
    enumerator (underscore / non-identifier start); the counted public surface goes
    9 -> 12 (the three named methods).
  - Iteration is a NAMED, gated law: t0 (per-member iteration order == the documented
    roster walk; TTL-skip-without-reap), t6 (the iterStep 0-B/op gate), t9 controls
    (a generator-based iterator allocates per step -> the alloc gate rejects it; an
    iterator that promotes-on-walk -> the recency-neutral law rejects it; an iterator
    that reaps-mid-walk -> the size-unchanged law rejects it).
  - The public API is additive; VERSION stays "1.3.0" (moves only at /release).
