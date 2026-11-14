import React, { useId } from "react";
import { COPY_CONTRACT } from "../copyContract.js";
import { formatCountRatioMetric } from "../summary.js";
import type { LaneId, LaneReplayEvidence, ValidatedEvidenceBundle } from "../types.js";

export interface PairedComparisonProps {
  readonly validated: ValidatedEvidenceBundle;
  readonly activeLane: LaneId;
  readonly onSelectLane: (lane: LaneId) => void;
}

function formatDispatchYesNo(lane: LaneReplayEvidence): string {
  if (lane.summary.foreign_backend_dispatched === null) {
    return `△ Not recorded (${COPY_CONTRACT.noGpuRecordedBanner})`;
  }
  return lane.summary.foreign_backend_dispatched
    ? `→ Yes (${lane.summary.foreign_block_alias} reached backend in baseline test)`
    : `┤ No (${lane.summary.foreign_block_alias} stopped before dispatch)`;
}

function formatCompletionYesNo(lane: LaneReplayEvidence): string {
  if (lane.summary.allowed_request_completed === null) {
    return `△ Not recorded (${COPY_CONTRACT.noGpuRecordedBanner})`;
  }
  const ratio = formatCountRatioMetric(lane.correctness.allowed_requests_completed);
  return lane.summary.allowed_request_completed
    ? `✓ Yes (${ratio})`
    : `✕ No (${ratio})`;
}

function formatGeneration(lane: LaneReplayEvidence): string {
  const gen = lane.summary.allocation_generation;
  if (lane.summary.generation_verified === null) {
    return `gen ${gen} (verification pending)`;
  }
  return lane.summary.generation_verified
    ? `gen ${gen} (✓ verified against expected generation)`
    : `gen ${gen} (unchecked in stock baseline)`;
}

export function PairedComparison({
  validated,
  activeLane,
  onSelectLane
}: PairedComparisonProps): React.JSX.Element {
  const headingId = useId();
  const { bundle, pairedConfigWarnings } = validated;
  const nativeOnly = bundle.lanes.native_only;
  const vervain = bundle.lanes.native_plus_vervain;
  const cfg = vervain.run_config;

  return (
    <section className="vr-paired-panel" aria-labelledby={headingId}>
      <div className="vr-field-header">
        <div>
          <p className="vr-eyebrow">Controlled differential comparison</p>
          <h2 id={headingId} className="vr-section-title">
            Paired run comparison: Native only vs Native plus Vervain
          </h2>
        </div>

        <div className="vr-status-cluster">
          {pairedConfigWarnings.length === 0 ? (
            <span className="vr-pill" data-testid="paired-config-parity-badge">
              <span>
                ✓ Shared scenario={cfg.scenario_id} · seed={cfg.seed} · fixture={cfg.fixture_id}
              </span>
            </span>
          ) : (
            <span className="vr-pill vr-pill--alert" data-testid="paired-config-mismatch-badge">
              <span>[!] PAIRED CONFIGURATION MISMATCH</span>
            </span>
          )}
        </div>
      </div>

      {pairedConfigWarnings.length > 0 && (
        <div className="vr-banner vr-banner--alert" role="alert" data-testid="paired-config-warning-banner">
          <p className="vr-banner-title">
            [!] Paired lanes do not share an identical run configuration; comparative claims are withheld.
          </p>
          <ul className="vr-exclusion-list">
            {pairedConfigWarnings.map((warning) => (
              <li key={warning.field}>{warning.message}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="vr-technical-line">{COPY_CONTRACT.nativeBaselineNote}</p>

      <div className="vr-paired-table-wrap">
        <table className="vr-paired-table" data-testid="paired-comparison-table">
          <thead>
            <tr>
              <th scope="col">Comparison dimension</th>
              <th
                scope="col"
                className={activeLane === "native_only" ? "vr-col-active" : undefined}
              >
                Native only{" "}
                {activeLane !== "native_only" && (
                  <button
                    type="button"
                    className="vr-btn"
                    onClick={() => onSelectLane("native_only")}
                  >
                    Inspect lane
                  </button>
                )}
              </th>
              <th
                scope="col"
                className={activeLane === "native_plus_vervain" ? "vr-col-active" : undefined}
              >
                Native plus Vervain{" "}
                {activeLane !== "native_plus_vervain" && (
                  <button
                    type="button"
                    className="vr-btn"
                    onClick={() => onSelectLane("native_plus_vervain")}
                  >
                    Inspect lane
                  </button>
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Scope decision</th>
              <td
                data-lane-label="Native only"
                className={activeLane === "native_only" ? "vr-col-active" : undefined}
              >
                {nativeOnly.summary.scope_decision_label}
              </td>
              <td
                data-lane-label="Native plus Vervain"
                className={activeLane === "native_plus_vervain" ? "vr-col-active" : undefined}
              >
                {vervain.summary.scope_decision_label}
              </td>
            </tr>

            <tr>
              <th scope="row">Physical block owner</th>
              <td
                data-lane-label="Native only"
                className={activeLane === "native_only" ? "vr-col-active" : undefined}
              >
                ● {nativeOnly.summary.allowed_block_alias}: {nativeOnly.summary.allowed_block_owner} · ◆{" "}
                {nativeOnly.summary.foreign_block_alias}: {nativeOnly.summary.foreign_block_owner}
              </td>
              <td
                data-lane-label="Native plus Vervain"
                className={activeLane === "native_plus_vervain" ? "vr-col-active" : undefined}
              >
                ● {vervain.summary.allowed_block_alias}: {vervain.summary.allowed_block_owner} · ◆{" "}
                {vervain.summary.foreign_block_alias}: {vervain.summary.foreign_block_owner}
              </td>
            </tr>

            <tr>
              <th scope="row">Allocation generation</th>
              <td
                data-lane-label="Native only"
                className={activeLane === "native_only" ? "vr-col-active" : undefined}
              >
                {formatGeneration(nativeOnly)}
              </td>
              <td
                data-lane-label="Native plus Vervain"
                className={activeLane === "native_plus_vervain" ? "vr-col-active" : undefined}
              >
                {formatGeneration(vervain)}
              </td>
            </tr>

            <tr>
              <th scope="row">Backend dispatch (foreign block)</th>
              <td
                data-lane-label="Native only"
                className={activeLane === "native_only" ? "vr-col-active" : undefined}
              >
                {formatDispatchYesNo(nativeOnly)}
              </td>
              <td
                data-lane-label="Native plus Vervain"
                className={activeLane === "native_plus_vervain" ? "vr-col-active" : undefined}
              >
                {formatDispatchYesNo(vervain)}
              </td>
            </tr>

            <tr>
              <th scope="row">Allowed completion (Birch)</th>
              <td
                data-lane-label="Native only"
                className={activeLane === "native_only" ? "vr-col-active" : undefined}
              >
                {formatCompletionYesNo(nativeOnly)}
              </td>
              <td
                data-lane-label="Native plus Vervain"
                className={activeLane === "native_plus_vervain" ? "vr-col-active" : undefined}
              >
                {formatCompletionYesNo(vervain)}
              </td>
            </tr>

            <tr>
              <th scope="row">Evidence status</th>
              <td
                data-lane-label="Native only"
                className={activeLane === "native_only" ? "vr-col-active" : undefined}
              >
                {nativeOnly.summary.evidence_status_label}
              </td>
              <td
                data-lane-label="Native plus Vervain"
                className={activeLane === "native_plus_vervain" ? "vr-col-active" : undefined}
              >
                {vervain.summary.evidence_status_label}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
