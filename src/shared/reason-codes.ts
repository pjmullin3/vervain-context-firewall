/**
 * Responsibility: Fixed machine-readable reason codes, dispositions, and error identifiers
 * shared across server enforcement modules, bounded receipts, and browser rendering.
 * Trust boundary: Safe public constants only; carries zero authority or secret material.
 */

export const CHUNK_DISPOSITIONS = ['admitted', 'withheld', 'unknown'] as const;
export type ChunkDisposition = (typeof CHUNK_DISPOSITIONS)[number];

export const ADMISSION_REASONS = {
  VALID_AUTHORITY_AND_PROVENANCE: 'valid_authority_and_provenance',
  TENANT_MISMATCH: 'tenant_mismatch',
  STALE_POLICY_EPOCH: 'stale_policy_epoch',
  DIGEST_MISMATCH: 'digest_mismatch',
  UNRECOGNIZED_SOURCE: 'unrecognized_source',
  DISALLOWED_CLASSIFICATION: 'disallowed_classification',
  CHUNK_SIZE_EXCEEDED: 'chunk_size_exceeded',
  CHUNK_COUNT_EXCEEDED: 'chunk_count_exceeded',
  SCHEMA_INCOMPLETE: 'schema_incomplete',
  MISSING_PROVENANCE: 'missing_provenance',
  MALFORMED_CHUNK: 'malformed_chunk',
} as const;

export type AdmissionReasonCode = (typeof ADMISSION_REASONS)[keyof typeof ADMISSION_REASONS];

export const RELEASE_DECISIONS = ['released', 'withheld', 'not_applicable'] as const;
export type ReleaseDecision = (typeof RELEASE_DECISIONS)[number];

export const RELEASE_REASONS = {
  AUTHORITY_VERIFIED: 'authority_verified',
  POLICY_EPOCH_CHANGED: 'policy_epoch_changed',
  SESSION_EXPIRED: 'session_expired',
  SESSION_MISSING: 'session_missing',
  AUTHORITY_MISMATCH: 'authority_mismatch',
  PLANTED_VALUE_DETECTED: 'planted_value_detected',
  UNBOUND_SOURCE_CITATION: 'unbound_source_citation',
  DUPLICATE_RELEASE_BLOCKED: 'duplicate_release_blocked',
  LEDGER_WRITE_FAILED: 'ledger_write_failed',
  PROVIDER_NOT_CALLED: 'provider_not_called',
  PROVIDER_FAILED: 'provider_failed',
  NO_ADMITTED_CONTEXT: 'no_admitted_context',
} as const;

export type ReleaseReasonCode = (typeof RELEASE_REASONS)[keyof typeof RELEASE_REASONS];

export const PROVIDER_OUTCOMES = [
  'succeeded',
  'not_called',
  'provider_unavailable',
  'rate_limited',
  'timed_out',
  'auth_failed',
  'invalid_response',
  'provider_error',
] as const;

export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number];

export const PERMITTED_TASK_BASES = {
  RELEASED_AUTHORIZED_ANSWER: 'released_authorized_answer_under_unchanged_epoch',
  UNMEDIATED_CONTROL_OBSERVATION: 'unmediated_synthetic_control_not_governed',
  NO_ADMITTED_CONTEXT: 'incomplete_zero_admitted_chunks_for_destination',
  WITHHELD_AT_RELEASE: 'incomplete_response_withheld_at_release_gate',
  PROVIDER_UNAVAILABLE_OR_FAILED: 'incomplete_provider_did_not_return_valid_answer',
} as const;

export type PermittedTaskBasis = (typeof PERMITTED_TASK_BASES)[keyof typeof PERMITTED_TASK_BASES];

export const API_ERROR_CODES = {
  AUTHORITY_OVERRIDE_REJECTED: 'authority_override_rejected',
  INVALID_SESSION: 'invalid_session',
  SESSION_EXPIRED: 'session_expired',
  AMBIGUOUS_JSON_PAYLOAD: 'ambiguous_json_payload',
  FORBIDDEN_JSON_KEY: 'forbidden_json_key',
  UNKNOWN_FIELD: 'unknown_field',
  INVALID_CONTENT_TYPE: 'invalid_content_type',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
  CSRF_ORIGIN_REJECTED: 'csrf_origin_rejected',
  RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
  BUDGET_EXCEEDED: 'budget_exceeded',
  SESSION_CAPACITY_REACHED: 'session_capacity_reached',
  RUN_IN_PROGRESS: 'run_in_progress',
  NOT_FOUND: 'not_found',
  INVALID_REQUEST: 'invalid_request',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];
