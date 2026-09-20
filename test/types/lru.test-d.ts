/**
 * @zakkster/lite-lru -- type-level surface gate (compiled by `tsc --noEmit`,
 * never run). This file is the TEETH for Lru.d.ts: it asserts the generic surface
 * is present and correct AND proves moat-pillar 1 -- that `LiteLru` SATISFIES the
 * uniform `LiteCache` interface, so a caller can swap one member for another.
 *
 * Teeth two ways: exact `Equal<>` checks fail if a signature drifts, and
 * `@ts-expect-error` directives FAIL the build if the expected compile error
 * stops happening (tsc flags an unused directive). Test-only; not in files[].
 * ASCII-only.
 */
import LiteLru, { VERSION, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, DirectLru } from "../../Lru.js";
import type { LiteCache, LiteCacheOptions } from "../../Lru.js";

// A type-equality check with teeth (identity holds only for exact-equal types).
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
declare function expectTrue<_T extends true>(): void;

// ---- get() return type: V | undefined (the D7 miss/undefined ambiguity) -----
const c = new LiteLru<string, number>(10);
const got = c.get("a");
expectTrue<Equal<typeof got, number | undefined>>();
const peeked = c.peek("a");
expectTrue<Equal<typeof peeked, number | undefined>>();
expectTrue<Equal<ReturnType<typeof c.has>, boolean>>();
expectTrue<Equal<ReturnType<typeof c.delete>, boolean>>();
expectTrue<Equal<typeof c.size, number>>();
expectTrue<Equal<typeof c.capacity, number>>();

// ---- VERSION is a string ----------------------------------------------------
expectTrue<Equal<typeof VERSION, string>>();

// ---- moat-pillar 1: LiteLru SATISFIES LiteCache (the one-line policy swap) ---
// A future member (`new Sieve(10)`) will type-check into the SAME binding.
const iface: LiteCache<string, number> = new LiteLru<string, number>(10);
iface.put("k", 1);
const ifaceGot = iface.get("k");
expectTrue<Equal<typeof ifaceGot, number | undefined>>();

// ---- onEvict params are typed from <K, V> -----------------------------------
new LiteLru<string, number>(10, {
  onEvict: (k, v) => {
    const _k: string = k;
    const _v: number = v;
    void _k;
    void _v;
  },
});

// LiteCacheOptions is the shared, generic options shape.
const opts: LiteCacheOptions<string, number> = { onEvict: (_k, _v) => {} };
void opts;

// ---- keys:'int' opt-in backing (decisions/0011) -----------------------------
new LiteLru<number, number>(10, { keys: "int" });
const intOpts: LiteCacheOptions<number, number> = { keys: "int" };
void intOpts;

// ---- negative checks (teeth: these MUST NOT compile) ------------------------

// @ts-expect-error -- V is number; a string value is rejected.
c.put("a", "not-a-number");

// @ts-expect-error -- onEvict value param is number; assigning it to string fails.
new LiteLru<string, number>(10, { onEvict: (_k, v) => { const s: string = v; void s; } });

// @ts-expect-error -- capacity is required and must be a number.
new LiteLru<string, number>("10");

// @ts-expect-error -- size is readonly.
c.size = 5;

// @ts-expect-error -- 'float' is not a valid keys backing (only 'int').
new LiteLru<number, number>(10, { keys: "float" });

// ---- Sieve: the second family member SATISFIES the SAME LiteCache surface ----
// (decisions/0012) The one-line policy swap: `new Sieve(n)` type-checks into the
// SAME `LiteCache` binding as `new LiteLru(n)`.
const sv = new Sieve<string, number>(10);
const svGot = sv.get("a");
expectTrue<Equal<typeof svGot, number | undefined>>();
expectTrue<Equal<ReturnType<typeof sv.has>, boolean>>();
expectTrue<Equal<ReturnType<typeof sv.delete>, boolean>>();
expectTrue<Equal<typeof sv.size, number>>();
expectTrue<Equal<typeof sv.capacity, number>>();

const svIface: LiteCache<string, number> = new Sieve<string, number>(10);
svIface.put("k", 1);
const svIfaceGot = svIface.get("k");
expectTrue<Equal<typeof svIfaceGot, number | undefined>>();

// keys:'int' opt-in backing applies identically to Sieve.
new Sieve<number, number>(10, { keys: "int" });

// onEvict params are typed from <K, V> on Sieve too.
new Sieve<string, number>(10, {
  onEvict: (k, v) => {
    const _k: string = k;
    const _v: number = v;
    void _k;
    void _v;
  },
});

// @ts-expect-error -- V is number; a string value is rejected on Sieve too.
sv.put("a", "not-a-number");

// @ts-expect-error -- 'lru' is not a valid keys backing (only 'int').
new Sieve<number, number>(10, { keys: "lru" });

// @ts-expect-error -- size is readonly on Sieve.
sv.size = 5;

// ---- S3Fifo: the third family member SATISFIES the SAME LiteCache surface -----
// (decisions/0013) The one-line policy swap: `new S3Fifo(n)` type-checks into the
// SAME `LiteCache` binding as `new LiteLru(n)` / `new Sieve(n)`.
const s3 = new S3Fifo<string, number>(10);
const s3Got = s3.get("a");
expectTrue<Equal<typeof s3Got, number | undefined>>();
expectTrue<Equal<ReturnType<typeof s3.has>, boolean>>();
expectTrue<Equal<ReturnType<typeof s3.delete>, boolean>>();
expectTrue<Equal<typeof s3.size, number>>();
expectTrue<Equal<typeof s3.capacity, number>>();

const s3Iface: LiteCache<string, number> = new S3Fifo<string, number>(10);
s3Iface.put("k", 1);
const s3IfaceGot = s3Iface.get("k");
expectTrue<Equal<typeof s3IfaceGot, number | undefined>>();

// keys:'int' opt-in backing applies identically to S3Fifo.
new S3Fifo<number, number>(10, { keys: "int" });

// onEvict params are typed from <K, V> on S3Fifo too.
new S3Fifo<string, number>(10, {
  onEvict: (k, v) => {
    const _k: string = k;
    const _v: number = v;
    void _k;
    void _v;
  },
});

// @ts-expect-error -- V is number; a string value is rejected on S3Fifo too.
s3.put("a", "not-a-number");

// @ts-expect-error -- 'fifo' is not a valid keys backing (only 'int').
new S3Fifo<number, number>(10, { keys: "fifo" });

// @ts-expect-error -- size is readonly on S3Fifo.
s3.size = 5;

// ---- WTinyLfu: the fourth family member SATISFIES the SAME LiteCache surface --
// (decisions/0014) The one-line policy swap: `new WTinyLfu(n)` type-checks into the
// SAME `LiteCache` binding as `new LiteLru(n)` / `new Sieve(n)` / `new S3Fifo(n)`.
const wt = new WTinyLfu<string, number>(10);
const wtGot = wt.get("a");
expectTrue<Equal<typeof wtGot, number | undefined>>();
expectTrue<Equal<ReturnType<typeof wt.has>, boolean>>();
expectTrue<Equal<ReturnType<typeof wt.delete>, boolean>>();
expectTrue<Equal<typeof wt.size, number>>();
expectTrue<Equal<typeof wt.capacity, number>>();

const wtIface: LiteCache<string, number> = new WTinyLfu<string, number>(10);
wtIface.put("k", 1);
const wtIfaceGot = wtIface.get("k");
expectTrue<Equal<typeof wtIfaceGot, number | undefined>>();

// keys:'int' opt-in backing applies identically to WTinyLfu.
new WTinyLfu<number, number>(10, { keys: "int" });

// onEvict params are typed from <K, V> on WTinyLfu too.
new WTinyLfu<string, number>(10, {
  onEvict: (k, v) => {
    const _k: string = k;
    const _v: number = v;
    void _k;
    void _v;
  },
});

// @ts-expect-error -- V is number; a string value is rejected on WTinyLfu too.
wt.put("a", "not-a-number");

// @ts-expect-error -- 'lfu' is not a valid keys backing (only 'int').
new WTinyLfu<number, number>(10, { keys: "lfu" });

// @ts-expect-error -- size is readonly on WTinyLfu.
wt.size = 5;

// ---- TTL surface (decisions/0017) -------------------------------------------
// `ttl` + `clock` options, the positional `put(k, v, ttlMs?)`, and `purgeStale()`
// are part of the SAME uniform LiteCache surface every member satisfies.
const ttlLru = new LiteLru<number, number>(10, { ttl: 1000, clock: () => Date.now() });
ttlLru.put(1, 1);            // default ttl
ttlLru.put(2, 2, 500);       // per-put override (positional ttlMs)
ttlLru.put(3, 3, Infinity);  // never-expire
expectTrue<Equal<ReturnType<typeof ttlLru.purgeStale>, number>>();

// purgeStale + the ttl put arity flow through the LiteCache binding (the swap holds).
const ttlIface: LiteCache<number, number> = new LiteLru<number, number>(10, { ttl: 1000 });
ttlIface.put(1, 1, 5);
expectTrue<Equal<ReturnType<typeof ttlIface.purgeStale>, number>>();

// TTL options are part of the shared, generic options shape.
const ttlOpts: LiteCacheOptions<number, number> = { ttl: 1000, clock: () => 0 };
void ttlOpts;

// The same ttl surface on the other three members (swap into LiteCache too).
const svTtl: LiteCache<number, number> = new Sieve<number, number>(10, { ttl: 5 });
svTtl.put(1, 1, 5);
const s3Ttl: LiteCache<number, number> = new S3Fifo<number, number>(10, { ttl: 5 });
s3Ttl.put(1, 1, Infinity);
const wtTtl: LiteCache<number, number> = new WTinyLfu<number, number>(10, { ttl: 5 });
expectTrue<Equal<ReturnType<typeof wtTtl.purgeStale>, number>>();

// @ts-expect-error -- ttl must be a number.
new LiteLru<number, number>(10, { ttl: "1000" });

// @ts-expect-error -- clock must be a zero-arg function returning number.
new LiteLru<number, number>(10, { ttl: 10, clock: 5 });

// @ts-expect-error -- the positional ttlMs must be a number.
ttlLru.put(4, 4, "500");

// ---- Slru: the fifth family member SATISFIES the SAME LiteCache surface -------
// (decisions/0015) The one-line policy swap: `new Slru(n)` type-checks into the SAME
// `LiteCache` binding as every other member.
const sl = new Slru<string, number>(10);
const slGot = sl.get("a");
expectTrue<Equal<typeof slGot, number | undefined>>();
expectTrue<Equal<ReturnType<typeof sl.has>, boolean>>();
expectTrue<Equal<typeof sl.capacity, number>>();
const slIface: LiteCache<string, number> = new Slru<string, number>(10);
slIface.put("k", 1);
new Slru<number, number>(10, { keys: "int" });
const slTtl: LiteCache<number, number> = new Slru<number, number>(10, { ttl: 5 });
slTtl.put(1, 1, Infinity);

// @ts-expect-error -- V is number; a string value is rejected on Slru too.
sl.put("a", "not-a-number");

// @ts-expect-error -- size is readonly on Slru.
sl.size = 5;

// ---- TwoQ: the sixth family member SATISFIES the SAME LiteCache surface -------
// (decisions/0015) The one-line policy swap: `new TwoQ(n)` type-checks into the SAME
// `LiteCache` binding as every other member.
const tq = new TwoQ<string, number>(10);
const tqGot = tq.get("a");
expectTrue<Equal<typeof tqGot, number | undefined>>();
expectTrue<Equal<ReturnType<typeof tq.has>, boolean>>();
expectTrue<Equal<typeof tq.capacity, number>>();
const tqIface: LiteCache<string, number> = new TwoQ<string, number>(10);
tqIface.put("k", 1);
new TwoQ<number, number>(10, { keys: "int" });
const tqTtl: LiteCache<number, number> = new TwoQ<number, number>(10, { ttl: 5 });
expectTrue<Equal<ReturnType<typeof tqTtl.purgeStale>, number>>();

// @ts-expect-error -- V is number; a string value is rejected on TwoQ too.
tq.put("a", "not-a-number");

// @ts-expect-error -- 'q' is not a valid keys backing (only 'int').
new TwoQ<number, number>(10, { keys: "q" });

// @ts-expect-error -- size is readonly on TwoQ.
tq.size = 5;

// ---- Arc: the seventh family member SATISFIES the SAME LiteCache surface -------
// (decisions/0016) The one-line policy swap: `new Arc(n)` type-checks into the SAME
// `LiteCache` binding as every other member.
const ar = new Arc<string, number>(10);
const arGot = ar.get("a");
expectTrue<Equal<typeof arGot, number | undefined>>();
expectTrue<Equal<ReturnType<typeof ar.has>, boolean>>();
expectTrue<Equal<typeof ar.capacity, number>>();
const arIface: LiteCache<string, number> = new Arc<string, number>(10);
arIface.put("k", 1);
new Arc<number, number>(10, { keys: "int" });
const arTtl: LiteCache<number, number> = new Arc<number, number>(10, { ttl: 5 });
expectTrue<Equal<ReturnType<typeof arTtl.purgeStale>, number>>();

// @ts-expect-error -- V is number; a string value is rejected on Arc too.
ar.put("a", "not-a-number");

// @ts-expect-error -- 'q' is not a valid keys backing (only 'int').
new Arc<number, number>(10, { keys: "q" });

// @ts-expect-error -- size is readonly on Arc.
ar.size = 5;

// ---- Lirs: the eighth family member SATISFIES the SAME LiteCache surface -------
// (decisions/0023) The one-line policy swap: `new Lirs(n)` type-checks into the SAME
// `LiteCache` binding as every other member.
const li = new Lirs<string, number>(10);
const liGot = li.get("a");
expectTrue<Equal<typeof liGot, number | undefined>>();
expectTrue<Equal<ReturnType<typeof li.has>, boolean>>();
expectTrue<Equal<typeof li.capacity, number>>();
const liIface: LiteCache<string, number> = new Lirs<string, number>(10);
liIface.put("k", 1);
new Lirs<number, number>(10, { keys: "int" });
const liTtl: LiteCache<number, number> = new Lirs<number, number>(10, { ttl: 5 });
expectTrue<Equal<ReturnType<typeof liTtl.purgeStale>, number>>();

// @ts-expect-error -- V is number; a string value is rejected on Lirs too.
li.put("a", "not-a-number");

// @ts-expect-error -- 'lir' is not a valid keys backing (only 'int').
new Lirs<number, number>(10, { keys: "lir" });

// @ts-expect-error -- size is readonly on Lirs.
li.size = 5;

// ---- Lfu: the ninth family member SATISFIES the SAME LiteCache surface ---------
// (decisions/0024) The one-line policy swap: `new Lfu(n)` type-checks into the SAME
// `LiteCache` binding as every other member.
const lf = new Lfu<string, number>(10);
const lfGot = lf.get("a");
expectTrue<Equal<typeof lfGot, number | undefined>>();
expectTrue<Equal<ReturnType<typeof lf.has>, boolean>>();
expectTrue<Equal<typeof lf.capacity, number>>();
const lfIface: LiteCache<string, number> = new Lfu<string, number>(10);
lfIface.put("k", 1);
new Lfu<number, number>(10, { keys: "int" });
const lfTtl: LiteCache<number, number> = new Lfu<number, number>(10, { ttl: 5 });
expectTrue<Equal<ReturnType<typeof lfTtl.purgeStale>, number>>();

// @ts-expect-error -- V is number; a string value is rejected on Lfu too.
lf.put("a", "not-a-number");

// @ts-expect-error -- 'lfu' is not a valid keys backing (only 'int').
new Lfu<number, number>(10, { keys: "lfu" });

// @ts-expect-error -- size is readonly on Lfu.
lf.size = 5;

// ---- keys:'dense' backing + maxKey (decisions/0029) --------------------------
new LiteLru<number, number>(10, { keys: "dense", maxKey: 1023 });
const denseOpts: LiteCacheOptions<number, number> = { keys: "dense", maxKey: 64 };
void denseOpts;

// @ts-expect-error -- maxKey must be a number.
new LiteLru<number, number>(10, { keys: "dense", maxKey: "1023" });

// ---- DirectLru: LiteLru pinned to the dense backing SATISFIES LiteCache -------
// (decisions/0029) The one-line policy swap: `new DirectLru(n, { maxKey })` is a
// LiteLru and type-checks into the SAME `LiteCache` binding as every other member.
const dl = new DirectLru<number, number>(10, { maxKey: 255 });
const dlGot = dl.get(1);
expectTrue<Equal<typeof dlGot, number | undefined>>();
expectTrue<Equal<ReturnType<typeof dl.has>, boolean>>();
expectTrue<Equal<typeof dl.capacity, number>>();
const dlIface: LiteCache<number, number> = new DirectLru<number, number>(10, { maxKey: 255 });
dlIface.put(1, 1);
const dlTtl = new DirectLru<number, number>(10, { maxKey: 255, ttl: 5 });
expectTrue<Equal<ReturnType<typeof dlTtl.purgeStale>, number>>();

// @ts-expect-error -- maxKey is required on DirectLru.
new DirectLru<number, number>(10);

// @ts-expect-error -- V is number; a string value is rejected on DirectLru too.
dl.put(1, "not-a-number");

// @ts-expect-error -- size is readonly on DirectLru.
dl.size = 5;
