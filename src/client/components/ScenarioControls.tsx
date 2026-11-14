/**
 * Responsibility: Scenario controls bar containing the synthetic persona selector,
 * primary `Run paired proof` button, secondary `Run clean request` button, advanced
 * disclosure (`Revoke during generation` and `Reset demo`), and visible frozen query.
 * Trust boundary: Triggers narrow parameterless or enum-only endpoints; never transmits
 * authority fields.
 */

import { useState } from 'react';
import type { PersonaId, SafePersonaView } from '../../shared/contracts.js';
import type { WorkspaceUiState } from '../state.js';

export interface ScenarioControlsProps {
  readonly session: SafePersonaView;
  readonly frozenQuery: string;
  readonly querySha256: string;
  readonly fixtureId: string;
  readonly activeAction: WorkspaceUiState['activeAction'];
  readonly onSwitchPersona: (persona: PersonaId) => void;
  readonly onRunPaired: () => void;
  readonly onRunClean: () => void;
  readonly onRunRevoke: () => void;
  readonly onReset: () => void;
}

export function ScenarioControls({
  session,
  frozenQuery,
  querySha256,
  fixtureId,
  activeAction,
  onSwitchPersona,
  onRunPaired,
  onRunClean,
  onRunRevoke,
  onReset,
}: ScenarioControlsProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const busy = activeAction !== null;
  const isAlderRevoked = session.persona === 'alder' && session.policyEpoch !== 7;

  return (
    <section className="controls-panel" aria-label="Scenario controls" data-testid="scenario-controls">
      <div className="controls-top-row">
        <p className="thesis-line">
          <strong>Pre-inference context boundary:</strong> IAM establishes this session is{' '}
          {session.tenantLabel}, yet a missing store predicate can still return another tenant&apos;s
          memory. Vervain validates chunk provenance before Gemini sees it.
        </p>

        <div className="action-cluster">
          <div className="persona-box">
            <label htmlFor="persona-selector" className="fixture-tag">
              Synthetic fixture
            </label>
            <select
              id="persona-selector"
              data-testid="persona-selector"
              className="persona-select"
              value={session.persona}
              disabled={busy}
              onChange={(e) => onSwitchPersona(e.target.value as PersonaId)}
            >
              <option value="alder">Tenant Alder (alder-operator · commercial)</option>
              <option value="beacon">Tenant Beacon (beacon-operator · restricted)</option>
            </select>
          </div>

          <button
            type="button"
            className="btn btn--primary"
            data-testid="btn-run-paired"
            disabled={busy}
            onClick={onRunPaired}
          >
            {activeAction === 'running_paired' ? 'Running paired proof...' : 'Run paired proof'}
          </button>

          <button
            type="button"
            className="btn"
            data-testid="btn-run-clean"
            disabled={busy}
            onClick={onRunClean}
          >
            {activeAction === 'running_clean' ? 'Running clean...' : 'Run clean request'}
          </button>

          {isAlderRevoked && (
            <button
              type="button"
              className="btn btn--warning"
              data-testid="btn-quick-restore-epoch"
              disabled={busy}
              onClick={onReset}
            >
              Reset demo (restore epoch 7)
            </button>
          )}

          <button
            type="button"
            className="btn btn--subtle"
            data-testid="btn-toggle-advanced"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((prev) => !prev)}
          >
            {advancedOpen ? 'Hide advanced' : 'Advanced'}
          </button>
        </div>
      </div>

      <div className="query-strip" data-testid="frozen-query-strip">
        <div className="query-strip-main">
          <span className="query-label">Frozen query (read-only judge path)</span>
          <span className="query-text" data-testid="frozen-query-text">
            &ldquo;{frozenQuery}&rdquo;
          </span>
        </div>
        <span className="mono" style={{ color: 'var(--text-muted)' }}>
          {fixtureId} · sha256:{querySha256.slice(0, 12)}
        </span>
      </div>

      {advancedOpen && (
        <div className="advanced-drawer" data-testid="advanced-controls">
          <span className="advanced-note">
            Temporal race &amp; session controls · Synthetic fixture selector rotates HttpOnly
            session IDs and is not production authentication.
          </span>
          <div className="action-cluster">
            <button
              type="button"
              className="btn btn--subtle"
              data-testid="btn-revoke-during-generation"
              disabled={busy}
              onClick={onRunRevoke}
            >
              {activeAction === 'running_revoke'
                ? 'Advancing epoch...'
                : 'Revoke during generation'}
            </button>
            <button
              type="button"
              className="btn btn--subtle"
              data-testid="btn-reset-demo"
              disabled={busy}
              onClick={onReset}
            >
              {activeAction === 'resetting' ? 'Resetting...' : 'Reset demo'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
