import React, { useId, useRef } from "react";
import type { TimelineStepEvidence, TimelineStepIndex } from "../types.js";

export interface TimelineScrubberProps {
  readonly steps: readonly TimelineStepEvidence[];
  readonly activeStepIndex: TimelineStepIndex;
  readonly onSelectStep: (stepIndex: TimelineStepIndex) => void;
}

function dispositionSymbol(recorded: boolean, disposition: TimelineStepEvidence["disposition"]): string {
  if (!recorded || disposition === "unrecorded") return "△";
  if (disposition === "unsupported") return "[/]";
  if (disposition === "stopped_before_dispatch") return "┤";
  if (disposition === "mismatch_detected") return "◆";
  if (disposition === "defect_injected") return "◆";
  if (disposition === "completed" || disposition === "sealed") return "✓";
  return "●";
}

export function TimelineScrubber({
  steps,
  activeStepIndex,
  onSelectStep
}: TimelineScrubberProps): React.JSX.Element {
  const headingId = useId();
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeStep = steps.find((s) => s.step_index === activeStepIndex) ?? steps[0]!;

  const moveFocusAndSelect = (targetIndexOneBased: number): void => {
    const clamped = Math.max(1, Math.min(9, targetIndexOneBased)) as TimelineStepIndex;
    onSelectStep(clamped);
    const btn = buttonRefs.current[clamped - 1];
    btn?.focus();
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentStepIndex: TimelineStepIndex
  ): void => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        moveFocusAndSelect(currentStepIndex < 9 ? currentStepIndex + 1 : 9);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        moveFocusAndSelect(currentStepIndex > 1 ? currentStepIndex - 1 : 1);
        break;
      case "Home":
        event.preventDefault();
        moveFocusAndSelect(1);
        break;
      case "End":
        event.preventDefault();
        moveFocusAndSelect(9);
        break;
      default:
        break;
    }
  };

  return (
    <section className="vr-timeline-panel" aria-labelledby={headingId}>
      <div className="vr-field-header">
        <h2 id={headingId} className="vr-section-title">
          Causal timeline ({activeStep.step_index} / 9: {activeStep.title})
        </h2>
        <span className="vr-meta-key">Use Left / Right arrow keys to scrub steps</span>
      </div>

      <ol className="vr-timeline-list" aria-label="Nine causal inference steps">
        {steps.map((step, idx) => {
          const isCurrent = step.step_index === activeStepIndex;
          return (
            <li key={step.step_id}>
              <button
                ref={(el) => {
                  buttonRefs.current[idx] = el;
                }}
                type="button"
                className={`vr-step-btn ${!step.recorded ? "vr-step-btn--unrecorded" : ""}`}
                aria-current={isCurrent ? "step" : undefined}
                tabIndex={isCurrent ? 0 : -1}
                onClick={() => onSelectStep(step.step_index)}
                onKeyDown={(e) => handleKeyDown(e, step.step_index)}
                data-testid={`timeline-step-${step.step_index}`}
              >
                <span className="vr-step-num">
                  <span>0{step.step_index}</span>
                  <span aria-hidden="true">{dispositionSymbol(step.recorded, step.disposition)}</span>
                </span>
                <span className="vr-step-title">{step.title}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="vr-active-step-detail" data-testid="active-step-detail">
        <p className="vr-active-step-text">
          <strong>
            Step {activeStep.step_index} ({activeStep.title}):
          </strong>{" "}
          {activeStep.detail}
        </p>
        <div className="vr-status-cluster">
          <span className="vr-pill">
            <span>boundary: {activeStep.boundary}</span>
          </span>
          <span className={activeStep.recorded ? "vr-pill" : "vr-pill vr-pill--warn"}>
            <span>ref: {activeStep.artifact_ref}</span>
          </span>
        </div>
      </div>
    </section>
  );
}
