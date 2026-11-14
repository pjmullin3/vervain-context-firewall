import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppInstance, type AppInstance } from '../../src/server/app.js';
import { loadServerConfig } from '../../src/server/config.js';
import { OpenAICompatibleChatTransport } from '../../src/server/openai-compatible.js';
import { TelemetryHub, parseVllmMetrics, validatePodSample } from '../../src/server/telemetry.js';

const SAMPLE = `# HELP vllm:num_requests_running Number of requests in model execution batches.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="gemma-3-12b-it"} 1.0
vllm:num_requests_waiting{engine="0",model_name="gemma-3-12b-it"} 0.0
vllm:kv_cache_usage_perc{engine="0",model_name="gemma-3-12b-it"} 0.0125
vllm:prompt_tokens_total{engine="0",model_name="gemma-3-12b-it"} 1000.0
vllm:generation_tokens_total{engine="0",model_name="gemma-3-12b-it"} 500.0
vllm:generation_tokens_total{engine="0",model_name="other-model"} 99999.0
vllm:time_to_first_token_seconds_sum{engine="0",model_name="gemma-3-12b-it"} 2.0
vllm:time_to_first_token_seconds_count{engine="0",model_name="gemma-3-12b-it"} 10.0
vllm:e2e_request_latency_seconds_sum{engine="0",model_name="gemma-3-12b-it"} 20.0
vllm:e2e_request_latency_seconds_count{engine="0",model_name="gemma-3-12b-it"} 10.0
`;
const KEY = 'test_ingest_key_value';

let app: AppInstance | null = null;
afterEach(async () => {
  if (app) await new Promise<void>((r) => app!.server.close(() => r()));
  app = null;
});

describe('telemetry', () => {
  it('parses vLLM metrics for the served model only', () => {
    const p = parseVllmMetrics(SAMPLE, 'gemma-3-12b-it', 1);
    expect(p.running).toBe(1);
    expect(p.genTokens).toBe(500);
    expect(p.kvPct).toBeCloseTo(0.0125);
    expect(p.e2eCount).toBe(10);
  });

  it('derives rates and window means, and flags stale data', () => {
    let now = 1_000_000;
    const hub = new TelemetryHub({ metricsUrl: 'http://x/metrics', model: 'gemma-3-12b-it', endpointHost: 'x', nowFn: () => now });
    expect((hub.snapshot()['vllm'] as { stale: boolean }).stale).toBe(true);
    hub.ingestMetricsText(SAMPLE);
    now += 2000;
    hub.ingestMetricsText(
      SAMPLE.replace('} 500.0', '} 600.0')
        .replace('time_to_first_token_seconds_sum{engine="0",model_name="gemma-3-12b-it"} 2.0', 'time_to_first_token_seconds_sum{engine="0",model_name="gemma-3-12b-it"} 2.4')
        .replace('time_to_first_token_seconds_count{engine="0",model_name="gemma-3-12b-it"} 10.0', 'time_to_first_token_seconds_count{engine="0",model_name="gemma-3-12b-it"} 12.0'),
    );
    const v = hub.snapshot()['vllm'] as { derived: Record<string, number | null>; stale: boolean; history: unknown[] };
    expect(v.derived['genTokensPerS']).toBeCloseTo(50);
    expect(v.derived['meanTtftMs30s']).toBeCloseTo(200);
    expect(v.derived['meanE2eMs30s']).toBeNull();
    expect(v.stale).toBe(false);
    now += 11_000;
    expect((hub.snapshot()['vllm'] as { stale: boolean }).stale).toBe(true);
  });

  it('validates pod samples strictly', () => {
    expect(validatePodSample({ pod_id: 'abc', gpu_util_pct: 50 }, 1)).not.toBeNull();
    expect(validatePodSample({ pod_id: 'abc', gpu_util_pct: 500 }, 1)).toBeNull();
    expect(validatePodSample({ pod_id: 'abc', extra: 1 }, 1)).toBeNull();
    expect(validatePodSample({ pod_id: 'x'.repeat(65) }, 1)).toBeNull();
  });

  it('ingest needs the bearer key; GET returns the public shape', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'telemetry_test_secret_at_least_32_bytes!',
      PROVIDER: 'openai_compatible',
      OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_COMPAT_MODEL: 'gemma-3-12b-it',
      OPENAI_COMPAT_API_KEY: KEY,
    });
    app = createAppInstance({ config, emitLogsToStdout: false });
    await new Promise<void>((r) => app!.server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const body = JSON.stringify({ pod_id: 'fyljv8x5hej2xe', pod_name: 'Vervain-2', role: 'primary', gpu_util_pct: 12 });
    const post = (headers: Record<string, string>, b = body) =>
      fetch(`${base}/api/telemetry/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: b });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${KEY}` }, '{"pod_id":"a","nope":1}')).status).toBe(400);
    expect((await post({ authorization: `Bearer ${KEY}` }, '{bad')).status).toBe(400);
    expect((await post({ authorization: `Bearer ${KEY}` })).status).toBe(200);
    const res = await fetch(`${base}/api/telemetry`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { model: string; endpointHost: string; pods: { stale: boolean; latest: { pod_name: string } }[]; vllm: { stale: boolean } };
    expect(json.model).toBe('gemma-3-12b-it');
    expect(json.endpointHost).toBe('127.0.0.1:9');
    expect(json.pods[0]?.latest.pod_name).toBe('Vervain-2');
    expect(json.pods[0]?.stale).toBe(false);
    expect(json.vllm.stale).toBe(true);
    expect(JSON.stringify(json)).not.toContain(KEY);
  });

  it('records content-free provenance per model call', async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-abc123',
          model: 'gemma-3-12b-it',
          choices: [{ message: { content: '{"answer":"x","sources_used":[]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 321, completion_tokens: 12 },
        }),
        { status: 200, headers: { 'x-request-id': 'req-1' } },
      )) as unknown as typeof fetch;
    const t = new OpenAICompatibleChatTransport(
      { baseUrl: 'https://pod-8000.proxy.example/v1', model: 'gemma-3-12b-it', apiKey: KEY, mergeSystemIntoUser: true },
      fakeFetch,
    );
    const before = t.lastSeq;
    await t.invoke(
      { model: 'gemma-3-12b-it', systemInstruction: 's', userContent: 'u', temperature: 0, maxOutputTokens: 64 } as never,
      { timeoutMs: 1000 },
    );
    const [call] = t.getCallsSince(before);
    expect(call).toMatchObject({
      endpointHost: 'pod-8000.proxy.example',
      servedModel: 'gemma-3-12b-it',
      httpStatus: 200,
      promptTokens: 321,
      completionTokens: 12,
      finishReason: 'stop',
      requestId: 'req-1',
      outcome: 'ok',
    });
    expect(JSON.stringify(call)).not.toContain(KEY);
  });
});
