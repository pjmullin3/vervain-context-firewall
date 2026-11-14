/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
// Particle world for graph cards, in the force-directed idiom of Obsidian's graph view (d3-force semantics):
//   v <- (v + alpha * sum of force velocities) * (1 - decay_i);   x <- x + v * dt
// There is no spring to a home position. Links pull toward a rest length, cards repel softly, a branch root feels a
// gentle lane gravity toward its assigned port, and a weak rest gravity slowly reorganises the map. `alpha` is the
// temperature: 0.3 while dragging, cooling by alphaDecay per tick once released, so motion fades instead of snapping.
// Weight: force velocities divide by mass and heavier cards keep more friction, so a big branch moves slowly.
// XPBD (Macklin, Mueller, Chentanez 2016) is kept only for the hard rules: cards never overlap, nothing enters the Box,
// pinned cards stay put. Coordinates are world pixels; ticks are 60 Hz from an accumulator with bounded catch-up.
export const STEP = 1 / 60, MAX_STEPS = 4;
export const LANE_DIR = Object.freeze({w: [-1, 0], n: [0, -1], e: [1, 0], s: [0, 1]});
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Heavy cards, light strings. The integrator is first order in feel: every tick the velocity keeps only `keep` of itself
// (d3-force's velocityDecay, the model behind Obsidian's graph), so a card relaxes exponentially toward its rest target at
// a rate kHome / (m (1 - keep)) per second and never rings. Mass slows that rate, so heavy data visibly moves slowly.
// Strings are weaker than rest forces and stretch before they pull; a child's rest target follows a share of its parent's
// displacement so a branch bends as one. Grabbing a card also grabs the bundle of cards within `grabRadius`, weighted by
// closeness, so nearby strings are pulled together. Constraints (port cone, Box separation, card separation, edge bound)
// are XPBD (Macklin, Mueller, Chentanez 2016) with compliance alpha~ = alpha / dt^2.
export function createWorld({step: initialStep = STEP, keep = 0.7, kHome = 90, kLink = 24, follow = 0.55, followUp = 0.1, grabRadius = 220, grabShare = 0.6, throwShare = 0.25, laneSlope = 1.4, boxRadius = 150, maxStretch = 2.4, alphaPort = 1.5e-3, alphaBox = 2e-4, alphaCard = 8e-4, alphaEdge = 3e-3, sleepSpeed = 0.6, sleepFrames = 8, maxSpeed = 2400, correction = 0.05} = {}) {
  const bodies = new Map(), lambda = new Map();
  let iterations = 2, step = initialStep;
  let accumulator = 0, lastTime = 0, awake = true, quietFrames = 0, metrics = {frames: [], settleAt: 0, wokeAt: 0, overlap: 0, substeps: 0, energy: 0, worst: null, worstErr: 0, err: 0};
  let field = null; // (x, y) => [ux, uy], the fluid medium; null means still air
  const pointer = []; // recent pointer samples for the (short) throw glide
  let grab = null; // {id, x0, y0, bundle: Map(id -> weight)}
  const hash = new Map(); const CELL = 260;
  const key = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  function rebuildHash() { hash.clear(); for (const b of bodies.values()) { const k = key(b.x, b.y); if (!hash.has(k)) hash.set(k, []); hash.get(k).push(b); } }
  function candidates(b) { const out = []; const cx = Math.floor(b.x / CELL), cy = Math.floor(b.y / CELL); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const o of hash.get(`${cx + i},${cy + j}`) || []) if (o !== b) out.push(o); return out; }
  function wake(id = null) { awake = true; quietFrames = 0; metrics.wokeAt = performance.now(); if (id) { const b = bodies.get(id); if (b) b.sleep = false; } }

  /** Sync bodies to the laid-out graph: new bodies start at home, existing bodies keep position and velocity. */
  function sync(layout) {
    const seen = new Set();
    for (const n of layout) {
      seen.add(n.id);
      let b = bodies.get(n.id);
      if (!b) { b = {id: n.id, x: n.home.x, y: n.home.y, vx: 0, vy: 0, sleep: false}; bodies.set(n.id, b); wake(); }
      else if (b.home && (Math.abs(b.home.x - n.home.x) > 1 || Math.abs(b.home.y - n.home.y) > 1)) wake();
      Object.assign(b, {home: n.home, w: n.w, h: n.h, r: n.r, m: n.m, invM: n.fixed ? 0 : 1 / n.m, fixed: !!n.fixed, parent: n.parent, port: n.port, root: n.root, rest: n.rest, kind: n.kind});
    }
    for (const id of [...bodies.keys()]) if (!seen.has(id)) { bodies.delete(id); wake(); }
    for (const b of bodies.values()) if (b.parent && !bodies.has(b.parent)) b.parent = null;
    rebuildHash();
  }
  const childrenOf = new Map();
  function forces(dt) {
    childrenOf.clear(); for (const b of bodies.values()) if (b.parent && bodies.has(b.parent)) (childrenOf.get(b.parent) || childrenOf.set(b.parent, []).get(b.parent)).push(b);
    const g = grab && bodies.get(grab.id);
    for (const b of bodies.values()) {
      if (b.invM === 0 || b.dragging || b.pinned) continue;
      let fx = 0, fy = 0;
      const p = b.parent && bodies.get(b.parent);
      // rest target: the layout home, shifted by a share of the parent's displacement and a small share of the children's
      let tx = b.home.x, ty = b.home.y;
      if (p) { tx += follow * (p.x - p.home.x); ty += follow * (p.y - p.home.y); }
      const kids = childrenOf.get(b.id);
      if (kids) { let sx = 0, sy = 0; for (const c of kids) { sx += c.x - c.home.x; sy += c.y - c.home.y; } tx += followUp * sx / kids.length; ty += followUp * sy / kids.length; }
      // a grabbed bundle: cards close to the grab point are carried by the drag, by closeness, strings and all
      const wgt = g && grab.bundle.get(b.id);
      if (wgt) { tx += wgt * (g.x - grab.x0); ty += wgt * (g.y - grab.y0); }
      fx += kHome * (tx - b.x); fy += kHome * (ty - b.y);
      // light string to the parent: weak, so it visibly stretches before it pulls
      if (p) { const dx = b.x - p.x, dy = b.y - p.y, l = Math.hypot(dx, dy) || 1; const f = -kLink * (l - b.rest); fx += f * dx / l; fy += f * dy / l; }
      if (field) { const [ux, uy] = field(b.x, b.y); fx += 4 * b.m * (ux - b.vx); fy += 4 * b.m * (uy - b.vy); }
      b.vx = (b.vx + fx * b.invM * dt) * keep; b.vy = (b.vy + fy * b.invM * dt) * keep;
      const s = Math.hypot(b.vx, b.vy); if (s > maxSpeed) { b.vx *= maxSpeed / s; b.vy *= maxSpeed / s; }
    }
  }
  function solve(id, C, a, b, ga, gb, alpha, dt) {
    if (C >= 0 && !(alpha === 0 && C > 0)) return 0;
    const wa = a.dragging || a.pinned ? 0 : a.invM, wb = !b ? 0 : b.dragging || b.pinned ? 0 : b.invM;
    const wsum = wa * (ga[0] ** 2 + ga[1] ** 2) + (b ? wb * (gb[0] ** 2 + gb[1] ** 2) : 0);
    if (wsum === 0) return 0;
    const at = alpha / (dt * dt), lam = lambda.get(id) || 0, dl = (-C - at * lam) / (wsum + at);
    lambda.set(id, lam + dl);
    a.x += wa * ga[0] * dl; a.y += wa * ga[1] * dl;
    if (b) { b.x += wb * gb[0] * dl; b.y += wb * gb[1] * dl; }
    const moved = Math.max(Math.abs(wa * dl), b ? Math.abs(wb * dl) : 0) * Math.hypot(ga[0], ga[1]);
    if (moved > metrics.worstErr) { metrics.worstErr = moved; metrics.worst = id; }
    return moved;
  }
  function constraints(dt) {
    let maxErr = 0, overlap = 0; lambda.clear(); metrics.worst = null; metrics.worstErr = 0;
    for (let iter = 0; iter < iterations; iter++) {
      for (const b of bodies.values()) {
        if (b.invM === 0) continue;
        if (b.pinned) { b.x = b.pinned.x; b.y = b.pinned.y; continue; }
        if (b.root && b.port) {
          const [lx, ly] = LANE_DIR[b.port], along = b.x * lx + b.y * ly, across = -b.x * ly + b.y * lx;
          maxErr = Math.max(maxErr, solve(`port:${b.id}`, along - boxRadius, b, null, [lx, ly], null, alphaPort, dt));
          const limit = laneSlope * Math.max(along, boxRadius), over = Math.abs(across) - limit;
          if (over > 0) maxErr = Math.max(maxErr, solve(`lane:${b.id}`, -over, b, null, [Math.sign(across) * ly, -Math.sign(across) * lx], null, alphaPort, dt));
        }
        const d = Math.hypot(b.x, b.y) || 1, minD = boxRadius * 0.8 + b.r;
        if (d < minD) maxErr = Math.max(maxErr, solve(`box:${b.id}`, d - minD, b, null, [b.x / d, b.y / d], null, alphaBox, dt));
        const p = b.parent && bodies.get(b.parent);
        if (p) { const dx = b.x - p.x, dy = b.y - p.y, l = Math.hypot(dx, dy) || 1, lim = b.rest * maxStretch; if (l > lim) maxErr = Math.max(maxErr, solve(`edge:${b.id}`, lim - l, b, p, [-dx / l, -dy / l], [dx / l, dy / l], alphaEdge, dt)); }
      }
      // card separation; the dragged card is lifted above the map and does not collide
      rebuildHash();
      for (const a of bodies.values()) for (const o of candidates(a)) {
        if (o.id < a.id || a.dragging || o.dragging) continue;
        const dx = a.x - o.x, dy = a.y - o.y, ox = (a.w + o.w) / 2 + 8 - Math.abs(dx), oy = (a.h + o.h) / 2 + 8 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        overlap = Math.max(overlap, Math.min(ox, oy));
        const gr = ox < oy ? [Math.sign(dx || 1), 0] : [0, Math.sign(dy || 1)];
        maxErr = Math.max(maxErr, solve(`card:${a.id}|${o.id}`, -Math.min(ox, oy), a, o, gr, [-gr[0], -gr[1]], alphaCard, dt));
      }
    }
    metrics.overlap = overlap; metrics.err = maxErr;
    return maxErr;
  }
  function substep(dt) {
    forces(dt);
    const mid = new Map();
    for (const b of bodies.values()) { if (b.invM && !b.dragging && !b.pinned) { b.x += b.vx * dt; b.y += b.vy * dt; } mid.set(b.id, [b.x, b.y]); }
    const err = constraints(dt);
    let speed = 0;
    for (const b of bodies.values()) {
      if (b.invM === 0 || b.dragging) continue;
      const [x1, y1] = mid.get(b.id); b.vx += correction * (b.x - x1) / dt; b.vy += correction * (b.y - y1) / dt;
      b.lifted = !!b.dragging;
      speed = Math.max(speed, Math.hypot(b.vx, b.vy));
    }
    return {speed, err};
  }
  return {
    bodies, sync, wake,
    /** A new observation tugs one point in the connected web. Links and springs carry the motion outward. */
    pulse(id, strength = 520) {
      const b = bodies.get(id); if (!b || b.invM === 0) return;
      let seed = 0; for (const c of id) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
      const angle = (seed % 6283) / 1000;
      const ax = Math.cos(angle), ay = Math.sin(angle);
      for (const o of bodies.values()) {
        if (o.invM === 0 || o.pinned) continue;
        const distance = Math.hypot(o.x - b.x, o.y - b.y);
        const weight = o === b ? 1 : Math.exp(-distance / 480) * .55;
        const side = o === b ? 1 : ((o.x - b.x) * -ay + (o.y - b.y) * ax >= 0 ? 1 : -1);
        o.vx += (ax + side * ay * .28) * strength * weight;
        o.vy += (ay - side * ax * .28) * strength * weight;
        o.x += (ax + side * ay * .28) * 8 * weight;
        o.y += (ay - side * ax * .28) * 8 * weight;
      }
      wake(id);
    },
    setField(f) { field = f; },
    setQuality(level) { if (level === 'dense') { step = 1 / 60; iterations = 1; } else { step = STEP; iterations = 2; } },
    step(now) {
      const t0 = performance.now();
      if (!lastTime) lastTime = now;
      accumulator = Math.min(accumulator + (now - lastTime) / 1000, MAX_STEPS * step);
      lastTime = now;
      if (!awake) { accumulator = 0; return false; }
      let speed = 0, err = 0, n = 0;
      while (accumulator >= step) { const r = substep(step); speed = r.speed; err = r.err; accumulator -= step; n++; }
      metrics.substeps = n; metrics.energy = speed;
      const quiet = speed < sleepSpeed && err < 0.5 && !grab;
      quietFrames = quiet ? quietFrames + 1 : 0;
      if (quietFrames >= sleepFrames) { awake = false; metrics.settleAt = performance.now(); for (const b of bodies.values()) { b.vx = 0; b.vy = 0; } }
      const ms = performance.now() - t0; metrics.frames.push(ms); if (metrics.frames.length > 240) metrics.frames.shift();
      return n > 0;
    },
    /** Pointer drives a body kinematically. The first call captures the bundle of cards within grabRadius. */
    drag(id, x, y, t = performance.now()) {
      const b = bodies.get(id); if (!b) return;
      if (!b.dragging) {
        b.dragging = true; pointer.length = 0; wake(id);
        const bundle = new Map();
        for (const o of bodies.values()) { if (o === b || o.invM === 0) continue; const d = Math.hypot(o.x - b.x, o.y - b.y); if (d < grabRadius) bundle.set(o.id, grabShare * (1 - d / grabRadius)); }
        grab = {id, x0: b.x, y0: b.y, bundle};
      }
      b.x = x; b.y = y; pointer.push({t, x, y}); while (pointer.length && t - pointer[0].t > 120) pointer.shift();
      if (field?.splat && pointer.length > 1) { const p = pointer[pointer.length - 2], dt = Math.max(1e-3, (t - p.t) / 1000); field.splat(x, y, (x - p.x) / dt, (y - p.y) / dt); }
      wake();
    },
    /** Release: a heavy card keeps only a share of the pointer speed and glides a short way; a paused pointer gives none. */
    release(id, t = performance.now()) {
      const b = bodies.get(id); if (!b) return [0, 0];
      b.dragging = false; grab = null;
      const recent = pointer.filter(p => t - p.t <= 100);
      let vx = 0, vy = 0;
      if (recent.length >= 2) {
        const last = recent[recent.length - 1], moved = Math.hypot(last.x - recent[0].x, last.y - recent[0].y);
        if (t - last.t < 60 && moved > 4) {
          let wsum = 0;
          for (let i = 1; i < recent.length; i++) { const w = Math.exp(-(t - recent[i].t) / 45), dt = Math.max(1e-3, (recent[i].t - recent[i - 1].t) / 1000); vx += w * (recent[i].x - recent[i - 1].x) / dt; vy += w * (recent[i].y - recent[i - 1].y) / dt; wsum += w; }
          vx = throwShare * vx / wsum; vy = throwShare * vy / wsum;
          const s = Math.hypot(vx, vy), cap = 900; if (s > cap) { vx *= cap / s; vy *= cap / s; }
        }
      }
      b.vx = vx; b.vy = vy; pointer.length = 0; wake(); return [vx, vy];
    },
    pin(id, at) { const b = bodies.get(id); if (b) { b.pinned = at ? {x: at.x, y: at.y} : null; wake(); } },
    isAwake: () => awake,
    grabbed: () => grab ? {id: grab.id, bundle: [...grab.bundle.keys()]} : null,
    metrics() {
      const f = [...metrics.frames].sort((a, b) => a - b), q = p => f.length ? f[Math.min(f.length - 1, Math.floor(p * f.length))] : 0;
      return {worst: metrics.worst, err: metrics.err, frameMs: {p50: q(.5), p90: q(.9), p99: q(.99), max: f.at(-1) || 0, n: f.length}, settleMs: metrics.settleAt && metrics.wokeAt ? Math.max(0, metrics.settleAt - metrics.wokeAt) : null, overlap: metrics.overlap, substeps: metrics.substeps, energy: metrics.energy, awake, bodies: bodies.size};
    },
  };
}

/** Graph diffusion for the decorative activity wave: dh/dt = -kappa L h + q(t) - lambda h on the tree, explicit Euler.
 *  L = D - A. Stability needs dt * kappa * lambda_max(L) < 2 and lambda_max <= 2 * max degree, so kappa is scaled by degree.
 *  h is a visual field only: a wave reaching a node never means data reached it. */
export function createDiffusion({kappa = 3, lambda = 1.2} = {}) {
  let h = new Map(), adj = new Map(), maxDeg = 1;
  return {
    setGraph(edges) { adj = new Map(); for (const e of edges) { for (const [a, b] of [[e.source, e.target], [e.target, e.source]]) { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); } } maxDeg = Math.max(1, ...[...adj.values()].map(l => l.length)); for (const id of h.keys()) if (!adj.has(id)) h.delete(id); },
    inject(id, q = 1) { h.set(id, Math.min(1, (h.get(id) || 0) + q)); },
    step(dt) {
      const k = kappa / (2 * maxDeg), next = new Map();
      for (const [id, nb] of adj) { const hi = h.get(id) || 0; let lap = 0; for (const j of nb) lap += (h.get(j) || 0) - hi; const v = hi + dt * (k * lap - lambda * hi); if (v > 1e-3) next.set(id, Math.min(1, v)); }
      h = next; return h;
    },
    get: id => h.get(id) || 0, size: () => h.size,
  };
}
