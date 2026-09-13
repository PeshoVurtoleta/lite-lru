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

import { LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu } from '../../Lru.js';
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

    // --- Slru soak (decisions/0015): build/clear cycles + conservation + census --
    // Build each cycle PAST capacity (eviction + slot reuse across probation + protected,
    // with 2-hit promotions), assert conservation mid-life, clear, assert size 0 + the
    // free list restored + the tracker released, and prove the evicted/cleared VALUE
    // objects are collectible. size()===0 and _freeListLength()===capacity each cycle.
    {
        const lrefs = [];
        const ltracker = createLeakTracker({ name: 'slru-soak' });
        for (let cyc = 0; cyc < 1024; cyc++) {
            const cache = new Slru(CAP);
            const h = ltracker.track(cache, () => {}, 'cache'); // cleanup must NOT close over cache
            for (let i = 0; i < CAP * 3; i++) {
                const val = { c: cyc, i };
                cache.put(i, val);
                if ((i & 1) === 0) { cache.get(i); cache.get(i); } // promote some to protected
                if ((cyc & 63) === 0 && (i & 7) === 0) lrefs.push(new WeakRef(val));
            }
            check(cache.size === CAP, () => 't7 slru: not full mid-life (size ' + cache.size + ')');
            validate(cache); // conservation mid-life (both segments)
            cache.clear();
            check(cache.size === 0, () => 't7 slru: size != 0 after clear (cycle ' + cyc + ')');
            check(cache._freeListLength() === CAP, () => 't7 slru: free list != capacity after clear (cycle ' + cyc + ')');
            validate(cache);
            ltracker.untrack(h);
        }
        check(ltracker.size() === 0, () => 't7 slru: leak tracker size ' + ltracker.size() + ' != 0');
        await settleGc(6);
        check(lrefs.length > 0, () => 't7 slru: census sample was empty (nothing to prove)');
        check(censusOk(lrefs), () => 't7 slru: an evicted/cleared value is still live -- a retention leak');
    }

    // --- TwoQ soak (decisions/0015): build/clear cycles + the GHOST-retains-no-values
    // census. The A1out ghost fingerprints A1in-evicted keys; it must retain only KEYS
    // (bounded to ghostCap), NEVER values. Push distinct int keys so every A1in eviction
    // records a fresh ghost key, sample the evicted VALUE objects, and prove they are
    // collectible after teardown even though their keys may still sit in the ghost.
    {
        const qrefs = [];
        const qtracker = createLeakTracker({ name: 'twoq-soak' });
        for (let cyc = 0; cyc < 1024; cyc++) {
            const cache = new TwoQ(CAP, { keys: 'int' });
            const h = qtracker.track(cache, () => {}, 'cache'); // cleanup must NOT close over cache
            for (let i = 0; i < CAP * 3; i++) {
                const val = { c: cyc, i };
                cache.put(cyc * 100000 + i, val); // distinct int keys => real ghost churn
                if ((cyc & 63) === 0 && (i & 7) === 0) qrefs.push(new WeakRef(val));
            }
            check(cache.size === CAP, () => 't7 twoq: not full mid-life (size ' + cache.size + ')');
            check(cache._gLen <= cache._ghostCap, () => 't7 twoq: ghost exceeded bound (' + cache._gLen + ')');
            validate(cache); // conservation mid-life (both queues + ghost bound)
            cache.clear();
            check(cache.size === 0, () => 't7 twoq: size != 0 after clear (cycle ' + cyc + ')');
            check(cache._freeListLength() === CAP, () => 't7 twoq: free list != capacity after clear (cycle ' + cyc + ')');
            check(cache._gLen === 0, () => 't7 twoq: ghost not empty after clear (cycle ' + cyc + ')');
            validate(cache);
            qtracker.untrack(h);
        }
        check(qtracker.size() === 0, () => 't7 twoq: leak tracker size ' + qtracker.size() + ' != 0');
        await settleGc(6);
        check(qrefs.length > 0, () => 't7 twoq: census sample was empty (nothing to prove)');
        check(censusOk(qrefs),
            () => 't7 twoq: an evicted value is still live -- the A1out ghost is retaining values (leak)');
    }

    // --- Arc soak (decisions/0016): build/clear cycles + the GHOST-retains-no-values
    // census. The two ghosts B1/B2 fingerprint evicted keys; they must retain only KEYS
    // (bounded so |B1|+|B2| <= c), NEVER values. Push distinct int keys so every eviction
    // records a fresh ghost key, sample the evicted VALUE objects, and prove they are
    // collectible after teardown even though their keys may still sit in a ghost. Each
    // cycle: conservation mid-life (both lists + both ghost bounds), size 0 + free list
    // restored + ghosts empty + p reset after clear.
    {
        const arefs = [];
        const atracker = createLeakTracker({ name: 'arc-soak' });
        for (let cyc = 0; cyc < 1024; cyc++) {
            const cache = new Arc(CAP, { keys: 'int' });
            const h = atracker.track(cache, () => {}, 'cache'); // cleanup must NOT close over cache
            for (let i = 0; i < CAP * 3; i++) {
                const val = { c: cyc, i };
                cache.put(cyc * 100000 + i, val); // distinct int keys => real ghost churn
                if ((i & 1) === 0) cache.get(cyc * 100000 + i); // promote some to T2
                if ((cyc & 63) === 0 && (i & 7) === 0) arefs.push(new WeakRef(val));
            }
            check(cache.size === CAP, () => 't7 arc: not full mid-life (size ' + cache.size + ')');
            check(cache._b1._len + cache._b2._len <= cache._ghostCap, () => 't7 arc: combined ghost exceeded bound');
            check(cache._t1Size + cache._b1._len <= cache._ghostCap, () => 't7 arc: |T1|+|B1| exceeded bound');
            validate(cache); // conservation mid-life (both lists + both ghost bounds)
            cache.clear();
            check(cache.size === 0, () => 't7 arc: size != 0 after clear (cycle ' + cyc + ')');
            check(cache._freeListLength() === CAP, () => 't7 arc: free list != capacity after clear (cycle ' + cyc + ')');
            check(cache._b1._len === 0 && cache._b2._len === 0, () => 't7 arc: ghosts not empty after clear (cycle ' + cyc + ')');
            check(cache._p === 0, () => 't7 arc: p not reset after clear (cycle ' + cyc + ')');
            validate(cache);
            atracker.untrack(h);
        }
        check(atracker.size() === 0, () => 't7 arc: leak tracker size ' + atracker.size() + ' != 0');
        await settleGc(6);
        check(arefs.length > 0, () => 't7 arc: census sample was empty (nothing to prove)');
        check(censusOk(arefs),
            () => 't7 arc: an evicted value is still live -- a B1/B2 ghost is retaining values (leak)');
    }

    // --- Lirs soak (decisions/0023): build/clear cycles + the HISTORY-retains-no-values
    // census. The bounded non-resident history fingerprints evicted keys; it must retain
    // only KEYS (bounded so hist._len <= capacity), NEVER values. Push distinct int keys so
    // every eviction records a fresh history key, sample the evicted VALUE objects, and prove
    // they are collectible after teardown even though their keys may still sit in the history.
    // Each cycle: conservation mid-life (|LIR|+|resident HIR|==size, history bounded, stack
    // coherent), then size 0 + free list restored + history empty after clear.
    {
        const lrefs = [];
        const ltracker = createLeakTracker({ name: 'lirs-soak' });
        for (let cyc = 0; cyc < 1024; cyc++) {
            const cache = new Lirs(CAP, { keys: 'int' });
            const h = ltracker.track(cache, () => {}, 'cache'); // cleanup must NOT close over cache
            for (let i = 0; i < CAP * 3; i++) {
                const val = { c: cyc, i };
                cache.put(cyc * 100000 + i, val); // distinct int keys => real history churn
                if ((i & 1) === 0) cache.get(cyc * 100000 + i); // exercise the access policy
                if ((cyc & 63) === 0 && (i & 7) === 0) lrefs.push(new WeakRef(val));
            }
            check(cache.size === CAP, () => 't7 lirs: not full mid-life (size ' + cache.size + ')');
            check(cache._hist._len <= CAP, () => 't7 lirs: history exceeded bound');
            validate(cache); // conservation mid-life (split + stack + history bound)
            cache.clear();
            check(cache.size === 0, () => 't7 lirs: size != 0 after clear (cycle ' + cyc + ')');
            check(cache._freeListLength() === CAP, () => 't7 lirs: free list != capacity after clear (cycle ' + cyc + ')');
            check(cache._hist._len === 0, () => 't7 lirs: history not empty after clear (cycle ' + cyc + ')');
            check(cache._lirCount === 0 && cache._sTop === -1 && cache._qHead === -1,
                () => 't7 lirs: stack/Q/LIR state not reset after clear (cycle ' + cyc + ')');
            validate(cache);
            ltracker.untrack(h);
        }
        check(ltracker.size() === 0, () => 't7 lirs: leak tracker size ' + ltracker.size() + ' != 0');
        await settleGc(6);
        check(lrefs.length > 0, () => 't7 lirs: census sample was empty (nothing to prove)');
        check(censusOk(lrefs),
            () => 't7 lirs: an evicted value is still live -- the non-resident history is retaining values (leak)');
    }

    // --- Lfu soak (decisions/0024): build/clear cycles + the BUCKET-POOL-conservation +
    // no-retention census. The frequency-churn stream drives buckets being created,
    // relabelled and destroyed; the bucket pool must stay conserved (live + free == cap)
    // and NEVER grow, and no evicted VALUE object may outlive its cycle (the bucket columns
    // hold only integer ids + Float64 frequencies -- they pin nothing).
    {
        const frefs = [];
        const ftracker = createLeakTracker({ name: 'lfu-soak' });
        let bFreqBytes = -1;
        for (let cyc = 0; cyc < 1024; cyc++) {
            const cache = new Lfu(CAP, { keys: 'int' });
            if (bFreqBytes < 0) bFreqBytes = cache._bFreq.buffer.byteLength;
            const h = ftracker.track(cache, () => {}, 'cache'); // cleanup must NOT close over cache
            for (let i = 0; i < CAP * 3; i++) {
                const val = { c: cyc, i };
                cache.put(cyc * 100000 + i, val);           // distinct int keys => real eviction churn
                if ((i & 1) === 0) cache.get(cyc * 100000 + i); // frequency churn (create/relabel buckets)
                if ((cyc & 63) === 0 && (i & 7) === 0) frefs.push(new WeakRef(val));
            }
            check(cache.size === CAP, () => 't7 lfu: not full mid-life (size ' + cache.size + ')');
            check(cache._bFreq.buffer.byteLength === bFreqBytes, () => 't7 lfu: _bFreq buffer grew (bucket pool not fixed)');
            validate(cache); // conservation mid-life (bucket list + pool + exact freqs)
            cache.clear();
            check(cache.size === 0, () => 't7 lfu: size != 0 after clear (cycle ' + cyc + ')');
            check(cache._freeListLength() === CAP, () => 't7 lfu: free list != capacity after clear (cycle ' + cyc + ')');
            check(cache._bMin === -1, () => 't7 lfu: bucket list not empty after clear (cycle ' + cyc + ')');
            validate(cache);
            ftracker.untrack(h);
        }
        check(ftracker.size() === 0, () => 't7 lfu: leak tracker size ' + ftracker.size() + ' != 0');
        await settleGc(6);
        check(frefs.length > 0, () => 't7 lfu: census sample was empty (nothing to prove)');
        check(censusOk(frefs),
            () => 't7 lfu: an evicted value is still live -- a bucket column is retaining values (leak)');
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

    // --- Snapshot soak (decisions/0021): 4096 dump/restore cycles conserve + no leak
    // Each cycle: churn a member PAST capacity, validate, dump, structuredClone, restore,
    // validate the restore, confirm size parity, exercise the restored cache, then drop
    // BOTH caches and the snapshot. The tracker (registered on the original each cycle)
    // must return to 0 -- neither dump()'s captured value refs nor restore()'s fresh
    // instance may outlive the cycle. A WeakRef census proves the sampled value objects
    // (held only via the caches / the snapshot during the cycle) are collectible after
    // teardown -- a snapshot that pinned values past its own lifetime is a leak.
    {
        const snaptracker = createLeakTracker({ name: 'snapshot-soak' });
        const srefs = [];
        const MEM = [LiteLru, Sieve, S3Fifo, WTinyLfu, Slru, TwoQ, Arc, Lirs, Lfu];
        for (let cyc = 0; cyc < 4096; cyc++) {
            const C = MEM[cyc % MEM.length];
            const cache = new C(CAP, { keys: 'int' });
            const h = snaptracker.track(cache, () => {}, 'cache'); // cleanup must NOT close over cache
            for (let i = 0; i < CAP * 2; i++) {
                const val = { c: cyc, i };
                cache.put(cyc * 100000 + i, val); // distinct int keys within int32 range
                if ((cyc & 511) === 0 && (i & 31) === 0) srefs.push(new WeakRef(val));
            }
            check(cache.size === CAP, () => 't7 snap: not full mid-life (size ' + cache.size + ')');
            validate(cache);
            const restored = C.restore(structuredClone(cache.dump()), { keys: 'int' });
            check(restored.size === cache.size, () => 't7 snap: restored size drift (cycle ' + cyc + ')');
            validate(restored);
            for (let i = 0; i < 8; i++) restored.put(-1 - i, { c: cyc, r: i }); // exercise the restore
            validate(restored);
            // Lfu-specific (decisions/0024, planner assertion #4): the ORIGINAL cache (its
            // dump() already captured into `restored` above) is also clear()-ed in this same
            // 4096-cycle dump/restore path, so every Lfu cycle here exercises dump/restore AND
            // clear together -- mirroring the dedicated 1024-cycle Lfu soak's explicit checks
            // (not just validate()'s internal term 13): the bucket list empties (`_bMin===-1`),
            // the slot free list returns to capacity, and the bucket-pool free STACK length
            // (walked standalone, not inferred from validate()'s conservation term) also
            // returns to exactly `CAP`.
            if (C === Lfu) {
                cache.clear();
                check(cache.size === 0, () => 't7 snap: lfu cache not empty after clear (cycle ' + cyc + ')');
                check(cache._bMin === -1, () => 't7 snap: lfu bucket list not empty after clear (cycle ' + cyc + ')');
                check(cache._freeListLength() === CAP,
                    () => 't7 snap: lfu free list != capacity after clear (cycle ' + cyc + ')');
                let lfuFreeBuckets = 0;
                for (let b = cache._bFreeHead; b !== -1; b = cache._bNext[b]) lfuFreeBuckets++;
                check(lfuFreeBuckets === CAP,
                    () => 't7 snap: lfu bucket-pool free length ' + lfuFreeBuckets + ' != capacity ' + CAP + ' after clear (cycle ' + cyc + ')');
                validate(cache);
            }
            snaptracker.untrack(h);
        }
        check(snaptracker.size() === 0, () => 't7 snap: leak tracker size ' + snaptracker.size() + ' != 0 after churn');
        await settleGc(6);
        check(srefs.length > 0, () => 't7 snap: census sample was empty (nothing to prove)');
        check(censusOk(srefs),
            () => 't7 snap: a value captured by a dropped snapshot/cache is still live -- a retention leak');
    }
}
