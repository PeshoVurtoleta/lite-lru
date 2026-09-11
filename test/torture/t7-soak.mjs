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

import { LiteLru } from '../../Lru.js';
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
}
