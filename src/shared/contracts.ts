/**
 * Responsibility: Strict API request/response contracts, RFC 8259 duplicate-key and
 * prototype-key rejecting JSON parser, and client authority-override detector.
 * Trust boundary: Validates untrusted wire inputs before server execution touches state.
 */

import {
  API_ERROR_CODES,
  type AdmissionReasonCode,
  type ApiErrorCode,
  type ChunkDisposition,
  type PermittedTaskBasis,
  type ProviderOutcome,
  type ReleaseDecision,
  type ReleaseReasonCode,
} from './reason-codes.js';

export const PERSONA_IDS = ['alder', 'beacon'] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];

export const SCENARIO_IDS = [
  'paired_defect',
  'clean_request',
  'revoke_during_generation',
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const RETRIEVAL_SCENARIO_MODES = [
  'safe_tenant_scoped',
  'cross_tenant_filter_omission',
] as const;
export type RetrievalScenarioMode = (typeof RETRIEVAL_SCENARIO_MODES)[number];

export const ARM_IDS = ['native_only', 'native_plus_vervain'] as const;
export type ArmId = (typeof ARM_IDS)[number];

export const RUNTIME_MODES = ['live', 'mock'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export interface SafePersonaView {
  persona: PersonaId;
  tenantLabel: string;
  principalDisplay: string;
  policyId: string;
  policyEpoch: number;
  sessionHandlePreview: string;
  expiresAtIso: string;
  fixtureNotice: 'synthetic_fixture_not_authentication';
}

export interface RuntimeStatusView {
  provider: 'Google Gemini';
  configuredModel: string;
  mode: RuntimeMode;
  liveKeyConfigured: boolean;
  contextMediationState: 'active' | 'degraded';
  mediatedBoundariesCount: number;
  mediatedBoundariesTotal: number;
  boundaryScopeNote: string;
  instanceLifetimeNote: string;
}

export type LaneStepStatus =
  | 'verified'
  | 'retrieved'
  | 'retrieved_with_foreign'
  | 'unmediated_passthrough'
  | 'filtered_foreign_withheld'
  | 'admitted_clean'
  | 'withheld_all'
  | 'transmitted_contaminated'
  | 'transmitted_authorized_only'
  | 'not_transmitted'
  | 'released'
  | 'withheld_release'
  | 'unmediated_reply'
  | 'provider_unavailable'
  | 'completed'
  | 'incomplete';

export interface LaneStepView {
  stepId:
    | 'session_authority'
    | 'retrieval'
    | 'admission'
    | 'gemini_transmission'
    | 'response_release'
    | 'allowed_task_outcome';
  label: string;
  status: LaneStepStatus;
  summary: string;
  detailMono?: string;
}

export type ProvenanceNodeId =
  | 'authority'
  | 'retriever'
  | 'source_alder'
  | 'source_beacon'
  | 'context_gate'
  | 'gemini'
  | 'release_gate'
  | 'reply'
  | 'receipt';

export type ProvenanceEdgeVerb =
  | 'retrieved'
  | 'admitted'
  | 'withheld'
  | 'transmitted'
  | 'generated'
  | 'released'
  | 'recorded'
  | 'unmediated';

export interface ProvenanceNodeView {
  id: ProvenanceNodeId;
  label: string;
  category: 'authority' | 'store' | 'source' | 'boundary' | 'provider' | 'output' | 'evidence';
  stateText: string;
  tone: 'neutral' | 'allowed' | 'withheld' | 'violet' | 'warning';
  evidenceFields: ReadonlyArray<{ key: string; value: string; mono?: boolean }>;
}

export interface ProvenanceEdgeView {
  id: string;
  from: ProvenanceNodeId;
  to: ProvenanceNodeId;
  verb: ProvenanceEdgeVerb;
  lineStyle: 'solid' | 'dashed' | 'interrupted' | 'dotted';
  tone: 'neutral' | 'allowed' | 'withheld' | 'violet' | 'warning';
  basis: string;
}

export interface SourceDecisionSummary {
  chunkId: string;
  sourceAlias: string;
  sourceTenantLabel: string;
  sourceVersionSha256: string;
  contentSha256: string;
  sourceEpoch: number;
  classification: string;
  disposition: ChunkDisposition;
  reasonCode: AdmissionReasonCode | 'unmediated_control_bypass';
  enteredGeminiEnvelope: boolean;
}

export interface ArmExecutionView {
  arm: ArmId;
  armLabel: string;
  controlWarning?: string;
  requestId: string;
  receiptId: string;
  fixtureId: string;
  querySha256: string;
  frozenQueryText: string;
  structuralVerdict:
    | 'cross_tenant_context_transmitted'
    | 'foreign_context_withheld_before_gemini'
    | 'clean_authorized_context_transmitted'
    | 'response_withheld_after_epoch_change'
    | 'no_context_admitted_native_denial_preserved';
  outcomeSentence: string;
  counts: {
    retrieved: number;
    admitted: number;
    withheld: number;
    unknown: number;
    admittedDenominatorUnit: 'retrieved_chunks';
  };
  foreignChunkEnteredEnvelope: boolean;
  plantedValueInResponse: boolean;
  permittedTaskCompleted: boolean;
  permittedTaskBasis: PermittedTaskBasis;
  policyEpochAtAdmission: number;
  policyEpochAtRelease: number;
  providerRuntime: {
    provider: 'Google Gemini';
    model: string;
    mode: RuntimeMode;
    callAttempted: boolean;
    outcome: ProviderOutcome;
    latencyMs: number;
    retryCount: number;
  };
  releaseDecision: ReleaseDecision;
  releaseReason: ReleaseReasonCode | 'unmediated_control_release';
  releasedAnswerText: string | null;
  releasedSourcesUsed: readonly string[];
  steps: readonly LaneStepView[];
  graph: {
    nodes: readonly ProvenanceNodeView[];
    edges: readonly ProvenanceEdgeView[];
  };
  receipt: ContextReceipt;
}

export interface ReceiptSourceEntry {
  chunk_id: string;
  source_digest_sha256: string;
  source_version_sha256: string;
  content_sha256: string;
  record_tenant_digest_sha256: string;
  record_policy_epoch: number;
  classification: string;
  disposition: ChunkDisposition | 'unmediated_control';
  reason_code: AdmissionReasonCode | 'unmediated_control_bypass';
  entered_outbound_envelope: boolean;
}

export interface ContextReceipt {
  schema_version: string;
  build_id: string;
  receipt_id: string;
  request_id: string;
  scenario: ScenarioId;
  arm: ArmId;
  session_digest_sha256: string;
  principal_digest_sha256: string;
  tenant_digest_sha256: string;
  policy_id: string;
  policy_epoch_at_admission: number;
  policy_epoch_at_release: number;
  query_sha256: string;
  counts: {
    retrieved: number;
    admitted: number;
    withheld: number;
    unknown: number;
    denominator_total_retrieved: number;
  };
  sources: readonly ReceiptSourceEntry[];
  outbound_envelope: {
    envelope_sha256: string | null;
    admitted_chunk_count: number;
    admitted_chunk_denominator_retrieved: number;
    foreign_tenant_chunk_present: boolean;
  };
  provider: {
    provider_id: 'google-gemini';
    model_id: string;
    transport_mode: RuntimeMode;
    call_attempted: boolean;
    outcome: ProviderOutcome;
    latency_ms: number;
    retry_count: number;
  };
  release: {
    decision: ReleaseDecision | 'unmediated_control_release';
    reason_code: ReleaseReasonCode | 'unmediated_control_release';
    response_sha256: string | null;
    response_utf8_bytes: number;
    planted_value_exact_match: boolean;
  };
  permitted_task: {
    completed: boolean;
    basis: PermittedTaskBasis;
  };
  chain: {
    event_count_in_run: number;
    first_event_index: number;
    last_event_index: number;
    previous_receipt_chain_sha256: string;
    current_receipt_chain_sha256: string;
    rollback_note: 'tamper_evident_within_live_instance_only_not_rollback_resistant_without_external_checkpoint';
  };
  timestamps: {
    started_at_iso: string;
    completed_at_iso: string;
    duration_ms: number;
  };
  mediated_boundaries: readonly string[];
  exclusions: readonly string[];
  evidence_completeness: 'complete_for_mediated_boundaries' | 'partial_provider_unavailable';
}

export interface LedgerVerificationResult {
  verified: boolean;
  checkedEvents: number;
  checkedReceipts: number;
  headChainSha256: string;
  failureIndex: number | null;
  failureReason: string | null;
  limitationNote: string;
}

export interface ScopedBlockEvidence {
  logicalSlot: number;
  physicalBlockId: number;
  blockLabel: string;
  scopeTagHex: string;
  scopeMatchesRequest: boolean;
  tokenPositions: readonly number[];
  validTokenFlags: readonly boolean[];
  rawScores: readonly number[];
  baselineWeights: readonly number[];
  scopedWeights: readonly number[];
  baselineBlockMass: number;
  scopedBlockMass: number;
  maskDisposition: 'admitted_to_softmax' | 'masked_scope_mismatch' | 'masked_invalid_slot';
}

export interface ScopedAttentionProofView {
  limitationBanner: string;
  requestScopeHex: string;
  tenantContextLabel: string;
  vectorDim: number;
  scaleFactor: number;
  queryVector: readonly number[];
  blocks: readonly ScopedBlockEvidence[];
  baselineOutput: readonly number[];
  scopedOutput: readonly number[];
  cleanAllowedTwinBaselineOutput: readonly number[];
  cleanAllowedTwinScopedOutput: readonly number[];
  contaminatedVsScopedL2Delta: number;
  cleanAllowedTwinMaxAbsDelta: number;
  foreignPostMaskMass: number;
  mismatchCounter: number;
  allMaskedControlStatus: 'refused_all_masked_zero_nan';
  invalidBlockControlStatus: 'failed_closed_invalid_block_id';
  computedAtIso: string;
}

export interface DemoStateResponse {
  session: SafePersonaView;
  runtime: RuntimeStatusView;
  frozenQuery: string;
  querySha256: string;
  fixtureId: string;
  latestPairedRun: {
    runGroupId: string;
    nativeOnly: ArmExecutionView;
    nativePlusVervain: ArmExecutionView;
  } | null;
  latestSingleRun: ArmExecutionView | null;
  recentReceiptIds: readonly string[];
  ledgerSummary: LedgerVerificationResult;
}

export interface StrictParseFailure {
  ok: false;
  code: ApiErrorCode;
  message: string;
}

export interface StrictParseSuccess<T = unknown> {
  ok: true;
  value: T;
}

export type StrictParseResult<T = unknown> = StrictParseSuccess<T> | StrictParseFailure;

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_JSON_DEPTH = 16;

const FORBIDDEN_AUTHORITY_KEYS_NORMALIZED = new Set([
  'tenant',
  'tenantid',
  'xtenant',
  'xtenantid',
  'principal',
  'principalid',
  'xprincipal',
  'xprincipalid',
  'policyepoch',
  'epoch',
  'xpolicyepoch',
  'policyid',
  'scope',
  'requestscope',
  'scopeid',
  'xscope',
  'xrequestscope',
  'disablesecurity',
  'bypassadmission',
  'allowforeign',
  'sessionid',
  'xsessionid',
  'apikey',
  'geminiapikey',
  'xapikey',
  'model',
  'geminimodel',
  'baseurl',
  'providerurl',
  'systeminstruction',
]);

export function normalizeFieldKey(rawKey: string): string {
  return rawKey.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isForbiddenAuthorityKey(rawKey: string): boolean {
  return FORBIDDEN_AUTHORITY_KEYS_NORMALIZED.has(normalizeFieldKey(rawKey));
}

/**
 * Parses a raw UTF-8 JSON string while strictly rejecting duplicate object keys at any
 * depth, prototype-related property names (`__proto__`, `constructor`, `prototype`),
 * null bytes, and excessive nesting before returning plain objects.
 */
export function parseStrictJson(raw: string): StrictParseResult<unknown> {
  if (raw.includes('\u0000')) {
    return {
      ok: false,
      code: API_ERROR_CODES.INVALID_REQUEST,
      message: 'Null bytes are not permitted in request payloads.',
    };
  }

  let parsedStandard: unknown;
  try {
    parsedStandard = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      code: API_ERROR_CODES.INVALID_REQUEST,
      message: 'Malformed JSON body.',
    };
  }

  // Structural RFC 8259 token scan to enforce key uniqueness and prototype-key rejection.
  let idx = 0;
  const len = raw.length;

  const skipWs = (): void => {
    while (idx < len) {
      const ch = raw.charCodeAt(idx);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        idx += 1;
      } else {
        break;
      }
    }
  };

  const readJsonStringDecoded = (): string => {
    const start = idx;
    idx += 1; // skip opening quote
    while (idx < len) {
      const ch = raw.charCodeAt(idx);
      if (ch === 0x5c) {
        // backslash escape
        idx += 2;
        continue;
      }
      if (ch === 0x22) {
        idx += 1;
        const slice = raw.slice(start, idx);
        return JSON.parse(slice) as string;
      }
      idx += 1;
    }
    throw new Error('Unterminated JSON string');
  };

  const scanValue = (depth: number): StrictParseFailure | null => {
    if (depth > MAX_JSON_DEPTH) {
      return {
        ok: false,
        code: API_ERROR_CODES.INVALID_REQUEST,
        message: 'JSON nesting depth exceeds policy limit.',
      };
    }
    skipWs();
    const ch = raw[idx];
    if (ch === '{') {
      idx += 1;
      skipWs();
      const seenKeys = new Set<string>();
      if (raw[idx] === '}') {
        idx += 1;
        return null;
      }
      while (idx < len) {
        skipWs();
        if (raw[idx] !== '"') {
          return {
            ok: false,
            code: API_ERROR_CODES.INVALID_REQUEST,
            message: 'Expected quoted object key.',
          };
        }
        const key = readJsonStringDecoded();
        if (FORBIDDEN_OBJECT_KEYS.has(key)) {
          return {
            ok: false,
            code: API_ERROR_CODES.FORBIDDEN_JSON_KEY,
            message: 'Prototype-related keys are rejected.',
          };
        }
        if (seenKeys.has(key)) {
          return {
            ok: false,
            code: API_ERROR_CODES.AMBIGUOUS_JSON_PAYLOAD,
            message: 'Duplicate JSON object keys are rejected.',
          };
        }
        seenKeys.add(key);
        skipWs();
        if (raw[idx] !== ':') {
          return {
            ok: false,
            code: API_ERROR_CODES.INVALID_REQUEST,
            message: 'Expected colon after object key.',
          };
        }
        idx += 1;
        const nestedErr = scanValue(depth + 1);
        if (nestedErr) {
          return nestedErr;
        }
        skipWs();
        if (raw[idx] === ',') {
          idx += 1;
          continue;
        }
        if (raw[idx] === '}') {
          idx += 1;
          break;
        }
        return {
          ok: false,
          code: API_ERROR_CODES.INVALID_REQUEST,
          message: 'Malformed JSON object separator.',
        };
      }
      return null;
    }

    if (ch === '[') {
      idx += 1;
      skipWs();
      if (raw[idx] === ']') {
        idx += 1;
        return null;
      }
      while (idx < len) {
        const nestedErr = scanValue(depth + 1);
        if (nestedErr) {
          return nestedErr;
        }
        skipWs();
        if (raw[idx] === ',') {
          idx += 1;
          continue;
        }
        if (raw[idx] === ']') {
          idx += 1;
          break;
        }
        return {
          ok: false,
          code: API_ERROR_CODES.INVALID_REQUEST,
          message: 'Malformed JSON array separator.',
        };
      }
      return null;
    }

    if (ch === '"') {
      readJsonStringDecoded();
      return null;
    }

    // Primitive literal (number, true, false, null) already validated by JSON.parse
    while (idx < len) {
      const code = raw.charCodeAt(idx);
      if (
        code === 0x20 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0d ||
        code === 0x2c ||
        code === 0x7d ||
        code === 0x5d
      ) {
        break;
      }
      idx += 1;
    }
    return null;
  };

  const scanError = scanValue(1);
  if (scanError) {
    return scanError;
  }

  return { ok: true, value: toNullPrototypeDeep(parsedStandard) };
}

function toNullPrototypeDeep(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map((item) => toNullPrototypeDeep(item));
  }
  if (val !== null && typeof val === 'object') {
    const clean = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      clean[k] = toNullPrototypeDeep(v);
    }
    return clean;
  }
  return val;
}

/**
 * Inspects raw HTTP headers, URL search parameters, and parsed JSON body keys
 * for any client-supplied tenant, principal, policy epoch, scope, or provider override.
 */
export function detectClientAuthorityOverride(params: {
  rawHeaders: readonly string[];
  searchParams: URLSearchParams;
  bodyValue?: unknown;
}): StrictParseFailure | null {
  const seenSecurityHeaders = new Set<string>();
  for (let i = 0; i < params.rawHeaders.length; i += 2) {
    const headerName = params.rawHeaders[i];
    if (!headerName) continue;
    const lower = headerName.toLowerCase();
    if (isForbiddenAuthorityKey(lower)) {
      return {
        ok: false,
        code: API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED,
        message: 'Client-supplied authority or model override header is rejected.',
      };
    }
    if (lower === 'cookie' || lower === 'origin' || lower === 'content-type') {
      if (seenSecurityHeaders.has(lower)) {
        return {
          ok: false,
          code: API_ERROR_CODES.AMBIGUOUS_JSON_PAYLOAD,
          message: `Duplicate ${lower} header is rejected.`,
        };
      }
      seenSecurityHeaders.add(lower);
    }
  }

  for (const key of params.searchParams.keys()) {
    if (isForbiddenAuthorityKey(key)) {
      return {
        ok: false,
        code: API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED,
        message: 'Client-supplied authority or model override query parameter is rejected.',
      };
    }
    return {
      ok: false,
      code: API_ERROR_CODES.UNKNOWN_FIELD,
      message: 'Unexpected query parameter on strict endpoint.',
    };
  }

  const walkBody = (node: unknown): StrictParseFailure | null => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const res = walkBody(item);
        if (res) return res;
      }
      return null;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        if (isForbiddenAuthorityKey(key)) {
          return {
            ok: false,
            code: API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED,
            message: 'Client-supplied authority, scope, or model override field is rejected.',
          };
        }
        const nested = walkBody(val);
        if (nested) return nested;
      }
    }
    return null;
  };

  if (params.bodyValue !== undefined) {
    return walkBody(params.bodyValue);
  }
  return null;
}

export function validatePersonaSessionPayload(body: unknown): StrictParseResult<{ persona: PersonaId }> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      code: API_ERROR_CODES.INVALID_REQUEST,
      message: 'Request body must be a JSON object.',
    };
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of keys) {
    if (key !== 'persona') {
      return {
        ok: false,
        code: isForbiddenAuthorityKey(key)
          ? API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED
          : API_ERROR_CODES.UNKNOWN_FIELD,
        message: isForbiddenAuthorityKey(key)
          ? 'Client-supplied authority field is rejected.'
          : 'Unknown field on session endpoint.',
      };
    }
  }
  const persona = record['persona'];
  if (persona !== 'alder' && persona !== 'beacon') {
    return {
      ok: false,
      code: API_ERROR_CODES.INVALID_REQUEST,
      message: 'Persona must be one of the known synthetic fixtures (alder or beacon).',
    };
  }
  return { ok: true, value: { persona } };
}

export function validateEmptyMutationPayload(body: unknown): StrictParseResult<Record<string, never>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      code: API_ERROR_CODES.INVALID_REQUEST,
      message: 'Request body must be an empty JSON object.',
    };
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length > 0) {
    const firstKey = keys[0] ?? '';
    return {
      ok: false,
      code: isForbiddenAuthorityKey(firstKey)
        ? API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED
        : API_ERROR_CODES.UNKNOWN_FIELD,
      message: isForbiddenAuthorityKey(firstKey)
        ? 'Client-supplied authority override field is rejected.'
        : 'Unexpected field on parameterless action endpoint.',
    };
  }
  return { ok: true, value: {} as Record<string, never> };
}
