// @zakkster/lite-lru -- per-member renderers (S13, decisions/0022, D22.1).
//
// One renderer per member, each driven STRICTLY off that member's dump() snapshot.
// A renderer reads ONLY snapshot fields; it computes pixel geometry (rendering),
// never member state (which would be shadow mechanics). Occupancy only: dump()
// omits fixed geometry (segment/ghost/window capacities, sketch rows/width), so
// renderers draw which slots are where + visited bits + hand + ghost keys + Arc p +
// sketch counter VALUES -- never reconstructed capacities (D22.5).
//
// Each renderer declares `fields` (the member-specific snapshot keys it consumes)
// and a `model(snap)` that reassembles the snapshot from exactly those keys +
// the shared base. Demo.test.mjs asserts model(dump) deep-equals dump() for every
// member: a dropped field (silently unrendered) or an invented field both fail.
//
// draw(g, snap, geom) uses a CanvasRenderingContext2D and runs in the browser
// only; the model() path is pure and is what the node test exercises.
//
// This module imports NOTHING (pure); it is loaded by demo/visuals.html alongside
// ../Lru.js. Repo-only dev artifact; NEVER shipped.

/** The base snapshot fields every member's dump() carries (snapBase in Lru.js):
 *  format tag, member name, capacity, keys backing, ttl flag, capture time. */
export const BASE_FIELDS = ['f', 'm', 'cap', 'keys', 'ttl', 't'];

/** Reassemble a snapshot from the base fields + a member's own fields. If `fields`
 *  omits a key dump() emits, the result is missing it (deep-equal fails -> the
 *  field is silently unrendered); if `fields` names a key dump() does NOT emit, the
 *  result carries `undefined` under it (deep-equal fails -> an invented field). */
function pick(snap, fields) {
    const o = {};
    for (let i = 0; i < BASE_FIELDS.length; i++) o[BASE_FIELDS[i]] = snap[BASE_FIELDS[i]];
    for (let i = 0; i < fields.length; i++) o[fields[i]] = snap[fields[i]];
    return o;
}

/* ------------------------------- palette --------------------------------- */
// Hex first (a browser that ignores anything falls back cleanly).
const COL = {
    bg: '#0c1512',
    slot: '#12261c',
    slotEdge: '#2b5a44',
    visited: '#ffcf5a',   // Sieve/S3Fifo/Slru visited bit set
    hand: '#ff8a6a',      // Sieve hand
    ghost: '#233', ghostEdge: '#3a5', // ghost keys (occupancy, keys only)
    text: '#cfe8d8', dim: '#7fa591', label: '#9fe3bf',
    prot: '#1c3a2a', prob: '#122633', window: '#2a2440',
    heat0: '#0b1f16', heat1: '#37e08a', // sketch counter heat
    pbar: '#46f',
};

const CELL_W = 34;
const CELL_H = 24;
const GAP = 4;

/** Draw one labelled row of cells from a snapList { slots, k, v, vis? } at (x,y).
 *  Returns the y below the row. A cell shows its key; a set visited bit tints it. */
function drawList(g, x, y, list, label, tint) {
    g.fillStyle = COL.label;
    g.font = '11px ui-monospace, monospace';
    g.fillText(label + ' (' + list.slots.length + ')', x, y - 4);
    const vis = list.vis; // present iff the member's dump() emits a visited column
    let cx = x;
    for (let i = 0; i < list.k.length; i++) {
        g.fillStyle = tint || COL.slot;
        g.fillRect(cx, y, CELL_W, CELL_H);
        if (vis !== undefined && vis[i] === 1) {
            g.strokeStyle = COL.visited; g.lineWidth = 2;
        } else {
            g.strokeStyle = COL.slotEdge; g.lineWidth = 1;
        }
        g.strokeRect(cx, y, CELL_W, CELL_H);
        g.fillStyle = COL.text;
        g.font = '11px ui-monospace, monospace';
        g.fillText(String(list.k[i]), cx + 4, y + 16);
        cx += CELL_W + GAP;
        if (cx > x + 12 * (CELL_W + GAP)) { cx = x; y += CELL_H + GAP + 12; }
    }
    return y + CELL_H + 18;
}

/** Draw a keys-only ghost FIFO (S3Fifo/TwoQ) or Arc B1/B2 as faded cells. */
function drawGhost(g, x, y, keys, label) {
    g.fillStyle = COL.dim;
    g.font = '11px ui-monospace, monospace';
    g.fillText(label + ' (' + keys.length + ')', x, y - 4);
    let cx = x;
    for (let i = 0; i < keys.length; i++) {
        g.fillStyle = COL.ghost;
        g.fillRect(cx, y, CELL_W, CELL_H - 6);
        g.strokeStyle = COL.ghostEdge; g.lineWidth = 1;
        g.strokeRect(cx, y, CELL_W, CELL_H - 6);
        g.fillStyle = COL.dim;
        g.fillText(String(keys[i]), cx + 4, y + 12);
        cx += CELL_W + GAP;
        if (cx > x + 12 * (CELL_W + GAP)) { cx = x; y += CELL_H + GAP; }
    }
    return y + CELL_H + 12;
}

/** Draw the WTinyLfu Count-Min sketch counter VALUES as a heat strip (occupancy of
 *  the fixed array; geometry -- row count / width -- is not in dump(), so it is not
 *  reconstructed: the flat `sk` array is drawn as-is). */
function drawSketch(g, x, y, sk, skSize) {
    g.fillStyle = COL.label;
    g.font = '11px ui-monospace, monospace';
    g.fillText('sketch (skSize=' + skSize + ')', x, y - 4);
    const cw = 6, ch = 14, per = 64;
    let cx = x, cy = y;
    for (let i = 0; i < sk.length; i++) {
        const v = sk[i] >>> 0;
        g.fillStyle = v === 0 ? COL.heat0 : COL.heat1;
        g.globalAlpha = v === 0 ? 1 : Math.min(1, 0.25 + (v & 0xff) / 16);
        g.fillRect(cx, cy, cw, ch);
        g.globalAlpha = 1;
        cx += cw + 1;
        if (((i + 1) % per) === 0) { cx = x; cy += ch + 2; }
    }
    return cy + ch + 12;
}

/** Draw the Arc adaptive parameter p as a bar in [0, cap]. */
function drawPBar(g, x, y, p, cap) {
    g.fillStyle = COL.label;
    g.font = '11px ui-monospace, monospace';
    g.fillText('p = ' + p + ' / ' + cap, x, y - 4);
    const w = 12 * (CELL_W + GAP);
    g.strokeStyle = COL.slotEdge; g.lineWidth = 1;
    g.strokeRect(x, y, w, 10);
    g.fillStyle = COL.pbar;
    g.fillRect(x, y, cap ? (w * p) / cap : 0, 10);
    return y + 24;
}

/* ----------------------------- renderers --------------------------------- */

export const RENDERERS = {
    LiteLru: {
        fields: ['list'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            drawList(g, geom.x, geom.y + 16, s.list, 'recency MRU..LRU', COL.slot);
        },
    },
    Sieve: {
        fields: ['list', 'hand'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            let y = drawList(g, geom.x, geom.y + 16, s.list, 'ring (visited bit)', COL.slot);
            g.fillStyle = COL.hand;
            g.font = '11px ui-monospace, monospace';
            g.fillText('hand -> slot ' + s.hand, geom.x, y);
        },
    },
    S3Fifo: {
        fields: ['main', 'small', 'ghost'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            let y = geom.y + 16;
            y = drawList(g, geom.x, y, s.main, 'main', COL.prot);
            y = drawList(g, geom.x, y, s.small, 'small (visited bit)', COL.prob);
            drawGhost(g, geom.x, y, s.ghost, 'ghost');
        },
    },
    WTinyLfu: {
        fields: ['window', 'prot', 'prob', 'sk', 'skSize'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            let y = geom.y + 16;
            y = drawList(g, geom.x, y, s.window, 'window', COL.window);
            y = drawList(g, geom.x, y, s.prot, 'protected', COL.prot);
            y = drawList(g, geom.x, y, s.prob, 'probation', COL.prob);
            drawSketch(g, geom.x, y, s.sk, s.skSize);
        },
    },
    Slru: {
        fields: ['prot', 'prob'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            let y = geom.y + 16;
            y = drawList(g, geom.x, y, s.prot, 'protected (visited bit)', COL.prot);
            drawList(g, geom.x, y, s.prob, 'probation (visited bit)', COL.prob);
        },
    },
    TwoQ: {
        fields: ['am', 'a1in', 'ghost'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            let y = geom.y + 16;
            y = drawList(g, geom.x, y, s.am, 'Am (LRU)', COL.prot);
            y = drawList(g, geom.x, y, s.a1in, 'A1in (FIFO)', COL.prob);
            drawGhost(g, geom.x, y, s.ghost, 'A1out ghost');
        },
    },
    Arc: {
        fields: ['t2', 't1', 'p', 'b1', 'b2'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            let y = geom.y + 16;
            y = drawPBar(g, geom.x, y + 8, s.p, s.cap);
            y = drawList(g, geom.x, y + 12, s.t2, 'T2 frequent', COL.prot);
            y = drawList(g, geom.x, y, s.t1, 'T1 recent', COL.prob);
            y = drawGhost(g, geom.x, y, s.b1, 'B1 ghost');
            drawGhost(g, geom.x, y, s.b2, 'B2 ghost');
        },
    },
    Lirs: {
        // LIRS dump() shape (decisions/0023): the LIR list + Q (resident, values), the per-Q
        // inS bits, the stack S order (slot indices top..bottom), and the bounded non-resident
        // history (keys only). Occupancy only -- L_hir/L_lir geometry is not in dump() (D22.5).
        fields: ['lir', 'q', 'qins', 's', 'hist'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            let y = geom.y + 16;
            y = drawList(g, geom.x, y, s.lir, 'LIR set (hot)', COL.prot);
            y = drawList(g, geom.x, y, s.q, 'Q resident HIR (evict front)', COL.prob);
            g.fillStyle = COL.dim;
            g.font = '11px ui-monospace, monospace';
            g.fillText('stack S depth ' + s.s.length + ' (top->bottom)', geom.x, y);
            y += 14;
            drawGhost(g, geom.x, y, s.hist, 'non-resident history');
        },
    },
    Lfu: {
        // Lfu dump() shape (decisions/0024): a list of frequency BUCKETS in ascending order,
        // each carrying its EXACT `freq` + its recency list (MRU..LRU) of resident keys/values.
        // The bucket ORDER (lowest freq = the eviction end) + the exact frequencies are the
        // whole story -- render each bucket labelled with its frequency.
        fields: ['buckets'],
        model(s) { return pick(s, this.fields); },
        draw(g, s, geom) {
            let y = geom.y + 16;
            for (let i = 0; i < s.buckets.length; i++) {
                const bk = s.buckets[i];
                const col = i === 0 ? COL.prob : COL.prot; // lowest freq (eviction end) stands out
                y = drawList(g, geom.x, y, bk.list, 'freq ' + bk.freq + (i === 0 ? ' (evict end)' : ''), col);
            }
        },
    },
};

/** The members this module renders. Demo.test.mjs asserts this covers every engine
 *  member (no member silently unrendered). */
export const RENDERED_MEMBERS = Object.keys(RENDERERS);
