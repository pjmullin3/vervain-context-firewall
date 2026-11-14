/**
 * Adversarial temporal-consistency tests across the real HTTP concurrency path.
 * A response generated under an obsolete session generation must never be released
 * or committed after reset.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { DemoStateResponse } from '../../src/shared/contracts.js';
import { createAppInstance, type AppInstance } from '../../src/server/app.js';
import { loadServerConfig } from '../../src/server/config.js';
import { ALDER_RECORD } from '../../src/server/fixture.js';
import { DeterministicMockGeminiTransport } from '../../src/server/gemini.js';

let activeApp: AppInstance | null = null;

afterEach(async () => {
  if (!activeApp) return;
  const server = activeApp.server;
  activeApp = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Daybreak: reset during generation', () => {
  it('withholds the late answer and does not resurrect cleared run state', async () => {
    let signalProviderInvoked!: () => void;
    const providerInvoked = new Promise<void>((resolve) => {
      signalProviderInvoked = resolve;
    });
    let releaseProvider!: () => void;
    const providerMayComplete = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });

    const transport = new DeterministicMockGeminiTransport(async () => {
      signalProviderInvoked();
      await providerMayComplete;
      return {
        status: 'ok',
        rawText: JSON.stringify({
          answer: 'Authorized Alder answer generated under the old session generation.',
          sources_used: [ALDER_RECORD.sourceId],
        }),
      };
    });
    const config = loadServerConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'mock',
      SESSION_SECRET: 'daybreak_temporal_secret_at_least_32_bytes',
    });
    activeApp = createAppInstance({ config, transport, emitLogsToStdout: false });
    await new Promise<void>((resolve) => {
      activeApp!.server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (activeApp.server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const sessionResponse = await fetch(`${baseUrl}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: 'alder' }),
    });
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';')[0] ?? '';

    const lateRunResponsePromise = fetch(`${baseUrl}/api/demo/run-clean`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    await providerInvoked;

    const resetResponse = await fetch(`${baseUrl}/api/demo/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    expect(resetResponse.status).toBe(200);

    releaseProvider();
    const lateRunResponse = await lateRunResponsePromise;
    expect(lateRunResponse.status).toBe(200);
    const lateRunBody = (await lateRunResponse.json()) as {
      run: NonNullable<DemoStateResponse['latestSingleRun']>;
    };
    expect(lateRunBody.run.releaseDecision).toBe('withheld');
    expect(lateRunBody.run.releaseReason).toBe('authority_mismatch');
    expect(lateRunBody.run.releasedAnswerText).toBeNull();
    expect(lateRunBody.run.permittedTaskCompleted).toBe(false);

    const stateResponse = await fetch(`${baseUrl}/api/demo/state`, {
      headers: { Cookie: cookie },
    });
    expect(stateResponse.status).toBe(200);
    const state = (await stateResponse.json()) as DemoStateResponse;
    expect(state.latestSingleRun).toBeNull();
    expect(state.recentReceiptIds).toEqual([]);
  });
});
