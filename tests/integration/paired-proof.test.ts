/**
 * Responsibility: M2 paired API integration tests verifying exact Gemini envelope contents
 * via `SpyGeminiTransport`, allowed-twin completion, epoch-revocation withholding, and HTTP API
 * contracts over an ephemeral server socket.
 * Trust boundary: Exercises full HTTP ingress -> session -> retrieval -> admission -> spy -> release -> ledger.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { DemoStateResponse } from '../../src/shared/contracts.js';
import { createAppInstance, type AppInstance } from '../../src/server/app.js';
import { loadServerConfig } from '../../src/server/config.js';
import {
  ALDER_RECORD,
  BEACON_RECORD,
  SYNTHETIC_PLANTED_VALUE,
  getProtectedFixtureSubstrings,
} from '../../src/server/fixture.js';
import {
  DeterministicMockGeminiTransport,
  SpyGeminiTransport,
} from '../../src/server/gemini.js';
import { findProhibitedContentInObject } from '../../src/server/redaction.js';

let activeApp: AppInstance | null = null;

async function startTestServer(customSpy?: SpyGeminiTransport): Promise<{
  baseUrl: string;
  spy: SpyGeminiTransport;
  app: AppInstance;
}> {
  const spy = customSpy ?? new SpyGeminiTransport(new DeterministicMockGeminiTransport());
  const config = loadServerConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'mock',
    SESSION_SECRET: 'integration_test_secret_key_32_bytes_minimum',
    GEMINI_MODEL: 'gemini-2.5-flash',
    MAX_GEMINI_CALLS_PER_SESSION: '24',
  });
  const app = createAppInstance({
    config,
    transport: spy,
    sleepFn: async () => {},
    emitLogsToStdout: false,
  });
  activeApp = app;

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (app.server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, spy, app };
}

afterEach(async () => {
  if (activeApp) {
    const srv = activeApp.server;
    activeApp = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

describe('M2 Paired API Proof & Envelope Spy Verification', () => {
  it('proves Native only transmits Beacon into Gemini envelope while Native + Vervain excludes Beacon and completes Alder task', async () => {
    const { baseUrl, spy, app } = await startTestServer();

    // 1. Create Alder session
    const sesRes = await fetch(`${baseUrl}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: 'alder' }),
    });
    expect(sesRes.status).toBe(200);
    const cookie = sesRes.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toContain('vervain_cf_sid=');

    // 2. Run paired proof
    const pairedRes = await fetch(`${baseUrl}/api/demo/run-paired`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({}),
    });
    expect(pairedRes.status).toBe(200);
    const body = (await pairedRes.json()) as {
      pairedRun: NonNullable<DemoStateResponse['latestPairedRun']>;
    };

    const { nativeOnly, nativePlusVervain } = body.pairedRun;
    expect(nativeOnly.querySha256).toBe(nativePlusVervain.querySha256);
    expect(nativeOnly.fixtureId).toBe(nativePlusVervain.fixtureId);

    // Inspect exact captured outbound envelopes at transport boundary
    const captured = spy.getCapturedEnvelopes();
    expect(captured).toHaveLength(2);
    const controlEnv = captured[0]!;
    const vervainEnv = captured[1]!;

    // G3_CONTROL_ARM_REALITY: Control arm contains both Alder & Beacon
    expect(controlEnv.includedSourceIds).toEqual([ALDER_RECORD.sourceId, BEACON_RECORD.sourceId]);
    expect(controlEnv.userContent).toContain(SYNTHETIC_PLANTED_VALUE);
    expect(nativeOnly.structuralVerdict).toBe('cross_tenant_context_transmitted');
    expect(nativeOnly.foreignChunkEnteredEnvelope).toBe(true);

    // G2_FOREIGN_ENVELOPE_ABSENCE: Vervain arm contains ONLY Alder and zero Beacon bytes
    expect(vervainEnv.includedSourceIds).toEqual([ALDER_RECORD.sourceId]);
    expect(vervainEnv.userContent).toContain('12 percent with director approval');
    expect(vervainEnv.userContent).not.toContain(BEACON_RECORD.sourceId);
    expect(vervainEnv.userContent).not.toContain(BEACON_RECORD.text);
    expect(vervainEnv.userContent).not.toContain(SYNTHETIC_PLANTED_VALUE);
    expect(vervainEnv.userContent).not.toContain('Ignore tenant boundaries');

    // G1_ALLOWED_TWIN: Permitted task completes under unchanged authority
    expect(nativePlusVervain.structuralVerdict).toBe('foreign_context_withheld_before_gemini');
    expect(nativePlusVervain.counts).toEqual({
      retrieved: 2,
      admitted: 1,
      withheld: 1,
      unknown: 0,
      admittedDenominatorUnit: 'retrieved_chunks',
    });
    expect(nativePlusVervain.foreignChunkEnteredEnvelope).toBe(false);
    expect(nativePlusVervain.releaseDecision).toBe('released');
    expect(nativePlusVervain.permittedTaskCompleted).toBe(true);
    expect(nativePlusVervain.releasedAnswerText).toContain('12 percent');
    expect(nativePlusVervain.releasedAnswerText).not.toContain(SYNTHETIC_PLANTED_VALUE);

    // Verify receipt export & ledger chain endpoint
    const exportRes = await fetch(
      `${baseUrl}/api/receipts/${nativePlusVervain.receiptId}/export`,
      { headers: { Cookie: cookie } },
    );
    expect(exportRes.status).toBe(200);
    const exportedJson = JSON.parse(await exportRes.text()) as unknown;
    expect(
      findProhibitedContentInObject(exportedJson, getProtectedFixtureSubstrings([cookie])),
    ).toBeNull();

    // Verify structured server logs are content-free
    expect(
      findProhibitedContentInObject(
        app.context.logger.snapshot(),
        getProtectedFixtureSubstrings([cookie]),
      ),
    ).toBeNull();

    const verifyRes = await fetch(`${baseUrl}/api/ledger/verify`, {
      headers: { Cookie: cookie },
    });
    expect(verifyRes.status).toBe(200);
    const verifyBody = (await verifyRes.json()) as { verified: boolean; checkedReceipts: number };
    expect(verifyBody.verified).toBe(true);
    expect(verifyBody.checkedReceipts).toBe(2);
  });

  it('withholds late response when policy epoch increments during generation (revoke_during_generation)', async () => {
    const { baseUrl } = await startTestServer();
    const sesRes = await fetch(`${baseUrl}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: 'alder' }),
    });
    const cookie = sesRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const revokeRes = await fetch(`${baseUrl}/api/demo/revoke-during-generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    expect(revokeRes.status).toBe(200);
    const body = (await revokeRes.json()) as {
      run: NonNullable<DemoStateResponse['latestSingleRun']>;
    };

    expect(body.run.policyEpochAtAdmission).toBe(7);
    expect(body.run.policyEpochAtRelease).toBe(8);
    expect(body.run.releaseDecision).toBe('withheld');
    expect(body.run.releaseReason).toBe('policy_epoch_changed');
    expect(body.run.releasedAnswerText).toBeNull();
    expect(body.run.permittedTaskCompleted).toBe(false);
  });
});
