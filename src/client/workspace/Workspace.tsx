/**
 * Responsibility: Default Vervain workspace view. One central context cube with branching
 * lineage, a single paired run, an animated walk along the branches, a node inspector,
 * and a six-step timeline. The ON/OFF switch flips between the two arms of the same run.
 * Trust boundary: Untrusted browser code. Calls only same-origin `/api/*` via api.ts and
 * never sends tenant, principal, epoch, or model parameters.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  ClientApiError,
  createOrSwitchPersonaSession,
  fetchDemoState,
  resetDemoSessionRequest,
  runPairedProofRequest,
  runRevokeDuringGenerationRequest,
  verifyLedgerChainRequest,
} from '../api.js';
import type {
  ArmExecutionView,
  DemoStateResponse,
  LedgerVerificationResult,
} from '../../shared/contracts.js';
import {
  APERTURE,
  CHUNK_ROUTES,
  CUBE,
  CUBE_V,
  EDGE_ROUTES,
  EXIT,
  NODES,
  VIEW_H,
  VIEW_W,
  leftFaceInset,
  lerp,
  pointAlong,
  poly,
  routeD,
} from './geometry.js';
import type { Pt, SampledRoute, WorkspaceNodeId } from './geometry.js';
import {
  NODE_STEP,
  STEPS,
  STEP_ENDS,
  armNodes,
  idleNodes,
  inspectorFields,
  modelDisplayName,
  short,
} from './model.js';
import type { Mark, NodeView } from './model.js';

type Mode = 'on' | 'off';
type Busy = null | 'run' | 'reset' | 'verify' | 'revoke';

const RUN_MS = 3000;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function seg(t: number, a: number, b: number): number {
  return Math.max(0, Math.min(1, (t - a) / (b - a)));
}

function ease(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

function stepIndexAt(t: number): number {
  for (let i = 0; i < STEP_ENDS.length; i += 1) if (t < (STEP_ENDS[i] ?? 1)) return i;
  return STEP_ENDS.length;
}

export function VervainMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="vw-mark">
      <path d="M12 2.5 20.5 7.2v9.6L12 21.5 3.5 16.8V7.2Z" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12 12 20.5 7.2M12 12 3.5 7.2M12 12v9.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.55" />
      <path d="M6.6 11.2 9.4 12.8v3.3L6.6 14.5Z" fill="#9b8af5" opacity="0.9" />
    </svg>
  );
}

function MarkGlyph({ mark, x, y }: { mark: Mark; x: number; y: number }) {
  const t = `translate(${x},${y})`;
  switch (mark) {
    case 'ok':
      return <path transform={t} d="M-4 0.5 -1.2 3.2 4.2 -3" className="vw-g vw-g-ok" />;
    case 'stop':
      return (
        <g transform={t} className="vw-g vw-g-stop">
          <polygon points="-2.4,-5.6 2.4,-5.6 5.6,-2.4 5.6,2.4 2.4,5.6 -2.4,5.6 -5.6,2.4 -5.6,-2.4" />
          <line x1="-2.8" y1="0" x2="2.8" y2="0" />
        </g>
      );
    case 'flag':
      return (
        <g transform={t} className="vw-g vw-g-flag">
          <polygon points="0,-5.6 6,4.8 -6,4.8" />
          <line x1="0" y1="-1.6" x2="0" y2="1.4" />
          <circle cx="0" cy="3.2" r="0.4" />
        </g>
      );
    case 'open':
      return (
        <g transform={t} className="vw-g vw-g-open">
          <circle r="4.6" />
          <line x1="-3.2" y1="3.2" x2="3.2" y2="-3.2" />
        </g>
      );
    case 'info':
      return <circle transform={t} r="3" className="vw-g vw-g-info" />;
    default:
      return <circle transform={t} r="2.6" className="vw-g vw-g-idle" />;
  }
}

function trim(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Wrap a status into at most two lines on word boundaries. */
function wrapStatus(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const cut = text.lastIndexOf(' ', max);
  const at = cut > max * 0.5 ? cut : max;
  return [text.slice(0, at).trimEnd(), trim(text.slice(at).trimStart(), max)];
}

interface NodeProps {
  readonly id: Exclude<WorkspaceNodeId, 'cube'>;
  readonly view: NodeView;
  readonly selected: boolean;
  readonly active: boolean;
  readonly revealed: boolean;
  readonly onOpen: (id: WorkspaceNodeId) => void;
}

function CanvasNode({ id, view, selected, active, revealed, onOpen }: NodeProps) {
  const b = NODES[id];
  const x = b.cx - b.w / 2;
  const y = b.cy - b.h / 2;
  const mark: Mark = revealed ? view.mark : id === 'retriever' ? 'flag' : 'idle';
  const status = revealed ? view.status : idleNodes()[id].status;
  const maxChars = Math.floor((b.w - 36) / 5.9);
  const lines = wrapStatus(status, maxChars);
  const boxH = b.h + (lines.length > 1 ? 15 : 0);
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(id);
    }
  };
  return (
    <g
      className={`vw-node vw-mark-${mark}${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}${view.foreign ? ' is-foreign' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${view.label}. ${status}. Open inspector.`}
      data-testid={`ws-node-${id}`}
      onClick={() => onOpen(id)}
      onKeyDown={onKey}
    >
      <rect x={x} y={y} width={b.w} height={boxH} rx={9} className="vw-node-box" />
      <text x={x + 14} y={y + 17} className="vw-node-type">
        {view.type.toUpperCase()}
      </text>
      <text x={x + 14} y={y + 36} className="vw-node-label">
        {trim(view.label, Math.floor((b.w - 24) / 7.2))}
      </text>
      <MarkGlyph mark={mark} x={x + 19} y={y + 50} />
      {lines.map((ln, i) => (
        <text key={ln} x={x + 30} y={y + 53.5 + i * 15} className="vw-node-status">
          {ln}
        </text>
      ))}
      <title>{`${view.label}: ${status}`}</title>
    </g>
  );
}

function ChunkToken({ at, kind, cut }: { at: Pt; kind: 'alder' | 'beacon'; cut?: boolean }) {
  const s = 7;
  const [x, y] = at;
  const hex = `${x},${y - s} ${x + s * 0.87},${y - s / 2} ${x + s * 0.87},${y + s / 2} ${x},${y + s} ${x - s * 0.87},${y + s / 2} ${x - s * 0.87},${y - s / 2}`;
  return (
    <g className={`vw-chunk vw-chunk-${kind}${cut ? ' is-cut' : ''}`} aria-hidden="true">
      <polygon points={hex} />
      <path d={`M${x - s * 0.87},${y - s / 2} L${x},${y} L${x + s * 0.87},${y - s / 2} M${x},${y} L${x},${y + s}`} />
      <text x={x} y={kind === 'alder' ? y - 12 : y + 20} textAnchor="middle" className="vw-chunk-label">
        {kind === 'alder' ? 'Alder' : 'Beacon'}
      </text>
    </g>
  );
}

function Cube({ mode, t, ran, beaconCut, selected, active, onOpen, view }: {
  mode: Mode;
  t: number;
  ran: boolean;
  beaconCut: boolean;
  selected: boolean;
  active: boolean;
  onOpen: (id: WorkspaceNodeId) => void;
  view: NodeView;
}) {
  const V = CUBE_V;
  const off = mode === 'off';
  const grid: string[] = [];
  for (const f of [1 / 3, 2 / 3]) {
    // top face lattice
    grid.push(`M${poly([lerp(V.ul, V.top, f), lerp(V.center, V.ur, f)])}`);
    grid.push(`M${poly([lerp(V.ul, V.center, f), lerp(V.top, V.ur, f)])}`);
    // left face lattice
    grid.push(`M${poly([lerp(V.ul, V.ll, f), lerp(V.center, V.bottom, f)])}`);
    grid.push(`M${poly([lerp(V.ul, V.center, f), lerp(V.ll, V.bottom, f)])}`);
    // right face lattice
    grid.push(`M${poly([lerp(V.center, V.bottom, f), lerp(V.ur, V.lr, f)])}`);
    grid.push(`M${poly([lerp(V.center, V.ur, f), lerp(V.bottom, V.lr, f)])}`);
  }
  const pulse = ran ? 0.5 + 0.5 * Math.sin(seg(t, 0.28, 0.52) * Math.PI) : 0;
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen('cube');
    }
  };
  return (
    <g
      className={`vw-cube${off ? ' is-off' : ''}${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`Vervain context gate. ${view.status}. Open inspector.`}
      data-testid="ws-node-cube"
      onClick={() => onOpen('cube')}
      onKeyDown={onKey}
    >
      <polygon className="vw-cube-hit" points={poly([V.top, V.ur, V.lr, V.bottom, V.ll, V.ul])} />
      <polygon className="vw-cube-face vw-cube-top" points={poly([V.top, V.ur, V.center, V.ul])} />
      <polygon className="vw-cube-face vw-cube-left" points={poly([V.ul, V.center, V.bottom, V.ll])} />
      <polygon className="vw-cube-face vw-cube-right" points={poly([V.center, V.ur, V.lr, V.bottom])} />
      <path className="vw-cube-grid" d={grid.join(' ')} />
      <polygon className="vw-cube-edge" points={poly([V.top, V.ur, V.lr, V.bottom, V.ll, V.ul])} />
      <path className="vw-cube-edge" d={`M${poly([V.ul, V.center, V.ur])} M${poly([V.center, V.bottom])}`} />
      {/* aperture / cut plane on the left face */}
      <polygon
        className={`vw-aperture${beaconCut ? ' is-cutting' : ''}`}
        points={leftFaceInset(0.42)}
        style={{ opacity: off ? 0.35 : 0.55 + 0.45 * pulse }}
      />
      <polygon className="vw-aperture-frame" points={leftFaceInset(0.5)} />
      <circle cx={EXIT[0]} cy={EXIT[1]} r={3} className="vw-exit" />
      <text x={CUBE.cx} y={CUBE.cy - CUBE.s - 18} textAnchor="middle" className="vw-cube-title">
        VERVAIN
      </text>
      <text x={CUBE.cx} y={CUBE.cy - CUBE.s - 4} textAnchor="middle" className="vw-cube-sub">
        {off ? 'OFF · Native only, no gate in the path' : ran ? view.status : 'Context gate · memory volume'}
      </text>
    </g>
  );
}

function Drawer({ id, arm, demo, verification, busy, onVerify, onClose, onExport, nodes }: {
  id: WorkspaceNodeId;
  arm: ArmExecutionView | null;
  demo: DemoStateResponse | null;
  verification: LedgerVerificationResult | null;
  busy: Busy;
  onVerify: () => void;
  onClose: () => void;
  onExport: () => void;
  nodes: Record<WorkspaceNodeId, NodeView>;
}) {
  const fields = inspectorFields(id, arm, demo?.session ?? null, demo?.runtime ?? null);
  const view = nodes[id];
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [id]);
  let lead: ReactNode = null;
  if (id === 'reply' && arm) {
    lead = arm.releasedAnswerText && arm.arm === 'native_plus_vervain' ? (
      <blockquote className="vw-quote" data-testid="ws-reply-text">{arm.releasedAnswerText}</blockquote>
    ) : (
      <p className="vw-drawer-note">
        {arm.providerRuntime.outcome === 'invalid_response'
          ? 'No usable reply: model output rejected by schema. The leak is shown by the request envelope, not the reply.'
          : arm.releasedAnswerText
            ? `Native only reply (unmediated): ${arm.releasedAnswerText}`
            : 'No reply text was released.'}
      </p>
    );
  }
  if (id === 'source_beacon' && arm) {
    lead = (
      <p className="vw-drawer-note">
        {arm.foreignChunkEnteredEnvelope
          ? "Beacon's note entered the Gemini request. Native only has no gate, so the retrieval bug reaches the model."
          : 'Withheld at the cube aperture before Gemini was called: the record tenant does not match the server-owned session.'}
      </p>
    );
  }
  return (
    <aside className="vw-drawer" aria-label={`${view.label} inspector`} data-testid="ws-drawer">
      <div className="vw-drawer-head">
        <div>
          <div className="vw-drawer-type">{view.type}</div>
          <h2>{id === 'cube' ? 'Vervain context gate' : view.label}</h2>
          {arm ? <div className="vw-drawer-lane">{arm.arm === 'native_only' ? 'Vervain OFF · Native only' : 'Vervain ON · Native + Vervain'}</div> : null}
        </div>
        <button ref={closeRef} type="button" className="vw-icon-btn" onClick={onClose} aria-label="Close inspector">
          ×
        </button>
      </div>
      {arm ? (
        <div className={`vw-drawer-status vw-mark-${view.mark}`}>
          <svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">
            <MarkGlyph mark={view.mark} x={0} y={0} />
          </svg>
          <span>{view.status}</span>
        </div>
      ) : null}
      {lead}
      <dl className="vw-fields">
        {fields.map((f) => (
          <div key={f.k} className="vw-field">
            <dt>{f.k}</dt>
            <dd className={f.mono ? 'is-mono' : undefined}>{f.v}</dd>
          </div>
        ))}
      </dl>
      {id === 'receipt' ? (
        <div className="vw-drawer-actions">
          <button type="button" className="vw-btn" onClick={onVerify} disabled={busy !== null} data-testid="ws-verify">
            {busy === 'verify' ? 'Verifying…' : 'Verify chain'}
          </button>
          <button type="button" className="vw-btn" onClick={onExport} disabled={!arm} data-testid="ws-export">
            Export JSON
          </button>
          {verification ? (
            <div className={`vw-verify ${verification.verified ? 'is-ok' : 'is-bad'}`} data-testid="ws-verify-result">
              {verification.verified ? 'Verified' : 'Failed'} · {verification.checkedReceipts} receipts,{' '}
              {verification.checkedEvents} events · head {short(verification.headChainSha256, 16)}
              {verification.failureReason ? ` · ${verification.failureReason}` : ''}
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

export function Workspace() {
  const [demo, setDemo] = useState<DemoStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [mode, setMode] = useState<Mode>('on');
  const [t, setT] = useState(0);
  const [runKey, setRunKey] = useState(0);
  const [selected, setSelected] = useState<WorkspaceNodeId | null>(null);
  const [verification, setVerification] = useState<LedgerVerificationResult | null>(null);
  const [revokeRun, setRevokeRun] = useState<ArmExecutionView | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setDemo(await fetchDemoState());
    } catch (err: unknown) {
      if (err instanceof ClientApiError && err.status === 401) {
        try {
          await createOrSwitchPersonaSession('alder');
          setDemo(await fetchDemoState());
          return;
        } catch (inner: unknown) {
          setError(inner instanceof Error ? inner.message : 'Unable to start the demo session.');
          return;
        }
      }
      setError(err instanceof Error ? err.message : 'Unable to load the workspace.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Drive one purposeful sequence per run (or mode flip), then stop.
  useEffect(() => {
    if (runKey === 0) return undefined;
    if (prefersReducedMotion()) {
      let i = 0;
      setT(STEP_ENDS[0]);
      const timer = window.setInterval(() => {
        i += 1;
        if (i >= STEP_ENDS.length) {
          window.clearInterval(timer);
          return;
        }
        setT(STEP_ENDS[i] ?? 1);
      }, 450);
      return () => window.clearInterval(timer);
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / RUN_MS);
      setT(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    setT(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [runKey]);

  const paired = demo?.latestPairedRun ?? null;
  const arm: ArmExecutionView | null = revokeRun ?? (paired ? (mode === 'on' ? paired.nativePlusVervain : paired.nativeOnly) : null);
  const ran = arm !== null;
  const effT = ran ? t : 0;
  const step = ran ? stepIndexAt(effT) : -1;
  const done = ran && effT >= 1;

  const nodes = useMemo(
    () => (arm && demo ? armNodes(arm, demo.session) : idleNodes()),
    [arm, demo],
  );
  const effectiveMode: Mode = arm ? (arm.arm === 'native_only' ? 'off' : 'on') : mode;
  const native = effectiveMode === 'off';
  const beaconSource = arm?.receipt.sources.find((src) => src.chunk_id.toLowerCase().includes('beacon')) ?? null;
  const beaconWithheld = ran && !native && beaconSource?.disposition === 'withheld';
  const beaconReason = beaconSource ? beaconSource.reason_code.replace(/_/g, ' ') : '';

  const run = async () => {
    setBusy('run');
    setError(null);
    setRevokeRun(null);
    try {
      const res = await runPairedProofRequest();
      setDemo((prev) =>
        prev
          ? { ...prev, session: res.session, latestPairedRun: res.pairedRun, ledgerSummary: res.ledgerSummary }
          : prev,
      );
      setVerification(null);
      setRunKey((k) => k + 1);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Run failed.');
    } finally {
      setBusy(null);
    }
  };

  const flip = (next: Mode) => {
    if (next === mode && !revokeRun) return;
    setMode(next);
    setRevokeRun(null);
    if (paired) setRunKey((k) => k + 1);
  };

  const reset = async () => {
    setBusy('reset');
    setMenuOpen(false);
    try {
      await resetDemoSessionRequest();
      setRevokeRun(null);
      setSelected(null);
      setVerification(null);
      setT(0);
      setRunKey(0);
      const fresh = await fetchDemoState();
      setDemo({ ...fresh, latestPairedRun: null, latestSingleRun: null });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Reset failed.');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    setBusy('revoke');
    setMenuOpen(false);
    try {
      const res = await runRevokeDuringGenerationRequest();
      setMode('on');
      setRevokeRun(res.run);
      setDemo((prev) => (prev ? { ...prev, session: res.session, ledgerSummary: res.ledgerSummary } : prev));
      setRunKey((k) => k + 1);
      setSelected('release');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Revoke run failed.');
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    setBusy('verify');
    try {
      setVerification(await verifyLedgerChainRequest());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setBusy(null);
    }
  };

  const exportJson = () => {
    if (!arm) return;
    const blob = new Blob([JSON.stringify(arm.receipt, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${arm.receipt.receipt_id}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(null);
        setMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Chunk positions along their routes.
  const chunkAt = (route: SampledRoute, a: number, b: number, backoff = 0): Pt =>
    pointAlong(route, ease(seg(effT, a, b)) * (1 - backoff / route.total));
  const showChunks = ran && effT >= STEP_ENDS[1] - 0.02;
  let alderPos: Pt | null = null;
  let beaconPos: Pt | null = null;
  if (showChunks && arm) {
    if (native) {
      alderPos = chunkAt(CHUNK_ROUTES.alderToGemini, 0.28, 0.68, 40);
      beaconPos = chunkAt(CHUNK_ROUTES.beaconToGemini, 0.3, 0.7, 10);
    } else {
      const toReply = arm.releaseDecision === 'released';
      alderPos = toReply
        ? chunkAt(CHUNK_ROUTES.alderToReply, 0.28, 0.9)
        : chunkAt(CHUNK_ROUTES.alderToGemini, 0.28, 0.68, 4);
      beaconPos = !beaconSource
        ? null
        : beaconWithheld
        ? chunkAt(CHUNK_ROUTES.beaconToAperture, 0.3, 0.48, 12)
        : chunkAt(CHUNK_ROUTES.beaconToGemini, 0.3, 0.7, 40);
    }
  }
  const beaconCut = beaconWithheld && effT >= 0.48;
  const receiptPulse = ran && effT >= 0.86 && effT < 1 ? pointAlong(CHUNK_ROUTES.receiptPulse, seg(effT, 0.86, 1)) : null;

  const revealed = (id: WorkspaceNodeId) => ran && step > NODE_STEP[id];
  const activeStep = ran && !done ? step : selected ? NODE_STEP[selected] : -1;

  const edgeClass = (lit: boolean, extra = '') => `vw-edge${lit ? ' is-lit' : ''}${extra ? ` ${extra}` : ''}`;
  const reached = (i: number) => ran && step > i;

  const runtime = demo?.runtime ?? null;
  const modelId = arm?.providerRuntime.model ?? runtime?.configuredModel ?? 'gemini';
  const transport = arm?.providerRuntime.mode ?? runtime?.mode ?? 'mock';
  const session = demo?.session;
  const replyText = arm && arm.arm === 'native_plus_vervain' && arm.releaseDecision === 'released' ? arm.releasedAnswerText : null;

  return (
    <div className={`vw-root${selected ? ' has-drawer' : ''}`} data-testid="workspace">
      <header className="vw-top">
        <div className="vw-brand">
          <VervainMark />
          <span className="vw-wordmark">Vervain</span>
          <nav className="vw-tabs" aria-label="Views">
            <a href="#" className="is-current" aria-current="page">Workspace</a>
            <a href="#evidence">Evidence</a>
          </nav>
        </div>
        <div className="vw-chips">
          <span className="vw-chip" data-testid="ws-session-chip">
            <span className="vw-dot" aria-hidden="true" />
            {session ? `${session.tenantLabel} · policy epoch ${session.policyEpoch}` : 'Starting session…'}
          </span>
          <span className={`vw-chip ${transport === 'live' ? 'is-live' : 'is-mock'}`} data-testid="ws-model-chip">
            {modelDisplayName(modelId)} · {transport === 'live' ? 'LIVE' : 'MOCK'}
          </span>
          <div className="vw-switch" role="group" aria-label="Vervain mode">
            <button
              type="button"
              aria-pressed={effectiveMode === 'on'}
              className={effectiveMode === 'on' ? 'is-on' : ''}
              onClick={() => flip('on')}
              data-testid="ws-mode-on"
            >
              Vervain ON
            </button>
            <button
              type="button"
              aria-pressed={effectiveMode === 'off'}
              className={effectiveMode === 'off' ? 'is-on is-off' : ''}
              onClick={() => flip('off')}
              data-testid="ws-mode-off"
            >
              OFF
            </button>
          </div>
        </div>
      </header>

      <div className="vw-command">
        <div className="vw-prompt">
          <span className="vw-prompt-line">
            {revokeRun
              ? 'Revoke mid-run: epoch changed during generation, so the reply is withheld. Reset restores epoch 7.'
              : native
                ? "Native only: no gate between retrieval and Gemini."
                : "Run Alder's request. A missing filter will also retrieve Beacon's note."}
          </span>
          <span className="vw-query">“{demo?.frozenQuery ?? 'Summarize our Northstar renewal position.'}”</span>
        </div>
        <div className="vw-actions">
          <button type="button" className="vw-run" onClick={() => void run()} disabled={busy !== null || !demo} data-testid="ws-run">
            {busy === 'run' ? 'Running…' : paired ? 'Run again' : 'Run request'}
          </button>
          <button type="button" className="vw-btn" onClick={() => void reset()} disabled={busy !== null} data-testid="ws-reset">
            Reset
          </button>
          <div className="vw-menu">
            <button
              type="button"
              className="vw-btn vw-more"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="More actions"
              onClick={() => setMenuOpen((o) => !o)}
            >
              …
            </button>
            {menuOpen ? (
              <div className="vw-menu-pop" role="menu">
                <button type="button" role="menuitem" onClick={() => void revoke()} disabled={busy !== null}>
                  Revoke mid-run (epoch {session?.policyEpoch ?? 7} → {(session?.policyEpoch ?? 7) + 1})
                </button>
                <a role="menuitem" href="#evidence">Open detailed evidence view</a>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <div className="vw-error" role="alert">
          {error}
        </div>
      ) : null}

      <main className="vw-canvas">
        <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="xMidYMid meet" className="vw-svg" role="group" aria-label="Vervain request lineage">
          {/* lineage drawn on a dotted canvas (CSS background) */}

          {/* lineage */}
          <path d={routeD(EDGE_ROUTES.idp_session)} className={edgeClass(reached(0))} />
          <path d={routeD(EDGE_ROUTES.session_retriever)} className={edgeClass(reached(0))} />
          <path d={routeD(EDGE_ROUTES.retriever_alder)} className={edgeClass(reached(1))} />
          <path d={routeD(EDGE_ROUTES.retriever_beacon)} className={edgeClass(reached(1), 'is-foreign')} />
          <path d={routeD(EDGE_ROUTES.alder_aperture)} className={edgeClass(reached(1))} />
          <path d={routeD(EDGE_ROUTES.beacon_aperture)} className={edgeClass(reached(1), 'is-foreign')} />
          <path d={routeD(EDGE_ROUTES.exit_gemini)} className={edgeClass(reached(2))} />
          <path d={routeD(EDGE_ROUTES.gemini_release)} className={edgeClass(reached(3), native ? 'is-unmediated' : '')} />
          <path d={routeD(EDGE_ROUTES.release_reply)} className={edgeClass(reached(4), native ? 'is-unmediated' : '')} />
          <path d={routeD(EDGE_ROUTES.cube_receipt)} className={edgeClass(reached(4), 'is-dotted')} />

          <Cube
            mode={effectiveMode}
            t={effT}
            ran={ran}
            beaconCut={beaconCut}
            selected={selected === 'cube'}
            active={activeStep === 2}
            onOpen={setSelected}
            view={nodes.cube}
          />
          {native ? (
            <path d={routeD(EDGE_ROUTES.through_cube)} className={edgeClass(reached(1), 'is-foreign is-through')} />
          ) : null}

          {(['idp', 'session', 'retriever', 'source_alder', 'source_beacon', 'gemini', 'release', 'reply', 'receipt'] as const).map((id) => (
            <CanvasNode
              key={id}
              id={id}
              view={nodes[id]}
              selected={selected === id}
              active={activeStep === NODE_STEP[id] && (activeStep !== 1 || id === 'retriever' || id.startsWith('source'))}
              revealed={revealed(id)}
              onOpen={setSelected}
            />
          ))}

          {/* chunk tokens */}
          {alderPos ? <ChunkToken at={alderPos} kind="alder" /> : null}
          {beaconPos ? <ChunkToken at={beaconPos} kind="beacon" cut={beaconCut} /> : null}
          {receiptPulse ? <circle cx={receiptPulse[0]} cy={receiptPulse[1]} r={3.5} className="vw-pulse" /> : null}

          {beaconCut ? (
            <g className="vw-cut" data-testid="ws-cut">
              <line x1={APERTURE[0] - 14} y1={APERTURE[1] + 10} x2={APERTURE[0] - 40} y2={APERTURE[1] + 56} className="vw-cut-leader" />
              <rect x={APERTURE[0] - 150} y={APERTURE[1] + 56} width={176} height={26} rx={5} className="vw-cut-tag" />
              <g transform={`translate(${APERTURE[0] - 136},${APERTURE[1] + 69})`} className="vw-g vw-g-stop">
                <polygon points="-2.4,-5.6 2.4,-5.6 5.6,-2.4 5.6,2.4 2.4,5.6 -2.4,5.6 -5.6,2.4 -5.6,-2.4" />
                <line x1="-2.8" y1="0" x2="2.8" y2="0" />
              </g>
              <text x={APERTURE[0] - 124} y={APERTURE[1] + 73} className="vw-cut-text">
                Withheld: {beaconReason}
              </text>
            </g>
          ) : null}

          {native && ran && arm.foreignChunkEnteredEnvelope && effT >= STEP_ENDS[3] ? (
            <g className="vw-leak" data-testid="ws-leak">
              <rect x={NODES.gemini.cx - 140} y={NODES.gemini.cy + 42} width={280} height={26} rx={5} className="vw-leak-tag" />
              <text x={NODES.gemini.cx} y={NODES.gemini.cy + 59} textAnchor="middle" className="vw-leak-text">
                Beacon data in Gemini request ({arm.receipt.outbound_envelope.admitted_chunk_count} of{' '}
                {arm.receipt.outbound_envelope.admitted_chunk_denominator_retrieved} chunks)
              </text>
            </g>
          ) : null}

          {done && replyText ? (
            <foreignObject x={NODES.reply.cx - 120} y={NODES.reply.cy + 44} width={240} height={126}>
              <button type="button" className="vw-quote-card" onClick={() => setSelected('reply')} data-testid="ws-quote">
                <span className="vw-quote-k">Released to Alder</span>
                <span className="vw-quote-t">{trim(replyText, 130)}</span>
              </button>
            </foreignObject>
          ) : null}
        </svg>
      </main>

      <nav className="vw-timeline" aria-label="Run steps">
        {STEPS.map((s, i) => {
          const state = !ran ? 'idle' : step > i ? 'done' : step === i ? 'now' : 'idle';
          return (
            <button
              key={s.id}
              type="button"
              className={`vw-step is-${state}${activeStep === i ? ' is-active' : ''}`}
              onClick={() => setSelected(s.node)}
              data-testid={`ws-step-${s.id}`}
            >
              <span className="vw-step-n">{String(i + 1).padStart(2, '0')}</span>
              <span className="vw-step-l">{s.label}</span>
              <span className="vw-step-s">{ran && step > i ? nodes[s.node].status : ' '}</span>
            </button>
          );
        })}
      </nav>

      {selected ? (
        <Drawer
          id={selected}
          arm={arm}
          demo={demo}
          verification={verification}
          busy={busy}
          onVerify={() => void verify()}
          onClose={() => setSelected(null)}
          onExport={exportJson}
          nodes={nodes}
        />
      ) : null}
    </div>
  );
}
