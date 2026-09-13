// @zakkster/lite-lru -- demo trace server (S13, decisions/0022, D22.4).
//
//   npm run demo:serve            (then open http://localhost:8013/)
//   node demo/serve.mjs [port]
//
// A zero-dependency Node http server. It exists because the browser page cannot
// import benchmark/Bench.mjs (Bench.mjs statically imports node:url, a Node
// builtin the browser cannot resolve). So the SERVER computes the trace + Belady
// OPT with Bench.mjs and hands them to the page as JSON:
//
//   GET /trace.json?kind=zipf&seed=1&cap=32&length=4000
//     -> { trace:[...], opt:{hits,misses,hitRate}, kind, seed, cap, length }
//
// It also serves the repo's static files so the page's `../Lru.js` import
// resolves (static root = the repo root; the page lives at /demo/visuals.html).
//
// Zero runtime deps ship: this server is a dev artifact, NEVER in the tarball.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, normalize, sep, extname } from 'node:path';

import { zipfTrace, loopTrace, scanTrace, makePrng, beladyOpt } from '../benchmark/Bench.mjs';

const DEMO_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(DEMO_DIR); // repo root -- so `../Lru.js` from /demo resolves to /Lru.js

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
};

/**
 * Build the trace + Belady OPT for one workload kind. The trace-generator params
 * mirror Bench.defaultWorkloads, so a served trace matches a bench run for the
 * same seed/cap. makePrng seeds the uniform (custom) kind directly.
 *
 * @returns {{trace:number[], opt:{hits:number,misses:number,hitRate:number},
 *            kind:string, seed:number, cap:number, length:number}}
 */
export function serveTrace(kind, seed, cap, length) {
    if (!Number.isInteger(cap) || cap < 1) throw new RangeError('[demo] cap must be an integer >= 1, got ' + String(cap));
    if (!Number.isInteger(length) || length < 1) throw new RangeError('[demo] length must be an integer >= 1, got ' + String(length));
    const s = (seed >>> 0) || 1;

    let trace;
    if (kind === 'zipf') trace = zipfTrace({ length, keyspace: cap * 16, exponent: 1.0, seed: s ^ 0x11 });
    else if (kind === 'loop') trace = loopTrace({ length, span: cap * 4 });
    else if (kind === 'scan') trace = scanTrace({ length, hotSize: (cap >> 1) || 1, hotFraction: 0.5, seed: s ^ 0x22 });
    else if (kind === 'uniform') {
        const prng = makePrng(s);
        const keyspace = cap * 4;
        trace = new Array(length);
        for (let i = 0; i < length; i++) trace[i] = prng() % keyspace;
    } else {
        throw new Error('[demo] unknown trace kind ' + String(kind) + ' (zipf|loop|scan|uniform)');
    }

    const opt = beladyOpt(trace, cap);
    return { trace, opt, kind, seed: s, cap, length };
}

/** Resolve a URL path to a real file under ROOT, or null if it escapes ROOT. */
function safePath(urlPath) {
    const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
    const abs = join(ROOT, rel);
    if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null; // path traversal guard
    return abs;
}

/** The one-line request handler. Exported so a test can drive it without a socket. */
export async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/trace.json') {
        try {
            const kind = url.searchParams.get('kind') || 'zipf';
            // `|| default` would treat an EXPLICIT "cap=0" / "length=0" query as absent
            // (0 is falsy) and silently substitute the default instead of failing closed
            // through serveTrace's own RangeError -- "null is not zero" (found by qa,
            // S13). Only a genuinely ABSENT param (searchParams.get returns null) uses
            // the default; a present-but-invalid value is passed through to serveTrace,
            // which rejects it.
            const seedParam = url.searchParams.get('seed');
            const capParam = url.searchParams.get('cap');
            const lengthParam = url.searchParams.get('length');
            const seed = seedParam === null ? 1 : Number(seedParam);
            const cap = capParam === null ? 32 : Number(capParam);
            const length = lengthParam === null ? 4000 : Number(lengthParam);
            const payload = serveTrace(kind, seed >>> 0, cap, length);
            const body = JSON.stringify(payload);
            res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
            res.end(body);
        } catch (err) {
            res.writeHead(400, { 'content-type': MIME['.json'] });
            res.end(JSON.stringify({ error: String(err && err.message || err) }));
        }
        return;
    }

    // "/" -> 302 REDIRECT to the page's real path (NOT an in-place serve). Serving
    // the HTML in place at "/" leaves the browser's document base URL at "/", so the
    // page's relative module imports (./Visualize.mjs, ./renderers.mjs) resolve to
    // the repo root and 404. Redirecting makes the browser re-request
    // /demo/visuals.html, so the base URL becomes /demo/ and the imports resolve.
    if (url.pathname === '/') {
        res.writeHead(302, { location: '/demo/visuals.html' });
        res.end();
        return;
    }

    // Static files.
    const pathname = url.pathname;
    const abs = safePath(pathname);
    if (abs === null) { res.writeHead(403); res.end('forbidden'); return; }
    try {
        const data = await readFile(abs);
        const type = MIME[extname(abs)] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        res.end(data);
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 ' + pathname);
    }
}

/** Create (but do not start) the http server. */
export function createServer() {
    return http.createServer((req, res) => { handle(req, res); });
}

/** Start listening. Returns the server. */
export function start(port) {
    const server = createServer();
    server.listen(port, () => {
        process.stdout.write('lite-lru demo server on http://localhost:' + port + '/\n');
        process.stdout.write('  page:   http://localhost:' + port + '/\n');
        process.stdout.write('  trace:  http://localhost:' + port + '/trace.json?kind=zipf&seed=1&cap=32\n');
    });
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    start(Number(process.argv[2]) || 8013);
}
