/**
 * Responsibility: Explicitly gated live Google Gemini smoke test (`ALLOW_LIVE_GEMINI=1` + `GEMINI_API_KEY`).
 * Trust boundary: Skips cleanly during offline/mock runs so CI and local tests stay deterministic
 * and zero-cost unless the operator enables a bounded live check.
 */

import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../../src/server/config.js';
import { ALDER_RECORD, BEACON_RECORD, SYNTHETIC_PLANTED_VALUE } from '../../src/server/fixture.js';
import { OfficialGoogleGenAITransport, SpyGeminiTransport } from '../../src/server/gemini.js';
import { AuditLedger } from '../../src/server/ledger.js';
import { SafeStructuredLogger } from '../../src/server/redaction.js';
import { ResponseReleaseGate } from '../../src/server/release.js';
import { SessionStore } from '../../src/server/session.js';
import { runPairedProofWorkflow } from '../../src/server/workflows.js';

const shouldRunLive =
  process.env.ALLOW_LIVE_GEMINI === '1' && Boolean(process.env.GEMINI_API_KEY?.trim());

describe.skipIf(!shouldRunLive)('M3 Live Google Gemini Smoke Proof', () => {
  it('executes one bounded live paired proof through official @google/genai SDK', async () => {
    const config = loadServerConfig({
      ...process.env,
      DEMO_MODE: 'live',
    });
    const spy = new SpyGeminiTransport(new OfficialGoogleGenAITransport(config.geminiApiKey));
    const sessionStore = new SessionStore({ secret: config.sessionSecret, ttlMs: 60_000 });
    const ledger = new AuditLedger();
    const releaseGate = new ResponseReleaseGate();
    const logger = new SafeStructuredLogger({ emitToStdout: false });

    const { snapshot: alder } = sessionStore.createOrRotateSession('alder');
    const paired = await runPairedProofWorkflow(
      { config, sessionStore, ledger, releaseGate, transport: spy, logger },
      alder,
    );

    const captured = spy.getCapturedEnvelopes();
    expect(captured).toHaveLength(2);
    expect(captured[1]!.includedSourceIds).toEqual([ALDER_RECORD.sourceId]);
    expect(captured[1]!.includedSourceIds).not.toContain(BEACON_RECORD.sourceId);
    expect(captured[1]!.userContent).not.toContain(SYNTHETIC_PLANTED_VALUE);
    expect(paired.nativePlusVervain.providerRuntime.mode).toBe('live');
    expect(paired.nativePlusVervain.providerRuntime.outcome).toBe('succeeded');
    expect(paired.nativePlusVervain.permittedTaskCompleted).toBe(true);
    expect(ledger.verifyChain().verified).toBe(true);
  });
});
