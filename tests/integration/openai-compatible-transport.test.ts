/**
 * Responsibility: Runs the unchanged paired-proof workflow through the OpenAI-compatible
 * chat-completions transport against a local fake server, and checks selection, the request
 * contract (temperature 0, JSON schema), and status mapping.
 * Trust boundary: Local loopback HTTP only; no live provider is contacted.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadServerConfig } from '../../src/server/config.js';
import { BEACON_RECORD, ALDER_RECORD, SYNTHETIC_PLANTED_VALUE } from '../../src/server/fixture.js';
import { SpyGeminiTransport } from '../../src/server/gemini.js';
import { AuditLedger } from '../../src/server/ledger.js';
import {
  loadOpenAICompatibleSettings,
  OpenAICompatibleChatTransport,
} from '../../src/server/openai-compatible.js';
import { SafeStructuredLogger } from '../../src/server/redaction.js';
import { ResponseReleaseGate } from '../../src/server/release.js';
import { SessionStore } from '../../src/server/session.js';
import { runPairedProofWorkflow } from '../../src/server/workflows.js';

const MODEL = 'fake-open-weight-model';

interface CapturedRequest {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

describe('OpenAI-compatible transport behind the unchanged Vervain gates', () => {
  const captured: CapturedRequest[] = [];
  let forcedStatus: number | null = null;
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (part: Buffer) => {
        raw += part.toString('utf8');
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        captured.push({ path: req.url ?? '', body });
        if (forcedStatus !== null) {
          res.writeHead(forcedStatus, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        const messages = body['messages'] as { role: string; content: string }[];
        const user = messages.find((m) => m.role === 'user')?.content ?? '';
        const sources = [...user.matchAll(/source_id=([^\s\]]+)/g)].map((m) => m[1]);
        const content = JSON.stringify({
          answer: 'Northstar renewals carry a 4 percent standard uplift.',
          sources_used: [...new Set(sources)],
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-fake',
            object: 'chat.completion',
            model: body['model'],
            choices: [
              { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is selected only by an explicit PROVIDER=openai_compatible', () => {
    expect(loadOpenAICompatibleSettings({})).toBeNull();
    expect(
      loadOpenAICompatibleSettings({ OPENAI_COMPAT_BASE_URL: baseUrl, OPENAI_COMPAT_MODEL: MODEL }),
    ).toBeNull();
    expect(() => loadOpenAICompatibleSettings({ PROVIDER: 'openai_compatible' })).toThrow();
    const settings = loadOpenAICompatibleSettings({
      PROVIDER: 'openai_compatible',
      OPENAI_COMPAT_BASE_URL: baseUrl,
      OPENAI_COMPAT_MODEL: MODEL,
    });
    expect(settings?.baseUrl.endsWith('/v1')).toBe(true);
  });

  it('carries the paired proof: Beacon reaches only the Native only envelope', async () => {
    captured.length = 0;
    forcedStatus = null;
    const settings = loadOpenAICompatibleSettings({
      PROVIDER: 'openai_compatible',
      OPENAI_COMPAT_BASE_URL: baseUrl,
      OPENAI_COMPAT_MODEL: MODEL,
    });
    expect(settings).not.toBeNull();
    const config = loadServerConfig({ NODE_ENV: 'test', DEMO_MODE: 'live', GEMINI_MODEL: MODEL });
    const transport = new OpenAICompatibleChatTransport(settings!);
    const spy = new SpyGeminiTransport(transport);
    const sessionStore = new SessionStore({ secret: config.sessionSecret, ttlMs: config.sessionTtlMs });
    const ledger = new AuditLedger();
    const { snapshot } = sessionStore.createOrRotateSession('alder');

    const paired = await runPairedProofWorkflow(
      {
        config,
        sessionStore,
        ledger,
        releaseGate: new ResponseReleaseGate(),
        transport: spy,
        logger: new SafeStructuredLogger({ emitToStdout: false }),
      },
      snapshot,
    );

    expect(captured).toHaveLength(2);
    for (const request of captured) {
      expect(request.path).toBe('/v1/chat/completions');
      expect(request.body['model']).toBe(MODEL);
      expect(request.body['temperature']).toBe(0);
      expect(request.body['response_format']).toMatchObject({ type: 'json_schema' });
    }
    const [controlRequest, governedRequest] = captured.map((r) => JSON.stringify(r.body));
    expect(controlRequest).toContain(BEACON_RECORD.sourceId);
    expect(governedRequest).not.toContain(BEACON_RECORD.sourceId);
    expect(governedRequest).not.toContain(SYNTHETIC_PLANTED_VALUE);
    expect(governedRequest).toContain(ALDER_RECORD.sourceId);

    expect(paired.nativeOnly.foreignChunkEnteredEnvelope).toBe(true);
    expect(paired.nativePlusVervain.foreignChunkEnteredEnvelope).toBe(false);
    expect(paired.nativePlusVervain.providerRuntime.outcome).toBe('succeeded');
    expect(paired.nativePlusVervain.providerRuntime.model).toBe(MODEL);
    expect(paired.nativePlusVervain.releaseDecision).toBe('released');
    expect(transport.getObservedModelIds()).toEqual([MODEL, MODEL]);
    expect(ledger.verifyChain().verified).toBe(true);
  });

  it('maps HTTP failures and refuses a model id the receipts would not name', async () => {
    const settings = loadOpenAICompatibleSettings({
      PROVIDER: 'openai_compatible',
      OPENAI_COMPAT_BASE_URL: baseUrl,
      OPENAI_COMPAT_MODEL: MODEL,
    })!;
    const transport = new OpenAICompatibleChatTransport(settings);
    const envelope = {
      requestId: 'req_test',
      armMode: 'vervain_governed',
      model: MODEL,
      systemInstruction: 'system',
      userContent: 'user',
      includedSourceIds: [],
      includedChunkCount: 0,
      temperature: 0,
      maxOutputTokens: 16,
      responseMimeType: 'application/json',
      envelopeSha256: '0'.repeat(64),
      promptUtf8Bytes: 10,
    } as const;

    forcedStatus = 429;
    expect((await transport.invoke(envelope, { timeoutMs: 2000 })).status).toBe('http_429');
    forcedStatus = 503;
    expect((await transport.invoke(envelope, { timeoutMs: 2000 })).status).toBe('http_503');
    forcedStatus = 401;
    expect((await transport.invoke(envelope, { timeoutMs: 2000 })).status).toBe('auth_error');
    forcedStatus = 500;
    expect((await transport.invoke(envelope, { timeoutMs: 2000 })).status).toBe('provider_error');
    forcedStatus = null;

    const before = captured.length;
    const mismatch = await transport.invoke({ ...envelope, model: 'other-model' }, { timeoutMs: 2000 });
    expect(mismatch.status).toBe('provider_error');
    expect(captured.length).toBe(before);

    const unreachable = new OpenAICompatibleChatTransport({
      ...settings,
      baseUrl: 'http://127.0.0.1:9/v1',
    });
    expect((await unreachable.invoke(envelope, { timeoutMs: 2000 })).status).toBe(
      'provider_unavailable',
    );
  });
});
