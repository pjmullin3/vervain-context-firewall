/**
 * Responsibility: Terminal M2 paired-proof runner printing a concise comparison of
 * `Native only` vs `Native + Vervain` over the frozen Northstar fixture.
 * Trust boundary: Local verification script; uses mock transport unless DEMO_MODE=live
 * and GEMINI_API_KEY are explicitly configured, or PROVIDER=openai_compatible selects a
 * self-hosted OpenAI-compatible endpoint (OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_MODEL).
 * PAIRED_PROOF_FULL=1 also prints both complete arm views, receipts included.
 */

import { loadServerConfig } from '../src/server/config.js';
import { ALDER_RECORD, BEACON_RECORD, SYNTHETIC_PLANTED_VALUE } from '../src/server/fixture.js';
import {
  DeterministicMockGeminiTransport,
  OfficialGoogleGenAITransport,
  SpyGeminiTransport,
} from '../src/server/gemini.js';
import { AuditLedger } from '../src/server/ledger.js';
import {
  loadOpenAICompatibleSettings,
  OpenAICompatibleChatTransport,
} from '../src/server/openai-compatible.js';
import { SafeStructuredLogger } from '../src/server/redaction.js';
import { ResponseReleaseGate } from '../src/server/release.js';
import { SessionStore } from '../src/server/session.js';
import { runPairedProofWorkflow } from '../src/server/workflows.js';

async function main(): Promise<void> {
  const compat = loadOpenAICompatibleSettings(process.env);
  const baseConfig = loadServerConfig({
    ...process.env,
    DEMO_MODE:
      compat || (process.env.GEMINI_API_KEY && process.env.DEMO_MODE === 'live') ? 'live' : 'mock',
    // Receipts record the envelope model id, so it must name the served model.
    ...(compat ? { GEMINI_MODEL: compat.model } : {}),
  });
  if (compat && baseConfig.geminiModel !== compat.model) {
    throw new Error('Envelope model id does not match OPENAI_COMPAT_MODEL.');
  }

  const compatTransport = compat ? new OpenAICompatibleChatTransport(compat) : null;
  const innerTransport =
    compatTransport ??
    (baseConfig.demoMode === 'live'
      ? new OfficialGoogleGenAITransport(baseConfig.geminiApiKey)
      : new DeterministicMockGeminiTransport());
  const spy = new SpyGeminiTransport(innerTransport);
  const sessionStore = new SessionStore({
    secret: baseConfig.sessionSecret,
    ttlMs: baseConfig.sessionTtlMs,
  });
  const ledger = new AuditLedger();
  const releaseGate = new ResponseReleaseGate();
  const logger = new SafeStructuredLogger({ emitToStdout: false });

  const { snapshot: alderAuthority } = sessionStore.createOrRotateSession('alder');
  const paired = await runPairedProofWorkflow(
    {
      config: baseConfig,
      sessionStore,
      ledger,
      releaseGate,
      transport: spy,
      logger,
    },
    alderAuthority,
  );

  const envelopes = spy.getCapturedEnvelopes();
  const ctrlEnv = envelopes[0]!;
  const vvnEnv = envelopes[1]!;
  const chainCheck = ledger.verifyChain();

  const summary = {
    fixture_id: paired.nativePlusVervain.fixtureId,
    query_sha256_prefix: paired.nativePlusVervain.querySha256.slice(0, 16),
    transport_mode: spy.mode,
    provider: compatTransport
      ? 'openai_compatible'
      : baseConfig.demoMode === 'live'
        ? 'Google Gemini'
        : 'mock',
    provider_endpoint: compatTransport ? compatTransport.endpointUrl : null,
    provider_reported_models: compatTransport ? compatTransport.getObservedModelIds() : null,
    model: baseConfig.geminiModel,
    native_only: {
      verdict: paired.nativeOnly.structuralVerdict,
      chunks_in_envelope: `${ctrlEnv.includedChunkCount}/${paired.nativeOnly.counts.retrieved}`,
      sources_in_envelope: ctrlEnv.includedSourceIds,
      beacon_in_envelope: ctrlEnv.includedSourceIds.includes(BEACON_RECORD.sourceId),
      planted_in_envelope: ctrlEnv.userContent.includes(SYNTHETIC_PLANTED_VALUE),
      planted_in_response: paired.nativeOnly.plantedValueInResponse,
      provider_outcome: paired.nativeOnly.providerRuntime.outcome,
      provider_latency_ms: paired.nativeOnly.providerRuntime.latencyMs,
      provider_retry_count: paired.nativeOnly.providerRuntime.retryCount,
      released_answer_text: paired.nativeOnly.releasedAnswerText,
      released_sources_used: paired.nativeOnly.releasedSourcesUsed,
      receipt_id: paired.nativeOnly.receiptId,
    },
    native_plus_vervain: {
      verdict: paired.nativePlusVervain.structuralVerdict,
      admitted_of_retrieved: `${paired.nativePlusVervain.counts.admitted}/${paired.nativePlusVervain.counts.retrieved}`,
      sources_in_envelope: vvnEnv.includedSourceIds,
      alder_in_envelope: vvnEnv.includedSourceIds.includes(ALDER_RECORD.sourceId),
      beacon_in_envelope: vvnEnv.includedSourceIds.includes(BEACON_RECORD.sourceId),
      planted_in_envelope: vvnEnv.userContent.includes(SYNTHETIC_PLANTED_VALUE),
      release_decision: paired.nativePlusVervain.releaseDecision,
      release_reason: paired.nativePlusVervain.releaseReason,
      permitted_task_completed: paired.nativePlusVervain.permittedTaskCompleted,
      provider_outcome: paired.nativePlusVervain.providerRuntime.outcome,
      provider_latency_ms: paired.nativePlusVervain.providerRuntime.latencyMs,
      provider_retry_count: paired.nativePlusVervain.providerRuntime.retryCount,
      released_answer_text: paired.nativePlusVervain.releasedAnswerText,
      released_sources_used: paired.nativePlusVervain.releasedSourcesUsed,
      receipt_id: paired.nativePlusVervain.receiptId,
    },
    ledger_chain_verified: chainCheck.verified,
    checked_events: chainCheck.checkedEvents,
    checked_receipts: chainCheck.checkedReceipts,
    ...(process.env.PAIRED_PROOF_FULL === '1'
      ? { arms_full: { native_only: paired.nativeOnly, native_plus_vervain: paired.nativePlusVervain } }
      : {}),
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (
    !summary.native_only.beacon_in_envelope ||
    summary.native_plus_vervain.beacon_in_envelope ||
    summary.native_plus_vervain.planted_in_envelope ||
    !summary.native_plus_vervain.alder_in_envelope ||
    !summary.ledger_chain_verified
  ) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('Paired proof script failed:', err instanceof Error ? err.message : 'unknown');
  process.exit(1);
});
