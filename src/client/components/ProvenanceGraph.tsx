/**
 * Responsibility: Deterministic 9-node SVG causal provenance graph centered on Vervain's
 * isometric 3D memory volume and pre-inference cut-plane at Context Gate, paired with a
 * 6-stage causal replay scrubber, 5-question CISO governance strip, and accessible node inspector.
 * Trust boundary: Renders safe node aliases, dispositions, and digests; never displays
 * protected source text.
 */

import { useState } from 'react';
import type {
  ArmExecutionView,
  ProvenanceEdgeView,
  ProvenanceNodeId,
  ProvenanceNodeView,
} from '../../shared/contracts.js';
import {
  CausalReplayScrubber,
  getEdgeCausalStage,
  getNodeCausalStage,
  resolveCausalElementOpacity,
  type ReplayStageSelection,
} from './CausalReplayScrubber.js';

export interface ProvenanceGraphProps {
  readonly execution: ArmExecutionView;
  readonly selectedNodeId: ProvenanceNodeId;
  readonly onSelectNode: (nodeId: ProvenanceNodeId) => void;
  readonly runPulseCounter: number;
  readonly pairedAvailable: boolean;
  readonly onSwitchInspectedArm?: (arm: 'native_only' | 'native_plus_vervain') => void;
}

interface NodeCoords {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

type Pt = readonly [number, number];

const NODE_LAYOUT: Readonly<Record<ProvenanceNodeId, NodeCoords>> = {
  authority: { x: 14, y: 116, w: 146, h: 48 },
  retriever: { x: 192, y: 116, w: 148, h: 48 },
  source_alder: { x: 372, y: 48, w: 156, h: 48 },
  source_beacon: { x: 372, y: 184, w: 156, h: 48 },
  context_gate: { x: 595, y: 114, w: 142, h: 52 },
  gemini: { x: 792, y: 54, w: 154, h: 48 },
  release_gate: { x: 792, y: 156, w: 154, h: 48 },
  reply: { x: 990, y: 156, w: 164, h: 48 },
  receipt: { x: 684, y: 268, w: 170, h: 46 },
};

// Isometric 3D memory cube vertices centered around context_gate (cx = 666)
const ISO_CUBE = {
  cx: 666,
  apertureX: 578,
  topBack: [666, 44] as Pt,
  topLeft: [578, 80] as Pt,
  topRight: [754, 80] as Pt,
  topFront: [666, 116] as Pt,
  botBack: [666, 140] as Pt,
  botLeft: [578, 176] as Pt,
  botRight: [754, 176] as Pt,
  botFront: [666, 212] as Pt,
} as const;

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function ptsString(points: readonly Pt[]): string {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

function toneStroke(tone: ProvenanceNodeView['tone']): string {
  switch (tone) {
    case 'violet':
      return '#9b8af5';
    case 'allowed':
      return '#58b889';
    case 'withheld':
      return '#e07a5f';
    case 'warning':
      return '#d99b52';
    case 'neutral':
    default:
      return 'rgba(255, 255, 255, 0.26)';
  }
}

function edgeDashArray(style: ProvenanceEdgeView['lineStyle']): string | undefined {
  switch (style) {
    case 'dashed':
      return '5 4';
    case 'interrupted':
      return '4 4';
    case 'dotted':
      return '2 4';
    case 'solid':
    default:
      return undefined;
  }
}

interface EdgeGeometry {
  readonly pathD: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly stopBar?: { readonly x: number; readonly y1: number; readonly y2: number };
  readonly aperturePassPoint?: Pt;
}

function computeEdgeGeometry(edge: ProvenanceEdgeView, isGovernedArm: boolean): EdgeGeometry {
  const fromBox = NODE_LAYOUT[edge.from];
  const toBox = NODE_LAYOUT[edge.to];
  const isInterrupted = edge.lineStyle === 'interrupted';

  if (edge.from === 'authority' && edge.to === 'retriever') {
    const x1 = fromBox.x + fromBox.w;
    const y1 = fromBox.y + fromBox.h / 2;
    const x2 = toBox.x;
    const y2 = toBox.y + toBox.h / 2;
    const c1x = x1 + (x2 - x1) * 0.35;
    const c2x = x1 + (x2 - x1) * 0.65;
    return {
      pathD: `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: fromBox.y - 9,
    };
  }

  if (edge.from === 'retriever' && edge.to === 'source_alder') {
    const x1 = fromBox.x + fromBox.w;
    const y1 = fromBox.y + 15;
    const x2 = toBox.x;
    const y2 = toBox.y + toBox.h / 2;
    const cx = (x1 + x2) / 2;
    return {
      pathD: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`,
      labelX: cx,
      labelY: 106,
    };
  }

  if (edge.from === 'retriever' && edge.to === 'source_beacon') {
    const x1 = fromBox.x + fromBox.w;
    const y1 = fromBox.y + fromBox.h - 15;
    const x2 = toBox.x;
    const y2 = toBox.y + toBox.h / 2;
    const cx = (x1 + x2) / 2;
    return {
      pathD: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`,
      labelX: cx,
      labelY: 179,
    };
  }

  if (edge.from === 'source_alder' && edge.to === 'context_gate') {
    const x1 = fromBox.x + fromBox.w;
    const y1 = fromBox.y + fromBox.h / 2;
    if (isInterrupted) {
      const cutX = ISO_CUBE.apertureX - 6;
      const cutY = 114;
      return {
        pathD: `M ${x1} ${y1} C ${x1 + 24} ${y1}, ${cutX - 18} ${cutY}, ${cutX} ${cutY}`,
        labelX: 552,
        labelY: 38,
        stopBar: { x: cutX, y1: cutY - 9, y2: cutY + 9 },
      };
    }
    const x2 = toBox.x;
    const y2 = toBox.y + 18;
    return {
      pathD: `M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 28} ${y2}, ${x2} ${y2}`,
      labelX: 554,
      labelY: 38,
      aperturePassPoint: isGovernedArm && edge.tone === 'allowed' ? [ISO_CUBE.apertureX, 124] : undefined,
    };
  }

  if (edge.from === 'source_beacon' && edge.to === 'context_gate') {
    const x1 = fromBox.x + fromBox.w;
    const y1 = fromBox.y + fromBox.h / 2;
    if (isInterrupted) {
      const cutX = ISO_CUBE.apertureX - 6;
      const cutY = 160;
      return {
        pathD: `M ${x1} ${y1} C ${x1 + 24} ${y1}, ${cutX - 18} ${cutY}, ${cutX} ${cutY}`,
        labelX: 552,
        labelY: 248,
        stopBar: { x: cutX, y1: cutY - 10, y2: cutY + 10 },
      };
    }
    const x2 = toBox.x;
    const y2 = toBox.y + toBox.h - 16;
    return {
      pathD: `M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 28} ${y2}, ${x2} ${y2}`,
      labelX: 554,
      labelY: 248,
    };
  }

  if (edge.from === 'context_gate' && edge.to === 'gemini') {
    const x1 = fromBox.x + fromBox.w;
    const y1 = fromBox.y + 18;
    const x2 = toBox.x;
    const y2 = toBox.y + toBox.h / 2;
    return {
      pathD: `M ${x1} ${y1} C ${x1 + 28} ${y1}, ${x2 - 26} ${y2}, ${x2} ${y2}`,
      labelX: 765,
      labelY: 42,
    };
  }

  if (edge.from === 'context_gate' && edge.to === 'release_gate') {
    const x1 = fromBox.x + fromBox.w;
    const y1 = fromBox.y + fromBox.h - 16;
    const x2 = isInterrupted ? toBox.x - 10 : toBox.x;
    const y2 = toBox.y + toBox.h / 2;
    return {
      pathD: `M ${x1} ${y1} C ${x1 + 24} ${y1}, ${x2 - 20} ${y2}, ${x2} ${y2}`,
      labelX: 764,
      labelY: 220,
      stopBar: isInterrupted ? { x: x2, y1: y2 - 9, y2: y2 + 9 } : undefined,
    };
  }

  if (edge.from === 'gemini' && edge.to === 'release_gate') {
    const x1 = fromBox.x + fromBox.w / 2;
    const y1 = fromBox.y + fromBox.h;
    const x2 = toBox.x + toBox.w / 2;
    const y2 = toBox.y;
    const c1y = y1 + (y2 - y1) * 0.35;
    const c2y = y1 + (y2 - y1) * 0.65;
    return {
      pathD: `M ${x1} ${y1} C ${x1} ${c1y}, ${x2} ${c2y}, ${x2} ${y2}`,
      labelX: x1,
      labelY: (y1 + y2) / 2 + 3,
    };
  }

  if (edge.from === 'release_gate' && edge.to === 'reply') {
    const x1 = fromBox.x + fromBox.w;
    const y1 = fromBox.y + fromBox.h / 2;
    const x2 = isInterrupted ? toBox.x - 10 : toBox.x;
    const y2 = toBox.y + toBox.h / 2;
    const c1x = x1 + (x2 - x1) * 0.35;
    const c2x = x1 + (x2 - x1) * 0.65;
    return {
      pathD: `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`,
      labelX: (fromBox.x + fromBox.w + toBox.x) / 2,
      labelY: fromBox.y - 9,
      stopBar: isInterrupted ? { x: x2, y1: y2 - 9, y2: y2 + 9 } : undefined,
    };
  }

  if (edge.to === 'receipt') {
    const x1 = fromBox.x + fromBox.w / 2;
    const y1 = fromBox.y + fromBox.h;
    const isFromGate = edge.from === 'context_gate';
    const x2 = isFromGate ? toBox.x : toBox.x + toBox.w;
    const y2 = toBox.y + toBox.h / 2;
    const bendX = isFromGate ? x2 - 26 : x2 + 26;
    return {
      pathD: `M ${x1} ${y1} C ${x1} ${y1 + 72}, ${bendX} ${y2}, ${x2} ${y2}`,
      labelX: isFromGate ? 640 : 890,
      labelY: 256,
    };
  }

  const x1 = fromBox.x + fromBox.w;
  const y1 = fromBox.y + fromBox.h / 2;
  const x2 = isInterrupted ? toBox.x - 10 : toBox.x;
  const y2 = toBox.y + toBox.h / 2;
  const cx = (x1 + x2) / 2;
  return {
    pathD: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`,
    labelX: cx,
    labelY: (y1 + y2) / 2 - 7,
    stopBar: isInterrupted ? { x: x2, y1: y2 - 8, y2: y2 + 8 } : undefined,
  };
}

function clipText(str: string, maxChars: number): string {
  return str.length > maxChars ? `${str.slice(0, maxChars - 3)}...` : str;
}

const GRID_SUBDIVISIONS = [1 / 3, 2 / 3] as const;

export function ProvenanceGraph({
  execution,
  selectedNodeId,
  onSelectNode,
  runPulseCounter,
  pairedAvailable,
  onSwitchInspectedArm,
}: ProvenanceGraphProps) {
  const [replayState, setReplayState] = useState<{
    readonly requestId: string;
    readonly stage: ReplayStageSelection;
  }>({
    requestId: execution.requestId,
    stage: 'all',
  });

  const activeStage: ReplayStageSelection =
    replayState.requestId === execution.requestId ? replayState.stage : 'all';

  const handleSelectStage = (
    stage: ReplayStageSelection,
    primaryNodeId?: ProvenanceNodeId,
  ): void => {
    setReplayState({ requestId: execution.requestId, stage });
    if (primaryNodeId) {
      onSelectNode(primaryNodeId);
    }
  };

  const fallbackNode = execution.graph.nodes[0];
  const selectedNode =
    execution.graph.nodes.find((n) => n.id === selectedNodeId) ?? fallbackNode;

  if (!selectedNode) {
    return null;
  }

  const connectedEdges = execution.graph.edges.filter(
    (e) => e.from === selectedNode.id || e.to === selectedNode.id,
  );

  const isGovernedArm = execution.arm === 'native_plus_vervain';
  const cubeOpacity = resolveCausalElementOpacity(3, activeStage);
  const authorityNode = execution.graph.nodes.find((n) => n.id === 'authority');
  const whoSummary = `${authorityNode?.label ?? execution.receipt.policy_id} · ${execution.receipt.policy_id} (${execution.arm})`;
  const epochShifted = execution.policyEpochAtAdmission !== execution.policyEpochAtRelease;

  return (
    <section
      className="panel-card"
      aria-label="Causal provenance graph"
      data-testid="provenance-graph-panel"
    >
      <div className="panel-header">
        <div>
          <h3>Causal Provenance Graph</h3>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Audit · Alert · Govern · Select any node (click or Tab + Enter) or scrub stages to inspect lineage
          </span>
        </div>

        {pairedAvailable && onSwitchInspectedArm && (
          <div className="tab-group" role="group" aria-label="Graph arm selector">
            <button
              type="button"
              className={`tab-btn ${execution.arm === 'native_plus_vervain' ? 'tab-btn--active' : ''}`}
              data-testid="graph-tab-vervain"
              onClick={() => onSwitchInspectedArm('native_plus_vervain')}
            >
              Native + Vervain
            </button>
            <button
              type="button"
              className={`tab-btn ${execution.arm === 'native_only' ? 'tab-btn--active' : ''}`}
              data-testid="graph-tab-native"
              onClick={() => onSwitchInspectedArm('native_only')}
            >
              Native only
            </button>
          </div>
        )}
      </div>

      <div className="graph-svg-wrap">
        <svg
          key={`pulse-${runPulseCounter}-${execution.arm}`}
          className="causal-svg"
          viewBox="0 0 1168 328"
          role="img"
          aria-label={`Causal provenance path for ${execution.armLabel}`}
        >
          <defs>
            <linearGradient
              id={`iso-top-${execution.arm}`}
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop
                offset="0%"
                stopColor={isGovernedArm ? 'rgba(155, 138, 245, 0.14)' : 'rgba(217, 155, 82, 0.10)'}
              />
              <stop offset="100%" stopColor="rgba(19, 19, 24, 0.45)" />
            </linearGradient>
            <linearGradient
              id={`iso-left-${execution.arm}`}
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop
                offset="0%"
                stopColor={isGovernedArm ? 'rgba(155, 138, 245, 0.16)' : 'rgba(217, 155, 82, 0.11)'}
              />
              <stop offset="100%" stopColor="rgba(13, 13, 16, 0.65)" />
            </linearGradient>
            <linearGradient
              id={`iso-right-${execution.arm}`}
              x1="0%"
              y1="0%"
              x2="100%"
              y2="100%"
            >
              <stop offset="0%" stopColor="rgba(88, 184, 137, 0.08)" />
              <stop offset="100%" stopColor="rgba(13, 13, 16, 0.72)" />
            </linearGradient>
          </defs>

          {/* Signature Isometric 3D Wire-Cube Memory Volume at context_gate */}
          <g opacity={cubeOpacity} aria-hidden="true">
            {/* Hidden interior rear cube axes for 3D depth */}
            <line
              x1={ISO_CUBE.topBack[0]}
              y1={ISO_CUBE.topBack[1]}
              x2={ISO_CUBE.botBack[0]}
              y2={ISO_CUBE.botBack[1]}
              stroke="rgba(155, 138, 245, 0.16)"
              strokeWidth="0.9"
              strokeDasharray="2 3"
            />
            <line
              x1={ISO_CUBE.botBack[0]}
              y1={ISO_CUBE.botBack[1]}
              x2={ISO_CUBE.botLeft[0]}
              y2={ISO_CUBE.botLeft[1]}
              stroke="rgba(155, 138, 245, 0.16)"
              strokeWidth="0.9"
              strokeDasharray="2 3"
            />
            <line
              x1={ISO_CUBE.botBack[0]}
              y1={ISO_CUBE.botBack[1]}
              x2={ISO_CUBE.botRight[0]}
              y2={ISO_CUBE.botRight[1]}
              stroke="rgba(155, 138, 245, 0.16)"
              strokeWidth="0.9"
              strokeDasharray="2 3"
            />

            {/* Top, Left, and Right Isometric Faces */}
            <polygon
              points={ptsString([
                ISO_CUBE.topBack,
                ISO_CUBE.topRight,
                ISO_CUBE.topFront,
                ISO_CUBE.topLeft,
              ])}
              fill={`url(#iso-top-${execution.arm})`}
              stroke={isGovernedArm ? 'rgba(155, 138, 245, 0.46)' : 'rgba(217, 155, 82, 0.36)'}
              strokeWidth="1.1"
            />
            <polygon
              points={ptsString([
                ISO_CUBE.topLeft,
                ISO_CUBE.topFront,
                ISO_CUBE.botFront,
                ISO_CUBE.botLeft,
              ])}
              fill={`url(#iso-left-${execution.arm})`}
              stroke={isGovernedArm ? '#9b8af5' : '#d99b52'}
              strokeWidth={isGovernedArm ? '1.5' : '1.3'}
              strokeDasharray={isGovernedArm ? undefined : '5 4'}
            />
            <polygon
              points={ptsString([
                ISO_CUBE.topFront,
                ISO_CUBE.topRight,
                ISO_CUBE.botRight,
                ISO_CUBE.botFront,
              ])}
              fill={`url(#iso-right-${execution.arm})`}
              stroke={isGovernedArm ? 'rgba(155, 138, 245, 0.40)' : 'rgba(217, 155, 82, 0.34)'}
              strokeWidth="1.1"
            />

            {/* Subtle internal depth grid lines on Top, Left, and Right faces */}
            {GRID_SUBDIVISIONS.map((t) => {
              const tl = lerpPt(ISO_CUBE.topBack, ISO_CUBE.topLeft, t);
              const tr = lerpPt(ISO_CUBE.topBack, ISO_CUBE.topRight, t);
              const fl = lerpPt(ISO_CUBE.topRight, ISO_CUBE.topFront, t);
              const fr = lerpPt(ISO_CUBE.topLeft, ISO_CUBE.topFront, t);

              const lTop = lerpPt(ISO_CUBE.topLeft, ISO_CUBE.topFront, t);
              const lBot = lerpPt(ISO_CUBE.botLeft, ISO_CUBE.botFront, t);
              const lMidA = lerpPt(ISO_CUBE.topLeft, ISO_CUBE.botLeft, t);
              const lMidB = lerpPt(ISO_CUBE.topFront, ISO_CUBE.botFront, t);

              const rTop = lerpPt(ISO_CUBE.topFront, ISO_CUBE.topRight, t);
              const rBot = lerpPt(ISO_CUBE.botFront, ISO_CUBE.botRight, t);
              const rMidA = lerpPt(ISO_CUBE.topFront, ISO_CUBE.botFront, t);
              const rMidB = lerpPt(ISO_CUBE.topRight, ISO_CUBE.botRight, t);

              return (
                <g key={`grid-${t}`} stroke="rgba(155, 138, 245, 0.22)" strokeWidth="0.75">
                  <line x1={tl[0]} y1={tl[1]} x2={fl[0]} y2={fl[1]} />
                  <line x1={tr[0]} y1={tr[1]} x2={fr[0]} y2={fr[1]} />
                  <line x1={lTop[0]} y1={lTop[1]} x2={lBot[0]} y2={lBot[1]} />
                  <line x1={lMidA[0]} y1={lMidA[1]} x2={lMidB[0]} y2={lMidB[1]} />
                  <line x1={rTop[0]} y1={rTop[1]} x2={rBot[0]} y2={rBot[1]} />
                  <line x1={rMidA[0]} y1={rMidA[1]} x2={rMidB[0]} y2={rMidB[1]} />
                </g>
              );
            })}

            {/* Pre-Inference Cut-Plane slicing vertically at the left entry face */}
            {isGovernedArm ? (
              <g>
                <polygon
                  points="572,62 584,67 584,189 572,184"
                  fill="rgba(155, 138, 245, 0.15)"
                  stroke="#9b8af5"
                  strokeWidth="1.2"
                />
                <line
                  x1={ISO_CUBE.apertureX}
                  y1={26}
                  x2={ISO_CUBE.apertureX}
                  y2={224}
                  stroke="#9b8af5"
                  strokeWidth="1.4"
                  strokeDasharray="3 3"
                />
                <text
                  x={ISO_CUBE.apertureX}
                  y={18}
                  textAnchor="middle"
                  fill="#9b8af5"
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                >
                  pre-inference cut-plane
                </text>
              </g>
            ) : (
              <g>
                <polygon
                  points="572,62 584,67 584,189 572,184"
                  fill="rgba(217, 155, 82, 0.09)"
                  stroke="#d99b52"
                  strokeWidth="1.2"
                  strokeDasharray="4 3"
                />
                <line
                  x1={ISO_CUBE.apertureX}
                  y1={26}
                  x2={ISO_CUBE.apertureX}
                  y2={224}
                  stroke="#d99b52"
                  strokeWidth="1.3"
                  strokeDasharray="5 4"
                />
                <text
                  x={ISO_CUBE.apertureX}
                  y={18}
                  textAnchor="middle"
                  fill="#d99b52"
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                >
                  unmediated_passthrough
                </text>
              </g>
            )}

            {/* Inference Memory Volume Inscription */}
            <rect
              x={ISO_CUBE.cx - 72}
              y={218}
              width={144}
              height={14}
              rx={3}
              fill="#0d0d10"
              fillOpacity="0.92"
            />
            <text
              x={ISO_CUBE.cx}
              y={228}
              textAnchor="middle"
              fill={isGovernedArm ? 'rgba(155, 138, 245, 0.88)' : 'rgba(217, 155, 82, 0.88)'}
              fontSize="9.5"
              letterSpacing="0.07em"
              fontFamily="var(--font-mono)"
            >
              AUDIT · ALERT · GOVERN
            </text>
          </g>

          {/* Cubic Bezier Lineage Edges */}
          {execution.graph.edges.map((edge) => {
            const geom = computeEdgeGeometry(edge, isGovernedArm);
            const color = toneStroke(edge.tone);
            const dash = edgeDashArray(edge.lineStyle);
            const pillW = edge.verb.length * 6.2 + 12;
            const edgeStage = getEdgeCausalStage(edge);
            const edgeOpacity = resolveCausalElementOpacity(edgeStage, activeStage);

            return (
              <g key={edge.id} data-testid={`graph-edge-${edge.id}`} opacity={edgeOpacity}>
                <path
                  d={geom.pathD}
                  fill="none"
                  stroke={color}
                  strokeWidth={edge.tone === 'allowed' || edge.tone === 'violet' ? '2.0' : '1.7'}
                  strokeDasharray={dash}
                  className="edge-animated"
                />
                {geom.aperturePassPoint && (
                  <circle
                    cx={geom.aperturePassPoint[0]}
                    cy={geom.aperturePassPoint[1]}
                    r={3.1}
                    fill="#58b889"
                    stroke="#0d0d10"
                    strokeWidth="1"
                  />
                )}
                {geom.stopBar && (
                  <g>
                    <line
                      x1={geom.stopBar.x}
                      y1={geom.stopBar.y1}
                      x2={geom.stopBar.x}
                      y2={geom.stopBar.y2}
                      stroke="#e07a5f"
                      strokeWidth="2.8"
                      strokeLinecap="round"
                    />
                    <line
                      x1={geom.stopBar.x - 3.5}
                      y1={geom.stopBar.y1}
                      x2={geom.stopBar.x}
                      y2={geom.stopBar.y1}
                      stroke="#e07a5f"
                      strokeWidth="1.5"
                    />
                    <line
                      x1={geom.stopBar.x - 3.5}
                      y1={geom.stopBar.y2}
                      x2={geom.stopBar.x}
                      y2={geom.stopBar.y2}
                      stroke="#e07a5f"
                      strokeWidth="1.5"
                    />
                  </g>
                )}
                <rect
                  x={geom.labelX - pillW / 2}
                  y={geom.labelY - 10}
                  width={pillW}
                  height={14}
                  rx={3}
                  fill="#0d0d10"
                  fillOpacity="0.92"
                  stroke="rgba(255, 255, 255, 0.08)"
                  strokeWidth="0.75"
                />
                <text
                  x={geom.labelX}
                  y={geom.labelY}
                  textAnchor="middle"
                  fill="#c9c6d1"
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                >
                  {edge.verb}
                </text>
              </g>
            );
          })}

          {/* Causal Boundary Nodes */}
          {execution.graph.nodes.map((node) => {
            const box = NODE_LAYOUT[node.id];
            const isSelected = node.id === selectedNode.id;
            const nodeStage = getNodeCausalStage(node.id);
            const nodeOpacity = resolveCausalElementOpacity(nodeStage, activeStage);
            const isStageActive = activeStage !== 'all' && activeStage === nodeStage;
            const accent = toneStroke(node.tone);
            const borderColor = isSelected ? '#efede8' : accent;

            return (
              <g
                key={node.id}
                className="graph-node-group"
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`${node.label}: ${node.stateText}`}
                data-testid={`graph-node-${node.id}`}
                opacity={nodeOpacity}
                onClick={() => onSelectNode(node.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectNode(node.id);
                  }
                }}
              >
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={5}
                  fill={isSelected ? '#1e1c29' : isStageActive ? '#181722' : '#131317'}
                  stroke={borderColor}
                  strokeWidth={isSelected ? '2.1' : isStageActive ? '1.7' : '1.2'}
                />
                <circle cx={box.x + 10} cy={box.y + 16} r={2.8} fill={accent} />
                <text
                  x={box.x + 17}
                  y={box.y + 19}
                  fill="#efede8"
                  fontSize="10.6"
                  fontWeight="600"
                >
                  {clipText(node.label, Math.max(18, Math.floor((box.w - 24) / 5.7)))}
                </text>
                <text
                  x={box.x + 10}
                  y={box.y + 36}
                  fill="#b2afbc"
                  fontSize="9.5"
                  fontFamily="var(--font-mono)"
                >
                  {clipText(node.stateText, Math.max(20, Math.floor((box.w - 18) / 5.75)))}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Interactive 6-Stage Causal Step Replay Scrubber */}
      <CausalReplayScrubber
        requestId={execution.requestId}
        activeStage={activeStage}
        onSelectStage={handleSelectStage}
      />

      {/* Compact 5-Question CISO Governance Strip (Audit · Alert · Govern) */}
      <div
        data-testid="governance-five-questions"
        aria-label="Five governance questions summary"
        style={{
          marginTop: 8,
          padding: '8px 10px',
          background: 'var(--bg-inset)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '6px 10px',
        }}
      >
        <div className="kv-pair">
          <span className="kv-key mono" style={{ color: 'var(--accent-violet)', fontSize: 10 }}>
            WHO
          </span>
          <span className="kv-val mono" style={{ fontSize: 11 }}>
            {whoSummary}
          </span>
        </div>

        <div className="kv-pair">
          <span className="kv-key mono" style={{ color: 'var(--accent-violet)', fontSize: 10 }}>
            WHAT
          </span>
          <span className="kv-val mono" style={{ fontSize: 11 }}>
            {execution.counts.admitted}/{execution.counts.retrieved} admitted ·{' '}
            {execution.counts.withheld} withheld
          </span>
        </div>

        <div className="kv-pair">
          <span className="kv-key mono" style={{ color: 'var(--accent-violet)', fontSize: 10 }}>
            WHEN
          </span>
          <span
            className="kv-val mono"
            style={{
              fontSize: 11,
              color: epochShifted ? 'var(--status-withheld)' : 'var(--text-primary)',
            }}
          >
            epoch {execution.policyEpochAtAdmission} -&gt; {execution.policyEpochAtRelease}
          </span>
        </div>

        <div className="kv-pair">
          <span className="kv-key mono" style={{ color: 'var(--accent-violet)', fontSize: 10 }}>
            HOW
          </span>
          <span
            className="kv-val mono"
            style={{
              fontSize: 11,
              color: execution.foreignChunkEnteredEnvelope
                ? 'var(--status-warning)'
                : 'var(--status-allowed)',
            }}
          >
            foreign in envelope: {execution.foreignChunkEnteredEnvelope ? 'yes' : 'no'}
          </span>
        </div>

        <div className="kv-pair">
          <span className="kv-key mono" style={{ color: 'var(--accent-violet)', fontSize: 10 }}>
            WHY
          </span>
          <span className="kv-val mono" style={{ fontSize: 11 }}>
            {execution.releaseDecision}: {execution.releaseReason}
          </span>
        </div>
      </div>

      {/* Selected Node Evidence Inspector */}
      <div className="node-inspector" data-testid="node-inspector">
        <div className="node-inspector-header">
          <strong>{selectedNode.label}</strong>
          <span className="mono" style={{ color: 'var(--accent-violet)' }}>
            {selectedNode.stateText}
          </span>
        </div>
        <div className="kv-grid">
          {selectedNode.evidenceFields.map((field) => (
            <div key={field.key} className="kv-pair">
              <span className="kv-key">{field.key}</span>
              <span className={`kv-val ${field.mono ? 'mono' : ''}`}>{field.value}</span>
            </div>
          ))}
          {connectedEdges.map((edge) => (
            <div key={edge.id} className="kv-pair">
              <span className="kv-key">
                Edge {edge.from} -&gt; {edge.to} ({edge.verb})
              </span>
              <span className="kv-val">{edge.basis}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
