/**
 * @zakkster/lite-lru -- standalone control driver (the must-fail proof).
 *
 * Every gate must be provably able to fail. This entry drives the whole-suite
 * BREAK control out-of-process and asserts BOTH directions of the invariant:
 *
 *   - a CLEAN run (`node --expose-gc test/torture.mjs`) prints exactly "ok" and
 *     exits 0;
 *   - the BREAK run (`LLRU_TORTURE_BREAK=1 node --expose-gc test/torture.mjs`)
 *     injects a retained allocation into the T6 hot loop, so the alloc gate
 *     rejects the window, the run exits NON-zero, and it never prints "ok".
 *
 * A suite that always fails is as useless as one that never does; both arms are
 * required. The in-process controls (t9: broken _detach, leaked map key, skipped
 * promotion, allocating hot loop, broken second policy) run every invocation, so a
 * plain `npm run torture` already proves each of THOSE gates bites; this driver
 * adds the out-of-process proof that the whole-suite BREAK exits non-zero.
 *
 * CONVENTION (mirrors ../LiteBinaryReader/test/controls.mjs): this entry prints
 * exactly "ok" and exits 0 when EVERY control behaved as designed (the clean arm
 * passed AND the break arm failed). It exits non-zero if any control misbehaved.
 *
 *     node test/controls.mjs        -> prints exactly "ok", exit 0
 *     npm run torture:controls
 *
 * @license MIT
 */

import { spawnSync } from 'node:child_process';

const ENTRY = new URL('./torture.mjs', import.meta.url).pathname;

/** Run the torture entry with an optional BREAK value. Returns code + output. */
function runWith(breakOn) {
    const env = Object.assign({}, process.env);
    if (breakOn) env.LLRU_TORTURE_BREAK = '1';
    else delete env.LLRU_TORTURE_BREAK;
    const res = spawnSync(process.execPath, ['--expose-gc', ENTRY], { env, encoding: 'utf8' });
    return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function fail(msg) {
    process.stderr.write('controls: FAIL -- ' + msg + '\n');
    process.exit(1);
}

// 1. The clean run must pass. If it does not, the BREAK arm is meaningless.
{
    const r = runWith(false);
    if (r.code !== 0) fail('clean run exited ' + r.code + ' (expected 0)\n' + r.stderr);
    if (r.stdout.trim() !== 'ok') fail('clean run stdout was ' + JSON.stringify(r.stdout) + ', expected exactly "ok"');
}

// 2. The BREAK run must exit non-zero and must NOT print "ok".
{
    const r = runWith(true);
    if (r.code === 0) fail('LLRU_TORTURE_BREAK=1 still exited 0 -- the T6 gate is decorative');
    if (r.stdout.trim() === 'ok') fail('LLRU_TORTURE_BREAK=1 printed "ok" on a failing run');
}

process.stdout.write('ok\n');
