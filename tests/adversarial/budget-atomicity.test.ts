/**
 * Adversarial quota-accounting test. A failed instance-wide reservation must
 * not consume the caller's per-session Gemini allowance without a provider call.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createAppInstance, type AppInstance } from '../../src/server/app.js';
import { loadServerConfig, type ServerConfig } from '../../src/server/config.js';

let activeApp: AppInstance | null = null;

afterEach(async () => {
  if (!activeApp) return;
  const server = activeApp.server;
  activeApp = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createSession(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/demo/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: 'alder' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}

async function runClean(baseUrl: string, cookie: string): Promise<Response> {
  return await fetch(`${baseUrl}/api/demo/run-clean`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  });
}

describe('Daybreak: atomic provider-budget reservation', () => {
  it('rolls back session quota when the instance window is full', async () => {
    let nowMs = 1_700_000_000_000;
    const baseConfig = loadServerConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'mock',
      SESSION_SECRET: 'daybreak_budget_secret_at_least_32_bytes',
      MAX_GEMINI_CALLS_PER_SESSION: '1',
      MAX_GEMINI_CALLS_PER_WINDOW: '1',
    });
    const config: ServerConfig = Object.freeze({
      ...baseConfig,
      geminiWindowMs: 1_000,
    });
    activeApp = createAppInstance({
      config,
      nowFn: () => nowMs,
      emitLogsToStdout: false,
    });
    await new Promise<void>((resolve) => {
      activeApp!.server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (activeApp.server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const firstCookie = await createSession(baseUrl);
    const secondCookie = await createSession(baseUrl);

    expect((await runClean(baseUrl, firstCookie)).status).toBe(200);
    expect((await runClean(baseUrl, secondCookie)).status).toBe(429);

    nowMs += 2_000;
    expect((await runClean(baseUrl, secondCookie)).status).toBe(200);
  });
});
