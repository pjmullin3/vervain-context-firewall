/**
 * Responsibility: End-to-end checks for the self-hosted (PROVIDER=openai_compatible) build:
 * the bearer key header, the Gemma system-role merge, server readiness and runtime status
 * naming the active provider and model, the screen labels switching away from Gemini, and the
 * Gemini path staying unchanged when PROVIDER is unset.
 * Trust boundary: Local loopback HTTP only; a fake chat-completions server stands in for vLLM.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAppInstance, type AppInstance } from '../../src/server/app.js';
import { loadServerConfig } from '../../src/server/config.js';
import { OfficialGoogleGenAITransport } from '../../src/server/gemini.js';
import {
  loadOpenAICompatibleSettings,
  OpenAICompatibleChatTransport,
} from '../../src/server/openai-compatible.js';
import { modelLabels } from '../../src/shared/provider-labels.js';

const GEMMA = 'gemma-3-27b-it';
const TEST_KEY = 'test-only-bearer-key';

interface Captured {
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

describe('self-hosted OpenAI-compatible provider', () => {
  const captured: Captured[] = [];
  let fake: http.Server;
  let fakeBase = '';
  let app: AppInstance | null = null;

  beforeAll(async () => {
    fake = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (part: Buffer) => {
        raw += part.toString('utf8');
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        captured.push({ authorization: req.headers['authorization'], body });
        const messages = body['messages'] as { role: string; content: string }[];
        const text = messages.map((m) => m.content).join('\n');
        const sources = [...text.matchAll(/source_id=([^\s\]]+)/g)].map((m) => m[1]);
        const content = JSON.stringify({
          answer: 'Acme renewals carry a 4 percent standard uplift.',
          sources_used: [...new Set(sources)],
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            model: body['model'],
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
  });

  afterEach(async () => {
    if (!app) return;
    const server = app.server;
    app = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });

  const envelope = {
    requestId: 'req_test',
    armMode: 'vervain_governed',
    model: GEMMA,
    systemInstruction: 'SYSTEM-TEXT',
    userContent: 'USER-TEXT',
    includedSourceIds: [],
    includedChunkCount: 0,
    temperature: 0,
    maxOutputTokens: 16,
    responseMimeType: 'application/json',
    envelopeSha256: '0'.repeat(64),
    promptUtf8Bytes: 10,
  } as const;

  it('sends OPENAI_COMPAT_API_KEY as a bearer token, and no authorization header without it', async () => {
    const env = { PROVIDER: 'openai_compatible', OPENAI_COMPAT_BASE_URL: fakeBase, OPENAI_COMPAT_MODEL: GEMMA };
    captured.length = 0;
    const withKey = new OpenAICompatibleChatTransport(
      loadOpenAICompatibleSettings({ ...env, OPENAI_COMPAT_API_KEY: ` ${TEST_KEY} ` })!,
    );
    expect((await withKey.invoke(envelope, { timeoutMs: 2000 })).status).toBe('ok');
    const without = new OpenAICompatibleChatTransport(loadOpenAICompatibleSettings(env)!);
    expect((await without.invoke(envelope, { timeoutMs: 2000 })).status).toBe('ok');
    expect(captured.map((c) => c.authorization)).toEqual([`Bearer ${TEST_KEY}`, undefined]);
  });

  it('merges the system text into the user message for Gemma, and keeps the system role otherwise', async () => {
    const env = { PROVIDER: 'openai_compatible', OPENAI_COMPAT_BASE_URL: fakeBase };
    captured.length = 0;
    await new OpenAICompatibleChatTransport(
      loadOpenAICompatibleSettings({ ...env, OPENAI_COMPAT_MODEL: GEMMA })!,
    ).invoke(envelope, { timeoutMs: 2000 });
    await new OpenAICompatibleChatTransport(
      loadOpenAICompatibleSettings({ ...env, OPENAI_COMPAT_MODEL: GEMMA, OPENAI_COMPAT_MERGE_SYSTEM: '0' })!,
    ).invoke(envelope, { timeoutMs: 2000 });
    await new OpenAICompatibleChatTransport(
      loadOpenAICompatibleSettings({ ...env, OPENAI_COMPAT_MODEL: 'qwen2.5-7b-instruct' })!,
    ).invoke({ ...envelope, model: 'qwen2.5-7b-instruct' }, { timeoutMs: 2000 });

    const [merged, explicitSystem, qwen] = captured.map((c) => c.body['messages']);
    expect(merged).toEqual([{ role: 'user', content: 'SYSTEM-TEXT\n\nUSER-TEXT' }]);
    expect(explicitSystem).toEqual([
      { role: 'system', content: 'SYSTEM-TEXT' },
      { role: 'user', content: 'USER-TEXT' },
    ]);
    expect(qwen).toEqual(explicitSystem);
  });

  it('serves readiness, runtime status, and receipts under the active self-hosted model', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'self_hosted_provider_test_secret_at_least_32_bytes',
      PROVIDER: 'openai_compatible',
      OPENAI_COMPAT_BASE_URL: fakeBase,
      OPENAI_COMPAT_MODEL: GEMMA,
      OPENAI_COMPAT_API_KEY: TEST_KEY,
      GEMINI_MODEL: 'gemini-2.5-flash',
      DEMO_MODE: 'mock',
    });
    expect(config.geminiModel).toBe(GEMMA);
    expect(config.demoMode).toBe('live');
    app = createAppInstance({ config, emitLogsToStdout: false });
    expect(app.context.transport).toBeInstanceOf(OpenAICompatibleChatTransport);
    await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', () => resolve()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: 'ready',
      provider: 'openai_compatible',
      model: GEMMA,
      demo_workflow_ready: true,
    });

    const session = await fetch(`${base}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: 'alder' }),
    });
    expect(session.status).toBe(200);
    const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const state = await fetch(`${base}/api/demo/state`, { headers: { Cookie: cookie } });
    expect(state.status).toBe(200);
    const runtime = ((await state.json()) as { runtime: Record<string, unknown> }).runtime;
    expect(runtime).toMatchObject({
      provider: 'Self-hosted open model',
      providerKind: 'openai_compatible',
      providerHostLabel: 'our H200',
      configuredModel: GEMMA,
      mode: 'live',
      liveKeyConfigured: true,
    });

    captured.length = 0;
    const run = await fetch(`${base}/api/demo/run-paired`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: base,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: '{}',
    });
    expect(run.status).toBe(200);
    const paired = ((await run.json()) as {
      pairedRun: { nativePlusVervain: { providerRuntime: Record<string, unknown>; releaseDecision: string } };
    }).pairedRun;
    expect(paired.nativePlusVervain.providerRuntime).toMatchObject({
      provider: 'Self-hosted open model',
      model: GEMMA,
      mode: 'live',
      outcome: 'succeeded',
    });
    expect(paired.nativePlusVervain.releaseDecision).toBe('released');
    expect(captured).toHaveLength(2);
    expect(captured.every((c) => c.authorization === `Bearer ${TEST_KEY}`)).toBe(true);
    expect(JSON.stringify(paired)).not.toContain(TEST_KEY);
  });

  it('labels the chip and model node with the served model on our H200, never Gemini', () => {
    const runtime = { providerKind: 'openai_compatible', providerHostLabel: 'our H200', configuredModel: GEMMA } as const;
    const labels = modelLabels(runtime, 'live');
    expect(labels.chip).toBe(`${GEMMA} · our H200 · LIVE`);
    expect(labels.node).toBe(`${GEMMA} (open model on our H200)`);
    expect(labels.short).toBe(GEMMA);
    expect(JSON.stringify(labels)).not.toMatch(/gemini/i);
  });

  it('keeps the Gemini path and labels unchanged when PROVIDER is unset', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'live',
      GEMINI_API_KEY: 'test_only_key_not_used_for_network',
      OPENAI_COMPAT_BASE_URL: fakeBase,
      OPENAI_COMPAT_MODEL: GEMMA,
    });
    expect(config.openAICompat).toBeNull();
    expect(config.providerKind).toBe('gemini');
    expect(config.providerName).toBe('Google Gemini');
    expect(config.providerHostLabel).toBeNull();
    expect(config.geminiModel).toBe('gemini-2.5-flash');
    app = createAppInstance({ config, emitLogsToStdout: false });
    expect(app.context.transport).toBeInstanceOf(OfficialGoogleGenAITransport);

    const runtime = { providerKind: 'gemini', providerHostLabel: null, configuredModel: 'gemini-2.5-flash' } as const;
    expect(modelLabels(runtime, 'live')).toEqual({
      chip: 'Gemini 4 Carbon · LIVE',
      node: 'Gemini 4 Carbon (model)',
      short: 'Gemini',
    });
    expect(modelLabels(null, null).chip).toBe('Gemini 4 Carbon · ...');
    expect(modelLabels(runtime, 'mock').chip).toBe('Gemini 4 Carbon · MOCK');
  });
});
