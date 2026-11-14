/**
 * Responsibility: Tests the optional user question on `/api/demo/run-paired`: it reaches the
 * model input in both arms, strict validation rejects bad input, authority overrides stay
 * rejected, receipts and logs carry only its digest and length, and the protected arm still
 * withholds the planted value.
 * Trust boundary: Full HTTP ingress -> validation -> both arms -> spy transport -> release -> ledger.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { DemoStateResponse } from '../../src/shared/contracts.js';
import { MAX_CUSTOM_QUESTION_LENGTH, validatePairedRunPayload } from '../../src/shared/contracts.js';
import { API_ERROR_CODES } from '../../src/shared/reason-codes.js';
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
import { findProhibitedContentInObject, sha256Hex } from '../../src/server/redaction.js';

type Paired = NonNullable<DemoStateResponse['latestPairedRun']>;

const QUESTION = "What is Pied Piper's project code?";

let activeApp: AppInstance | null = null;

async function startServer(spy: SpyGeminiTransport): Promise<{ baseUrl: string; app: AppInstance }> {
  const config = loadServerConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'mock',
    SESSION_SECRET: 'custom_question_test_secret_key_32_bytes_min',
    GEMINI_MODEL: 'gemini-2.5-flash',
    MAX_GEMINI_CALLS_PER_SESSION: '24',
  });
  const app = createAppInstance({ config, transport: spy, sleepFn: async () => {}, emitLogsToStdout: false });
  activeApp = app;
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
  const port = (app.server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, app };
}

async function openSession(baseUrl: string, persona: 'alder' | 'beacon' = 'alder'): Promise<string> {
  const res = await fetch(`${baseUrl}/api/demo/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
}

function runPaired(baseUrl: string, cookie: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}/api/demo/run-paired`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body,
  });
}

afterEach(async () => {
  if (activeApp) {
    const srv = activeApp.server;
    activeApp = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

describe('Custom question on the paired run', () => {
  it('sends the question to the model in both arms and keeps the search bug and the gate', async () => {
    const spy = new SpyGeminiTransport(new DeterministicMockGeminiTransport());
    const { baseUrl } = await startServer(spy);
    const cookie = await openSession(baseUrl);

    const res = await runPaired(baseUrl, cookie, JSON.stringify({ question: `  ${QUESTION}  ` }));
    expect(res.status).toBe(200);
    const { pairedRun } = (await res.json()) as { pairedRun: Paired };

    const envs = spy.getCapturedEnvelopes();
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env.userContent).toContain(`USER_QUESTION:\n${QUESTION}\n`);
    }
    // Search bug unchanged: the unprotected arm still gets both companies' notes.
    expect(envs[0]!.includedSourceIds).toEqual([ALDER_RECORD.sourceId, BEACON_RECORD.sourceId]);
    // Gate unchanged: the protected arm only gets the asker's note.
    expect(envs[1]!.includedSourceIds).toEqual([ALDER_RECORD.sourceId]);
    expect(envs[1]!.userContent).not.toContain(SYNTHETIC_PLANTED_VALUE);

    const sha = sha256Hex(QUESTION);
    expect(pairedRun.nativeOnly.querySha256).toBe(sha);
    expect(pairedRun.nativePlusVervain.querySha256).toBe(sha);
    expect(pairedRun.nativeOnly.receipt.query_sha256).toBe(sha);
    expect(pairedRun.nativePlusVervain.receipt.query_sha256).toBe(sha);
    expect(pairedRun.nativePlusVervain.structuralVerdict).toBe('foreign_context_withheld_before_gemini');
  });

  it('uses the frozen question when the body is empty', async () => {
    const spy = new SpyGeminiTransport(new DeterministicMockGeminiTransport());
    const { baseUrl } = await startServer(spy);
    const cookie = await openSession(baseUrl);
    const res = await runPaired(baseUrl, cookie, '{}');
    expect(res.status).toBe(200);
    for (const env of spy.getCapturedEnvelopes()) {
      expect(env.userContent).not.toContain(QUESTION);
    }
  });

  it('rejects bad questions with a clear 400 and never calls the model', async () => {
    const spy = new SpyGeminiTransport(new DeterministicMockGeminiTransport());
    const { baseUrl } = await startServer(spy);
    const cookie = await openSession(baseUrl);
    const bad: unknown[] = [
      'x'.repeat(MAX_CUSTOM_QUESTION_LENGTH + 1),
      'What is\u0007 the code?',
      'line one\nline two',
      'tab\there',
      'bidi ‮ trick',
      'zero​width',
      '   ',
      '',
      42,
      null,
      ['What is the code?'],
      { text: 'nested' },
    ];
    for (const question of bad) {
      const res = await runPaired(baseUrl, cookie, JSON.stringify({ question }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe(API_ERROR_CODES.INVALID_REQUEST);
      expect(body.error.message).toMatch(/Question/);
    }
    expect(spy.getCapturedEnvelopes()).toHaveLength(0);

    // Exactly the limit is fine.
    expect(validatePairedRunPayload({ question: 'q'.repeat(MAX_CUSTOM_QUESTION_LENGTH) }).ok).toBe(true);
  });

  it('still rejects authority overrides and unknown fields next to a question', async () => {
    const spy = new SpyGeminiTransport(new DeterministicMockGeminiTransport());
    const { baseUrl } = await startServer(spy);
    const cookie = await openSession(baseUrl);
    for (const key of ['tenant', 'tenantId', 'policy_epoch', 'scope', 'model', 'systemInstruction', 'bypassAdmission']) {
      const res = await runPaired(baseUrl, cookie, JSON.stringify({ question: QUESTION, [key]: 'beacon' }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED);
    }
    const unknown = await runPaired(baseUrl, cookie, JSON.stringify({ question: QUESTION, extra: 1 }));
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(API_ERROR_CODES.UNKNOWN_FIELD);
    // Override hidden inside the question value object shape is still caught by the detector.
    const nested = await runPaired(baseUrl, cookie, JSON.stringify({ question: { tenant: 'beacon' } }));
    expect(nested.status).toBe(400);
    expect(((await nested.json()) as { error: { code: string } }).error.code).toBe(
      API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED,
    );
    expect(spy.getCapturedEnvelopes()).toHaveLength(0);
  });

  it('keeps the question text out of receipts, ledger events, and logs (digest and length only)', async () => {
    const spy = new SpyGeminiTransport(new DeterministicMockGeminiTransport());
    const { baseUrl, app } = await startServer(spy);
    const cookie = await openSession(baseUrl);
    const res = await runPaired(baseUrl, cookie, JSON.stringify({ question: QUESTION }));
    expect(res.status).toBe(200);
    const { pairedRun } = (await res.json()) as { pairedRun: Paired };

    const forbidden = getProtectedFixtureSubstrings([QUESTION]);
    for (const arm of [pairedRun.nativeOnly, pairedRun.nativePlusVervain]) {
      expect(findProhibitedContentInObject(arm.receipt, forbidden)).toBeNull();
      expect(JSON.stringify(arm.receipt)).not.toContain(QUESTION);
      const events = app.context.ledger.getEventsForRequest(arm.requestId);
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain(QUESTION);
      const fetched = await fetch(`${baseUrl}/api/receipts/${arm.receiptId}`, { headers: { Cookie: cookie } });
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).not.toContain(QUESTION);
    }

    const logs = app.context.logger.snapshot();
    expect(JSON.stringify(logs)).not.toContain(QUESTION);
    expect(findProhibitedContentInObject(logs, forbidden)).toBeNull();
    const questionLog = logs.find((l) => l.event === 'paired_run_question');
    expect(questionLog?.fields).toMatchObject({
      custom_question: true,
      query_sha256: sha256Hex(QUESTION),
      query_length: QUESTION.length,
    });
  });

  it('withholds the planted value in the protected arm even if the model tries to repeat it', async () => {
    // A model that always tries to repeat the planted value, whatever it was given.
    const leaky = new DeterministicMockGeminiTransport((envelope) => ({
      status: 'ok',
      rawText: JSON.stringify({
        answer: `The project code is ${SYNTHETIC_PLANTED_VALUE}.`,
        sources_used: [...envelope.includedSourceIds],
      }),
    }));
    const spy = new SpyGeminiTransport(leaky);
    const { baseUrl } = await startServer(spy);
    const cookie = await openSession(baseUrl);
    const res = await runPaired(baseUrl, cookie, JSON.stringify({ question: QUESTION }));
    expect(res.status).toBe(200);
    const { pairedRun } = (await res.json()) as { pairedRun: Paired };

    expect(pairedRun.nativeOnly.foreignChunkEnteredEnvelope).toBe(true);
    const governed = pairedRun.nativePlusVervain;
    expect(governed.foreignChunkEnteredEnvelope).toBe(false);
    expect(governed.releaseDecision).toBe('withheld');
    expect(governed.releaseReason).toBe('planted_value_detected');
    expect(governed.releasedAnswerText).toBeNull();
    expect(JSON.stringify(governed)).not.toContain(SYNTHETIC_PLANTED_VALUE);
  });

  it('works when Pied Piper is asking: Acme\'s note is the one blocked', async () => {
    const spy = new SpyGeminiTransport(new DeterministicMockGeminiTransport());
    const { baseUrl } = await startServer(spy);
    const cookie = await openSession(baseUrl, 'beacon');
    const res = await runPaired(baseUrl, cookie, JSON.stringify({ question: "What is Acme's renewal discount?" }));
    expect(res.status).toBe(200);
    const { pairedRun } = (await res.json()) as { pairedRun: Paired };
    const envs = spy.getCapturedEnvelopes();
    // Unprotected arm: Acme's note goes into the model.
    expect(envs[0]!.includedSourceIds).toEqual([ALDER_RECORD.sourceId, BEACON_RECORD.sourceId]);
    expect(pairedRun.nativeOnly.foreignChunkEnteredEnvelope).toBe(true);
    // Protected arm: Acme's note is withheld; Pied Piper's own note is restricted for the model
    // destination, so nothing is admitted and the model is not called (unchanged gate behavior).
    expect(envs).toHaveLength(1);
    const governed = pairedRun.nativePlusVervain;
    expect(governed.foreignChunkEnteredEnvelope).toBe(false);
    expect(governed.counts.admitted).toBe(0);
    expect(governed.providerRuntime.callAttempted).toBe(false);
  });
});
