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

import { runDifferential, lruPolicy, lruIntPolicy, fifoPolicy, SEED, die } from './harness.mjs';

const OPS = 100000;

/** Run one policy across several capacities and keyspaces; die on any divergence. */
function fuzzPolicy(policy, configs) {
    for (let ci = 0; ci < configs.length; ci++) {
        const cfg = configs[ci];
        const seed = (SEED ^ cfg.salt) >>> 0 || 1;
        const r = runDifferential(policy, { cap: cfg.cap, ops: cfg.ops, seed, keyspace: cfg.keyspace });
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

    // The SEAM proof: the SAME runner drives a second policy unchanged.
    fuzzPolicy(fifoPolicy, [
        { cap: 1, keyspace: 4, ops: OPS, salt: 0x61 },
        { cap: 8, keyspace: 24, ops: OPS, salt: 0x62 },
        { cap: 64, keyspace: 200, ops: OPS, salt: 0x63 },
    ]);
}
