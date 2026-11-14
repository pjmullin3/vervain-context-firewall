/**
 * Responsibility: Live serving telemetry for the self-hosted model. Polls the vLLM Prometheus
 * `/metrics` endpoint, derives token rates and mean latencies from counter deltas, and keeps
 * GPU samples pushed by pods through a bearer-authenticated ingest route. Every value shown
 * comes from a real scrape or sample; stale data is flagged, never filled in.
 * Trust boundary: Holds no prompts or answers. The ingest key is compared in constant time.
 */

import crypto from 'node:crypto';

export const TELEMETRY_STALE_MS = 10_000;
const HISTORY = 90;
const WINDOW_MS = 30_000;

export interface VllmPoint {
  readonly t: number;
  readonly running: number | null;
  readonly waiting: number | null;
  readonly kvPct: number | null;
  readonly promptTokens: number | null;
  readonly genTokens: number | null;
  readonly ttftSum: number | null;
  readonly ttftCount: number | null;
  readonly e2eSum: number | null;
  readonly e2eCount: number | null;
}

const METRIC_KEYS: Readonly<Record<string, keyof Omit<VllmPoint, 't'>>> = {
  'vllm:num_requests_running': 'running',
  'vllm:num_requests_waiting': 'waiting',
  'vllm:kv_cache_usage_perc': 'kvPct',
  'vllm:prompt_tokens_total': 'promptTokens',
  'vllm:generation_tokens_total': 'genTokens',
  'vllm:time_to_first_token_seconds_sum': 'ttftSum',
  'vllm:time_to_first_token_seconds_count': 'ttftCount',
  'vllm:e2e_request_latency_seconds_sum': 'e2eSum',
  'vllm:e2e_request_latency_seconds_count': 'e2eCount',
};

/** Parses Prometheus text, summing each known metric over label sets for `model`. */
export function parseVllmMetrics(text: string, model: string | null, t: number): VllmPoint {
  const acc: Record<string, number | null> = {};
  for (const k of Object.values(METRIC_KEYS)) acc[k] = null;
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([^\s]+)/.exec(line);
    if (!m) continue;
    const key = METRIC_KEYS[m[1] ?? ''];
    if (!key) continue;
    const labels = m[2] ?? '';
    if (model && labels.includes('model_name=') && !labels.includes(`model_name="${model}"`)) continue;
    const v = Number(m[3]);
    if (!Number.isFinite(v)) continue;
    acc[key] = (acc[key] ?? 0) + v;
  }
  return { t, ...(acc as Omit<VllmPoint, 't'>) };
}

function rate(a: number | null, b: number | null, dtS: number): number | null {
  if (a === null || b === null || dtS <= 0) return null;
  return Math.max(0, (b - a) / dtS);
}

function meanOver(
  pts: readonly VllmPoint[],
  sumKey: 'ttftSum' | 'e2eSum',
  countKey: 'ttftCount' | 'e2eCount',
): number | null {
  if (pts.length < 2) return null;
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  const ds = (b[sumKey] ?? 0) - (a[sumKey] ?? 0);
  const dc = (b[countKey] ?? 0) - (a[countKey] ?? 0);
  if (a[countKey] === null || b[countKey] === null || dc <= 0) return null;
  return (ds / dc) * 1000;
}

const NUM_FIELDS: Readonly<Record<string, [number, number]>> = {
  gpu_util_pct: [0, 100],
  vram_used_mib: [0, 1_000_000],
  vram_total_mib: [0, 1_000_000],
  temp_c: [-50, 150],
  power_w: [0, 5000],
  power_limit_w: [0, 5000],
  cpu_util_pct: [0, 100],
  mem_used_gib: [0, 100_000],
  mem_total_gib: [0, 100_000],
  uptime_s: [0, 1e9],
  sampled_at: [0, 1e13],
};
const STR_FIELDS = new Set(['pod_id', 'pod_name', 'role', 'region', 'gpu_name', 'pstate', 'driver', 'cuda']);
const BOOL_FIELDS = new Set(['vllm_up']);

export type PodSample = Record<string, string | number | boolean | null> & { received_at: number };

/** Strict validation of one ingest body; returns null when anything is unknown or out of range. */
export function validatePodSample(body: unknown, now: number): PodSample | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const out: PodSample = { received_at: now };
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (NUM_FIELDS[k]) {
      if (v === null) { out[k] = null; continue; }
      const [lo, hi] = NUM_FIELDS[k]!;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return null;
      out[k] = v;
    } else if (STR_FIELDS.has(k)) {
      if (typeof v !== 'string' || v.length > 64) return null;
      out[k] = v;
    } else if (BOOL_FIELDS.has(k)) {
      if (typeof v !== 'boolean') return null;
      out[k] = v;
    } else {
      return null;
    }
  }
  if (typeof out['pod_id'] !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(out['pod_id'])) return null;
  return out;
}

export function bearerMatches(header: string | undefined, key: string | null): boolean {
  if (!key || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const a = crypto.createHash('sha256').update(header.slice(7)).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

export class TelemetryHub {
  private readonly vllm: VllmPoint[] = [];
  private lastScrapeOk: number | null = null;
  private lastScrapeError: string | null = null;
  private readonly pods = new Map<string, PodSample[]>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: {
      metricsUrl: string | null;
      model: string | null;
      endpointHost: string | null;
      fetchFn?: typeof fetch;
      nowFn?: () => number;
    },
  ) {}

  private now(): number {
    return (this.opts.nowFn ?? Date.now)();
  }

  start(intervalMs = 2000): void {
    if (this.timer || !this.opts.metricsUrl) return;
    void this.scrapeOnce();
    this.timer = setInterval(() => void this.scrapeOnce(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scrapeOnce(): Promise<void> {
    if (!this.opts.metricsUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await (this.opts.fetchFn ?? fetch)(this.opts.metricsUrl, { signal: controller.signal });
      if (!res.ok) {
        this.lastScrapeError = `http_${res.status}`;
        return;
      }
      const text = await res.text();
      this.ingestMetricsText(text);
    } catch {
      this.lastScrapeError = controller.signal.aborted ? 'timeout' : 'unreachable';
    } finally {
      clearTimeout(timer);
    }
  }

  ingestMetricsText(text: string): void {
    const t = this.now();
    this.vllm.push(parseVllmMetrics(text, this.opts.model, t));
    if (this.vllm.length > HISTORY) this.vllm.shift();
    this.lastScrapeOk = t;
    this.lastScrapeError = null;
  }

  addPodSample(sample: PodSample): void {
    const id = sample['pod_id'] as string;
    if (!this.pods.has(id) && this.pods.size >= 8) return;
    const list = this.pods.get(id) ?? [];
    list.push(sample);
    if (list.length > HISTORY) list.shift();
    this.pods.set(id, list);
  }

  snapshot(): Record<string, unknown> {
    const now = this.now();
    const pts = this.vllm;
    const series = pts.map((p, i) => {
      const prev = i > 0 ? pts[i - 1]! : null;
      const dt = prev ? (p.t - prev.t) / 1000 : 0;
      return {
        t: p.t,
        genTps: prev ? rate(prev.genTokens, p.genTokens, dt) : null,
        promptTps: prev ? rate(prev.promptTokens, p.promptTokens, dt) : null,
        running: p.running,
      };
    });
    const latest = pts.length > 0 ? pts[pts.length - 1]! : null;
    const lastSeries = series.length > 0 ? series[series.length - 1]! : null;
    const windowPts = pts.filter((p) => latest !== null && latest.t - p.t <= WINDOW_MS);
    const vllmAge = this.lastScrapeOk === null ? null : (now - this.lastScrapeOk) / 1000;
    const pods = [...this.pods.values()].map((list) => {
      const last = list[list.length - 1]!;
      const age = (now - last.received_at) / 1000;
      return {
        latest: last,
        history: list.slice(-60).map((s) => ({
          t: s.received_at,
          gpu_util_pct: s['gpu_util_pct'] ?? null,
          vram_used_mib: s['vram_used_mib'] ?? null,
          power_w: s['power_w'] ?? null,
        })),
        age_s: Math.round(age * 10) / 10,
        stale: age * 1000 > TELEMETRY_STALE_MS,
      };
    });
    return {
      model: this.opts.model,
      endpointHost: this.opts.endpointHost,
      serverTime: now,
      pods,
      vllm: {
        configured: this.opts.metricsUrl !== null,
        latest: latest
          ? {
              running: latest.running,
              waiting: latest.waiting,
              kvCachePct: latest.kvPct === null ? null : latest.kvPct * 100,
              promptTokensTotal: latest.promptTokens,
              generationTokensTotal: latest.genTokens,
              requestsTotal: latest.e2eCount,
            }
          : null,
        derived: {
          genTokensPerS: lastSeries?.genTps ?? null,
          promptTokensPerS: lastSeries?.promptTps ?? null,
          meanTtftMs30s: meanOver(windowPts, 'ttftSum', 'ttftCount'),
          meanE2eMs30s: meanOver(windowPts, 'e2eSum', 'e2eCount'),
        },
        history: series.slice(-60),
        age_s: vllmAge === null ? null : Math.round(vllmAge * 10) / 10,
        stale: vllmAge === null || vllmAge * 1000 > TELEMETRY_STALE_MS,
        lastError: this.lastScrapeError,
      },
    };
  }
}

/** Builds the hub from the OpenAI-compatible base URL (`.../v1` becomes `.../metrics`). */
export function createTelemetryHub(baseUrl: string | null, model: string | null): TelemetryHub {
  if (!baseUrl) return new TelemetryHub({ metricsUrl: null, model, endpointHost: null });
  const u = new URL(baseUrl);
  const metrics = new URL(u.toString().replace(/\/v1\/?$/, '') + '/metrics');
  return new TelemetryHub({ metricsUrl: metrics.toString(), model, endpointHost: u.host });
}
