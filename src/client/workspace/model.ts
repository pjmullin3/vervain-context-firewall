/**
 * Responsibility: Pure view model for the Vervain workspace. Maps one arm of a paired run
 * (plus the server-owned session and runtime status) to node labels, status marks, timeline
 * steps, and inspector fields. Every value shown comes from the API response.
 * Trust boundary: Presentation only; never derives or sends authority.
 */

import type {
  ArmExecutionView,
  ProvenanceNodeId,
  ReceiptSourceEntry,
  RuntimeStatusView,
  SafePersonaView,
} from '../../shared/contracts.js';
import type { WorkspaceNodeId } from './geometry.js';

export type Mark = 'idle' | 'ok' | 'stop' | 'flag' | 'open' | 'info';

export interface NodeView {
  readonly type: string;
  readonly label: string;
  readonly status: string;
  readonly mark: Mark;
  readonly foreign?: boolean;
}

export interface Field {
  readonly k: string;
  readonly v: string;
  readonly mono?: boolean;
}

export const STEPS = [
  { id: 'authority', label: 'Authority', node: 'session' },
  { id: 'retrieval', label: 'Retrieval', node: 'retriever' },
  { id: 'gate', label: 'Context gate', node: 'cube' },
  { id: 'gemini', label: 'Gemini request', node: 'gemini' },
  { id: 'release', label: 'Release check', node: 'release' },
  { id: 'receipt', label: 'Receipt', node: 'receipt' },
] as const satisfies ReadonlyArray<{ id: string; label: string; node: WorkspaceNodeId }>;

/** Animation progress boundaries: step i is complete once t >= STEP_ENDS[i]. */
export const STEP_ENDS = [0.12, 0.28, 0.52, 0.7, 0.86, 1] as const;

export const NODE_STEP: Record<WorkspaceNodeId, number> = {
  idp: 0,
  session: 0,
  retriever: 1,
  source_alder: 1,
  source_beacon: 1,
  cube: 2,
  gemini: 3,
  release: 4,
  reply: 4,
  receipt: 5,
};

const GRAPH_ID: Record<WorkspaceNodeId, ProvenanceNodeId> = {
  idp: 'authority',
  session: 'authority',
  retriever: 'retriever',
  source_alder: 'source_alder',
  source_beacon: 'source_beacon',
  cube: 'context_gate',
  gemini: 'gemini',
  release: 'release_gate',
  reply: 'reply',
  receipt: 'receipt',
};

export function modelDisplayName(modelId: string): string {
  return modelId
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

export function short(hash: string | null | undefined, n = 16): string {
  if (!hash) return 'none';
  return hash.length > n ? `${hash.slice(0, n)}…` : hash;
}

function findSource(arm: ArmExecutionView, tenantWord: string): ReceiptSourceEntry | undefined {
  return arm.receipt.sources.find((s) => s.chunk_id.toLowerCase().includes(tenantWord));
}

function reasonWords(code: string): string {
  return code.replace(/_/g, ' ');
}

export function isNativeOnly(arm: ArmExecutionView): boolean {
  return arm.arm === 'native_only';
}

export function geminiIn(arm: ArmExecutionView): number {
  return arm.receipt.outbound_envelope.admitted_chunk_count;
}

export function idleNodes(): Record<WorkspaceNodeId, NodeView> {
  return {
    idp: { type: 'Identity', label: 'Identity provider', status: 'Waiting for request', mark: 'idle' },
    session: { type: 'Session', label: 'Tenant Alder session', status: 'Server-owned', mark: 'idle' },
    retriever: { type: 'Retriever', label: 'Retriever', status: 'Missing tenant filter', mark: 'flag' },
    source_alder: { type: 'Source · Alder', label: 'Alder renewal playbook', status: 'Not retrieved yet', mark: 'idle' },
    source_beacon: {
      type: 'Source · foreign',
      label: 'Beacon strategy note',
      status: 'Not retrieved yet',
      mark: 'idle',
      foreign: true,
    },
    cube: { type: 'Boundary', label: 'VERVAIN', status: 'Context gate', mark: 'idle' },
    gemini: { type: 'Model', label: 'Gemini 4 Carbon request', status: 'No request sent', mark: 'idle' },
    release: { type: 'Gate', label: 'Release check (epoch)', status: 'Waiting', mark: 'idle' },
    reply: { type: 'Output', label: 'Reply to Alder', status: 'Waiting', mark: 'idle' },
    receipt: { type: 'Evidence', label: 'Receipt', status: 'Hash-chained, content-free', mark: 'idle' },
  };
}

export function armNodes(
  arm: ArmExecutionView,
  session: SafePersonaView,
): Record<WorkspaceNodeId, NodeView> {
  const native = isNativeOnly(arm);
  const sent = geminiIn(arm);
  const denom = arm.receipt.outbound_envelope.admitted_chunk_denominator_retrieved;
  const beacon = findSource(arm, 'beacon');
  const alder = findSource(arm, 'alder');
  const outcome = arm.providerRuntime.outcome;
  const base = idleNodes();

  const replyStatus = (): Pick<NodeView, 'status' | 'mark'> => {
    if (native) {
      if (outcome === 'invalid_response') {
        return { status: 'No usable reply: model output rejected by schema', mark: 'flag' };
      }
      return {
        status: arm.plantedValueInResponse
          ? 'Unmediated · carries Beacon marker'
          : `Reply status: ${outcome}`,
        mark: arm.plantedValueInResponse ? 'flag' : 'info',
      };
    }
    if (arm.releaseDecision === 'released') return { status: 'Answer released to Alder', mark: 'ok' };
    if (arm.releaseDecision === 'withheld') {
      return { status: `Withheld: ${reasonWords(arm.releaseReason)}`, mark: 'stop' };
    }
    return { status: `Provider ${outcome}`, mark: 'info' };
  };

  const epochA = arm.policyEpochAtAdmission;
  const epochR = arm.policyEpochAtRelease;

  return {
    idp: { ...base.idp, status: 'Synthetic fixture · verified', mark: 'ok' },
    session: {
      ...base.session,
      status: `${session.policyId}@${epochA} · verified`,
      mark: 'ok',
    },
    retriever: {
      ...base.retriever,
      status: beacon
        ? `No tenant filter · ${arm.counts.retrieved} returned`
        : `${arm.counts.retrieved} returned · no foreign chunk`,
      mark: beacon ? 'flag' : 'ok',
    },
    source_alder: {
      ...base.source_alder,
      status: native
        ? 'Sent unmediated'
        : alder?.disposition === 'admitted'
          ? 'Admitted: same tenant'
          : `Withheld: ${reasonWords(alder?.reason_code ?? 'unknown')}`,
      mark: native ? 'open' : alder?.disposition === 'admitted' ? 'ok' : 'stop',
    },
    source_beacon: !beacon
      ? { ...base.source_beacon, status: 'Not retrieved in this run', mark: 'idle' }
      : {
      ...base.source_beacon,
      status: native
        ? 'Entered the Gemini request'
        : beacon?.disposition === 'withheld'
          ? `Withheld: ${reasonWords(beacon.reason_code)}`
          : `Disposition: ${beacon?.disposition ?? 'unknown'}`,
      mark: native ? 'flag' : beacon?.disposition === 'withheld' ? 'stop' : 'flag',
    },
    cube: native
      ? { ...base.cube, status: 'OFF · not in the path', mark: 'open' }
      : { ...base.cube, status: `${arm.counts.admitted} of ${arm.counts.retrieved} admitted`, mark: 'ok' },
    gemini: {
      ...base.gemini,
      label: `${modelDisplayName(arm.providerRuntime.model)} request`,
      status: arm.foreignChunkEnteredEnvelope
        ? `${sent} of ${denom} chunks · Beacon included`
        : `Alder only · ${sent} of ${denom} chunks`,
      mark: arm.foreignChunkEnteredEnvelope ? 'flag' : 'ok',
    },
    release: native
      ? { ...base.release, status: 'No release check (Native only)', mark: 'open' }
      : {
          ...base.release,
          status: `${arm.releaseDecision === 'released' ? 'Released' : 'Withheld'} · epoch ${epochA} → ${epochR}`,
          mark: arm.releaseDecision === 'released' ? 'ok' : 'stop',
        },
    reply: { ...base.reply, ...replyStatus() },
    receipt: {
      ...base.receipt,
      status: `${short(arm.receipt.receipt_id, 18)} · chained`,
      mark: 'ok',
    },
  };
}

export function inspectorFields(
  id: WorkspaceNodeId,
  arm: ArmExecutionView | null,
  session: SafePersonaView | null,
  runtime: RuntimeStatusView | null,
): Field[] {
  const out: Field[] = [];
  if (id === 'idp' || id === 'session') {
    if (session) {
      out.push(
        { k: 'Tenant', v: session.tenantLabel },
        { k: 'Principal', v: session.principalDisplay },
        { k: 'Policy', v: `${session.policyId}@${session.policyEpoch}` },
        { k: 'Session handle', v: session.sessionHandlePreview, mono: true },
        { k: 'Expires', v: session.expiresAtIso, mono: true },
        { k: 'Authority source', v: 'Server-owned session store (HttpOnly cookie)' },
        { k: 'Fixture notice', v: 'Synthetic demo fixture, not real authentication' },
      );
    }
    if (arm) {
      out.push(
        { k: 'Session digest', v: arm.receipt.session_digest_sha256, mono: true },
        { k: 'Tenant digest', v: arm.receipt.tenant_digest_sha256, mono: true },
      );
    }
    return out;
  }
  if (!arm) {
    if (id === 'gemini' && runtime) {
      out.push(
        { k: 'Provider', v: runtime.provider },
        { k: 'Model', v: runtime.configuredModel, mono: true },
        { k: 'Transport', v: runtime.mode.toUpperCase() },
      );
    }
    out.push({ k: 'State', v: 'Run the request to populate this node.' });
    return out;
  }

  const graphNode = arm.graph.nodes.find((n) => n.id === GRAPH_ID[id]);
  if (id === 'retriever') {
    out.push(
      { k: 'Defect', v: 'Query omits the tenant predicate (deliberate demo bug)' },
      { k: 'Chunks returned', v: String(arm.counts.retrieved) },
      { k: 'Query', v: arm.frozenQueryText },
      { k: 'Query SHA-256', v: arm.querySha256, mono: true },
    );
  } else if (id === 'source_alder' || id === 'source_beacon') {
    const src = findSource(arm, id === 'source_alder' ? 'alder' : 'beacon');
    if (src) {
      out.push(
        { k: 'Chunk', v: src.chunk_id, mono: true },
        { k: 'Disposition', v: src.disposition },
        { k: 'Reason', v: reasonWords(src.reason_code) },
        { k: 'Entered Gemini request', v: src.entered_outbound_envelope ? 'yes' : 'no' },
        { k: 'Classification', v: src.classification },
        { k: 'Record epoch', v: String(src.record_policy_epoch) },
        { k: 'Content SHA-256', v: src.content_sha256, mono: true },
        { k: 'Source version', v: src.source_version_sha256, mono: true },
        { k: 'Record tenant digest', v: src.record_tenant_digest_sha256, mono: true },
      );
    }
  } else if (id === 'cube') {
    out.push(
      { k: 'Lane', v: arm.armLabel },
      { k: 'Retrieved', v: String(arm.counts.retrieved) },
      { k: 'Admitted', v: String(arm.counts.admitted) },
      { k: 'Withheld', v: String(arm.counts.withheld) },
      { k: 'Epoch at admission', v: String(arm.policyEpochAtAdmission) },
      { k: 'Foreign chunk in request', v: arm.foreignChunkEnteredEnvelope ? 'yes' : 'no' },
    );
  } else if (id === 'gemini') {
    const env = arm.receipt.outbound_envelope;
    out.push(
      { k: 'Model', v: arm.providerRuntime.model, mono: true },
      { k: 'Transport', v: arm.providerRuntime.mode.toUpperCase() },
      { k: 'Chunks in request', v: `${env.admitted_chunk_count} of ${env.admitted_chunk_denominator_retrieved}` },
      { k: 'Foreign tenant chunk present', v: env.foreign_tenant_chunk_present ? 'yes' : 'no' },
      { k: 'Envelope SHA-256', v: env.envelope_sha256 ?? 'none', mono: true },
      { k: 'Provider outcome', v: arm.providerRuntime.outcome },
      { k: 'Latency', v: `${arm.providerRuntime.latencyMs} ms` },
    );
  } else if (id === 'release') {
    out.push(
      { k: 'Decision', v: arm.releaseDecision === 'not_applicable' ? 'not applicable (Native only)' : arm.releaseDecision },
      { k: 'Reason', v: reasonWords(arm.releaseReason) },
      { k: 'Epoch before (admission)', v: String(arm.policyEpochAtAdmission) },
      { k: 'Epoch after (release)', v: String(arm.policyEpochAtRelease) },
      { k: 'Beacon marker in output', v: arm.receipt.release.planted_value_exact_match ? 'yes' : 'no' },
      { k: 'Response SHA-256', v: arm.receipt.release.response_sha256 ?? 'none', mono: true },
    );
  } else if (id === 'reply') {
    out.push(
      { k: 'Provider outcome', v: arm.providerRuntime.outcome },
      { k: 'Release decision', v: arm.releaseDecision },
      { k: 'Allowed task completed', v: arm.permittedTaskCompleted ? 'yes' : 'no' },
      { k: 'Sources used', v: arm.releasedSourcesUsed.join(', ') || 'none' },
    );
  } else if (id === 'receipt') {
    const r = arm.receipt;
    out.push(
      { k: 'Receipt ID', v: r.receipt_id, mono: true },
      { k: 'Request ID', v: r.request_id, mono: true },
      { k: 'Lane', v: r.arm },
      { k: 'Events in run', v: String(r.chain.event_count_in_run) },
      { k: 'Previous chain hash', v: r.chain.previous_receipt_chain_sha256, mono: true },
      { k: 'Current chain hash', v: r.chain.current_receipt_chain_sha256, mono: true },
      { k: 'Protected text stored', v: '0 bytes (digests only)' },
      { k: 'Evidence', v: r.evidence_completeness.replace(/_/g, ' ') },
    );
  }
  if (graphNode && id !== 'receipt') {
    for (const f of graphNode.evidenceFields) {
      if (!out.some((o) => o.k.toLowerCase() === f.key.toLowerCase())) {
        out.push({ k: f.key, v: f.value, mono: f.mono });
      }
    }
  }
  return out;
}
