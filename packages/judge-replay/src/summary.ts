import { COPY_CONTRACT } from "./copyContract.js";
import { escapeHtml } from "./sanitize.js";
import type {
  CountRatioMetric,
  LaneId,
  SampledPercentileMetric,
  SampledScalarMetric,
  TimelineStepIndex,
  ValidatedEvidenceBundle
} from "./types.js";

export function formatCountRatioMetric(metric: CountRatioMetric): string {
  if (metric.status === "not_recorded" || metric.numerator === null || metric.denominator === null) {
    return `${metric.unrecorded_reason ?? COPY_CONTRACT.noGpuRecordedBanner} (${metric.unit_label})`;
  }
  return `${metric.numerator} / ${metric.denominator} ${metric.unit_label}`;
}

export function formatPercentileMetric(metric: SampledPercentileMetric): string {
  if (
    metric.status === "not_recorded" ||
    metric.p50 === null ||
    metric.p95 === null ||
    metric.sample_count === null
  ) {
    return metric.unrecorded_reason ?? COPY_CONTRACT.noGpuRecordedBanner;
  }
  return `p50 ${metric.p50} ${metric.unit}, p95 ${metric.p95} ${metric.unit} (n = ${metric.sample_count} samples)`;
}

export function formatScalarMetric(metric: SampledScalarMetric): string {
  if (metric.status === "not_recorded" || metric.value === null || metric.sample_count === null) {
    return metric.unrecorded_reason ?? COPY_CONTRACT.noGpuRecordedBanner;
  }
  return `${metric.value} ${metric.unit} (n = ${metric.sample_count} samples)`;
}

export interface CausalSummaryOutput {
  readonly plainText: string;
  readonly escapedHtml: string;
}

/**
 * Generates an accessible, deterministic text summary of the causal replay state
 * for screen readers, audit exports, and static inspection.
 */
export function generateCausalSummary(
  validated: ValidatedEvidenceBundle,
  activeLaneId: LaneId = "native_plus_vervain",
  activeStepIndex: TimelineStepIndex = 9
): CausalSummaryOutput {
  const { bundle, statusBadge, verifierFailed, pairedConfigWarnings, outcomeClaimEligible } = validated;
  const lane = bundle.lanes[activeLaneId];
  const step = lane.steps.find((s) => s.step_index === activeStepIndex) ?? lane.steps[0]!;

  const gpuPhrase = bundle.gpu_run_recorded
    ? `GPU topology: ${bundle.hardware.gpu_count}x ${bundle.hardware.gpu_model} (${bundle.hardware.topology}).`
    : `GPU status: ${COPY_CONTRACT.noGpuRecordedBanner}.`;

  const verifierPhrase = verifierFailed
    ? `Verification failed (${bundle.verifier.failure_reason ?? "canonical digest mismatch"}). Positive outcome claims are withheld.`
    : `Verifier verdict: ${bundle.verifier.verdict.toUpperCase()} (${bundle.verifier.canonical_sha256.slice(0, 23)}...).`;

  const configPhrase =
    pairedConfigWarnings.length > 0
      ? `Warning: paired configuration mismatch across ${pairedConfigWarnings.map((w) => w.field).join(", ")}.`
      : `Paired lanes share scenario ${lane.run_config.scenario_id}, seed ${lane.run_config.seed}, model ${lane.run_config.model_id}, and backend ${lane.run_config.backend}.`;

  const dispatchPhrase =
    lane.summary.foreign_backend_dispatched === null
      ? "Foreign block backend dispatch: not yet recorded."
      : lane.summary.foreign_backend_dispatched
        ? `Foreign block ${lane.summary.foreign_block_alias} (${lane.summary.foreign_block_owner}) reached backend dispatch in this unmediated baseline lane.`
        : `Foreign block ${lane.summary.foreign_block_alias} (${lane.summary.foreign_block_owner}) was stopped at the attention aperture before backend dispatch.`;

  const completionPhrase =
    lane.summary.allowed_request_completed === null
      ? "Allowed Birch request completion: not yet recorded."
      : lane.summary.allowed_request_completed
        ? `Allowed request (${bundle.policy.request_scope}, block ${lane.summary.allowed_block_alias}, generation ${lane.summary.allocation_generation}) completed (${formatCountRatioMetric(lane.correctness.allowed_requests_completed)}).`
        : `Allowed request (${bundle.policy.request_scope}) did not complete.`;

  const outcomeSentence = outcomeClaimEligible ? ` ${COPY_CONTRACT.outcomeLine}` : "";

  const plainText = [
    `${COPY_CONTRACT.productTitle} [${statusBadge}].`,
    `Run ${bundle.run_id} viewing ${lane.label} at step ${step.step_index} of 9 (${step.title}): ${step.detail}`,
    `IAM allowed ${bundle.trust_boundary.iam_request_actor}; fault injection (${bundle.trust_boundary.retrieval_defect}) placed ${bundle.policy.foreign_scope} data onto ${bundle.policy.request_scope}'s path.`,
    dispatchPhrase,
    completionPhrase,
    gpuPhrase,
    verifierPhrase,
    configPhrase,
    `${COPY_CONTRACT.limitLine}${outcomeSentence}`,
    `Exclusions: ${bundle.exclusions.join("; ")}.`
  ].join(" ");

  return {
    plainText,
    escapedHtml: escapeHtml(plainText)
  };
}
