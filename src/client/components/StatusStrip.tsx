/**
 * Responsibility: Top status strip displaying product identity, synthetic persona,
 * mediation state, policy epoch binding, Gemini model/transport mode, and active boundary count.
 * Trust boundary: Pure display component; renders server-supplied status fields verbatim.
 */

import { APP_SUBTITLE, APP_TITLE } from '../../shared/config.js';
import type { RuntimeStatusView, SafePersonaView } from '../../shared/contracts.js';

export interface StatusStripProps {
  readonly session: SafePersonaView;
  readonly runtime: RuntimeStatusView;
}

export function StatusStrip({ session, runtime }: StatusStripProps) {
  const isMock = runtime.mode === 'mock';
  const liveUnconfigured = runtime.mode === 'live' && !runtime.liveKeyConfigured;

  return (
    <header className="status-strip" data-testid="status-strip">
      <div className="brand-cluster">
        <span className="brand-mark">
          {/* Abstract converging-branch aperture glyph (no literal shield or leaf) */}
          <svg
            className="aperture-glyph"
            viewBox="0 0 18 18"
            fill="none"
            aria-hidden="true"
          >
            <path d="M2 4.5 L8.5 8.2" stroke="#efede8" strokeWidth="1.4" strokeLinecap="round" />
            <path
              d="M2 13.5 L7.2 10.4"
              stroke="#e07a5f"
              strokeWidth="1.4"
              strokeDasharray="2 2"
              strokeLinecap="round"
            />
            <line x1="9.5" y1="2.5" x2="9.5" y2="6.8" stroke="#9b8af5" strokeWidth="1.6" />
            <line x1="9.5" y1="11.2" x2="9.5" y2="15.5" stroke="#9b8af5" strokeWidth="1.6" />
            <path d="M9.5 9 L16 9" stroke="#58b889" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {APP_TITLE}
        </span>
        <span className="brand-subtitle">{APP_SUBTITLE}</span>
      </div>

      <div className="strip-pills">
        <span className="strip-pill" data-testid="strip-persona">
          <span>Synthetic persona:</span>
          <strong>{session.tenantLabel}</strong>
          <span className="mono">({session.principalDisplay})</span>
        </span>

        <span className="strip-pill strip-pill--violet" data-testid="strip-mediation">
          <span className="status-dot" aria-hidden="true" />
          <span>
            {runtime.contextMediationState === 'active'
              ? 'Context mediation active'
              : 'Context mediation degraded'}
          </span>
        </span>

        <span className="strip-pill" data-testid="strip-policy">
          <span>Policy</span>
          <strong className="mono">
            {session.policyId}@{session.policyEpoch}
          </strong>
        </span>

        <span
          className={`strip-pill ${isMock || liveUnconfigured ? 'strip-pill--warning' : ''}`}
          data-testid="strip-provider"
        >
          <span
            className={`status-dot ${isMock || liveUnconfigured ? 'status-dot--warning' : ''}`}
            aria-hidden="true"
          />
          <span>{runtime.provider}</span>
          <span className="mono">{runtime.configuredModel}</span>
          <strong className="mono">
            {isMock
              ? 'MOCK TRANSPORT'
              : runtime.liveKeyConfigured
                ? 'LIVE SDK'
                : 'LIVE (KEY UNSET)'}
          </strong>
        </span>

        <span className="strip-pill" data-testid="strip-boundaries">
          <strong className="mono">
            {runtime.mediatedBoundariesCount}/{runtime.mediatedBoundariesTotal} in this demo
          </strong>
          <span>· {runtime.boundaryScopeNote}</span>
        </span>
      </div>
    </header>
  );
}
