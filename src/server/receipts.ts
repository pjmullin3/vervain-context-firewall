/**
 * Responsibility: Content-free bounded `ContextReceipt` assembly from execution events
 * and mandatory sensitive-string hygiene enforcement before persistence or export.
 * Trust boundary: Ensures zero fixture text, prompts, responses, planted values, cookies,
 * or keys ever enter a receipt.
 */

import crypto from 'node:crypto';
import {
  BUILD_ID,
  MEDIATED_BOUNDARIES,
  RECEIPT_EXCLUSIONS,
  RECEIPT_SCHEMA_VERSION,
} from '../shared/config.js';
import type {
  ArmId,
  ContextReceipt,
  ReceiptSourceEntry,
  RuntimeMode,
  ScenarioId,
} from '../shared/contracts.js';
import type {
  PermittedTaskBasis,
  ProviderOutcome,
  ReleaseDecision,
  ReleaseReasonCode,
} from '../shared/reason-codes.js';
import type { ChunkAdmissionDecision } from './admission.js';
import { getProtectedFixtureSubstrings } from './fixture.js';
import {
  computeReceiptChainSha256,
  type AuditLedger,
  type LedgerEventRecord,
} from './ledger.js';
import { domainSeparatedDigest, findProhibitedContentInObject } from './redaction.js';
import type { RetrievedChunk } from './retrieval.js';
import type { ServerAuthoritySnapshot } from './session.js';

export function buildAndAppendRunReceipt(params: {
  ledger: AuditLedger;
  requestId: string;
  scenario: ScenarioId;
  arm: ArmId;
  authorityAtAdmission: ServerAuthoritySnapshot;
  policyEpochAtRelease: number;
  querySha256: string;
  retrievedChunks: readonly RetrievedChunk[];
  admissionDecisions: readonly ChunkAdmissionDecision[] | null; // null only in unmediated control
  envelopeSha256: string | null;
  admittedChunkCount: number;
  foreignTenantChunkInEnvelope: boolean;
  modelId: string;
  transportMode: RuntimeMode;
  providerCallAttempted: boolean;
  providerOutcome: ProviderOutcome;
  providerLatencyMs: number;
  providerRetryCount: number;
  releaseDecision: ReleaseDecision | 'unmediated_control_release';
  releaseReasonCode: ReleaseReasonCode | 'unmediated_control_release';
  responseSha256: string | null;
  responseUtf8Bytes: number;
  plantedValueExactMatch: boolean;
  permittedTaskCompleted: boolean;
  permittedTaskBasis: PermittedTaskBasis;
  startedAtMs: number;
  completedAtMs: number;
  extraSecretsToRedactCheck?: readonly string[];
}): ContextReceipt {
  const receiptId = `rcpt_${crypto.randomBytes(12).toString('hex')}`;
  const sessionDigest = domainSeparatedDigest('session', params.authorityAtAdmission.sessionId);
  const principalDigest = domainSeparatedDigest(
    'principal',
    params.authorityAtAdmission.principalId,
  );
  const tenantDigest = domainSeparatedDigest('tenant', params.authorityAtAdmission.tenantId);

  const sources: ReceiptSourceEntry[] =
    params.admissionDecisions !== null
      ? params.admissionDecisions.map((d) =>
          Object.freeze({
            chunk_id: d.chunkId,
            source_digest_sha256: domainSeparatedDigest('source', d.sourceId),
            source_version_sha256: d.sourceVersionSha256,
            content_sha256: d.contentSha256,
            record_tenant_digest_sha256: domainSeparatedDigest('tenant', d.recordTenantId),
            record_policy_epoch: d.recordPolicyEpoch,
            classification: d.classification,
            disposition: d.disposition,
            reason_code: d.reasonCode,
            entered_outbound_envelope: d.disposition === 'admitted' && params.providerCallAttempted,
          }),
        )
      : params.retrievedChunks.map((c) =>
          Object.freeze({
            chunk_id: c.chunk_id,
            source_digest_sha256: domainSeparatedDigest('source', c.source_id),
            source_version_sha256: c.source_version_sha256,
            content_sha256: c.content_sha256,
            record_tenant_digest_sha256: domainSeparatedDigest('tenant', c.tenant_id),
            record_policy_epoch: c.policy_epoch,
            classification: c.classification,
            disposition: 'unmediated_control' as const,
            reason_code: 'unmediated_control_bypass' as const,
            entered_outbound_envelope: params.providerCallAttempted,
          }),
        );

  const retrievedCount =
    params.admissionDecisions !== null
      ? params.admissionDecisions.length
      : params.retrievedChunks.length;
  const admittedCount =
    params.admissionDecisions !== null
      ? params.admissionDecisions.filter((d) => d.disposition === 'admitted').length
      : params.retrievedChunks.length;
  const withheldCount =
    params.admissionDecisions !== null
      ? params.admissionDecisions.filter((d) => d.disposition === 'withheld').length
      : 0;
  const unknownCount =
    params.admissionDecisions !== null
      ? params.admissionDecisions.filter((d) => d.disposition === 'unknown').length
      : 0;

  const startedIso = new Date(params.startedAtMs).toISOString();
  const completedIso = new Date(params.completedAtMs).toISOString();

  // Emit canonical per-stage ledger events for this request
  const runEvents: LedgerEventRecord[] = [];
  const pushStage = (
    stage: LedgerEventRecord['stage'],
    payload: Readonly<Record<string, unknown>>,
  ): void => {
    const ev = params.ledger.appendEvent({
      eventId: `evt_${params.requestId}_${stage}`,
      requestId: params.requestId,
      sessionDigestSha256: sessionDigest,
      stage,
      timestampIso: completedIso,
      payload,
    });
    runEvents.push(ev);
  };

  pushStage('retrieval', {
    scenario: params.scenario,
    arm: params.arm,
    retrieved_count: retrievedCount,
    query_sha256: params.querySha256,
  });

  pushStage('admission', {
    policy_id: params.authorityAtAdmission.policyId,
    policy_epoch_at_admission: params.authorityAtAdmission.policyEpoch,
    admitted_count: admittedCount,
    withheld_count: withheldCount,
    unknown_count: unknownCount,
    denominator_retrieved: retrievedCount,
  });

  pushStage('provider_dispatch', {
    call_attempted: params.providerCallAttempted,
    envelope_sha256: params.envelopeSha256,
    admitted_chunk_count: params.admittedChunkCount,
    foreign_tenant_chunk_present: params.foreignTenantChunkInEnvelope,
    model_id: params.modelId,
    transport_mode: params.transportMode,
  });

  pushStage('provider_completion', {
    outcome: params.providerOutcome,
    latency_ms: params.providerLatencyMs,
    retry_count: params.providerRetryCount,
  });

  pushStage('release_decision', {
    decision: params.releaseDecision,
    reason_code: params.releaseReasonCode,
    policy_epoch_at_release: params.policyEpochAtRelease,
    response_sha256: params.responseSha256,
    response_utf8_bytes: params.responseUtf8Bytes,
    planted_value_exact_match: params.plantedValueExactMatch,
  });

  pushStage('observed_outcome', {
    receipt_id: receiptId,
    permitted_task_completed: params.permittedTaskCompleted,
    permitted_task_basis: params.permittedTaskBasis,
  });

  const firstEventIndex = runEvents[0]!.event_index;
  const lastEventIndex = runEvents[runEvents.length - 1]!.event_index;
  const eventHashes = runEvents.map((e) => e.event_sha256);
  const prevReceiptChainSha256 = params.ledger.getPreviousReceiptChainSha256();

  const evidenceCompleteness: ContextReceipt['evidence_completeness'] =
    params.providerCallAttempted && params.providerOutcome !== 'succeeded'
      ? 'partial_provider_unavailable'
      : 'complete_for_mediated_boundaries';

  const bodyWithoutCurrentHash = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    build_id: BUILD_ID,
    receipt_id: receiptId,
    request_id: params.requestId,
    scenario: params.scenario,
    arm: params.arm,
    session_digest_sha256: sessionDigest,
    principal_digest_sha256: principalDigest,
    tenant_digest_sha256: tenantDigest,
    policy_id: params.authorityAtAdmission.policyId,
    policy_epoch_at_admission: params.authorityAtAdmission.policyEpoch,
    policy_epoch_at_release: params.policyEpochAtRelease,
    query_sha256: params.querySha256,
    counts: Object.freeze({
      retrieved: retrievedCount,
      admitted: admittedCount,
      withheld: withheldCount,
      unknown: unknownCount,
      denominator_total_retrieved: retrievedCount,
    }),
    sources: Object.freeze(sources),
    outbound_envelope: Object.freeze({
      envelope_sha256: params.envelopeSha256,
      admitted_chunk_count: params.admittedChunkCount,
      admitted_chunk_denominator_retrieved: retrievedCount,
      foreign_tenant_chunk_present: params.foreignTenantChunkInEnvelope,
    }),
    provider: Object.freeze({
      provider_id: 'google-gemini' as const,
      model_id: params.modelId,
      transport_mode: params.transportMode,
      call_attempted: params.providerCallAttempted,
      outcome: params.providerOutcome,
      latency_ms: params.providerLatencyMs,
      retry_count: params.providerRetryCount,
    }),
    release: Object.freeze({
      decision: params.releaseDecision,
      reason_code: params.releaseReasonCode,
      response_sha256: params.responseSha256,
      response_utf8_bytes: params.responseUtf8Bytes,
      planted_value_exact_match: params.plantedValueExactMatch,
    }),
    permitted_task: Object.freeze({
      completed: params.permittedTaskCompleted,
      basis: params.permittedTaskBasis,
    }),
    chain: {
      event_count_in_run: runEvents.length,
      first_event_index: firstEventIndex,
      last_event_index: lastEventIndex,
      previous_receipt_chain_sha256: prevReceiptChainSha256,
      rollback_note:
        'tamper_evident_within_live_instance_only_not_rollback_resistant_without_external_checkpoint' as const,
    },
    timestamps: Object.freeze({
      started_at_iso: startedIso,
      completed_at_iso: completedIso,
      duration_ms: Math.max(0, params.completedAtMs - params.startedAtMs),
    }),
    mediated_boundaries: MEDIATED_BOUNDARIES,
    exclusions: RECEIPT_EXCLUSIONS,
    evidence_completeness: evidenceCompleteness,
  };

  const currentReceiptChainSha256 = computeReceiptChainSha256({
    previousReceiptChainSha256: prevReceiptChainSha256,
    receiptBodyWithoutChainHash: bodyWithoutCurrentHash,
    eventHashesInRun: eventHashes,
  });

  const fullReceipt: ContextReceipt = Object.freeze({
    ...bodyWithoutCurrentHash,
    chain: Object.freeze({
      ...bodyWithoutCurrentHash.chain,
      current_receipt_chain_sha256: currentReceiptChainSha256,
    }),
  });

  // Self-verify content-free invariant before persisting receipt
  const forbidden = getProtectedFixtureSubstrings([
    params.authorityAtAdmission.sessionId,
    ...(params.extraSecretsToRedactCheck ?? []),
  ]);
  const leakCheck = findProhibitedContentInObject(fullReceipt, forbidden);
  if (leakCheck !== null) {
    throw new Error(
      `Receipt content-hygiene violation at ${leakCheck.path}: ${leakCheck.reason}`,
    );
  }

  return params.ledger.recordReceipt(fullReceipt, eventHashes);
}
