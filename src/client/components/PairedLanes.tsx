/**
 * Responsibility: Synchronized side-by-side rendering of `Native only` (synthetic vulnerable
 * control) vs `Native + Vervain` (mediated context admission and release) across all 6 stages,
 * plus single-lane rendering for `Run clean request` and `Revoke during generation`.
 * Trust boundary: Display-only; pairs every status color with explicit text and denominators.
 */

import type { ArmExecutionView } from '../../shared/contracts.js';

export interface PairedLanesProps {
  readonly mode: 'empty' | 'paired' | 'single';
  readonly nativeOnly: ArmExecutionView | null;
  readonly nativePlusVervain: ArmExecutionView | null;
  readonly singleRun: ArmExecutionView | null;
  readonly inspectedArm: 'native_only' | 'native_plus_vervain';
  readonly onSelectArmForInspection: (arm: 'native_only' | 'native_plus_vervain') => void;
}

function verdictStyle(
  verdict: ArmExecutionView['structuralVerdict'],
): { label: string; className: string } {
  switch (verdict) {
    case 'foreign_context_withheld_before_gemini':
      return {
        label: 'Foreign context withheld before Gemini',
        className: 'verdict-badge verdict-badge--allowed',
      };
    case 'clean_authorized_context_transmitted':
      return {
        label: 'Authorized context transmitted & released',
        className: 'verdict-badge verdict-badge--allowed',
      };
    case 'cross_tenant_context_transmitted':
      return {
        label: 'Cross-tenant context transmitted',
        className: 'verdict-badge verdict-badge--warning',
      };
    case 'response_withheld_after_epoch_change':
      return {
        label: 'Response withheld: policy_epoch_changed',
        className: 'verdict-badge verdict-badge--withheld',
      };
    case 'no_context_admitted_native_denial_preserved':
    default:
      return {
        label: '0 admitted: native restriction preserved',
        className: 'verdict-badge verdict-badge--withheld',
      };
  }
}

function LaneCard({
  execution,
  isSelected,
  onInspect,
  showInspectToggle,
}: {
  readonly execution: ArmExecutionView;
  readonly isSelected: boolean;
  readonly onInspect?: () => void;
  readonly showInspectToggle: boolean;
}) {
  const badge = verdictStyle(execution.structuralVerdict);
  const isGoverned = execution.arm === 'native_plus_vervain';

  return (
    <article
      className={`lane-card ${isGoverned ? 'lane-card--governed' : 'lane-card--control'}`}
      data-testid={`lane-${execution.arm}`}
    >
      <div className="lane-header">
        <div className="lane-title-group">
          <h2>{execution.armLabel}</h2>
          {execution.controlWarning && (
            <div className="lane-warning-note" data-testid="control-arm-warning">
              {execution.controlWarning}
            </div>
          )}
        </div>
        <span className={badge.className} data-testid={`verdict-${execution.arm}`}>
          {badge.label}
        </span>
      </div>

      <div className="lane-metrics-row">
        <span className="lane-metric-chip" data-testid={`counts-${execution.arm}`}>
          <strong>
            {execution.counts.admitted} of {execution.counts.retrieved}
          </strong>{' '}
          retrieved chunks {isGoverned ? 'admitted' : 'entered envelope'}
          {isGoverned && execution.counts.withheld > 0
            ? ` · ${execution.counts.withheld} withheld`
            : ''}
        </span>
        <span className="lane-metric-chip mono">
          epoch {execution.policyEpochAtAdmission} → {execution.policyEpochAtRelease}
        </span>
        <span className="lane-metric-chip mono">
          {execution.providerRuntime.outcome} · {execution.providerRuntime.latencyMs}ms ·{' '}
          {execution.providerRuntime.mode.toUpperCase()}
        </span>
        {showInspectToggle && onInspect && (
          <button
            type="button"
            className={`tab-btn ${isSelected ? 'tab-btn--active' : ''}`}
            data-testid={`inspect-arm-${execution.arm}`}
            onClick={onInspect}
          >
            {isSelected ? 'Inspecting graph & receipt' : 'Inspect graph & receipt'}
          </button>
        )}
      </div>

      <ol className="steps-list">
        {execution.steps.map((step) => {
          const itemModifier =
            step.status === 'filtered_foreign_withheld'
              ? 'step-item--interrupted'
              : step.status === 'transmitted_contaminated' ||
                  step.status === 'unmediated_passthrough'
                ? 'step-item--contaminated'
                : step.status === 'withheld_release' || step.status === 'withheld_all'
                  ? 'step-item--withheld'
                  : '';

          return (
            <li
              key={step.stepId}
              className={`step-item ${itemModifier}`}
              data-testid={`step-${execution.arm}-${step.stepId}`}
            >
              <div className="step-top">
                <span className="step-name">{step.label}</span>
                <span className="step-state-tag">{step.status}</span>
              </div>
              <div className="step-summary">{step.summary}</div>
            </li>
          );
        })}
      </ol>

      <div className="reply-box" data-testid={`reply-box-${execution.arm}`}>
        <div className="reply-box-label">
          <span>
            {isGoverned
              ? execution.releaseDecision === 'released'
                ? 'Released authorized answer'
                : 'Release gate outcome (reply body withheld)'
              : 'Observed unmediated reply (synthetic control)'}
          </span>
          <span className="mono">
            allowed_task={execution.permittedTaskCompleted ? 'complete' : 'incomplete'}
          </span>
        </div>
        <p className="reply-box-body">
          {execution.releasedAnswerText !== null
            ? execution.releasedAnswerText
            : execution.providerRuntime.outcome !== 'succeeded' &&
                execution.providerRuntime.callAttempted
              ? `Provider did not return a valid answer (${execution.providerRuntime.outcome} in ${execution.providerRuntime.mode} mode). Context-boundary admission decisions remain recorded in receipt ${execution.receiptId}.`
              : `No reply text delivered (${execution.releaseReason}). Reference receipt ${execution.receiptId}.`}
        </p>
      </div>
    </article>
  );
}

export function PairedLanes({
  mode,
  nativeOnly,
  nativePlusVervain,
  singleRun,
  inspectedArm,
  onSelectArmForInspection,
}: PairedLanesProps) {
  if (mode === 'empty') {
    return (
      <section className="paired-section" data-testid="empty-proof-stage">
        <div className="empty-stage">
          <div>
            <h2>Compare the same retrieval defect with and without Vervain</h2>
            <p>
              Click <strong>Run paired proof</strong> above to execute the frozen query across two
              synchronized lanes. Both lanes receive the exact same two chunks from a deliberately
              misconfigured retriever that omitted its internal tenant predicate.
            </p>
            <p style={{ marginBottom: 0 }}>
              In <strong>Native only</strong>, Tenant Beacon&apos;s restricted note enters the
              outbound Gemini envelope. In <strong>Native + Vervain</strong>, deterministic
              provenance validation withholds Beacon (<span className="mono">tenant_mismatch</span>)
              before inference while Tenant Alder&apos;s renewal guidance continues to Gemini.
            </p>
          </div>
          <div className="fixture-preview-cards">
            <div className="fixture-mini-card fixture-mini-card--allowed">
              <div className="query-label">Authorized Tenant A record</div>
              <div className="mono" style={{ marginTop: 4, color: 'var(--text-primary)' }}>
                alder/renewal-playbook-v3
              </div>
              <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
                Tenant Alder · customer-commercial · epoch 7
              </div>
            </div>
            <div className="fixture-mini-card fixture-mini-card--foreign">
              <div className="query-label">Foreign Tenant B record (synthetic defect)</div>
              <div className="mono" style={{ marginTop: 4, color: 'var(--text-primary)' }}>
                beacon/strategy-note-v2
              </div>
              <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
                Tenant Beacon · restricted-strategy · epoch 11 + untrusted override text
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (mode === 'single' && singleRun) {
    return (
      <section className="paired-section" data-testid="single-proof-stage">
        <div className="paired-grid paired-grid--single">
          <LaneCard execution={singleRun} isSelected={true} showInspectToggle={false} />
        </div>
      </section>
    );
  }

  if (nativeOnly && nativePlusVervain) {
    return (
      <section className="paired-section" data-testid="paired-proof-stage">
        <div className="paired-grid">
          <LaneCard
            execution={nativeOnly}
            isSelected={inspectedArm === 'native_only'}
            onInspect={() => onSelectArmForInspection('native_only')}
            showInspectToggle={true}
          />
          <LaneCard
            execution={nativePlusVervain}
            isSelected={inspectedArm === 'native_plus_vervain'}
            onInspect={() => onSelectArmForInspection('native_plus_vervain')}
            showInspectToggle={true}
          />
        </div>
      </section>
    );
  }

  return null;
}
