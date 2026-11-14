/**
 * Responsibility: Campaigns D, E, and F adversarial tests covering mid-generation authority races,
 * out-of-order delayed completion, mid-flight reset isolation, duplicate release replay, secondary
 * planted-value withholding, receipt-bound ledger write failure, recursive content-free hygiene,
 * canonical hash-chain tampering, and HTTP ingress hardening (CSRF, Content-Type, 8KB cap, 405,
 * static path traversal, CSP/XFO/nosniff headers, in-flight idempotency, rate and Gemini caps).
 * Trust boundary: Exercises concurrency, evidence ledger, and public HTTP/static boundaries.
 */

import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEDGER_EVENT_SCHEMA_VERSION } from '../../src/shared/config.js';
import type { DemoStateResponse } from '../../src/shared/contracts.js';
import { API_ERROR_CODES, RELEASE_REASONS } from '../../src/shared/reason-codes.js';
import { createAppInstance, type AppInstance } from '../../src/server/app.js';
import { loadServerConfig } from '../../src/server/config.js';
import type { GeminiOutboundEnvelope } from '../../src/server/envelope.js';
import {
  ALDER_RECORD,
  FROZEN_QUERY_SHA256,
  SYNTHETIC_PLANTED_VALUE,
  getProtectedFixtureSubstrings,
} from '../../src/server/fixture.js';
import {
  DeterministicMockGeminiTransport,
  SpyGeminiTransport,
  type TransportRawResult,
} from '../../src/server/gemini.js';
import {
  AuditLedger,
  canonicalJsonString,
  computeEventSha256,
  type LedgerEventRecord,
} from '../../src/server/ledger.js';
import { buildAndAppendRunReceipt } from '../../src/server/receipts.js';
import { findProhibitedContentInObject } from '../../src/server/redaction.js';
import { ResponseReleaseGate } from '../../src/server/release.js';
import { retrieveBrokenControlChunks } from '../../src/server/retrieval.js';
import { handleApiOrProbeRequest } from '../../src/server/routes.js';
import { SessionStore } from '../../src/server/session.js';
import {
  runCleanRequestWorkflow,
  runPairedProofWorkflow,
  type WorkflowDependencies,
} from '../../src/server/workflows.js';
import { evaluateContextAdmission } from '../../src/server/admission.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}

const TEST_SESSION_SECRET = 'adversarial_campaign_def_secret_32_bytes_long';
const TEST_FAKE_API_KEY = 'AIzaSyAdversarialSyntheticKeyValue987654321';

let activeServer: AppInstance['server'] | null = null;
const tempDirsToClean: string[] = [];

afterEach(async () => {
  if (activeServer) {
    const srv = activeServer;
    activeServer = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirsToClean.length > 0) {
    const dir = tempDirsToClean.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function startWebHarness(options?: {
  envOverrides?: Record<string, string>;
  customHandler?: (
    envelope: GeminiOutboundEnvelope,
    attempt: number,
  ) => Promise<TransportRawResult> | TransportRawResult;
  clientDistDir?: string;
}): Promise<{
  baseUrl: string;
  port: number;
  app: AppInstance;
  spy: SpyGeminiTransport;
  advanceTimeMs: (ms: number) => void;
}> {
  let nowMs = 1_760_500_000_000;
  const spy = new SpyGeminiTransport(new DeterministicMockGeminiTransport(options?.customHandler));
  const config = loadServerConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'mock',
    GEMINI_API_KEY: TEST_FAKE_API_KEY,
    SESSION_SECRET: TEST_SESSION_SECRET,
    SESSION_TTL_MS: '60000',
    MAX_GEMINI_CALLS_PER_SESSION: '30',
    MAX_GEMINI_CALLS_PER_WINDOW: '100',
    RATE_LIMIT_MUTATIONS_PER_MINUTE: '50',
    ...options?.envOverrides,
  });

  const app = createAppInstance({
    config,
    transport: spy,
    clientDistDir: options?.clientDistDir,
    nowFn: () => nowMs,
    sleepFn: async () => {},
    emitLogsToStdout: false,
  });
  activeServer = app.server;

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (app.server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    app,
    spy,
    advanceTimeMs: (ms: number) => {
      nowMs += ms;
    },
  };
}

async function createSessionCookie(baseUrl: string, persona: 'alder' | 'beacon'): Promise<string> {
  const res = await fetch(`${baseUrl}/api/demo/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function assertHardeningHeaders(headers: Headers, expectNoStore: boolean): void {
  expect(headers.get('x-content-type-options')).toBe('nosniff');
  expect(headers.get('x-frame-options')).toBe('DENY');
  expect(headers.get('referrer-policy')).toBe('no-referrer');
  expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
  expect(headers.get('cross-origin-resource-policy')).toBe('same-origin');
  const csp = headers.get('content-security-policy') ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  if (expectNoStore) {
    expect(headers.get('cache-control')).toBe('no-store');
  }
}

describe('Campaign D: Concurrency Races, Release Gate, Secondary Scanner, and Receipt-Bound Release', () => {
  it('withholds in-flight response when policy epoch increments during generation and completes allowed follow-up after reset', async () => {
    const enteredTransport = createDeferred<void>();
    const releaseTransport = createDeferred<TransportRawResult>();
    let gateFirstCall = true;

    const { baseUrl, app } = await startWebHarness({
      customHandler: async () => {
        if (gateFirstCall) {
          gateFirstCall = false;
          enteredTransport.resolve();
          return releaseTransport.promise;
        }
        return {
          status: 'ok',
          rawText: JSON.stringify({
            answer: 'Authorized renewal uplift is 4 percent on Net 30 terms.',
            sources_used: [ALDER_RECORD.sourceId],
          }),
        };
      },
    });

    const cookie = await createSessionCookie(baseUrl, 'alder');
    const token = cookie.slice('vervain_cf_sid='.length);
    const resolvedSes = app.context.sessionStore.resolveCookieToken(token);
    expect(resolvedSes.ok).toBe(true);
    if (!resolvedSes.ok) return;

    const inFlightPromise = fetch(`${baseUrl}/api/demo/run-clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });

    await enteredTransport.promise;
    // Increment policy epoch while Gemini call is in flight
    const bumpedEpoch = app.context.sessionStore.incrementPolicyEpoch(
      resolvedSes.snapshot.sessionId,
    );
    expect(bumpedEpoch).toBe(8);

    releaseTransport.resolve({
      status: 'ok',
      rawText: JSON.stringify({
        answer: 'Late answer generated under superseded epoch 7.',
        sources_used: [ALDER_RECORD.sourceId],
      }),
    });

    const inFlightRes = await inFlightPromise;
    expect(inFlightRes.status).toBe(200);
    const inFlightBody = (await inFlightRes.json()) as {
      run: NonNullable<DemoStateResponse['latestSingleRun']>;
    };
    expect(inFlightBody.run.policyEpochAtAdmission).toBe(7);
    expect(inFlightBody.run.policyEpochAtRelease).toBe(8);
    expect(inFlightBody.run.releaseDecision).toBe('withheld');
    expect(inFlightBody.run.releaseReason).toBe(RELEASE_REASONS.POLICY_EPOCH_CHANGED);
    expect(inFlightBody.run.releasedAnswerText).toBeNull();
    expect(inFlightBody.run.permittedTaskCompleted).toBe(false);

    // Reset back to initial epoch 7 and confirm permitted clean follow-up completes
    await fetch(`${baseUrl}/api/demo/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    const cleanAfter = await fetch(`${baseUrl}/api/demo/run-clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    expect(cleanAfter.status).toBe(200);
    const cleanAfterBody = (await cleanAfter.json()) as {
      run: NonNullable<DemoStateResponse['latestSingleRun']>;
    };
    expect(cleanAfterBody.run.releaseDecision).toBe('released');
    expect(cleanAfterBody.run.permittedTaskCompleted).toBe(true);
  });

  it('withholds response when session expires or rotates to another persona during in-flight generation', async () => {
    // Part 1: Session TTL expiry mid-generation
    const enteredExpiry = createDeferred<void>();
    const finishExpiry = createDeferred<TransportRawResult>();
    {
      const { baseUrl, advanceTimeMs } = await startWebHarness({
        customHandler: async () => {
          enteredExpiry.resolve();
          return finishExpiry.promise;
        },
      });
      const cookie = await createSessionCookie(baseUrl, 'alder');
      const runPromise = fetch(`${baseUrl}/api/demo/run-clean`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      });

      await enteredExpiry.promise;
      advanceTimeMs(65_000); // Expire session while Gemini is generating
      finishExpiry.resolve({
        status: 'ok',
        rawText: JSON.stringify({
          answer: 'Answer arriving after session expiry.',
          sources_used: [ALDER_RECORD.sourceId],
        }),
      });

      const res = await runPromise;
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        run: NonNullable<DemoStateResponse['latestSingleRun']>;
      };
      expect(body.run.releaseDecision).toBe('withheld');
      expect(body.run.releaseReason).toBe(RELEASE_REASONS.SESSION_EXPIRED);
      expect(body.run.releasedAnswerText).toBeNull();
      await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
      activeServer = null;
    }

    // Part 2: Session persona rotation mid-generation deletes old session -> session_missing
    const enteredRotate = createDeferred<void>();
    const finishRotate = createDeferred<TransportRawResult>();
    {
      const { baseUrl } = await startWebHarness({
        customHandler: async () => {
          enteredRotate.resolve();
          return finishRotate.promise;
        },
      });
      const alderCookie = await createSessionCookie(baseUrl, 'alder');
      const runPromise = fetch(`${baseUrl}/api/demo/run-clean`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: alderCookie },
        body: '{}',
      });

      await enteredRotate.promise;
      // Rotate persona while passing alderCookie -> invalidates old session mid-flight
      const rotRes = await fetch(`${baseUrl}/api/demo/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: alderCookie },
        body: JSON.stringify({ persona: 'beacon' }),
      });
      expect(rotRes.status).toBe(200);

      finishRotate.resolve({
        status: 'ok',
        rawText: JSON.stringify({
          answer: 'Answer arriving after persona switch.',
          sources_used: [ALDER_RECORD.sourceId],
        }),
      });

      const res = await runPromise;
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        run: NonNullable<DemoStateResponse['latestSingleRun']>;
      };
      expect(body.run.releaseDecision).toBe('withheld');
      expect(body.run.releaseReason).toBe(RELEASE_REASONS.SESSION_MISSING);
      expect(body.run.releasedAnswerText).toBeNull();
    }
  });

  it('blocks out-of-order delayed run completion and mid-flight reset from overwriting newer session state', async () => {
    const run1Entered = createDeferred<void>();
    const run1Finish = createDeferred<TransportRawResult>();
    let callIdx = 0;

    const { app, baseUrl } = await startWebHarness({
      customHandler: async () => {
        callIdx += 1;
        if (callIdx === 1) {
          run1Entered.resolve();
          return run1Finish.promise;
        }
        return {
          status: 'ok',
          rawText: JSON.stringify({
            answer: `Fast newer run answer #${callIdx}.`,
            sources_used: [ALDER_RECORD.sourceId],
          }),
        };
      },
    });

    const deps: WorkflowDependencies = {
      config: app.context.config,
      sessionStore: app.context.sessionStore,
      ledger: app.context.ledger,
      releaseGate: app.context.releaseGate,
      transport: app.context.transport,
      logger: app.context.logger,
      sleepFn: async () => {},
    };

    const cookie = await createSessionCookie(baseUrl, 'alder');
    const resolved = app.context.sessionStore.resolveCookieToken(
      cookie.slice('vervain_cf_sid='.length),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const snap = resolved.snapshot;

    // 1. Out-of-order completion: Run 1 starts first (ticket seq 1) and stalls;
    // Run 2 starts second (ticket seq 2) and finishes immediately.
    const slowRun1Promise = runCleanRequestWorkflow(deps, snap);
    await run1Entered.promise;

    const fastRun2 = await runCleanRequestWorkflow(deps, snap);
    expect(fastRun2.releaseDecision).toBe('released');

    run1Finish.resolve({
      status: 'ok',
      rawText: JSON.stringify({
        answer: 'Stale delayed run #1 answer.',
        sources_used: [ALDER_RECORD.sourceId],
      }),
    });
    const slowRun1 = await slowRun1Promise;

    const viewAfterOutOfOrder = app.context.sessionStore.getSessionRunsView(snap.sessionId);
    expect(viewAfterOutOfOrder?.latestSingleRun?.requestId).toBe(fastRun2.requestId);
    expect(viewAfterOutOfOrder?.latestSingleRun?.requestId).not.toBe(slowRun1.requestId);

    // 2. Reset between runs: start a stalled run, issue /api/demo/reset mid-flight, then finish run
    const preResetEntered = createDeferred<void>();
    const preResetFinish = createDeferred<TransportRawResult>();
    let interceptNext = true;

    const customDeps: WorkflowDependencies = {
      ...deps,
      transport: new DeterministicMockGeminiTransport(async () => {
        if (interceptNext) {
          interceptNext = false;
          preResetEntered.resolve();
          return preResetFinish.promise;
        }
        return {
          status: 'ok',
          rawText: JSON.stringify({
            answer: 'Post-reset clean answer.',
            sources_used: [ALDER_RECORD.sourceId],
          }),
        };
      }),
    };

    const preResetPairedPromise = runPairedProofWorkflow(customDeps, snap);
    await preResetEntered.promise;

    const resetHttpRes = await fetch(`${baseUrl}/api/demo/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    expect(resetHttpRes.status).toBe(200);

    preResetFinish.resolve({
      status: 'ok',
      rawText: JSON.stringify({
        answer: 'Delayed pre-reset control reply.',
        sources_used: [ALDER_RECORD.sourceId],
      }),
    });

    const stalePaired = await preResetPairedPromise;
    expect(stalePaired.nativePlusVervain.releaseDecision).toBe('withheld');
    expect(stalePaired.nativePlusVervain.releaseReason).toBe(RELEASE_REASONS.AUTHORITY_MISMATCH);
    expect(stalePaired.nativePlusVervain.releasedAnswerText).toBeNull();

    // Neither pre-reset paired run nor its receipts may appear in post-reset session state
    const stateRes = await fetch(`${baseUrl}/api/demo/state`, {
      headers: { Cookie: cookie },
    });
    const stateBody = (await stateRes.json()) as DemoStateResponse;
    expect(stateBody.latestPairedRun).toBeNull();
    expect(stateBody.recentReceiptIds).toHaveLength(0);

    const staleReceiptFetch = await fetch(
      `${baseUrl}/api/receipts/${stalePaired.nativePlusVervain.receiptId}`,
      { headers: { Cookie: cookie } },
    );
    expect(staleReceiptFetch.status).toBe(404);
  });

  it('blocks duplicate release replay for the same requestId in ResponseReleaseGate', () => {
    const store = new SessionStore({
      secret: TEST_SESSION_SECRET,
      ttlMs: 60_000,
    });
    const gate = new ResponseReleaseGate();
    const { snapshot } = store.createOrRotateSession('alder');

    const first = gate.evaluateRelease({
      requestId: 'req_replay_once_only',
      authorityAtAdmission: snapshot,
      sessionStore: store,
      candidate: {
        rawText: '{"answer":"Authorized summary.","sources_used":["alder/renewal-playbook-v3"]}',
        parsedAnswer: 'Authorized summary.',
        parsedSourcesUsed: [ALDER_RECORD.sourceId],
      },
    });
    expect(first.decision).toBe('released');
    expect(first.reasonCode).toBe(RELEASE_REASONS.AUTHORITY_VERIFIED);

    for (let i = 0; i < 3; i += 1) {
      const replay = gate.evaluateRelease({
        requestId: 'req_replay_once_only',
        authorityAtAdmission: snapshot,
        sessionStore: store,
        candidate: {
          rawText: '{"answer":"Authorized summary.","sources_used":["alder/renewal-playbook-v3"]}',
          parsedAnswer: 'Authorized summary.',
          parsedSourcesUsed: [ALDER_RECORD.sourceId],
        },
      });
      expect(replay.decision).toBe('withheld');
      expect(replay.reasonCode).toBe(RELEASE_REASONS.DUPLICATE_RELEASE_BLOCKED);
      expect(replay.releasedAnswer).toBeNull();
      expect(replay.responseSha256).toBeNull();
    }
  });

  it('withholds Vervain-governed response when mocked output contains exact planted value in answer, raw JSON, or sources_used', async () => {
    const plantedVariants = [
      JSON.stringify({
        answer: `Renewal summary containing ${SYNTHETIC_PLANTED_VALUE}.`,
        sources_used: [ALDER_RECORD.sourceId],
      }),
      JSON.stringify({
        answer: 'Benign answer string.',
        sources_used: [ALDER_RECORD.sourceId],
        hidden_note: SYNTHETIC_PLANTED_VALUE,
      }),
      JSON.stringify({
        answer: 'Benign answer string.',
        sources_used: [SYNTHETIC_PLANTED_VALUE],
      }),
    ];

    let idx = 0;
    const { baseUrl } = await startWebHarness({
      customHandler: () => {
        const rawText = plantedVariants[idx] ?? plantedVariants[0]!;
        idx += 1;
        return { status: 'ok', rawText };
      },
    });

    const cookie = await createSessionCookie(baseUrl, 'alder');

    for (let i = 0; i < plantedVariants.length; i += 1) {
      const res = await fetch(`${baseUrl}/api/demo/run-clean`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        run: NonNullable<DemoStateResponse['latestSingleRun']>;
      };
      expect(body.run.releaseDecision).toBe('withheld');
      expect(body.run.releaseReason).toBe(RELEASE_REASONS.PLANTED_VALUE_DETECTED);
      expect(body.run.plantedValueInResponse).toBe(true);
      expect(body.run.releasedAnswerText).toBeNull();
      expect(body.run.receipt.release.response_sha256).toBeNull();
      expect(JSON.stringify(body.run.receipt)).not.toContain(SYNTHETIC_PLANTED_VALUE);
    }
  });

  it('withholds response with HTTP 500 when simulated ledger write fails because release is receipt-bound', async () => {
    const { baseUrl, app, spy } = await startWebHarness();
    const cookie = await createSessionCookie(baseUrl, 'alder');

    app.context.ledger.setSimulatedWriteFailureForTest(true);

    const failedClean = await fetch(`${baseUrl}/api/demo/run-clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    expect(failedClean.status).toBe(500);
    const errText = await failedClean.text();
    const errJson = JSON.parse(errText) as { error: { code: string; message: string } };
    expect(errJson.error.code).toBe(API_ERROR_CODES.INTERNAL_ERROR);

    // Transport WAS called, yet zero model answer text or stack trace reached the caller
    expect(spy.getCapturedEnvelopes()).toHaveLength(1);
    expect(errText).not.toContain('12 percent');
    expect(errText).not.toContain('at buildAndAppendRunReceipt');
    expect(errText).not.toContain(SYNTHETIC_PLANTED_VALUE);

    // State view must NOT have committed the unreceipted run
    const stateWhileBroken = (await (
      await fetch(`${baseUrl}/api/demo/state`, { headers: { Cookie: cookie } })
    ).json()) as DemoStateResponse;
    expect(stateWhileBroken.latestSingleRun).toBeNull();
    expect(stateWhileBroken.recentReceiptIds).toHaveLength(0);

    // Re-enable ledger writes -> subsequent run succeeds and ledger chain remains valid
    app.context.ledger.setSimulatedWriteFailureForTest(false);
    const recoveredClean = await fetch(`${baseUrl}/api/demo/run-clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    expect(recoveredClean.status).toBe(200);
    const recoveredBody = (await recoveredClean.json()) as {
      run: NonNullable<DemoStateResponse['latestSingleRun']>;
      ledgerSummary: DemoStateResponse['ledgerSummary'];
    };
    expect(recoveredBody.run.releaseDecision).toBe('released');
    expect(recoveredBody.ledgerSummary.verified).toBe(true);
  });
});

describe('Campaign E: Recursive Content-Free Hygiene and Canonical Hash-Chain Tamper Detection', () => {
  it('confirms receipts, ledger events, structured logs, and error responses are recursively content-free', async () => {
    const { baseUrl, app } = await startWebHarness();
    const cookie = await createSessionCookie(baseUrl, 'alder');
    const resolved = app.context.sessionStore.resolveCookieToken(
      cookie.slice('vervain_cf_sid='.length),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const pairedRes = await fetch(`${baseUrl}/api/demo/run-paired`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    const pairedBody = (await pairedRes.json()) as {
      pairedRun: NonNullable<DemoStateResponse['latestPairedRun']>;
    };

    const revokeRes = await fetch(`${baseUrl}/api/demo/revoke-during-generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{}',
    });
    const revokeBody = (await revokeRes.json()) as {
      run: NonNullable<DemoStateResponse['latestSingleRun']>;
    };

    // Trigger several error responses (400, 401, 404, 415)
    const err400 = await (
      await fetch(`${baseUrl}/api/demo/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{"persona":"${SYNTHETIC_PLANTED_VALUE}"}`,
      })
    ).json();
    const err401 = await (await fetch(`${baseUrl}/api/demo/state`)).json();
    const err404 = await (
      await fetch(`${baseUrl}/api/receipts/rcpt_missing_000`, { headers: { Cookie: cookie } })
    ).json();
    const err415 = await (
      await fetch(`${baseUrl}/api/demo/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Cookie: cookie },
        body: ALDER_RECORD.text,
      })
    ).json();

    const releasedAnswer = pairedBody.pairedRun.nativePlusVervain.releasedAnswerText ?? '';
    const forbiddenSubstrings = getProtectedFixtureSubstrings([
      cookie,
      resolved.snapshot.sessionId,
      TEST_SESSION_SECRET,
      TEST_FAKE_API_KEY,
      releasedAnswer,
    ]);

    const allReceipts = [
      pairedBody.pairedRun.nativeOnly.receipt,
      pairedBody.pairedRun.nativePlusVervain.receipt,
      revokeBody.run.receipt,
    ];

    for (const rcpt of allReceipts) {
      expect(findProhibitedContentInObject(rcpt, forbiddenSubstrings)).toBeNull();
      const events = app.context.ledger.getEventsForRequest(rcpt.request_id);
      expect(events.length).toBe(6);
      expect(findProhibitedContentInObject(events, forbiddenSubstrings)).toBeNull();

      const exportedText = await (
        await fetch(`${baseUrl}/api/receipts/${rcpt.receipt_id}/export`, {
          headers: { Cookie: cookie },
        })
      ).text();
      expect(
        findProhibitedContentInObject(JSON.parse(exportedText), forbiddenSubstrings),
      ).toBeNull();
    }

    expect(
      findProhibitedContentInObject(app.context.logger.snapshot(), forbiddenSubstrings),
    ).toBeNull();
    expect(
      findProhibitedContentInObject([err400, err401, err404, err415], forbiddenSubstrings),
    ).toBeNull();
  });

  it('causes verifyChain() failure on tampering with every canonical event field, recomputed event hash, and event order', () => {
    const createPopulatedLedger = (): AuditLedger => {
      const store = new SessionStore({ secret: TEST_SESSION_SECRET, ttlMs: 60_000 });
      const ledger = new AuditLedger();
      const { snapshot } = store.createOrRotateSession('alder');
      const broken = retrieveBrokenControlChunks('cross_tenant_filter_omission');
      const admission = evaluateContextAdmission(broken.chunks, snapshot);

      for (const reqId of ['req_ledger_a', 'req_ledger_b']) {
        buildAndAppendRunReceipt({
          ledger,
          requestId: reqId,
          scenario: 'paired_defect',
          arm: 'native_plus_vervain',
          authorityAtAdmission: snapshot,
          policyEpochAtRelease: snapshot.policyEpoch,
          querySha256: FROZEN_QUERY_SHA256,
          retrievedChunks: broken.chunks,
          admissionDecisions: admission.decisions,
          envelopeSha256: '1'.repeat(64),
          admittedChunkCount: 1,
          foreignTenantChunkInEnvelope: false,
          modelId: 'gemini-2.5-flash',
          transportMode: 'mock',
          providerCallAttempted: true,
          providerOutcome: 'succeeded',
          providerLatencyMs: 8,
          providerRetryCount: 0,
          releaseDecision: 'released',
          releaseReasonCode: 'authority_verified',
          responseSha256: '2'.repeat(64),
          responseUtf8Bytes: 48,
          plantedValueExactMatch: false,
          permittedTaskCompleted: true,
          permittedTaskBasis: 'released_authorized_answer_under_unchanged_epoch',
          startedAtMs: 1_760_000_000_000,
          completedAtMs: 1_760_000_000_010,
        });
      }
      expect(ledger.verifyChain().verified).toBe(true);
      expect(ledger.verifyChain().checkedEvents).toBe(12);
      expect(ledger.verifyChain().checkedReceipts).toBe(2);
      return ledger;
    };

    const fieldMutators: ReadonlyArray<{
      name: string;
      targetIndex: number;
      mutate: (ev: LedgerEventRecord) => LedgerEventRecord;
    }> = [
      {
        name: 'schema_version',
        targetIndex: 0,
        mutate: (ev) => ({ ...ev, schema_version: `${LEDGER_EVENT_SCHEMA_VERSION}.tampered` }),
      },
      {
        name: 'event_index',
        targetIndex: 2,
        mutate: (ev) => ({ ...ev, event_index: 99 }),
      },
      {
        name: 'event_id',
        targetIndex: 1,
        mutate: (ev) => ({ ...ev, event_id: 'evt_forged_id' }),
      },
      {
        name: 'request_id',
        targetIndex: 3,
        mutate: (ev) => ({ ...ev, request_id: 'req_forged' }),
      },
      {
        name: 'session_digest_sha256',
        targetIndex: 4,
        mutate: (ev) => ({ ...ev, session_digest_sha256: 'f'.repeat(64) }),
      },
      {
        name: 'stage',
        targetIndex: 1,
        mutate: (ev) => ({ ...ev, stage: 'release_decision' }),
      },
      {
        name: 'timestamp_iso',
        targetIndex: 5,
        mutate: (ev) => ({ ...ev, timestamp_iso: '2099-01-01T00:00:00.000Z' }),
      },
      {
        name: 'payload nested value',
        targetIndex: 2,
        mutate: (ev) => ({
          ...ev,
          payload: { ...ev.payload, foreign_tenant_chunk_present: true },
        }),
      },
      {
        name: 'prev_event_sha256',
        targetIndex: 6,
        mutate: (ev) => ({ ...ev, prev_event_sha256: 'e'.repeat(64) }),
      },
      {
        name: 'event_sha256',
        targetIndex: 7,
        mutate: (ev) => ({ ...ev, event_sha256: 'd'.repeat(64) }),
      },
      {
        name: 'last event payload mutated WITH attacker-recomputed event_sha256',
        targetIndex: 11,
        mutate: (ev) => {
          const updatedBase: Omit<LedgerEventRecord, 'event_sha256'> = {
            schema_version: ev.schema_version,
            event_index: ev.event_index,
            event_id: ev.event_id,
            request_id: ev.request_id,
            session_digest_sha256: ev.session_digest_sha256,
            stage: ev.stage,
            timestamp_iso: ev.timestamp_iso,
            payload: { ...ev.payload, permitted_task_completed: false },
            prev_event_sha256: ev.prev_event_sha256,
          };
          return {
            ...updatedBase,
            event_sha256: computeEventSha256(updatedBase),
          };
        },
      },
    ];

    for (const item of fieldMutators) {
      const ledger = createPopulatedLedger();
      ledger.tamperEventAtIndexForTest(item.targetIndex, item.mutate);
      const check = ledger.verifyChain();
      expect(check.verified, item.name).toBe(false);
      expect(check.failureReason, item.name).not.toBeNull();
    }

    // Event order swap fails verification
    const swappedLedger = createPopulatedLedger();
    swappedLedger.swapEventsForTest(1, 2);
    const swapCheck = swappedLedger.verifyChain();
    expect(swapCheck.verified).toBe(false);

    // Non-finite numbers rejected by canonicalJsonString
    expect(() => canonicalJsonString({ bad: Number.NaN })).toThrow(/non-finite/i);
    expect(() => canonicalJsonString({ bad: Number.POSITIVE_INFINITY })).toThrow(/non-finite/i);
    expect(() => canonicalJsonString({ bad: Number.NEGATIVE_INFINITY })).toThrow(/non-finite/i);
  });
});

describe('Campaign F: Web Ingress Hardening, Path Traversal, Headers, Idempotency, Rate Limits, and Caps', () => {
  it('enforces CSRF cross-origin Origin and Sec-Fetch-Site: cross-site rejection while permitting same-origin', async () => {
    const { baseUrl, port } = await startWebHarness();
    const cookie = await createSessionCookie(baseUrl, 'alder');

    const crossOriginCases: ReadonlyArray<Record<string, string>> = [
      { Origin: 'https://evil.attacker.invalid' },
      { Origin: 'null' },
      { Origin: `http://127.0.0.1:${port + 1}` },
      { Origin: ':::malformed-origin:::' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site' },
    ];

    for (const extraHeaders of crossOriginCases) {
      const res = await fetch(`${baseUrl}/api/demo/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          ...extraHeaders,
        },
        body: '{}',
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: API_ERROR_CODES.CSRF_ORIGIN_REJECTED },
      });
    }

    // Matching same-origin Origin + Sec-Fetch-Site: same-origin succeeds
    const allowedSameOrigin = await fetch(`${baseUrl}/api/demo/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Cookie: cookie,
        Origin: `http://127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: '{}',
    });
    expect(allowedSameOrigin.status).toBe(200);
  });

  it('rejects non-HTTP(S) schemes, userinfo/path-bearing Origin headers, and Sec-Fetch-Site: same-site on POST mutations', async () => {
    const { baseUrl, port } = await startWebHarness();
    const cookie = await createSessionCookie(baseUrl, 'alder');

    const subtleCsrfHeaders: ReadonlyArray<Record<string, string>> = [
      { Origin: `ftp://127.0.0.1:${port}` },
      { Origin: `http://user@127.0.0.1:${port}/unexpected-path` },
      { 'Sec-Fetch-Site': 'same-site' },
    ];

    for (const extraHeaders of subtleCsrfHeaders) {
      const res = await fetch(`${baseUrl}/api/demo/reset`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          ...extraHeaders,
        },
        body: '{}',
      });
      expect(res.status).toBe(403);
    }
  });

  it('returns 415 on wrong or missing Content-Type headers for POST endpoints', async () => {
    const { baseUrl } = await startWebHarness();
    const cookie = await createSessionCookie(baseUrl, 'alder');

    for (const ct of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=---123',
      '',
    ]) {
      const headers: Record<string, string> = { Cookie: cookie };
      if (ct) headers['Content-Type'] = ct;
      const res = await fetch(`${baseUrl}/api/demo/run-clean`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({
        error: { code: API_ERROR_CODES.INVALID_CONTENT_TYPE },
      });
    }
  });

  it('rejects prefix-confused Content-Type values such as application/jsonp with 415', async () => {
    const { baseUrl } = await startWebHarness();

    const res = await fetch(`${baseUrl}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jsonp' },
      body: '{"persona":"alder"}',
    });
    expect(res.status).toBe(415);
  });

  it('returns 413 when request body exceeds 8192 UTF-8 bytes and accepts bodies within limit', async () => {
    const { baseUrl } = await startWebHarness();

    // Exactly 8192-byte whitespace-padded valid payload -> 200 (not 413)
    const baseJson = '{"persona":"alder"}';
    const exact8192 = `${baseJson}${' '.repeat(8192 - baseJson.length)}`;
    expect(Buffer.byteLength(exact8192, 'utf8')).toBe(8192);

    const okRes = await fetch(`${baseUrl}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: exact8192,
    });
    expect(okRes.status).toBe(200);

    // 8193-byte payload -> must return HTTP 413 JSON rather than resetting socket before response flush
    const overBody = `{"persona":"${'a'.repeat(8180)}"}`;
    expect(Buffer.byteLength(overBody, 'utf8')).toBeGreaterThan(8192);

    const overRes = await fetch(`${baseUrl}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: overBody,
    });
    expect(overRes.status).toBe(413);
    expect(await overRes.json()).toMatchObject({
      error: { code: API_ERROR_CODES.PAYLOAD_TOO_LARGE },
    });
  });

  it('returns 405 Method Not Allowed on wrong HTTP methods across probes, API routes, and static assets', async () => {
    const { baseUrl } = await startWebHarness();
    const cookie = await createSessionCookie(baseUrl, 'alder');

    const methodMatrix: ReadonlyArray<readonly [string, string]> = [
      ['POST', '/healthz'],
      ['DELETE', '/readyz'],
      ['GET', '/api/demo/session'],
      ['GET', '/api/demo/reset'],
      ['GET', '/api/demo/run-paired'],
      ['GET', '/api/demo/run-clean'],
      ['GET', '/api/demo/revoke-during-generation'],
      ['POST', '/api/demo/state'],
      ['POST', '/api/demo/scoped-attention'],
      ['POST', '/api/ledger/verify'],
      ['POST', '/api/receipts/rcpt_abcdef123456'],
      ['PUT', '/api/demo/session'],
      ['PATCH', '/api/demo/run-clean'],
      ['DELETE', '/api/demo/state'],
      ['OPTIONS', '/api/demo/session'],
      ['POST', '/index.html'],
      ['PUT', '/assets/app.js'],
      ['DELETE', '/'],
    ];

    for (const [method, route] of methodMatrix) {
      const res = await fetch(`${baseUrl}${route}`, {
        method,
        headers: { Cookie: cookie },
      });
      expect(res.status, `${method} ${route}`).toBe(405);
      expect(await res.json()).toMatchObject({
        error: { code: API_ERROR_CODES.METHOD_NOT_ALLOWED },
      });
    }
  });

  it('blocks static path traversal outside clientDistDir and emits CSP, XFO, and nosniff headers on all responses', async () => {
    const parentTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vervain-adv-static-'));
    tempDirsToClean.push(parentTmp);

    const clientDistDir = path.join(parentTmp, 'public-client');
    await fs.mkdir(clientDistDir, { recursive: true });
    await fs.writeFile(path.join(clientDistDir, 'index.html'), '<!doctype html><title>Demo</title>');
    await fs.writeFile(
      path.join(parentTmp, 'outside-canary.txt'),
      'OUTSIDE_CLIENT_ROOT_CANARY_999',
    );

    const { baseUrl } = await startWebHarness({ clientDistDir });

    const traversalPaths = [
      '/../outside-canary.txt',
      '/..%2foutside-canary.txt',
      '/..%2f..%2fpackage.json',
      '/%2e%2e%2foutside-canary.txt',
      '/assets/..%2f..%2foutside-canary.txt',
      '/%00',
      '/index.html%00.png',
      '/%E0%A4%A',
    ];

    for (const target of traversalPaths) {
      const res = await fetch(`${baseUrl}${target}`);
      expect([400, 403, 404]).toContain(res.status);
      const text = await res.text();
      expect(text).not.toContain('OUTSIDE_CLIENT_ROOT_CANARY_999');
      assertHardeningHeaders(res.headers, false);
    }

    // Valid static asset GET and HEAD succeed with full hardening headers
    const indexGet = await fetch(`${baseUrl}/`);
    expect(indexGet.status).toBe(200);
    expect(await indexGet.text()).toContain('<title>Demo</title>');
    assertHardeningHeaders(indexGet.headers, false);

    const indexHead = await fetch(`${baseUrl}/index.html`, { method: 'HEAD' });
    expect(indexHead.status).toBe(200);
    assertHardeningHeaders(indexHead.headers, false);

    // Health, readiness, and API routes include hardening headers + Cache-Control: no-store
    const healthRes = await fetch(`${baseUrl}/healthz`);
    expect(healthRes.status).toBe(200);
    assertHardeningHeaders(healthRes.headers, true);

    const readyRes = await fetch(`${baseUrl}/readyz`);
    expect(readyRes.status).toBe(200);
    assertHardeningHeaders(readyRes.headers, true);
  });

  it('handles malformed scheme-relative URLs and invalid Host headers with HTTP 400 instead of unhandled rejection', async () => {
    const { app } = await startWebHarness();

    const invokeMockReq = async (
      rawUrl: string,
      hostHeader: string,
    ): Promise<{ statusCode: number; body: string }> => {
      const headersMap = new Map<string, string>();
      let endedBody = '';
      const mockReq = {
        method: 'GET',
        url: rawUrl,
        headers: { host: hostHeader },
        rawHeaders: ['Host', hostHeader],
      } as unknown as IncomingMessage;

      const mockRes = {
        statusCode: 200,
        headersSent: false,
        setHeader: (k: string, v: string) => {
          headersMap.set(k.toLowerCase(), v);
        },
        end: (chunk?: string) => {
          endedBody = chunk ?? '';
        },
      } as unknown as ServerResponse;

      await handleApiOrProbeRequest(mockReq, mockRes, app.context);
      return { statusCode: mockRes.statusCode, body: endedBody };
    };

    const badTarget = await invokeMockReq('//[invalid]/api/demo/state', '127.0.0.1:8080');
    expect(badTarget.statusCode).toBe(400);

    const badHost = await invokeMockReq('/api/demo/state', '[invalid-ipv6');
    expect(badHost.statusCode).toBe(400);
  });

  it('coalesces concurrent in-flight paired-proof requests for the same session without multiplying Gemini calls', async () => {
    const firstCallEntered = createDeferred<void>();
    const allFiveIngressed = createDeferred<void>();
    const allowFinish = createDeferred<void>();
    let callCounter = 0;

    const { baseUrl, app, spy } = await startWebHarness({
      customHandler: async (env) => {
        callCounter += 1;
        if (callCounter === 1) {
          firstCallEntered.resolve();
          await allowFinish.promise;
        }
        return {
          status: 'ok',
          rawText: JSON.stringify({
            answer: `Coalesced response for ${env.armMode}.`,
            sources_used: [ALDER_RECORD.sourceId],
          }),
        };
      },
    });

    const cookie = await createSessionCookie(baseUrl, 'alder');

    let pairedIngressCount = 0;
    app.server.on('request', (req) => {
      if (req.url === '/api/demo/run-paired') {
        req.on('end', () => {
          pairedIngressCount += 1;
          if (pairedIngressCount === 5) {
            allFiveIngressed.resolve();
          }
        });
      }
    });

    // Launch 5 concurrent POST /api/demo/run-paired requests on the same session
    const concurrentRequests = Array.from({ length: 5 }, () =>
      fetch(`${baseUrl}/api/demo/run-paired`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      }),
    );

    await Promise.all([firstCallEntered.promise, allFiveIngressed.promise]);
    allowFinish.resolve();

    const responses = await Promise.all(concurrentRequests);
    const runGroupIds = new Set<string>();
    for (const res of responses) {
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        pairedRun: NonNullable<DemoStateResponse['latestPairedRun']>;
      };
      runGroupIds.add(body.pairedRun.runGroupId);
    }

    // All 5 callers received the exact same coalesced paired run, and transport ran only 2 calls (1 control + 1 Vervain)
    expect(runGroupIds.size).toBe(1);
    expect(spy.getCapturedEnvelopes()).toHaveLength(2);
  });

  it('enforces per-session mutation rate limits, per-session Gemini call caps, and instance-wide Gemini window caps', async () => {
    // 1. Per-session mutation rate limit + window recovery
    {
      const { baseUrl, advanceTimeMs } = await startWebHarness({
        envOverrides: {
          RATE_LIMIT_MUTATIONS_PER_MINUTE: '3',
          SESSION_TTL_MS: '300000',
        },
      });
      const cookie = await createSessionCookie(baseUrl, 'alder');

      for (let i = 0; i < 3; i += 1) {
        const okRes = await fetch(`${baseUrl}/api/demo/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: '{}',
        });
        expect(okRes.status).toBe(200);
      }

      const throttled = await fetch(`${baseUrl}/api/demo/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      });
      expect(throttled.status).toBe(429);
      expect(await throttled.json()).toMatchObject({
        error: { code: API_ERROR_CODES.RATE_LIMIT_EXCEEDED },
      });

      advanceTimeMs(60_001);
      const recovered = await fetch(`${baseUrl}/api/demo/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      });
      expect(recovered.status).toBe(200);

      await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
      activeServer = null;
    }

    // 2. Per-session Gemini call cap (3 max: run-paired uses 2, run-clean uses 1, next fails 429 even after /reset)
    {
      const { baseUrl } = await startWebHarness({
        envOverrides: {
          MAX_GEMINI_CALLS_PER_SESSION: '3',
          MAX_GEMINI_CALLS_PER_WINDOW: '50',
          RATE_LIMIT_MUTATIONS_PER_MINUTE: '50',
        },
      });
      const cookie = await createSessionCookie(baseUrl, 'alder');

      const p1 = await fetch(`${baseUrl}/api/demo/run-paired`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      });
      expect(p1.status).toBe(200);

      const c1 = await fetch(`${baseUrl}/api/demo/run-clean`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      });
      expect(c1.status).toBe(200);

      // Session Reset must NOT replenish session Gemini call budget
      await fetch(`${baseUrl}/api/demo/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      });

      const overSessionBudget = await fetch(`${baseUrl}/api/demo/run-clean`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: '{}',
      });
      expect(overSessionBudget.status).toBe(429);
      expect(await overSessionBudget.json()).toMatchObject({
        error: { code: API_ERROR_CODES.BUDGET_EXCEEDED },
      });

      await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
      activeServer = null;
    }

    // 3. Instance-wide Gemini window cap stops fresh session rotation from bypassing global budget
    {
      const { baseUrl } = await startWebHarness({
        envOverrides: {
          MAX_GEMINI_CALLS_PER_SESSION: '10',
          MAX_GEMINI_CALLS_PER_WINDOW: '2',
        },
      });
      const cookie1 = await createSessionCookie(baseUrl, 'alder');
      const r1 = await fetch(`${baseUrl}/api/demo/run-paired`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie1 },
        body: '{}',
      });
      expect(r1.status).toBe(200);

      const cookie2 = await createSessionCookie(baseUrl, 'alder');
      const r2 = await fetch(`${baseUrl}/api/demo/run-clean`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie2 },
        body: '{}',
      });
      expect(r2.status).toBe(429);
      expect(await r2.json()).toMatchObject({
        error: { code: API_ERROR_CODES.BUDGET_EXCEEDED },
      });
    }
  });
});
