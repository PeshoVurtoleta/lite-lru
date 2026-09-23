/**
 * @zakkster/lite-lru -- .d.ts drift guard (node:test).
 *
 * Shipping a hand-written ambient .d.ts earns its keep only if a gate proves it
 * never drifts from the runtime. This suite reads the file TEXT of Lru.js,
 * Lru.d.ts and package.json (never imports them) and asserts the inventories
 * agree, each DERIVED by regex, never hardcoded:
 *
 *   (a) version parity : the VERSION literal in Lru.js EQUALS the version in
 *       package.json; and Lru.d.ts DECLARES `VERSION`.
 *   (b) member parity  : for EVERY one of the 13 policy members the public
 *       (non-`_`) instance methods + getters of the runtime class EQUAL the
 *       members declared on the same class in Lru.d.ts (S17 N3: was 9 classes,
 *       now all 13, plus the N2 config getters keysBacking / maxKey / ttlEnabled
 *       / statsEnabled and the static `restore` factory).
 *   (c) family surface : Lru.d.ts defines `interface LiteCache` AND every policy
 *       class `implements LiteCache<...>` -- moat-pillar 1, the uniform interface.
 *   (d) DirectLru       : the 14th class is a thin subclass; it `extends LiteLru`
 *       (no duplicated instance surface) and carries its own static `restore`.
 *
 * Each check is a PURE function over text, so the same function proves teeth: the
 * mutation controls feed it a mutated COPY and assert it now reports a diff / a
 * false. A vacuity control asserts the unmutated text reports zero diffs.
 *
 * NOTE on the member regex (S17 N3): it matches `name(` at line start, so a BARE
 * local call in a method body (e.g. `testStep();`, `ckCol(...)`) would be mistaken
 * for a public member. The runtime source guards against this with a `void` prefix
 * (`void testStep();`) -- `void` is in KEYWORDS below and is skipped -- exactly as
 * `void validateOptions(options)` does in every constructor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const JS = readFileSync(new URL('Lru.js', ROOT), 'utf8');
const DTS = readFileSync(new URL('Lru.d.ts', ROOT), 'utf8');
const PKG = readFileSync(new URL('package.json', ROOT), 'utf8');

// JS statement keywords that can start a line as `keyword (` inside a class body
// (control flow / a `void`-prefixed bare call), so the member extractor must not
// mistake them for methods. `delete` is deliberately ABSENT: it is a real public
// method name and only ever appears at line-start as its own definition.
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return', 'try',
  'super', 'function', 'typeof', 'new', 'void', 'yield', 'await',
]);

// The full public instance surface every policy member satisfies (moat-pillar 1),
// regex-derived below and pinned here so a silent add/drop on BOTH sides is caught.
// S17 N2 appended the four cold config getters.
const SURFACE = [
  'get', 'put', 'has', 'peek', 'delete', 'clear', 'purgeStale', 'stats',
  'resetStats', 'dump', 'keys', 'values', 'entries', 'size', 'capacity',
  'keysBacking', 'maxKey', 'ttlEnabled', 'statsEnabled',
];
const SURFACE_SIZE = SURFACE.length; // 19

// The static factory surface (S17 N3: statics were previously uncounted).
const STATICS = ['restore'];

// The 13 policy members (order matches Bench.test.js / Options.test.js). DirectLru
// (the 14th class) is handled separately: it inherits the surface via `extends`.
const MEMBER_CLASSES = [
  'LiteLru', 'Sieve', 'S3Fifo', 'WTinyLfu', 'Slru', 'TwoQ', 'Arc', 'Lirs',
  'Lfu', 'ClockPro', 'LruK', 'Mq', 'Car',
];

// --- pure extractors (text in, Set/string/bool out) -------------------------

/** VERSION string literal in Lru.js. */
function jsVersion(jsText) {
  const m = /export const VERSION\s*=\s*"([^"]+)"/.exec(jsText);
  assert.ok(m, 'Lru.js has no `export const VERSION = "..."` literal');
  return m[1];
}

/** version field in package.json. */
function pkgVersion(pkgText) {
  const m = /"version":\s*"([^"]+)"/.exec(pkgText);
  assert.ok(m, 'package.json has no version field');
  return m[1];
}

/** True if the d.ts DECLARES a `VERSION` export. */
function dtsDeclaresVersion(dtsText) {
  return /export const VERSION\b/.test(dtsText);
}

/** The `{...}` body text of `class Name` (balanced-brace scan), or null if absent. */
function classBody(text, name) {
  const decl = new RegExp('class ' + name + '\\b');
  const m0 = decl.exec(text);
  if (m0 === null) return null;
  const open = text.indexOf('{', m0.index);
  let depth = 0;
  let i = open;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) break; }
  }
  return text.slice(open + 1, i);
}

/** Public (non-`_`) INSTANCE member names declared on a `class Name` body. The
 *  `[A-Za-z]` anchor drops every `_`-prefixed internal; KEYWORDS drops the
 *  control-flow / void-prefixed tokens the source body carries but the bodiless
 *  d.ts does not. STATIC members are captured by group 1 and SKIPPED here (they
 *  are not part of the LiteCache<K,V> instance contract -- decisions/0021). */
function classMembers(text, name) {
  const body = classBody(text, name);
  if (body === null) return new Set();
  const out = new Set();
  const re = /(?:^|\n)\s*(static\s+)?(?:get\s+)?([A-Za-z]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) continue; // static -> not an instance member
    const nm = m[2];
    if (nm === 'constructor' || KEYWORDS.has(nm)) continue;
    out.add(nm);
  }
  return out;
}

/** STATIC member names declared on a `class Name` body. Tolerates a generic
 *  parameter list between the name and the `(` (the d.ts writes
 *  `static restore<K = unknown, V = unknown>(...)`). */
function staticMembers(text, name) {
  const body = classBody(text, name);
  if (body === null) return new Set();
  const out = new Set();
  const re = /(?:^|\n)\s*static\s+([A-Za-z]\w*)\s*(?:<[^>]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return out;
}

/** True if `text` declares `export class Name` (a named export in that source). */
function declaresExportClass(text, name) {
  return new RegExp('export class ' + name + '\\b').test(text);
}

/** True if the d.ts declares `class Name<...> implements LiteCache<...>`. */
function implementsLiteCache(dtsText, name) {
  return new RegExp('class ' + name + '<[^>]*>\\s+implements LiteCache<[^>]*>').test(dtsText);
}

/** True if the d.ts declares `class Name<...> extends Base<...>`. */
function classExtends(dtsText, name, base) {
  return new RegExp('class ' + name + '<[^>]*>\\s+extends ' + base + '<[^>]*>').test(dtsText);
}

/** True if the d.ts declares `interface LiteCache<...>`. */
function hasLiteCacheInterface(dtsText) {
  return /interface LiteCache</.test(dtsText);
}

/** Rewrite ONLY the `{...}` body of `class Name` (leaving the interface + other
 *  classes untouched), applying `from -> to` inside it. For the mutation controls:
 *  a member drop/rename scoped to one class, so member parity for THAT class alone
 *  must then diverge. In-memory only -- never writes the repo. */
function mutateClassBody(dtsText, name, from, to) {
  const decl = new RegExp('class ' + name + '\\b');
  const m0 = decl.exec(dtsText);
  assert.ok(m0, 'mutateClassBody: no class ' + name);
  const open = dtsText.indexOf('{', m0.index);
  let depth = 0;
  let i = open;
  for (; i < dtsText.length; i++) {
    if (dtsText[i] === '{') depth++;
    else if (dtsText[i] === '}') { depth--; if (depth === 0) break; }
  }
  const before = dtsText.slice(0, open);
  const body = dtsText.slice(open, i);
  const after = dtsText.slice(i);
  const nextBody = body.replace(from, to);
  assert.notEqual(nextBody, body, 'mutateClassBody: pattern ' + from + ' not found in ' + name);
  return before + nextBody + after;
}

/** Symmetric-difference report between two sets: [] when equal. */
function setDiff(a, b, labelA, labelB) {
  const diffs = [];
  for (const x of a) if (!b.has(x)) diffs.push(labelA + ' has ' + x + ' but ' + labelB + ' does not');
  for (const x of b) if (!a.has(x)) diffs.push(labelB + ' has ' + x + ' but ' + labelA + ' does not');
  return diffs;
}

// --- (a) version parity -----------------------------------------------------

test('(a) version parity: Lru.js VERSION === package.json version + d.ts declares VERSION', () => {
  assert.equal(jsVersion(JS), pkgVersion(PKG));
  assert.ok(dtsDeclaresVersion(DTS), 'Lru.d.ts must declare `export const VERSION`');
});

// --- (b + c) member parity + family surface, for every policy member ---------

for (const name of MEMBER_CLASSES) {
  test('(b/c) ' + name + ': named export in BOTH sources; instance surface + statics agree; ' +
    'implements LiteCache', () => {
    assert.ok(declaresExportClass(JS, name), 'Lru.js must `export class ' + name + '`');
    assert.ok(declaresExportClass(DTS, name), 'Lru.d.ts must `export class ' + name + '`');

    // Instance-member parity (the 19-strong uniform surface incl. the N2 getters).
    const js = classMembers(JS, name);
    const dts = classMembers(DTS, name);
    const diffs = setDiff(js, dts, 'Lru.js', 'Lru.d.ts');
    assert.deepEqual(diffs, [], diffs.join('; '));
    for (const nm of SURFACE) {
      assert.ok(js.has(nm), 'Lru.js class ' + name + ' is missing public member ' + nm);
      assert.ok(dts.has(nm), 'Lru.d.ts class ' + name + ' is missing member ' + nm);
    }
    assert.equal(js.size, SURFACE_SIZE, name + ' (Lru.js): expected ' + SURFACE_SIZE + ' members, saw ' + js.size);
    assert.equal(dts.size, SURFACE_SIZE, name + ' (Lru.d.ts): expected ' + SURFACE_SIZE + ' members, saw ' + dts.size);

    // Static-factory parity (S17 N3: `restore` etc.).
    const jsS = staticMembers(JS, name);
    const dtsS = staticMembers(DTS, name);
    const sDiffs = setDiff(jsS, dtsS, 'Lru.js', 'Lru.d.ts');
    assert.deepEqual(sDiffs, [], 'static ' + sDiffs.join('; '));
    for (const nm of STATICS) {
      assert.ok(jsS.has(nm), 'Lru.js class ' + name + ' is missing static ' + nm);
      assert.ok(dtsS.has(nm), 'Lru.d.ts class ' + name + ' is missing static ' + nm);
    }

    // Family surface (moat-pillar 1).
    assert.ok(implementsLiteCache(DTS, name), 'class ' + name + ' must `implements LiteCache<...>`');
  });
}

test('(c) family surface: interface LiteCache is declared (moat-pillar 1)', () => {
  assert.ok(hasLiteCacheInterface(DTS), 'Lru.d.ts must define `interface LiteCache<...>`');
});

// --- (d) DirectLru: the 14th class, a thin subclass -------------------------

test('(d) DirectLru: named export in BOTH sources; extends LiteLru; carries a static restore', () => {
  assert.ok(declaresExportClass(JS, 'DirectLru'), 'Lru.js must `export class DirectLru`');
  assert.ok(declaresExportClass(DTS, 'DirectLru'), 'Lru.d.ts must `export class DirectLru`');
  // It duplicates NO instance surface -- both bodies carry zero instance members.
  assert.equal(classMembers(JS, 'DirectLru').size, 0, 'DirectLru (Lru.js) must inherit its surface, not redeclare it');
  assert.equal(classMembers(DTS, 'DirectLru').size, 0, 'DirectLru (Lru.d.ts) must inherit its surface, not redeclare it');
  assert.ok(classExtends(DTS, 'DirectLru', 'LiteLru'), 'DirectLru must `extends LiteLru<...>` in the d.ts');
  // Static-factory parity.
  const jsS = staticMembers(JS, 'DirectLru');
  const dtsS = staticMembers(DTS, 'DirectLru');
  assert.deepEqual(setDiff(jsS, dtsS, 'Lru.js', 'Lru.d.ts'), []);
  assert.ok(jsS.has('restore') && dtsS.has('restore'), 'DirectLru must declare a static restore in BOTH sources');
});

// --- teeth: each check must reject a mutated COPY (non-vacuity) --------------

test('control: unmutated text reports zero diffs / all-present (vacuity)', () => {
  assert.equal(jsVersion(JS), pkgVersion(PKG));
  assert.ok(dtsDeclaresVersion(DTS));
  for (const name of MEMBER_CLASSES) {
    assert.deepEqual(setDiff(classMembers(JS, name), classMembers(DTS, name), 'a', 'b'), [], name + ' instance');
    assert.deepEqual(setDiff(staticMembers(JS, name), staticMembers(DTS, name), 'a', 'b'), [], name + ' static');
    assert.ok(implementsLiteCache(DTS, name), name + ' implements');
  }
  assert.ok(hasLiteCacheInterface(DTS));
  assert.ok(classExtends(DTS, 'DirectLru', 'LiteLru'));
});

test('control: desyncing the package.json version makes version parity fail', () => {
  const mutated = PKG.replace(/"version":\s*"[^"]+"/, '"version": "9.9.9"');
  assert.notEqual(jsVersion(JS), pkgVersion(mutated));
});

test('control: dropping the VERSION declaration from the d.ts fails the version check', () => {
  const mutated = DTS.replace(/export const VERSION\b[^\n]*\n/, '');
  assert.ok(!dtsDeclaresVersion(mutated), 'removing VERSION from the d.ts did not fail the check');
});

test('control: dropping a method from the d.ts LiteLru class makes member parity fail', () => {
  const mutated = mutateClassBody(DTS, 'LiteLru', /\n\s*peek\(key: K\): V \| undefined;/, '');
  const diffs = setDiff(classMembers(JS, 'LiteLru'), classMembers(mutated, 'LiteLru'), 'Lru.js', 'Lru.d.ts');
  assert.ok(diffs.length > 0, 'dropping peek() from the d.ts LiteLru class did not fail member parity');
});

test('control: breaking the LiteLru implements clause fails the family-surface check', () => {
  const mutated = DTS.replace(/class LiteLru<[^>]*>\s+implements LiteCache<[^>]*>/, 'class LiteLru<K = unknown, V = unknown>');
  assert.ok(!implementsLiteCache(mutated, 'LiteLru'), 'de-implementing LiteCache did not fail the surface check');
});

test('control: dropping the LiteCache interface fails the family-surface check', () => {
  const mutated = DTS.replace(/interface LiteCache</, 'interface NotACache<');
  assert.ok(!hasLiteCacheInterface(mutated), 'renaming the LiteCache interface did not fail the surface check');
});

// --- S17 N3 mutation control: Car specifically (was a skipped class) --------

test('N3 control: renaming a member in the d.ts Car class fails Car member parity', () => {
  // In-memory rename of a Car instance method (scoped to Car's body only).
  const mutated = mutateClassBody(DTS, 'Car', /\n(\s*)purgeStale\(\): number;/, '\n$1purgeStaleX(): number;');
  const diffs = setDiff(classMembers(JS, 'Car'), classMembers(mutated, 'Car'), 'Lru.js', 'Lru.d.ts');
  assert.ok(diffs.length > 0, 'renaming purgeStale() on the d.ts Car class did not fail member parity');
});

test('N3 control: removing a member from the d.ts Car class fails Car member parity', () => {
  const mutated = mutateClassBody(DTS, 'Car', /\n\s*clear\(\): void;/, '');
  const diffs = setDiff(classMembers(JS, 'Car'), classMembers(mutated, 'Car'), 'Lru.js', 'Lru.d.ts');
  assert.ok(diffs.length > 0, 'removing clear() from the d.ts Car class did not fail member parity');
});

test('N3 control: removing an N2 config getter from the d.ts Car class fails Car member parity', () => {
  const mutated = mutateClassBody(DTS, 'Car', /\n\s*get keysBacking\(\): 'map' \| 'int' \| 'dense';/, '');
  const diffs = setDiff(classMembers(JS, 'Car'), classMembers(mutated, 'Car'), 'Lru.js', 'Lru.d.ts');
  assert.ok(diffs.length > 0, 'removing the keysBacking getter from the d.ts Car class did not fail member parity');
});

test('N3 control: removing the static restore from the d.ts Car class fails Car static parity', () => {
  const mutated = mutateClassBody(DTS, 'Car', /\n\s*static restore<[^;]*;/, '');
  const diffs = setDiff(staticMembers(JS, 'Car'), staticMembers(mutated, 'Car'), 'Lru.js', 'Lru.d.ts');
  assert.ok(diffs.length > 0, 'removing static restore from the d.ts Car class did not fail static parity');
});

test('N3 control: breaking the Car implements clause fails the Car surface check', () => {
  const mutated = DTS.replace(/class Car<[^>]*>\s+implements LiteCache<[^>]*>/, 'class Car<K = unknown, V = unknown>');
  assert.ok(!implementsLiteCache(mutated, 'Car'), 'de-implementing LiteCache on Car did not fail the surface check');
});

test('N3 control: breaking the DirectLru extends clause fails the subclass check', () => {
  const mutated = DTS.replace(/class DirectLru<[^>]*>\s+extends LiteLru<[^>]*>/, 'class DirectLru<K = number, V = unknown>');
  assert.ok(!classExtends(mutated, 'DirectLru', 'LiteLru'), 'de-extending LiteLru on DirectLru did not fail the check');
});
