/**
 * Responsibility: Narrow browser API client communicating exclusively with same-origin
 * `/api/*` endpoints using HttpOnly SameSite cookies.
 * Trust boundary: Untrusted browser code; never sends tenant, principal, epoch, scope,
 * or model override parameters.
 */

import type {
  ArmExecutionView,
  ContextReceipt,
  DemoStateResponse,
  EnterpriseArchitectureResponse,
  InferenceProofStatusView,
  LedgerVerificationResult,
  PersonaId,
  SafePersonaView,
  ScopedAttentionProofView,
} from '../shared/contracts.js';

export class ClientApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const body = (await res.json().catch(() => null)) as
    | T
    | { error?: { code?: string; message?: string } }
    | null;

  if (!res.ok) {
    const errObj =
      body && typeof body === 'object' && 'error' in body ? body.error : undefined;
    throw new ClientApiError(
      res.status,
      errObj?.code ?? 'request_failed',
      errObj?.message ?? `HTTP ${res.status}`,
    );
  }

  return body as T;
}

export async function fetchDemoState(): Promise<DemoStateResponse> {
  return requestJson<DemoStateResponse>('/api/demo/state');
}

export async function createOrSwitchPersonaSession(persona: PersonaId): Promise<{
  session: SafePersonaView;
}> {
  return requestJson<{ session: SafePersonaView }>('/api/demo/session', {
    method: 'POST',
    body: JSON.stringify({ persona }),
  });
}

export async function runPairedProofRequest(): Promise<{
  pairedRun: NonNullable<DemoStateResponse['latestPairedRun']>;
  session: SafePersonaView;
  ledgerSummary: LedgerVerificationResult;
}> {
  return requestJson('/api/demo/run-paired', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function runCleanDemoRequest(): Promise<{
  run: ArmExecutionView;
  session: SafePersonaView;
  ledgerSummary: LedgerVerificationResult;
}> {
  return requestJson('/api/demo/run-clean', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function runRevokeDuringGenerationRequest(): Promise<{
  run: ArmExecutionView;
  session: SafePersonaView;
  ledgerSummary: LedgerVerificationResult;
}> {
  return requestJson('/api/demo/revoke-during-generation', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function resetDemoSessionRequest(): Promise<{
  session: SafePersonaView;
  reset: boolean;
}> {
  return requestJson('/api/demo/reset', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function verifyLedgerChainRequest(): Promise<LedgerVerificationResult> {
  return requestJson<LedgerVerificationResult>('/api/ledger/verify');
}

export async function fetchReceiptById(receiptId: string): Promise<{ receipt: ContextReceipt }> {
  return requestJson<{ receipt: ContextReceipt }>(`/api/receipts/${encodeURIComponent(receiptId)}`);
}

export async function fetchScopedAttentionProof(): Promise<ScopedAttentionProofView> {
  return requestJson<ScopedAttentionProofView>('/api/demo/scoped-attention');
}

export async function fetchInferenceProofStatus(): Promise<InferenceProofStatusView> {
  return requestJson<InferenceProofStatusView>('/api/inference-proof');
}

export async function fetchEnterpriseArchitecture(): Promise<EnterpriseArchitectureResponse> {
  return requestJson<EnterpriseArchitectureResponse>('/api/demo/enterprise-architecture');
}
