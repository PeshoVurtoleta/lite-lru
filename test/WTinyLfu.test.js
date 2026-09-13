/**
 * @zakkster/lite-lru -- node:test boundary suite for the W-TinyLFU member
 * (decisions/0014). Mirrors S3Fifo.test.js in coverage and style, but pins
 * W-TinyLFU's OWN policy laws: a newcomer enters the admission WINDOW; below
 * capacity the window sheds its overflow into PROBATION with no eviction; at
 * capacity the window's LRU is the admission CANDIDATE, weighed against the
 * PROBATION LRU VICTIM via the count-min sketch -- the candidate is admitted iff
 * strictly more frequent, TIES REJECT (favor the incumbent); a probation HIT
 * PROMOTES to PROTECTED (demoting protected's LRU back to probation on overflow);
 * has/peek are frequency- AND recency-neutral; a one-hit-wonder never reaches
 * PROTECTED. validate() (the conservation invariant, extended with the W-TinyLFU
 * three-segment + sketch terms) runs after mutating tests as a structural backstop.
 *
 * BOUNDARY MATRIX (every new entry point): capacity 0 (invalid)/1/N-1/N/N+1, the
 * empty and cleared cache, `null`/`undefined`/`NaN`/`-0` as capacity AND as keys,
 * a duplicate delete() ("duplicate dispose"), a reentrant put/get/delete/clear from
 * inside onEvict ("re-entrant write" / the closest analogue to "dispose-during-
 * iteration" this surface has -- there is no iterator protocol to dispose mid-walk,
 * so the reentrancy guard is the load-bearing equivalent), and one adversarial case
 * the planner did not name: an OBJECT key's sketch coordinate is its resident SLOT
 * (D14.1, no WeakMap) -- so a slot vacated by an evicted object key hands its
 * leftover frequency to WHATEVER new key the store places there next. This is a
 * documented tradeoff (decisions/0014-wtinylfu.md D14.1), pinned here as executable
 * fact, not just prose.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WTinyLfu, VERSION } from '../Lru.js';
import { validate } from './validate.mjs';
import { makeWTinyLfuOracle } from './torture/oracles/wtinylfu.mjs';
import { CountedWTinyLfu, WTINYLFU_WRITES_WINDOW_MRU_REHIT } from './torture/harness.mjs';

const NIL = -1;
const SEG_WINDOW = 0;   // matches Lru.js's WTinyLfu segment tags
const SEG_PROBATION = 1;
const SEG_PROTECTED = 2;

test('exports: VERSION and the named WTinyLfu export are present', async () => {
    assert.equal(VERSION, '1.12.0');
    const mod = await import('../Lru.js');
    assert.equal(mod.WTinyLfu, WTinyLfu);
});

test('getters: size and capacity reflect state', () => {
    const c = new WTinyLfu(3);
    assert.equal(c.capacity, 3);
    assert.equal(c.size, 0);
    c.put('a', 1);
    assert.equal(c.size, 1);
    validate(c);
});

test('put/get: basic round-trip', () => {
    const c = new WTinyLfu(4);
    c.put('a', 1);
    c.put('b', 2);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('b'), 2);
    assert.equal(c.get('missing'), undefined);
    validate(c);
});

// --- D14.4: segment sizing, derived from the formula, NOT hardcoded -----------

test('sizing: window = max(1, round(cap/100)); main = cap - window; protected = round(main*0.8)', () => {
    const CASES = [
        { cap: 1, window: 1, main: 0, protected: 0 },
        { cap: 2, window: 1, main: 1, protected: 1 },
        { cap: 3, window: 1, main: 2, protected: 2 },
        { cap: 4, window: 1, main: 3, protected: 2 },
        { cap: 10, window: 1, main: 9, protected: 7 },
        { cap: 20, window: 1, main: 19, protected: 15 },
        { cap: 64, window: 1, main: 63, protected: 50 },
        { cap: 100, window: 1, main: 99, protected: 79 },
        { cap: 101, window: 1, main: 100, protected: 80 },
        { cap: 200, window: 2, main: 198, protected: 158 },
    ];
    for (const { cap, window, main, protected: pcap } of CASES) {
        const c = new WTinyLfu(cap);
        assert.equal(c._windowCap, window, 'cap ' + cap + ' windowCap');
        assert.equal(c._mainCap, main, 'cap ' + cap + ' mainCap');
        assert.equal(c._protectedCap, pcap, 'cap ' + cap + ' protectedCap');
        assert.equal(main - pcap >= 0, true, 'cap ' + cap + ' probation remainder must be >= 0');
        validate(c);
    }
});

// --- capacity 1/2/3 degenerate edges (D14.4) ----------------------------------

test('capacity 1 (window 1, main 0, protected 0): admission is SKIPPED -- a pure LRU of size 1', () => {
    let evictions = 0;
    const c = new WTinyLfu(1, { onEvict: () => { evictions++; } });
    assert.equal(c._windowCap, 1);
    assert.equal(c._mainCap, 0);
    assert.equal(c._protectedCap, 0);
    c.put('a', 1);
    assert.equal(c.size, 1);
    c.put('b', 2); // no probation victim exists -> the candidate (a) is unconditionally evicted
    assert.equal(c.has('a'), false);
    assert.equal(c.get('b'), 2);
    assert.equal(c.size, 1);
    assert.equal(evictions, 1);
    validate(c);
    // a proven (hit) entry is STILL evicted next -- capacity 1 has no protected region.
    c.get('b');
    c.put('d', 4);
    assert.equal(c.has('b'), false);
    assert.equal(c.get('d'), 4);
    validate(c);
});

test('capacity 2 (window 1, main 1, protected 1, probation 0): admission compares window vs the one probation slot', () => {
    const c = new WTinyLfu(2);
    c.put('a', 1); // window=[a]
    c.put('b', 2); // window=[b], shed a -> probation=[a]
    assert.equal(c._seg[c._store.get('b')], SEG_WINDOW);
    assert.equal(c._seg[c._store.get('a')], SEG_PROBATION);
    validate(c);
    c.put('c', 3); // cand=b (freq1), victim=a (freq1) -> TIE -> reject candidate: b evicted
    assert.equal(c.has('b'), false, 'tie rejects the candidate (favors the incumbent)');
    assert.equal(c.has('a'), true, 'the incumbent probation victim survives a tie');
    assert.equal(c.has('c'), true);
    assert.equal(c.size, 2);
    validate(c);
});

test('capacity 3 (window 1, main 2, protected 2, probation 0): promoting BOTH probation entries empties probation', () => {
    const c = new WTinyLfu(3);
    c.put('a', 1); // window=[a]
    c.put('b', 2); // window=[b], shed a -> probation=[a]
    c.put('c', 3); // window=[c], shed b -> probation=[b,a] (head b, tail a)
    assert.equal(c.size, 3);
    validate(c);
    c.get('b'); // promote b -> protected=[b] (no demotion, size 1 <= cap 2)
    c.get('a'); // promote a -> protected=[b,a] (size 2 == cap 2, no demotion)
    assert.equal(c._prSize, 0, 'probation is now empty');
    assert.equal(c._ptSize, 2, 'protected is exactly at its cap');
    validate(c);
    c.put('d', 4); // cand = window tail = c; victim = probation tail = NIL (empty) -> c evicted unconditionally
    assert.equal(c.has('c'), false, 'the candidate is evicted when there is no probation victim to compare against');
    assert.equal(c.has('a'), true, 'a protected entry is never evicted directly');
    assert.equal(c.has('b'), true, 'a protected entry is never evicted directly');
    assert.equal(c.has('d'), true);
    assert.equal(c.size, 3);
    validate(c);
});

test('small caps 2..9: fill boundaries N-1 / N / N+1, eviction begins exactly at N+1', () => {
    for (let N = 2; N <= 9; N++) {
        let evictions = 0;
        const c = new WTinyLfu(N, { onEvict: () => { evictions++; } });
        for (let i = 0; i < N - 1; i++) c.put(i, i);
        assert.equal(c.size, N - 1);
        assert.equal(evictions, 0);
        validate(c);
        c.put(N - 1, N - 1); // fills exactly
        assert.equal(c.size, N);
        assert.equal(evictions, 0);
        validate(c);
        c.put(N, N); // over capacity -> eviction begins
        assert.equal(c.size, N);
        assert.equal(evictions, 1, 'eviction begins exactly at N+1 (cap ' + N + ')');
        validate(c);
    }
});

// --- admission: candidate vs victim, ties reject, empty-probation rejects -----

test('admission: the candidate wins ONLY when strictly more frequent than the victim', () => {
    const c = new WTinyLfu(4); // window 1, main 3, protected 2, probation 1 (below cap)
    c.put('a', 1); // window=[a]
    c.put('b', 2); // window=[b], shed a -> probation=[a]
    c.put('c', 3); // window=[c], shed b -> probation=[b,a]
    c.put('d', 4); // window=[d], shed c -> probation=[c,b,a]; size 4 == cap
    assert.equal(c.size, 4);
    validate(c);
    // cand = window tail = d (freq 1); victim = probation tail = a (freq 1) -> TIE -> reject.
    const c2 = clone4(c);
    c2.put('e', 5);
    assert.equal(c2.has('d'), false, 'a tie rejects the candidate');
    assert.equal(c2.has('a'), true, 'the incumbent survives a tie');
    validate(c2);

    // Bump d's frequency above a's before the SAME decision -> candidate now wins.
    const c3 = clone4(c);
    c3.get('d'); c3.get('d'); // freq(d) now higher than freq(a)
    c3.put('e', 5);
    assert.equal(c3.has('d'), true, 'a strictly-more-frequent candidate is admitted');
    assert.equal(c3.has('a'), false, 'the victim is evicted when the candidate wins');
    assert.equal(c3._seg[c3._store.get('d')], SEG_PROBATION, 'the admitted candidate lands in probation');
    validate(c3);

    function clone4() {
        const cc = new WTinyLfu(4);
        cc.put('a', 1); cc.put('b', 2); cc.put('c', 3); cc.put('d', 4);
        return cc;
    }
});

test('admission: an empty probation ALWAYS rejects the candidate (no victim to compare against)', () => {
    const c = new WTinyLfu(1); // main 0 -> probation can never hold anything
    c.put('a', 1);
    c.put('b', 2); // no victim exists -> a (the candidate) is evicted unconditionally
    assert.equal(c.has('a'), false);
    assert.equal(c.has('b'), true);
    validate(c);
});

test('_peekVictim: predicts the next eviction WITHOUT mutating any counter, link, size, or the sketch', () => {
    const c = new WTinyLfu(3);
    c.put('a', 1); c.put('b', 2);
    assert.equal(c._peekVictim(), undefined, 'below capacity a new key does not evict');
    c.put('c', 3); // now size == capacity == 3
    const wSize = c._wSize, prSize = c._prSize, ptSize = c._ptSize, size = c.size;
    const wHead = c._wHead, prHead = c._prHead, ptHead = c._ptHead;
    const skSnapshot = c._sk.slice();
    const predicted = c._peekVictim();
    assert.equal(c._wSize, wSize, '_peekVictim must not change wSize');
    assert.equal(c._prSize, prSize, '_peekVictim must not change prSize');
    assert.equal(c._ptSize, ptSize, '_peekVictim must not change ptSize');
    assert.equal(c.size, size, '_peekVictim must not change size');
    assert.equal(c._wHead, wHead, '_peekVictim must not relink the window');
    assert.equal(c._prHead, prHead, '_peekVictim must not relink probation');
    assert.equal(c._ptHead, ptHead, '_peekVictim must not relink protected');
    assert.deepEqual(Array.from(c._sk), Array.from(skSnapshot), '_peekVictim must not touch the sketch');
    validate(c);
    c.put('zzz', 99); // whichever key was predicted must now be gone
    assert.equal(c.has(predicted), false, 'the predicted victim must match the real eviction');
    validate(c);
});

// --- window -> probation -> protected promotion + protected-overflow demotion -

test('law: below capacity, window overflow sheds into PROBATION with no eviction', () => {
    const c = new WTinyLfu(10); // window 1, main 9
    c.put('a', 1);
    assert.equal(c._seg[c._store.get('a')], SEG_WINDOW);
    c.put('b', 2); // window overflow -> a sheds to probation
    assert.equal(c._seg[c._store.get('a')], SEG_PROBATION, 'shed window overflow lands in probation');
    assert.equal(c._seg[c._store.get('b')], SEG_WINDOW);
    assert.equal(c.size, 2);
    validate(c);
});

test('law: a HIT on a WINDOW entry moves it to window MRU (no cross-segment move)', () => {
    const c = new WTinyLfu(1000); // windowCap 10 -- room for an interior window hit
    for (let i = 0; i < 1000; i++) c.put(i, i);
    assert.equal(c._wSize, 10);
    const interior = c._keys[c._next[c._wHead]]; // second-from-head, still window-interior
    c.get(interior);
    assert.equal(c._wHead === c._store.get(interior) ? interior : c._keys[c._wHead], interior,
        'the hit entry became the window head');
    assert.equal(c._seg[c._store.get(interior)], SEG_WINDOW, 'stayed in the WINDOW (no promotion)');
    validate(c);
});

test('law: a HIT on a PROBATION entry PROMOTES it to PROTECTED', () => {
    const c = new WTinyLfu(20); // window 1, main 19, protected 15
    for (let i = 0; i < 20; i++) c.put(i, i); // window sheds overflow -> all but the last land in probation
    let probeKey = -1;
    for (let k = 0; k < 20; k++) {
        const s = c._store.get(k);
        if (s >= 0 && c._seg[s] === SEG_PROBATION) { probeKey = k; break; }
    }
    assert.ok(probeKey >= 0, 'setup invalid: expected a probation entry');
    c.get(probeKey);
    assert.equal(c._seg[c._store.get(probeKey)], SEG_PROTECTED, 'the probation hit promoted to PROTECTED');
    validate(c);
});

test('law: PROTECTED overflow demotes protected\'s LRU back to PROBATION', () => {
    const c = new WTinyLfu(4); // window 1, main 3, protected 2
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4); // probation=[c,b,a] (head..tail)
    assert.equal(c.size, 4);
    c.get('a'); // promote a -> protected=[a] (size 1 <= 2, no demotion)
    c.get('b'); // promote b -> protected=[b,a] (size 2 == 2, no demotion)
    assert.equal(c._ptSize, 2);
    c.get('c'); // promote c -> protected size 3 > cap 2 -> demote protected's LRU (a) back to probation
    assert.equal(c._ptSize, 2, 'protected stays clamped to its cap after a demotion');
    assert.equal(c._prSize, 1, 'the demoted entry landed back in probation');
    assert.equal(c._seg[c._store.get('a')], SEG_PROBATION, 'a was demoted back to probation');
    assert.equal(c._seg[c._store.get('c')], SEG_PROTECTED, 'the newly-promoted c is in protected');
    assert.equal(c._seg[c._store.get('b')], SEG_PROTECTED, 'b was not disturbed by the demotion');
    validate(c);
});

test('law: a HIT on a PROTECTED entry moves it to protected MRU (no demotion, no cross-segment move)', () => {
    const c = new WTinyLfu(20);
    for (let i = 0; i < 20; i++) c.put(i, i);
    c.get(0); c.get(1); c.get(2); // promote three distinct entries into protected
    const ptHeadBefore = c._ptHead;
    // Hit the CURRENT protected tail (not head) -- must relink to protected MRU, stay PROTECTED.
    const tailKey = c._keys[c._ptTail];
    c.get(tailKey);
    assert.equal(c._ptHead, c._store.get(tailKey), 'the protected hit became the protected head');
    assert.equal(c._seg[c._store.get(tailKey)], SEG_PROTECTED, 'stayed in PROTECTED');
    assert.notEqual(c._ptHead, ptHeadBefore);
    validate(c);
});

// --- scan / frequency resistance, as an executable unit test ------------------

test('law: a one-hit-wonder flood leaves via window/probation and NEVER pollutes protected', () => {
    const N = 32;
    const c = new WTinyLfu(N);
    const HOT = 'hot';
    c.put(HOT, 1);
    for (let i = 0; i < 400; i++) c.get(HOT); // build frequency
    for (let i = 0; i < N - 1; i++) c.put('cold' + i, i);
    assert.equal(c.size, N);
    for (let i = 0; i < 3000; i++) {
        assert.equal(c.get(HOT), 1, 'hot key lost at ' + i);
        c.put('scan' + i, i); // a fresh one-hit-wonder every op
        assert.equal(c.size, N);
        // NO one-hit-wonder key is ever promoted to PROTECTED: put() never promotes,
        // and a one-hit-wonder is by definition never get()'d again.
        const s = c._store.get('scan' + i);
        if (s >= 0) assert.notEqual(c._seg[s], SEG_PROTECTED, 'a one-hit-wonder must never reach PROTECTED');
        if ((i & 255) === 0) validate(c);
    }
    assert.equal(c.has(HOT), true, 'the hot key survived the scan (frequency resistance)');
    assert.equal(c._seg[c._store.get(HOT)], SEG_PROTECTED, 'the proven hot key graduated to PROTECTED');
    let survivors = 0;
    for (let i = 0; i < 3000; i++) if (c.has('scan' + i)) survivors++;
    assert.ok(survivors < N, 'cold scan keys were evicted (non-vacuous)');
    validate(c);
});

// --- has/peek are frequency- AND recency-NEUTRAL ------------------------------

test('law: has() and peek() do NOT bump the sketch or relink (visited-neutral, frequency-neutral)', () => {
    const c = new CountedWTinyLfu(20);
    for (let i = 0; i < 20; i++) c.put(i, i);
    let probeKey = -1;
    for (let k = 0; k < 20; k++) {
        const s = c._store.get(k);
        if (s >= 0 && c._seg[s] === SEG_PROBATION) { probeKey = k; break; }
    }
    assert.ok(probeKey >= 0);
    const s = c._store.get(probeKey);
    const freqBefore = c._sketchFreq(c._hashKey(probeKey, s));
    const segBefore = c._seg[s];
    const wHeadBefore = c._wHead, prHeadBefore = c._prHead, ptHeadBefore = c._ptHead;

    c.resetWrites();
    assert.equal(c.has(probeKey), true);
    assert.equal(c.peek(probeKey), probeKey);
    assert.equal(c.writes(), 0, 'has/peek must not relink _next/_prev');

    const freqAfter = c._sketchFreq(c._hashKey(probeKey, s));
    assert.equal(freqAfter, freqBefore, 'has/peek must not bump the sketch');
    assert.equal(c._seg[s], segBefore, 'has/peek must not move the entry between segments');
    assert.equal(c._wHead, wHeadBefore);
    assert.equal(c._prHead, prHeadBefore);
    assert.equal(c._ptHead, ptHeadBefore);
    validate(c);

    // has/peek must not protect the entry from eviction either (no side effect at all).
    // (covered structurally: no relink means it stays exactly where a real hit would not
    // have left it, so eviction order is unaffected by having called has/peek.)
});

test('law: has()/peek() on a MISSING key touch nothing and never throw', () => {
    const c = new CountedWTinyLfu(4);
    c.put('a', 1);
    c.resetWrites();
    assert.equal(c.has('nope'), false);
    assert.equal(c.peek('nope'), undefined);
    assert.equal(c.writes(), 0);
    validate(c);
});

// --- the ONE genuine zero-relink fast path (t6's headline, pinned at unit level) -

test('the window-MRU re-hit relinks NOTHING (the one 0-relink fast path; matches the t6 gate baseline)', () => {
    const cw = new CountedWTinyLfu(8);
    for (let i = 0; i < 8; i++) cw.put(i, i); // key 7 is the window MRU (head)
    cw.resetWrites();
    cw.get(cw._keys[cw._wHead]);
    assert.equal(cw.writes(), WTINYLFU_WRITES_WINDOW_MRU_REHIT);
    assert.equal(cw.writes(), 0);
    validate(cw);
});

// --- delete + segment repair, for EACH segment --------------------------------

test('delete() from WINDOW keeps the cache coherent and reusable', () => {
    const c = new WTinyLfu(20);
    for (let i = 0; i < 20; i++) c.put(i, i);
    const windowKey = c._keys[c._wHead];
    assert.equal(c._seg[c._store.get(windowKey)], SEG_WINDOW);
    assert.equal(c.delete(windowKey), true);
    assert.equal(c.has(windowKey), false);
    validate(c);
    c.put('new-window', 1);
    assert.equal(c.get('new-window'), 1);
    validate(c);
});

test('delete() from PROBATION keeps the cache coherent and reusable', () => {
    const c = new WTinyLfu(20);
    for (let i = 0; i < 20; i++) c.put(i, i);
    let probationKey = -1;
    for (let k = 0; k < 20; k++) {
        const s = c._store.get(k);
        if (s >= 0 && c._seg[s] === SEG_PROBATION) { probationKey = k; break; }
    }
    assert.ok(probationKey >= 0);
    assert.equal(c.delete(probationKey), true);
    assert.equal(c.has(probationKey), false);
    validate(c);
    c.put('new-probation', 1);
    assert.equal(c.get('new-probation'), 1);
    validate(c);
});

test('delete() from PROTECTED keeps the cache coherent and reusable', () => {
    const c = new WTinyLfu(20);
    for (let i = 0; i < 20; i++) c.put(i, i);
    c.get(0); c.get(1); // promote two entries into protected
    let protectedKey = -1;
    for (let k = 0; k < 20; k++) {
        const s = c._store.get(k);
        if (s >= 0 && c._seg[s] === SEG_PROTECTED) { protectedKey = k; break; }
    }
    assert.ok(protectedKey >= 0);
    assert.equal(c.delete(protectedKey), true);
    assert.equal(c.has(protectedKey), false);
    validate(c);
    c.put('new-protected', 1);
    assert.equal(c.get('new-protected'), 1);
    validate(c);
});

test('delete() returns true/false and frees the slot for refill; a duplicate delete returns false', () => {
    const c = new WTinyLfu(4);
    c.put('a', 1); c.put('b', 2); c.put('c', 3);
    assert.equal(c.delete('b'), true);
    assert.equal(c.delete('b'), false, 'duplicate delete (duplicate dispose) returns false');
    assert.equal(c.delete('nope'), false);
    assert.equal(c.size, 2);
    validate(c);
    c.put('d', 4);
    c.put('e', 5);
    assert.equal(c.size, 4);
    assert.equal(c.get('d'), 4);
    assert.equal(c.get('e'), 5);
    validate(c);
});

test('delete() does not touch the sketch (frequency history persists across deletion)', () => {
    const c = new WTinyLfu(20);
    for (let i = 0; i < 20; i++) c.put(i, i);
    const s = c._store.get(0);
    const h = c._hashKey(0, s);
    const freqBefore = c._sketchFreq(h);
    c.delete(0);
    // The sketch cells for a PRIMITIVE key hash by value, not by slot, so the count
    // persists in the sketch even though the key is gone (documented in D14.1/D14.3).
    assert.equal(c._sketchFreq(h), freqBefore, 'the sketch is untouched by delete()');
    validate(c);
});

test('conservation invariant holds after a mixed op stream', () => {
    const c = new WTinyLfu(8);
    let x = 1;
    for (let i = 0; i < 500; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        const k = x % 20;
        const op = x % 5;
        if (op === 0) c.get(k);
        else if (op === 1) c.put(k, i);
        else if (op === 2) c.delete(k);
        else if (op === 3) c.has(k);
        else c.peek(k);
        validate(c);
    }
});

// --- empty-cache reads: no throw, the miss contract ---------------------------

test('an empty (never-filled) cache misses cleanly on get/has/peek/delete (no throw)', () => {
    const c = new WTinyLfu(4);
    assert.equal(c.size, 0);
    assert.equal(c.get('x'), undefined);
    assert.equal(c.has('x'), false);
    assert.equal(c.peek('x'), undefined);
    assert.equal(c.delete('x'), false);
    assert.equal(c._wHead, NIL);
    assert.equal(c._prHead, NIL);
    assert.equal(c._ptHead, NIL);
    validate(c);
});

test('a CLEARED cache misses cleanly on get/has/peek/delete (no throw) and zeroes the sketch', () => {
    const c = new WTinyLfu(4);
    c.put('a', 1); c.put('b', 2);
    c.get('a');
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.get('a'), undefined);
    assert.equal(c.has('a'), false);
    assert.equal(c.peek('a'), undefined);
    assert.equal(c.delete('a'), false);
    assert.equal(c._skSize, 0, 'clear zeroes the sample counter');
    for (let i = 0; i < c._sk.length; i++) assert.equal(c._sk[i], 0, 'clear zeroes the sketch buffer');
    validate(c);
});

// --- clear ----------------------------------------------------------------------

test('clear() empties all three segments, zeroes the sketch, stays reusable', () => {
    const c = new WTinyLfu(20);
    for (let i = 0; i < 20; i++) c.put(i, i);
    c.get(0); c.get(1); // populate protected too
    assert.ok(c._ptSize > 0);
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c._wHead, NIL); assert.equal(c._wTail, NIL); assert.equal(c._wSize, 0);
    assert.equal(c._prHead, NIL); assert.equal(c._prTail, NIL); assert.equal(c._prSize, 0);
    assert.equal(c._ptHead, NIL); assert.equal(c._ptTail, NIL); assert.equal(c._ptSize, 0);
    assert.equal(c._skSize, 0);
    validate(c);
    c.put('x', 42);
    assert.equal(c.get('x'), 42);
    assert.equal(c.size, 1);
    validate(c);
});

test('clear() soak: after EACH clear() in a churn loop, size/free-list/index/sketch reset', () => {
    const c = new WTinyLfu(20);
    for (let cyc = 0; cyc < 50; cyc++) {
        for (let i = 0; i < 20 + cyc % 4; i++) c.put('k' + i, i);
        if (cyc % 2 === 0) { c.get('k0'); c.get('k1'); }
        c.clear();
        assert.equal(c.size, 0, 'cycle ' + cyc + ': size not 0 after clear');
        assert.equal(c._freeListLength(), c._capacity, 'cycle ' + cyc + ': free-list != capacity');
        assert.equal(c._store.indexSize(), 0, 'cycle ' + cyc + ': index size != 0');
        assert.equal(c._skSize, 0, 'cycle ' + cyc + ': sketch sample counter not reset');
        validate(c);
    }
});

// --- aging: halve every nibble in place, deterministically (D14.3) -----------

test('aging: _sketchAge halves every 4-bit counter in place, with no cross-nibble bit-steal', () => {
    const c = new WTinyLfu(4); // skWidth = 4 (smallest pow2 >= 4)
    // Craft one raw Uint32 word with two adjacent nibbles of KNOWN, DIFFERENT values:
    // nibble0 = 15 (saturated), nibble1 = 1 -- so a naive unmasked shift would leak
    // nibble1's low bit into nibble0's top bit (the exact bug the mask prevents).
    c._sk.fill(0);
    c._sk[0] = 0x1f; // binary ...0001 1111 -> nibble0=0xF(15), nibble1=0x1(1)
    c._sketchAge();
    assert.equal(c._sk[0] & 0xf, 7, 'nibble0: floor(15/2) = 7, no contamination from nibble1');
    assert.equal((c._sk[0] >>> 4) & 0xf, 0, 'nibble1: floor(1/2) = 0');
    validate(c);
});

test('aging: halving is symmetric across the whole packed word (every counter independently)', () => {
    const c = new WTinyLfu(4);
    c._sk.fill(0);
    // 8 nibbles per Uint32 word: values 0..7 packed low-to-high.
    let word = 0;
    for (let n = 0; n < 8; n++) word |= (n << (n * 4));
    c._sk[0] = word >>> 0;
    c._sketchAge();
    for (let n = 0; n < 8; n++) {
        const got = (c._sk[0] >>> (n * 4)) & 0xf;
        assert.equal(got, n >> 1, 'nibble ' + n + ': floor(' + n + '/2) = ' + (n >> 1) + ', got ' + got);
    }
    validate(c);
});

test('aging: fires exactly at sampleSize = 10*capacity bumps, and halves _skSize', () => {
    const c = new WTinyLfu(4); // sample = 40
    assert.equal(c._skSample, 40);
    c.put('a', 1); // consumes 1 of the 4 slots, 1 sketchInc
    // Reach-in to the boundary deterministically (mirrors S3Fifo's internal-state tests).
    c._skSize = c._skSample - 1; // one bump away from the aging threshold
    const before = c._sk[0]; // whatever the current packed state is
    c.get('a'); // the sketchInc that crosses the threshold -> ages immediately
    assert.equal(c._skSize, c._skSample >>> 1, '_skSize halves the instant it crosses the threshold');
    validate(c);
});

test('aging matches the oracle deterministically across many aging passes (a differential spot-check)', () => {
    // The oracle halves via `sk[i] = sk[i] >> 1` per flat counter; Lru.js halves via the
    // packed-nibble formula. Drive BOTH through an identical get/put stream (crossing the
    // sample=10*cap threshold many times over) and assert every value/victim/size agrees
    // at every step -- since admission reads sketch frequency directly, any aging drift
    // would show up as a victim or value mismatch immediately.
    const cap = 8; // sample = 80
    const c = new WTinyLfu(cap);
    const o = makeWTinyLfuOracle(cap);
    let x = 0xC0FFEE ^ cap;
    const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x >>> 0; };
    const keyspace = cap * 3 + 2;
    for (let i = 0; i < 5000; i++) { // >> 80*several = many aging passes
        const kind = rnd() % 5;
        const key = rnd() % keyspace;
        const val = rnd() >>> 0;
        let rv, ov;
        if (kind === 0) { rv = c.get(key); ov = o.get(key); }
        else if (kind === 1) { c.put(key, val); o.put(key, val); rv = ov = undefined; }
        else if (kind === 2) { rv = c.delete(key); ov = o.delete(key); }
        else if (kind === 3) { rv = c.has(key); ov = o.has(key); }
        else { rv = c.peek(key); ov = o.peek(key); }
        assert.ok(Object.is(rv, ov), 'value mismatch at op ' + i);
        assert.equal(c.size, o.size(), 'size mismatch at op ' + i);
        assert.equal(c._peekVictim(), o.victim(), 'victim mismatch at op ' + i + ' (depends on sketch/aging state)');
        if ((i & 63) === 0) validate(c);
    }
});

// --- D7: the undefined-value ambiguity, pinned as contract --------------------

test('D7: a stored undefined value is indistinguishable from a miss via get()', () => {
    const c = new WTinyLfu(4);
    c.put('k', undefined);
    assert.equal(c.get('k'), undefined);
    assert.equal(c.get('absent'), undefined);
    assert.equal(c.has('k'), true);
    assert.equal(c.has('absent'), false);
    assert.equal(c.peek('k'), undefined);
    assert.equal(c.peek('absent'), undefined);
    validate(c);
});

// --- SameValueZero key semantics (0/-0, NaN) -----------------------------------

test('keys: 0 and -0 collapse to one entry (SameValueZero)', () => {
    const c = new WTinyLfu(4);
    c.put(0, 'zero');
    c.put(-0, 'neg');
    assert.equal(c.size, 1);
    assert.equal(c.get(0), 'neg');
    assert.equal(c.get(-0), 'neg');
    validate(c);
});

test('keys: NaN is a single usable key', () => {
    const c = new WTinyLfu(4);
    c.put(NaN, 'x');
    c.put(NaN, 'y');
    assert.equal(c.size, 1);
    assert.equal(c.get(NaN), 'y');
    assert.equal(c.has(NaN), true);
    validate(c);
});

// --- fail-closed capacity door (D9) -------------------------------------------

for (const bad of [0, -1, 1.5, NaN, undefined, null, '4', Infinity, -0]) {
    const label = Object.is(bad, -0) ? '-0 (negative zero: an integer equal to 0, still < 1)' : String(bad);
    test('fail-closed: capacity ' + label + ' throws a tagged RangeError', () => {
        assert.throws(() => new WTinyLfu(bad), (err) => {
            assert.ok(err instanceof RangeError);
            assert.match(err.message, /\[lite-lru\]/);
            return true;
        });
    });
}

test('fail-closed: capacity is usable at exactly 1 (the smallest valid integer)', () => {
    const c = new WTinyLfu(1);
    assert.equal(c.capacity, 1);
    validate(c);
});

// --- fail-closed: unknown `keys` option, the did-you-mean door (shared newStore) ---

for (const bad of ['Int', 'INT', 'string', 'map', 0, 1, true, {}, [], null]) {
    test('fail-closed: keys option ' + String(bad) + ' throws a tagged, did-you-mean TypeError', () => {
        assert.throws(() => new WTinyLfu(4, { keys: bad }), (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /unknown keys option/);
            assert.match(err.message, /did you mean 'int'\?/);
            return true;
        });
    });
}

// --- the `keys: 'int'` substrate backing (decisions/0011) rides identically ----

test('int backing: an identical op script observes IDENTICAL results to the default backing', () => {
    const script = [
        ['put', 1, 'A'], ['put', 2, 'B'], ['put', 3, 'C'], ['put', 4, 'D'],
        ['has', 1], ['peek', 2],
        ['get', 1], // build frequency
        ['put', 5, 'E'], // over capacity -> evict via admission compare
        ['put', 1, 'A2'], // may re-enter as a new key (1 was possibly evicted)
        ['has', 2], ['has', 5],
        ['peek', 3],
        ['delete', 3],
        ['delete', 3],
        ['put', 6, 'F'], ['put', 7, 'G'],
        ['get', 6], ['get', 7],
        ['clear'],
        ['put', 8, 'H'], ['get', 8], ['has', 9],
    ];
    function run(useInt) {
        const events = [];
        const c = new WTinyLfu(4, {
            keys: useInt ? 'int' : undefined,
            onEvict: (k, v) => events.push(['evict', k, v]),
        });
        for (const [kind, a, b] of script) {
            if (kind === 'put') { c.put(a, b); events.push(['put', c.size]); }
            else if (kind === 'get') events.push(['get', c.get(a)]);
            else if (kind === 'has') events.push(['has', c.has(a)]);
            else if (kind === 'peek') events.push(['peek', c.peek(a)]);
            else if (kind === 'delete') events.push(['delete', c.delete(a)]);
            else { c.clear(); events.push(['clear', c.size]); }
            validate(c);
        }
        return events;
    }
    assert.deepEqual(run(true), run(false));
});

test('int backing: key 0, -0 collapse, and the int32 domain bounds are valid keys', () => {
    const c = new WTinyLfu(4, { keys: 'int' });
    c.put(0, 'zero');
    c.put(-0, 'neg');
    assert.equal(c.size, 1);
    assert.equal(c.get(0), 'neg');
    c.put(-2147483648, 'min');
    c.put(2147483647, 'max');
    assert.equal(c.get(-2147483648), 'min');
    assert.equal(c.get(2147483647), 'max');
    validate(c);
});

test('int backing: delete() frees the slot for refill; a duplicate delete returns false', () => {
    // Capacity 5 keeps every put in this script BELOW capacity (no admission compare
    // fires), so the assertions pin delete()+refill mechanics only, not policy timing.
    const c = new WTinyLfu(5, { keys: 'int' });
    c.put(1, 1); c.put(2, 2); c.put(3, 3);
    assert.equal(c.delete(2), true);
    assert.equal(c.delete(2), false);
    assert.equal(c.delete(999), false);
    assert.equal(c.size, 2);
    validate(c);
    c.put(4, 4); c.put(5, 5);
    assert.equal(c.size, 4);
    assert.equal(c.get(4), 4);
    assert.equal(c.get(5), 5);
    validate(c);
});

const BAD_INT_KEYS = [1.5, -1.5, 'x', '0', null, undefined, NaN, Infinity, -Infinity,
    -2147483649, 2147483648, {}, [], true];

for (const bad of BAD_INT_KEYS) {
    test('int backing door: key ' + String(bad) + ' throws a [lite-lru]-tagged TypeError on every method', () => {
        const c = new WTinyLfu(4, { keys: 'int' });
        c.put(1, 1);
        const matcher = (err) => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /\[lite-lru\]/);
            assert.match(err.message, /32-bit signed integer/);
            return true;
        };
        assert.throws(() => c.put(bad, 'v'), matcher, 'put');
        assert.throws(() => c.get(bad), matcher, 'get');
        assert.throws(() => c.has(bad), matcher, 'has');
        assert.throws(() => c.peek(bad), matcher, 'peek');
        assert.throws(() => c.delete(bad), matcher, 'delete');
        assert.equal(c.size, 1);
        assert.equal(c.get(1), 1);
        validate(c);
    });
}

test('int backing: conservation invariant holds after a mixed op stream (heavy churn)', () => {
    const c = new WTinyLfu(8, { keys: 'int' });
    let x = 1;
    for (let i = 0; i < 500; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        const k = x % 20;
        const op = x % 5;
        if (op === 0) c.get(k);
        else if (op === 1) c.put(k, i);
        else if (op === 2) c.delete(k);
        else if (op === 3) c.has(k);
        else c.peek(k);
        validate(c);
    }
});

// --- onEvict fire-after + reentrancy (decisions/0002, inherited) ---------------

test('onEvict fires LAST, once, with the cache consistent (size===capacity, victim gone)', () => {
    let calls = 0, sizeDuring = -1, victimPresent = null;
    const c = new WTinyLfu(4, {
        onEvict: (k) => { calls++; sizeDuring = c.size; victimPresent = c.has(k); },
    });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    c.put('e', 5); // ties -> the window candidate (d) is evicted
    assert.equal(calls, 1);
    assert.equal(sizeDuring, 4, 'the callback sees a full, consistent cache');
    assert.equal(victimPresent, false, 'the victim is already gone when the callback fires');
    validate(c);
});

for (const reenter of [
    { name: 'put', fn: (c) => c.put('reentrant', 999) },
    { name: 'get', fn: (c) => c.get('b') },
    { name: 'delete', fn: (c) => c.delete('b') },
    { name: 'clear', fn: (c) => c.clear() },
]) {
    test('onEvict reentrancy: a reentrant ' + reenter.name + '() throws and leaves the cache consistent', () => {
        let fired = 0;
        const c = new WTinyLfu(4, { onEvict: () => { fired++; reenter.fn(c); } });
        c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
        assert.throws(() => c.put('e', 5), /\[lite-lru\].*must not reenter/);
        assert.equal(fired, 1, 'onEvict fired exactly once');
        assert.ok(c.size <= 4, 'size never exceeds capacity');
        assert.equal(c.size, 4);
        validate(c);
    });
}

test('onEvict reads: has() and peek() are ALLOWED inside the callback', () => {
    let ok = true, sawHas, sawPeek;
    const c = new WTinyLfu(4, {
        onEvict: (evictedKey) => {
            try {
                // Probe a SURVIVING key (not the just-evicted one) for a stable read.
                const survivorKey = evictedKey === 'a' ? 'b' : 'a';
                sawHas = c.has(survivorKey);
                sawPeek = c.peek(survivorKey);
            } catch { ok = false; }
        },
    });
    c.put('a', 1); c.put('b', 2); c.put('c', 3); c.put('d', 4);
    c.put('e', 5); // evicts a tie-loser; onEvict reads a survivor
    assert.equal(ok, true);
    assert.equal(sawHas, true);
    validate(c);
});

// --- adversarial: object keys hash by RESIDENT SLOT (D14.1), a documented tradeoff -

test('adversarial: an object key inherits the stale frequency of whatever key vacated its slot (D14.1)', () => {
    // No WeakMap (zero-GC law) -> an object key's sketch coordinate is its SLOT, not a
    // stable per-key identity. Evict a HEAVILY-hit object key, let a BRAND NEW object key
    // take the vacated slot, and observe the newcomer inherit the leftover frequency --
    // this is the documented D14.1 tradeoff, pinned here as executable fact.
    const c = new WTinyLfu(2); // window 1, main 1, protected 1, probation 0
    const hot = { id: 'hot' };
    const cold = { id: 'cold' };
    c.put(hot, 'H'); // window=[hot]
    for (let i = 0; i < 50; i++) c.get(hot); // build frequency heavily
    c.put(cold, 'C'); // window=[cold], shed hot -> probation=[hot]
    const hotSlot = c._store.get(hot);
    const hotFreqBeforeEvict = c._sketchFreq(c._hashKey(hot, hotSlot));
    assert.ok(hotFreqBeforeEvict > 1, 'setup invalid: hot must have built real frequency');

    // Evict hot: cand = window tail = cold (freq low), victim = probation tail = hot
    // (freq high) -> hot wins the compare and SURVIVES; force eviction differently --
    // put a low-frequency candidate that LOSES so `hot` (the high-freq incumbent)
    // is NOT what gets evicted; instead delete it explicitly to free its slot,
    // deterministically reproducing "the slot hot occupied is now vacant + still
    // carries hot's frequency in the sketch" without depending on admission timing.
    assert.equal(c.delete(hot), true);
    assert.equal(c._store.get(hot), -1, 'hot is gone from the index');

    // A BRAND NEW distinct object key, never seen before, takes the vacated slot.
    const fresh = { id: 'fresh-never-seen' };
    c.put(fresh, 'F'); // reuses the freed slot (D6): allocSlot returns the same index
    const freshSlot = c._store.get(fresh);
    assert.equal(freshSlot, hotSlot, 'setup invalid: expected the freed slot to be reused');
    // `fresh`'s OWN put() bumped its slot's sketch by 1 on top of whatever hot left behind.
    const freshFreq = c._sketchFreq(c._hashKey(fresh, freshSlot));
    assert.ok(freshFreq > 1,
        'a brand-new object key inherited a stale frequency (' + freshFreq + ') from the key that ' +
        'vacated its slot -- the documented D14.1 tradeoff, not a bug');
    validate(c);
});

// --- cross-check against the independent W-TinyLFU oracle (both backings) -----

test('both backings match an independent W-TinyLFU oracle over a fuzz stream (caps 1..9, 64)', () => {
    for (const cap of [1, 2, 3, 5, 8, 9, 64]) {
        for (const useInt of [false, true]) {
            const keyspace = cap * 3 + 2;
            const c = new WTinyLfu(cap, useInt ? { keys: 'int' } : undefined);
            const o = makeWTinyLfuOracle(cap);
            let x = (0x1234567 ^ cap) >>> 0;
            const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x >>> 0; };
            for (let i = 0; i < 8000; i++) {
                const kind = rnd() % 5;
                const key = rnd() % keyspace;
                const val = rnd() >>> 0;
                let rv, ov;
                if (kind === 0) { rv = c.get(key); ov = o.get(key); }
                else if (kind === 1) { c.put(key, val); o.put(key, val); rv = ov = undefined; }
                else if (kind === 2) { rv = c.delete(key); ov = o.delete(key); }
                else if (kind === 3) { rv = c.has(key); ov = o.has(key); }
                else { rv = c.peek(key); ov = o.peek(key); }
                assert.ok(Object.is(rv, ov), 'value mismatch at op ' + i + ' (cap=' + cap + ' int=' + useInt + ')');
                assert.equal(c.size, o.size(), 'size mismatch at op ' + i + ' (cap=' + cap + ' int=' + useInt + ')');
                assert.equal(c._peekVictim(), o.victim(), 'victim mismatch at op ' + i + ' (cap=' + cap + ' int=' + useInt + ')');
                validate(c);
            }
        }
    }
});
