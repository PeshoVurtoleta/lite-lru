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
import LiteLru, { VERSION } from "../../Lru.js";
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
