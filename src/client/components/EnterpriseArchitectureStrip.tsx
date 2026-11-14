/**
 * Responsibility: Post-IAM / Pre-Egress Inference Boundary Architecture panel illustrating
 * where session IAM ends, where post-egress DLP/SIEM arrives after generation, and how
 * Vervain mediates context admission, scope-salted KV lifecycles, and release-time epochs
 * across hosted frontier APIs and self-hosted open-weight inference engines.
 * Trust boundary: Read-only architectural disclosure and reference preset inspector;
 * distinguishes active web-demo boundaries from reference open-weight simulations.
 */

import { useState } from 'react';
import type {
  EnterprisePresetId,
  EnterprisePresetSummary,
  InferenceProofBadgeState,
  InferenceProofStatusView,
  OpenWeightEngineProfile,
} from '../../shared/contracts.js';

export interface EnterpriseArchitectureStripProps {
  readonly presets: readonly EnterprisePresetSummary[];
  readonly engineProfiles: readonly OpenWeightEngineProfile[];
  readonly inferenceProof: InferenceProofStatusView | null;
}

function formatDeploymentClass(
  deploymentClass: OpenWeightEngineProfile['deploymentClass'],
): string {
  switch (deploymentClass) {
    case 'open_weight_self_hosted':
      return 'Open-weight self-hosted';
    case 'neocloud_disaggregated':
      return 'Multi-tenant neocloud';
    case 'hosted_frontier_api':
      return 'Hosted frontier API';
  }
}

function gpuBadgeClassName(badgeState: InferenceProofBadgeState): string {
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

export function EnterpriseArchitectureStrip({
  presets,
  engineProfiles,
  inferenceProof,
}: EnterpriseArchitectureStripProps) {
  const [selectedPresetId, setSelectedPresetId] = useState<EnterprisePresetId | null>(null);

  const activePreset =
    presets.find((p) => p.presetId === selectedPresetId) ?? presets[0] ?? null;

  const gpuBadgeState: InferenceProofBadgeState =
    inferenceProof?.badgeState ?? 'NO GPU RUN RECORDED';

  return (
    <section
      className="panel-card"
      style={{ marginTop: 14 }}
      aria-label="Post-IAM and Pre-Egress Inference Boundary Architecture"
      data-testid="enterprise-architecture-strip"
    >
      {/* Header & Demo Scope Note */}
      <div className="panel-header" style={{ alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ maxWidth: 960 }}>
          <h3 style={{ fontSize: 15 }}>
            Why IAM and DLP Miss the Inference Layer: 1/3 of Enterprise Tokens Run Open Weights
            Ungoverned
          </h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            Demo scope note: Active mediation in this web app governs 2/2 server boundaries
            (retrieval-to-Gemini envelope and epoch release gate). Open-weight engine hooks and
            deployment presets below show target enterprise integration surfaces and deterministic
            reference simulations.
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <span className="strip-pill strip-pill--violet mono">Post-IAM · Pre-Egress</span>
          <span className={`${gpuBadgeClassName(gpuBadgeState)} mono`}>
            GPU proof: {gpuBadgeState}
          </span>
        </div>
      </div>

      {/* 4-Column Post-IAM / Pre-Egress Architectural Pipeline */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(225px, 1fr))',
          gap: 10,
          marginBottom: 14,
        }}
      >
        {/* Stage 1: Identity & IAM */}
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--bg-inset)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
            }}
          >
            <span className="query-label">1. Identity &amp; IAM</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
              upstream -&gt;
            </span>
          </div>
          <strong style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
            Okta · Microsoft Entra · WorkOS
          </strong>
          <div style={{ fontSize: 12, color: 'var(--status-warning)' }}>
            Ends at session authentication
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Verifies principal login, then steps aside before retrieval assembly or KV block reuse.
          </div>
        </div>

        {/* Stage 2: Vervain Runtime Firewall */}
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--accent-violet-soft)',
            border: '1px solid var(--border-violet)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
            }}
          >
            <span className="query-label" style={{ color: 'var(--accent-violet)' }}>
              2. Vervain Runtime Firewall
            </span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--accent-violet)' }}>
              Audit · Alert · Govern
            </span>
          </div>
          <strong style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
            Pre-inference context gate · Scope-salted KV · Epoch release gate
          </strong>
          <div style={{ fontSize: 12, color: '#8ee0b5' }}>
            Enforces tenant, classification &amp; epoch before generation
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            Binds server-owned authority to context admission, prefix cache_salt, and release.
          </div>
        </div>

        {/* Stage 3: Inference Engines */}
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--bg-inset)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
            }}
          >
            <span className="query-label">3. Inference Engines</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
              compute -&gt;
            </span>
          </div>
          <strong style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
            Google Gemini API + Open-Weight Runtimes
          </strong>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            vLLM · SGLang · Ollama · NVIDIA Dynamo · Multi-Tenant Neoclouds
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Processes only admitted chunks and scope-matched KV blocks under active epoch.
          </div>
        </div>

        {/* Stage 4: Post-Egress Stack */}
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--bg-inset)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
            }}
          >
            <span className="query-label">4. Post-Egress Stack</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
              audit sink
            </span>
          </div>
          <strong style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
            Cyera · Palo Alto · Zscaler · SIEM
          </strong>
          <div style={{ fontSize: 12, color: 'var(--status-warning)' }}>
            Acts after generation; receives content-free SHA-256 receipts
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Regex/DLP inspects outbound text too late to prevent cross-tenant synthesis in weights.
          </div>
        </div>
      </div>

      {/* Interactive Enterprise & Neocloud Deployment Preset Tabs */}
      {activePreset !== null && (
        <div className="coverage-section" style={{ marginTop: 12, paddingTop: 12 }}>
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
            <div>
              <h4 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 12.5 }}>
                Enterprise &amp; Neocloud Deployment Presets
              </h4>
            </div>

            <div
              className="tab-group"
              role="tablist"
              aria-label="Enterprise and neocloud deployment presets"
              style={{ flexWrap: 'wrap' }}
            >
              {presets.map((preset) => {
                const isSelected = preset.presetId === activePreset.presetId;
                return (
                  <button
                    key={preset.presetId}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    className={`tab-btn ${isSelected ? 'tab-btn--active' : ''}`}
                    data-testid={`preset-tab-${preset.presetId}`}
                    onClick={() => setSelectedPresetId(preset.presetId)}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div
            className="node-inspector"
            style={{ marginTop: 0 }}
            data-testid="preset-detail-card"
          >
            <div
              className="node-inspector-header"
              style={{ flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <strong>{activePreset.label}</strong>
                <span className="strip-pill mono">{activePreset.sector}</span>
              </div>

              <span
                className="verdict-badge verdict-badge--allowed mono"
                data-testid="preset-chunk-denominator"
              >
                {activePreset.admittedCount} of {activePreset.retrievedDenominator} admitted ·{' '}
                {activePreset.withheldCount} withheld ({activePreset.primaryWithholdReason})
              </span>
            </div>

            <div className="kv-grid">
              <div className="kv-pair">
                <span className="kv-key">Upstream IAM</span>
                <span className="kv-val mono">{activePreset.iamUpstream}</span>
              </div>
              <div className="kv-pair">
                <span className="kv-key">Inference runtime target</span>
                <span className="kv-val mono">{activePreset.inferenceRuntimeTarget}</span>
              </div>
              <div className="kv-pair">
                <span className="kv-key">Post-IAM blind spot</span>
                <span className="kv-val">{activePreset.postIamBlindSpot}</span>
              </div>
              <div className="kv-pair">
                <span className="kv-key">Why post-egress DLP arrives late</span>
                <span className="kv-val">{activePreset.preEgressFailureWhyDlpIsLate}</span>
              </div>
              <div className="kv-pair">
                <span className="kv-key">Vervain runtime intervention</span>
                <span className="kv-val">{activePreset.vervainInterventionSummary}</span>
              </div>
              <div className="kv-pair">
                <span className="kv-key">Downstream egress &amp; receipt sink</span>
                <span className="kv-val mono">{activePreset.downstreamEgress}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Compact Engine Enforcement Matrix */}
      <div className="coverage-section" style={{ marginTop: 14, paddingTop: 12 }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 4,
          }}
        >
          <h4 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 12.5 }}>
            Inference Engine Enforcement Matrix
          </h4>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Honest runtime evidence status per engine target in this build
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="scoped-table" data-testid="engine-profile-matrix">
            <thead>
              <tr>
                <th>Engine</th>
                <th>KV &amp; Prefix Surface</th>
                <th>Unguarded Failure Mode</th>
                <th>Vervain Enforcement Hook</th>
                <th>Demo Evidence Status</th>
              </tr>
            </thead>
            <tbody>
              {engineProfiles.map((profile) => {
                const isActiveInApp = profile.demoEvidenceStatus === 'active_in_this_app';
                return (
                  <tr key={profile.engineId} data-testid={`engine-row-${profile.engineId}`}>
                    <td>
                      <strong>{profile.displayName}</strong>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {formatDeploymentClass(profile.deploymentClass)}
                      </div>
                    </td>
                    <td className="mono">{profile.kvAndPrefixSurface}</td>
                    <td>{profile.unguardedFailureMode}</td>
                    <td>{profile.vervainEnforcementHook}</td>
                    <td>
                      <span
                        className={
                          isActiveInApp
                            ? 'verdict-badge verdict-badge--allowed mono'
                            : 'strip-pill mono'
                        }
                      >
                        {profile.demoEvidenceStatus}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
