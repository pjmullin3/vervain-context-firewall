import React from "react";
import { COPY_CONTRACT } from "../copyContract.js";
import type { ReplaySurfaceKind } from "../machine.js";
import type { SourceStatus, ValidatedEvidenceBundle } from "../types.js";

export interface TopStatusStripProps {
  readonly surfaceKind: ReplaySurfaceKind;
  readonly validated: ValidatedEvidenceBundle | null;
  readonly receiptOpen: boolean;
  readonly onOpenReceipt: () => void;
  readonly receiptTriggerRef?: React.RefObject<HTMLButtonElement | null>;
}

function statusGlyph(status: SourceStatus): string {
  switch (status) {
    case "live":
      return "●";
    case "recorded":
      return "▣";
    case "local_only":
      return "◇";
    case "incomplete":
      return "△";
    case "unsupported":
      return "[/]";
  }
}

function statusPillModifier(status: SourceStatus, surfaceKind: ReplaySurfaceKind): string {
  if (surfaceKind === "verifier_failed" || surfaceKind === "invalid") {
    return "vr-pill vr-pill--alert";
  }
  if (
    status === "incomplete" ||
    status === "unsupported" ||
    surfaceKind === "stale"
  ) {
    return "vr-pill vr-pill--warn";
  }
  if (status === "live" || status === "recorded") {
    return "vr-pill vr-pill--purple";
  }
  return "vr-pill";
}

export function TopStatusStrip({
  surfaceKind,
  validated,
  receiptOpen,
  onOpenReceipt,
  receiptTriggerRef
}: TopStatusStripProps): React.JSX.Element {
  const bundle = validated?.bundle ?? null;

  return (
    <header className="vr-status-strip" aria-label="Replay source and verification status">
      <div className="vr-status-cluster">
        <span className="vr-brand-mark">
          <svg
            className="vr-brand-cube"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <polygon
              points="8,1.5 14,5 14,11 8,14.5 2,11 2,5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
            />
            <polyline
              points="2,5 8,8.5 14,5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
            />
            <line
              x1="8"
              y1="8.5"
              x2="8"
              y2="14.5"
              stroke="var(--vr-accent-purple)"
              strokeWidth="1.35"
            />
          </svg>
          <span>{COPY_CONTRACT.productTitle}</span>
        </span>

        {validated && bundle ? (
          <>
            <span
              className={statusPillModifier(bundle.source_status, surfaceKind)}
              data-testid="source-status-badge"
            >
              <span aria-hidden="true">{statusGlyph(bundle.source_status)}</span>
              <span>{validated.statusBadge}</span>
            </span>

            {!bundle.gpu_run_recorded && (
              <span className="vr-pill vr-pill--warn" data-testid="no-gpu-badge">
                <span aria-hidden="true">△</span>
                <span>{COPY_CONTRACT.noGpuRecordedBanner}</span>
              </span>
            )}

            {bundle.freshness === "stale" && (
              <span className="vr-pill vr-pill--warn" data-testid="stale-badge">
                <span aria-hidden="true">△</span>
                <span>STALE ARTIFACT</span>
              </span>
            )}
          </>
        ) : (
          <span
            className={
              surfaceKind === "invalid" ? "vr-pill vr-pill--alert" : "vr-pill vr-pill--warn"
            }
            data-testid="source-status-badge"
          >
            <span aria-hidden="true">{surfaceKind === "invalid" ? "[!]" : "◇"}</span>
            <span>
              {surfaceKind === "loading"
                ? "LOADING EVIDENCE"
                : surfaceKind === "invalid"
                  ? "INVALID EVIDENCE"
                  : "NO EVIDENCE LOADED"}
            </span>
          </span>
        )}
      </div>

      <div className="vr-status-cluster">
        {validated && bundle && (
          <>
            <span className="vr-meta-item">
              <span className="vr-meta-key">Model / Backend</span>
              <span className="vr-meta-val" data-testid="status-model-backend">
                {bundle.software.model_id} · {bundle.software.runtime_selected_backend}
              </span>
            </span>

            <span className="vr-meta-item">
              <span className="vr-meta-key">Run</span>
              <span className="vr-meta-val" data-testid="status-run-id">
                {bundle.run_id}
              </span>
            </span>

            <span
              className={
                validated.verifierFailed
                  ? "vr-pill vr-pill--alert"
                  : bundle.verifier.verdict === "verified"
                    ? "vr-pill vr-pill--purple"
                    : "vr-pill vr-pill--warn"
              }
              data-testid="verifier-verdict-badge"
            >
              <span aria-hidden="true">
                {validated.verifierFailed
                  ? "[!]"
                  : bundle.verifier.verdict === "verified"
                    ? "✓"
                    : "△"}
              </span>
              <span>
                {validated.verifierFailed
                  ? "VERIFIER FAILED"
                  : `VERIFIER: ${bundle.verifier.verdict.toUpperCase()}`}
              </span>
            </span>

            <button
              ref={receiptTriggerRef}
              type="button"
              className="vr-btn vr-btn--primary"
              aria-expanded={receiptOpen}
              aria-controls="vervain-receipt-drawer"
              onClick={onOpenReceipt}
              data-testid="open-exact-receipt-btn"
            >
              {receiptOpen ? "Close exact receipt" : "Open exact receipt"}
            </button>
          </>
        )}
      </div>
    </header>
  );
}
