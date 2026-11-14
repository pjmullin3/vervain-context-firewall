/**
 * Responsibility: Deterministic 9-node SVG causal provenance graph showing branching source
 * paths converging on the Vervain Context Gate aperture, continuing to Gemini, Release Gate,
 * Reply, and Receipt, with accessible keyboard node inspection.
 * Trust boundary: Renders safe node aliases, dispositions, and digests; never displays
 * protected source text.
 */

import type {
  ArmExecutionView,
  ProvenanceEdgeView,
  ProvenanceNodeId,
  ProvenanceNodeView,
} from '../../shared/contracts.js';

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

const NODE_LAYOUT: Readonly<Record<ProvenanceNodeId, NodeCoords>> = {
  authority: { x: 14, y: 114, w: 144, h: 48 },
  retriever: { x: 196, y: 114, w: 148, h: 48 },
  source_alder: { x: 386, y: 42, w: 158, h: 48 },
  source_beacon: { x: 386, y: 184, w: 158, h: 48 },
  context_gate: { x: 594, y: 104, w: 142, h: 68 },
  gemini: { x: 782, y: 54, w: 150, h: 48 },
  release_gate: { x: 782, y: 162, w: 150, h: 48 },
  reply: { x: 974, y: 162, w: 124, h: 48 },
  receipt: { x: 668, y: 256, w: 164, h: 44 },
};

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
      return 'rgba(255, 255, 255, 0.24)';
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

function anchorPoint(
  node: NodeCoords,
  side: 'left' | 'right' | 'bottom' | 'top',
): [number, number] {
  if (side === 'left') return [node.x, node.y + node.h / 2];
  if (side === 'right') return [node.x + node.w, node.y + node.h / 2];
  if (side === 'bottom') return [node.x + node.w / 2, node.y + node.h];
  return [node.x + node.w / 2, node.y];
}

function computeEdgeGeometry(edge: ProvenanceEdgeView): {
  pathD: string;
  labelX: number;
  labelY: number;
  stopBar?: { x: number; y1: number; y2: number };
} {
  const fromBox = NODE_LAYOUT[edge.from];
  const toBox = NODE_LAYOUT[edge.to];

  if (edge.to === 'receipt') {
    const [x1, y1] = anchorPoint(fromBox, 'bottom');
    const [x2, y2] = anchorPoint(toBox, edge.from === 'context_gate' ? 'left' : 'right');
    const midY = (y1 + y2) / 2;
    return {
      pathD: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: midY + 2,
    };
  }

  if (edge.from === 'gemini' && edge.to === 'release_gate') {
    const [x1, y1] = anchorPoint(fromBox, 'bottom');
    const [x2, y2] = anchorPoint(toBox, 'top');
    return {
      pathD: `M ${x1} ${y1} L ${x2} ${y2}`,
      labelX: x1,
      labelY: (y1 + y2) / 2 + 3,
    };
  }

  const [x1, y1] = anchorPoint(fromBox, 'right');
  const [x2Raw, y2] = anchorPoint(toBox, 'left');

  const isInterrupted = edge.lineStyle === 'interrupted';
  const x2 = isInterrupted ? x2Raw - 10 : x2Raw;
  const cx = (x1 + x2) / 2;

  return {
    pathD: `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`,
    labelX: cx,
    labelY: (y1 + y2) / 2 - 7,
    stopBar: isInterrupted ? { x: x2, y1: y2 - 8, y2: y2 + 8 } : undefined,
  };
}

function clipText(str: string, maxChars: number): string {
  return str.length > maxChars ? `${str.slice(0, maxChars - 1)}…` : str;
}

export function ProvenanceGraph({
  execution,
  selectedNodeId,
  onSelectNode,
  runPulseCounter,
  pairedAvailable,
  onSwitchInspectedArm,
}: ProvenanceGraphProps) {
  const selectedNode =
    execution.graph.nodes.find((n) => n.id === selectedNodeId) ?? execution.graph.nodes[0]!;
  const connectedEdges = execution.graph.edges.filter(
    (e) => e.from === selectedNode.id || e.to === selectedNode.id,
  );

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
            Select any node (click or Tab + Enter) to inspect safe provenance &amp; edge basis
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
          viewBox="0 0 1112 314"
          role="img"
          aria-label={`Causal provenance path for ${execution.armLabel}`}
        >
          {/* Pre-inference aperture guide line */}
          <line
            x1={NODE_LAYOUT.context_gate.x - 5}
            y1={24}
            x2={NODE_LAYOUT.context_gate.x - 5}
            y2={244}
            stroke="rgba(155, 138, 245, 0.25)"
            strokeWidth="1.2"
            strokeDasharray="3 3"
          />
          <text
            x={NODE_LAYOUT.context_gate.x - 3}
            y={17}
            fill="#9b8af5"
            fontSize="10.5"
            fontFamily="var(--font-mono)"
          >
            pre-inference aperture
          </text>

          {/* Edges */}
          {execution.graph.edges.map((edge) => {
            const geom = computeEdgeGeometry(edge);
            const color = toneStroke(edge.tone);
            const dash = edgeDashArray(edge.lineStyle);
            const pillW = edge.verb.length * 6.2 + 10;
            return (
              <g key={edge.id} data-testid={`graph-edge-${edge.id}`}>
                <path
                  d={geom.pathD}
                  fill="none"
                  stroke={color}
                  strokeWidth={edge.tone === 'allowed' || edge.tone === 'violet' ? '1.9' : '1.6'}
                  strokeDasharray={dash}
                  className="edge-animated"
                />
                {geom.stopBar && (
                  <line
                    x1={geom.stopBar.x}
                    y1={geom.stopBar.y1}
                    x2={geom.stopBar.x}
                    y2={geom.stopBar.y2}
                    stroke="#e07a5f"
                    strokeWidth="2.6"
                  />
                )}
                <rect
                  x={geom.labelX - pillW / 2}
                  y={geom.labelY - 10}
                  width={pillW}
                  height={13}
                  rx={3}
                  fill="#0d0d10"
                  fillOpacity="0.9"
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

          {/* Nodes */}
          {execution.graph.nodes.map((node) => {
            const box = NODE_LAYOUT[node.id];
            const isSelected = node.id === selectedNode.id;
            const borderColor = isSelected ? '#efede8' : toneStroke(node.tone);
            return (
              <g
                key={node.id}
                className="graph-node-group"
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`${node.label}: ${node.stateText}`}
                data-testid={`graph-node-${node.id}`}
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
                  fill={isSelected ? '#1d1c26' : '#131317'}
                  stroke={borderColor}
                  strokeWidth={isSelected ? '2.0' : '1.2'}
                />
                <text
                  x={box.x + 9}
                  y={box.y + 19}
                  fill="#efede8"
                  fontSize="11"
                  fontWeight="600"
                >
                  {clipText(node.label, 24)}
                </text>
                <text
                  x={box.x + 9}
                  y={box.y + 35}
                  fill="#a5a2ae"
                  fontSize="10"
                  fontFamily="var(--font-mono)"
                >
                  {clipText(node.stateText, 25)}
                </text>
              </g>
            );
          })}
        </svg>
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
          {connectedEdges.slice(0, 2).map((edge) => (
            <div key={edge.id} className="kv-pair">
              <span className="kv-key">
                Edge {edge.from} → {edge.to} ({edge.verb})
              </span>
              <span className="kv-val">{edge.basis}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
