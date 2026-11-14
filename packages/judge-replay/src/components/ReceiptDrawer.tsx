import React, { useEffect, useId, useRef } from "react";
import { COPY_CONTRACT } from "../copyContract.js";
import { parseEvidenceBundle } from "../parser.js";
import { ensureStylesInjected } from "../styles/styleSheet.js";
import {
  formatCountRatioMetric,
  formatPercentileMetric,
  formatScalarMetric
} from "../summary.js";
import type { LaneId, ValidatedEvidenceBundle } from "../types.js";

export interface ReceiptDrawerProps {
  readonly open: boolean;
  readonly onClose?: () => void;
  readonly validated?: ValidatedEvidenceBundle | null;
  readonly evidence?: unknown;
  readonly activeLane?: LaneId;
  readonly mode?: "drawer" | "inline";
  readonly injectStyles?: boolean;
}

export function ReceiptDrawer({
  open,
  onClose,
  validated: validatedProp,
  evidence,
  activeLane = "native_plus_vervain",
  mode = "drawer",
  injectStyles = true
}: ReceiptDrawerProps): React.JSX.Element | null {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    ensureStylesInjected(injectStyles);
  }, [injectStyles]);

  useEffect(() => {
    if (!open || mode !== "drawer") {
      return;
    }
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && onClose) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, mode, onClose]);

  if (!open) {
    return null;
  }

  let resolvedValidated: ValidatedEvidenceBundle | null = validatedProp ?? null;
  let parseFailureMessage: string | null = null;

  if (!resolvedValidated && evidence !== undefined && evidence !== null) {
    const parsed = parseEvidenceBundle(evidence);
    if (parsed.ok) {
      resolvedValidated = parsed.value;
    } else {
      const firstIssue = parsed.issues[0];
      parseFailureMessage = `${firstIssue?.code ?? "INVALID_EVIDENCE"} at ${firstIssue?.path ?? "$"}: ${firstIssue?.message ?? "Evidence validation failed."}`;
    }
  }

  const content = (
    <aside
      id="vervain-receipt-drawer"
      className={mode === "inline" ? "vr-drawer vr-drawer--inline" : "vr-drawer"}
      role={mode === "drawer" ? "dialog" : "region"}
      aria-modal={mode === "drawer" ? true : undefined}
      aria-labelledby={titleId}
      data-vervain-replay-root={mode === "inline" ? "" : undefined}
      data-testid="receipt-drawer"
    >
      <div className="vr-drawer-header">
        <div>
          <p className="vr-eyebrow">Attribution receipt &amp; verification dossier</p>
          <h2 id={titleId} className="vr-section-title">
            Exact configuration, denominators, and stated exclusions
          </h2>
        </div>

        {onClose && (
          <button
            ref={closeButtonRef}
            type="button"
            className="vr-btn"
            onClick={onClose}
            data-testid="close-receipt-btn"
          >
            Close receipt
          </button>
        )}
      </div>

      {!resolvedValidated ? (
        <div className="vr-banner vr-banner--alert" role="alert">
          <p className="vr-banner-title">[!] Receipt unavailable: evidence failed verification</p>
          <p className="vr-banner-body">
            {parseFailureMessage ?? "No validated evidence bundle is loaded."}
          </p>
        </div>
      ) : (
        (() => {
          const { bundle, statusBadge, verifierFailed, digestMatches } = resolvedValidated;
          const activeLaneData = bundle.lanes[activeLane];
          const nativeLane = bundle.lanes.native_only;
          const vervainLane = bundle.lanes.native_plus_vervain;

          return (
            <>
              {verifierFailed && (
                <div className="vr-banner vr-banner--alert" role="alert" data-testid="drawer-verifier-failed">
                  <p className="vr-banner-title">[!] VERIFIER FAILED: DIGEST OR VERDICT REJECTED</p>
                  <p className="vr-banner-body">
                    {bundle.verifier.failure_reason ??
                      "Canonical SHA-256 digest does not match computed receipt digest. Outcome claims are withheld."}
                  </p>
                </div>
              )}

              {/* 1. Limitations & Exclusions displayed prominently at full body size right at top */}
              <details className="vr-disclosure" open>
                <summary>
                  <span>Scope boundaries &amp; exclusions (full-size disclosure)</span>
                  <span aria-hidden="true">▾</span>
                </summary>
                <div className="vr-disclosure-body">
                  <p className="vr-limit-line">{COPY_CONTRACT.limitLine}</p>
                  <ul className="vr-exclusion-list" data-testid="receipt-exclusions-list">
                    {bundle.exclusions.map((item, index) => (
                      <li key={`${index}-${item.slice(0, 24)}`}>{item}</li>
                    ))}
                  </ul>
                </div>
              </details>

              {/* 2. Canonical Artifact Digest & Verification */}
              <details className="vr-disclosure" open>
                <summary>
                  <span>Canonical artifact digest &amp; verification</span>
                  <span aria-hidden="true">▾</span>
                </summary>
                <div className="vr-disclosure-body">
                  <dl className="vr-kv-dl">
                    <dt>Source status</dt>
                    <dd>{statusBadge}</dd>
                    <dt>Verifier ID</dt>
                    <dd>{bundle.verifier.verifier_id}</dd>
                    <dt>Verifier verdict</dt>
                    <dd>
                      {verifierFailed
                        ? "[!] FAILED"
                        : `${bundle.verifier.verdict.toUpperCase()} (digest match: ${String(digestMatches)})`}
                    </dd>
                    <dt>Canonical SHA-256</dt>
                    <dd>{bundle.verifier.canonical_sha256}</dd>
                    <dt>Computed SHA-256</dt>
                    <dd>{bundle.verifier.computed_sha256}</dd>
                    <dt>Verified UTC</dt>
                    <dd>{bundle.verifier.verified_at_utc}</dd>
                    <dt>Schema version</dt>
                    <dd>{bundle.schema_version}</dd>
                  </dl>
                </div>
              </details>

              {/* 3. Exact Software, vLLM SHA, Patch Digest, Model & Backend */}
              <details className="vr-disclosure" open>
                <summary>
                  <span>Software, vLLM SHA, patch digest &amp; backend</span>
                  <span aria-hidden="true">▾</span>
                </summary>
                <div className="vr-disclosure-body">
                  <dl className="vr-kv-dl">
                    <dt>vLLM commit SHA</dt>
                    <dd data-testid="receipt-vllm-sha">{bundle.software.vllm_sha}</dd>
                    <dt>Vervain patch digest</dt>
                    <dd data-testid="receipt-patch-digest">{bundle.software.patch_digest_sha256}</dd>
                    <dt>Model ID</dt>
                    <dd>{bundle.software.model_id}</dd>
                    <dt>Model revision</dt>
                    <dd>{bundle.software.model_revision}</dd>
                    <dt>Tokenizer revision</dt>
                    <dd>{bundle.software.tokenizer_revision}</dd>
                    <dt>Selected backend</dt>
                    <dd>{bundle.software.runtime_selected_backend}</dd>
                    <dt>Execution surface</dt>
                    <dd>{bundle.software.execution_surface}</dd>
                  </dl>
                </div>
              </details>

              {/* 4. GPU & Hardware Topology */}
              <details className="vr-disclosure" open>
                <summary>
                  <span>GPU &amp; hardware topology</span>
                  <span aria-hidden="true">▾</span>
                </summary>
                <div className="vr-disclosure-body">
                  <dl className="vr-kv-dl">
                    <dt>GPU run status</dt>
                    <dd data-testid="receipt-gpu-status">
                      {bundle.gpu_run_recorded
                        ? "RECORDED GPU ARTIFACT"
                        : COPY_CONTRACT.noGpuRecordedBanner}
                    </dd>
                    <dt>GPU model</dt>
                    <dd>
                      {bundle.gpu_run_recorded && bundle.hardware.gpu_model
                        ? `${bundle.hardware.gpu_count}x ${bundle.hardware.gpu_model}`
                        : COPY_CONTRACT.noGpuRecordedBanner}
                    </dd>
                    <dt>Topology</dt>
                    <dd>
                      {bundle.gpu_run_recorded && bundle.hardware.topology
                        ? bundle.hardware.topology
                        : COPY_CONTRACT.noGpuRecordedBanner}
                    </dd>
                    <dt>Hardware note</dt>
                    <dd>{bundle.hardware.note}</dd>
                  </dl>
                </div>
              </details>

              {/* 5. Trust Boundary, Scope Tag, Policy Epoch & KV Block Ownership */}
              <details className="vr-disclosure" open>
                <summary>
                  <span>Trust boundary, scope tag &amp; KV block generation</span>
                  <span aria-hidden="true">▾</span>
                </summary>
                <div className="vr-disclosure-body">
                  <dl className="vr-kv-dl">
                    <dt>Authority source</dt>
                    <dd>{bundle.trust_boundary.authority_source}</dd>
                    <dt>Mediated boundary</dt>
                    <dd>{bundle.trust_boundary.mediated_boundary}</dd>
                    <dt>Request ID / scope</dt>
                    <dd>
                      {bundle.policy.request_id} · {bundle.policy.request_scope} (IAM:{" "}
                      {bundle.trust_boundary.iam_access_decision})
                    </dd>
                    <dt>Foreign scope</dt>
                    <dd>{bundle.policy.foreign_scope}</dd>
                    <dt>Policy epoch</dt>
                    <dd>{bundle.policy.policy_epoch}</dd>
                    <dt>Expected generation</dt>
                    <dd>{bundle.policy.expected_allocation_generation}</dd>
                    {activeLaneData.blocks.map((block) => (
                      <React.Fragment key={block.block_alias}>
                        <dt>Block {block.block_alias}</dt>
                        <dd>
                          owner={block.owner_scope} · gen={block.allocation_generation} (expected{" "}
                          {block.expected_generation}) · {block.token_range} · outcome=
                          {block.aperture_outcome}
                        </dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </div>
              </details>

              {/* 6. Paired Correctness & Sample-Counted Telemetry */}
              <details className="vr-disclosure" open>
                <summary>
                  <span>Paired correctness, latency, memory &amp; guard time (with denominators)</span>
                  <span aria-hidden="true">▾</span>
                </summary>
                <div className="vr-disclosure-body">
                  <dl className="vr-kv-dl">
                    <dt>Vervain foreign reads stopped</dt>
                    <dd>{formatCountRatioMetric(vervainLane.correctness.foreign_reads_stopped)}</dd>
                    <dt>Baseline foreign reads stopped</dt>
                    <dd>{formatCountRatioMetric(nativeLane.correctness.foreign_reads_stopped)}</dd>
                    <dt>Vervain allowed completions</dt>
                    <dd>{formatCountRatioMetric(vervainLane.correctness.allowed_requests_completed)}</dd>
                    <dt>Baseline allowed completions</dt>
                    <dd>{formatCountRatioMetric(nativeLane.correctness.allowed_requests_completed)}</dd>
                    <dt>TTFT ({activeLaneData.label})</dt>
                    <dd>{formatPercentileMetric(activeLaneData.telemetry.ttft_ms)}</dd>
                    <dt>ITL ({activeLaneData.label})</dt>
                    <dd>{formatPercentileMetric(activeLaneData.telemetry.itl_ms)}</dd>
                    <dt>Throughput ({activeLaneData.label})</dt>
                    <dd>{formatScalarMetric(activeLaneData.telemetry.throughput_tok_per_s)}</dd>
                    <dt>Peak GPU memory ({activeLaneData.label})</dt>
                    <dd>{formatScalarMetric(activeLaneData.telemetry.peak_gpu_memory_gib)}</dd>
                    <dt>Scope guard time ({activeLaneData.label})</dt>
                    <dd>{formatPercentileMetric(activeLaneData.telemetry.guard_overhead_us)}</dd>
                  </dl>
                </div>
              </details>
            </>
          );
        })()
      )}
    </aside>
  );

  if (mode === "inline") {
    return content;
  }

  return (
    <div
      className="vr-drawer-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && onClose) {
          onClose();
        }
      }}
    >
      {content}
    </div>
  );
}
