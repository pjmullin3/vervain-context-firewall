/**
 * Versioned typed evidence contract for @vervain/judge-replay.
 * Every visual state in VervainInferenceReplay and ReceiptDrawer derives from these types.
 */

export const EVIDENCE_SCHEMA_VERSION = "vervain.judge_replay.v1" as const;

export type EvidenceSchemaVersion = typeof EVIDENCE_SCHEMA_VERSION;

export type SourceStatus =
  | "live"
  | "recorded"
  | "local_only"
  | "incomplete"
  | "unsupported";

export type SourceStatusBadgeLabel =
  | "LIVE H200 RUN"
  | "RECORDED H200 RUN"
  | "LOCAL TEST"
  | "INCOMPLETE"
  | "UNSUPPORTED";

export type ArtifactFreshness = "current" | "stale";

export type VerifierVerdict = "verified" | "failed" | "unverified";

export type LaneId = "native_only" | "native_plus_vervain";

export const CANONICAL_TIMELINE_STEPS = Object.freeze([
  { index: 1, id: "request-authenticated", title: "request authenticated" },
  { index: 2, id: "retrieval-defect-injected", title: "retrieval defect injected" },
  { index: 3, id: "context-admitted-or-withheld", title: "context admitted or withheld" },
  { index: 4, id: "kv-block-allocated", title: "KV block allocated" },
  { index: 5, id: "block-table-finalized", title: "block table finalized" },
  { index: 6, id: "scope-checked", title: "scope checked" },
  { index: 7, id: "backend-dispatched-or-stopped", title: "backend dispatched or stopped" },
  { index: 8, id: "allowed-result-completed", title: "allowed result completed" },
  { index: 9, id: "receipt-sealed", title: "receipt sealed" }
] as const);

export type TimelineStepIndex = (typeof CANONICAL_TIMELINE_STEPS)[number]["index"];
export type TimelineStepId = (typeof CANONICAL_TIMELINE_STEPS)[number]["id"];
export type TimelineStepTitle = (typeof CANONICAL_TIMELINE_STEPS)[number]["title"];

export type ExecutionSurface =
  | "h200_gpu_runtime"
  | "local_contract_harness"
  | "unmediated_surface";

export type LineagePatternKind = "ruled_horizontal" | "hatched_diagonal";

export type LineageRole = "request_owner" | "foreign_injected";

export interface TrustBoundaryEvidence {
  readonly authority_source: string;
  readonly mediated_boundary: string;
  readonly iam_request_actor: string;
  readonly iam_access_decision: "allowed";
  readonly retrieval_defect: string;
  readonly unmediated_surfaces: readonly string[];
}

export interface SoftwareEvidence {
  readonly vllm_sha: string;
  readonly patch_digest_sha256: string;
  readonly model_id: string;
  readonly model_revision: string;
  readonly tokenizer_revision: string;
  readonly runtime_selected_backend: string;
  readonly execution_surface: ExecutionSurface;
}

export interface HardwareEvidence {
  readonly status: "recorded" | "no_gpu_run_recorded";
  readonly gpu_model: string | null;
  readonly gpu_count: number | null;
  readonly topology: string | null;
  readonly note: string;
}

export interface PolicyEvidence {
  readonly request_id: string;
  readonly request_scope: string;
  readonly foreign_scope: string;
  readonly policy_epoch: number;
  readonly expected_allocation_generation: number;
}

export interface LineageItemEvidence {
  readonly id: string;
  readonly label: string;
  readonly scope_tag: string;
  readonly role: LineageRole;
  readonly source_alias: string;
  readonly token_span_label: string;
  readonly block_alias: string;
  readonly allocation_generation: number;
  readonly pattern_kind: LineagePatternKind;
}

export type BlockApertureOutcome =
  | "clipped_before_dispatch"
  | "passed_verified"
  | "passed_unmediated"
  | "pending"
  | "unsupported";

export interface PhysicalBlockEvidence {
  readonly block_alias: string;
  readonly owner_scope: string;
  readonly allocation_generation: number;
  readonly expected_generation: number;
  readonly token_range: string;
  readonly is_foreign_to_request: boolean;
  readonly aperture_outcome: BlockApertureOutcome;
}

export type StepBoundary =
  | "iam_gateway"
  | "retrieval_path"
  | "context_admission"
  | "paged_kv_allocator"
  | "block_table"
  | "attention_aperture"
  | "attention_backend"
  | "egress_completion"
  | "audit_ledger";

export type StepDisposition =
  | "admitted"
  | "defect_injected"
  | "allocated"
  | "finalized"
  | "mismatch_detected"
  | "unmediated_pass"
  | "stopped_before_dispatch"
  | "backend_dispatched"
  | "completed"
  | "sealed"
  | "unrecorded"
  | "unsupported";

export interface TimelineStepEvidence {
  readonly step_index: TimelineStepIndex;
  readonly step_id: TimelineStepId;
  readonly title: TimelineStepTitle;
  readonly recorded: boolean;
  readonly boundary: StepBoundary;
  readonly disposition: StepDisposition;
  readonly detail: string;
  readonly artifact_ref: string;
}

export interface LaneRunConfig {
  readonly scenario_id: string;
  readonly seed: number;
  readonly model_id: string;
  readonly model_revision: string;
  readonly tokenizer_revision: string;
  readonly backend: string;
  readonly vllm_sha: string;
  readonly fixture_id: string;
}

export type LaneScopeDecision =
  | "not_mediated_in_baseline"
  | "foreign_stopped_allowed_admitted"
  | "generation_mismatch_stopped"
  | "withheld_incomplete"
  | "unsupported_backend";

export interface LaneSummaryEvidence {
  readonly scope_decision: LaneScopeDecision;
  readonly scope_decision_label: string;
  readonly foreign_block_alias: string;
  readonly foreign_block_owner: string;
  readonly allowed_block_alias: string;
  readonly allowed_block_owner: string;
  readonly allocation_generation: number;
  readonly generation_verified: boolean | null;
  readonly foreign_backend_dispatched: boolean | null;
  readonly allowed_request_completed: boolean | null;
  readonly evidence_status_label: string;
}

export interface CountRatioMetric {
  readonly status: "recorded" | "not_recorded";
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly unit_label: string;
  readonly unrecorded_reason: string | null;
}

export interface SampledPercentileMetric {
  readonly status: "recorded" | "not_recorded";
  readonly p50: number | null;
  readonly p95: number | null;
  readonly sample_count: number | null;
  readonly unit: "ms" | "us";
  readonly unrecorded_reason: string | null;
}

export interface SampledScalarMetric {
  readonly status: "recorded" | "not_recorded";
  readonly value: number | null;
  readonly sample_count: number | null;
  readonly unit: "tok/s" | "GiB";
  readonly unrecorded_reason: string | null;
}

export interface PairedCorrectnessEvidence {
  readonly foreign_reads_stopped: CountRatioMetric;
  readonly allowed_requests_completed: CountRatioMetric;
}

export interface TelemetryEvidence {
  readonly ttft_ms: SampledPercentileMetric;
  readonly itl_ms: SampledPercentileMetric;
  readonly throughput_tok_per_s: SampledScalarMetric;
  readonly peak_gpu_memory_gib: SampledScalarMetric;
  readonly guard_overhead_us: SampledPercentileMetric;
}

export interface LaneReplayEvidence {
  readonly lane_id: LaneId;
  readonly label: "Native only" | "Native plus Vervain";
  readonly lane_note: string;
  readonly run_config: LaneRunConfig;
  readonly summary: LaneSummaryEvidence;
  readonly blocks: readonly PhysicalBlockEvidence[];
  readonly steps: readonly TimelineStepEvidence[];
  readonly correctness: PairedCorrectnessEvidence;
  readonly telemetry: TelemetryEvidence;
}

export interface VerifierEvidence {
  readonly verifier_id: string;
  readonly verdict: VerifierVerdict;
  readonly canonical_sha256: string;
  readonly computed_sha256: string;
  readonly verified_at_utc: string;
  readonly failure_reason: string | null;
}

export interface EvidenceBundle {
  readonly schema_version: EvidenceSchemaVersion;
  readonly run_id: string;
  readonly fixture_id: string;
  readonly scenario_id: string;
  readonly source_status: SourceStatus;
  readonly freshness: ArtifactFreshness;
  readonly stale_reason: string | null;
  readonly unsupported_reason: string | null;
  readonly gpu_run_recorded: boolean;
  readonly gpu_status_label: string;
  readonly captured_at_utc: string;
  readonly trust_boundary: TrustBoundaryEvidence;
  readonly software: SoftwareEvidence;
  readonly hardware: HardwareEvidence;
  readonly policy: PolicyEvidence;
  readonly lineage: readonly LineageItemEvidence[];
  readonly lanes: {
    readonly native_only: LaneReplayEvidence;
    readonly native_plus_vervain: LaneReplayEvidence;
  };
  readonly exclusions: readonly string[];
  readonly verifier: VerifierEvidence;
}

export type ValidationErrorCode =
  | "INVALID_ROOT_OBJECT"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "FORBIDDEN_PROTECTED_FIELD"
  | "UNKNOWN_FIELD"
  | "UNSAFE_VALUE_PATTERN"
  | "TEXT_CAP_EXCEEDED"
  | "COLLECTION_CAP_EXCEEDED"
  | "INVALID_SCALAR_TYPE"
  | "NON_FINITE_OR_IMPOSSIBLE_NUMBER"
  | "METRIC_MISSING_DENOMINATOR"
  | "GPU_STATUS_INCONSISTENT"
  | "TIMELINE_ORDER_INVALID"
  | "FIXTURE_LIVE_STATUS_FORBIDDEN";

export interface ValidationIssue {
  readonly code: ValidationErrorCode;
  readonly path: string;
  readonly message: string;
}

export interface PairedConfigWarning {
  readonly field: keyof LaneRunConfig;
  readonly nativeOnlyValue: string | number;
  readonly vervainValue: string | number;
  readonly message: string;
}

export interface ValidatedEvidenceBundle {
  readonly bundle: EvidenceBundle;
  readonly statusBadge: SourceStatusBadgeLabel;
  readonly pairedConfigWarnings: readonly PairedConfigWarning[];
  readonly digestMatches: boolean;
  readonly verifierFailed: boolean;
  readonly outcomeClaimEligible: boolean;
}

export type ParseEvidenceResult =
  | {
      readonly ok: true;
      readonly value: ValidatedEvidenceBundle;
    }
  | {
      readonly ok: false;
      readonly issues: readonly ValidationIssue[];
    };
