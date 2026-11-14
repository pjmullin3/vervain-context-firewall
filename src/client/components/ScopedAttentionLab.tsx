/**
 * Responsibility: Secondary technical disclosure panel executing and rendering the
 * CPU/TypeScript Scoped Attention reference math over a 4-block paged KV table,
 * the Carbon 3 self-hosted GPU evidence verifier status, a 4-mode open-weight KV
 * and prefix-cache lifecycle explorer, and an online block-tiled Flash recurrence trace.
 * Trust boundary: Request scope tag comes exclusively from the server-owned session;
 * browser never supplies a scope parameter, and GPU metrics are never staged or faked.
 */

import { useState } from 'react';
import { SCOPED_ATTENTION_LIMITATION_LABEL } from '../../shared/config.js';
import type {
  InferenceProofBadgeState,
  InferenceProofStatusView,
  KvLifecycleModeId,
  OnlineTileStepEvidence,
  ScopedAttentionProofView,
} from '../../shared/contracts.js';

export interface ScopedAttentionLabProps {
  readonly isOpen: boolean;
  readonly loading: boolean;
  readonly proof: ScopedAttentionProofView | null;
  readonly onToggle: () => void;
  readonly inferenceProof?: InferenceProofStatusView | null;
}

function inferenceBadgeClassName(badgeState: InferenceProofBadgeState): string {
  switch (badgeState) {
    case 'LIVE H200 RUN':
    case 'RECORDED H200 RUN':
      return 'verdict-badge verdict-badge--allowed';
    case 'VERIFICATION FAILED':
      return 'verdict-badge verdict-badge--withheld';
    case 'LOCAL TEST':
      return 'verdict-badge';
    case 'NO GPU RUN RECORDED':
    case 'NO VERDICT':
    case 'INCOMPLETE':
    case 'UNSUPPORTED':
    default:
      return 'verdict-badge verdict-badge--warning';
  }
}

function isSkippedHeaderDisposition(
  disposition: OnlineTileStepEvidence['headerCheckDisposition'],
): boolean {
  return (
    disposition === 'skipped_foreign_scope_zero_kv_read' ||
    disposition === 'skipped_stale_generation_zero_kv_read'
  );
}

export function ScopedAttentionLab({
  isOpen,
  loading,
  proof,
  onToggle,
  inferenceProof,
}: ScopedAttentionLabProps) {
  const [showMathJson, setShowMathJson] = useState(false);
  const [selectedKvModeId, setSelectedKvModeId] = useState<KvLifecycleModeId>(
    'contaminated_block_table',
  );

  const badgeState: InferenceProofBadgeState =
    inferenceProof?.badgeState ?? 'NO GPU RUN RECORDED';
  const verifierVerdict = inferenceProof?.verifierVerdict ?? 'NOT_CONFIGURED';
  const primaryReasonCode = inferenceProof?.primaryReasonCode ?? 'NO_ARTIFACT_CONFIGURED';
  const claimBoundary =
    inferenceProof?.claimBoundary ??
    'Self-hosted GPU evidence requires a verified Carbon 3 artifact bundle; this workspace executes TypeScript CPU reference math and mediated Gemini context boundaries only.';
  const runtimeManifest = inferenceProof?.runtimeManifest ?? null;

  const kvModes = proof?.kvModes ?? [];
  const activeKvMode =
    kvModes.find((m) => m.modeId === selectedKvModeId) ?? kvModes[0] ?? null;
  const onlineTileSteps = proof?.onlineTileSteps ?? [];

  return (
    <section
      className="scoped-lab-wrapper"
      aria-label="Scoped Attention Reference Lab"
      data-testid="scoped-attention-section"
    >
      <div className="panel-card">
        <div className="panel-header" style={{ marginBottom: 10 }}>
          <div>
            <h3>Self-Hosted Roadmap Layer: Scoped Attention &amp; Open-Weight KV Lab</h3>
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

        {/* Self-Hosted GPU / Carbon 3 Evidence Verifier Banner */}
        <div
          className="node-inspector"
          style={{
            marginTop: 0,
            marginBottom: isOpen && proof ? 12 : 0,
            padding: '10px 12px',
          }}
          data-testid="inference-proof-card"
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 12.5 }}>
                Self-Hosted GPU / Carbon 3 Evidence Verifier
              </strong>
              <span
                className={`${inferenceBadgeClassName(badgeState)} mono`}
                data-testid="inference-proof-badge"
              >
                {badgeState}
              </span>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <span className="lane-metric-chip mono">
                verdict: <strong>{verifierVerdict}</strong>
              </span>
              <span className="lane-metric-chip mono">reason: {primaryReasonCode}</span>
              {inferenceProof?.digestMatch !== null &&
                inferenceProof?.digestMatch !== undefined && (
                  <span className="lane-metric-chip mono">
                    sha256_match: {inferenceProof.digestMatch ? 'true' : 'false'}
                  </span>
                )}
            </div>
          </div>

          {runtimeManifest !== null ? (
            <div className="kv-grid" style={{ marginBottom: 6 }}>
              <div className="kv-pair">
                <span className="kv-key">GPU model &amp; tensor parallelism</span>
                <span className="kv-val mono">
                  {runtimeManifest.gpuModel} (count={runtimeManifest.gpuCount} · TP=
                  {runtimeManifest.tpSize})
                </span>
              </div>
              <div className="kv-pair">
                <span className="kv-key">Engine &amp; attention backend</span>
                <span className="kv-val mono">
                  {runtimeManifest.engineName} · {runtimeManifest.selectedBackend} (
                  {runtimeManifest.modelId})
                </span>
              </div>
              <div className="kv-pair">
                <span className="kv-key">KV cache dtype &amp; paging</span>
                <span className="kv-val mono">
                  {runtimeManifest.kvDtype} · block_size={runtimeManifest.blockSize} · prefix_cache=
                  {runtimeManifest.prefixCachingEnabled ? 'enabled' : 'disabled'}
                </span>
              </div>
              <div className="kv-pair">
                <span className="kv-key">Active guard mode</span>
                <span className="kv-val mono">{runtimeManifest.guardMode}</span>
              </div>
            </div>
          ) : (
            <div
              className="mono"
              style={{
                padding: '5px 8px',
                marginBottom: 6,
                background: 'var(--bg-inset)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
                fontSize: 11.5,
              }}
            >
              No H200 artifact loaded prior to GPU GO
            </div>
          )}

          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            <strong style={{ color: 'var(--text-secondary)' }}>Claim boundary:</strong>{' '}
            {claimBoundary}
          </div>
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
                      <td className="mono">
                        [{blk.rawScores.map((s) => s.toFixed(3)).join(', ')}]
                      </td>
                      <td className="mono">{blk.baselineBlockMass.toFixed(6)}</td>
                      <td className="mono">{blk.scopedBlockMass.toFixed(6)}</td>
                      <td className="mono">{blk.maskDisposition}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 4-Mode Open-Weight KV & Prefix-Cache Lifecycle Explorer */}
            {activeKvMode !== null && kvModes.length > 0 && (
              <div
                className="coverage-section"
                style={{ marginTop: 16, paddingTop: 14 }}
                data-testid="kv-lifecycle-explorer"
              >
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <div>
                    <h4 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 13 }}>
                      4-Mode Open-Weight KV &amp; Prefix-Cache Lifecycle Explorer
                    </h4>
                    <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      Deterministic reference simulation of open-weight serving failure modes and
                      scope-bound controls
                    </span>
                  </div>
                </div>

                <div
                  className="tab-group"
                  role="tablist"
                  aria-label="Open-weight KV lifecycle modes"
                  style={{ flexWrap: 'wrap', marginBottom: 10 }}
                >
                  {kvModes.map((mode) => {
                    const active = mode.modeId === activeKvMode.modeId;
                    return (
                      <button
                        key={mode.modeId}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        className={`tab-btn ${active ? 'tab-btn--active' : ''}`}
                        data-testid={`kv-mode-tab-${mode.modeId}`}
                        onClick={() => setSelectedKvModeId(mode.modeId)}
                      >
                        {mode.title}
                      </button>
                    );
                  })}
                </div>

                <div
                  className="node-inspector"
                  style={{ marginTop: 0 }}
                  data-testid="kv-mode-detail"
                >
                  <div className="node-inspector-header" style={{ flexWrap: 'wrap' }}>
                    <strong>{activeKvMode.title}</strong>
                    <span className="strip-pill strip-pill--violet mono">
                      {activeKvMode.engineSurface}
                    </span>
                  </div>

                  <div className="kv-grid" style={{ marginBottom: 10 }}>
                    <div className="kv-pair">
                      <span className="kv-key">Defect mechanism</span>
                      <span className="kv-val">{activeKvMode.defectMechanism}</span>
                    </div>
                    <div className="kv-pair">
                      <span className="kv-key">Vervain runtime control</span>
                      <span className="kv-val">{activeKvMode.vervainControl}</span>
                    </div>
                  </div>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
                      gap: 10,
                      marginBottom: 10,
                    }}
                  >
                    <div className="fixture-mini-card fixture-mini-card--foreign">
                      <div className="query-label">Unguarded engine outcome</div>
                      <div style={{ marginTop: 4, color: 'var(--text-primary)' }}>
                        {activeKvMode.unguardedOutcomeSummary}
                      </div>
                    </div>
                    <div className="fixture-mini-card fixture-mini-card--allowed">
                      <div className="query-label">Vervain governed outcome</div>
                      <div style={{ marginTop: 4, color: 'var(--text-primary)' }}>
                        {activeKvMode.governedOutcomeSummary}
                      </div>
                    </div>
                  </div>

                  <div className="kv-grid">
                    <div className="kv-pair">
                      <span className="kv-key">
                        Prefix hash: unguarded vs scope-salted (cache_salt)
                      </span>
                      <span className="kv-val mono">
                        {activeKvMode.prefixHashUnguardedHex} -&gt;{' '}
                        {activeKvMode.prefixHashSaltedHex} (cache_salt)
                      </span>
                    </div>
                    <div className="kv-pair">
                      <span className="kv-key">
                        Foreign attention mass (unguarded -&gt; governed)
                      </span>
                      <span className="kv-val mono">
                        {activeKvMode.unguardedForeignMass.toFixed(6)} -&gt;{' '}
                        {activeKvMode.governedForeignMass.toFixed(6)} (clean-twin max |Δ|:{' '}
                        {activeKvMode.maxOutputDeltaVsCleanTwin.toExponential(2)})
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Online Block-Tiled (m_i, l_i, O_i) Flash Recurrence Table */}
            {onlineTileSteps.length > 0 && (
              <div className="coverage-section" style={{ marginTop: 16, paddingTop: 14 }}>
                <div style={{ marginBottom: 6 }}>
                  <h4 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 13 }}>
                    Online Block-Tiled (m_i, l_i, O_i) Flash Recurrence Trace
                  </h4>
                  <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    Block header scope &amp; allocation generation check executes before loading K/V
                    tensors into tile SRAM
                  </span>
                </div>

                <div style={{ overflowX: 'auto' }}>
                  <table className="scoped-table" data-testid="online-tile-table">
                    <thead>
                      <tr>
                        <th>Slot</th>
                        <th>Phys Block</th>
                        <th>Block Scope</th>
                        <th>Alloc / Expected Gen</th>
                        <th>Header Check Disposition</th>
                        <th>KV Tensor Reads</th>
                        <th>Running m_i</th>
                        <th>Running l_i</th>
                        <th>Normalized O_i</th>
                      </tr>
                    </thead>
                    <tbody>
                      {onlineTileSteps.map((step) => {
                        const skipped =
                          step.kvTensorReadsPerformed === 0 ||
                          isSkippedHeaderDisposition(step.headerCheckDisposition);
                        const genMismatch =
                          step.allocationGeneration !== step.expectedGeneration;

                        return (
                          <tr
                            key={step.stepIndex}
                            className={skipped ? 'scoped-row--foreign' : ''}
                          >
                            <td className="mono">#{step.logicalSlot}</td>
                            <td className="mono">phys#{step.physicalBlockId}</td>
                            <td className="mono">{step.blockScopeHex}</td>
                            <td className="mono">
                              <span
                                style={{
                                  color: genMismatch
                                    ? 'var(--status-warning)'
                                    : 'var(--text-primary)',
                                }}
                              >
                                {step.allocationGeneration} / {step.expectedGeneration}
                              </span>
                            </td>
                            <td className="mono">{step.headerCheckDisposition}</td>
                            <td className="mono">
                              {step.kvTensorReadsPerformed === 0 ? (
                                <span className="verdict-badge verdict-badge--allowed mono">
                                  0 reads (header skip)
                                </span>
                              ) : (
                                <span>{step.kvTensorReadsPerformed} reads</span>
                              )}
                            </td>
                            <td className="mono">
                              {step.runningMaxLogitM === null
                                ? '-inf'
                                : step.runningMaxLogitM.toFixed(4)}
                            </td>
                            <td className="mono">{step.runningDenomL.toFixed(6)}</td>
                            <td className="mono">
                              [{step.runningNormalizedOutput.map((v) => v.toFixed(3)).join(', ')}]
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div
              style={{
                marginTop: 12,
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
                {showMathJson
                  ? 'Hide equation & JSON evidence'
                  : 'Inspect equation & JSON evidence'}
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
