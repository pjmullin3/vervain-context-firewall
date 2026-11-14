/**
 * Responsibility: The demo's main screen. The stock Vervain DataMap runs full screen; two
 * additions sit on top of it: (1) a live leak check that replays one arm of a real paired run
 * on the configured model as DataMap activity, and (2) a receipt drawer with a ledger check and the measured
 * results from our own GPU run.
 * Trust boundary: Untrusted browser bundle; it only calls the existing public demo API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArmExecutionView, DemoStateResponse, LedgerVerificationResult, PersonaId } from '../../shared/contracts.js';
import { createOrSwitchPersonaSession, fetchDemoState, runPairedProofRequest, verifyLedgerChainRequest } from '../api.js';
import { BrandLogo } from '../datamap/BrandLogo.jsx';
import { DataMap, type DataMapSource } from '../datamap/DataMap.jsx';
import { snapshotAt, type Observation } from '../datamap/fixtures.mjs';
import { modelLabels } from '../../shared/provider-labels.js';
import './leakcheck.css';

type Paired = NonNullable<DemoStateResponse['latestPairedRun']>;

/** Display names for API ids. The backend keeps its ids (alder, beacon); people only ever see these names. */
export const DISPLAY_NAMES: Record<string, string> = {
  alder: 'Acme Co.',
  beacon: 'Pied Piper',
  'alder/renewal-playbook-v3': "Acme's renewal playbook",
  'beacon/strategy-note-v2': "Pied Piper's private strategy note",
};
/** The company the demo opens as. */
const DEFAULT_ASKER: PersonaId = 'alder';
/** Longest question the server accepts (it re-checks). */
const MAX_QUESTION_LENGTH = 300;

/**
 * Who is asking, and everything on screen that depends on it. The asker's own note is always
 * allowed; the other company's note is the one the search bug drags in.
 */
export interface Cast {
  asker: PersonaId;
  /** Asker display name, e.g. "Acme Co.". */
  name: string;
  /** Other company display name. */
  otherName: string;
  /** Possessive short names used in sentences. */
  own: string;
  other: string;
  ownFile: string;
  otherFile: string;
  ownNote: string;
  otherNote: string;
  /** Short name of the other company's file for headline sentences. */
  otherShort: string;
  answerFile: string;
}

const FILES: Record<PersonaId, string> = {
  alder: '/Acme Co./renewal-playbook.md',
  beacon: '/Pied Piper/private-strategy-note.md',
};
const POSSESSIVE: Record<PersonaId, string> = { alder: "Acme's", beacon: "Pied Piper's" };
const ANSWER_FILES: Record<PersonaId, string> = {
  alder: '/Answers/answer-to-acme.md',
  beacon: '/Answers/answer-to-pied-piper.md',
};
const SHORT_NOTE: Record<PersonaId, string> = {
  alder: "Acme's renewal playbook",
  beacon: "Pied Piper's private note",
};
const NOTE_IDS: Record<PersonaId, string> = {
  alder: 'alder/renewal-playbook-v3',
  beacon: 'beacon/strategy-note-v2',
};

export function castFor(asker: PersonaId): Cast {
  const other: PersonaId = asker === 'alder' ? 'beacon' : 'alder';
  return {
    asker,
    name: DISPLAY_NAMES[asker] ?? asker,
    otherName: DISPLAY_NAMES[other] ?? other,
    own: POSSESSIVE[asker],
    other: POSSESSIVE[other],
    ownFile: FILES[asker],
    otherFile: FILES[other],
    ownNote: DISPLAY_NAMES[NOTE_IDS[asker]] ?? NOTE_IDS[asker],
    otherNote: DISPLAY_NAMES[NOTE_IDS[other]] ?? NOTE_IDS[other],
    otherShort: SHORT_NOTE[other],
    answerFile: ANSWER_FILES[asker],
  };
}

/** Display names for the replayed actors (the DataMap reads `name`; `model` keeps them ungrouped). Each says who acts. */
function actorsFor(cast: Cast, modelNode: string): Record<string, string> {
  return {
    assistant: `${cast.name} AI assistant`,
    search: 'Search tool',
    gemini: modelNode,
  };
}
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
export function requestObservations(cast: Cast, t0: number): Observation[] {
  return timed(
    [
      { agent: 'assistant', kind: 'session_start', client },
      { agent: 'assistant', kind: 'user_prompt', client },
      { agent: 'search', kind: 'subagent_start', parent: 'assistant', client },
      { agent: 'search', kind: 'file_read', op: 'read', path: cast.ownFile, status: PENDING, parent: 'assistant', client },
      { agent: 'search', kind: 'file_read', op: 'read', path: cast.otherFile, status: PENDING, parent: 'assistant', client },
    ],
    t0,
  );
}

/** The steps that follow from one arm of the real paired run, starting at `t1`. */
export function resultObservations(cast: Cast, arm: ArmExecutionView, t1: number): Observation[] {
  const leaked = arm.foreignChunkEnteredEnvelope;
  const called = modelCalled(arm);
  const steps: Step[] = [
    { agent: 'search', kind: 'file_read', op: 'read', path: cast.ownFile, status: called ? 'completed' : 'denied', parent: 'assistant', client },
    { agent: 'search', kind: 'file_read', op: 'read', path: cast.otherFile, status: leaked ? 'completed' : 'denied', parent: 'assistant', client },
  ];
  if (called) {
    steps.push(
      { agent: 'gemini', kind: 'subagent_start', parent: 'assistant', client },
      { agent: 'gemini', kind: 'file_read', op: 'read', path: cast.ownFile, status: 'completed', parent: 'assistant', client },
    );
    if (leaked) steps.push({ agent: 'gemini', kind: 'file_read', op: 'read', path: cast.otherFile, status: 'completed', parent: 'assistant', client });
    steps.push({ agent: 'gemini', kind: 'file_write', op: 'write', path: cast.answerFile, status: answerReleased(arm) ? 'completed' : 'failed', parent: 'assistant', client });
  }
  steps.push({ agent: 'assistant', kind: 'file_write', op: 'write', path: receiptPath(arm.receiptId), status: 'completed', client });
  return timed(steps, t1);
}

/** When the result steps start for a replay that began at `t0`. */
export const resultStart = (t0: number) => t0 + REQUEST_STEPS * STEP;

/** A full replay of one arm: the request steps, then the result steps. */
export function armObservations(cast: Cast, arm: ArmExecutionView, t0: number): Observation[] {
  return [...requestObservations(cast, t0), ...resultObservations(cast, arm, resultStart(t0))];
}

/** Card labels for one arm: the other company's note says BLOCKED or LEAKED once that step plays; a rejected answer says so. */
export function armTags(cast: Cast, arm: ArmExecutionView, observations: Observation[], modelShort = 'Gemini'): CardTag[] {
  const leaked = arm.foreignChunkEnteredEnvelope;
  const at = (agent: string, path: string) => observations.find((o) => o.agent === agent && o.path === path && o.status !== PENDING)?.at;
  const tags: CardTag[] = [];
  const blockedOrLeakedAt = leaked ? at('gemini', cast.otherFile) : at('search', cast.otherFile);
  if (blockedOrLeakedAt !== undefined) {
    tags.push(
      leaked
        ? { path: cast.otherFile, from: blockedOrLeakedAt, text: `LEAKED into ${modelShort}`, tone: 'leaked' }
        : { path: cast.otherFile, from: blockedOrLeakedAt, text: 'BLOCKED by Vervain', tone: 'blocked' },
    );
  }
  const answerAt = at('gemini', cast.answerFile);
  if (!answerReleased(arm) && answerAt !== undefined) tags.push({ path: cast.answerFile, from: answerAt, text: 'No usable answer', tone: 'neutral' });
  const ownHeldAt = modelCalled(arm) ? undefined : at('search', cast.ownFile);
  if (ownHeldAt !== undefined) tags.push({ path: cast.ownFile, from: ownHeldAt, text: 'Restricted: not sent to AI', tone: 'neutral' });
  return tags;
}

/** Whether the model was called at all (Vervain skips it when no file is allowed through). */
function modelCalled(arm: ArmExecutionView): boolean {
  return arm.providerRuntime.callAttempted;
}

/** Acme got an answer unless Vervain held it back or the model call failed. */
function answerReleased(arm: ArmExecutionView): boolean {
  return arm.releaseDecision !== 'withheld' && arm.providerRuntime.outcome === 'succeeded';
}

/** The receipt's "Released" line, worded for why no answer went out. */
export function releasedText(cast: Cast, arm: ArmExecutionView): string {
  if (answerReleased(arm)) return `Answer sent to ${cast.name}`;
  if (!modelCalled(arm)) return 'No answer (no file was allowed to reach the AI, so it was not called)';
  if (arm.releaseReason === 'planted_value_detected') {
    return 'No answer sent (it contained the secret project code, so Vervain held it back)';
  }
  if (arm.providerRuntime.outcome === 'invalid_response' || arm.releaseDecision === 'withheld') {
    return 'No usable answer (model output rejected by format check)';
  }
  return 'No usable answer';
}

function idleObservations(t0: number): Observation[] {
  return [{ agent: 'assistant', at: t0, kind: 'session_start', client }];
}

/** A DataMap source with the same {label, clock, interval, poll} contract as the stock harness. Reads observations from a ref so the map keeps its layout while the result streams in. */
function replaySource(cast: Cast, observations: { current: Observation[] }, t0: number, modelNode: string): DataMapSource {
  const actors = actorsFor(cast, modelNode);
  return {
    label: cast.name,
    clock: () => Date.now(),
    interval: 300,
    async poll() {
      const snap = snapshotAt({ observations: observations.current, t0, span: 12000, title: 'Leak check' }, Date.now());
      for (const session of snap.sessions) {
        const name = actors[String(session.id)] ?? String(session.id);
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
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [asker, setAsker] = useState<PersonaId>(DEFAULT_ASKER);
  const [question, setQuestion] = useState('');
  /** The question the shown result answered (null = the built-in question). */
  const [askedQuestion, setAskedQuestion] = useState<string | null>(null);
  const cast = useMemo(() => castFor(asker), [asker]);

  const observations = useRef<Observation[]>(idleObservations(startedAt));
  const tags = useRef<CardTag[]>([]);

  useEffect(() => {
    // The demo opens as Acme: open (or reuse) Acme's synthetic session first.
    createOrSwitchPersonaSession(DEFAULT_ASKER)
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
  const mode = arm?.providerRuntime.mode ?? demo?.runtime.mode ?? null;
  const isLive = mode === 'live';
  const labels = modelLabels(demo?.runtime ?? null, mode, arm?.providerRuntime.model);
  const model = arm?.providerRuntime.model ?? demo?.runtime.configuredModel ?? labels.short;
  const source = useMemo(() => replaySource(cast, observations, startedAt, labels.node), [cast, startedAt, labels.node]);
  const cardTag = useCallback((node: { kind: string; meta?: Record<string, unknown> }) => {
    if (node.kind !== 'file') return null;
    const now = Date.now();
    const tag = tags.current.find((t) => t.path === node.meta?.path && now >= t.from);
    return tag ? { text: tag.text, tone: tag.tone } : null;
  }, []);


  async function run() {
    setRunning(true);
    setError(null);
    setPaired(null);
    const asked = question.trim();
    const t0 = Date.now();
    observations.current = requestObservations(cast, t0);
    tags.current = [];
    setStartedAt(t0);
    try {
      const result = await runPairedProofRequest(asked);
      const runArm = armOf(result.pairedRun, vervainOn);
      const t1 = Math.max(Date.now() + STEP, resultStart(t0));
      observations.current = [...requestObservations(cast, t0), ...resultObservations(cast, runArm, t1)];
      tags.current = armTags(cast, runArm, observations.current, labels.short);
      setAskedQuestion(asked.length > 0 ? asked : null);
      setPaired(result.pairedRun);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The run failed.');
    } finally {
      setRunning(false);
    }
  }

  /** Switches who is asking through the existing server session switch, then clears the old result. */
  async function switchAsker(next: PersonaId) {
    if (next === asker || running || switching) return;
    setSwitching(true);
    setError(null);
    try {
      await createOrSwitchPersonaSession(next);
      setDemo(await fetchDemoState());
      const t0 = Date.now();
      observations.current = idleObservations(t0);
      tags.current = [];
      setPaired(null);
      setAskedQuestion(null);
      setDrawerOpen(false);
      setAsker(next);
      setStartedAt(t0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch who is asking.');
    } finally {
      setSwitching(false);
    }
  }

  /** Replays one arm of the last result from its first step, re-seeding the clock to now. */
  function replay(on: boolean) {
    if (!paired || running) return;
    const t0 = Date.now();
    const replayArm = armOf(paired, on);
    observations.current = armObservations(cast, replayArm, t0);
    tags.current = armTags(cast, replayArm, observations.current, labels.short);
    setStartedAt(t0);
  }

  function toggle() {
    const next = !vervainOn;
    setVervainOn(next);
    replay(next);
  }

  const sentence = arm
    ? vervainOn
      ? `BLOCKED. ${cast.otherShort} never reached the AI. ${
          answerReleased(arm)
            ? `${cast.name} still got its answer.`
            : modelCalled(arm)
              ? `${releasedText(cast, arm)}.`
              : `${cast.own} own note is restricted too, so the AI was not called.`
        }`
      : `LEAKED. ${cast.otherShort} went straight into the AI.`
    : running
      ? `${cast.name} asks. The search bug grabs ${cast.otherShort} too. Asking ${labels.short}...`
      : `Acme Co. and Pied Piper share one AI assistant. Vervain controls what the agent reads before it reasons.`;

  const answerText = arm && answerReleased(arm) ? arm.releasedAnswerText : null;
  const placeholder = asker === 'alder' ? "e.g. What is Pied Piper's project code?" : "e.g. What is Acme's renewal discount?";

  return (
    <div className="lc-root">
      <header className="lc-bar">
        <div className="lc-brand">
          <BrandLogo className="lc-logo" decorative={false} />
          <span className="lc-name">Vervain</span>
        </div>
        <span className={`lc-chip ${isLive ? 'is-live' : 'is-mock'}`} title={`Model: ${model}`}>
          {labels.chip}
        </span>
        <div className="lc-asker" role="radiogroup" aria-label="Asking as">
          <span className="lc-asker-label">Asking as:</span>
          {(['alder', 'beacon'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={asker === id}
              className={`lc-seg ${asker === id ? 'is-current' : ''}`}
              onClick={() => void switchAsker(id)}
              disabled={running || switching}
            >
              {DISPLAY_NAMES[id]}
            </button>
          ))}
        </div>
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
          <form
            className="lc-ask"
            onSubmit={(e) => {
              e.preventDefault();
              if (!running && !switching) void run();
            }}
          >
            <label className="lc-ask-label" htmlFor="lc-question">
              Ask as {cast.name}
            </label>
            <input
              id="lc-question"
              className="lc-input"
              type="text"
              value={question}
              maxLength={MAX_QUESTION_LENGTH}
              placeholder={placeholder}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={running || switching}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="submit" className="lc-run" disabled={running || switching}>
              {running ? `Asking ${labels.short}...` : `Run ${cast.own} request`}
            </button>
          </form>
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
          key={`${asker}-${startedAt}`}
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
        {arm && !error ? (
          <section className={`lc-answer ${vervainOn ? 'is-on' : 'is-off'}`} aria-label="Question and answer">
            <p className="lc-q">
              <span>{cast.name} asked</span>
              {askedQuestion ?? arm.frozenQueryText}
            </p>
            <p className="lc-a">
              <span>Vervain {vervainOn ? 'ON' : 'OFF'} · {labels.short} answered</span>
              {answerText !== null ? answerText : `${releasedText(cast, arm)}.`}
            </p>
          </section>
        ) : null}
      </div>

      {drawerOpen && paired && arm ? (
        <ReceiptDrawer cast={cast} arm={arm} vervainOn={vervainOn} onClose={() => setDrawerOpen(false)} />
      ) : null}
    </div>
  );
}

function ReceiptDrawer({ cast, arm, vervainOn, onClose }: { cast: Cast; arm: ArmExecutionView; vervainOn: boolean; onClose: () => void }) {
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

  const seen = !modelCalled(arm)
    ? 'Nothing (the AI was not called)'
    : arm.foreignChunkEnteredEnvelope
      ? `${cast.ownNote} and ${cast.otherNote}`
      : `${cast.ownNote} only`;
  const released = releasedText(cast, arm);

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
          {arm.counts.retrieved} files ({cast.ownNote}, {cast.otherNote})
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
