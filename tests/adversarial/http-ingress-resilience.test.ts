/**
 * Adversarial HTTP-ingress tests for inputs that must fail closed without
 * rejecting the async request callback or destabilizing the server process.
 */

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createAppInstance, type AppInstance } from '../../src/server/app.js';
import { loadServerConfig } from '../../src/server/config.js';
import {
  handleApiOrProbeRequest,
  type ApiRouterContext,
} from '../../src/server/routes.js';

let activeApp: AppInstance | null = null;

afterEach(async () => {
  if (!activeApp) return;
  const server = activeApp.server;
  activeApp = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function sendRawRequest(port: number, request: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.end(request);
    });
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

describe('Daybreak: HTTP ingress resilience', () => {
  it('handles an invalid Host authority as a bounded 400 response', async () => {
    const request = new http.IncomingMessage(new net.Socket());
    request.method = 'GET';
    request.url = '/healthz';
    request.headers.host = '[';
    const response = new http.ServerResponse(request);

    await expect(
      handleApiOrProbeRequest(
        request,
        response,
        null as unknown as ApiRouterContext,
      ),
    ).resolves.toBe(true);
    expect(response.statusCode).toBe(400);
  });

  it('keeps the real server healthy after a malformed Host request', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'mock',
      SESSION_SECRET: 'daybreak_http_test_secret_32_bytes_minimum',
    });
    activeApp = createAppInstance({ config, emitLogsToStdout: false });
    await new Promise<void>((resolve) => {
      activeApp!.server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (activeApp.server.address() as AddressInfo).port;

    const malformedResponse = await sendRawRequest(
      port,
      'GET /healthz HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n',
    );
    expect(malformedResponse).toMatch(/^HTTP\/1\.1 400 /);

    const healthyResponse = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(healthyResponse.status).toBe(200);
    await expect(healthyResponse.json()).resolves.toEqual({ status: 'alive' });
  });

  it('rejects a JSON-prefix media type instead of treating it as application/json', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'mock',
      SESSION_SECRET: 'daybreak_content_type_secret_32_bytes',
    });
    activeApp = createAppInstance({ config, emitLogsToStdout: false });
    await new Promise<void>((resolve) => {
      activeApp!.server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (activeApp.server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jsonp' },
      body: JSON.stringify({ persona: 'alder' }),
    });

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_content_type' },
    });
  });
});
