/**
 * t5 -- differential fuzz through the PARAMETERIZED runner (the seam).
 *
 * 100k mixed ops (get/put/delete/has/peek) against the brute oracle: same value
 * returned AND same next-eviction victim AND same live size after every op. On
 * divergence the runner returns a record; this tier prints the seed + op index so
 * the case replays via  TORTURE_SEED=<n> node --expose-gc test/torture.mjs.
 *
 * THREE policies are driven, proving the runner is policy-parameterized (not a
 * single-policy harness): classic LRU on the DEFAULT Map backing, classic LRU on
 * the INTEGER substrate backing (`keys: 'int'`) -- BOTH against the SAME lru oracle
 * so the substrate is byte-identical (decisions/0011) -- and FIFO (real Map+queue
 * vs brute array oracle). A future member is a fourth line.
 */

import {
    runDifferential, lruPolicy, lruIntPolicy, fifoPolicy,
    sievePolicy, sieveIntPolicy, s3fifoPolicy, s3fifoIntPolicy,
    wtinylfuPolicy, wtinylfuIntPolicy,
    slruPolicy, slruIntPolicy, twoqPolicy, twoqIntPolicy,
    arcPolicy, arcIntPolicy,
    lirsPolicy, lirsIntPolicy,
    lfuPolicy, lfuIntPolicy,
    clockProPolicy, clockProIntPolicy,
    lrukPolicy, lrukIntPolicy,
    mqPolicy, mqIntPolicy,
    carPolicy, carIntPolicy,
    lruTtlPolicy, sieveTtlPolicy, s3fifoTtlPolicy, wtinylfuTtlPolicy,
    slruTtlPolicy, twoqTtlPolicy, arcTtlPolicy, lirsTtlPolicy, lfuTtlPolicy, clockProTtlPolicy, lrukTtlPolicy, mqTtlPolicy, carTtlPolicy,
    SNAP_MEMBERS, runRoundTrip,
    SEED, die,
} from './harness.mjs';

const OPS = 100000;

/** Run one policy across several capacities and keyspaces; die on any divergence. */
function fuzzPolicy(policy, configs) {
    for (let ci = 0; ci < configs.length; ci++) {
        const cfg = configs[ci];
        const seed = (SEED ^ cfg.salt) >>> 0 || 1;
        const r = runDifferential(policy, { cap: cfg.cap, ops: cfg.ops, seed, keyspace: cfg.keyspace, ttl: cfg.ttl });
        if (!r.ok) {
            die('t5 ' + policy.name + ' diverged at op ' + r.i + ' (' + r.why + '): real=' +
                String(r.real) + ' oracle=' + String(r.oracle) + ' key=' + String(r.key) +
                ' kind=' + r.kind + ' cap=' + cfg.cap + ' keyspace=' + cfg.keyspace +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs');
        }
    }
}

export function run() {
    // Keyspace tuned so hits and evictions both happen often: keyspace ~ 2..4x cap.
    const lruConfigs = [
        { cap: 1, keyspace: 4, ops: OPS, salt: 0x51 },   // degenerate cap-1
        { cap: 8, keyspace: 24, ops: OPS, salt: 0x52 },
        { cap: 64, keyspace: 200, ops: OPS, salt: 0x53 },
        { cap: 256, keyspace: 300, ops: OPS, salt: 0x54 }, // high hit rate
    ];
    fuzzPolicy(lruPolicy, lruConfigs);

    // The SUBSTRATE proof (decisions/0011): the integer open-addressed backing is
    // driven across the SAME corpus against the SAME lru oracle -- identical values
    // + victims. Keys are `prng() % keyspace` (non-negative int32), valid int-mode.
    fuzzPolicy(lruIntPolicy, lruConfigs);

    // The MEMBER proof (decisions/0012): SIEVE on BOTH backings against its own
    // independent oracle -- same value AND same next victim AND same size after
    // every op. The int backing rides the SAME strict-zero substrate.
    fuzzPolicy(sievePolicy, lruConfigs);
    fuzzPolicy(sieveIntPolicy, lruConfigs);

    // The S3-FIFO MEMBER proof (decisions/0013): admission control on BOTH backings
    // against its own independent three-structure oracle -- same value AND same next
    // victim AND same size after every op. The int backing also exercises the
    // strict-zero ghost ring + membership table. Caps 1..9 stress the small-cap
    // rounding + the mainCap==0 / ghostCap==0 degenerate edges (D13); 64 is a normal
    // split (smallCap 6 / mainCap 58) where graduation + ghost admission both fire.
    const s3Configs = [];
    for (let cap = 1; cap <= 9; cap++) {
        s3Configs.push({ cap, keyspace: cap * 3 + 2, ops: OPS, salt: 0x70 + cap });
    }
    s3Configs.push({ cap: 64, keyspace: 200, ops: OPS, salt: 0x7f });
    fuzzPolicy(s3fifoPolicy, s3Configs);
    fuzzPolicy(s3fifoIntPolicy, s3Configs);

    // The W-TinyLFU MEMBER proof (decisions/0014): window + SLRU + count-min sketch on
    // BOTH backings against its own independent oracle -- same value AND same next
    // victim AND same size after every op, including the frequency-driven admission
    // decision and >=1 sketch aging pass (sample = 10*cap). Caps 1..9 stress the
    // window/protected rounding + the main==0 degenerate edge (D14.4); 64 is a normal
    // split (window 1 / protected 50 / probation 13) where admission + promotion +
    // aging all fire.
    const wConfigs = [];
    for (let cap = 1; cap <= 9; cap++) {
        wConfigs.push({ cap, keyspace: cap * 3 + 2, ops: OPS, salt: 0x90 + cap });
    }
    wConfigs.push({ cap: 64, keyspace: 200, ops: OPS, salt: 0x9f });
    fuzzPolicy(wtinylfuPolicy, wConfigs);
    fuzzPolicy(wtinylfuIntPolicy, wConfigs);

    // The Slru MEMBER proof (decisions/0015): the Segmented-LRU member on BOTH backings
    // against its own independent probation/protected oracle -- same value AND same next
    // victim AND same size after every op. Caps 1..9 stress the 80/20 rounding + the
    // protectedCap==capacity degenerate edge (cap 1/2); 64 is a normal split
    // (protectedCap 51 / probation 13) where the promote-on-2nd-hit + demote both fire.
    const slruConfigs = [];
    for (let cap = 1; cap <= 9; cap++) {
        slruConfigs.push({ cap, keyspace: cap * 3 + 2, ops: OPS, salt: 0xb0 + cap });
    }
    slruConfigs.push({ cap: 64, keyspace: 200, ops: OPS, salt: 0xbf });
    fuzzPolicy(slruPolicy, slruConfigs);
    fuzzPolicy(slruIntPolicy, slruConfigs);

    // The TwoQ MEMBER proof (decisions/0015): the full-2Q member on BOTH backings against
    // its own independent A1in/Am/A1out-ghost oracle -- same value AND same next victim
    // AND same size after every op. The int backing also exercises the strict-zero A1out
    // ghost ring + membership table. Caps 1..9 stress the 25% rounding + the ghostCap==0
    // (cap 1) degenerate edge; 64 is a normal split (a1inCap 16 / amCap 48 / ghost 48).
    const twoqConfigs = [];
    for (let cap = 1; cap <= 9; cap++) {
        twoqConfigs.push({ cap, keyspace: cap * 3 + 2, ops: OPS, salt: 0xc0 + cap });
    }
    twoqConfigs.push({ cap: 64, keyspace: 200, ops: OPS, salt: 0xcf });
    fuzzPolicy(twoqPolicy, twoqConfigs);
    fuzzPolicy(twoqIntPolicy, twoqConfigs);

    // The Arc MEMBER proof (decisions/0016): the adaptive member on BOTH backings against
    // its own independent two-list/two-ghost/`p` oracle -- same value AND same next victim
    // AND same size after every op, including the `p` adaptation on B1/B2 ghost hits and the
    // REPLACE boundary. The int backing also exercises the strict-zero B1/B2 ghost rings +
    // membership tables. Caps 1..9 stress the degenerate small caps (ghost sizing, the
    // |T1|==c direct-evict edge); 64 is a normal split where both ghosts + p adaptation fire.
    const arcConfigs = [];
    for (let cap = 1; cap <= 9; cap++) {
        arcConfigs.push({ cap, keyspace: cap * 3 + 2, ops: OPS, salt: 0xd0 + cap });
    }
    arcConfigs.push({ cap: 64, keyspace: 200, ops: OPS, salt: 0xdf });
    fuzzPolicy(arcPolicy, arcConfigs);
    fuzzPolicy(arcIntPolicy, arcConfigs);

    // The Lirs MEMBER proof (decisions/0023): the LIRS member on BOTH backings against its
    // own independent stack-S / Q / bounded-history oracle -- same value AND same next victim
    // AND same size after every op, including the resident-HIR-in-S promotion, the bottom-LIR
    // demotion, stack pruning, and the bounded non-resident history (drop-oldest). Caps 1..9
    // stress the L_hir=max(1,round(cap*0.01)) split incl. cap 1 -> L_lir 0 (all-HIR window);
    // 64/256 exercise a normal split where promotion + demotion + pruning all fire.
    const lirsConfigs = [];
    for (let cap = 1; cap <= 9; cap++) {
        lirsConfigs.push({ cap, keyspace: cap * 3 + 2, ops: OPS, salt: 0xe0 + cap });
    }
    lirsConfigs.push({ cap: 64, keyspace: 200, ops: OPS, salt: 0xef });
    lirsConfigs.push({ cap: 256, keyspace: 300, ops: OPS, salt: 0xe1f });
    fuzzPolicy(lirsPolicy, lirsConfigs);
    fuzzPolicy(lirsIntPolicy, lirsConfigs);

    // The Lfu MEMBER proof (decisions/0024): the exact-LFU member on BOTH backings against
    // its own independent exact-frequency + LRU-tie-break oracle -- same value AND same next
    // victim AND same size after every op. Caps 1..9 stress degenerate buckets (cap 1 -> one
    // key whose frequency climbs unboundedly, bucket relabel fast path); 64/256 exercise many
    // coexisting frequency buckets with promotions, in-place relabels, and min-bucket eviction.
    const lfuConfigs = [];
    for (let cap = 1; cap <= 9; cap++) {
        lfuConfigs.push({ cap, keyspace: cap * 3 + 2, ops: OPS, salt: 0xf0 + cap });
    }
    lfuConfigs.push({ cap: 64, keyspace: 200, ops: OPS, salt: 0xff });
    lfuConfigs.push({ cap: 256, keyspace: 300, ops: OPS, salt: 0xf1f });
    fuzzPolicy(lfuPolicy, lfuConfigs);
    fuzzPolicy(lfuIntPolicy, lfuConfigs);

    // The ClockPro MEMBER proof (decisions/0025): the CLOCK-approximation-of-LIRS member on
    // BOTH backings against its own independent clock/three-hand/bounded-history oracle -- same
    // value AND same next victim AND same live size after every op, including the reference-bit
    // second chance, HAND_cold promotion of a referenced test page, HAND_hot demotion, the
    // HAND_test test-period expiry (which lowers _mHot), the bounded non-resident history
    // re-admit (which raises _mHot), and the eviction victim from the non-destructive sweep
    // twin. The int backing also exercises the strict-zero history ring + membership table.
    // Caps 1..10 stress the degenerate small caps (cap 1 -> the all-cold single-page window,
    // and the "no cold victim -> demote a hot page" guard); 64/256 exercise a normal split
    // where promotion + demotion + both adaptations all fire.
    const clockProConfigs = [];
    for (let cap = 1; cap <= 10; cap++) {
        clockProConfigs.push({ cap, keyspace: cap * 3 + 2, ops: OPS, salt: 0x1a0 + cap });
    }
    clockProConfigs.push({ cap: 64, keyspace: 200, ops: OPS, salt: 0x1af });
    clockProConfigs.push({ cap: 256, keyspace: 300, ops: OPS, salt: 0x1a1f });
    fuzzPolicy(clockProPolicy, clockProConfigs);
    fuzzPolicy(clockProIntPolicy, clockProConfigs);

    // The LruK MEMBER proof (decisions/0026): the LRU-K (K=2) member on BOTH backings against
    // its own independent cold/warm/reference-time/bounded-history oracle -- same value AND same
    // next victim AND same live size after every op, including the cold->warm promotion, the
    // cold-tail (infinite-K-distance) eviction, the all-warm min-r1 scan victim, and the bounded
    // history WARM re-admit. The int backing also exercises the strict-zero history ring +
    // membership table. Caps 1..9 stress the degenerate small caps (cap 1 -> the single-page
    // window; the all-warm-no-cold min-r1 scan); 64 exercises a normal cold/warm split.
    const lrukConfigs = [];
    for (let cap = 1; cap <= 9; cap++) {
        lrukConfigs.push({ cap, keyspace: cap * 3 + 2, ops: OPS, salt: 0x2b0 + cap });
    }
    lrukConfigs.push({ cap: 64, keyspace: 200, ops: OPS, salt: 0x2bf });
    fuzzPolicy(lrukPolicy, lrukConfigs);
    fuzzPolicy(lrukIntPolicy, lrukConfigs);

    // The Mq MEMBER proof (decisions/0027): the Multi-Queue (m=8) member on BOTH backings against
    // its own independent 8-band/refcount/logical-clock/bounded-Qout oracle -- same value AND same
    // next victim AND same live size after every op, including the re-band move-to-band-MRU, the
    // fixed 7-step aging demotion (band decay), the lowest-queue-tail eviction, and the bounded
    // Qout refcount-preserving re-admit. The int backing also exercises the strict-zero Qout ring
    // + its parallel refcount ring + membership table. Caps 1..9 stress the degenerate small caps
    // (short lifeTime -> frequent demotions); 64 exercises a normal multi-band spread.
    const mqConfigs = [];
    for (let cap = 1; cap <= 9; cap++) {
        mqConfigs.push({ cap, keyspace: cap * 3 + 2, ops: OPS, salt: 0x3c0 + cap });
    }
    mqConfigs.push({ cap: 64, keyspace: 200, ops: OPS, salt: 0x3cf });
    fuzzPolicy(mqPolicy, mqConfigs);
    fuzzPolicy(mqIntPolicy, mqConfigs);

    // The Car MEMBER proof (decisions/0028): the CLOCK-reformulation-of-ARC member on BOTH
    // backings against its own independent two-clock/two-ghost/`p` oracle -- same value AND same
    // next victim AND same live size after every op, including the reference-bit second chance,
    // the T1-survivor migration to T2, the T2 rotation, the `p` adaptation on B1/B2 ghost hits,
    // the directory trim, and the eviction victim from the non-destructive sweep twin. The int
    // backing also exercises the strict-zero B1/B2 ghost rings + membership tables. Caps 1..9
    // stress the degenerate small caps (ghost sizing, the empty-clock REPLACE fallback); 64/256
    // exercise a normal split where both clocks + both ghosts + p adaptation all fire.
    const carConfigs = [];
    for (let cap = 1; cap <= 9; cap++) {
        carConfigs.push({ cap, keyspace: cap * 3 + 2, ops: OPS, salt: 0x4d0 + cap });
    }
    carConfigs.push({ cap: 64, keyspace: 200, ops: OPS, salt: 0x4df });
    carConfigs.push({ cap: 256, keyspace: 300, ops: OPS, salt: 0x4d1f });
    fuzzPolicy(carPolicy, carConfigs);
    fuzzPolicy(carIntPolicy, carConfigs);

    // The SEAM proof: the SAME runner drives a second policy unchanged.
    fuzzPolicy(fifoPolicy, [
        { cap: 1, keyspace: 4, ops: OPS, salt: 0x61 },
        { cap: 8, keyspace: 24, ops: OPS, salt: 0x62 },
        { cap: 64, keyspace: 200, ops: OPS, salt: 0x63 },
    ]);

    // The TTL proof (decisions/0017): the runner drives a VIRTUAL CLOCK, advancing it
    // a few ms per op and passing per-put ttlMs (some Infinity, some the default), so
    // entries expire mid-stream. Each member's LAZY stale rule (get/has/peek reap on
    // touch, no promotion; capacity eviction does NOT prefer stale) must match its own
    // oracle -- same value AND same next victim AND same size after every op. Caps 8/64
    // exercise both small (probation-empty) and normal splits under expiry churn.
    const ttlConfigs = [
        { cap: 8, keyspace: 24, ops: OPS, salt: 0xa1, ttl: 8 },
        { cap: 64, keyspace: 200, ops: OPS, salt: 0xa2, ttl: 8 },
    ];
    fuzzPolicy(lruTtlPolicy, ttlConfigs);
    fuzzPolicy(sieveTtlPolicy, ttlConfigs);
    fuzzPolicy(s3fifoTtlPolicy, ttlConfigs);
    fuzzPolicy(wtinylfuTtlPolicy, ttlConfigs);
    fuzzPolicy(slruTtlPolicy, ttlConfigs);
    fuzzPolicy(twoqTtlPolicy, ttlConfigs);
    fuzzPolicy(arcTtlPolicy, ttlConfigs);
    fuzzPolicy(lirsTtlPolicy, ttlConfigs);
    fuzzPolicy(lfuTtlPolicy, ttlConfigs);
    fuzzPolicy(clockProTtlPolicy, ttlConfigs);
    fuzzPolicy(lrukTtlPolicy, ttlConfigs);
    fuzzPolicy(mqTtlPolicy, ttlConfigs);
    fuzzPolicy(carTtlPolicy, ttlConfigs);

    // The SNAPSHOT proof (decisions/0021): for EVERY member, on BOTH backings, ttl OFF
    // and ttl ON, over the 100k corpus -- dump -> restore -> dump is a fixed point AND a
    // restored cache decides FUTURE evictions identically to the un-snapshotted twin
    // (same value + size + victim after every op). Dropping any aux state (Arc's p,
    // W-TinyLFU's sketch, a ghost, a visited bit, the TTL _exp column) diverges here.
    const snapConfigs = [
        { cap: 1, keyspace: 4, salt: 0x5a01 },     // degenerate cap-1
        { cap: 8, keyspace: 24, salt: 0x5a02 },
        { cap: 64, keyspace: 200, salt: 0x5a03 },
        { cap: 256, keyspace: 300, salt: 0x5a04 }, // high hit rate
    ];
    for (let mi = 0; mi < SNAP_MEMBERS.length; mi++) {
        const member = SNAP_MEMBERS[mi];
        for (let ci = 0; ci < snapConfigs.length; ci++) {
            const cfg = snapConfigs[ci];
            // Four lanes: default/int backing x ttl off/on. `pre` builds a rich state,
            // `ops` drives the shared future trace. Total corpus per lane = pre + ops.
            const lanes = [
                { keys: undefined, ttl: undefined },
                { keys: 'int', ttl: undefined },
                { keys: undefined, ttl: 8 },
                { keys: 'int', ttl: 8 },
            ];
            for (let li = 0; li < lanes.length; li++) {
                const lane = lanes[li];
                const seed = (SEED ^ cfg.salt ^ (mi << 8) ^ (li << 4)) >>> 0 || 1;
                const r = runRoundTrip(member, {
                    cap: cfg.cap, pre: 40000, ops: 60000, seed,
                    keyspace: cfg.keyspace, keys: lane.keys, ttl: lane.ttl,
                });
                if (!r.ok) {
                    die('t5 snapshot ' + member.name + ' diverged (' + r.why + '): real=' +
                        String(r.real) + ' oracle=' + String(r.oracle) +
                        (r.err ? ' err=' + r.err : '') + ' at op ' + String(r.i) +
                        ' cap=' + cfg.cap + ' keyspace=' + cfg.keyspace +
                        ' keys=' + String(lane.keys) + ' ttl=' + String(lane.ttl) +
                        '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs');
                }
            }
        }
    }
}
