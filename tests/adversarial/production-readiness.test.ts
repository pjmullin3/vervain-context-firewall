/**
 * Adversarial production-startup and readiness tests. A container must not be
 * declared ready with an unusable live provider, and production authority cookies
 * must never be signed by a process-random fallback secret.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createAppInstance, type AppInstance } from '../../src/server/app.js';
import { loadServerConfig } from '../../src/server/config.js';

let activeApp: AppInstance | null = null;

afterEach(async () => {
  if (!activeApp) return;
  const server = activeApp.server;
  activeApp = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Daybreak: production startup and readiness', () => {
  it('refuses production configuration without a durable 32-byte session secret', () => {
    expect(() =>
      loadServerConfig({
        NODE_ENV: 'production',
        DEMO_MODE: 'live',
        GEMINI_API_KEY: 'test_only_key_not_used_for_network',
      }),
    ).toThrow(/SESSION_SECRET/);

    expect(() =>
      loadServerConfig({
        NODE_ENV: 'production',
        DEMO_MODE: 'live',
        GEMINI_API_KEY: 'test_only_key_not_used_for_network',
        SESSION_SECRET: 'too-short',
      }),
    ).toThrow(/SESSION_SECRET/);
  });

  it('returns 503 not-ready when live mode has no Gemini key', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'production',
      DEMO_MODE: 'live',
      SESSION_SECRET: 'production_readiness_secret_at_least_32_bytes',
    });
    activeApp = createAppInstance({ config, emitLogsToStdout: false });
    await new Promise<void>((resolve) => {
      activeApp!.server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (activeApp.server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'not_ready',
      gemini_adapter_mode: 'live',
      gemini_key_configured: false,
      demo_workflow_ready: false,
    });
  });
});
