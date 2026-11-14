/**
 * Responsibility: Terminal M2 paired-proof runner printing a concise comparison of
 * `Native only` vs `Native + Vervain` over the frozen Northstar fixture.
 * Trust boundary: Local verification script; uses mock transport unless DEMO_MODE=live
 * and GEMINI_API_KEY are explicitly configured.
 */

import { loadServerConfig } from '../src/server/config.js';
import { ALDER_RECORD, BEACON_RECORD, SYNTHETIC_PLANTED_VALUE } from '../src/server/fixture.js';
import {
  DeterministicMockGeminiTransport,
  OfficialGoogleGenAITransport,
  SpyGeminiTransport,
} from '../src/server/gemini.js';
import { AuditLedger } from '../src/server/ledger.js';
import { SafeStructuredLogger } from '../src/server/redaction.js';
import { ResponseReleaseGate } from '../src/server/release.js';
import { SessionStore } from '../src/server/session.js';
import { runPairedProofWorkflow } from '../src/server/workflows.js';

async function main(): Promise<void> {
  const baseConfig = loadServerConfig({
    ...process.env,
    DEMO_MODE: process.env.GEMINI_API_KEY && process.env.DEMO_MODE === 'live' ? 'live' : 'mock',
  });

  const innerTransport =
    baseConfig.demoMode === 'live'
      ? new OfficialGoogleGenAITransport(baseConfig.geminiApiKey)
      : new DeterministicMockGeminiTransport();
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
    model: baseConfig.geminiModel,
    native_only: {
      verdict: paired.nativeOnly.structuralVerdict,
      chunks_in_envelope: `${ctrlEnv.includedChunkCount}/${paired.nativeOnly.counts.retrieved}`,
      sources_in_envelope: ctrlEnv.includedSourceIds,
      beacon_in_envelope: ctrlEnv.includedSourceIds.includes(BEACON_RECORD.sourceId),
      planted_in_envelope: ctrlEnv.userContent.includes(SYNTHETIC_PLANTED_VALUE),
      planted_in_response: paired.nativeOnly.plantedValueInResponse,
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
      permitted_task_completed: paired.nativePlusVervain.permittedTaskCompleted,
      receipt_id: paired.nativePlusVervain.receiptId,
    },
    ledger_chain_verified: chainCheck.verified,
    checked_events: chainCheck.checkedEvents,
    checked_receipts: chainCheck.checkedReceipts,
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
