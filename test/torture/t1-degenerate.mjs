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

import { LiteLru } from '../../Lru.js';
import { check, validate } from './harness.mjs';

export function run() {
    // --- SameValueZero key collapse: 0 and -0 are ONE key -----------------------
    {
        const c = new LiteLru(4);
        c.put(0, 'zero');
        c.put(-0, 'neg-zero'); // must overwrite the SAME slot, not add a second
        check(c.size === 1, () => 't1: 0 and -0 did not collapse to one key (size ' + c.size + ')');
        check(c.get(0) === 'neg-zero', () => 't1: -0 did not overwrite 0');
        check(c.get(-0) === 'neg-zero', () => 't1: get(-0) missed the shared slot');
        validate(c);
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
    }
}
