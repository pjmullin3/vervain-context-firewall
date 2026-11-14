/**
 * Responsibility: Pure layout geometry for the Vervain workspace canvas: node positions,
 * isometric cube vertices, cubic lineage routes, and arc-length sampling for chunk motion.
 * Trust boundary: Presentation math only; holds no authority and reads no API state.
 */

export type Pt = readonly [number, number];

export interface CubicSeg {
  readonly p0: Pt;
  readonly c1: Pt;
  readonly c2: Pt;
  readonly p3: Pt;
}

export type Route = readonly CubicSeg[];

export const VIEW_W = 1280;
export const VIEW_H = 600;

export type WorkspaceNodeId =
  | 'idp'
  | 'session'
  | 'retriever'
  | 'source_alder'
  | 'source_beacon'
  | 'cube'
  | 'gemini'
  | 'release'
  | 'reply'
  | 'receipt';

export interface NodeBox {
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
}

export const NODE_H = 62;

export const NODES: Record<Exclude<WorkspaceNodeId, 'cube'>, NodeBox> = {
  idp: { cx: 132, cy: 92, w: 220, h: NODE_H },
  session: { cx: 132, cy: 210, w: 220, h: NODE_H },
  retriever: { cx: 132, cy: 345, w: 220, h: NODE_H },
  source_alder: { cx: 398, cy: 228, w: 220, h: NODE_H },
  source_beacon: { cx: 398, cy: 440, w: 220, h: NODE_H },
  gemini: { cx: 866, cy: 318, w: 236, h: NODE_H },
  release: { cx: 1146, cy: 214, w: 220, h: NODE_H },
  reply: { cx: 1146, cy: 372, w: 220, h: NODE_H },
  receipt: { cx: 640, cy: 528, w: 240, h: NODE_H },
};

/** Isometric cube centred at (cx, cy) with vertical half-extent s. */
export const CUBE = { cx: 640, cy: 270, s: 118 } as const;
const A = CUBE.s * 0.866;

export const CUBE_V = {
  top: [CUBE.cx, CUBE.cy - CUBE.s] as Pt,
  ur: [CUBE.cx + A, CUBE.cy - CUBE.s / 2] as Pt,
  lr: [CUBE.cx + A, CUBE.cy + CUBE.s / 2] as Pt,
  bottom: [CUBE.cx, CUBE.cy + CUBE.s] as Pt,
  ll: [CUBE.cx - A, CUBE.cy + CUBE.s / 2] as Pt,
  ul: [CUBE.cx - A, CUBE.cy - CUBE.s / 2] as Pt,
  center: [CUBE.cx, CUBE.cy] as Pt,
};

/** Centre of the left face, where context enters (the aperture). */
export const APERTURE: Pt = [CUBE.cx - A / 2, CUBE.cy + CUBE.s / 4];
/** Centre of the right face, where admitted context leaves for the model. */
export const EXIT: Pt = [CUBE.cx + A / 2, CUBE.cy + CUBE.s / 4];

/** Parallelogram inset on the left face, scaled around the face centre. */
export function leftFaceInset(scale: number): string {
  const corners = [CUBE_V.ul, CUBE_V.center, CUBE_V.bottom, CUBE_V.ll];
  return corners
    .map(([x, y]) => {
      const px = APERTURE[0] + (x - APERTURE[0]) * scale;
      const py = APERTURE[1] + (y - APERTURE[1]) * scale;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(' ');
}

export function poly(points: readonly Pt[]): string {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

export function lerp(a: Pt, b: Pt, t: number): Pt {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export const left = (id: keyof typeof NODES): Pt => [NODES[id].cx - NODES[id].w / 2, NODES[id].cy];
export const right = (id: keyof typeof NODES): Pt => [NODES[id].cx + NODES[id].w / 2, NODES[id].cy];
export const top = (id: keyof typeof NODES): Pt => [NODES[id].cx, NODES[id].cy - NODES[id].h / 2];
export const bottom = (id: keyof typeof NODES): Pt => [NODES[id].cx, NODES[id].cy + NODES[id].h / 2];

/** Horizontal S-curve between two points. */
export function hCurve(a: Pt, b: Pt): CubicSeg {
  const mx = (b[0] - a[0]) * 0.5;
  return { p0: a, c1: [a[0] + mx, a[1]], c2: [b[0] - mx, b[1]], p3: b };
}

/** Vertical S-curve between two points. */
export function vCurve(a: Pt, b: Pt): CubicSeg {
  const my = (b[1] - a[1]) * 0.5;
  return { p0: a, c1: [a[0], a[1] + my], c2: [b[0], b[1] - my], p3: b };
}

/** Elbow from a horizontal exit into a vertical entry (or the reverse). */
export function hvCurve(a: Pt, b: Pt): CubicSeg {
  return { p0: a, c1: [b[0], a[1]], c2: [b[0], a[1]], p3: b };
}

export function line(a: Pt, b: Pt): CubicSeg {
  return { p0: a, c1: lerp(a, b, 1 / 3), c2: lerp(a, b, 2 / 3), p3: b };
}

export function routeD(route: Route): string {
  return route
    .map((s, i) => {
      const head = i === 0 ? `M${s.p0[0].toFixed(1)},${s.p0[1].toFixed(1)} ` : '';
      return `${head}C${s.c1[0].toFixed(1)},${s.c1[1].toFixed(1)} ${s.c2[0].toFixed(1)},${s.c2[1].toFixed(1)} ${s.p3[0].toFixed(1)},${s.p3[1].toFixed(1)}`;
    })
    .join(' ');
}

function cubicAt(s: CubicSeg, t: number): Pt {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return [
    b0 * s.p0[0] + b1 * s.c1[0] + b2 * s.c2[0] + b3 * s.p3[0],
    b0 * s.p0[1] + b1 * s.c1[1] + b2 * s.c2[1] + b3 * s.p3[1],
  ];
}

export interface SampledRoute {
  readonly pts: readonly Pt[];
  readonly cum: readonly number[];
  readonly total: number;
}

export function sampleRoute(route: Route, perSeg = 48): SampledRoute {
  const pts: Pt[] = [];
  route.forEach((seg, i) => {
    for (let k = i === 0 ? 0 : 1; k <= perSeg; k += 1) pts.push(cubicAt(seg, k / perSeg));
  });
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { pts, cum, total: cum[cum.length - 1] ?? 0 };
}

export function pointAlong(r: SampledRoute, f: number): Pt {
  const target = Math.max(0, Math.min(1, f)) * r.total;
  let lo = 0;
  let hi = r.cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (r.cum[mid]! < target) lo = mid;
    else hi = mid;
  }
  const c0 = r.cum[lo]!;
  const span = r.cum[hi]! - c0 || 1;
  return lerp(r.pts[lo]!, r.pts[hi]!, (target - c0) / span);
}

/* Static lineage routes. */
export const EDGE_ROUTES = {
  idp_session: [vCurve(bottom('idp'), top('session'))],
  session_retriever: [vCurve(bottom('session'), top('retriever'))],
  retriever_alder: [hCurve(right('retriever'), left('source_alder'))],
  retriever_beacon: [hCurve(right('retriever'), left('source_beacon'))],
  alder_aperture: [hCurve(right('source_alder'), APERTURE)],
  beacon_aperture: [hCurve(right('source_beacon'), APERTURE)],
  through_cube: [line(APERTURE, EXIT)],
  exit_gemini: [hCurve(EXIT, left('gemini'))],
  gemini_release: [hCurve(right('gemini'), left('release'))],
  release_reply: [vCurve(bottom('release'), top('reply'))],
  cube_receipt: [vCurve(CUBE_V.bottom, top('receipt'))],
} satisfies Record<string, Route>;

/* Chunk motion routes. Tokens park on node edges so they never cover node text. */
export const CHUNK_ROUTES = {
  alderToReply: sampleRoute([
    ...EDGE_ROUTES.alder_aperture,
    ...EDGE_ROUTES.through_cube,
    ...EDGE_ROUTES.exit_gemini,
    line(left('gemini'), right('gemini')),
    ...EDGE_ROUTES.gemini_release,
    line(left('release'), [NODES.release.cx - NODES.release.w / 2 + 40, NODES.release.cy]),
    hvCurve(
      [NODES.release.cx - NODES.release.w / 2 + 40, NODES.release.cy],
      [NODES.reply.cx - NODES.reply.w / 2 - 14, NODES.reply.cy - 14],
    ),
  ]),
  alderToGemini: sampleRoute([
    ...EDGE_ROUTES.alder_aperture,
    ...EDGE_ROUTES.through_cube,
    ...EDGE_ROUTES.exit_gemini,
  ]),
  beaconToAperture: sampleRoute([...EDGE_ROUTES.beacon_aperture]),
  beaconToGemini: sampleRoute([
    ...EDGE_ROUTES.beacon_aperture,
    ...EDGE_ROUTES.through_cube,
    ...EDGE_ROUTES.exit_gemini,
  ]),
  receiptPulse: sampleRoute([...EDGE_ROUTES.cube_receipt]),
};
