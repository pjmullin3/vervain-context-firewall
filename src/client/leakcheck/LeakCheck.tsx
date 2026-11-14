/**
 * Responsibility: The demo's main screen. The stock Vervain DataMap runs full screen; two
 * additions sit on top of it: (1) a live leak check that replays one arm of a real paired run
 * on Gemini as DataMap activity, and (2) a receipt drawer with a ledger check and the measured
 * results from our own GPU run.
 * Trust boundary: Untrusted browser bundle; it only calls the existing public demo API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArmExecutionView, DemoStateResponse, LedgerVerificationResult } from '../../shared/contracts.js';
import { createOrSwitchPersonaSession, fetchDemoState, runPairedProofRequest, verifyLedgerChainRequest } from '../api.js';
import { BrandLogo } from '../datamap/BrandLogo.jsx';
import { DataMap, type DataMapSource } from '../datamap/DataMap.jsx';
import { snapshotAt, type Observation } from '../datamap/fixtures.mjs';
import './leakcheck.css';

type Paired = NonNullable<DemoStateResponse['latestPairedRun']>;

/** Display names for API ids. The backend keeps its ids (alder, beacon); people only ever see these names. */
export const DISPLAY_NAMES: Record<string, string> = {
  alder: 'Acme Co.',
  beacon: 'Pied Piper',
  'alder/renewal-playbook-v3': "Acme's renewal playbook",
  'beacon/strategy-note-v2': "Pied Piper's private strategy note",
};
const ASKING_ID = 'alder';

/** Display names for the replayed actors (the DataMap reads `name`; `model` keeps them ungrouped). Each says who acts. */
const ACTORS: Record<string, string> = {
  assistant: 'Acme Co. AI assistant',
  search: 'Search tool',
  gemini: 'Gemini 4 Carbon (model)',
};

const ACME_FILE = '/Acme Co./renewal-playbook.md';
const PIED_PIPER_FILE = '/Pied Piper/private-strategy-note.md';
const ANSWER_FILE = '/Answers/answer-to-acme.md';
const PENDING = 'in_progress_observed';
const client = 'vervain-demo';
/** One replayed step every STEP ms, so branches spawn one by one. */
export const STEP = 650;
const REQUEST_STEPS = 5;

/** A visible label on one card from a given time on (the DataMap's cardTag hook). */
export interface CardTag {
  path: string;
  from: number;
  text: string;
  tone: 'blocked' | 'leaked' | 'neutral';
}

type Step = Omit<Observation, 'at'>;
const timed = (steps: Step[], t0: number): Observation[] => steps.map((o, i) => ({ ...o, at: t0 + i * STEP }));

export function receiptPath(receiptId: string): string {
  const short = receiptId.replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'receipt';
  return `/Receipts/receipt-${short}.json`;
}

/** Steps that do not depend on the AI call: they start the moment Run is pressed. */
export function requestObservations(t0: number): Observation[] {
  return timed(
    [
      { agent: 'assistant', kind: 'session_start', client },
      { agent: 'assistant', kind: 'user_prompt', client },
      { agent: 'search', kind: 'subagent_start', parent: 'assistant', client },
      { agent: 'search', kind: 'file_read', op: 'read', path: ACME_FILE, status: PENDING, parent: 'assistant', client },
      { agent: 'search', kind: 'file_read', op: 'read', path: PIED_PIPER_FILE, status: PENDING, parent: 'assistant', client },
    ],
    t0,
  );
}

/** The steps that follow from one arm of the real paired run, starting at `t1`. */
export function resultObservations(arm: ArmExecutionView, t1: number): Observation[] {
  const leaked = arm.foreignChunkEnteredEnvelope;
  const steps: Step[] = [
    { agent: 'search', kind: 'file_read', op: 'read', path: ACME_FILE, status: 'completed', parent: 'assistant', client },
    { agent: 'search', kind: 'file_read', op: 'read', path: PIED_PIPER_FILE, status: leaked ? 'completed' : 'denied', parent: 'assistant', client },
    { agent: 'gemini', kind: 'subagent_start', parent: 'assistant', client },
    { agent: 'gemini', kind: 'file_read', op: 'read', path: ACME_FILE, status: 'completed', parent: 'assistant', client },
  ];
  if (leaked) steps.push({ agent: 'gemini', kind: 'file_read', op: 'read', path: PIED_PIPER_FILE, status: 'completed', parent: 'assistant', client });
  steps.push(
    { agent: 'gemini', kind: 'file_write', op: 'write', path: ANSWER_FILE, status: answerReleased(arm) ? 'completed' : 'failed', parent: 'assistant', client },
    { agent: 'assistant', kind: 'file_write', op: 'write', path: receiptPath(arm.receiptId), status: 'completed', client },
  );
  return timed(steps, t1);
}

/** When the result steps start for a replay that began at `t0`. */
export const resultStart = (t0: number) => t0 + REQUEST_STEPS * STEP;

/** A full replay of one arm: the request steps, then the result steps. */
export function armObservations(arm: ArmExecutionView, t0: number): Observation[] {
  return [...requestObservations(t0), ...resultObservations(arm, resultStart(t0))];
}

/** Card labels for one arm: the Pied Piper note says BLOCKED or LEAKED once that step plays; a rejected answer says so. */
export function armTags(arm: ArmExecutionView, observations: Observation[]): CardTag[] {
  const leaked = arm.foreignChunkEnteredEnvelope;
  const at = (agent: string, path: string) => observations.find((o) => o.agent === agent && o.path === path && o.status !== PENDING)?.at;
  const tags: CardTag[] = [];
  const blockedOrLeakedAt = leaked ? at('gemini', PIED_PIPER_FILE) : at('search', PIED_PIPER_FILE);
  if (blockedOrLeakedAt !== undefined) {
    tags.push(
      leaked
        ? { path: PIED_PIPER_FILE, from: blockedOrLeakedAt, text: 'LEAKED into Gemini', tone: 'leaked' }
        : { path: PIED_PIPER_FILE, from: blockedOrLeakedAt, text: 'BLOCKED by Vervain', tone: 'blocked' },
    );
  }
  const answerAt = at('gemini', ANSWER_FILE);
  if (!answerReleased(arm) && answerAt !== undefined) tags.push({ path: ANSWER_FILE, from: answerAt, text: 'No usable answer', tone: 'neutral' });
  return tags;
}

/** Acme got an answer unless Vervain held it back or the model call failed. */
function answerReleased(arm: ArmExecutionView): boolean {
  return arm.releaseDecision !== 'withheld' && arm.providerRuntime.outcome === 'succeeded';
}

/** The receipt's "Released" line, worded for why no answer went out. */
export function releasedText(arm: ArmExecutionView): string {
  if (answerReleased(arm)) return 'Answer sent to Acme';
  if (arm.providerRuntime.outcome === 'invalid_response' || arm.releaseDecision === 'withheld') {
    return 'No usable answer (model output rejected by format check)';
  }
  return 'No usable answer';
}

function idleObservations(t0: number): Observation[] {
  return [{ agent: 'assistant', at: t0, kind: 'session_start', client }];
}

/** A DataMap source with the same {label, clock, interval, poll} contract as the stock harness. Reads observations from a ref so the map keeps its layout while the result streams in. */
function replaySource(observations: { current: Observation[] }, t0: number): DataMapSource {
  return {
    label: 'Acme Co.',
    clock: () => Date.now(),
    interval: 300,
    async poll() {
      const snap = snapshotAt({ observations: observations.current, t0, span: 12000, title: 'Leak check' }, Date.now());
      for (const session of snap.sessions) {
        const name = ACTORS[String(session.id)] ?? String(session.id);
        session.name = name;
        session.model = name;
      }
      return snap;
    },
  };
}

function armOf(paired: Paired, vervainOn: boolean): ArmExecutionView {
  return vervainOn ? paired.nativePlusVervain : paired.nativeOnly;
}

export function LeakCheck() {
  const [demo, setDemo] = useState<DemoStateResponse | null>(null);
  const [paired, setPaired] = useState<Paired | null>(null);
  const [vervainOn, setVervainOn] = useState(true);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const observations = useRef<Observation[]>(idleObservations(startedAt));
  const tags = useRef<CardTag[]>([]);

  useEffect(() => {
    // The demo always asks as Acme: open (or reuse) Acme's synthetic session first.
    createOrSwitchPersonaSession(ASKING_ID)
      .then(() => fetchDemoState())
      .then(setDemo)
      .catch(() => setDemo(null));
  }, []);

  const arm = paired ? armOf(paired, vervainOn) : null;

  // The stock map fits once on mount; as the replay grows, press its own Fit button so every branch stays in view.
  useEffect(() => {
    const timers = Array.from({ length: 14 }, (_, i) => 500 + i * STEP).map((ms) =>
      window.setTimeout(() => {
        const fit = [...document.querySelectorAll<HTMLButtonElement>('.lc-map button')].find((b) => b.textContent === 'Fit');
        fit?.click();
      }, ms),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [startedAt, paired]);
  const source = useMemo(() => replaySource(observations, startedAt), [startedAt]);
  const cardTag = useCallback((node: { kind: string; meta?: Record<string, unknown> }) => {
    if (node.kind !== 'file') return null;
    const now = Date.now();
    const tag = tags.current.find((t) => t.path === node.meta?.path && now >= t.from);
    return tag ? { text: tag.text, tone: tag.tone } : null;
  }, []);

  const mode = arm?.providerRuntime.mode ?? demo?.runtime.mode ?? null;
  const isLive = mode === 'live';
  const model = arm?.providerRuntime.model ?? demo?.runtime.configuredModel ?? 'Gemini 4 Carbon';

  async function run() {
    setRunning(true);
    setError(null);
    setPaired(null);
    const t0 = Date.now();
    observations.current = requestObservations(t0);
    tags.current = [];
    setStartedAt(t0);
    try {
      const result = await runPairedProofRequest();
      const runArm = armOf(result.pairedRun, vervainOn);
      const t1 = Math.max(Date.now() + STEP, resultStart(t0));
      observations.current = [...requestObservations(t0), ...resultObservations(runArm, t1)];
      tags.current = armTags(runArm, observations.current);
      setPaired(result.pairedRun);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The run failed.');
    } finally {
      setRunning(false);
    }
  }

  /** Replays one arm of the last result from its first step, re-seeding the clock to now. */
  function replay(on: boolean) {
    if (!paired || running) return;
    const t0 = Date.now();
    const replayArm = armOf(paired, on);
    observations.current = armObservations(replayArm, t0);
    tags.current = armTags(replayArm, observations.current);
    setStartedAt(t0);
  }

  function toggle() {
    const next = !vervainOn;
    setVervainOn(next);
    replay(next);
  }

  const sentence = arm
    ? vervainOn
      ? "BLOCKED. Pied Piper's private note never reached the AI. Acme still got its answer."
      : "LEAKED. Pied Piper's private note went straight into the AI."
    : running
      ? "Acme asks. The search bug grabs Pied Piper's private note too. Asking Gemini..."
      : "Acme Co. and Pied Piper share one AI assistant. Vervain controls what the agent reads before it reasons.";

  return (
    <div className="lc-root">
      <header className="lc-bar">
        <div className="lc-brand">
          <BrandLogo className="lc-logo" decorative={false} />
          <span className="lc-name">Vervain</span>
        </div>
        <span className={`lc-chip ${isLive ? 'is-live' : 'is-mock'}`} title={`Model: ${model}`}>
          Gemini 4 Carbon · {mode === null ? '...' : isLive ? 'LIVE' : 'MOCK'}
        </span>
        <div className="lc-actions">
          <button
            type="button"
            className={`lc-switch ${vervainOn ? 'is-on' : 'is-off'}`}
            role="switch"
            aria-checked={vervainOn}
            onClick={toggle}
          >
            <span className="lc-knob" aria-hidden="true" />
            Vervain {vervainOn ? 'ON' : 'OFF'}
          </button>
          <button type="button" className="lc-run" onClick={run} disabled={running}>
            {running ? 'Asking Gemini...' : "Run Acme's request"}
          </button>
          <button type="button" className="lc-ghost" onClick={() => replay(vervainOn)} disabled={!paired || running}>
            Replay
          </button>
          <button type="button" className="lc-ghost" onClick={() => setDrawerOpen(true)} disabled={!paired}>
            Receipt
          </button>
          <a className="lc-details" href="#evidence">
            Details
          </a>
        </div>
      </header>

      <div className="lc-map">
        <DataMap
          key={startedAt}
          source={source}
          initialSettings={{ physics: true }}
          cardTag={cardTag}
          minimalTools
          onPlayback={() => replay(vervainOn)}
          onOpen={(what, node) => {
            const path = typeof node.meta?.path === 'string' ? node.meta.path : '';
            if (what === 'file' && path.startsWith('/Receipts/')) {
              setDrawerOpen(true);
              return true;
            }
            return undefined;
          }}
        />
        <p className={`lc-sentence ${arm ? (vervainOn ? 'is-on' : 'is-off') : ''}`} role="status">
          {error ? `Run failed: ${error}` : sentence}
        </p>
      </div>

      {drawerOpen && paired && arm ? (
        <ReceiptDrawer arm={arm} vervainOn={vervainOn} onClose={() => setDrawerOpen(false)} />
      ) : null}
    </div>
  );
}

function ReceiptDrawer({ arm, vervainOn, onClose }: { arm: ArmExecutionView; vervainOn: boolean; onClose: () => void }) {
  const [check, setCheck] = useState<LedgerVerificationResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  async function runCheck() {
    setChecking(true);
    setCheckError(null);
    try {
      setCheck(await verifyLedgerChainRequest());
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'Check failed.');
    } finally {
      setChecking(false);
    }
  }

  const seen = arm.foreignChunkEnteredEnvelope ? "Acme's renewal playbook and Pied Piper's private note" : "Acme's renewal playbook only";
  const released = releasedText(arm);

  return (
    <aside className="lc-drawer" aria-label="Receipt">
      <div className="lc-drawer-head">
        <strong>Receipt</strong>
        <button type="button" className="lc-ghost" onClick={onClose} aria-label="Close receipt">
          Close
        </button>
      </div>
      <p className="lc-mute">
        Vervain {vervainOn ? 'ON' : 'OFF'} · {arm.receiptId}
      </p>
      <dl className="lc-facts">
        <dt>Search found</dt>
        <dd>
          {arm.counts.retrieved} files (Acme's renewal playbook, Pied Piper's private strategy note)
        </dd>
        <dt>The AI saw</dt>
        <dd>{seen}</dd>
        <dt>Blocked</dt>
        <dd>{arm.counts.withheld} file{arm.counts.withheld === 1 ? '' : 's'}</dd>
        <dt>Released</dt>
        <dd>{released}</dd>
        <dt>Private text stored</dt>
        <dd>None</dd>
      </dl>
      <button type="button" className="lc-run" onClick={runCheck} disabled={checking}>
        {checking ? 'Checking...' : 'Check the receipt'}
      </button>
      {check ? (
        <p className={`lc-check ${check.verified ? 'is-ok' : 'is-bad'}`}>
          {check.verified
            ? `Verified: ${check.checkedReceipts} receipts, ${check.checkedEvents} events, chain intact.`
            : `Failed: ${check.failureReason ?? 'chain mismatch'}.`}
        </p>
      ) : null}
      {checkError ? <p className="lc-check is-bad">{checkError}</p> : null}

      <section className="lc-gpu">
        <strong>On our own GPU</strong>
        <p>NVIDIA H200 · vLLM 0.30.0 · Qwen2.5-7B-Instruct (open model).</p>
        <p>Vervain off: the model's answer contained Pied Piper's secret project code (2 of 2 runs).</p>
        <p>Vervain on: Pied Piper's note was blocked, Acme got its answer, receipt verified.</p>
      </section>
    </aside>
  );
}
