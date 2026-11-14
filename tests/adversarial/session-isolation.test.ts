/**
 * Adversarial multi-session isolation tests. Resource pressure must never evict
 * a different still-valid session as a side effect of unauthenticated creation.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createAppInstance, type AppInstance } from '../../src/server/app.js';
import { loadServerConfig, type ServerConfig } from '../../src/server/config.js';
import { SessionCapacityError, SessionStore } from '../../src/server/session.js';

let activeApp: AppInstance | null = null;

afterEach(async () => {
  if (!activeApp) return;
  const server = activeApp.server;
  activeApp = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('Daybreak: session isolation under capacity pressure', () => {
  it('fails closed at capacity without invalidating an existing live session', () => {
    const store = new SessionStore({
      secret: 'daybreak_capacity_secret_at_least_32_bytes',
      ttlMs: 60_000,
      maxSessions: 2,
    });

    const first = store.createOrRotateSession('alder');
    store.createOrRotateSession('beacon');

    expect(() => store.createOrRotateSession('alder')).toThrow(SessionCapacityError);
    expect(store.resolveCookieToken(first.cookieToken)).toMatchObject({ ok: true });
  });

  it('allows an authenticated rotation to replace its own capacity slot', () => {
    const store = new SessionStore({
      secret: 'daybreak_rotation_secret_at_least_32_bytes',
      ttlMs: 60_000,
      maxSessions: 1,
    });
    const first = store.createOrRotateSession('alder');

    const rotated = store.createOrRotateSession('beacon', first.cookieToken);

    expect(store.resolveCookieToken(first.cookieToken)).toMatchObject({ ok: false });
    expect(store.resolveCookieToken(rotated.cookieToken)).toMatchObject({ ok: true });
  });

  it('returns 503 at HTTP capacity while the existing session remains usable', async () => {
    const baseConfig = loadServerConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'mock',
      SESSION_SECRET: 'daybreak_http_capacity_secret_32_bytes',
    });
    const config: ServerConfig = Object.freeze({
      ...baseConfig,
      maxSessionsInMemory: 1,
    });
    activeApp = createAppInstance({ config, emitLogsToStdout: false });
    await new Promise<void>((resolve) => {
      activeApp!.server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (activeApp.server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const firstResponse = await fetch(`${baseUrl}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: 'alder' }),
    });
    expect(firstResponse.status).toBe(200);
    const firstCookie = firstResponse.headers.get('set-cookie')?.split(';')[0] ?? '';

    const overflowResponse = await fetch(`${baseUrl}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: 'beacon' }),
    });
    expect(overflowResponse.status).toBe(503);
    await expect(overflowResponse.json()).resolves.toMatchObject({
      error: { code: 'session_capacity_reached' },
    });

    const existingState = await fetch(`${baseUrl}/api/demo/state`, {
      headers: { Cookie: firstCookie },
    });
    expect(existingState.status).toBe(200);
  });
});
