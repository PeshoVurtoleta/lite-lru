/**
 * @zakkster/lite-lru -- .d.ts drift guard (node:test).
 *
 * Shipping a hand-written ambient .d.ts earns its keep only if a gate proves it
 * never drifts from the runtime. This suite reads the file TEXT of Lru.js,
 * Lru.d.ts and package.json (never imports them) and asserts THREE inventories
 * agree, each DERIVED by regex, never hardcoded:
 *
 *   (a) version parity : the VERSION literal in Lru.js EQUALS the version in
 *       package.json; and Lru.d.ts DECLARES `VERSION`.
 *   (b) member parity  : the public (non-`_`) methods of `class LiteLru` in
 *       Lru.js (get/put/has/peek/delete/clear + get size/get capacity) EQUAL the
 *       members declared on `class LiteLru` in Lru.d.ts.
 *   (c) family surface : Lru.d.ts defines `interface LiteCache` AND declares
 *       `class LiteLru<...> implements LiteCache<...>` -- moat-pillar 1, the
 *       uniform interface every future member satisfies.
 *
 * Each check is a PURE function over text, so the same function proves teeth: the
 * mutation controls feed it a mutated COPY and assert it now reports a diff / a
 * false. A vacuity control asserts the unmutated text reports zero diffs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const JS = readFileSync(new URL('Lru.js', ROOT), 'utf8');
const DTS = readFileSync(new URL('Lru.d.ts', ROOT), 'utf8');
const PKG = readFileSync(new URL('package.json', ROOT), 'utf8');

// JS statement keywords that can start a line as `keyword (` inside a class body
// (control flow), so the member extractor must not mistake them for methods.
// `delete` is deliberately ABSENT: it is a real public method name here and only
// ever appears at line-start as its own definition.
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return', 'try',
  'super', 'function', 'typeof', 'new', 'void', 'yield', 'await',
]);

// --- pure extractors (text in, Set/string out) ------------------------------

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

/** Public (non-`_`) member names declared on a `class Name` body in text. The
 *  `[A-Za-z]` anchor drops every `_`-prefixed internal; KEYWORDS drops the
 *  control-flow tokens the source body carries but the bodiless d.ts does not. */
function classMembers(text, name) {
  const decl = new RegExp('class ' + name + '\\b');
  const m0 = decl.exec(text);
  if (m0 === null) return new Set();
  const start = m0.index;
  const open = text.indexOf('{', start);
  let depth = 0;
  let i = open;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = text.slice(open + 1, i);
  const out = new Set();
  const re = /(?:^|\n)\s*(?:static\s+)?(?:get\s+)?([A-Za-z]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const nm = m[1];
    if (nm === 'constructor' || KEYWORDS.has(nm)) continue;
    out.add(nm);
  }
  return out;
}

/** True if the d.ts declares `interface LiteCache<...>`. */
function hasLiteCacheInterface(dtsText) {
  return /interface LiteCache</.test(dtsText);
}

/** True if the d.ts declares `class LiteLru<...> implements LiteCache<...>`. */
function liteLruImplementsLiteCache(dtsText) {
  return /class LiteLru<[^>]*>\s+implements LiteCache<[^>]*>/.test(dtsText);
}

/** True if the d.ts declares `class Sieve<...> implements LiteCache<...>`. */
function sieveImplementsLiteCache(dtsText) {
  return /class Sieve<[^>]*>\s+implements LiteCache<[^>]*>/.test(dtsText);
}

/** True if the d.ts declares `class S3Fifo<...> implements LiteCache<...>`. */
function s3fifoImplementsLiteCache(dtsText) {
  return /class S3Fifo<[^>]*>\s+implements LiteCache<[^>]*>/.test(dtsText);
}

/** True if the d.ts declares `class WTinyLfu<...> implements LiteCache<...>`. */
function wtinylfuImplementsLiteCache(dtsText) {
  return /class WTinyLfu<[^>]*>\s+implements LiteCache<[^>]*>/.test(dtsText);
}

/** True if the d.ts declares `class Slru<...> implements LiteCache<...>`. */
function slruImplementsLiteCache(dtsText) {
  return /class Slru<[^>]*>\s+implements LiteCache<[^>]*>/.test(dtsText);
}

/** True if the d.ts declares `class TwoQ<...> implements LiteCache<...>`. */
function twoqImplementsLiteCache(dtsText) {
  return /class TwoQ<[^>]*>\s+implements LiteCache<[^>]*>/.test(dtsText);
}

/** True if the d.ts declares `class Arc<...> implements LiteCache<...>`. */
function arcImplementsLiteCache(dtsText) {
  return /class Arc<[^>]*>\s+implements LiteCache<[^>]*>/.test(dtsText);
}

/** True if BOTH sources declare a `Sieve` class (the second named export). */
function jsDeclaresSieve(jsText) {
  return /export class Sieve\b/.test(jsText);
}
function dtsDeclaresSieve(dtsText) {
  return /export class Sieve\b/.test(dtsText);
}

/** True if BOTH sources declare an `S3Fifo` class (the third named export). */
function jsDeclaresS3Fifo(jsText) {
  return /export class S3Fifo\b/.test(jsText);
}
function dtsDeclaresS3Fifo(dtsText) {
  return /export class S3Fifo\b/.test(dtsText);
}

/** True if BOTH sources declare a `WTinyLfu` class (the fourth named export). */
function jsDeclaresWTinyLfu(jsText) {
  return /export class WTinyLfu\b/.test(jsText);
}
function dtsDeclaresWTinyLfu(dtsText) {
  return /export class WTinyLfu\b/.test(dtsText);
}

/** True if BOTH sources declare an `Slru` class (the fifth named export). */
function jsDeclaresSlru(jsText) {
  return /export class Slru\b/.test(jsText);
}
function dtsDeclaresSlru(dtsText) {
  return /export class Slru\b/.test(dtsText);
}

/** True if BOTH sources declare a `TwoQ` class (the sixth named export). */
function jsDeclaresTwoQ(jsText) {
  return /export class TwoQ\b/.test(jsText);
}
function dtsDeclaresTwoQ(dtsText) {
  return /export class TwoQ\b/.test(dtsText);
}

/** True if BOTH sources declare an `Arc` class (the seventh named export). */
function jsDeclaresArc(jsText) {
  return /export class Arc\b/.test(jsText);
}
function dtsDeclaresArc(dtsText) {
  return /export class Arc\b/.test(dtsText);
}

/** Symmetric-difference report between two sets: [] when equal. */
function setDiff(a, b, labelA, labelB) {
  const diffs = [];
  for (const x of a) if (!b.has(x)) diffs.push(labelA + ' has ' + x + ' but ' + labelB + ' does not');
  for (const x of b) if (!a.has(x)) diffs.push(labelB + ' has ' + x + ' but ' + labelA + ' does not');
  return diffs;
}

// --- the three inventories --------------------------------------------------

test('(a) version parity: Lru.js VERSION === package.json version + d.ts declares VERSION', () => {
  assert.equal(jsVersion(JS), pkgVersion(PKG));
  assert.ok(dtsDeclaresVersion(DTS), 'Lru.d.ts must declare `export const VERSION`');
});

test('(b) member parity: public class methods in Lru.js === members on class LiteLru in Lru.d.ts', () => {
  const js = classMembers(JS, 'LiteLru');
  const dts = classMembers(DTS, 'LiteLru');
  const diffs = setDiff(js, dts, 'Lru.js', 'Lru.d.ts');
  assert.deepEqual(diffs, [], diffs.join('; '));
  // the full public surface, pinned by name (regex-derived above, listed here as
  // the intended inventory so a silent add/drop on BOTH sides is still caught).
  for (const nm of ['get', 'put', 'has', 'peek', 'delete', 'clear', 'purgeStale', 'stats', 'resetStats', 'keys', 'values', 'entries', 'size', 'capacity']) {
    assert.ok(js.has(nm), 'Lru.js class LiteLru is missing public member ' + nm);
    assert.ok(dts.has(nm), 'Lru.d.ts class LiteLru is missing member ' + nm);
  }
  assert.equal(js.size, 14, 'expected exactly 14 public members in Lru.js, saw ' + js.size);
  assert.equal(dts.size, 14, 'expected exactly 14 members in Lru.d.ts, saw ' + dts.size);
});

test('(c) family surface: interface LiteCache + class LiteLru implements LiteCache (moat-pillar 1)', () => {
  assert.ok(hasLiteCacheInterface(DTS), 'Lru.d.ts must define `interface LiteCache<...>`');
  assert.ok(liteLruImplementsLiteCache(DTS), 'class LiteLru must `implements LiteCache<...>`');
});

test('(d) Sieve surface: Sieve is a named export in BOTH sources, members agree, implements LiteCache', () => {
  assert.ok(jsDeclaresSieve(JS), 'Lru.js must `export class Sieve` (the second named export)');
  assert.ok(dtsDeclaresSieve(DTS), 'Lru.d.ts must `export class Sieve`');
  const js = classMembers(JS, 'Sieve');
  const dts = classMembers(DTS, 'Sieve');
  const diffs = setDiff(js, dts, 'Lru.js', 'Lru.d.ts');
  assert.deepEqual(diffs, [], diffs.join('; '));
  // The full public surface -- identical inventory to LiteLru (moat-pillar 1: the
  // uniform LiteCache surface every member satisfies).
  for (const nm of ['get', 'put', 'has', 'peek', 'delete', 'clear', 'purgeStale', 'stats', 'resetStats', 'keys', 'values', 'entries', 'size', 'capacity']) {
    assert.ok(js.has(nm), 'Lru.js class Sieve is missing public member ' + nm);
    assert.ok(dts.has(nm), 'Lru.d.ts class Sieve is missing member ' + nm);
  }
  assert.equal(js.size, 14, 'expected exactly 14 public members in Sieve (Lru.js), saw ' + js.size);
  assert.equal(dts.size, 14, 'expected exactly 14 members in Sieve (Lru.d.ts), saw ' + dts.size);
  assert.ok(sieveImplementsLiteCache(DTS), 'class Sieve must `implements LiteCache<...>`');
});

test('(e) S3Fifo surface: S3Fifo is a named export in BOTH sources, members agree, implements LiteCache', () => {
  assert.ok(jsDeclaresS3Fifo(JS), 'Lru.js must `export class S3Fifo` (the third named export)');
  assert.ok(dtsDeclaresS3Fifo(DTS), 'Lru.d.ts must `export class S3Fifo`');
  const js = classMembers(JS, 'S3Fifo');
  const dts = classMembers(DTS, 'S3Fifo');
  const diffs = setDiff(js, dts, 'Lru.js', 'Lru.d.ts');
  assert.deepEqual(diffs, [], diffs.join('; '));
  // The full public surface -- identical inventory to LiteLru/Sieve (moat-pillar 1).
  for (const nm of ['get', 'put', 'has', 'peek', 'delete', 'clear', 'purgeStale', 'stats', 'resetStats', 'keys', 'values', 'entries', 'size', 'capacity']) {
    assert.ok(js.has(nm), 'Lru.js class S3Fifo is missing public member ' + nm);
    assert.ok(dts.has(nm), 'Lru.d.ts class S3Fifo is missing member ' + nm);
  }
  assert.equal(js.size, 14, 'expected exactly 14 public members in S3Fifo (Lru.js), saw ' + js.size);
  assert.equal(dts.size, 14, 'expected exactly 14 members in S3Fifo (Lru.d.ts), saw ' + dts.size);
  assert.ok(s3fifoImplementsLiteCache(DTS), 'class S3Fifo must `implements LiteCache<...>`');
});

test('(f) WTinyLfu surface: WTinyLfu is a named export in BOTH sources, members agree, implements LiteCache', () => {
  assert.ok(jsDeclaresWTinyLfu(JS), 'Lru.js must `export class WTinyLfu` (the fourth named export)');
  assert.ok(dtsDeclaresWTinyLfu(DTS), 'Lru.d.ts must `export class WTinyLfu`');
  const js = classMembers(JS, 'WTinyLfu');
  const dts = classMembers(DTS, 'WTinyLfu');
  const diffs = setDiff(js, dts, 'Lru.js', 'Lru.d.ts');
  assert.deepEqual(diffs, [], diffs.join('; '));
  // The full public surface -- identical inventory to LiteLru/Sieve/S3Fifo (moat-pillar 1).
  for (const nm of ['get', 'put', 'has', 'peek', 'delete', 'clear', 'purgeStale', 'stats', 'resetStats', 'keys', 'values', 'entries', 'size', 'capacity']) {
    assert.ok(js.has(nm), 'Lru.js class WTinyLfu is missing public member ' + nm);
    assert.ok(dts.has(nm), 'Lru.d.ts class WTinyLfu is missing member ' + nm);
  }
  assert.equal(js.size, 14, 'expected exactly 14 public members in WTinyLfu (Lru.js), saw ' + js.size);
  assert.equal(dts.size, 14, 'expected exactly 14 members in WTinyLfu (Lru.d.ts), saw ' + dts.size);
  assert.ok(wtinylfuImplementsLiteCache(DTS), 'class WTinyLfu must `implements LiteCache<...>`');
});

test('(g) Slru surface: Slru is a named export in BOTH sources, members agree, implements LiteCache', () => {
  assert.ok(jsDeclaresSlru(JS), 'Lru.js must `export class Slru` (the fifth named export)');
  assert.ok(dtsDeclaresSlru(DTS), 'Lru.d.ts must `export class Slru`');
  const js = classMembers(JS, 'Slru');
  const dts = classMembers(DTS, 'Slru');
  const diffs = setDiff(js, dts, 'Lru.js', 'Lru.d.ts');
  assert.deepEqual(diffs, [], diffs.join('; '));
  for (const nm of ['get', 'put', 'has', 'peek', 'delete', 'clear', 'purgeStale', 'stats', 'resetStats', 'keys', 'values', 'entries', 'size', 'capacity']) {
    assert.ok(js.has(nm), 'Lru.js class Slru is missing public member ' + nm);
    assert.ok(dts.has(nm), 'Lru.d.ts class Slru is missing member ' + nm);
  }
  assert.equal(js.size, 14, 'expected exactly 14 public members in Slru (Lru.js), saw ' + js.size);
  assert.equal(dts.size, 14, 'expected exactly 14 members in Slru (Lru.d.ts), saw ' + dts.size);
  assert.ok(slruImplementsLiteCache(DTS), 'class Slru must `implements LiteCache<...>`');
});

test('(h) TwoQ surface: TwoQ is a named export in BOTH sources, members agree, implements LiteCache', () => {
  assert.ok(jsDeclaresTwoQ(JS), 'Lru.js must `export class TwoQ` (the sixth named export)');
  assert.ok(dtsDeclaresTwoQ(DTS), 'Lru.d.ts must `export class TwoQ`');
  const js = classMembers(JS, 'TwoQ');
  const dts = classMembers(DTS, 'TwoQ');
  const diffs = setDiff(js, dts, 'Lru.js', 'Lru.d.ts');
  assert.deepEqual(diffs, [], diffs.join('; '));
  for (const nm of ['get', 'put', 'has', 'peek', 'delete', 'clear', 'purgeStale', 'stats', 'resetStats', 'keys', 'values', 'entries', 'size', 'capacity']) {
    assert.ok(js.has(nm), 'Lru.js class TwoQ is missing public member ' + nm);
    assert.ok(dts.has(nm), 'Lru.d.ts class TwoQ is missing member ' + nm);
  }
  assert.equal(js.size, 14, 'expected exactly 14 public members in TwoQ (Lru.js), saw ' + js.size);
  assert.equal(dts.size, 14, 'expected exactly 14 members in TwoQ (Lru.d.ts), saw ' + dts.size);
  assert.ok(twoqImplementsLiteCache(DTS), 'class TwoQ must `implements LiteCache<...>`');
});

test('(i) Arc surface: Arc is a named export in BOTH sources, members agree, implements LiteCache', () => {
  assert.ok(jsDeclaresArc(JS), 'Lru.js must `export class Arc` (the seventh named export)');
  assert.ok(dtsDeclaresArc(DTS), 'Lru.d.ts must `export class Arc`');
  const js = classMembers(JS, 'Arc');
  const dts = classMembers(DTS, 'Arc');
  const diffs = setDiff(js, dts, 'Lru.js', 'Lru.d.ts');
  assert.deepEqual(diffs, [], diffs.join('; '));
  for (const nm of ['get', 'put', 'has', 'peek', 'delete', 'clear', 'purgeStale', 'stats', 'resetStats', 'keys', 'values', 'entries', 'size', 'capacity']) {
    assert.ok(js.has(nm), 'Lru.js class Arc is missing public member ' + nm);
    assert.ok(dts.has(nm), 'Lru.d.ts class Arc is missing member ' + nm);
  }
  assert.equal(js.size, 14, 'expected exactly 14 public members in Arc (Lru.js), saw ' + js.size);
  assert.equal(dts.size, 14, 'expected exactly 14 members in Arc (Lru.d.ts), saw ' + dts.size);
  assert.ok(arcImplementsLiteCache(DTS), 'class Arc must `implements LiteCache<...>`');
});

// --- teeth: each check must reject a mutated COPY (non-vacuity) --------------

test('control: unmutated text reports zero diffs / all-present (vacuity)', () => {
  assert.equal(jsVersion(JS), pkgVersion(PKG));
  assert.ok(dtsDeclaresVersion(DTS));
  assert.deepEqual(setDiff(classMembers(JS, 'LiteLru'), classMembers(DTS, 'LiteLru'), 'a', 'b'), []);
  assert.deepEqual(setDiff(classMembers(JS, 'Sieve'), classMembers(DTS, 'Sieve'), 'a', 'b'), []);
  assert.deepEqual(setDiff(classMembers(JS, 'S3Fifo'), classMembers(DTS, 'S3Fifo'), 'a', 'b'), []);
  assert.deepEqual(setDiff(classMembers(JS, 'WTinyLfu'), classMembers(DTS, 'WTinyLfu'), 'a', 'b'), []);
  assert.deepEqual(setDiff(classMembers(JS, 'Slru'), classMembers(DTS, 'Slru'), 'a', 'b'), []);
  assert.deepEqual(setDiff(classMembers(JS, 'TwoQ'), classMembers(DTS, 'TwoQ'), 'a', 'b'), []);
  assert.deepEqual(setDiff(classMembers(JS, 'Arc'), classMembers(DTS, 'Arc'), 'a', 'b'), []);
  assert.ok(hasLiteCacheInterface(DTS));
  assert.ok(liteLruImplementsLiteCache(DTS));
  assert.ok(sieveImplementsLiteCache(DTS));
  assert.ok(s3fifoImplementsLiteCache(DTS));
  assert.ok(wtinylfuImplementsLiteCache(DTS));
  assert.ok(slruImplementsLiteCache(DTS));
  assert.ok(twoqImplementsLiteCache(DTS));
  assert.ok(arcImplementsLiteCache(DTS));
});

test('control: desyncing the package.json version makes version parity fail', () => {
  const mutated = PKG.replace(/"version":\s*"[^"]+"/, '"version": "9.9.9"');
  assert.notEqual(jsVersion(JS), pkgVersion(mutated));
});

test('control: dropping the VERSION declaration from the d.ts fails the version check', () => {
  const mutated = DTS.replace(/export const VERSION\b[^\n]*\n/, '');
  assert.ok(!dtsDeclaresVersion(mutated), 'removing VERSION from the d.ts did not fail the check');
});

test('control: dropping a method from the d.ts class makes member parity fail', () => {
  // `peek(...)` is declared in BOTH the interface and the class; strip every copy
  // (global) so the class body loses it and member parity must then diverge.
  const mutated = DTS.replace(/\n\s*peek\(key: K\): V \| undefined;/g, '');
  const diffs = setDiff(classMembers(JS, 'LiteLru'), classMembers(mutated, 'LiteLru'), 'Lru.js', 'Lru.d.ts');
  assert.ok(diffs.length > 0, 'dropping peek() from the d.ts did not fail member parity');
});

test('control: breaking the implements clause fails the family-surface check', () => {
  const mutated = DTS.replace(/class LiteLru<[^>]*>\s+implements LiteCache<[^>]*>/, 'class LiteLru<K = unknown, V = unknown>');
  assert.ok(!liteLruImplementsLiteCache(mutated), 'de-implementing LiteCache did not fail the surface check');
});

test('control: dropping the LiteCache interface fails the family-surface check', () => {
  const mutated = DTS.replace(/interface LiteCache</, 'interface NotACache<');
  assert.ok(!hasLiteCacheInterface(mutated), 'renaming the LiteCache interface did not fail the surface check');
});

test('control: breaking Sieve implements clause fails the Sieve surface check', () => {
  const mutated = DTS.replace(/class Sieve<[^>]*>\s+implements LiteCache<[^>]*>/, 'class Sieve<K = unknown, V = unknown>');
  assert.ok(!sieveImplementsLiteCache(mutated), 'de-implementing LiteCache on Sieve did not fail the surface check');
});

test('control: dropping a method from the d.ts Sieve class makes Sieve member parity fail', () => {
  // Strip every `clear(): void;` (interface + both classes); the Sieve class then
  // loses `clear` while Lru.js's Sieve still has it, so member parity must diverge.
  const mutated = DTS.replace(/\n\s*clear\(\): void;/g, '');
  const diffs = setDiff(classMembers(JS, 'Sieve'), classMembers(mutated, 'Sieve'), 'Lru.js', 'Lru.d.ts');
  assert.ok(diffs.length > 0, 'dropping clear() from the d.ts Sieve class did not fail member parity');
});

test('control: breaking Slru implements clause fails the Slru surface check', () => {
  const mutated = DTS.replace(/class Slru<[^>]*>\s+implements LiteCache<[^>]*>/, 'class Slru<K = unknown, V = unknown>');
  assert.ok(!slruImplementsLiteCache(mutated), 'de-implementing LiteCache on Slru did not fail the surface check');
});

test('control: breaking TwoQ implements clause fails the TwoQ surface check', () => {
  const mutated = DTS.replace(/class TwoQ<[^>]*>\s+implements LiteCache<[^>]*>/, 'class TwoQ<K = unknown, V = unknown>');
  assert.ok(!twoqImplementsLiteCache(mutated), 'de-implementing LiteCache on TwoQ did not fail the surface check');
});

test('control: breaking Arc implements clause fails the Arc surface check', () => {
  const mutated = DTS.replace(/class Arc<[^>]*>\s+implements LiteCache<[^>]*>/, 'class Arc<K = unknown, V = unknown>');
  assert.ok(!arcImplementsLiteCache(mutated), 'de-implementing LiteCache on Arc did not fail the surface check');
});
