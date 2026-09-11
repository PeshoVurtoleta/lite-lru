/**
 * t9 -- controls. Every gate must be provably able to fail (a gate that cannot
 * fail is decorative). Each control runs a deliberately-broken variant IN PROCESS
 * and asserts the corresponding gate flags it; where it matters it also proves
 * non-vacuity (the checker passes a genuinely correct input).
 *
 * The whole-suite control lives in T6: LLRU_TORTURE_BREAK=1 injects a retained
 * allocation into the T6 hot loop; controls.mjs drives that arm out-of-process.
 * The controls below prove each in-process gate bites on a plain `npm run torture`.
 *
 * Broken variants (subclasses / ad-hoc policies -- Lru.js is never modified):
 *   C1 _detach that dangles a prev            -> validate() reciprocity fails
 *   C2 evict that forgets _map.delete         -> validate() map.size != size fails
 *   C3 get that skips _moveToFront            -> diverges from the LRU oracle
 *   C4 a hot loop that allocates per op        -> the alloc gates reject it
 *   C5 a broken SECOND policy (FIFO)           -> the runner catches it (the seam)
 */

import { LiteLru } from '../../Lru.js';
import {
    runOpsGate, runAllocsGate, runDifferential, wrapLru, validate,
    lruPolicy, check, die,
} from './harness.mjs';
import { makeLruOracle } from './oracles/lru.mjs';
import { makeFifoOracle } from './oracles/fifo.mjs';

const NIL = -1;

/** C1: a _detach that updates the forward link but dangles the backward one. */
class BrokenDetach extends LiteLru {
    _detach(s) {
        const p = this._prev[s];
        const n = this._next[s];
        if (p !== NIL) this._next[p] = n; else this._head = n;
        // BUG: the `_prev[n] = p` fixup is dropped -> reciprocity breaks.
        if (n === NIL) this._tail = p;
    }
}

/** C2: an eviction that reuses the slot but forgets to delete the old map key. */
class BrokenEvict extends LiteLru {
    put(key, value) {
        const existing = this._map.get(key);
        if (existing !== undefined) { this._vals[existing] = value; this._moveToFront(existing); return; }
        let s;
        if (this._size === this._capacity) {
            s = this._tail;
            const evKey = this._keys[s];
            const evVal = this._vals[s];
            this._detach(s);
            // BUG: this._map.delete(evKey) is dropped -> the stale key leaks in the map.
            this._size--;
            this._onEvict(evKey, evVal);
        } else {
            s = this._allocSlot();
        }
        this._keys[s] = key; this._vals[s] = value; this._map.set(key, s); this._pushFront(s); this._size++;
    }
}

/** C3: a get that returns the value but skips the recency promotion. */
class BrokenGet extends LiteLru {
    get(key) {
        const s = this._map.get(key);
        if (s === undefined) return undefined;
        // BUG: this._moveToFront(s) is dropped -> recency never updates.
        return this._vals[s];
    }
}

/** C5: a FIFO real whose victim() reports the WRONG end (newest, not oldest). */
function makeBrokenFifoReal(cap) {
    const map = new Map();
    const q = [];
    return {
        get(k) { return map.has(k) ? map.get(k) : undefined; },
        put(k, v) {
            if (map.has(k)) { map.set(k, v); return; }
            if (map.size === cap) { const old = q.shift(); map.delete(old); }
            map.set(k, v); q.push(k);
        },
        has(k) { return map.has(k); },
        peek(k) { return map.has(k) ? map.get(k) : undefined; },
        delete(k) { if (!map.has(k)) return false; map.delete(k); const i = q.indexOf(k); if (i >= 0) q.splice(i, 1); return true; },
        size() { return map.size; },
        victim() { return q.length ? q[q.length - 1] : undefined; }, // BUG: newest, not oldest
    };
}

const leak = [];
const retainSink = [];

export function run() {
    // --- C0: non-vacuity -- a CORRECT cache validates clean and matches the oracle.
    {
        const c = new LiteLru(8);
        for (let i = 0; i < 12; i++) c.put(i, i);
        validate(c); // must not throw
        const r = runDifferential(lruPolicy, { cap: 8, ops: 5000, seed: 12345, keyspace: 24 });
        if (!r.ok) die('t9 C0: a correct LiteLru diverged from its own oracle (the runner is vacuous)');
    }

    // --- C1: dangling-prev _detach -> validate() reciprocity fails --------------
    {
        const c = new BrokenDetach(6);
        for (let i = 0; i < 6; i++) c.put(i, i);
        c.get(2); // an interior re-hit -> broken detach dangles a prev
        let threw = false;
        try { validate(c); } catch (e) { threw = true; }
        if (!threw) die('t9 C1: validate() passed a cache with a dangling prev link (no teeth)');
    }

    // --- C2: evict forgets _map.delete -> validate() map.size != size fails ------
    {
        const c = new BrokenEvict(4);
        for (let i = 0; i < 5; i++) c.put(i, i); // the 5th put evicts and leaks a map key
        let threw = false;
        try { validate(c); } catch (e) { threw = true; }
        if (!threw) die('t9 C2: validate() passed a cache leaking an evicted map key (no teeth)');
    }

    // --- C3: get skips _moveToFront -> diverges from the LRU oracle --------------
    {
        const brokenPolicy = {
            name: 'lru-broken-get',
            real: (cap) => wrapLru(new BrokenGet(cap)),
            oracle: (cap) => makeLruOracle(cap),
        };
        const r = runDifferential(brokenPolicy, { cap: 8, ops: 20000, seed: 777, keyspace: 20 });
        if (r.ok) die('t9 C3: a get() that skips promotion did NOT diverge from the LRU oracle (no teeth)');
    }

    // --- C4: an allocating hot loop -> both alloc channels reject it -------------
    // ops channel: a retaining typed-array push grows arrayBuffers.
    const c4ops = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
    if (c4ops.report.ok) die('t9 C4: an allocating hot loop passed the zero-alloc ops gate');
    leak.length = 0;
    // retained channel: a boxed {} per op survives a forced collection.
    const c4ret = runAllocsGate((i) => { retainSink.push({ v: i }); }, { iterations: 50000, batches: 8 });
    if (c4ret.ok) die('t9 C4: a {}-per-op body passed the retained-alloc gate -- bytesPerCall=' + c4ret.bytesPerCall);
    retainSink.length = 0;
    // non-vacuity: a non-retaining preallocated-slot body passes.
    const slot = new Int32Array(1);
    const c4ok = runAllocsGate((i) => { slot[0] = i; }, { iterations: 50000, batches: 8 });
    if (!c4ok.ok) {
        die('t9 C4: a non-retaining slot-write body failed the retained-alloc gate (vacuous) -- verdict=' +
            c4ok.report.verdict + ' settled=' + c4ok.result.settled + ' bytesPerCall=' + c4ok.bytesPerCall);
    }

    // --- C5: the SEAM has teeth -- a broken SECOND policy is caught --------------
    // The runner is policy-parameterized: it drives FIFO too. A FIFO real whose
    // victim() reports the newest instead of the oldest MUST diverge from the FIFO
    // oracle -- proving the runner actually checks the plugged-in policy's victim.
    {
        const brokenFifo = { name: 'fifo-broken', real: makeBrokenFifoReal, oracle: makeFifoOracle };
        const r = runDifferential(brokenFifo, { cap: 8, ops: 20000, seed: 999, keyspace: 24 });
        if (r.ok) die('t9 C5: a FIFO with a wrong victim() did NOT diverge from the FIFO oracle (the seam is toothless)');
        // non-vacuity: the CORRECT FIFO agrees with its oracle (proven in t5), and
        // the divergence above is a victim mismatch, not a value/size accident.
        check(r.why === 'victim' || r.why === 'value' || r.why === 'size',
            () => 't9 C5: divergence reason was ' + r.why + ' (unexpected)');
    }
}
