/**
 * @zakkster/lite-lru -- torture gate entry.
 *
 * The DONE-WHEN of S1 is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Tiers run STRICTLY SEQUENTIALLY (lite-gc-profiler is one-measurement-at-a-time
 * and throws if nested). The tiers (ROADMAP section 4):
 *
 *     t0 recency laws          t1 degenerate keys/values
 *     t2 adversarial + conservation   t5 differential fuzz (2 policies)
 *     t6 zero-alloc + writes-per-hit  t7 soak + conservation
 *     t9 controls (every gate must be able to fail)
 *
 * ENTRY CONTRACT (mirrors ../LiteBinaryReader/test/torture.mjs):
 *   - `--expose-gc` guard: the GC gate is meaningless without it -> exit(1).
 *   - Peer preflight: the two devDeps are imported DYNAMICALLY, AFTER the guard;
 *     a fresh clone that skipped `npm install` exits(2) with a remedy.
 *   - Replay: every failure prints the seed and replay command.
 *
 * CONTROL: LLRU_TORTURE_BREAK=1 node --expose-gc test/torture.mjs injects a
 * retained allocation into the T6 hot loop; the alloc gate rejects it and the
 * process exits non-zero. A normal run exits 0.
 *
 * @license MIT
 */

async function main() {
    // --- guard: the GC gate is meaningless without --expose-gc ----------------
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc: node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }

    // --- preflight: peers must be installed before any tier is imported --------
    for (const pkg of ['@zakkster/lite-gc-profiler', '@zakkster/lite-leak']) {
        try {
            await import(pkg);
        } catch {
            process.stderr.write(
                'torture: FAIL -- missing devDependency ' + pkg + ' -- run: npm install\n');
            process.exit(2);
        }
    }

    // Dynamic imports so preflight owns the failure path.
    const { SEED, BREAK } = await import('./torture/harness.mjs');
    const { run: t0 } = await import('./torture/t0-laws.mjs');
    const { run: t1 } = await import('./torture/t1-degenerate.mjs');
    const { run: t2 } = await import('./torture/t2-adversarial.mjs');
    const { run: t5 } = await import('./torture/t5-fuzz.mjs');
    const { run: t6 } = await import('./torture/t6-alloc.mjs');
    const { run: t7 } = await import('./torture/t7-soak.mjs');
    const { run: t9 } = await import('./torture/t9-controls.mjs');

    const TIERS = [
        ['t0 laws', t0],
        ['t1 degenerate', t1],
        ['t2 adversarial', t2],
        ['t5 differential', t5],
        ['t6 alloc', t6],
        ['t7 soak', t7],
        ['t9 controls', t9],
    ];

    for (const [name, run] of TIERS) {
        try {
            // Tiers normally fail via die() (which exits). A thrown error is an
            // unexpected fault -- surface it with the replay seed and stop.
            await run();
        } catch (err) {
            process.stderr.write(
                'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
            process.exit(1);
        }
    }

    // Reaching here in BREAK mode means the T6 control did not trip -- a fault.
    if (BREAK) {
        process.stderr.write(
            'torture: FAIL -- LLRU_TORTURE_BREAK set but the gate still passed\n');
        process.exit(1);
    }

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
