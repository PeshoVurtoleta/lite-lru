/**
 * t1 -- degenerate keys and values. Each answer is PINNED as contract.
 *
 * Keys: 0, -0, NaN (SameValueZero -> one key), "", undefined, null, object
 * identity, a long string. Values: undefined, null, 0, NaN, object.
 *
 * The load-bearing case is D7: a stored `undefined` VALUE is indistinguishable
 * from a miss via get(); has() disambiguates; peek() returns undefined for both.
 * These are contract, not accident -- pinned so a refactor cannot drift them.
 */

import { LiteLru, Sieve, S3Fifo, WTinyLfu, Arc } from '../../Lru.js';
import { check, validate } from './harness.mjs';

export function run() {
    let units = 0; // work units: degenerate-key/value scenarios validated
    // --- SameValueZero key collapse: 0 and -0 are ONE key -----------------------
    {
        const c = new LiteLru(4);
        c.put(0, 'zero');
        c.put(-0, 'neg-zero'); // must overwrite the SAME slot, not add a second
        check(c.size === 1, () => 't1: 0 and -0 did not collapse to one key (size ' + c.size + ')');
        check(c.get(0) === 'neg-zero', () => 't1: -0 did not overwrite 0');
        check(c.get(-0) === 'neg-zero', () => 't1: get(-0) missed the shared slot');
        validate(c);
        units++;
    }

    // --- NaN is a single usable key (SameValueZero: NaN matches NaN) -------------
    {
        const c = new LiteLru(4);
        c.put(NaN, 'nan1');
        c.put(NaN, 'nan2'); // same key
        check(c.size === 1, () => 't1: NaN did not behave as a single key (size ' + c.size + ')');
        check(c.get(NaN) === 'nan2', () => 't1: get(NaN) did not return the latest value');
        check(c.has(NaN) === true, () => 't1: has(NaN) false');
        validate(c);
        units++;
    }

    // --- empty string, null, undefined as DISTINCT keys -------------------------
    {
        const c = new LiteLru(8);
        c.put('', 'empty');
        c.put(null, 'null-key');
        c.put(undefined, 'undef-key');
        check(c.size === 3, () => 't1: "" / null / undefined did not stay distinct (size ' + c.size + ')');
        check(c.get('') === 'empty', () => 't1: "" key lost');
        check(c.get(null) === 'null-key', () => 't1: null key lost');
        check(c.get(undefined) === 'undef-key', () => 't1: undefined key lost');
        check(c.has(null) === true && c.has(undefined) === true, () => 't1: has() missed null/undefined key');
        validate(c);
        units++;
    }

    // --- object identity keys + a long string key -------------------------------
    {
        const c = new LiteLru(4);
        const o1 = { id: 1 };
        const o2 = { id: 1 }; // structurally equal but a DIFFERENT identity
        const longKey = 'x'.repeat(4096);
        c.put(o1, 'first');
        c.put(o2, 'second');
        c.put(longKey, 'long');
        check(c.size === 3, () => 't1: object-identity keys collapsed (size ' + c.size + ')');
        check(c.get(o1) === 'first', () => 't1: o1 identity key lost');
        check(c.get(o2) === 'second', () => 't1: o2 identity key lost');
        check(c.get(longKey) === 'long', () => 't1: long string key lost');
        validate(c);
        units++;
    }

    // --- D7: a stored `undefined` VALUE -- pin every answer ---------------------
    {
        const c = new LiteLru(4);
        c.put('k', undefined);
        // get() cannot distinguish a stored-undefined from a miss:
        check(c.get('k') === undefined, () => 't1 D7: get(stored-undefined) !== undefined');
        check(c.get('absent') === undefined, () => 't1 D7: get(miss) !== undefined');
        // has() DISAMBIGUATES:
        check(c.has('k') === true, () => 't1 D7: has(stored-undefined) must be true');
        check(c.has('absent') === false, () => 't1 D7: has(miss) must be false');
        // peek() returns undefined for BOTH (no disambiguation via peek):
        check(c.peek('k') === undefined, () => 't1 D7: peek(stored-undefined) !== undefined');
        check(c.peek('absent') === undefined, () => 't1 D7: peek(miss) !== undefined');
        validate(c);
        units++;
    }

    // --- other degenerate VALUES round-trip exactly -----------------------------
    {
        const c = new LiteLru(8);
        const obj = { a: 1 };
        c.put('null', null);
        c.put('zero', 0);
        c.put('nan', NaN);
        c.put('obj', obj);
        check(c.get('null') === null, () => 't1: null value not preserved');
        check(c.get('zero') === 0, () => 't1: 0 value not preserved');
        check(Number.isNaN(c.get('nan')), () => 't1: NaN value not preserved');
        check(c.get('obj') === obj, () => 't1: object value identity not preserved');
        // has() is true for all of them even where the value is falsy:
        check(c.has('null') && c.has('zero') && c.has('nan') && c.has('obj'),
            () => 't1: has() false on a present falsy value');
        validate(c);
        units++;
    }

    // --- Arc degenerate keys + values (decisions/0016) --------------------------
    // The same degenerate matrix as the LiteLru cases above, but through the adaptive
    // member: SameValueZero key collapse, distinct primitive keys, object identity, the
    // D7 stored-undefined ambiguity, and falsy values round-tripping -- all with the two
    // ghosts + `p` present. validate() nets each mutation.
    {
        const c = new Arc(4);
        c.put(0, 'zero'); c.put(-0, 'neg-zero'); // SameValueZero: one key
        check(c.size === 1 && c.get(0) === 'neg-zero', () => 't1 arc: 0/-0 did not collapse');
        c.put(NaN, 'nan1'); c.put(NaN, 'nan2');   // NaN is a single key
        check(c.get(NaN) === 'nan2', () => 't1 arc: NaN not a single usable key');
        validate(c);

        const d = new Arc(8);
        d.put('', 'empty'); d.put(null, 'null-key'); d.put(undefined, 'undef-key');
        check(d.size === 3, () => 't1 arc: "" / null / undefined not distinct');
        check(d.get(null) === 'null-key' && d.get(undefined) === 'undef-key', () => 't1 arc: null/undefined key lost');
        const o1 = { id: 1 }, o2 = { id: 1 };
        d.put(o1, 'first'); d.put(o2, 'second');
        check(d.get(o1) === 'first' && d.get(o2) === 'second', () => 't1 arc: object identity keys collapsed');
        validate(d);

        // D7: a stored `undefined` value is indistinguishable from a miss via get(); has()
        // disambiguates; peek() returns undefined for both.
        const e = new Arc(4);
        e.put('k', undefined);
        check(e.get('k') === undefined && e.get('absent') === undefined, () => 't1 arc D7: get ambiguity broken');
        check(e.has('k') === true && e.has('absent') === false, () => 't1 arc D7: has() did not disambiguate');
        check(e.peek('k') === undefined, () => 't1 arc D7: peek(stored-undefined) != undefined');
        // Falsy values round-trip exactly.
        e.put('null', null); e.put('zero', 0); e.put('nan', NaN);
        check(e.get('null') === null && e.get('zero') === 0 && Number.isNaN(e.get('nan')), () => 't1 arc: falsy value not preserved');
        validate(e);
        units += 3; // arc: key-collapse + distinct-keys + D7/falsy scenarios
    }

    // --- TTL fail-closed validation (decisions/0017, D17.2/D17.4) ----------------
    // Bad ttl / ttlMs / clock are caller bugs, thrown at the door. Pinned across ALL
    // four members so the shared door stays uniform.
    {
        const members = [['LiteLru', LiteLru], ['Sieve', Sieve], ['S3Fifo', S3Fifo], ['WTinyLfu', WTinyLfu], ['Arc', Arc]];
        const bad = (fn, why) => {
            let threw = false;
            try { fn(); } catch (e) { threw = /^\[lite-lru\]/.test(e.message); }
            check(threw, why);
        };
        for (const [name, C] of members) {
            // ttl default: <= 0, NaN, non-number all throw; Infinity + positive are fine.
            bad(() => new C(4, { ttl: 0 }), () => 't1 TTL: ' + name + ' ttl 0 did not throw');
            bad(() => new C(4, { ttl: -1 }), () => 't1 TTL: ' + name + ' ttl -1 did not throw');
            bad(() => new C(4, { ttl: NaN }), () => 't1 TTL: ' + name + ' ttl NaN did not throw');
            bad(() => new C(4, { ttl: '5' }), () => 't1 TTL: ' + name + ' ttl "5" did not throw');
            new C(4, { ttl: Infinity }); // never-expire default: valid
            new C(4, { ttl: 10 });       // positive default: valid
            // clock: non-function throws; a function is fine.
            bad(() => new C(4, { ttl: 10, clock: 123 }), () => 't1 TTL: ' + name + ' non-fn clock did not throw');
            new C(4, { ttl: 10, clock: () => 0 });
            // per-put ttlMs on a NON-ttl instance throws (no _exp column to stamp).
            bad(() => { const c = new C(4); c.put('k', 1, 5); },
                () => 't1 TTL: ' + name + ' ttlMs on a non-ttl instance did not throw');
            // per-put ttlMs bad value throws on a ttl instance.
            bad(() => { const c = new C(4, { ttl: 10 }); c.put('k', 1, 0); },
                () => 't1 TTL: ' + name + ' ttlMs 0 did not throw');
            bad(() => { const c = new C(4, { ttl: 10 }); c.put('k', 1, -3); },
                () => 't1 TTL: ' + name + ' ttlMs -3 did not throw');
            bad(() => { const c = new C(4, { ttl: 10 }); c.put('k', 1, NaN); },
                () => 't1 TTL: ' + name + ' ttlMs NaN did not throw');
            // a valid per-put ttlMs + Infinity are accepted.
            { const c = new C(4, { ttl: 10 }); c.put('k', 1, 5); c.put('n', 2, Infinity); validate(c); }
            units++; // one member's full TTL fail-closed matrix proven
        }
    }

    // --- D7 under TTL: a stale entry storing `undefined` (decisions/0017) --------
    // D7 says a stored `undefined` is indistinguishable from a miss via get(); once the
    // entry goes STALE it becomes a genuine miss for get/has/peek alike (reaped).
    {
        let now = 0; const clock = () => now;
        const c = new LiteLru(4, { ttl: 5, clock });
        c.put('u', undefined);
        check(c.get('u') === undefined, () => 't1 D7-TTL: fresh stored-undefined get != undefined');
        check(c.has('u') === true, () => 't1 D7-TTL: fresh stored-undefined has must be true');
        now = 6; // stale now
        check(c.get('u') === undefined, () => 't1 D7-TTL: stale get != undefined');
        check(c.has('u') === false, () => 't1 D7-TTL: stale has must be false (reaped)');
        check(c.peek('u') === undefined, () => 't1 D7-TTL: stale peek != undefined');
        check(c.size === 0, () => 't1 D7-TTL: stale entry not reaped (size ' + c.size + ')');
        validate(c);
        units++;
    }

    return units;
}
