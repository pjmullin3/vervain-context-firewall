import React, { useEffect, useReducer, useRef } from "react";
import { COPY_CONTRACT } from "../copyContract.js";
import {
  createReplayState,
  replayReducer,
  type ReplayMachineState
} from "../machine.js";
import { ensureStylesInjected } from "../styles/styleSheet.js";
import { generateCausalSummary } from "../summary.js";
import type { LaneId, TimelineStepIndex } from "../types.js";
import { CausalFieldSvg } from "./CausalFieldSvg.js";
import { PairedComparison } from "./PairedComparison.js";
import { ReceiptDrawer } from "./ReceiptDrawer.js";
import { TimelineScrubber } from "./TimelineScrubber.js";
import { TopStatusStrip } from "./TopStatusStrip.js";

export interface VervainInferenceReplayProps {
  readonly evidence?: unknown;
  readonly status?: "empty" | "loading" | "loaded";
  readonly fromFixture?: boolean;
  readonly initialLane?: LaneId | null;
  readonly initialStepIndex?: TimelineStepIndex | null;
  readonly defaultReceiptOpen?: boolean;
  readonly initialReceiptOpen?: boolean;
  readonly rejectedDeepLinkParams?: readonly string[];
  readonly forceReducedMotion?: boolean;
  readonly demoStepDurationMs?: number;
  readonly injectStyles?: boolean;
  readonly onStateChange?: (state: ReplayMachineState) => void;
}

function detectReducedMotionPreference(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function VervainInferenceReplay({
  evidence,
  status = evidence === undefined || evidence === null ? "empty" : "loaded",
  fromFixture = false,
  initialLane = "native_plus_vervain",
  initialStepIndex,
  defaultReceiptOpen,
  initialReceiptOpen,
  rejectedDeepLinkParams,
  forceReducedMotion,
  demoStepDurationMs = 850,
  injectStyles = true,
  onStateChange
}: VervainInferenceReplayProps): React.JSX.Element {
  const receiptTriggerRef = useRef<HTMLButtonElement | null>(null);
  const resolvedLane: LaneId = initialLane ?? "native_plus_vervain";
  const resolvedStepIndex: TimelineStepIndex | undefined = initialStepIndex ?? undefined;
  const resolvedReceiptOpen = initialReceiptOpen ?? defaultReceiptOpen ?? false;

  const [state, dispatch] = useReducer(replayReducer, undefined, () =>
    createReplayState({
      status,
      evidence,
      fromFixture,
      initialLane: resolvedLane,
      initialStepIndex: resolvedStepIndex,
      receiptOpen: resolvedReceiptOpen,
      reducedMotion: forceReducedMotion ?? detectReducedMotionPreference()
    })
  );

  useEffect(() => {
    ensureStylesInjected(injectStyles);
  }, [injectStyles]);

  // Synchronize external evidence/status prop updates cleanly
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    if (status === "loading") {
      dispatch({ type: "SET_LOADING" });
      return;
    }
    if (status === "empty" || evidence === undefined || evidence === null) {
      dispatch({ type: "SET_EMPTY" });
      return;
    }
    dispatch({
      type: "LOAD_EVIDENCE",
      input: evidence,
      fromFixture,
      initialLane: resolvedLane,
      initialStepIndex: resolvedStepIndex
    });
  }, [status, evidence, fromFixture, resolvedLane, resolvedStepIndex]);

  // Track prefers-reduced-motion media query
  useEffect(() => {
    if (typeof forceReducedMotion === "boolean") {
      dispatch({ type: "SET_REDUCED_MOTION", reducedMotion: forceReducedMotion });
      return;
    }
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    dispatch({ type: "SET_REDUCED_MOTION", reducedMotion: mql.matches });
    const listener = (event: MediaQueryListEvent): void => {
      dispatch({ type: "SET_REDUCED_MOTION", reducedMotion: event.matches });
    };
    mql.addEventListener("change", listener);
    return () => {
      mql.removeEventListener("change", listener);
    };
  }, [forceReducedMotion]);

  // Deterministic bounded Demo playback timer (stops automatically at maxRecordedStepIndex)
  useEffect(() => {
    if (state.playback !== "playing") {
      return;
    }
    const interval = window.setInterval(() => {
      dispatch({ type: "TICK" });
    }, Math.max(120, demoStepDurationMs));
    return () => {
      window.clearInterval(interval);
    };
  }, [state.playback, demoStepDurationMs]);

  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

  const handleCloseReceipt = (): void => {
    dispatch({ type: "CLOSE_RECEIPT" });
    window.requestAnimationFrame(() => {
      receiptTriggerRef.current?.focus();
    });
  };

  const validated = state.evidenceRef;
  const activeLaneData = validated ? validated.bundle.lanes[state.activeLane] : null;
  const activeStep = activeLaneData?.steps.find((s) => s.step_index === state.activeStepIndex) ?? null;
  const causalSummary = validated
    ? generateCausalSummary(validated, state.activeLane, state.activeStepIndex)
    : null;

  return (
    <div
      data-vervain-replay-root=""
      data-reduced-motion={state.reducedMotion ? "true" : "false"}
      data-surface-kind={state.surfaceKind}
    >
      <div className="vr-workspace">
        <TopStatusStrip
          surfaceKind={state.surfaceKind}
          validated={validated}
          receiptOpen={state.receiptOpen}
          onOpenReceipt={() => dispatch({ type: "TOGGLE_RECEIPT" })}
          receiptTriggerRef={receiptTriggerRef}
        />

        <main aria-label="Vervain causal inference replay workspace" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {rejectedDeepLinkParams && rejectedDeepLinkParams.length > 0 && (
            <div className="vr-banner vr-banner--warn" role="status" data-testid="rejected-deeplink-notice">
              <p className="vr-banner-body">
                Ignored non-allowlisted deep-link parameters: {rejectedDeepLinkParams.join(", ")}
              </p>
            </div>
          )}

          {/* Locked Copy Contract & Limitations Block */}
          <section className="vr-hero-grid" aria-label="Thesis and boundary framing">
            <div className="vr-hero-copy">
              <p className="vr-eyebrow">{COPY_CONTRACT.creativeThesis}</p>
              <h1 className="vr-primary-heading">{COPY_CONTRACT.primaryLine}</h1>
              <p className="vr-technical-line">{COPY_CONTRACT.technicalLine}</p>
            </div>

            <div className="vr-outcome-card">
              {validated?.outcomeClaimEligible ? (
                <p className="vr-outcome-line" data-testid="outcome-claim-line">
                  {COPY_CONTRACT.outcomeLine}
                </p>
              ) : (
                <p className="vr-outcome-withheld" data-testid="outcome-withheld-line">
                  Outcome line withheld: requires a current, digest-verified paired artifact with matching
                  lane configuration and completed guard interception.
                </p>
              )}

              <p className="vr-limit-line" data-testid="limit-claim-line">
                <strong>Stated limit:</strong> {COPY_CONTRACT.limitLine}
              </p>
            </div>
          </section>

          {/* Polite Live Region for meaningful playback/mode announcements */}
          <div className="vr-sr-only" aria-live="polite" aria-atomic="true" data-testid="sr-live-region">
            {validated && activeLaneData && activeStep
              ? `${activeLaneData.label}, step ${activeStep.step_index} of 9, ${activeStep.title}. ${activeStep.detail}`
              : `Replay state: ${state.surfaceKind}`}
          </div>

          {/* Screen-reader full causal summary */}
          {causalSummary && (
            <section className="vr-sr-only" aria-label="Causal replay summary">
              <h2>Accessible summary of causal replay</h2>
              <p data-testid="sr-causal-summary">{causalSummary.plainText}</p>
            </section>
          )}

          {/* First-class Empty State */}
          {state.surfaceKind === "empty" && (
            <section className="vr-banner" data-testid="state-empty">
              <h2 className="vr-banner-title">◇ No replay evidence bundle loaded</h2>
              <p className="vr-banner-body">
                Supply a typed <code>vervain.judge_replay.v1</code> evidence object to inspect request
                authentication, KV block ownership, pre-attention scope checks, and cryptographic receipts.
              </p>
            </section>
          )}

          {/* First-class Loading State (calm static structure, zero ambient animation) */}
          {state.surfaceKind === "loading" && (
            <section className="vr-banner" aria-busy="true" data-testid="state-loading">
              <h2 className="vr-banner-title">◇ Loading typed evidence artifact</h2>
              <p className="vr-banner-body">
                Validating schema, canonical SHA-256 digest, sample-count denominators, and protected-field
                exclusions.
              </p>
            </section>
          )}

          {/* First-class Invalid Untrusted Evidence State */}
          {state.surfaceKind === "invalid" && (
            <section className="vr-banner vr-banner--alert" role="alert" data-testid="state-invalid">
              <h2 className="vr-banner-title">
                [!] Verification failure: untrusted evidence rejected ({state.validationIssues.length}{" "}
                {state.validationIssues.length === 1 ? "issue" : "issues"})
              </h2>
              <p className="vr-banner-body">
                Best-effort rendering is disabled. Fix the artifact contract violation before replaying:
              </p>
              <ul className="vr-exclusion-list">
                {state.validationIssues.slice(0, 6).map((issue, idx) => (
                  <li key={`${issue.code}-${issue.path}-${idx}`}>
                    <code>{issue.code}</code> at <code>{issue.path}</code>: {issue.message}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* First-class Banners for Verifier-Failed, Incomplete, Unsupported, and Stale */}
          {validated && state.surfaceKind === "verifier_failed" && (
            <section className="vr-banner vr-banner--alert" role="alert" data-testid="state-verifier-failed">
              <h2 className="vr-banner-title">[!] Verification failed: artifact digest or verdict rejected</h2>
              <p className="vr-banner-body">
                {validated.bundle.verifier.failure_reason ??
                  "Computed SHA-256 does not match canonical ledger SHA-256. Positive outcome claims are suppressed."}
              </p>
            </section>
          )}

          {validated && state.surfaceKind === "incomplete" && (
            <section className="vr-banner vr-banner--warn" data-testid="state-incomplete">
              <h2 className="vr-banner-title">
                △ Incomplete evidence artifact · {COPY_CONTRACT.noGpuRecordedBanner}
              </h2>
              <p className="vr-banner-body">
                Only steps 1 through {state.maxRecordedStepIndex} are recorded. Unrecorded steps are
                explicitly marked and GPU performance metrics are absent ({COPY_CONTRACT.noGpuRecordedBanner}).
              </p>
            </section>
          )}

          {validated && state.surfaceKind === "unsupported" && (
            <section className="vr-banner vr-banner--warn" data-testid="state-unsupported">
              <h2 className="vr-banner-title">[/] Unsupported execution surface</h2>
              <p className="vr-banner-body">
                {validated.bundle.unsupported_reason ??
                  "Selected backend or provider-internal memory surface does not expose paged KV ownership hooks."}
              </p>
            </section>
          )}

          {validated && state.surfaceKind === "stale" && (
            <section className="vr-banner vr-banner--warn" data-testid="state-stale">
              <h2 className="vr-banner-title">△ Stale evidence bundle</h2>
              <p className="vr-banner-body">
                {validated.bundle.stale_reason ??
                  "This replay bundle belongs to a superseded policy epoch and is presented for archival inspection only."}
              </p>
            </section>
          )}

          {/* Interactive Workspace when Validated Evidence Exists */}
          {validated && activeLaneData && (
            <>
              {/* Replay & Mode Controls */}
              <section className="vr-controls-bar" aria-label="Replay playback and lane controls">
                <div className="vr-control-group">
                  <button
                    type="button"
                    className="vr-btn vr-btn--primary"
                    onClick={() => dispatch({ type: "START_DEMO" })}
                    disabled={state.playback === "playing"}
                    data-testid="control-demo-btn"
                  >
                    Demo
                  </button>
                  <button
                    type="button"
                    className="vr-btn"
                    onClick={() => dispatch({ type: "PAUSE" })}
                    disabled={state.playback !== "playing"}
                    data-testid="control-pause-btn"
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className="vr-btn"
                    onClick={() => dispatch({ type: "STEP_NEXT" })}
                    disabled={state.activeStepIndex >= state.maxRecordedStepIndex}
                    data-testid="control-step-btn"
                  >
                    Step
                  </button>
                  <button
                    type="button"
                    className="vr-btn"
                    onClick={() => dispatch({ type: "RESTART" })}
                    data-testid="control-restart-btn"
                  >
                    Restart
                  </button>
                </div>

                <div className="vr-control-group">
                  <div className="vr-segmented" role="group" aria-label="Execution lane mode">
                    <button
                      type="button"
                      className={`vr-btn ${state.activeLane === "native_only" ? "vr-btn--active" : ""}`}
                      aria-pressed={state.activeLane === "native_only"}
                      onClick={() => dispatch({ type: "SET_LANE", lane: "native_only" })}
                      data-testid="mode-native-only-btn"
                    >
                      Native only
                    </button>
                    <button
                      type="button"
                      className={`vr-btn ${state.activeLane === "native_plus_vervain" ? "vr-btn--active" : ""}`}
                      aria-pressed={state.activeLane === "native_plus_vervain"}
                      onClick={() => dispatch({ type: "SET_LANE", lane: "native_plus_vervain" })}
                      data-testid="mode-vervain-btn"
                    >
                      Native plus Vervain
                    </button>
                  </div>

                  <button
                    type="button"
                    className="vr-btn"
                    onClick={() => dispatch({ type: "OPEN_RECEIPT" })}
                    data-testid="control-open-receipt-btn"
                  >
                    Open receipt
                  </button>
                </div>
              </section>

              <CausalFieldSvg
                validated={validated}
                surfaceKind={state.surfaceKind}
                activeLane={state.activeLane}
                activeStepIndex={state.activeStepIndex}
                onSelectStep={(stepIndex) => dispatch({ type: "SELECT_STEP", stepIndex })}
              />

              <TimelineScrubber
                steps={activeLaneData.steps}
                activeStepIndex={state.activeStepIndex}
                onSelectStep={(stepIndex) => dispatch({ type: "SELECT_STEP", stepIndex })}
              />

              <PairedComparison
                validated={validated}
                activeLane={state.activeLane}
                onSelectLane={(lane) => dispatch({ type: "SET_LANE", lane })}
              />
            </>
          )}
        </main>

        <ReceiptDrawer
          open={state.receiptOpen}
          onClose={handleCloseReceipt}
          validated={validated}
          activeLane={state.activeLane}
          mode="drawer"
          injectStyles={false}
        />
      </div>
    </div>
  );
}
