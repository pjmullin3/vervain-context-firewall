/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
// Deterministic rest positions from a projection. Each lane grows away from the Box along its port direction; depth
// (from the flood) sets the distance along the lane, sibling order sets the lateral zig-zag. Branch roots are placed so
// the newest branch sits nearest the lane axis, and their distance grows with lateral offset so every root stays inside
// the lane cone the physics enforces. Existing nodes keep their rest position between polls unless their tree parent
// or port changed, so a completion never reflows the map. Rest length of an edge is the parent-child rest distance.
import {BOX} from './topology.mjs';
import {LANE_DIR} from './physics.mjs';
const ALONG = {w: 300, e: 300, n: 190, s: 190}, GAP = 14, FIRST = 330;
const zig = k => (k % 2 ? -(k + 1) / 2 : k / 2);
export function layoutProjection(proj, previous = new Map(), sizes = new Map()) {
  const {nodes, parent, port, depth, order} = proj, rects = [], placed = new Map();
  const size = id => sizes.get(id) || {w: 216, h: 64};
  const free = (cx, cy, s) => !rects.some(q => q.l < cx + s.w / 2 + GAP && q.r > cx - s.w / 2 - GAP && q.t < cy + s.h / 2 + GAP && q.b > cy - s.h / 2 - GAP);
  const occupy = (id, cx, cy, s) => { rects.push({l: cx - s.w / 2, r: cx + s.w / 2, t: cy - s.h / 2, b: cy + s.h / 2}); placed.set(id, {x: cx, y: cy}); };
  occupy(BOX, 0, 0, {w: 196, h: 176});
  for (const n of nodes) { const p = previous.get(n.id); if (n.id !== BOX && p && p.parent === parent.get(n.id) && p.port === port.get(n.id)) occupy(n.id, p.x, p.y, size(n.id)); }
  const pending = nodes.filter(n => n.id !== BOX && !placed.has(n.id));
  const roots = pending.filter(n => parent.get(n.id) === BOX).sort((a, b) => (b.first_at || 0) - (a.first_at || 0) || (a.id < b.id ? -1 : 1));
  const rest = pending.filter(n => parent.get(n.id) !== BOX).sort((a, b) => (depth.get(a.id) ?? 99) - (depth.get(b.id) ?? 99) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0) || (a.id < b.id ? -1 : 1));
  const lanes = {w: 0, n: 0, e: 0, s: 0};
  const place = (n, isRoot) => {
    const lane = port.get(n.id) || 's', [lx, ly] = LANE_DIR[lane], px = -ly, py = lx, s = size(n.id), from = placed.get(parent.get(n.id)) || {x: 0, y: 0};
    const spacing = lane === 'w' || lane === 'e' ? s.h + 30 : s.w + 24;
    let spot = null;
    for (let round = 0; !spot && round < 8; round++) for (let k = 0; !spot && k < 48; k++) {
      const lat = (isRoot ? zig(lanes[lane] + k) : zig(k)) * spacing;
      const along = isRoot ? FIRST + round * ALONG[lane] * 0.5 + 0.55 * Math.abs(lat) : ALONG[lane] * (1 + round * 0.5);
      const cx = (isRoot ? 0 : from.x) + lx * along + px * lat, cy = (isRoot ? 0 : from.y) + ly * along + py * lat;
      if (free(cx, cy, s)) spot = {x: cx, y: cy};
    }
    if (isRoot) lanes[lane]++;
    spot ||= {x: from.x + lx * ALONG[lane] + px * rects.length * 6, y: from.y + ly * ALONG[lane] + py * rects.length * 6};
    occupy(n.id, spot.x, spot.y, s);
  };
  for (const n of roots) place(n, true);
  for (const n of rest) place(n, false);
  const out = new Map();
  for (const n of nodes) {
    const p = placed.get(n.id) || {x: 0, y: 0}, par = parent.get(n.id), pp = par ? placed.get(par) : null;
    out.set(n.id, {x: p.x, y: p.y, parent: par || null, port: port.get(n.id) || null, root: par === BOX, rest: pp ? Math.hypot(p.x - pp.x, p.y - pp.y) : 0});
  }
  return out;
}
