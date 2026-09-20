/**
 * @zakkster/lite-lru -- node:test boundary suite closing the QA gap left by 1.16.0
 * (eef6bbd): the fail-closed constructor doors (`validateOptions`/`validateOnEvict`,
 * decisions/0019 area) were verified by code-reading only. The +20 tests that shipped
 * with 1.16.0 were CAR/ClockPro victim-ORDER suites, not door regression tests, and
 * only LiteLru + Sieve had a "the door is family-wide" pin (test/Lru.test.js). This
 * file PARAMETERIZES the same doors over the full 13-member family so a refactor of
 * the shared helpers cannot silently regress one member while the reference member
 * still passes.
 *
 * Deliberately test-only: no Lru.js / benchmark/Bench.mjs edits. ASCII-only; every
 * potentially-Symbol/BigInt test value is turned to text with `String()`, never a
 * template literal or `+` concatenation (the family's own recurring footgun class).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu, ClockPro, LruK, Mq, Car,
} from '../Lru.js';

/** All 13 family members, in the same order `runBench` reports them (Bench.test.js). */
const MEMBERS = [
    ['LiteLru', LiteLru], ['Sieve', Sieve], ['S3Fifo', S3Fifo], ['WTinyLfu', WTinyLfu],
    ['Slru', Slru], ['TwoQ', TwoQ], ['Arc', Arc], ['Lirs', Lirs], ['Lfu', Lfu],
    ['ClockPro', ClockPro], ['LruK', LruK], ['Mq', Mq], ['Car', Car],
];

const KNOWN_KEYS = ['onEvict', 'keys', 'ttl', 'clock', 'stats', 'maxKey'];

/* ============================================================================ *
 * TASK 1 -- unknown option key: did-you-mean hint (near-miss) + the full valid
 * set (no near miss). Parameterized over all 13 members.
 * ============================================================================ */

for (const [name, Cls] of MEMBERS) {
    test(name + ': unknown option "onEvcit" (near-miss of onEvict) throws [lite-lru] naming the ' +
        'bad key and suggesting onEvict', () => {
        assert.throws(() => new Cls(4, { onEvcit: () => {} }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /onEvcit/);
            assert.match(err.message, /did you mean onEvict/);
            return true;
        });
    });

    test(name + ': unknown option "keyz" (near-miss of keys) suggests keys', () => {
        assert.throws(() => new Cls(4, { keyz: 'int' }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /keyz/);
            assert.match(err.message, /did you mean keys/);
            return true;
        });
    });

    test(name + ': unknown option "kys" (a weaker 1-char-prefix near-miss of keys) still suggests keys, ' +
        'not any other known key', () => {
        assert.throws(() => new Cls(4, { kys: 'int' }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /did you mean keys/);
            return true;
        });
    });

    test(name + ': a totally-unknown option "zzzzzz" (no near match) lists every valid key, not a single guess', () => {
        assert.throws(() => new Cls(4, { zzzzzz: 1 }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /zzzzzz/);
            for (const k of KNOWN_KEYS) {
                assert.ok(err.message.includes(k), name + ': message missing valid key "' + k + '" -- ' + err.message);
            }
            return true;
        });
    });
}

/* ============================================================================ *
 * TASK 2 -- non-object options bag: 42, "opts", null must ALL throw "must be an
 * object" (null is NOT "no options" -- fail closed, not silently ignored).
 * Parameterized over all 13 members.
 * ============================================================================ */

for (const [name, Cls] of MEMBERS) {
    for (const bad of [42, 'opts', null]) {
        test(name + ': options ' + String(bad) + ' (non-object) throws [lite-lru] "must be an object"', () => {
            assert.throws(() => new Cls(4, bad), (err) => {
                assert.ok(err instanceof TypeError);
                assert.match(err.message, /\[lite-lru\]/);
                assert.match(err.message, /must be an object/);
                return true;
            });
        });
    }

    test(name + ': options undefined / omitted is accepted as "no options" (the ONLY non-object that is)', () => {
        assert.doesNotThrow(() => new Cls(4));
        assert.doesNotThrow(() => new Cls(4, undefined));
    });
}

/* ============================================================================ *
 * TASK 3 -- onEvict fail-closed: non-function values throw "must be a function";
 * undefined/omitted is accepted; a real function is accepted and actually fires.
 * Parameterized over all 13 members. This is the intended 1.16.0 TIGHTENING: a
 * null/garbage onEvict used to silently become the shared NOOP; it now throws.
 * ============================================================================ */

for (const [name, Cls] of MEMBERS) {
    for (const bad of [42, 'fn', null, {}]) {
        test(name + ': onEvict ' + String(bad) + ' (not a function) throws [lite-lru] "must be a function" -- ' +
            'the fail-closed tightening vs <=1.15.0 (a null/garbage onEvict no longer silently becomes NOOP)', () => {
            assert.throws(() => new Cls(4, { onEvict: bad }), (err) => {
                assert.ok(err instanceof TypeError);
                assert.match(err.message, /\[lite-lru\]/);
                assert.match(err.message, /must be a function/);
                return true;
            });
        });
    }

    test(name + ': onEvict undefined (explicit or omitted) is accepted -- eviction works with no handler', () => {
        assert.doesNotThrow(() => {
            const c = new Cls(2, { onEvict: undefined });
            c.put('a', 1); c.put('b', 2); c.put('c', 3); // must not require a handler to evict
        });
        assert.doesNotThrow(() => new Cls(2));
    });

    test(name + ': a real onEvict function is accepted at construction and actually fires on eviction', () => {
        let calls = 0;
        const c = new Cls(2, { onEvict: () => { calls++; } });
        c.put('a', 1);
        c.put('b', 2);
        c.put('c', 3); // over capacity -> must evict something and fire the handler
        assert.ok(calls >= 1, name + ': a real onEvict handler never fired on an over-capacity put');
    });
}

/* ============================================================================ *
 * TASK 4 -- the Symbol/BigInt footgun (the family's recurring fail class, QA has
 * caught it before in lite-filter). A Symbol/BigInt anywhere on the validation
 * path must produce a CLEAN [lite-lru] error via String(), never a raw
 * "TypeError: Cannot convert a Symbol/BigInt value to ..." from an unguarded
 * template literal or `+` concatenation. Also: `for...in` can never observe a
 * Symbol key (spec guarantee) -- asserted here so the guard's ABSENCE of a special
 * case is proven correct, not just assumed. Parameterized over all 13 members.
 * ============================================================================ */

for (const [name, Cls] of MEMBERS) {
    test(name + ': a Symbol as the ENTIRE options bag throws a clean [lite-lru] error, never a raw Symbol-coercion TypeError', () => {
        const sym = Symbol('opts');
        assert.throws(() => new Cls(4, sym), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /must be an object/);
            assert.doesNotMatch(err.message, /Cannot convert a Symbol/);
            return true;
        });
    });

    test(name + ': a BigInt as the ENTIRE options bag throws a clean [lite-lru] error, never a raw TypeError', () => {
        assert.throws(() => new Cls(4, 42n), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /must be an object/);
            return true;
        });
    });

    test(name + ': onEvict: Symbol() stringifies cleanly in the [lite-lru] error (no raw coercion throw)', () => {
        assert.throws(() => new Cls(4, { onEvict: Symbol('h') }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /must be a function/);
            assert.doesNotMatch(err.message, /Cannot convert a Symbol/);
            return true;
        });
    });

    test(name + ': keys: Symbol() stringifies cleanly in the [lite-lru] error (no raw coercion throw)', () => {
        assert.throws(() => new Cls(4, { keys: Symbol('int-ish') }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.doesNotMatch(err.message, /Cannot convert a Symbol/);
            return true;
        });
    });

    test(name + ': onEvict: BigInt stringifies cleanly in the [lite-lru] error (no raw coercion throw)', () => {
        assert.throws(() => new Cls(4, { onEvict: 7n }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /must be a function/);
            return true;
        });
    });

    test(name + ': a Symbol-keyed option is invisible to for...in and NEVER triggers "unknown option" -- ' +
        'the guard holds even when an object carries ONLY a Symbol-keyed property', () => {
        const opts = {};
        // An enumerable Symbol-keyed own property. `for...in` (used by validateOptions)
        // can never see it (ECMA-262 EnumerateObjectProperties: string keys only) -- this
        // is a language guarantee, not something the library special-cases; this test
        // proves the guard's silence on Symbol keys is exactly that guarantee, not a gap.
        Object.defineProperty(opts, Symbol('sneaky'), { value: 1, enumerable: true });
        assert.doesNotThrow(() => new Cls(4, opts),
            name + ': a Symbol-keyed-only options bag must construct fine (no "unknown option" false positive)');
    });
}

/* ============================================================================ *
 * ADVERSARIAL (the case the planner did not think of): an ARRAY as the options
 * bag. `typeof [] === "object"` so it passes the object-shape door, but `for...in`
 * over an array ALSO enumerates its own numeric-index properties as string keys
 * ('0', '1', ...) -- none of which are in the known-option set. This must fail
 * CLOSED with a normal did-you-mean-style error (naming '0' and listing the valid
 * set, since a bare digit has no near-miss), not silently accept the array as "no
 * options", and not throw anything OTHER than the tagged [lite-lru] TypeError.
 * Parameterized over all 13 members.
 * ============================================================================ */

for (const [name, Cls] of MEMBERS) {
    test(name + ': ADVERSARIAL -- an array as the options bag (typeof "object", but for...in enumerates its ' +
        'indices) fails closed on the first numeric index as an unknown option, listing the valid set', () => {
        assert.throws(() => new Cls(4, [1, 2, 3]), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /unknown option 0/);
            for (const k of KNOWN_KEYS) {
                assert.ok(err.message.includes(k), name + ': array-options message missing valid key "' + k + '"');
            }
            return true;
        });
    });

    test(name + ': ADVERSARIAL -- an EMPTY array as the options bag has NO own enumerable keys (the ' +
        '"unknown option" for...in door stays silent), but `[].keys` resolves through the PROTOTYPE ' +
        'chain to the inherited Array.prototype.keys iterator method -- a genuinely surprising ' +
        'property-read collision with the `keys` door, not the enumeration door. It still fails ' +
        'CLOSED and clean (a [lite-lru] TypeError, not a raw crash) rather than silently accepting a ' +
        'built-in function as a keys-backing choice', () => {
        assert.throws(() => new Cls(4, []), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /unknown keys option/);
            assert.match(err.message, /did you mean 'int' or 'dense'\?/);
            return true;
        });
    });
}

/* ============================================================================ *
 * BONUS adversarial (item 4 reinforcement): a Proxy-based options bag whose
 * `ownKeys` trap hides EVERY property from `for...in`/`Object.keys` (so the
 * "unknown option" enumeration loop sees nothing), yet a malformed `onEvict` is
 * still reachable via a direct property read. `validateOnEvict` reads
 * `options.onEvict` directly (not via enumeration), so it must still catch this --
 * proving the two doors are independent, not one door relying on the other's
 * enumeration to ever "see" a bad value. Run once on the reference member (the
 * shared helpers are the same function for all 13; TASK 1-4 already prove the
 * enumeration door itself is family-wide).
 * ============================================================================ */

test('BONUS adversarial: a Proxy hiding onEvict from ownKeys/for...in enumeration is STILL fail-closed ' +
    'validated via the direct options.onEvict property read', () => {
    const hidden = { onEvict: 42 }; // invalid -- not a function
    const sneaky = new Proxy(hidden, {
        ownKeys() { return []; }, // hide every key from for...in
        getOwnPropertyDescriptor() { return undefined; },
        get(target, prop) { return target[prop]; }, // direct reads still resolve normally
    });
    assert.throws(() => new LiteLru(4, sneaky), (err) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /\[lite-lru\]/);
        assert.match(err.message, /must be a function/);
        return true;
    });
});

/* ============================================================================ *
 * TASK 5 -- the keys:'dense' backing doors (decisions/0029), parameterized over
 * all 13 members. The dense backing direct-maps k -> slot over a fixed [0, maxKey]
 * domain, so `maxKey` is REQUIRED and every dense key must fall in that domain --
 * both fail CLOSED at the door (null is not zero), with the typeof guard FIRST.
 * ============================================================================ */

for (const [name, Cls] of MEMBERS) {
    test(name + ": keys:'dense' without maxKey throws a tagged [lite-lru] maxKey error", () => {
        assert.throws(() => new Cls(4, { keys: 'dense' }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /maxKey/);
            return true;
        });
    });

    for (const badMk of [-1, 1.5, 2147483648, '10', null, true]) {
        test(name + ": keys:'dense' with maxKey " + String(badMk) + ' fails closed', () => {
            assert.throws(() => new Cls(4, { keys: 'dense', maxKey: badMk }), (err) => {
                assert.ok(err instanceof TypeError);
                assert.match(err.message, /\[lite-lru\]/);
                assert.match(err.message, /maxKey/);
                return true;
            });
        });
    }

    test(name + ": keys:'dense' with a valid maxKey rejects an out-of-[0,maxKey] key, fail closed", () => {
        const c = new Cls(4, { keys: 'dense', maxKey: 15 });
        for (const badKey of [-1, 16, 1.5, '3', null, {}]) {
            assert.throws(() => c.get(badKey), (err) => {
                assert.ok(err instanceof TypeError);
                assert.match(err.message, /\[lite-lru\]/);
                assert.match(err.message, /dense/);
                return true;
            }, name + ' key ' + String(badKey));
        }
        // A legal in-domain key (incl. 0 and maxKey) round-trips.
        c.put(0, 'a'); c.put(15, 'b');
        assert.equal(c.get(0), 'a');
        assert.equal(c.get(15), 'b');
    });

    test(name + ": an unknown keys value suggests both 'int' and 'dense'", () => {
        assert.throws(() => new Cls(4, { keys: 'nope' }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /did you mean 'int' or 'dense'\?/);
            return true;
        });
    });
}
