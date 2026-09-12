/**
 * t7 -- soak & conservation. ~4096 build-up / tear-down churn cycles.
 *
 * After each cycle: the conservation invariant holds mid-life, and size===0 after
 * clear(). Across cycles the heap is sampled (lite-leak tracker.size() must return
 * to 0) and a WeakRef census proves evicted/cleared VALUE objects are actually
 * collectible -- not merely untracked (the reachability witness size() is not).
 *
 * The retention hazard a cache uniquely has: a freed or evicted slot that keeps
 * pinning a value object the cache no longer owns (_freeSlot / eviction must drop
 * the payload refs). The census is the teeth for that.
 */

import { LiteLru, S3Fifo, WTinyLfu } from '../../Lru.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { check, validate, censusOk, settleGc } from './harness.mjs';

const CYCLES = 4096;
const CAP = 64;

export async function run() {
    const tracker = createLeakTracker({ name: 'lru-soak' });
    const refs = []; // WeakRefs to value objects that SHOULD be collectible after teardown

    let heapFirst = 0;
    let heapLast = 0;

    for (let cyc = 0; cyc < CYCLES; cyc++) {
        const cache = new LiteLru(CAP);
        const h = tracker.track(cache, () => {}, 'cache'); // cleanup must NOT close over cache

        // Build-up PAST capacity so eviction + slot reuse are exercised every cycle.
        for (let i = 0; i < CAP * 2; i++) {
            const val = { c: cyc, i }; // a fresh object per put; most get evicted
            cache.put(i, val);
            if ((cyc & 255) === 0 && (i & 15) === 0) refs.push(new WeakRef(val));
        }
        check(cache.size === CAP, () => 't7: cache not full mid-life (size ' + cache.size + ')');
        validate(cache); // conservation mid-life

        // Scramble recency, then tear down.
        cache.get(0 & 0); cache.get(CAP); cache.get(CAP + 1);
        cache.clear();
        check(cache.size === 0, () => 't7: size != 0 after clear (cycle ' + cyc + ')');
        validate(cache); // conservation after clear
        tracker.untrack(h);

        if (cyc === 0) heapFirst = process.memoryUsage().heapUsed;
        if ((cyc & 511) === 0) {
            globalThis.gc();
            heapLast = process.memoryUsage().heapUsed;
        }
    }

    // The tracker must have released every cycle's registration.
    check(tracker.size() === 0, () => 't7: leak tracker size ' + tracker.size() + ' != 0 after churn');

    // Reachability: after settling, the sampled value objects must be collectible.
    await settleGc(6);
    check(refs.length > 0, () => 't7: census sample was empty (nothing to prove)');
    check(censusOk(refs), () => 't7: every sampled evicted/cleared value is still live -- a retention leak');

    // No unbounded upward retention trend across the run. A fixed-capacity cache
    // that clears each cycle must not grow the heap without bound; allow generous
    // slack for allocator noise but reject a multi-x blowup.
    globalThis.gc();
    const heapEnd = process.memoryUsage().heapUsed;
    check(heapEnd < heapFirst + 64 * 1024 * 1024,
        () => 't7: heap grew from ' + heapFirst + ' to ' + heapEnd + ' across churn (retention trend)');
    void heapLast;

    // --- S3-FIFO soak: churn + conservation + the GHOST-retains-no-values census -
    // (decisions/0013) The unique S3-FIFO hazard: the ghost outlives the entry it
    // fingerprints. It must retain only KEYS (bounded to ghostCap), NEVER values -- a
    // ghost that pinned value objects would be a retention leak the size() witness
    // cannot see. Push distinct integer keys so every eviction records a fresh ghost
    // key, sample the evicted VALUE objects, and prove they are collectible after
    // teardown even though their keys may still sit in the ghost.
    {
        const s3refs = [];
        const s3tracker = createLeakTracker({ name: 's3fifo-soak' });
        for (let cyc = 0; cyc < 1024; cyc++) {
            const cache = new S3Fifo(CAP, { keys: 'int' });
            const h = s3tracker.track(cache, () => {}, 'cache'); // cleanup must NOT close over cache
            for (let i = 0; i < CAP * 3; i++) {
                const val = { c: cyc, i }; // fresh object; most get evicted (key -> ghost)
                cache.put(cyc * 100000 + i, val); // distinct int keys => real ghost churn
                if ((cyc & 63) === 0 && (i & 7) === 0) s3refs.push(new WeakRef(val));
            }
            check(cache.size === CAP, () => 't7 s3fifo: not full mid-life (size ' + cache.size + ')');
            check(cache._gLen <= cache._ghostCap, () => 't7 s3fifo: ghost exceeded bound (' + cache._gLen + ')');
            validate(cache); // conservation mid-life (both rings + ghost bound)
            cache.clear();
            check(cache.size === 0, () => 't7 s3fifo: size != 0 after clear (cycle ' + cyc + ')');
            check(cache._gLen === 0, () => 't7 s3fifo: ghost not empty after clear (cycle ' + cyc + ')');
            validate(cache);
            s3tracker.untrack(h);
        }
        check(s3tracker.size() === 0, () => 't7 s3fifo: leak tracker size ' + s3tracker.size() + ' != 0');
        await settleGc(6);
        check(s3refs.length > 0, () => 't7 s3fifo: census sample was empty (nothing to prove)');
        check(censusOk(s3refs),
            () => 't7 s3fifo: an evicted value is still live -- the ghost is retaining values (leak)');
    }

    // --- W-TinyLFU soak: fill + clear cycles, conservation + value-retention census
    // (decisions/0014) Build each cycle PAST capacity (eviction + slot reuse across all
    // three segments + the sketch bumping/aging), assert conservation mid-life, clear,
    // assert conservation + size 0 + the tracker released, and prove the evicted/cleared
    // VALUE objects are collectible. The sketch retains only PRIMITIVE counts, never a
    // key or value ref -- a WeakMap-free design (D14.1), so nothing pins a value here.
    {
        const wrefs = [];
        const wtracker = createLeakTracker({ name: 'wtinylfu-soak' });
        for (let cyc = 0; cyc < 1024; cyc++) {
            const cache = new WTinyLfu(CAP);
            const h = wtracker.track(cache, () => {}, 'cache'); // cleanup must NOT close over cache
            for (let i = 0; i < CAP * 3; i++) {
                const val = { c: cyc, i }; // fresh object; most get evicted
                cache.put(i, val);
                if ((i & 3) === 0) cache.get(i); // exercise promotion + sketch bumps
                if ((cyc & 63) === 0 && (i & 7) === 0) wrefs.push(new WeakRef(val));
            }
            check(cache.size === CAP, () => 't7 wtinylfu: not full mid-life (size ' + cache.size + ')');
            validate(cache); // conservation mid-life (all three segments + sketch)
            cache.clear();
            check(cache.size === 0, () => 't7 wtinylfu: size != 0 after clear (cycle ' + cyc + ')');
            check(cache._skSize === 0, () => 't7 wtinylfu: sketch not reset after clear (cycle ' + cyc + ')');
            validate(cache);
            wtracker.untrack(h);
        }
        check(wtracker.size() === 0, () => 't7 wtinylfu: leak tracker size ' + wtracker.size() + ' != 0');
        await settleGc(6);
        check(wrefs.length > 0, () => 't7 wtinylfu: census sample was empty (nothing to prove)');
        check(censusOk(wrefs),
            () => 't7 wtinylfu: an evicted/cleared value is still live -- a retention leak');
    }

    // --- TTL soak (decisions/0017): expiry churn + conservation + purgeStale + census
    // Build each cycle PAST capacity under a virtual clock, half the entries with a
    // finite ttl (they expire mid-build) and half never-expire. Assert conservation
    // mid-life (the `_exp` term: free slots read Infinity, the column never grows),
    // purgeStale() reaps every currently-expired resident (and its count is positive
    // across the run -- non-vacuity), no resident is stale afterwards, clear() empties,
    // and every sampled expired/evicted/cleared VALUE object is collectible (the `_exp`
    // column holds primitive timestamps only -- it pins nothing).
    {
        const ttlrefs = [];
        const ttltracker = createLeakTracker({ name: 'ttl-soak' });
        let totalPurged = 0;
        for (let cyc = 0; cyc < 1024; cyc++) {
            let now = 0; const clock = () => now;
            const cache = new LiteLru(CAP, { ttl: 5, clock });
            const h = ttltracker.track(cache, () => {}, 'cache'); // cleanup must NOT close over cache
            for (let i = 0; i < CAP * 2; i++) {
                const val = { c: cyc, i };
                cache.put(i, val, (i & 1) === 0 ? Infinity : 5); // half never, half ttl 5
                if ((cyc & 63) === 0 && (i & 7) === 0) ttlrefs.push(new WeakRef(val));
                now++; // advance the clock so the ttl-5 entries expire within a few ops
            }
            validate(cache); // conservation mid-life incl. the _exp term
            const purged = cache.purgeStale();
            totalPurged += purged;
            validate(cache); // conservation after purge
            // No resident is stale after purgeStale: a subsequent purge reaps zero.
            check(cache.purgeStale() === 0, () => 't7 ttl: purgeStale left stale residents (cycle ' + cyc + ')');
            cache.clear();
            check(cache.size === 0, () => 't7 ttl: size != 0 after clear (cycle ' + cyc + ')');
            validate(cache);
            ttltracker.untrack(h);
        }
        check(ttltracker.size() === 0, () => 't7 ttl: leak tracker size ' + ttltracker.size() + ' != 0');
        check(totalPurged > 0, () => 't7 ttl: purgeStale never reaped anything (vacuous)');
        await settleGc(6);
        check(ttlrefs.length > 0, () => 't7 ttl: census sample was empty (nothing to prove)');
        check(censusOk(ttlrefs),
            () => 't7 ttl: an expired/evicted/cleared value is still live -- the _exp column is retaining values');
    }
}
