/**
 * Live serving telemetry for the self-hosted H200 and the model-call inspector.
 * Every number comes from GET /api/telemetry (real vLLM scrapes and pod samples) or from the
 * provenance the server recorded for this run. Nothing is filled in when data is missing.
 */

import { useEffect, useState } from 'react';

const STALE_S = 10;

interface PodView {
  latest: Record<string, string | number | boolean | null> & { received_at: number };
  history: { t: number; gpu_util_pct: number | null; vram_used_mib: number | null; power_w: number | null }[];
  age_s: number;
  stale: boolean;
}

export interface TelemetryView {
  model: string | null;
  endpointHost: string | null;
  serverTime: number;
  pods: PodView[];
  vllm: {
    configured: boolean;
    latest: {
      running: number | null;
      waiting: number | null;
      kvCachePct: number | null;
      promptTokensTotal: number | null;
      generationTokensTotal: number | null;
      requestsTotal: number | null;
    } | null;
    derived: {
      genTokensPerS: number | null;
      promptTokensPerS: number | null;
      meanTtftMs30s: number | null;
      meanE2eMs30s: number | null;
    };
    history: { t: number; genTps: number | null; promptTps: number | null; running: number | null }[];
    age_s: number | null;
    stale: boolean;
  };
}

export interface ModelCall {
  seq: number;
  method: string;
  path: string;
  endpointHost: string;
  requestedModel: string;
  servedModel: string | null;
  httpStatus: number | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: string | null;
  requestId: string | null;
  outcome: string;
  startedAt: string;
}

function n(v: unknown, digits = 0): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : null;
}

function Spark({ values, max }: { values: (number | null)[]; max?: number }) {
  const pts = values.map((v) => (typeof v === 'number' ? v : null));
  const real = pts.filter((v): v is number => v !== null);
  if (real.length < 2) return <div className="lt-spark is-empty">waiting for data</div>;
  const top = Math.max(max ?? 0, ...real, 1);
  const w = 240;
  const h = 34;
  const step = w / Math.max(pts.length - 1, 1);
  let d = '';
  pts.forEach((v, i) => {
    if (v === null) return;
    const x = i * step;
    const y = h - (v / top) * (h - 2) - 1;
    d += `${d === '' ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
  });
  return (
    <svg className="lt-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Age({ age, stale }: { age: number | null; stale: boolean }) {
  if (age === null) return <span className="lt-age">no data yet</span>;
  return <span className={`lt-age ${stale ? 'is-stale' : ''}`}>{stale ? 'STALE · ' : ''}updated {age.toFixed(0)}s ago</span>;
}

function Row({ k, v }: { k: string; v: string | null }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v ?? '–'}</dd>
    </>
  );
}

const gib = (mib: unknown) => (typeof mib === 'number' ? (mib / 1024).toFixed(1) : null);

export function useTelemetry(): { data: TelemetryView | null; available: boolean; fetchedAt: number } {
  const [data, setData] = useState<TelemetryView | null>(null);
  const [available, setAvailable] = useState(true);
  const [fetchedAt, setFetchedAt] = useState(0);
  useEffect(() => {
    let alive = true;
    let misses = 0;
    async function tick() {
      try {
        const res = await fetch('/api/telemetry', { credentials: 'same-origin' });
        if (res.status === 404) {
          if (alive) setAvailable(false);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as TelemetryView;
        if (alive) {
          setData(body);
          setFetchedAt(Date.now());
          misses = 0;
        }
      } catch {
        misses += 1;
      }
      if (alive) setTimeout(() => void tick(), misses > 5 ? 5000 : 2000);
    }
    void tick();
    return () => {
      alive = false;
    };
  }, []);
  return { data, available, fetchedAt };
}

export function TelemetryPanel({ data, fetchedAt }: { data: TelemetryView | null; fetchedAt: number }) {
  const [open, setOpen] = useState(true);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // Ages advance locally between polls; a poll that stops arriving makes the panel go stale.
  const drift = fetchedAt > 0 ? (Date.now() - fetchedAt) / 1000 : 0;
  const primary = data?.pods.find((p) => p.latest['role'] === 'primary') ?? data?.pods[0] ?? null;
  const standby = data?.pods.filter((p) => p !== primary) ?? [];
  const v = data?.vllm ?? null;
  const vAge = v && v.age_s !== null ? v.age_s + drift : null;
  const vStale = !v || vAge === null || vAge > STALE_S;
  const pAge = primary ? primary.age_s + drift : null;
  const pStale = !primary || pAge === null || pAge > STALE_S;

  return (
    <aside className={`lt-panel ${open ? 'is-open' : 'is-closed'}`} aria-label="Live telemetry from our H200">
      <button type="button" className="lt-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="lt-dot" aria-hidden="true" /> LIVE: our H200 {open ? '›' : '‹'}
      </button>
      {open ? (
        <div className="lt-body">
          <section className={`lt-block ${pStale ? 'is-stale' : ''}`}>
            <header>
              <strong>GPU {primary ? `· ${String(primary.latest['pod_name'] ?? primary.latest['pod_id'])}` : ''}</strong>
              <Age age={pAge} stale={pStale} />
            </header>
            {primary ? (
              <>
                <p className="lt-sub">
                  {String(primary.latest['gpu_name'] ?? 'GPU')} · {String(primary.latest['region'] ?? '')}
                </p>
                <p className="lt-big">
                  {n(primary.latest['gpu_util_pct']) ?? '–'}
                  <small>% GPU util</small>
                </p>
                <Spark values={primary.history.map((h) => h.gpu_util_pct)} max={100} />
                <dl className="lt-facts">
                  <Row k="VRAM" v={gib(primary.latest['vram_used_mib']) && `${gib(primary.latest['vram_used_mib'])} / ${gib(primary.latest['vram_total_mib']) ?? '?'} GiB`} />
                  <Row k="Power" v={n(primary.latest['power_w']) && `${n(primary.latest['power_w'])} / ${n(primary.latest['power_limit_w']) ?? '?'} W`} />
                  <Row k="Temp" v={n(primary.latest['temp_c']) && `${n(primary.latest['temp_c'])} C`} />
                  <Row k="CPU" v={n(primary.latest['cpu_util_pct']) && `${n(primary.latest['cpu_util_pct'])} %`} />
                  <Row k="Uptime" v={typeof primary.latest['uptime_s'] === 'number' ? `${(primary.latest['uptime_s'] / 3600).toFixed(1)} h` : null} />
                </dl>
              </>
            ) : (
              <p className="lt-wait">waiting for data</p>
            )}
          </section>

          <section className={`lt-block ${vStale ? 'is-stale' : ''}`}>
            <header>
              <strong>vLLM</strong>
              <Age age={vAge} stale={vStale} />
            </header>
            {v && v.latest ? (
              <>
                <p className="lt-sub">
                  {data?.model} · {data?.endpointHost}
                </p>
                <p className="lt-big">
                  {n(v.derived.genTokensPerS, 1) ?? '–'}
                  <small>output tokens/s</small>
                </p>
                <Spark values={v.history.map((h) => h.genTps)} />
                <dl className="lt-facts">
                  <Row k="Running" v={n(v.latest.running)} />
                  <Row k="Waiting" v={n(v.latest.waiting)} />
                  <Row k="Mean TTFT (30s)" v={v.derived.meanTtftMs30s === null ? 'no requests' : `${n(v.derived.meanTtftMs30s)} ms`} />
                  <Row k="Mean latency (30s)" v={v.derived.meanE2eMs30s === null ? 'no requests' : `${n(v.derived.meanE2eMs30s)} ms`} />
                  <Row k="KV cache" v={n(v.latest.kvCachePct, 1) && `${n(v.latest.kvCachePct, 1)} %`} />
                  <Row k="Requests served" v={n(v.latest.requestsTotal)} />
                </dl>
              </>
            ) : (
              <p className="lt-wait">waiting for data</p>
            )}
          </section>

          {standby.map((p) => {
            const age = p.age_s + drift;
            const stale = age > STALE_S;
            return (
              <section key={String(p.latest['pod_id'])} className={`lt-block lt-standby ${stale ? 'is-stale' : ''}`}>
                <header>
                  <strong>{String(p.latest['pod_name'] ?? p.latest['pod_id'])} · {String(p.latest['role'] ?? 'pod')}</strong>
                  <Age age={age} stale={stale} />
                </header>
                <p className="lt-sub">
                  {n(p.latest['gpu_util_pct']) ?? '–'}% util · {gib(p.latest['vram_used_mib']) ?? '–'} GiB VRAM · vLLM{' '}
                  {p.latest['vllm_up'] === true ? 'up' : p.latest['vllm_up'] === false ? 'down' : '–'}
                </p>
              </section>
            );
          })}
        </div>
      ) : null}
    </aside>
  );
}

export interface ReceivedPiece {
  owner: string;
  label: string;
  sent: boolean;
}

export function ModelCallInspector({
  call,
  vervainOn,
  modelCalled,
  pieces,
  rawAnswer,
  podLabel,
}: {
  call: ModelCall | null;
  vervainOn: boolean;
  modelCalled: boolean;
  pieces: ReceivedPiece[];
  rawAnswer: string | null;
  podLabel: string | null;
}) {
  return (
    <section className={`lt-call ${vervainOn ? 'is-on' : 'is-off'}`} aria-label="Model call">
      <strong>Model call · Vervain {vervainOn ? 'ON' : 'OFF'}</strong>
      {!modelCalled ? (
        <p className="lt-sub">The AI was not called for this arm.</p>
      ) : call ? (
        <>
          <p className="lt-mono">
            {call.method} {call.path} to {call.servedModel ?? call.requestedModel}
            {podLabel ? ` on ${podLabel}` : ''} ({call.endpointHost})
          </p>
          <dl className="lt-facts">
            <Row k="HTTP" v={call.httpStatus === null ? call.outcome : String(call.httpStatus)} />
            <Row k="Latency" v={`${call.latencyMs} ms`} />
            <Row k="Prompt tokens" v={n(call.promptTokens)} />
            <Row k="Output tokens" v={n(call.completionTokens)} />
            <Row k="Finish reason" v={call.finishReason} />
            <Row k="Request id" v={call.requestId} />
          </dl>
        </>
      ) : (
        <p className="lt-sub">No call record for this arm.</p>
      )}
      <p className="lt-label">What the model received</p>
      <ul className="lt-pieces">
        {pieces.map((p) => (
          <li key={p.label} className={p.sent ? 'is-sent' : 'is-blocked'}>
            <span>{p.label}</span> <em>{p.owner}</em> <b>{p.sent ? 'sent' : 'blocked by Vervain'}</b>
          </li>
        ))}
      </ul>
      {rawAnswer !== null ? (
        <>
          <p className="lt-label">Model's raw answer</p>
          <pre className="lt-raw">{rawAnswer}</pre>
        </>
      ) : null}
    </section>
  );
}
