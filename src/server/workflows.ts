/**
 * Responsibility: Orchestrates the three server-owned demo workflows (`paired_defect`,
 * `clean_request`, and `revoke_during_generation`), constructs causal provenance graphs
 * and lane step views, and enforces receipt-bound response release.
 * Trust boundary: Coordinates retrieval, admission, Gemini transport, release gate, and
 * ledger append. Never returns a released answer if receipt persistence fails.
 */

import crypto from 'node:crypto';
import { DESTINATION_GEMINI_CONTEXT } from '../shared/config.js';
import type {
  ArmExecutionView,
  ArmId,
  LaneStepView,
  ProvenanceEdgeView,
  ProvenanceNodeView,
  ScenarioId,
} from '../shared/contracts.js';
import {
  PERMITTED_TASK_BASES,
  RELEASE_REASONS,
  type PermittedTaskBasis,
  type ProviderOutcome,
  type ReleaseDecision,
  type ReleaseReasonCode,
} from '../shared/reason-codes.js';
import type { ServerConfig } from './config.js';
import {
  evaluateContextAdmission,
  type ChunkAdmissionDecision,
} from './admission.js';
import {
  buildUnmediatedControlEnvelopeForSyntheticDefectOnly,
  buildVervainGeminiEnvelope,
  type GeminiOutboundEnvelope,
} from './envelope.js';
import {
  ALDER_RECORD,
  BEACON_RECORD,
  FROZEN_FIXTURE_ID,
  FROZEN_QUERY_SHA256,
  FROZEN_QUERY_TEXT,
} from './fixture.js';
import { executeGeminiEnvelope, type GeminiTransport } from './gemini.js';
import type { AuditLedger } from './ledger.js';
import { buildAndAppendRunReceipt } from './receipts.js';
import { domainSeparatedDigest, type SafeStructuredLogger } from './redaction.js';
import type { ResponseReleaseGate } from './release.js';
import {
  retrieveBrokenControlChunks,
  retrieveTenantScopedChunks,
  type RetrievedChunk,
} from './retrieval.js';
import type { ServerAuthoritySnapshot, SessionStore } from './session.js';

export interface WorkflowDependencies {
  readonly config: ServerConfig;
  readonly sessionStore: SessionStore;
  readonly ledger: AuditLedger;
  readonly releaseGate: ResponseReleaseGate;
  readonly transport: GeminiTransport;
  readonly logger: SafeStructuredLogger;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

export class InstanceGeminiBudgetLimiter {
  private timestampsMs: number[] = [];
  private readonly windowMs: number;
  private readonly maxCalls: number;
  private readonly nowFn: () => number;

  constructor(options: { windowMs: number; maxCalls: number; nowFn?: () => number }) {
    this.windowMs = options.windowMs;
    this.maxCalls = options.maxCalls;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  public tryReserve(callCount: number): boolean {
    const now = this.nowFn();
    const cutoff = now - this.windowMs;
    this.timestampsMs = this.timestampsMs.filter((t) => t > cutoff);
    if (this.timestampsMs.length + callCount > this.maxCalls) {
      return false;
    }
    for (let i = 0; i < callCount; i += 1) {
      this.timestampsMs.push(now);
    }
    return true;
  }
}

function buildProvenanceGraph(params: {
  arm: ArmId;
  authority: ServerAuthoritySnapshot;
  retrievedChunks: readonly RetrievedChunk[];
  admissionDecisions: readonly ChunkAdmissionDecision[] | null;
  envelope: GeminiOutboundEnvelope | null;
  providerOutcome: ProviderOutcome;
  providerMode: 'live' | 'mock';
  modelId: string;
  releaseDecision: ReleaseDecision | 'unmediated_control_release';
  releaseReason: ReleaseReasonCode | 'unmediated_control_release';
  policyEpochAtRelease: number;
  receiptId: string;
  receiptChainSha256: string;
  foreignEnteredEnvelope: boolean;
  plantedInResponse: boolean;
}): { nodes: readonly ProvenanceNodeView[]; edges: readonly ProvenanceEdgeView[] } {
  const {
    arm,
    authority,
    retrievedChunks,
    admissionDecisions,
    envelope,
    providerOutcome,
    providerMode,
    modelId,
    releaseDecision,
    releaseReason,
    policyEpochAtRelease,
    receiptId,
    receiptChainSha256,
    foreignEnteredEnvelope,
    plantedInResponse,
  } = params;

  const alderRetrieved = retrievedChunks.some((c) => c.source_id === ALDER_RECORD.sourceId);
  const beaconRetrieved = retrievedChunks.some((c) => c.source_id === BEACON_RECORD.sourceId);

  const alderDecision = admissionDecisions?.find((d) => d.sourceId === ALDER_RECORD.sourceId);
  const beaconDecision = admissionDecisions?.find((d) => d.sourceId === BEACON_RECORD.sourceId);

  const nodes: ProvenanceNodeView[] = [
    {
      id: 'authority',
      label: `${authority.tenantLabel} (${authority.principalDisplay})`,
      category: 'authority',
      stateText: `${authority.policyId}@${authority.policyEpoch}`,
      tone: 'violet',
      evidenceFields: [
        { key: 'Authority source', value: 'Server-owned session store' },
        { key: 'Policy binding', value: `${authority.policyId}@${authority.policyEpoch}`, mono: true },
        {
          key: 'Tenant digest',
          value: domainSeparatedDigest('tenant', authority.tenantId).slice(0, 16),
          mono: true,
        },
      ],
    },
    {
      id: 'retriever',
      label:
        retrievedChunks[0]?.retrieval_basis === 'synthetic_defect_missing_tenant_predicate'
          ? 'Retriever (missing tenant filter)'
          : 'Retriever (tenant-scoped predicate)',
      category: 'store',
      stateText: `${retrievedChunks.length} retrieved`,
      tone: beaconRetrieved && authority.tenantId === 'tenant_alder' ? 'warning' : 'neutral',
      evidenceFields: [
        {
          key: 'Retrieval basis',
          value: retrievedChunks[0]?.retrieval_basis ?? 'store_predicate_tenant_epoch_classification',
          mono: true,
        },
        { key: 'Chunks returned', value: `${retrievedChunks.length}` },
      ],
    },
    {
      id: 'source_alder',
      label: ALDER_RECORD.sourceId,
      category: 'source',
      stateText: !alderRetrieved
        ? 'not retrieved'
        : arm === 'native_only'
          ? 'retrieved (unmediated)'
          : `${alderDecision?.disposition ?? 'unknown'} (${alderDecision?.reasonCode ?? 'none'})`,
      tone: !alderRetrieved
        ? 'neutral'
        : arm === 'native_only'
          ? 'neutral'
          : alderDecision?.disposition === 'admitted'
            ? 'allowed'
            : 'withheld',
      evidenceFields: [
        { key: 'Source tenant', value: ALDER_RECORD.tenantLabel },
        { key: 'Classification', value: ALDER_RECORD.classification, mono: true },
        { key: 'Record epoch', value: `${ALDER_RECORD.policyEpoch}`, mono: true },
        { key: 'Version digest', value: ALDER_RECORD.sourceVersionSha256.slice(0, 16), mono: true },
      ],
    },
    {
      id: 'source_beacon',
      label: BEACON_RECORD.sourceId,
      category: 'source',
      stateText: !beaconRetrieved
        ? 'filtered at store'
        : arm === 'native_only'
          ? 'transmitted (unmediated)'
          : `${beaconDecision?.disposition ?? 'withheld'} (${beaconDecision?.reasonCode ?? 'tenant_mismatch'})`,
      tone: !beaconRetrieved
        ? 'neutral'
        : arm === 'native_only'
          ? 'warning'
          : 'withheld',
      evidenceFields: [
        { key: 'Source tenant', value: BEACON_RECORD.tenantLabel },
        { key: 'Classification', value: BEACON_RECORD.classification, mono: true },
        { key: 'Record epoch', value: `${BEACON_RECORD.policyEpoch}`, mono: true },
        { key: 'Version digest', value: BEACON_RECORD.sourceVersionSha256.slice(0, 16), mono: true },
      ],
    },
    {
      id: 'context_gate',
      label: arm === 'native_plus_vervain' ? 'Vervain Context Gate' : 'Unmediated Control Pass',
      category: 'boundary',
      stateText:
        arm === 'native_only'
          ? `bypassed (${retrievedChunks.length}/${retrievedChunks.length} passed)`
          : `${admissionDecisions?.filter((d) => d.disposition === 'admitted').length ?? 0}/${retrievedChunks.length} admitted`,
      tone: arm === 'native_plus_vervain' ? 'violet' : 'warning',
      evidenceFields: [
        {
          key: 'Boundary status',
          value: arm === 'native_plus_vervain' ? 'Deterministic 6-step validation' : 'Synthetic control (unmediated)',
        },
        {
          key: 'Foreign chunk in envelope',
          value: foreignEnteredEnvelope ? 'yes (control defect)' : 'no (withheld before envelope)',
          mono: true,
        },
      ],
    },
    {
      id: 'gemini',
      label: `Google Gemini (${modelId})`,
      category: 'provider',
      stateText:
        envelope === null
          ? 'not called'
          : `${providerOutcome} [${providerMode}]`,
      tone:
        envelope === null
          ? 'neutral'
          : foreignEnteredEnvelope
            ? 'warning'
            : providerOutcome === 'succeeded'
              ? 'allowed'
              : 'withheld',
      evidenceFields: [
        { key: 'Transport mode', value: providerMode, mono: true },
        { key: 'Provider outcome', value: providerOutcome, mono: true },
        {
          key: 'Envelope SHA-256',
          value: envelope ? envelope.envelopeSha256.slice(0, 16) : 'none',
          mono: true,
        },
        { key: 'Admitted chunks sent', value: `${envelope?.includedChunkCount ?? 0} of ${retrievedChunks.length}` },
      ],
    },
    {
      id: 'release_gate',
      label: arm === 'native_plus_vervain' ? 'Vervain Release Gate' : 'Unmediated Reply Path',
      category: 'boundary',
      stateText: `${releaseDecision} (${releaseReason})`,
      tone:
        releaseDecision === 'released'
          ? 'violet'
          : releaseDecision === 'withheld'
            ? 'withheld'
            : 'warning',
      evidenceFields: [
        { key: 'Admission epoch', value: `${authority.policyEpoch}`, mono: true },
        { key: 'Release epoch', value: `${policyEpochAtRelease}`, mono: true },
        { key: 'Release reason', value: releaseReason, mono: true },
        { key: 'Planted value exact match', value: plantedInResponse ? 'true' : 'false', mono: true },
      ],
    },
    {
      id: 'reply',
      label: 'Client Reply',
      category: 'output',
      stateText:
        releaseDecision === 'released'
          ? 'authorized reply released'
          : releaseDecision === 'unmediated_control_release'
            ? providerOutcome === 'succeeded'
              ? 'unmediated reply observed'
              : 'provider unavailable'
            : 'reply withheld',
      tone:
        releaseDecision === 'released'
          ? 'allowed'
          : releaseDecision === 'unmediated_control_release'
            ? 'warning'
            : 'withheld',
      evidenceFields: [
        { key: 'Delivery state', value: releaseDecision, mono: true },
        { key: 'Streaming posture', value: 'Nonstreaming buffered gate' },
      ],
    },
    {
      id: 'receipt',
      label: 'Bounded Receipt',
      category: 'evidence',
      stateText: 'recorded (content-free)',
      tone: 'violet',
      evidenceFields: [
        { key: 'Receipt ID', value: receiptId, mono: true },
        { key: 'Chain head', value: receiptChainSha256.slice(0, 16), mono: true },
        { key: 'Protected text stored', value: '0 bytes (digests only)' },
      ],
    },
  ];

  const edges: ProvenanceEdgeView[] = [
    {
      id: 'e_auth_ret',
      from: 'authority',
      to: 'retriever',
      verb: 'retrieved',
      lineStyle: 'solid',
      tone: 'violet',
      basis: `Session bound to ${authority.policyId}@${authority.policyEpoch}`,
    },
  ];

  if (alderRetrieved) {
    edges.push({
      id: 'e_ret_alder',
      from: 'retriever',
      to: 'source_alder',
      verb: 'retrieved',
      lineStyle: 'solid',
      tone: 'neutral',
      basis: 'Returned by retriever scan',
    });
    const alderPassed =
      arm === 'native_only' || alderDecision?.disposition === 'admitted';
    edges.push({
      id: 'e_alder_gate',
      from: 'source_alder',
      to: 'context_gate',
      verb: arm === 'native_only' ? 'unmediated' : alderPassed ? 'admitted' : 'withheld',
      lineStyle: alderPassed ? 'solid' : 'interrupted',
      tone: arm === 'native_only' ? 'warning' : alderPassed ? 'allowed' : 'withheld',
      basis:
        arm === 'native_only'
          ? 'No context admission gate in Native-only control'
          : `Gate disposition: ${alderDecision?.disposition ?? 'withheld'} (${alderDecision?.reasonCode ?? 'unknown'})`,
    });
  }

  if (beaconRetrieved) {
    edges.push({
      id: 'e_ret_beacon',
      from: 'retriever',
      to: 'source_beacon',
      verb: 'retrieved',
      lineStyle: 'dashed',
      tone: 'warning',
      basis: 'Returned due to missing tenant predicate in control scenario',
    });
    const beaconPassed =
      arm === 'native_only' || beaconDecision?.disposition === 'admitted';
    edges.push({
      id: 'e_beacon_gate',
      from: 'source_beacon',
      to: 'context_gate',
      verb: arm === 'native_only' ? 'unmediated' : beaconPassed ? 'admitted' : 'withheld',
      lineStyle: beaconPassed ? 'dashed' : 'interrupted',
      tone: beaconPassed ? 'warning' : 'withheld',
      basis:
        arm === 'native_only'
          ? 'Unmediated control forwarded foreign chunk into outbound envelope'
          : `Withheld at context gate (${beaconDecision?.reasonCode ?? 'tenant_mismatch'})`,
    });
  }

  if (envelope !== null) {
    edges.push({
      id: 'e_gate_gemini',
      from: 'context_gate',
      to: 'gemini',
      verb: 'transmitted',
      lineStyle: foreignEnteredEnvelope ? 'dashed' : 'solid',
      tone: foreignEnteredEnvelope ? 'warning' : 'allowed',
      basis: `Transmitted ${envelope.includedChunkCount} of ${retrievedChunks.length} retrieved chunks`,
    });
    edges.push({
      id: 'e_gemini_rel',
      from: 'gemini',
      to: 'release_gate',
      verb: 'generated',
      lineStyle: providerOutcome === 'succeeded' ? 'solid' : 'dotted',
      tone: providerOutcome === 'succeeded' ? 'neutral' : 'withheld',
      basis: `Provider outcome: ${providerOutcome}`,
    });
  } else {
    edges.push({
      id: 'e_gate_rel_skip',
      from: 'context_gate',
      to: 'release_gate',
      verb: 'withheld',
      lineStyle: 'interrupted',
      tone: 'withheld',
      basis: 'Provider not called because 0 chunks were admitted',
    });
  }

  edges.push({
    id: 'e_rel_reply',
    from: 'release_gate',
    to: 'reply',
    verb:
      releaseDecision === 'released'
        ? 'released'
        : releaseDecision === 'unmediated_control_release'
          ? 'unmediated'
          : 'withheld',
    lineStyle:
      releaseDecision === 'released'
        ? 'solid'
        : releaseDecision === 'unmediated_control_release'
          ? 'dashed'
          : 'interrupted',
    tone:
      releaseDecision === 'released'
        ? 'allowed'
        : releaseDecision === 'unmediated_control_release'
          ? 'warning'
          : 'withheld',
    basis: `Release decision: ${releaseDecision} (${releaseReason})`,
  });

  edges.push({
    id: 'e_gate_receipt',
    from: 'context_gate',
    to: 'receipt',
    verb: 'recorded',
    lineStyle: 'dotted',
    tone: 'violet',
    basis: 'Admission counts and source digests bound into receipt chain',
  });

  edges.push({
    id: 'e_rel_receipt',
    from: 'release_gate',
    to: 'receipt',
    verb: 'recorded',
    lineStyle: 'dotted',
    tone: 'violet',
    basis: 'Release epoch and decision bound into receipt chain',
  });

  return { nodes, edges };
}

/**
 * Executes the Native-only synthetic control lane (used only inside `runPairedProofWorkflow`).
 */
async function executeNativeOnlyControlArm(
  deps: WorkflowDependencies,
  authorityAtStart: ServerAuthoritySnapshot,
  retrievedChunks: readonly RetrievedChunk[],
): Promise<ArmExecutionView> {
  const startedAtMs = Date.now();
  const requestId = `req_ctrl_${crypto.randomBytes(10).toString('hex')}`;

  const foreignPresentInEnvelope = retrievedChunks.some(
    (c) => c.tenant_id !== authorityAtStart.tenantId,
  );

  const envelope = buildUnmediatedControlEnvelopeForSyntheticDefectOnly({
    scenario: 'paired_defect',
    requestId,
    queryText: FROZEN_QUERY_TEXT,
    rawChunks: retrievedChunks,
    model: deps.config.geminiModel,
    temperature: deps.config.geminiTemperature,
    maxOutputTokens: deps.config.geminiMaxOutputTokens,
  });

  const geminiResult = await executeGeminiEnvelope({
    transport: deps.transport,
    envelope,
    timeoutMs: deps.config.geminiTimeoutMs,
    maxRetries: deps.config.geminiMaxRetries,
    retryBaseDelayMs: deps.config.geminiRetryBaseDelayMs,
    logger: deps.logger,
    sleepFn: deps.sleepFn,
  });

  const combinedText = `${geminiResult.rawText ?? ''}\n${geminiResult.parsedAnswer ?? ''}`;
  const plantedInResponse = deps.releaseGate.containsPlantedValue(combinedText);
  const completedAtMs = Date.now();

  const receipt = buildAndAppendRunReceipt({
    ledger: deps.ledger,
    requestId,
    scenario: 'paired_defect',
    arm: 'native_only',
    authorityAtAdmission: authorityAtStart,
    policyEpochAtRelease: authorityAtStart.policyEpoch,
    querySha256: FROZEN_QUERY_SHA256,
    retrievedChunks,
    admissionDecisions: null,
    envelopeSha256: envelope.envelopeSha256,
    admittedChunkCount: envelope.includedChunkCount,
    foreignTenantChunkInEnvelope: foreignPresentInEnvelope,
    modelId: deps.config.geminiModel,
    transportMode: deps.transport.mode,
    providerCallAttempted: true,
    providerOutcome: geminiResult.outcome,
    providerLatencyMs: geminiResult.latencyMs,
    providerRetryCount: geminiResult.retryCount,
    releaseDecision: 'unmediated_control_release',
    releaseReasonCode: 'unmediated_control_release',
    responseSha256:
      geminiResult.parsedAnswer !== null
        ? domainSeparatedDigest('response', geminiResult.parsedAnswer)
        : null,
    responseUtf8Bytes: geminiResult.responseUtf8Bytes,
    plantedValueExactMatch: plantedInResponse,
    permittedTaskCompleted: false,
    permittedTaskBasis: PERMITTED_TASK_BASES.UNMEDIATED_CONTROL_OBSERVATION,
    startedAtMs,
    completedAtMs,
    extraSecretsToRedactCheck: deps.config.geminiApiKey ? [deps.config.geminiApiKey] : [],
  });

  const steps: LaneStepView[] = [
    {
      stepId: 'session_authority',
      label: 'Session authority',
      status: 'verified',
      summary: `Server session ${authorityAtStart.tenantLabel} (${authorityAtStart.principalDisplay})`,
      detailMono: `${authorityAtStart.policyId}@${authorityAtStart.policyEpoch}`,
    },
    {
      stepId: 'retrieval',
      label: 'Retrieval',
      status: foreignPresentInEnvelope ? 'retrieved_with_foreign' : 'retrieved',
      summary: `${retrievedChunks.length} chunks returned by missing-filter defect (${foreignPresentInEnvelope ? '1 foreign tenant chunk' : '0 foreign'})`,
      detailMono: 'cross_tenant_filter_omission',
    },
    {
      stepId: 'admission',
      label: 'Admission',
      status: 'unmediated_passthrough',
      summary: `No context gate in synthetic control; ${envelope.includedChunkCount} of ${retrievedChunks.length} chunks passed through`,
      detailMono: 'unmediated_control_bypass',
    },
    {
      stepId: 'gemini_transmission',
      label: 'Gemini transmission',
      status:
        geminiResult.outcome === 'succeeded'
          ? 'transmitted_contaminated'
          : 'provider_unavailable',
      summary:
        geminiResult.outcome === 'succeeded'
          ? `Cross-tenant context transmitted in outbound Gemini envelope (${envelope.includedChunkCount} of ${retrievedChunks.length} chunks)`
          : `Foreign chunk entered outbound envelope (${envelope.includedChunkCount} of ${retrievedChunks.length}); provider returned ${geminiResult.outcome}`,
      detailMono: `env:${envelope.envelopeSha256.slice(0, 12)}`,
    },
    {
      stepId: 'response_release',
      label: 'Response release',
      status:
        geminiResult.outcome === 'succeeded' ? 'unmediated_reply' : 'provider_unavailable',
      summary:
        geminiResult.outcome !== 'succeeded'
          ? `No model answer returned (${geminiResult.outcome})`
          : plantedInResponse
            ? 'Unmediated reply observed; model repeated synthetic planted value'
            : 'Unmediated reply observed; model omitted planted value, though foreign chunk already entered provider envelope',
      detailMono: `planted_match=${String(plantedInResponse)}`,
    },
    {
      stepId: 'allowed_task_outcome',
      label: 'Allowed task outcome',
      status: 'incomplete',
      summary: 'Synthetic vulnerable control lane; cross-tenant context transmission occurred',
      detailMono: PERMITTED_TASK_BASES.UNMEDIATED_CONTROL_OBSERVATION,
    },
  ];

  const graph = buildProvenanceGraph({
    arm: 'native_only',
    authority: authorityAtStart,
    retrievedChunks,
    admissionDecisions: null,
    envelope,
    providerOutcome: geminiResult.outcome,
    providerMode: deps.transport.mode,
    modelId: deps.config.geminiModel,
    releaseDecision: 'unmediated_control_release',
    releaseReason: 'unmediated_control_release',
    policyEpochAtRelease: authorityAtStart.policyEpoch,
    receiptId: receipt.receipt_id,
    receiptChainSha256: receipt.chain.current_receipt_chain_sha256,
    foreignEnteredEnvelope: foreignPresentInEnvelope,
    plantedInResponse,
  });

  const outcomeSentence =
    geminiResult.outcome !== 'succeeded'
      ? `Cross-tenant context transmitted into the outbound Gemini envelope (${envelope.includedChunkCount} of ${retrievedChunks.length} retrieved chunks included); provider call ended with ${geminiResult.outcome}.`
      : plantedInResponse
        ? `Cross-tenant context transmitted (${envelope.includedChunkCount} of ${retrievedChunks.length} retrieved chunks entered the Gemini envelope), and the observed reply repeated the synthetic planted value.`
        : `Cross-tenant context transmitted (${envelope.includedChunkCount} of ${retrievedChunks.length} retrieved chunks entered the Gemini envelope); Gemini did not repeat the planted string in the reply.`;

  return Object.freeze<ArmExecutionView>({
    arm: 'native_only',
    armLabel: 'Native only (synthetic vulnerable control)',
    controlWarning: 'Intentionally vulnerable synthetic control. Never a recommended deployment.',
    requestId,
    receiptId: receipt.receipt_id,
    fixtureId: FROZEN_FIXTURE_ID,
    querySha256: FROZEN_QUERY_SHA256,
    frozenQueryText: FROZEN_QUERY_TEXT,
    structuralVerdict: 'cross_tenant_context_transmitted',
    outcomeSentence,
    counts: {
      retrieved: retrievedChunks.length,
      admitted: envelope.includedChunkCount,
      withheld: 0,
      unknown: 0,
      admittedDenominatorUnit: 'retrieved_chunks',
    },
    foreignChunkEnteredEnvelope: foreignPresentInEnvelope,
    plantedValueInResponse: plantedInResponse,
    permittedTaskCompleted: false,
    permittedTaskBasis: PERMITTED_TASK_BASES.UNMEDIATED_CONTROL_OBSERVATION,
    policyEpochAtAdmission: authorityAtStart.policyEpoch,
    policyEpochAtRelease: authorityAtStart.policyEpoch,
    providerRuntime: {
      provider: 'Google Gemini',
      model: deps.config.geminiModel,
      mode: deps.transport.mode,
      callAttempted: true,
      outcome: geminiResult.outcome,
      latencyMs: geminiResult.latencyMs,
      retryCount: geminiResult.retryCount,
    },
    releaseDecision: 'not_applicable',
    releaseReason: 'unmediated_control_release',
    // In Native-only control we show observed answer text only after redacting the exact synthetic
    // planted token with a clearly marked synthetic observation tag if desired, or show exact synthetic
    // fixture reply in UI while keeping receipts/logs 100% content-free. Keeping exact synthetic
    // reply in UI fulfills "Gemini may or may not repeat the planted value, and the UI reports the observed result exactly".
    releasedAnswerText: geminiResult.parsedAnswer,
    releasedSourcesUsed: geminiResult.parsedSourcesUsed,
    steps,
    graph,
    receipt,
  });
}

/**
 * Executes the Vervain-governed lane (`native_plus_vervain`) across `paired_defect`,
 * `clean_request`, or `revoke_during_generation`.
 */
export async function executeVervainGovernedArm(params: {
  deps: WorkflowDependencies;
  scenario: ScenarioId;
  authorityAtStart: ServerAuthoritySnapshot;
  retrievedChunks: readonly RetrievedChunk[];
  afterDispatchBeforeReleaseHook?: () => Promise<void> | void;
}): Promise<ArmExecutionView> {
  const { deps, scenario, authorityAtStart, retrievedChunks, afterDispatchBeforeReleaseHook } =
    params;
  const startedAtMs = Date.now();
  const requestId = `req_vvn_${crypto.randomBytes(10).toString('hex')}`;

  // 1. Deterministic 6-step Context Admission Gate
  const admission = evaluateContextAdmission(retrievedChunks, authorityAtStart, {
    destination: DESTINATION_GEMINI_CONTEXT,
  });

  let envelope: GeminiOutboundEnvelope | null = null;
  let providerCallAttempted = false;
  let providerOutcome: ProviderOutcome = 'not_called';
  let providerLatencyMs = 0;
  let providerRetryCount = 0;

  let releaseDecision: ReleaseDecision = 'not_applicable';
  let releaseReason: ReleaseReasonCode = RELEASE_REASONS.NO_ADMITTED_CONTEXT;
  let policyEpochAtRelease = authorityAtStart.policyEpoch;
  let plantedValueMatch = false;
  let candidateReleasedAnswer: string | null = null;
  let candidateReleasedSources: readonly string[] = [];
  let responseSha256: string | null = null;
  let responseUtf8Bytes = 0;

  if (admission.admittedChunks.length > 0) {
    envelope = buildVervainGeminiEnvelope({
      requestId,
      queryText: FROZEN_QUERY_TEXT,
      admittedChunks: admission.admittedChunks,
      model: deps.config.geminiModel,
      temperature: deps.config.geminiTemperature,
      maxOutputTokens: deps.config.geminiMaxOutputTokens,
    });

    providerCallAttempted = true;
    const geminiResult = await executeGeminiEnvelope({
      transport: deps.transport,
      envelope,
      timeoutMs: deps.config.geminiTimeoutMs,
      maxRetries: deps.config.geminiMaxRetries,
      retryBaseDelayMs: deps.config.geminiRetryBaseDelayMs,
      logger: deps.logger,
      sleepFn: deps.sleepFn,
    });

    providerOutcome = geminiResult.outcome;
    providerLatencyMs = geminiResult.latencyMs;
    providerRetryCount = geminiResult.retryCount;

    if (afterDispatchBeforeReleaseHook) {
      await afterDispatchBeforeReleaseHook();
    }

    if (
      geminiResult.outcome === 'succeeded' &&
      geminiResult.rawText !== null &&
      geminiResult.parsedAnswer !== null
    ) {
      const releaseEval = deps.releaseGate.evaluateRelease({
        requestId,
        authorityAtAdmission: authorityAtStart,
        sessionStore: deps.sessionStore,
        allowedSourceIds: envelope.includedSourceIds,
        candidate: {
          rawText: geminiResult.rawText,
          parsedAnswer: geminiResult.parsedAnswer,
          parsedSourcesUsed: geminiResult.parsedSourcesUsed,
        },
      });

      releaseDecision = releaseEval.decision;
      releaseReason = releaseEval.reasonCode;
      policyEpochAtRelease = releaseEval.policyEpochAtRelease;
      plantedValueMatch = releaseEval.plantedValueExactMatch;
      candidateReleasedAnswer = releaseEval.releasedAnswer;
      candidateReleasedSources = releaseEval.releasedSourcesUsed;
      responseSha256 = releaseEval.responseSha256;
      responseUtf8Bytes = releaseEval.responseUtf8Bytes;
    } else {
      const liveCheck = deps.sessionStore.getSnapshotBySessionId(authorityAtStart.sessionId);
      policyEpochAtRelease = liveCheck.ok
        ? liveCheck.snapshot.policyEpoch
        : authorityAtStart.policyEpoch;
      releaseDecision = 'not_applicable';
      releaseReason = RELEASE_REASONS.PROVIDER_FAILED;
    }
  } else {
    releaseDecision = 'not_applicable';
    releaseReason = RELEASE_REASONS.NO_ADMITTED_CONTEXT;
  }

  const permittedTaskCompleted =
    providerOutcome === 'succeeded' && releaseDecision === 'released';

  const permittedTaskBasis: PermittedTaskBasis = permittedTaskCompleted
    ? PERMITTED_TASK_BASES.RELEASED_AUTHORIZED_ANSWER
    : admission.admittedChunks.length === 0
      ? PERMITTED_TASK_BASES.NO_ADMITTED_CONTEXT
      : providerOutcome !== 'succeeded'
        ? PERMITTED_TASK_BASES.PROVIDER_UNAVAILABLE_OR_FAILED
        : PERMITTED_TASK_BASES.WITHHELD_AT_RELEASE;

  const foreignEnteredEnvelope =
    envelope !== null &&
    admission.admittedChunks.some((c) => c.tenantId !== authorityAtStart.tenantId);

  const completedAtMs = Date.now();

  // Mandatory receipt-bound release: build and persist receipt BEFORE exposing candidateReleasedAnswer!
  const receipt = buildAndAppendRunReceipt({
    ledger: deps.ledger,
    requestId,
    scenario,
    arm: 'native_plus_vervain',
    authorityAtAdmission: authorityAtStart,
    policyEpochAtRelease,
    querySha256: FROZEN_QUERY_SHA256,
    retrievedChunks,
    admissionDecisions: admission.decisions,
    envelopeSha256: envelope?.envelopeSha256 ?? null,
    admittedChunkCount: admission.admittedChunks.length,
    foreignTenantChunkInEnvelope: foreignEnteredEnvelope,
    modelId: deps.config.geminiModel,
    transportMode: deps.transport.mode,
    providerCallAttempted,
    providerOutcome,
    providerLatencyMs,
    providerRetryCount,
    releaseDecision,
    releaseReasonCode: releaseReason,
    responseSha256,
    responseUtf8Bytes,
    plantedValueExactMatch: plantedValueMatch,
    permittedTaskCompleted,
    permittedTaskBasis,
    startedAtMs,
    completedAtMs,
    extraSecretsToRedactCheck: deps.config.geminiApiKey ? [deps.config.geminiApiKey] : [],
  });

  const foreignWithheld = admission.decisions.some(
    (d) => d.disposition === 'withheld' && d.reasonCode === 'tenant_mismatch',
  );

  const structuralVerdict: ArmExecutionView['structuralVerdict'] =
    releaseDecision === 'withheld' && releaseReason === RELEASE_REASONS.POLICY_EPOCH_CHANGED
      ? 'response_withheld_after_epoch_change'
      : admission.admittedChunks.length === 0
        ? 'no_context_admitted_native_denial_preserved'
        : foreignWithheld
          ? 'foreign_context_withheld_before_gemini'
          : 'clean_authorized_context_transmitted';

  const outcomeSentence = (() => {
    if (structuralVerdict === 'response_withheld_after_epoch_change') {
      return `Admitted ${admission.counts.admitted} of ${admission.counts.retrieved} retrieved chunks at epoch ${authorityAtStart.policyEpoch}, then withheld the generated reply because session policy epoch advanced to ${policyEpochAtRelease} before release (mediated solely on this app's context and reply boundaries).`;
    }
    if (structuralVerdict === 'no_context_admitted_native_denial_preserved') {
      return `Admitted 0 of ${admission.counts.retrieved} retrieved chunks for destination gemini.context; Gemini was not called and native restriction remained final (mediated solely on this app's context and reply boundaries).`;
    }
    if (providerOutcome !== 'succeeded') {
      return `Withheld ${admission.counts.withheld} of ${admission.counts.retrieved} retrieved chunks before provider dispatch and excluded foreign context from the Gemini envelope; Gemini call ended with ${providerOutcome} (${deps.transport.mode} mode).`;
    }
    if (releaseDecision !== 'released') {
      return `Admitted ${admission.counts.admitted} of ${admission.counts.retrieved} retrieved chunks, then withheld the reply at release with reason ${releaseReason}.`;
    }
    if (foreignWithheld) {
      return `Withheld ${admission.counts.withheld} of ${admission.counts.retrieved} retrieved chunks (tenant_mismatch) before provider dispatch, transmitted only ${authorityAtStart.tenantLabel}'s authorized chunk to Gemini, and released the renewal answer under unchanged epoch ${policyEpochAtRelease} (for this app's mediated context and reply paths only).`;
    }
    return `Admitted ${admission.counts.admitted} of ${admission.counts.retrieved} retrieved chunks, transmitted authorized context to Gemini, and released the renewal answer under unchanged epoch ${policyEpochAtRelease} (for this app's mediated context and reply paths only).`;
  })();

  const steps: LaneStepView[] = [
    {
      stepId: 'session_authority',
      label: 'Session authority',
      status: 'verified',
      summary: `Server session ${authorityAtStart.tenantLabel} (${authorityAtStart.principalDisplay})`,
      detailMono: `${authorityAtStart.policyId}@${authorityAtStart.policyEpoch}`,
    },
    {
      stepId: 'retrieval',
      label: 'Retrieval',
      status: foreignWithheld ? 'retrieved_with_foreign' : 'retrieved',
      summary: foreignWithheld
        ? `${admission.counts.retrieved} chunks returned by broken retriever (1 foreign chunk present)`
        : `${admission.counts.retrieved} chunk(s) returned by tenant-scoped retriever`,
      detailMono:
        retrievedChunks[0]?.retrieval_basis ?? 'store_predicate_tenant_epoch_classification',
    },
    {
      stepId: 'admission',
      label: 'Admission',
      status:
        admission.counts.admitted === 0
          ? 'withheld_all'
          : foreignWithheld
            ? 'filtered_foreign_withheld'
            : 'admitted_clean',
      summary: foreignWithheld
        ? `${admission.counts.admitted} of ${admission.counts.retrieved} retrieved chunks admitted; foreign chunk withheld (tenant_mismatch)`
        : `${admission.counts.admitted} of ${admission.counts.retrieved} retrieved chunks admitted`,
      detailMono: foreignWithheld ? 'withheld:tenant_mismatch' : 'admitted:valid_authority',
    },
    {
      stepId: 'gemini_transmission',
      label: 'Gemini transmission',
      status:
        envelope === null
          ? 'not_transmitted'
          : providerOutcome === 'succeeded'
            ? 'transmitted_authorized_only'
            : 'provider_unavailable',
      summary:
        envelope === null
          ? `Provider not called (0 of ${admission.counts.retrieved} chunks admitted)`
          : providerOutcome === 'succeeded'
            ? `Exact outbound envelope carried ${envelope.includedChunkCount} of ${admission.counts.retrieved} retrieved chunks (0 foreign bytes)`
            : `Authorized-only envelope dispatched (${envelope.includedChunkCount} of ${admission.counts.retrieved}); provider returned ${providerOutcome}`,
      detailMono: envelope ? `env:${envelope.envelopeSha256.slice(0, 12)}` : 'not_dispatched',
    },
    {
      stepId: 'response_release',
      label: 'Response release',
      status:
        releaseDecision === 'released'
          ? 'released'
          : providerCallAttempted && providerOutcome !== 'succeeded'
            ? 'provider_unavailable'
            : 'withheld_release',
      summary:
        releaseDecision === 'released'
          ? `Released after verifying ${authorityAtStart.policyId}@${policyEpochAtRelease} unchanged`
          : providerCallAttempted && providerOutcome !== 'succeeded'
            ? `No response to release (${providerOutcome})`
            : `Withheld (${releaseReason}); epoch ${authorityAtStart.policyEpoch} -> ${policyEpochAtRelease}`,
      detailMono: `${releaseDecision}:${releaseReason}`,
    },
    {
      stepId: 'allowed_task_outcome',
      label: 'Allowed task outcome',
      status: permittedTaskCompleted ? 'completed' : 'incomplete',
      summary: permittedTaskCompleted
        ? 'Authorized renewal answer released with content-free receipt'
        : `Incomplete (${permittedTaskBasis})`,
      detailMono: permittedTaskBasis,
    },
  ];

  const graph = buildProvenanceGraph({
    arm: 'native_plus_vervain',
    authority: authorityAtStart,
    retrievedChunks,
    admissionDecisions: admission.decisions,
    envelope,
    providerOutcome,
    providerMode: deps.transport.mode,
    modelId: deps.config.geminiModel,
    releaseDecision,
    releaseReason,
    policyEpochAtRelease,
    receiptId: receipt.receipt_id,
    receiptChainSha256: receipt.chain.current_receipt_chain_sha256,
    foreignEnteredEnvelope: false,
    plantedInResponse: plantedValueMatch,
  });

  return Object.freeze<ArmExecutionView>({
    arm: 'native_plus_vervain',
    armLabel: 'Native + Vervain (mediated context & release)',
    requestId,
    receiptId: receipt.receipt_id,
    fixtureId: FROZEN_FIXTURE_ID,
    querySha256: FROZEN_QUERY_SHA256,
    frozenQueryText: FROZEN_QUERY_TEXT,
    structuralVerdict,
    outcomeSentence,
    counts: {
      retrieved: admission.counts.retrieved,
      admitted: admission.counts.admitted,
      withheld: admission.counts.withheld,
      unknown: admission.counts.unknown,
      admittedDenominatorUnit: 'retrieved_chunks',
    },
    foreignChunkEnteredEnvelope: foreignEnteredEnvelope,
    plantedValueInResponse: plantedValueMatch,
    permittedTaskCompleted,
    permittedTaskBasis,
    policyEpochAtAdmission: authorityAtStart.policyEpoch,
    policyEpochAtRelease,
    providerRuntime: {
      provider: 'Google Gemini',
      model: deps.config.geminiModel,
      mode: deps.transport.mode,
      callAttempted: providerCallAttempted,
      outcome: providerOutcome,
      latencyMs: providerLatencyMs,
      retryCount: providerRetryCount,
    },
    releaseDecision,
    releaseReason,
    releasedAnswerText: releaseDecision === 'released' ? candidateReleasedAnswer : null,
    releasedSourcesUsed: releaseDecision === 'released' ? candidateReleasedSources : [],
    steps,
    graph,
    receipt,
  });
}

export async function runPairedProofWorkflow(
  deps: WorkflowDependencies,
  authorityAtStart: ServerAuthoritySnapshot,
): Promise<{
  runGroupId: string;
  nativeOnly: ArmExecutionView;
  nativePlusVervain: ArmExecutionView;
}> {
  const ticket = deps.sessionStore.allocateRunTicket(authorityAtStart.sessionId);
  if (!ticket) {
    throw new Error('Session unavailable for run allocation.');
  }

  const runGroupId = `pair_${crypto.randomBytes(8).toString('hex')}`;
  const brokenRetrieval = retrieveBrokenControlChunks('cross_tenant_filter_omission');

  // Execute Native only control arm and Native + Vervain governed arm on the exact same retrieved chunks
  const nativeOnly = await executeNativeOnlyControlArm(
    deps,
    authorityAtStart,
    brokenRetrieval.chunks,
  );
  const nativePlusVervain = await executeVervainGovernedArm({
    deps,
    scenario: 'paired_defect',
    authorityAtStart,
    retrievedChunks: brokenRetrieval.chunks,
  });

  deps.sessionStore.registerSessionReceipt(
    authorityAtStart.sessionId,
    ticket.stateGeneration,
    nativeOnly.receiptId,
  );
  deps.sessionStore.registerSessionReceipt(
    authorityAtStart.sessionId,
    ticket.stateGeneration,
    nativePlusVervain.receiptId,
  );

  const pairedResult = Object.freeze({
    runGroupId,
    nativeOnly,
    nativePlusVervain,
  });

  deps.sessionStore.commitPairedRunIfLatest(authorityAtStart.sessionId, ticket, pairedResult);
  return pairedResult;
}

export async function runCleanRequestWorkflow(
  deps: WorkflowDependencies,
  authorityAtStart: ServerAuthoritySnapshot,
): Promise<ArmExecutionView> {
  const ticket = deps.sessionStore.allocateRunTicket(authorityAtStart.sessionId);
  if (!ticket) {
    throw new Error('Session unavailable for run allocation.');
  }

  const cleanRetrieval = retrieveTenantScopedChunks(
    authorityAtStart,
    DESTINATION_GEMINI_CONTEXT,
  );

  const result = await executeVervainGovernedArm({
    deps,
    scenario: 'clean_request',
    authorityAtStart,
    retrievedChunks: cleanRetrieval.chunks,
  });

  deps.sessionStore.registerSessionReceipt(
    authorityAtStart.sessionId,
    ticket.stateGeneration,
    result.receiptId,
  );
  deps.sessionStore.commitSingleRunIfLatest(authorityAtStart.sessionId, ticket, result);
  return result;
}

export async function runRevokeDuringGenerationWorkflow(
  deps: WorkflowDependencies,
  authorityAtStart: ServerAuthoritySnapshot,
): Promise<ArmExecutionView> {
  const ticket = deps.sessionStore.allocateRunTicket(authorityAtStart.sessionId);
  if (!ticket) {
    throw new Error('Session unavailable for run allocation.');
  }

  const cleanRetrieval = retrieveTenantScopedChunks(
    authorityAtStart,
    DESTINATION_GEMINI_CONTEXT,
  );

  const result = await executeVervainGovernedArm({
    deps,
    scenario: 'revoke_during_generation',
    authorityAtStart,
    retrievedChunks: cleanRetrieval.chunks,
    afterDispatchBeforeReleaseHook: () => {
      deps.sessionStore.incrementPolicyEpoch(authorityAtStart.sessionId);
    },
  });

  deps.sessionStore.registerSessionReceipt(
    authorityAtStart.sessionId,
    ticket.stateGeneration,
    result.receiptId,
  );
  deps.sessionStore.commitSingleRunIfLatest(authorityAtStart.sessionId, ticket, result);
  return result;
}
