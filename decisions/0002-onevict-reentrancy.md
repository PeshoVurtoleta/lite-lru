# 0002 -- onEvict reentrancy contract (amends D8)

Status: accepted (v0.1.1, S1)

## Context

D8 (0001) added an optional `onEvict(key, value)` hook fired when a `put` at
capacity evicts the LRU tail. The original `put` fired it MID-EVICTION:

```
s = this._tail;
evKey = this._keys[s]; evVal = this._vals[s];
this._detach(s);            // s unlinked from the active list
this._map.delete(evKey);    // key removed from the index
this._size--;               // size now capacity-1
this._onEvict(evKey, evVal);// <-- fired HERE, cache mid-surgery
// ... only AFTER this does s get reused for the newcomer
```

At the callback point the cache is in an inconsistent intermediate state: slot
`s` is detached but not yet reclaimed or reused, and `_size` is `capacity-1`.

## The defect (found by S1 qa, reproduced)

If the callback REENTERS the same instance while the cache is at capacity:

```js
const c = new LiteLru(3, { onEvict: () => c.put("reentrant", 999) });
c.put("a",1); c.put("b",2); c.put("c",3);
c.put("d",4);   // evicts "a"; onEvict reenters put()
```

The reentrant `put` sees `_size === capacity-1`, so it takes the ALLOC branch and
calls `_allocSlot()` -- but the free list is empty at steady-state capacity, so it
pops `this._free === NIL === -1`. Slot `-1` aliases the sentinel: the `Int32Array`
link writes at index `-1` silently no-op, `_keys[-1]`/`_map` gain a phantom entry,
and `this._free` becomes `undefined`. Result: `size` exceeds `capacity`, and a
later `validate()` (or any free-list walk) never terminates -- a hang, i.e. a DoS,
not merely a wrong answer.

Root cause is not the free list; it is firing a caller-supplied callback while an
internal multi-step mutation is only half done.

## Decision

Two changes, together:

1. **Fire `onEvict` LAST, when the cache is fully consistent.** Capture
   `(evKey, evVal)` before the eviction, complete the whole operation (reuse the
   slot for the newcomer, restore `_size`), and only THEN call `_onEvict`. A
   callback now observes a coherent cache with the new entry present and the victim
   gone. This is the more conventional ordering and, on its own, removes the
   half-done-state hazard.

2. **Fail closed on reentrancy.** A `_inOnEvict` boolean is set only while
   `_onEvict` runs (via `try/finally`, so it resets even if the callback throws).
   Every MUTATING method -- `put`, `get` (it promotes), `delete`, `clear` -- throws
   a `[lite-lru]`-tagged `Error` if entered while `_inOnEvict` is true. Because the
   cache is already consistent when the callback fires (change 1), that throw leaves
   it intact. Read-only methods `has` and `peek` are NOT guarded: they cannot
   corrupt anything and are the sanctioned way to inspect the cache from `onEvict`.

This matches the suite law "fail closed on every unverified state": reentrant
mutation is a caller bug, so it is rejected loudly rather than silently corrupting
the structure or being quietly supported (which would invite unbounded
evict -> put -> evict recursion).

## Why not "support reentrancy"?

Allowing `onEvict` to reenter `put` opens recursive eviction cascades (each evict
fires another callback that evicts again) with no natural bound -- a stack-overflow
risk and a reasoning hazard for every future family member. A hard, documented "do
not reenter" contract is simpler, safe, and cheap.

## Cost

`_inOnEvict` is one instance boolean. The guard on each mutating method is a single
predicted-not-taken branch and NO allocation; the `Error` is built only on the
throw (misuse) path. The zero-alloc hot-path posture is unchanged -- proven by the
existing torture T6 gate (get/put re-hit loops still 0 B/op, backing stores
unchanged). The writes-per-hit baselines (head 0 / interior 5 / tail 4) are
untouched: the guard writes nothing to the link columns.

## Consequences

- Contract: **the `onEvict` callback must not call `put`/`get`/`delete`/`clear` on
  the same instance; doing so throws. Use `has`/`peek` to read.**
- Observable change for well-behaved callbacks: `onEvict` now fires with the cache
  in its final post-`put` state (newcomer inserted, `size === capacity`), not the
  transient `size === capacity-1` mid-eviction state. Callbacks that only consume
  `(evKey, evVal)` -- the intended use -- are unaffected.
- `Lru.js` read hot path (`get`/`put` re-hit) stays zero-alloc; no new R_* or type
  surface; VERSION unchanged by this decision (moves at /release).
- Regression pinned in `test/Lru.test.js` (reentrant mutators throw + cache stays
  consistent via `validate()`; reads allowed; normal fire-once semantics).
