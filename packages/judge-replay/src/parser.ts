import {
  CANONICAL_TIMELINE_STEPS,
  EVIDENCE_SCHEMA_VERSION,
  type ArtifactFreshness,
  type BlockApertureOutcome,
  type CountRatioMetric,
  type EvidenceBundle,
  type ExecutionSurface,
  type HardwareEvidence,
  type LaneId,
  type LaneReplayEvidence,
  type LaneRunConfig,
  type LaneScopeDecision,
  type LaneSummaryEvidence,
  type LineageItemEvidence,
  type LineagePatternKind,
  type LineageRole,
  type PairedConfigWarning,
  type PairedCorrectnessEvidence,
  type ParseEvidenceResult,
  type PhysicalBlockEvidence,
  type PolicyEvidence,
  type SampledPercentileMetric,
  type SampledScalarMetric,
  type SoftwareEvidence,
  type SourceStatus,
  type SourceStatusBadgeLabel,
  type StepBoundary,
  type StepDisposition,
  type TelemetryEvidence,
  type TimelineStepEvidence,
  type TrustBoundaryEvidence,
  type ValidatedEvidenceBundle,
  type ValidationIssue,
  type VerifierEvidence,
  type VerifierVerdict
} from "./types.js";
import {
  LIMITS,
  deepFreeze,
  escapeHtml,
  scanUntrustedGraph,
  validateBoundedText,
  validateGitShaOrUnrecorded,
  validateIsoUtcTimestamp,
  validateSafeId,
  validateSha256Prefixed
} from "./sanitize.js";

const SOURCE_STATUS_TO_BADGE: Readonly<Record<SourceStatus, SourceStatusBadgeLabel>> = {
  live: "LIVE H200 RUN",
  recorded: "RECORDED H200 RUN",
  local_only: "LOCAL TEST",
  incomplete: "INCOMPLETE",
  unsupported: "UNSUPPORTED"
};

export function mapSourceStatusToBadge(status: SourceStatus): SourceStatusBadgeLabel {
  return SOURCE_STATUS_TO_BADGE[status];
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      issues.push({
        code: "UNKNOWN_FIELD",
        path: `${path}.${escapeHtml(key.slice(0, 40))}`,
        message: `Unexpected field '${escapeHtml(key.slice(0, 40))}' is not part of ${EVIDENCE_SCHEMA_VERSION}.`
      });
    }
  }
}

function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  issues: ValidationIssue[],
  fallback: T
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  issues.push({
    code: "INVALID_SCALAR_TYPE",
    path,
    message: `Expected one of [${allowed.join(", ")}].`
  });
  return fallback;
}

function validateNonNegativeInt(
  value: unknown,
  path: string,
  max: number,
  issues: ValidationIssue[]
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    issues.push({
      code: "NON_FINITE_OR_IMPOSSIBLE_NUMBER",
      path,
      message: `Expected integer in 0..${max}.`
    });
    return 0;
  }
  return value;
}

function validatePositiveInt(
  value: unknown,
  path: string,
  max: number,
  issues: ValidationIssue[]
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    issues.push({
      code: "NON_FINITE_OR_IMPOSSIBLE_NUMBER",
      path,
      message: `Expected positive integer in 1..${max}.`
    });
    return 1;
  }
  return value;
}

function validateOptionalBoundedText(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  maxLength: number = LIMITS.maxNoteLength
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return validateBoundedText(value, path, issues, maxLength);
}

function parseTrustBoundary(raw: unknown, path: string, issues: ValidationIssue[]): TrustBoundaryEvidence {
  if (!isPlainRecord(raw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path, message: "Expected trust_boundary object." });
    return {
      authority_source: "",
      mediated_boundary: "",
      iam_request_actor: "",
      iam_access_decision: "allowed",
      retrieval_defect: "",
      unmediated_surfaces: []
    };
  }
  assertAllowedKeys(
    raw,
    [
      "authority_source",
      "mediated_boundary",
      "iam_request_actor",
      "iam_access_decision",
      "retrieval_defect",
      "unmediated_surfaces"
    ],
    path,
    issues
  );
  const surfacesRaw = raw.unmediated_surfaces;
  const unmediatedSurfaces: string[] = [];
  if (!Array.isArray(surfacesRaw) || surfacesRaw.length === 0) {
    issues.push({
      code: "INVALID_SCALAR_TYPE",
      path: `${path}.unmediated_surfaces`,
      message: "Expected non-empty array of unmediated surfaces."
    });
  } else if (surfacesRaw.length > LIMITS.maxUnmediatedSurfaces) {
    issues.push({
      code: "COLLECTION_CAP_EXCEEDED",
      path: `${path}.unmediated_surfaces`,
      message: `Exceeds cap of ${LIMITS.maxUnmediatedSurfaces} items.`
    });
  } else {
    surfacesRaw.forEach((item, idx) => {
      unmediatedSurfaces.push(
        validateBoundedText(item, `${path}.unmediated_surfaces[${idx}]`, issues, LIMITS.maxShortLabelLength)
      );
    });
  }

  return {
    authority_source: validateBoundedText(raw.authority_source, `${path}.authority_source`, issues, LIMITS.maxShortLabelLength),
    mediated_boundary: validateBoundedText(raw.mediated_boundary, `${path}.mediated_boundary`, issues, LIMITS.maxShortLabelLength),
    iam_request_actor: validateSafeId(raw.iam_request_actor, `${path}.iam_request_actor`, issues),
    iam_access_decision: validateEnum(raw.iam_access_decision, ["allowed"] as const, `${path}.iam_access_decision`, issues, "allowed"),
    retrieval_defect: validateBoundedText(raw.retrieval_defect, `${path}.retrieval_defect`, issues, LIMITS.maxNoteLength),
    unmediated_surfaces: unmediatedSurfaces
  };
}

function parseSoftware(
  raw: unknown,
  allowUnrecordedSha: boolean,
  path: string,
  issues: ValidationIssue[]
): SoftwareEvidence {
  if (!isPlainRecord(raw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path, message: "Expected software object." });
    return {
      vllm_sha: "",
      patch_digest_sha256: "",
      model_id: "",
      model_revision: "",
      tokenizer_revision: "",
      runtime_selected_backend: "",
      execution_surface: "local_contract_harness"
    };
  }
  assertAllowedKeys(
    raw,
    [
      "vllm_sha",
      "patch_digest_sha256",
      "model_id",
      "model_revision",
      "tokenizer_revision",
      "runtime_selected_backend",
      "execution_surface"
    ],
    path,
    issues
  );
  return {
    vllm_sha: validateGitShaOrUnrecorded(raw.vllm_sha, `${path}.vllm_sha`, allowUnrecordedSha, issues),
    patch_digest_sha256: validateSha256Prefixed(raw.patch_digest_sha256, `${path}.patch_digest_sha256`, issues),
    model_id: validateSafeId(raw.model_id, `${path}.model_id`, issues, 96),
    model_revision: validateSafeId(raw.model_revision, `${path}.model_revision`, issues, 64),
    tokenizer_revision: validateSafeId(raw.tokenizer_revision, `${path}.tokenizer_revision`, issues, 64),
    runtime_selected_backend: validateBoundedText(
      raw.runtime_selected_backend,
      `${path}.runtime_selected_backend`,
      issues,
      96
    ),
    execution_surface: validateEnum<ExecutionSurface>(
      raw.execution_surface,
      ["h200_gpu_runtime", "local_contract_harness", "unmediated_surface"] as const,
      `${path}.execution_surface`,
      issues,
      "local_contract_harness"
    )
  };
}

function parseHardware(
  raw: unknown,
  gpuRunRecorded: boolean,
  path: string,
  issues: ValidationIssue[]
): HardwareEvidence {
  if (!isPlainRecord(raw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path, message: "Expected hardware object." });
    return {
      status: "no_gpu_run_recorded",
      gpu_model: null,
      gpu_count: null,
      topology: null,
      note: "NO GPU RUN RECORDED"
    };
  }
  assertAllowedKeys(raw, ["status", "gpu_model", "gpu_count", "topology", "note"], path, issues);
  const status = validateEnum(
    raw.status,
    ["recorded", "no_gpu_run_recorded"] as const,
    `${path}.status`,
    issues,
    "no_gpu_run_recorded"
  );
  const note = validateBoundedText(raw.note, `${path}.note`, issues, LIMITS.maxNoteLength);

  if (!gpuRunRecorded) {
    if (status !== "no_gpu_run_recorded") {
      issues.push({
        code: "GPU_STATUS_INCONSISTENT",
        path: `${path}.status`,
        message: "hardware.status must be 'no_gpu_run_recorded' when gpu_run_recorded is false."
      });
    }
    if (raw.gpu_model !== null || raw.gpu_count !== null || raw.topology !== null) {
      issues.push({
        code: "GPU_STATUS_INCONSISTENT",
        path,
        message: "gpu_model, gpu_count, and topology must be null when gpu_run_recorded is false."
      });
    }
    if (!note.includes("NO GPU RUN RECORDED")) {
      issues.push({
        code: "GPU_STATUS_INCONSISTENT",
        path: `${path}.note`,
        message: "hardware.note must explicitly state 'NO GPU RUN RECORDED' when gpu_run_recorded is false."
      });
    }
    return {
      status: "no_gpu_run_recorded",
      gpu_model: null,
      gpu_count: null,
      topology: null,
      note
    };
  }

  if (status !== "recorded") {
    issues.push({
      code: "GPU_STATUS_INCONSISTENT",
      path: `${path}.status`,
      message: "hardware.status must be 'recorded' when gpu_run_recorded is true."
    });
  }
  const gpuModel = validateBoundedText(raw.gpu_model, `${path}.gpu_model`, issues, LIMITS.maxShortLabelLength);
  const gpuCount = validatePositiveInt(raw.gpu_count, `${path}.gpu_count`, 64, issues);
  const topology = validateBoundedText(raw.topology, `${path}.topology`, issues, LIMITS.maxShortLabelLength);

  return {
    status: "recorded",
    gpu_model: gpuModel,
    gpu_count: gpuCount,
    topology,
    note
  };
}

function parsePolicy(raw: unknown, path: string, issues: ValidationIssue[]): PolicyEvidence {
  if (!isPlainRecord(raw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path, message: "Expected policy object." });
    return {
      request_id: "",
      request_scope: "",
      foreign_scope: "",
      policy_epoch: 0,
      expected_allocation_generation: 0
    };
  }
  assertAllowedKeys(
    raw,
    [
      "request_id",
      "request_scope",
      "foreign_scope",
      "policy_epoch",
      "expected_allocation_generation"
    ],
    path,
    issues
  );
  return {
    request_id: validateSafeId(raw.request_id, `${path}.request_id`, issues),
    request_scope: validateSafeId(raw.request_scope, `${path}.request_scope`, issues),
    foreign_scope: validateSafeId(raw.foreign_scope, `${path}.foreign_scope`, issues),
    policy_epoch: validateNonNegativeInt(raw.policy_epoch, `${path}.policy_epoch`, 1_000_000, issues),
    expected_allocation_generation: validateNonNegativeInt(
      raw.expected_allocation_generation,
      `${path}.expected_allocation_generation`,
      1_000_000,
      issues
    )
  };
}

function parseLineage(raw: unknown, path: string, issues: ValidationIssue[]): LineageItemEvidence[] {
  if (!Array.isArray(raw) || raw.length < 2) {
    issues.push({
      code: "INVALID_SCALAR_TYPE",
      path,
      message: "Expected lineage array with at least 2 items (request owner and foreign injected path)."
    });
    return [];
  }
  if (raw.length > LIMITS.maxLineageItems) {
    issues.push({
      code: "COLLECTION_CAP_EXCEEDED",
      path,
      message: `Lineage array exceeds cap (${LIMITS.maxLineageItems}).`
    });
    return [];
  }
  return raw.map((entry, idx) => {
    const itemPath = `${path}[${idx}]`;
    if (!isPlainRecord(entry)) {
      issues.push({ code: "INVALID_SCALAR_TYPE", path: itemPath, message: "Expected lineage item object." });
      return {
        id: "",
        label: "",
        scope_tag: "",
        role: "request_owner",
        source_alias: "",
        token_span_label: "",
        block_alias: "",
        allocation_generation: 0,
        pattern_kind: "ruled_horizontal"
      };
    }
    assertAllowedKeys(
      entry,
      [
        "id",
        "label",
        "scope_tag",
        "role",
        "source_alias",
        "token_span_label",
        "block_alias",
        "allocation_generation",
        "pattern_kind"
      ],
      itemPath,
      issues
    );
    return {
      id: validateSafeId(entry.id, `${itemPath}.id`, issues),
      label: validateBoundedText(entry.label, `${itemPath}.label`, issues, LIMITS.maxShortLabelLength),
      scope_tag: validateSafeId(entry.scope_tag, `${itemPath}.scope_tag`, issues),
      role: validateEnum<LineageRole>(
        entry.role,
        ["request_owner", "foreign_injected"] as const,
        `${itemPath}.role`,
        issues,
        "request_owner"
      ),
      source_alias: validateSafeId(entry.source_alias, `${itemPath}.source_alias`, issues),
      token_span_label: validateBoundedText(
        entry.token_span_label,
        `${itemPath}.token_span_label`,
        issues,
        LIMITS.maxShortLabelLength
      ),
      block_alias: validateSafeId(entry.block_alias, `${itemPath}.block_alias`, issues),
      allocation_generation: validateNonNegativeInt(
        entry.allocation_generation,
        `${itemPath}.allocation_generation`,
        1_000_000,
        issues
      ),
      pattern_kind: validateEnum<LineagePatternKind>(
        entry.pattern_kind,
        ["ruled_horizontal", "hatched_diagonal"] as const,
        `${itemPath}.pattern_kind`,
        issues,
        "ruled_horizontal"
      )
    };
  });
}

function parseCountRatioMetric(raw: unknown, path: string, issues: ValidationIssue[]): CountRatioMetric {
  if (!isPlainRecord(raw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path, message: "Expected count ratio metric object." });
    return {
      status: "not_recorded",
      numerator: null,
      denominator: null,
      unit_label: "",
      unrecorded_reason: "NO GPU RUN RECORDED"
    };
  }
  assertAllowedKeys(raw, ["status", "numerator", "denominator", "unit_label", "unrecorded_reason"], path, issues);
  const status = validateEnum(raw.status, ["recorded", "not_recorded"] as const, `${path}.status`, issues, "not_recorded");
  const unitLabel = validateBoundedText(raw.unit_label, `${path}.unit_label`, issues, LIMITS.maxShortLabelLength);

  if (status === "not_recorded") {
    if (raw.numerator !== null || raw.denominator !== null) {
      issues.push({
        code: "NON_FINITE_OR_IMPOSSIBLE_NUMBER",
        path,
        message: "numerator and denominator must be null when status is 'not_recorded'."
      });
    }
    const reason = validateBoundedText(raw.unrecorded_reason, `${path}.unrecorded_reason`, issues, LIMITS.maxShortLabelLength);
    return {
      status: "not_recorded",
      numerator: null,
      denominator: null,
      unit_label: unitLabel,
      unrecorded_reason: reason
    };
  }

  if (typeof raw.denominator !== "number" || !Number.isInteger(raw.denominator) || raw.denominator < 1 || raw.denominator > 1_000_000) {
    issues.push({
      code: "METRIC_MISSING_DENOMINATOR",
      path: `${path}.denominator`,
      message: "Recorded ratio metric must specify a positive integer denominator (1..1000000)."
    });
    return {
      status: "recorded",
      numerator: 0,
      denominator: 1,
      unit_label: unitLabel,
      unrecorded_reason: null
    };
  }

  if (
    typeof raw.numerator !== "number" ||
    !Number.isInteger(raw.numerator) ||
    raw.numerator < 0 ||
    raw.numerator > raw.denominator
  ) {
    issues.push({
      code: "NON_FINITE_OR_IMPOSSIBLE_NUMBER",
      path: `${path}.numerator`,
      message: `Numerator must be an integer between 0 and denominator (${raw.denominator}).`
    });
    return {
      status: "recorded",
      numerator: 0,
      denominator: raw.denominator,
      unit_label: unitLabel,
      unrecorded_reason: null
    };
  }

  return {
    status: "recorded",
    numerator: raw.numerator,
    denominator: raw.denominator,
    unit_label: unitLabel,
    unrecorded_reason: validateOptionalBoundedText(raw.unrecorded_reason, `${path}.unrecorded_reason`, issues, LIMITS.maxShortLabelLength)
  };
}

function parsePercentileMetric(
  raw: unknown,
  expectedUnit: "ms" | "us",
  gpuRunRecorded: boolean,
  path: string,
  issues: ValidationIssue[]
): SampledPercentileMetric {
  if (!isPlainRecord(raw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path, message: "Expected percentile metric object." });
    return {
      status: "not_recorded",
      p50: null,
      p95: null,
      sample_count: null,
      unit: expectedUnit,
      unrecorded_reason: "NO GPU RUN RECORDED"
    };
  }
  assertAllowedKeys(raw, ["status", "p50", "p95", "sample_count", "unit", "unrecorded_reason"], path, issues);
  const status = validateEnum(raw.status, ["recorded", "not_recorded"] as const, `${path}.status`, issues, "not_recorded");
  const unit = validateEnum(raw.unit, [expectedUnit] as const, `${path}.unit`, issues, expectedUnit);

  if (status === "not_recorded") {
    if (raw.p50 !== null || raw.p95 !== null || raw.sample_count !== null) {
      issues.push({
        code: "NON_FINITE_OR_IMPOSSIBLE_NUMBER",
        path,
        message: "p50, p95, and sample_count must be null when metric status is 'not_recorded'."
      });
    }
    const reason = validateBoundedText(raw.unrecorded_reason, `${path}.unrecorded_reason`, issues, LIMITS.maxShortLabelLength);
    if (!gpuRunRecorded && !reason.includes("NO GPU RUN RECORDED")) {
      issues.push({
        code: "GPU_STATUS_INCONSISTENT",
        path: `${path}.unrecorded_reason`,
        message: "Unrecorded GPU metric must state 'NO GPU RUN RECORDED'."
      });
    }
    return {
      status: "not_recorded",
      p50: null,
      p95: null,
      sample_count: null,
      unit,
      unrecorded_reason: reason
    };
  }

  if (!gpuRunRecorded) {
    issues.push({
      code: "GPU_STATUS_INCONSISTENT",
      path,
      message: "GPU latency/overhead metrics cannot be marked 'recorded' when gpu_run_recorded is false."
    });
  }

  if (typeof raw.sample_count !== "number" || !Number.isInteger(raw.sample_count) || raw.sample_count < 1 || raw.sample_count > 1_000_000) {
    issues.push({
      code: "METRIC_MISSING_DENOMINATOR",
      path: `${path}.sample_count`,
      message: "Recorded percentile metric must include a positive integer sample_count."
    });
  }

  const minAllowed = expectedUnit === "ms" ? 0.001 : 0;
  const maxAllowed = expectedUnit === "ms" ? 600_000 : 10_000_000;
  const p50Valid = typeof raw.p50 === "number" && Number.isFinite(raw.p50) && raw.p50 >= minAllowed && raw.p50 <= maxAllowed;
  const p95Valid = typeof raw.p95 === "number" && Number.isFinite(raw.p95) && raw.p95 >= minAllowed && raw.p95 <= maxAllowed;

  if (!p50Valid || !p95Valid || (p50Valid && p95Valid && (raw.p95 as number) < (raw.p50 as number))) {
    issues.push({
      code: "NON_FINITE_OR_IMPOSSIBLE_NUMBER",
      path,
      message: `Percentile metric requires finite p50 <= p95 within ${minAllowed}..${maxAllowed} ${expectedUnit}.`
    });
  }

  return {
    status: "recorded",
    p50: p50Valid ? (raw.p50 as number) : 0,
    p95: p95Valid ? (raw.p95 as number) : 0,
    sample_count: typeof raw.sample_count === "number" && Number.isInteger(raw.sample_count) && raw.sample_count > 0 ? raw.sample_count : 1,
    unit,
    unrecorded_reason: null
  };
}

function parseScalarMetric(
  raw: unknown,
  expectedUnit: "tok/s" | "GiB",
  gpuRunRecorded: boolean,
  path: string,
  issues: ValidationIssue[]
): SampledScalarMetric {
  if (!isPlainRecord(raw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path, message: "Expected scalar metric object." });
    return {
      status: "not_recorded",
      value: null,
      sample_count: null,
      unit: expectedUnit,
      unrecorded_reason: "NO GPU RUN RECORDED"
    };
  }
  assertAllowedKeys(raw, ["status", "value", "sample_count", "unit", "unrecorded_reason"], path, issues);
  const status = validateEnum(raw.status, ["recorded", "not_recorded"] as const, `${path}.status`, issues, "not_recorded");
  const unit = validateEnum(raw.unit, [expectedUnit] as const, `${path}.unit`, issues, expectedUnit);

  if (status === "not_recorded") {
    if (raw.value !== null || raw.sample_count !== null) {
      issues.push({
        code: "NON_FINITE_OR_IMPOSSIBLE_NUMBER",
        path,
        message: "value and sample_count must be null when metric status is 'not_recorded'."
      });
    }
    const reason = validateBoundedText(raw.unrecorded_reason, `${path}.unrecorded_reason`, issues, LIMITS.maxShortLabelLength);
    if (!gpuRunRecorded && !reason.includes("NO GPU RUN RECORDED")) {
      issues.push({
        code: "GPU_STATUS_INCONSISTENT",
        path: `${path}.unrecorded_reason`,
        message: "Unrecorded GPU metric must state 'NO GPU RUN RECORDED'."
      });
    }
    return {
      status: "not_recorded",
      value: null,
      sample_count: null,
      unit,
      unrecorded_reason: reason
    };
  }

  if (!gpuRunRecorded) {
    issues.push({
      code: "GPU_STATUS_INCONSISTENT",
      path,
      message: "GPU throughput/memory metrics cannot be marked 'recorded' when gpu_run_recorded is false."
    });
  }

  if (typeof raw.sample_count !== "number" || !Number.isInteger(raw.sample_count) || raw.sample_count < 1 || raw.sample_count > 1_000_000) {
    issues.push({
      code: "METRIC_MISSING_DENOMINATOR",
      path: `${path}.sample_count`,
      message: "Recorded scalar metric must include a positive integer sample_count."
    });
  }

  const maxAllowed = expectedUnit === "tok/s" ? 1_000_000 : 2_048;
  const valValid = typeof raw.value === "number" && Number.isFinite(raw.value) && raw.value > 0 && raw.value <= maxAllowed;
  if (!valValid) {
    issues.push({
      code: "NON_FINITE_OR_IMPOSSIBLE_NUMBER",
      path: `${path}.value`,
      message: `Scalar metric value must be finite in (0, ${maxAllowed}] ${expectedUnit}.`
    });
  }

  return {
    status: "recorded",
    value: valValid ? (raw.value as number) : 1,
    sample_count: typeof raw.sample_count === "number" && Number.isInteger(raw.sample_count) && raw.sample_count > 0 ? raw.sample_count : 1,
    unit,
    unrecorded_reason: null
  };
}

function parseLane(
  raw: unknown,
  expectedLaneId: LaneId,
  expectedLabel: "Native only" | "Native plus Vervain",
  sourceStatus: SourceStatus,
  gpuRunRecorded: boolean,
  path: string,
  issues: ValidationIssue[]
): LaneReplayEvidence {
  const allowUnrecordedSha = sourceStatus === "incomplete";
  if (!isPlainRecord(raw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path, message: `Expected lane object for ${expectedLaneId}.` });
    throw new Error("Invalid lane root");
  }
  assertAllowedKeys(
    raw,
    ["lane_id", "label", "lane_note", "run_config", "summary", "blocks", "steps", "correctness", "telemetry"],
    path,
    issues
  );

  const laneId = validateEnum(raw.lane_id, [expectedLaneId] as const, `${path}.lane_id`, issues, expectedLaneId);
  const label = validateEnum(raw.label, [expectedLabel] as const, `${path}.label`, issues, expectedLabel);
  const laneNote = validateBoundedText(raw.lane_note, `${path}.lane_note`, issues, LIMITS.maxNoteLength);

  // Run config
  const rcRaw = raw.run_config;
  let runConfig: LaneRunConfig = {
    scenario_id: "",
    seed: 0,
    model_id: "",
    model_revision: "",
    tokenizer_revision: "",
    backend: "",
    vllm_sha: "",
    fixture_id: ""
  };
  if (!isPlainRecord(rcRaw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path: `${path}.run_config`, message: "Expected run_config object." });
  } else {
    assertAllowedKeys(
      rcRaw,
      [
        "scenario_id",
        "seed",
        "model_id",
        "model_revision",
        "tokenizer_revision",
        "backend",
        "vllm_sha",
        "fixture_id"
      ],
      `${path}.run_config`,
      issues
    );
    runConfig = {
      scenario_id: validateSafeId(rcRaw.scenario_id, `${path}.run_config.scenario_id`, issues),
      seed: validateNonNegativeInt(rcRaw.seed, `${path}.run_config.seed`, 2_147_483_647, issues),
      model_id: validateSafeId(rcRaw.model_id, `${path}.run_config.model_id`, issues, 96),
      model_revision: validateSafeId(rcRaw.model_revision, `${path}.run_config.model_revision`, issues, 64),
      tokenizer_revision: validateSafeId(rcRaw.tokenizer_revision, `${path}.run_config.tokenizer_revision`, issues, 64),
      backend: validateBoundedText(rcRaw.backend, `${path}.run_config.backend`, issues, 96),
      vllm_sha: validateGitShaOrUnrecorded(rcRaw.vllm_sha, `${path}.run_config.vllm_sha`, allowUnrecordedSha, issues),
      fixture_id: validateSafeId(rcRaw.fixture_id, `${path}.run_config.fixture_id`, issues)
    };
  }

  // Summary
  const sumRaw = raw.summary;
  let summary: LaneSummaryEvidence = {
    scope_decision: "withheld_incomplete",
    scope_decision_label: "",
    foreign_block_alias: "",
    foreign_block_owner: "",
    allowed_block_alias: "",
    allowed_block_owner: "",
    allocation_generation: 0,
    generation_verified: null,
    foreign_backend_dispatched: null,
    allowed_request_completed: null,
    evidence_status_label: ""
  };
  if (!isPlainRecord(sumRaw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path: `${path}.summary`, message: "Expected summary object." });
  } else {
    assertAllowedKeys(
      sumRaw,
      [
        "scope_decision",
        "scope_decision_label",
        "foreign_block_alias",
        "foreign_block_owner",
        "allowed_block_alias",
        "allowed_block_owner",
        "allocation_generation",
        "generation_verified",
        "foreign_backend_dispatched",
        "allowed_request_completed",
        "evidence_status_label"
      ],
      `${path}.summary`,
      issues
    );
    const nullableBool = (v: unknown, p: string): boolean | null => {
      if (v === null || typeof v === "boolean") return v;
      issues.push({ code: "INVALID_SCALAR_TYPE", path: p, message: "Expected boolean or null." });
      return null;
    };
    summary = {
      scope_decision: validateEnum<LaneScopeDecision>(
        sumRaw.scope_decision,
        [
          "not_mediated_in_baseline",
          "foreign_stopped_allowed_admitted",
          "generation_mismatch_stopped",
          "withheld_incomplete",
          "unsupported_backend"
        ] as const,
        `${path}.summary.scope_decision`,
        issues,
        "withheld_incomplete"
      ),
      scope_decision_label: validateBoundedText(
        sumRaw.scope_decision_label,
        `${path}.summary.scope_decision_label`,
        issues,
        LIMITS.maxShortLabelLength
      ),
      foreign_block_alias: validateSafeId(sumRaw.foreign_block_alias, `${path}.summary.foreign_block_alias`, issues),
      foreign_block_owner: validateSafeId(sumRaw.foreign_block_owner, `${path}.summary.foreign_block_owner`, issues),
      allowed_block_alias: validateSafeId(sumRaw.allowed_block_alias, `${path}.summary.allowed_block_alias`, issues),
      allowed_block_owner: validateSafeId(sumRaw.allowed_block_owner, `${path}.summary.allowed_block_owner`, issues),
      allocation_generation: validateNonNegativeInt(
        sumRaw.allocation_generation,
        `${path}.summary.allocation_generation`,
        1_000_000,
        issues
      ),
      generation_verified: nullableBool(sumRaw.generation_verified, `${path}.summary.generation_verified`),
      foreign_backend_dispatched: nullableBool(
        sumRaw.foreign_backend_dispatched,
        `${path}.summary.foreign_backend_dispatched`
      ),
      allowed_request_completed: nullableBool(
        sumRaw.allowed_request_completed,
        `${path}.summary.allowed_request_completed`
      ),
      evidence_status_label: validateBoundedText(
        sumRaw.evidence_status_label,
        `${path}.summary.evidence_status_label`,
        issues,
        LIMITS.maxShortLabelLength
      )
    };
  }

  // Blocks
  const blocksRaw = raw.blocks;
  const blocks: PhysicalBlockEvidence[] = [];
  if (!Array.isArray(blocksRaw) || blocksRaw.length === 0) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path: `${path}.blocks`, message: "Expected non-empty blocks array." });
  } else if (blocksRaw.length > LIMITS.maxBlocksPerLane) {
    issues.push({
      code: "COLLECTION_CAP_EXCEEDED",
      path: `${path}.blocks`,
      message: `Blocks array exceeds cap (${LIMITS.maxBlocksPerLane}).`
    });
  } else {
    blocksRaw.forEach((b, idx) => {
      const bPath = `${path}.blocks[${idx}]`;
      if (!isPlainRecord(b)) {
        issues.push({ code: "INVALID_SCALAR_TYPE", path: bPath, message: "Expected block object." });
        return;
      }
      assertAllowedKeys(
        b,
        [
          "block_alias",
          "owner_scope",
          "allocation_generation",
          "expected_generation",
          "token_range",
          "is_foreign_to_request",
          "aperture_outcome"
        ],
        bPath,
        issues
      );
      if (typeof b.is_foreign_to_request !== "boolean") {
        issues.push({
          code: "INVALID_SCALAR_TYPE",
          path: `${bPath}.is_foreign_to_request`,
          message: "Expected boolean."
        });
      }
      blocks.push({
        block_alias: validateSafeId(b.block_alias, `${bPath}.block_alias`, issues),
        owner_scope: validateSafeId(b.owner_scope, `${bPath}.owner_scope`, issues),
        allocation_generation: validateNonNegativeInt(
          b.allocation_generation,
          `${bPath}.allocation_generation`,
          1_000_000,
          issues
        ),
        expected_generation: validateNonNegativeInt(
          b.expected_generation,
          `${bPath}.expected_generation`,
          1_000_000,
          issues
        ),
        token_range: validateBoundedText(b.token_range, `${bPath}.token_range`, issues, 48),
        is_foreign_to_request: Boolean(b.is_foreign_to_request),
        aperture_outcome: validateEnum<BlockApertureOutcome>(
          b.aperture_outcome,
          [
            "clipped_before_dispatch",
            "passed_verified",
            "passed_unmediated",
            "pending",
            "unsupported"
          ] as const,
          `${bPath}.aperture_outcome`,
          issues,
          "pending"
        )
      });
    });
  }

  // Exact 9 timeline steps
  const stepsRaw = raw.steps;
  const steps: TimelineStepEvidence[] = [];
  if (!Array.isArray(stepsRaw) || stepsRaw.length !== CANONICAL_TIMELINE_STEPS.length) {
    issues.push({
      code: "TIMELINE_ORDER_INVALID",
      path: `${path}.steps`,
      message: `Expected exact ${CANONICAL_TIMELINE_STEPS.length} canonical timeline steps in causal order.`
    });
  } else {
    let sawUnrecorded = false;
    stepsRaw.forEach((s, idx) => {
      const canonical = CANONICAL_TIMELINE_STEPS[idx]!;
      const sPath = `${path}.steps[${idx}]`;
      if (!isPlainRecord(s)) {
        issues.push({ code: "INVALID_SCALAR_TYPE", path: sPath, message: "Expected step object." });
        return;
      }
      assertAllowedKeys(
        s,
        ["step_index", "step_id", "title", "recorded", "boundary", "disposition", "detail", "artifact_ref"],
        sPath,
        issues
      );
      if (s.step_index !== canonical.index || s.step_id !== canonical.id || s.title !== canonical.title) {
        issues.push({
          code: "TIMELINE_ORDER_INVALID",
          path: sPath,
          message: `Step ${idx + 1} must match canonical step (${canonical.index}: '${canonical.title}').`
        });
      }
      if (typeof s.recorded !== "boolean") {
        issues.push({ code: "INVALID_SCALAR_TYPE", path: `${sPath}.recorded`, message: "Expected boolean." });
      }
      const recorded = Boolean(s.recorded);
      if (!recorded) {
        sawUnrecorded = true;
      } else if (sawUnrecorded) {
        issues.push({
          code: "TIMELINE_ORDER_INVALID",
          path: `${sPath}.recorded`,
          message: "Recorded timeline steps must form a contiguous causal prefix without gaps."
        });
      }
      if (
        !recorded &&
        sourceStatus !== "incomplete" &&
        sourceStatus !== "unsupported"
      ) {
        issues.push({
          code: "TIMELINE_ORDER_INVALID",
          path: `${sPath}.recorded`,
          message: `All 9 timeline steps must be recorded when source_status is '${sourceStatus}'.`
        });
      }

      steps.push({
        step_index: canonical.index,
        step_id: canonical.id,
        title: canonical.title,
        recorded,
        boundary: validateEnum<StepBoundary>(
          s.boundary,
          [
            "iam_gateway",
            "retrieval_path",
            "context_admission",
            "paged_kv_allocator",
            "block_table",
            "attention_aperture",
            "attention_backend",
            "egress_completion",
            "audit_ledger"
          ] as const,
          `${sPath}.boundary`,
          issues,
          "iam_gateway"
        ),
        disposition: validateEnum<StepDisposition>(
          s.disposition,
          [
            "admitted",
            "defect_injected",
            "allocated",
            "finalized",
            "mismatch_detected",
            "unmediated_pass",
            "stopped_before_dispatch",
            "backend_dispatched",
            "completed",
            "sealed",
            "unrecorded",
            "unsupported"
          ] as const,
          `${sPath}.disposition`,
          issues,
          "unrecorded"
        ),
        detail: validateBoundedText(s.detail, `${sPath}.detail`, issues, LIMITS.maxNoteLength),
        artifact_ref: validateSafeId(s.artifact_ref, `${sPath}.artifact_ref`, issues, 80)
      });
    });
  }

  // Correctness
  const corrRaw = raw.correctness;
  let correctness: PairedCorrectnessEvidence = {
    foreign_reads_stopped: {
      status: "not_recorded",
      numerator: null,
      denominator: null,
      unit_label: "injected foreign block reads",
      unrecorded_reason: "NO GPU RUN RECORDED"
    },
    allowed_requests_completed: {
      status: "not_recorded",
      numerator: null,
      denominator: null,
      unit_label: "allowed Birch requests",
      unrecorded_reason: "NO GPU RUN RECORDED"
    }
  };
  if (!isPlainRecord(corrRaw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path: `${path}.correctness`, message: "Expected correctness object." });
  } else {
    assertAllowedKeys(corrRaw, ["foreign_reads_stopped", "allowed_requests_completed"], `${path}.correctness`, issues);
    correctness = {
      foreign_reads_stopped: parseCountRatioMetric(
        corrRaw.foreign_reads_stopped,
        `${path}.correctness.foreign_reads_stopped`,
        issues
      ),
      allowed_requests_completed: parseCountRatioMetric(
        corrRaw.allowed_requests_completed,
        `${path}.correctness.allowed_requests_completed`,
        issues
      )
    };
  }

  // Telemetry
  const telRaw = raw.telemetry;
  let telemetry: TelemetryEvidence = {
    ttft_ms: { status: "not_recorded", p50: null, p95: null, sample_count: null, unit: "ms", unrecorded_reason: "NO GPU RUN RECORDED" },
    itl_ms: { status: "not_recorded", p50: null, p95: null, sample_count: null, unit: "ms", unrecorded_reason: "NO GPU RUN RECORDED" },
    throughput_tok_per_s: { status: "not_recorded", value: null, sample_count: null, unit: "tok/s", unrecorded_reason: "NO GPU RUN RECORDED" },
    peak_gpu_memory_gib: { status: "not_recorded", value: null, sample_count: null, unit: "GiB", unrecorded_reason: "NO GPU RUN RECORDED" },
    guard_overhead_us: { status: "not_recorded", p50: null, p95: null, sample_count: null, unit: "us", unrecorded_reason: "NO GPU RUN RECORDED" }
  };
  if (!isPlainRecord(telRaw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path: `${path}.telemetry`, message: "Expected telemetry object." });
  } else {
    assertAllowedKeys(
      telRaw,
      ["ttft_ms", "itl_ms", "throughput_tok_per_s", "peak_gpu_memory_gib", "guard_overhead_us"],
      `${path}.telemetry`,
      issues
    );
    telemetry = {
      ttft_ms: parsePercentileMetric(telRaw.ttft_ms, "ms", gpuRunRecorded, `${path}.telemetry.ttft_ms`, issues),
      itl_ms: parsePercentileMetric(telRaw.itl_ms, "ms", gpuRunRecorded, `${path}.telemetry.itl_ms`, issues),
      throughput_tok_per_s: parseScalarMetric(
        telRaw.throughput_tok_per_s,
        "tok/s",
        gpuRunRecorded,
        `${path}.telemetry.throughput_tok_per_s`,
        issues
      ),
      peak_gpu_memory_gib: parseScalarMetric(
        telRaw.peak_gpu_memory_gib,
        "GiB",
        gpuRunRecorded,
        `${path}.telemetry.peak_gpu_memory_gib`,
        issues
      ),
      guard_overhead_us: parsePercentileMetric(
        telRaw.guard_overhead_us,
        "us",
        gpuRunRecorded,
        `${path}.telemetry.guard_overhead_us`,
        issues
      )
    };
  }

  return {
    lane_id: laneId,
    label,
    lane_note: laneNote,
    run_config: runConfig,
    summary,
    blocks,
    steps,
    correctness,
    telemetry
  };
}

function parseVerifier(raw: unknown, path: string, issues: ValidationIssue[]): VerifierEvidence {
  if (!isPlainRecord(raw)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path, message: "Expected verifier object." });
    return {
      verifier_id: "",
      verdict: "failed",
      canonical_sha256: "",
      computed_sha256: "",
      verified_at_utc: "",
      failure_reason: "Missing verifier block"
    };
  }
  assertAllowedKeys(
    raw,
    ["verifier_id", "verdict", "canonical_sha256", "computed_sha256", "verified_at_utc", "failure_reason"],
    path,
    issues
  );
  return {
    verifier_id: validateSafeId(raw.verifier_id, `${path}.verifier_id`, issues),
    verdict: validateEnum<VerifierVerdict>(
      raw.verdict,
      ["verified", "failed", "unverified"] as const,
      `${path}.verdict`,
      issues,
      "failed"
    ),
    canonical_sha256: validateSha256Prefixed(raw.canonical_sha256, `${path}.canonical_sha256`, issues),
    computed_sha256: validateSha256Prefixed(raw.computed_sha256, `${path}.computed_sha256`, issues),
    verified_at_utc: validateIsoUtcTimestamp(raw.verified_at_utc, `${path}.verified_at_utc`, issues),
    failure_reason: validateOptionalBoundedText(raw.failure_reason, `${path}.failure_reason`, issues, LIMITS.maxNoteLength)
  };
}

export function checkPairedConfiguration(
  nativeOnly: LaneRunConfig,
  vervain: LaneRunConfig
): PairedConfigWarning[] {
  const fields: readonly (keyof LaneRunConfig)[] = [
    "scenario_id",
    "seed",
    "model_id",
    "model_revision",
    "tokenizer_revision",
    "backend",
    "vllm_sha",
    "fixture_id"
  ];
  const warnings: PairedConfigWarning[] = [];
  for (const field of fields) {
    if (nativeOnly[field] !== vervain[field]) {
      warnings.push({
        field,
        nativeOnlyValue: nativeOnly[field],
        vervainValue: vervain[field],
        message: `Paired lanes differ on '${field}': Native only='${String(nativeOnly[field])}' vs Native plus Vervain='${String(vervain[field])}'.`
      });
    }
  }
  return warnings;
}

export function canRenderOutcomeClaim(validated: {
  readonly bundle: EvidenceBundle;
  readonly pairedConfigWarnings: readonly PairedConfigWarning[];
  readonly digestMatches: boolean;
  readonly verifierFailed: boolean;
}): boolean {
  const { bundle, pairedConfigWarnings, digestMatches, verifierFailed } = validated;
  if (verifierFailed || !digestMatches || bundle.verifier.verdict !== "verified") {
    return false;
  }
  if (
    bundle.source_status !== "live" &&
    bundle.source_status !== "recorded" &&
    bundle.source_status !== "local_only"
  ) {
    return false;
  }
  if (bundle.freshness !== "current") {
    return false;
  }
  if (pairedConfigWarnings.length > 0) {
    return false;
  }
  const vervainSummary = bundle.lanes.native_plus_vervain.summary;
  return (
    vervainSummary.scope_decision === "foreign_stopped_allowed_admitted" &&
    vervainSummary.foreign_backend_dispatched === false &&
    vervainSummary.allowed_request_completed === true
  );
}

export function parseEvidenceBundle(untrustedInput: unknown): ParseEvidenceResult {
  if (!isPlainRecord(untrustedInput)) {
    return {
      ok: false,
      issues: [
        {
          code: "INVALID_ROOT_OBJECT",
          path: "$",
          message: "Evidence bundle must be a non-null JSON object."
        }
      ]
    };
  }

  const graphIssues = scanUntrustedGraph(untrustedInput);
  if (graphIssues.length > 0) {
    return { ok: false, issues: deepFreeze(graphIssues) };
  }

  const issues: ValidationIssue[] = [];
  assertAllowedKeys(
    untrustedInput,
    [
      "schema_version",
      "run_id",
      "fixture_id",
      "scenario_id",
      "source_status",
      "freshness",
      "stale_reason",
      "unsupported_reason",
      "gpu_run_recorded",
      "gpu_status_label",
      "captured_at_utc",
      "trust_boundary",
      "software",
      "hardware",
      "policy",
      "lineage",
      "lanes",
      "exclusions",
      "verifier"
    ],
    "$",
    issues
  );

  if (untrustedInput.schema_version !== EVIDENCE_SCHEMA_VERSION) {
    issues.push({
      code: "UNSUPPORTED_SCHEMA_VERSION",
      path: "$.schema_version",
      message: `Expected schema_version '${EVIDENCE_SCHEMA_VERSION}'.`
    });
  }

  const sourceStatus = validateEnum<SourceStatus>(
    untrustedInput.source_status,
    ["live", "recorded", "local_only", "incomplete", "unsupported"] as const,
    "$.source_status",
    issues,
    "incomplete"
  );

  const freshness = validateEnum<ArtifactFreshness>(
    untrustedInput.freshness,
    ["current", "stale"] as const,
    "$.freshness",
    issues,
    "current"
  );

  const staleReason = validateOptionalBoundedText(
    untrustedInput.stale_reason,
    "$.stale_reason",
    issues
  );
  if (freshness === "stale" && !staleReason) {
    issues.push({
      code: "INVALID_SCALAR_TYPE",
      path: "$.stale_reason",
      message: "stale_reason is required when freshness is 'stale'."
    });
  }

  const unsupportedReason = validateOptionalBoundedText(
    untrustedInput.unsupported_reason,
    "$.unsupported_reason",
    issues
  );
  if (sourceStatus === "unsupported" && !unsupportedReason) {
    issues.push({
      code: "INVALID_SCALAR_TYPE",
      path: "$.unsupported_reason",
      message: "unsupported_reason is required when source_status is 'unsupported'."
    });
  }

  if (typeof untrustedInput.gpu_run_recorded !== "boolean") {
    issues.push({
      code: "INVALID_SCALAR_TYPE",
      path: "$.gpu_run_recorded",
      message: "gpu_run_recorded must be a boolean."
    });
  }
  const gpuRunRecorded = Boolean(untrustedInput.gpu_run_recorded);
  const gpuStatusLabel = validateBoundedText(
    untrustedInput.gpu_status_label,
    "$.gpu_status_label",
    issues,
    LIMITS.maxShortLabelLength
  );

  if (!gpuRunRecorded) {
    if (sourceStatus === "live" || sourceStatus === "recorded") {
      issues.push({
        code: "GPU_STATUS_INCONSISTENT",
        path: "$.source_status",
        message: `source_status '${sourceStatus}' requires gpu_run_recorded: true.`
      });
    }
    if (gpuStatusLabel !== "NO GPU RUN RECORDED") {
      issues.push({
        code: "GPU_STATUS_INCONSISTENT",
        path: "$.gpu_status_label",
        message: "gpu_status_label must equal 'NO GPU RUN RECORDED' when gpu_run_recorded is false."
      });
    }
  }

  const runId = validateSafeId(untrustedInput.run_id, "$.run_id", issues);
  const fixtureId = validateSafeId(untrustedInput.fixture_id, "$.fixture_id", issues);
  const scenarioId = validateSafeId(untrustedInput.scenario_id, "$.scenario_id", issues);
  const capturedAtUtc = validateIsoUtcTimestamp(untrustedInput.captured_at_utc, "$.captured_at_utc", issues);

  const trustBoundary = parseTrustBoundary(untrustedInput.trust_boundary, "$.trust_boundary", issues);
  const software = parseSoftware(
    untrustedInput.software,
    sourceStatus === "incomplete",
    "$.software",
    issues
  );
  const hardware = parseHardware(untrustedInput.hardware, gpuRunRecorded, "$.hardware", issues);
  const policy = parsePolicy(untrustedInput.policy, "$.policy", issues);
  const lineage = parseLineage(untrustedInput.lineage, "$.lineage", issues);

  let nativeOnlyLane: LaneReplayEvidence | null = null;
  let vervainLane: LaneReplayEvidence | null = null;
  if (!isPlainRecord(untrustedInput.lanes)) {
    issues.push({ code: "INVALID_SCALAR_TYPE", path: "$.lanes", message: "Expected lanes object." });
  } else {
    assertAllowedKeys(untrustedInput.lanes, ["native_only", "native_plus_vervain"], "$.lanes", issues);
    if (isPlainRecord(untrustedInput.lanes.native_only)) {
      nativeOnlyLane = parseLane(
        untrustedInput.lanes.native_only,
        "native_only",
        "Native only",
        sourceStatus,
        gpuRunRecorded,
        "$.lanes.native_only",
        issues
      );
    } else {
      issues.push({
        code: "INVALID_SCALAR_TYPE",
        path: "$.lanes.native_only",
        message: "Expected native_only lane object."
      });
    }
    if (isPlainRecord(untrustedInput.lanes.native_plus_vervain)) {
      vervainLane = parseLane(
        untrustedInput.lanes.native_plus_vervain,
        "native_plus_vervain",
        "Native plus Vervain",
        sourceStatus,
        gpuRunRecorded,
        "$.lanes.native_plus_vervain",
        issues
      );
    } else {
      issues.push({
        code: "INVALID_SCALAR_TYPE",
        path: "$.lanes.native_plus_vervain",
        message: "Expected native_plus_vervain lane object."
      });
    }
  }

  // Exclusions
  const exclusionsRaw = untrustedInput.exclusions;
  const exclusions: string[] = [];
  if (!Array.isArray(exclusionsRaw) || exclusionsRaw.length === 0) {
    issues.push({
      code: "INVALID_SCALAR_TYPE",
      path: "$.exclusions",
      message: "Expected non-empty exclusions array."
    });
  } else if (exclusionsRaw.length > LIMITS.maxExclusions) {
    issues.push({
      code: "COLLECTION_CAP_EXCEEDED",
      path: "$.exclusions",
      message: `Exclusions array exceeds cap (${LIMITS.maxExclusions}).`
    });
  } else {
    exclusionsRaw.forEach((item, idx) => {
      exclusions.push(validateBoundedText(item, `$.exclusions[${idx}]`, issues, LIMITS.maxNoteLength));
    });
  }

  const verifier = parseVerifier(untrustedInput.verifier, "$.verifier", issues);

  if (issues.length > 0 || !nativeOnlyLane || !vervainLane) {
    return {
      ok: false,
      issues: deepFreeze(issues)
    };
  }

  const bundle: EvidenceBundle = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    run_id: runId,
    fixture_id: fixtureId,
    scenario_id: scenarioId,
    source_status: sourceStatus,
    freshness,
    stale_reason: staleReason,
    unsupported_reason: unsupportedReason,
    gpu_run_recorded: gpuRunRecorded,
    gpu_status_label: gpuStatusLabel,
    captured_at_utc: capturedAtUtc,
    trust_boundary: trustBoundary,
    software,
    hardware,
    policy,
    lineage,
    lanes: {
      native_only: nativeOnlyLane,
      native_plus_vervain: vervainLane
    },
    exclusions,
    verifier
  };

  const pairedConfigWarnings = checkPairedConfiguration(
    bundle.lanes.native_only.run_config,
    bundle.lanes.native_plus_vervain.run_config
  );
  const digestMatches = bundle.verifier.canonical_sha256 === bundle.verifier.computed_sha256;
  const verifierFailed =
    bundle.verifier.verdict === "failed" ||
    !digestMatches ||
    (bundle.source_status !== "incomplete" &&
      bundle.source_status !== "unsupported" &&
      bundle.verifier.verdict !== "verified");

  const outcomeClaimEligible = canRenderOutcomeClaim({
    bundle,
    pairedConfigWarnings,
    digestMatches,
    verifierFailed
  });

  const validated: ValidatedEvidenceBundle = {
    bundle,
    statusBadge: mapSourceStatusToBadge(bundle.source_status),
    pairedConfigWarnings,
    digestMatches,
    verifierFailed,
    outcomeClaimEligible
  };

  return {
    ok: true,
    value: deepFreeze(validated)
  };
}

export function validateEvidenceBundle(untrustedInput: unknown): ValidatedEvidenceBundle {
  const result = parseEvidenceBundle(untrustedInput);
  if (!result.ok) {
    const first = result.issues[0];
    throw new Error(
      `Evidence validation failed (${first?.code ?? "UNKNOWN"} at ${first?.path ?? "$"}): ${first?.message ?? "Invalid evidence"}`
    );
  }
  return result.value;
}
