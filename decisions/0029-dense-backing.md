# 0029 -- The direct-mapped dense keyed-index backing (DirectSlotStore) + DirectLru, D29

Status: accepted (v1.17.0)

## Context

D11 (0011) gave the family two keyed-index backings: the default `Map` (arbitrary
keys, AMORTIZED) and `keys: 'int'` (an open-addressed typed-array index, STRICT
zero-alloc for large/sparse 32-bit integer keys). The `keys: 'int'` path still pays a
hash mix + a probe loop per op. A large class of real caches key on a SMALL, DENSE
integer domain -- entity ids, frame/slot indices, tile coordinates, interned handles --
where the whole key space fits in a flat array. For that shape the hash + probe is pure
overhead: a direct map `k -> slot` is both faster and simpler, and it makes `clear()`
O(1). D29 adds that third backing WITHOUT touching the two existing hot paths.

## The decision -- D29

A third internal `SlotStore` subclass, `DirectSlotStore`, opted into with
`keys: 'dense'` + a required `maxKey`, plus a thin `DirectLru` wrapper. Chosen ONCE at
construction like the other two, so every member's hot path stays monomorphic.

### D29.1 -- The hot body is a single array read; no hash, no probe, no init

The index is a DIRECT map over `[0, maxKey]`: `_ixSlot[k]` is the slot,
`_gen[k]` is a generation stamp. The whole hot body is

    get(k) => _gen[k] === _epoch ? _ixSlot[k] : NIL

No `Math.imul` hash, no linear-probe loop, no backward-shift delete. Measured
0.00000 B/op on get/put/delete/has/peek (t6 Gate DENSE), index buffers fixed at
construction.

### D29.2 -- The generation-stamp no-init trick (borrowed from sparse-set)

`_gen` is a zero-initialized `Int32Array` and `_epoch` starts at 1, so a NEVER-WRITTEN
key reads `_gen[k] === 0 !== 1` = absent with NO O(U) pre-fill. `set` stamps
`_gen[k] = _epoch` (and bumps `_count`) for a new key, or overwrites `_ixSlot[k]` in
place for a live one. `delete` writes `_gen[k] = 0` -- 0 is the reserved DEAD sentinel,
never a live epoch. Because 0 means "never/dead", the KEY `0` is fully legal (null is
not zero): emptiness is carried by the stamp, not by the key value.

### D29.3 -- clear() is O(1) via an epoch bump (disclosed-amortized reset)

`clearIndex()` does `++_epoch` (and `_count = 0`): every previously-stamped key now
mismatches the new epoch and reads absent at once, a genuine O(1) clear. The epoch
domain is `[1, INT_MAX]`; ONLY when a bump would exceed `INT_MAX` do we pay a single
O(U) `_gen.fill(0)` + `_epoch = 1` reset -- roughly once per 2^31 clears, disclosed as
amortized, never on the common path.

### D29.4 -- SPACE is the honest co-headline: O(maxKey), NOT O(entries)

The two `[0, maxKey]` `Int32Array`s cost O(maxKey), independent of how many entries are
resident. This is the explicit trade vs `keys: 'int'` (O(capacity) space, large/sparse
domains ok) and the default `Map` (O(entries), arbitrary keys). `keys: 'dense'` wins
only when the key domain is small and dense; the docs say so and steer large/sparse
domains to `keys: 'int'`.

### D29.5 -- Fail closed at the door

`maxKey` is REQUIRED for `keys: 'dense'` and must be an integer in `[0, INT_MAX]`
(`MAX_KEY_MSG`); a key outside `[0, maxKey]`, a non-integer, or a non-number fails
closed with `DENSE_KEY_MSG` -- the typeof guard runs FIRST, before any coercion. The
unknown-`keys` message now suggests both `'int'` and `'dense'`.

### D29.6 -- snapBase reads an explicit `_kind` tag, not a duck-type (the RISK)

The pre-existing `snapBase` detected the `'int'` backing by duck-typing on
`checkStable`. `DirectSlotStore` ALSO has `checkStable` (its buffers must not grow
either), so duck-typing would mislabel a dense cache as `'int'`. D29 replaces the
detection with an explicit `_store._kind` tag (`'map' | 'int' | 'dense'`) set on all
three subclasses. A dense dump carries `keys: 'dense'` + `mk` (maxKey); `restore`
rebuilds the `[0, mk]` index and fails closed on a dense snapshot missing `mk` (or a
non-dense snapshot carrying one). This change was made BEFORE the dump/restore wiring
so the two typed-array backings never alias.

### D29.7 -- DirectLru: zero policy duplication

`DirectLru extends LiteLru` and fixes `keys: 'dense'`, forwarding `maxKey` to the SAME
constructor. `new DirectLru(cap, { maxKey })` is byte-identical to
`new LiteLru(cap, { keys: 'dense', maxKey })`: every hot path, the DLL, and dump/restore
are inherited verbatim. It fails closed on a conflicting `keys` option. A cold options
object is built explicitly (not spread) at construction to keep the shape monomorphic;
no hot-path allocation.

Honest note on `restore`: a dumped `DirectLru` restores as a plain `LiteLru` (with the
`keys: 'dense'` backing), NOT a `DirectLru` instance -- `DirectLru.restore(snap)` returns
`LiteLru` and `restored instanceof DirectLru` is `false`. `DirectLru` is purely a
construction-time convenience over the shared backing; it carries no state or behavior
beyond the fixed `keys` option, so the restored `LiteLru` is behaviorally identical. The
`Lru.d.ts` return type is `LiteLru`, and a locking test in `test/Direct.test.js` pins this
so it cannot silently change.

## Consequences

- A third STRICT zero-alloc backing for small dense integer domains, faster than
  `keys: 'int'` (bench: ~40 vs ~50 ns/op at capacity 256) and with an O(1) `clear()`.
- The default `Map` and `keys: 'int'` hot paths are byte-unchanged; all thirteen
  members thread `maxKey` and can ride the dense backing.
- O(maxKey) space is the disclosed cost; the docs steer sparse domains to `keys: 'int'`.
- Proven by: t6 Gate DENSE (0 B/op churn + mixed + O(1) clear cycle + Sieve factory
  path), two dense perf-gate scenarios, `test/Direct.test.js` (oracle-vs-Map identity,
  dump/restore, no-init, O(1) clear), dense door cases across all thirteen members.
