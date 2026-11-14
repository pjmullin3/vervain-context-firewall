/**
 * Responsibility: Secondary technical disclosure panel executing and rendering the
 * CPU/TypeScript Scoped Attention reference math over a 4-block paged KV table,
 * explicitly labeled everywhere as non-production algorithm evidence.
 * Trust boundary: Request scope tag comes exclusively from the server-owned session;
 * browser never supplies a scope parameter.
 */

import { useState } from 'react';
import { SCOPED_ATTENTION_LIMITATION_LABEL } from '../../shared/config.js';
import type { ScopedAttentionProofView } from '../../shared/contracts.js';

export interface ScopedAttentionLabProps {
  readonly isOpen: boolean;
  readonly loading: boolean;
  readonly proof: ScopedAttentionProofView | null;
  readonly onToggle: () => void;
}

export function ScopedAttentionLab({
  isOpen,
  loading,
  proof,
  onToggle,
}: ScopedAttentionLabProps) {
  const [showMathJson, setShowMathJson] = useState(false);

  return (
    <section
      className="scoped-lab-wrapper"
      aria-label="Scoped Attention Reference Lab"
      data-testid="scoped-attention-section"
    >
      <div className="panel-card">
        <div className="panel-header" style={{ marginBottom: isOpen ? 10 : 0 }}>
          <div>
            <h3>Self-Hosted Roadmap Layer: Scoped Attention Reference Lab</h3>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {SCOPED_ATTENTION_LIMITATION_LABEL}
            </span>
          </div>

          <button
            type="button"
            className="btn"
            data-testid="btn-open-scoped-attention"
            aria-expanded={isOpen}
            disabled={loading}
            onClick={onToggle}
          >
            {loading
              ? 'Computing reference attention...'
              : isOpen
                ? 'Close scoped attention proof'
                : 'Open scoped attention proof'}
          </button>
        </div>

        {isOpen && proof && (
          <div data-testid="scoped-attention-panel">
            <div className="limitation-callout" data-testid="scoped-limitation-banner">
              {proof.limitationBanner}
            </div>

            <div className="kv-grid" style={{ marginBottom: 12 }}>
              <div className="kv-pair">
                <span className="kv-key">Server-owned request scope tag</span>
                <span className="kv-val mono" data-testid="scoped-request-tag">
                  {proof.requestScopeHex} ({proof.tenantContextLabel})
                </span>
              </div>
              <div className="kv-pair">
                <span className="kv-key">Scope mismatch counter (foreign blocks masked)</span>
                <span className="kv-val mono" data-testid="scoped-mismatch-count">
                  {proof.mismatchCounter} of {proof.blocks.length} blocks masked before softmax
                </span>
              </div>
              <div className="kv-pair">
                <span className="kv-key">Foreign block post-softmax mass</span>
                <span className="kv-val mono" data-testid="scoped-foreign-mass">
                  {proof.foreignPostMaskMass.toFixed(6)} (baseline:{' '}
                  {(
                    proof.blocks.find((b) => !b.scopeMatchesRequest)?.baselineBlockMass ?? 0
                  ).toFixed(6)}
                  )
                </span>
              </div>
              <div className="kv-pair">
                <span className="kv-key">Clean allowed-twin max |Δ| (scoped vs baseline)</span>
                <span className="kv-val mono" data-testid="scoped-clean-delta">
                  {proof.cleanAllowedTwinMaxAbsDelta.toExponential(2)} (L2 contaminated shift:{' '}
                  {proof.contaminatedVsScopedL2Delta.toFixed(6)})
                </span>
              </div>
            </div>

            {/* Post-computation Scope Aperture SVG illustrating foreign block interruption */}
            <div className="graph-svg-wrap" style={{ marginBottom: 10 }}>
              <svg
                className="causal-svg"
                viewBox="0 0 920 140"
                role="img"
                aria-label="Reference paged KV block scope aperture diagram"
              >
                <line
                  x1={380}
                  y1={10}
                  x2={380}
                  y2={130}
                  stroke="#9b8af5"
                  strokeWidth="1.4"
                  strokeDasharray="3 3"
                />
                <text
                  x={388}
                  y={18}
                  fill="#9b8af5"
                  fontSize="10.5"
                  fontFamily="var(--font-mono)"
                >
                  pre-softmax scope mask ({proof.requestScopeHex})
                </text>
                {proof.blocks.map((blk, idx) => {
                  const y = 36 + idx * 26;
                  const matches = blk.scopeMatchesRequest;
                  return (
                    <g key={blk.logicalSlot}>
                      <text
                        x={12}
                        y={y + 4}
                        fill="#efede8"
                        fontSize="10.5"
                        fontFamily="var(--font-mono)"
                      >
                        slot {blk.logicalSlot} · phys#{blk.physicalBlockId} · {blk.scopeTagHex}
                      </text>
                      <path
                        d={`M 236 ${y} L ${matches ? 462 : 372} ${y}`}
                        stroke={matches ? '#58b889' : '#e07a5f'}
                        strokeWidth="1.8"
                        strokeDasharray={matches ? undefined : '4 3'}
                        className="edge-animated"
                      />
                      {!matches && (
                        <line
                          x1={372}
                          y1={y - 6}
                          x2={372}
                          y2={y + 6}
                          stroke="#e07a5f"
                          strokeWidth="2.5"
                        />
                      )}
                      <text
                        x={474}
                        y={y + 4}
                        fill={matches ? '#b9b6bf' : '#f3a693'}
                        fontSize="10.5"
                        fontFamily="var(--font-mono)"
                      >
                        baseline={blk.baselineBlockMass.toFixed(4)} → scoped=
                        {blk.scopedBlockMass.toFixed(6)} ({blk.maskDisposition})
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table className="scoped-table" data-testid="scoped-blocks-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Block &amp; Scope Tag</th>
                    <th>Token Positions (valid)</th>
                    <th>Scaled Q·Kᵀ / √d</th>
                    <th>Baseline Mass</th>
                    <th>Scoped Mass</th>
                    <th>Disposition</th>
                  </tr>
                </thead>
                <tbody>
                  {proof.blocks.map((blk) => (
                    <tr
                      key={blk.logicalSlot}
                      className={blk.scopeMatchesRequest ? '' : 'scoped-row--foreign'}
                    >
                      <td className="mono">#{blk.logicalSlot}</td>
                      <td>
                        <div>{blk.blockLabel}</div>
                        <div className="mono" style={{ color: 'var(--text-muted)' }}>
                          tag={blk.scopeTagHex}
                        </div>
                      </td>
                      <td className="mono">
                        [{blk.tokenPositions.join(', ')}] (
                        {blk.validTokenFlags.map((v) => (v ? '1' : '0')).join(',')})
                      </td>
                      <td className="mono">[{blk.rawScores.map((s) => s.toFixed(3)).join(', ')}]</td>
                      <td className="mono">{blk.baselineBlockMass.toFixed(6)}</td>
                      <td className="mono">{blk.scopedBlockMass.toFixed(6)}</td>
                      <td className="mono">{blk.maskDisposition}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div
              style={{
                marginTop: 10,
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
                Fail-closed checks: {proof.allMaskedControlStatus} ·{' '}
                {proof.invalidBlockControlStatus}
              </span>
              <button
                type="button"
                className="btn btn--subtle"
                data-testid="btn-toggle-scoped-json"
                aria-expanded={showMathJson}
                onClick={() => setShowMathJson((prev) => !prev)}
              >
                {showMathJson ? 'Hide equation & JSON evidence' : 'Inspect equation & JSON evidence'}
              </button>
            </div>

            {showMathJson && (
              <pre className="raw-json-pre" data-testid="scoped-raw-json">
                {[
                  'Reference equation (executed on server in TypeScript, d = 4, block_size = 2):',
                  '  scores          = (Q @ K^T) / sqrt(d)',
                  '  combined_mask   = ordinary_validity_mask AND (block_scope == request_scope)',
                  '  masked_scores   = where(combined_mask, scores, -Infinity)',
                  '  weights         = stable_max_shifted_softmax(masked_scores)',
                  '  output          = weights @ V',
                  '',
                  JSON.stringify(proof, null, 2),
                ].join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
