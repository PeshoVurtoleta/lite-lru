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
import LiteLru, { VERSION, Sieve, S3Fifo, WTinyLfu } from "../../Lru.js";
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
