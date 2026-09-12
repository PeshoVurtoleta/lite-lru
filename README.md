# @zakkster/lite-lru

> A zero-GC cache FAMILY under one `LiteCache<K,V>` surface: a classic LRU reference member and the modern SIEVE headline, one-line swappable, tree-shakeable to a single policy, with a shipped bench + Belady OPT tool so you stop guessing your eviction policy and measure it on your own trace.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-lru.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-lru)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-lru?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-lru)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-lru?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-lru)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The cache family the ecosystem was missing

Every JavaScript cache picks ONE eviction policy for you and hides it. `lru-cache` is LRU, forever; `quick-lru` is a naive two-Map swap, forever. But the RIGHT policy is a property of YOUR access pattern, not of the library -- classic LRU thrashes on a scan, a FIFO wastes memory on a skewed workload, and on a well-provisioned cache the per-hit bookkeeping is pure overhead. `lite-lru` ships a **curated family of policies behind one identical interface**, so switching is a one-line swap, plus **the measurement tool that tells you which one to pick**: replay your trace, get each policy's hit ratio as a percentage of Belady's clairvoyant optimum.

```bash
npm install @zakkster/lite-lru
```

```js
import { LiteLru, Sieve } from '@zakkster/lite-lru';

// Same surface, different eviction policy. Swap the constructor, nothing else.
const cache = new LiteLru(3);            // classic recency (the reference member)
// const cache = new Sieve(3);           // <- modern lazy-promotion FIFO (the headline)

cache.put('a', 1);
cache.put('b', 2);
cache.put('c', 3);
cache.get('a');                          // 'a' is now most-recently-used
cache.put('d', 4);                       // at capacity -> evicts the LRU ('b')

cache.has('b');                          // false (evicted; has() never touches recency)
cache.get('a');                          // 1  (still hot)
cache.size;                              // 3  (never exceeds capacity)
```

Then measure, do not guess:

```bash
npm run bench     # per-policy hit ratio + % of Belady OPT + writes/hit on seeded traces
```

One `LiteCache<K,V>` surface, `get`/`put`/`has`/`peek`/`delete`/`clear`, all O(1), zero allocation on every hot path after construction. `import { Sieve }` alone drops `LiteLru`'s body from your bundle (`sideEffects: false`). Integer keys opt into a strict-zero-alloc typed-array backing.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [LRU vs SIEVE -- which member, and when](#lru-vs-sieve----which-member-and-when)
- [API reference](#api-reference)
  - [The members](#the-members)
  - [Construction options](#construction-options)
  - [The bench tool](#the-bench-tool)
  - [Constants](#constants)
- [Composability](#composability)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Measure & Trust](#measure--trust)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

---

## Why this exists

Two problems no small cache library solves at once:

1. **The policy is the caller's, not the library's.** LRU is the right answer for genuinely unpredictable, recency-skewed, chronically-at-capacity workloads -- the case it was designed for. It is the WRONG answer for a scan (a sequential sweep larger than the cache evicts its own future), and it is overhead for a cache sized at or above its working set (recency order is consulted only on eviction; if you never evict, every move-to-front is wasted work). `lite-lru` treats the policy as a swappable choice: `LiteLru` for recency, `Sieve` for one-hit-wonder-heavy web/CDN traffic, more members to come -- all `class X implements LiteCache<K,V>`, so `new LiteLru(n)` swaps for `new Sieve(n)` and nothing else in your code changes.

2. **"Which policy?" is folklore, not measurement.** Neither incumbent can tell you how close you are to the theoretical best. `lite-lru` ships the measurement tool the family is built around: it replays a trace against every member AND against Belady's OPT -- the clairvoyant offline optimum that evicts the entry whose next use is farthest away -- and reports each policy's hit ratio as a **percentage of optimal**. "SIEVE hit 66.8%" is ambiguous; "SIEVE hit 66.8%, which is 89.8% of the offline optimum on this trace" is actionable.

The honest competitive read: `lru-cache` is already typed-array-backed and feature-maximal (TTL, size-aware, async fetch, dispose); "we are the zero-GC LRU" would be false against it, so that is never the pitch. `lite-lru` wins on a different axis -- a family under one interface, tree-shakeable to a sub-policy for edge/serverless/browser/game budgets, and the shipped measurement tool neither incumbent offers.

---

## What you get

- **`LiteLru`** -- the classic Least-Recently-Used reference member: a `Map` (or a typed-array index for integer keys) fused with an intrusive, preallocated doubly-linked list. `get` and `put` promote to most-recently-used; at capacity a new key evicts the LRU tail. The honest floor every other member is measured against.
- **`Sieve`** -- the modern headline (Zhang et al., NSDI'24, "SIEVE is simpler than LRU"): a lazy-promotion FIFO ring with one visited bit per entry and a single moving hand. A hit sets the bit and does **nothing structural** -- zero relinks -- where classic LRU rewrites a small constant number of links. At capacity the hand sweeps FIFO order, grants each visited entry one second chance, and evicts the first unvisited entry in place.
- **One `LiteCache<K,V>` surface** -- both members expose exactly `get` / `put` / `has` / `peek` / `delete` / `clear`, plus `size` and `capacity`. The recency/lazy-promotion difference is INTERNAL. Types ship in [`Lru.d.ts`](./Lru.d.ts); the interface is the type-checked contract that makes the one-line swap safe.
- **`Bench.mjs`** -- a runnable ESM tool AND an importable module: `runBench(opts)` and `beladyOpt(trace, capacity)`. Feed it a trace, get per-policy hit ratio, writes-per-hit, machine-local ns/op, and percentage of Belady OPT.
- **A `keys: 'int'` backing** -- opt in and the keyed index becomes an open-addressed typed-array table for STRICT zero allocation (even the index never allocates), with a fail-closed door for 32-bit signed integer keys.
- **A zero-GC `onEvict` hook** -- fired once per eviction with the evicted `(key, value)`, e.g. to return the value to a pool.

---

## LRU vs SIEVE -- which member, and when

<details>
<summary>What each member does on a hit and at eviction, and the workload it is for.</summary>

Both members share the exact same surface and the same hit/miss semantics. They differ only in what happens on the hot path and how the victim is chosen.

### `LiteLru` -- classic recency

`get(key)` and `put(key, value)` promote the entry to the most-recently-used end of a doubly-linked list; `has` and `peek` do not touch recency. At capacity, a new key evicts the least-recently-used (tail) entry and reuses its slot in place. This is the right policy when reuse really is governed by recency and the cache is chronically at capacity -- and it is the reference member and the differential oracle every other member is checked against.

The cost is unconditional: every hit relinks the list. Re-hitting the entry that is ALREADY the MRU head early-returns at zero writes; an interior or tail re-hit relinks a small constant. That per-hit work only pays off at an eviction, and only if recency predicts reuse -- so on a cache that rarely evicts, or a predictable pattern, it is net overhead.

### `Sieve` -- lazy-promotion FIFO (the headline)

`get(key)` sets a single visited byte and returns -- no relink, the hand untouched. New entries insert at the head of FIFO order, unvisited. At capacity the hand sweeps from its current position (it persists across evictions): a visited entry gets a second chance (bit cleared, hand advances), and the first unvisited entry is the victim, evicted in place. `has` and `peek` are visited-neutral.

Because a hit does nothing structural and a fresh key enters unvisited, a burst of distinct one-hit-wonder keys sweeps straight back out without displacing the proven-hot set -- SIEVE is scan-resistant where LRU is not, at a fraction of the per-hit writes. It matches or beats LRU on real web/CDN traces. Reach for it on one-hit-wonder-heavy or skewed traffic, and anywhere per-hit GC pressure matters (realtime, game loops).

Pick with the [bench tool](#measure--trust), not by intuition -- the whole point of the family is that this is a measurable choice on YOUR trace.

</details>

---

## API reference

### The members

Both classes implement `LiteCache<K,V>`. Every method is O(1) (amortized on the default `Map` backing; see [construction options](#construction-options)).

```ts
new LiteLru<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)
new Sieve<K, V>(capacity: number, options?: LiteCacheOptions<K, V>)

cache.get(key: K): V | undefined      // returns the value AND applies the member's hit policy
cache.put(key: K, value: V): void     // insert/update; at capacity, evicts the member's victim first
cache.has(key: K): boolean            // presence test; NEVER changes recency / visited state
cache.peek(key: K): V | undefined     // read without applying the hit policy
cache.delete(key: K): boolean         // remove; true if it was present
cache.clear(): void                   // empty the cache; allocates nothing
cache.size: number                    // current entry count, 0 .. capacity (getter)
cache.capacity: number                // fixed maximum, set at construction (getter)
```

- **`capacity`** -- must be an integer `>= 1`. Anything else throws a `[lite-lru]`-tagged `RangeError` at the door (fail-closed -- `null` is not zero).
- **The undefined-value contract (D7).** `get` and `peek` return `V | undefined`, where `undefined` means EITHER "absent" OR "the stored value is literally `undefined`". These are indistinguishable through the return value alone. To disambiguate, call `has(key)`. `null` is a normal, distinguishable value; only `undefined` collides with the miss sentinel.
- **`get` vs `has`/`peek`.** `get` applies the member's hit policy (`LiteLru`: promote to MRU; `Sieve`: set the visited bit). `has` and `peek` never do -- they are the sanctioned way to inspect without perturbing eviction order.

### Construction options

```ts
interface LiteCacheOptions<K, V> {
  onEvict?: (key: K, value: V) => void;
  keys?: "int";
}
```

- **`onEvict(key, value)`** -- called once per eviction with the evicted pair (e.g. to return a value to a pool). Zero-GC: pass a hoisted function, not a fresh closure per construction.
  - **Reentrancy contract (fires LAST, fail-closed).** `onEvict` fires AFTER the cache is fully consistent -- the newcomer already inserted, the victim already gone. It MUST NOT call `put`/`get`/`delete`/`clear` on the same instance; doing so throws a `[lite-lru]`-tagged `Error` rather than corrupting the intrusive lists mid-eviction. `has` and `peek` ARE allowed from within the callback (they cannot mutate) -- use them to inspect.
- **`keys: "int"`** -- opt into the open-addressed typed-array keyed index for STRICT zero allocation (even the index never allocates -- no pre-fill caveat). Keys MUST be 32-bit signed integers in `[-2147483648, 2147483647]`; a non-integer or out-of-range key throws a `[lite-lru]`-tagged `TypeError` (fail-closed). Values remain arbitrary. Omitted, the default is a JS `Map`: arbitrary keys, honestly AMORTIZED (its internal resize can allocate), byte-identical to the pre-`keys` behavior. An unknown `keys` value throws with a did-you-mean hint.

### The bench tool

`Bench.mjs` ships in the tarball as both a runnable and a subpath import. It imports ONLY the cache implementation -- zero runtime deps, no test-only devDeps.

```ts
import { runBench, beladyOpt } from '@zakkster/lite-lru/Bench.mjs';

runBench(opts?): BenchResult
// opts: { capacity?, length?, seed?, workloads?: [{ name, capacity, trace: number[] }] }
// Returns structured per-workload, per-member results (hitRatio, writesPerHit,
// nsPerOp, pctOptimal) plus each workload's OPT. Deterministic for a given seed.
// Pass your own `workloads` to replay YOUR trace.

beladyOpt(trace: number[] | Uint32Array, capacity: number): { hits, misses, hitRate }
// Belady's clairvoyant offline optimum: evict the resident whose NEXT use is
// farthest away. A REFERENCE ORACLE, never a cache policy.
```

Run directly, it prints a table; imported, it returns structured results and prints nothing. See [Measure & Trust](#measure--trust).

### Constants

| Constant  | Value     | Meaning                                                       |
| --------- | --------- | ------------------------------------------------------------ |
| `VERSION` | `'0.1.0'` | Package version string (in lock-step with `package.json` and `llms.txt`). |

Both members and `VERSION` are named exports; `LiteLru` is also the default export.

---

## Composability

The end-to-end "measure, then deploy" loop the family is built for -- pick a policy by replaying a trace, then run that policy in production, all through one interface:

```js
import { LiteLru, Sieve } from '@zakkster/lite-lru';
import { runBench, beladyOpt } from '@zakkster/lite-lru/Bench.mjs';

// 1. Capture (or synthesize) YOUR access trace as an array of integer keys.
const trace = /* e.g. request key per event, in order */ [];

// 2. Measure every candidate policy against Belady OPT on that exact trace.
const opt = beladyOpt(trace, 1024).hits;
const result = runBench({
  workloads: [{ name: 'prod', capacity: 1024, trace }],
});
for (const m of result.workloads[0].members) {
  console.log(`${m.name}: ${(m.hitRatio * 100).toFixed(1)}% ` +
              `(${m.pctOptimal.toFixed(1)}% of OPT), ${m.writesPerHit.toFixed(2)} writes/hit`);
}

// 3. Deploy the winner behind the SAME interface. If SIEVE measured closer to OPT
//    with fewer writes per hit, this is the only line that changes:
const Policy = result.workloads[0].members
  .reduce((a, b) => (b.pctOptimal > a.pctOptimal ? b : a)).name === 'Sieve' ? Sieve : LiteLru;

const cache = new Policy(1024, {
  keys: 'int',                                   // integer keys -> strict zero-alloc backing
  onEvict: (k, v) => pool.release(v),            // hoisted, zero-GC, fires fail-closed
});

// 4. Steady state: O(1), zero allocation on every hot path.
for (const key of liveRequests) {
  let v = cache.get(key);
  if (v === undefined) { v = load(key); cache.put(key, v); }
  use(v);
}
```

The measurement pass and the deployed cache read the same policies from the same file: the number the bench reports is the behavior you ship, by construction.

---

## Zero-GC design notes

<details>
<summary>What the hot path allocates (nothing), and how it stays that way.</summary>

An LRU has a hard capacity ceiling by definition, so all `capacity` slots are preallocated ONCE in the constructor and reused forever. The doubly-linked list is not made of `{}` node objects -- it is a set of parallel arrays indexed by an integer slot: object columns `_keys[]` / `_vals[]` for the payload, and two `Int32Array` link columns `_next[]` / `_prev[]` for the topology. A slot is in exactly one intrusive list at a time (the active recency/FIFO list, or the free stack), both threaded through `_next[]`. Eviction repurposes the evicted slot in place -- no node is ever allocated on `put`, and a freed slot drops its payload refs so the cache never pins a value it no longer owns.

| Operation                          | Steady-state allocations |
| ---------------------------------- | ------------------------ |
| `get` / `put` / `delete` / `has` / `peek` (slot + list layer) | **0** |
| keyed index, `keys: 'int'`         | **0** (open-addressed typed arrays, fixed at construction) |
| keyed index, default `Map`         | amortized (the Map's internal resize can allocate) |
| construction                       | once (all slots + columns, then reused) |

`SIEVE` adds one fixed `Uint8Array` visited column, one byte per slot, allocated once and never grown -- a hit is a single unconditional byte store, no mask or shift.

The torture harness (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`, under `--expose-gc`) commits the zero-GC posture as GATED numbers -- a regression fails as loudly as a leak:

- **No major GC** across the hot loop (`maxMajor: 0`).
- **Pause ceiling** of `maxPauseMs: 4` on the measured window.
- **Retained bytes per call** below `maxBytesPerCall: 1` (under one heap object, above measurement noise).
- **No backing-store growth** (`maxArrayBuffersGrowth: 0`) -- the typed-array columns and the integer index never resize under churn at capacity.

### Writes per hit -- the honest micro-win (measured, not "lock-free")

The literature sells SIEVE on scalability, but that is a multi-core systems argument that does not transfer to single-threaded JS -- there is no lock to avoid. What DOES transfer, and is pinned as a gated number, is **fewer metadata writes per hit** (fewer dirtied cache lines):

| Member    | Hit on the MRU/head | Interior hit | Tail hit | Metadata written |
| --------- | ------------------- | ------------ | -------- | ---------------- |
| `LiteLru` | **0** link writes   | **5** link writes | **4** link writes | intrusive-list relinks |
| `Sieve`   | **0** link writes   | **0** link writes | **0** link writes | exactly **1** visited byte |

A `CountedLru` / `CountedSieve` proxy tallies every index store in the torture gate, so these counts are a regression tripwire, not a claim. This is a real but minor corroborator -- it matters most for GC-pause-sensitive realtime and game loops -- and it is never framed as "lock-free" or as a cross-library throughput win.

</details>

---

## Measure & Trust

Hit ratio and throughput are OUTPUTS of your trace, never headline claims. The bench is how you get them -- for the members AND for Belady's clairvoyant optimum, so you see how much room is actually left:

```bash
npm run bench     # or: node Bench.mjs
```

The default run reports each member on three named, seeded workloads -- `zipf` (skewed popularity), `loop` (a sequential scan larger than the cache), and `scan` (a one-hit-wonder flood over a stable hot set) -- as a fraction of OPT. On the default seeded trace in this repo (capacity 256, 200000 ops, seed `0x9e3779b9`), the deterministic outputs are:

| Workload | Policy    | Hit % | % of OPT | Writes/hit |
| -------- | --------- | ----- | -------- | ---------- |
| `zipf`   | OPT       | 74.4  | 100.0    | -          |
| `zipf`   | `LiteLru` | 57.4  | 77.2     | 4.824      |
| `zipf`   | `Sieve`   | 66.8  | 89.8     | 1.000      |
| `loop`   | OPT       | 24.9  | 100.0    | -          |
| `loop`   | `LiteLru` | 0.0   | 0.0      | 0.000      |
| `loop`   | `Sieve`   | 0.0   | 0.0      | 0.000      |
| `scan`   | OPT       | 49.9  | 100.0    | -          |
| `scan`   | `LiteLru` | 36.0  | 72.1     | 4.967      |
| `scan`   | `Sieve`   | 49.9  | 100.0    | 1.000      |

Hit % and % of OPT are deterministic (seeded trace, deterministic policies); `ns/op` is wall-clock and MACHINE-LOCAL -- the tool prints it with a `node`/`arch` fingerprint, and it is an example only, not a comparable number across machines. These are outputs of these specific traces, not general claims: the `loop` row is exactly why LRU is a floor and not a headline, and the `scan` row is the scan-resistance story as a measurement. Replay YOUR trace by passing `workloads` to `runBench`, and trust the number because the bench drives the same policies the package ships.

---

## Design decisions worth knowing

- **Classic LRU is the reference member, not the headline.** LRU pays its relink cost unconditionally (every hit) but earns its benefit conditionally (only at an eviction, only if recency predicts reuse). On a cache sized at or above its working set, or on a predictable pattern, that benefit goes to zero while the cost remains -- so LRU is the honest floor and the differential oracle, and lazy-promotion policies like SIEVE are the members. The bench + OPT let you discover which regime you are in.
- **One file, named exports -- NOT a subpath per policy.** A single `Lru.js` exports every member; `sideEffects: false` + ESM named imports mean `import { Sieve }` drops `LiteLru`'s body from your bundle. The shared substrate is internal, never a second package. `Bench.mjs` is a separate runnable tool, deliberately NOT a `bin` and NOT a second implementation.
- **A shared substrate, chosen once at construction.** The keyed index, the SoA slot columns, and the free stack are factored into an internal `SlotStore` both members compose. The backing (default `Map`, or the `keys: 'int'` typed-array index) is chosen once so each hot path is monomorphic -- no per-op branch on backing type.
- **Integer keys get a strict-zero-alloc index with no tombstones.** `keys: 'int'` is open-addressed with linear probing and backward-shift deletion, a fixed table (load factor <= 0.75) sized once at construction, never resized. A Fibonacci hash mix (`Math.imul(key, 0x9e3779b1)`) keeps sequential keys from clustering. The accepted domain is validated at the door.
- **`onEvict` fires LAST and fails closed.** Firing after the cache is fully consistent, plus a reentrancy guard that rejects mutation from within the callback, prevents evict -> put -> evict recursion and mid-surgery corruption. `has`/`peek` stay open inside the callback.
- **Belady OPT lives strictly offline.** OPT is clairvoyant -- it peers into the future of the trace -- so it can never be a production policy and lives only in `Bench.mjs`. Its practical heap implementation is differential-tested against a brute-force O(N*C) OPT in the torture gate, because every "% of optimal" figure depends on it being exactly right.
- **Fail closed, name the value.** A bad capacity, an unknown `keys` value, or an out-of-range integer key all throw a `[lite-lru]`-tagged error at the door; `null` is never coerced to zero.

---

## Testing

**143 deterministic tests, all pass**, plus a torture gate that proves both leak-freedom and the zero-GC quality numbers, and a shipped bench.

```bash
npm test               # 143 node:test cases (both members, laws, boundary, dts drift)
npm run test:types     # tsc: the LiteCache<K,V> surface + one-line-swap type-check
npm run torture        # @zakkster/lite-leak + lite-gc-profiler: 0 B/op + gated numbers
npm run torture:controls  # the deliberately-broken variants -- every gate must fail
npm run bench          # per-policy hit ratio + % of Belady OPT + writes/hit
npm run verify         # test + test:types + torture + controls, the publish gate
```

The torture suite runs tiers strictly sequentially: `t0` recency/policy laws, `t1` degenerate keys/values (the D7 undefined-value case included), `t2` adversarial sequences + the conservation invariant, `t5` differential fuzz of both members (on the default AND `keys: 'int'` backings) against independent brute-force oracles, `t6` the zero-alloc gate + the writes-per-hit counter, `t7` a ~4096-cycle soak with a WeakRef reachability census, `t8` the Belady OPT gate (the shipped `beladyOpt` differential-tested against a brute-force OPT, plus the optimality bound `optHits >= memberHits` for both members on every trace), and `t9` the controls -- each gate driven by a deliberately-broken variant that MUST fail, so no gate is decorative. `test/` and `decisions/` never enter the tarball (`npm pack --dry-run` proves it). No gate output is a FAIL.

---

## What this is not

- **Not "the zero-GC LRU."** `lru-cache` is already typed-array-backed; that is not the moat and is never the claim. The moat is the family + the interface + the measurement tool.
- **Not feature parity with `lru-cache`.** No TTL, size/cost-aware capacity, async `fetchMethod`, or `dispose` in the core today. TTL and zero-GC iteration are on the roadmap as opt-in, pay-for-what-you-use columns; async fetch and size-aware capacity change the model and belong in separate packages, not this hot core.
- **Not a growable cache.** Capacity is fixed and load-bearing -- there is no growth path. An LRU never exceeds capacity, so there is nothing to grow.
- **Not lock-free or multi-core.** This is single-threaded zero-GC JavaScript; there is no lock to avoid. The measured win is fewer writes per hit, not scalability.
- **Not a concurrency primitive.** No atomics, no cross-worker synchronization. Coordinate shared access yourself.
- **Not clairvoyant in production.** Belady OPT is an offline reference oracle only; it never ships as a policy.

---

## Ecosystem

Part of the **@zakkster** zero-GC stack:

- [`lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal) -- zero-GC reactive graph for hot paths
- [`lite-binary-reader`](https://www.npmjs.com/package/@zakkster/lite-binary-reader) -- zero-GC reader for raw / foreign binary buffers
- [`lite-sepforge`](https://www.npmjs.com/package/@zakkster/lite-sepforge) -- zero-GC halftone and color-separation kernels
- **`lite-lru`** -- this package

---

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
