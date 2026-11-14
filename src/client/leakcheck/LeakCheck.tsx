/**
 * Responsibility: The demo's main screen. The stock Vervain DataMap runs full screen; two
 * additions sit on top of it: (1) a live leak check that replays one arm of a real paired run
 * on Gemini as DataMap activity, and (2) a receipt drawer with a ledger check and the measured
 * results from our own GPU run.
 * Trust boundary: Untrusted browser bundle; it only calls the existing public demo API.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ArmExecutionView, DemoStateResponse, LedgerVerificationResult } from '../../shared/contracts.js';
import { fetchDemoState, runPairedProofRequest, verifyLedgerChainRequest } from '../api.js';
import { BrandLogo } from '../datamap/BrandLogo.jsx';
import { DataMap, type DataMapSource } from '../datamap/DataMap.jsx';
import { snapshotAt, type Observation } from '../datamap/fixtures.mjs';
import './leakcheck.css';

type Paired = NonNullable<DemoStateResponse['latestPairedRun']>;

/** Display names for the replayed actors (the DataMap reads `name`; `model` keeps them ungrouped). */
const ACTORS: Record<string, string> = {
  assistant: "Alder's AI assistant",
  search: 'Search (missing company filter)',
  gemini: 'Gemini 4 Carbon',
};

const ALDER_NOTE = '/Alder/Alder renewal playbook';
const BEACON_NOTE = '/Beacon/Beacon strategy note (other company)';

/** One arm of a real paired run, laid out as activity over about seven seconds from `t0`. */
export function armObservations(arm: ArmExecutionView, t0: number): Observation[] {
  const s = (sec: number) => t0 + sec * 1000;
  const on = arm.arm !== 'native_only';
  const beaconReachedModel = arm.foreignChunkEnteredEnvelope;
  const released = arm.releaseDecision === 'released' || arm.releasedAnswerText !== null;
  const client = 'vervain-demo';
  const obs: Observation[] = [
    { agent: 'assistant', at: s(0), kind: 'session_start', client },
    { agent: 'assistant', at: s(0.5), kind: 'user_prompt', client },
    { agent: 'search', at: s(1.2), kind: 'subagent_start', parent: 'assistant', client },
    { agent: 'search', at: s(2.0), kind: 'file_read', op: 'read', path: ALDER_NOTE, status: 'completed', parent: 'assistant', client },
    { agent: 'search', at: s(2.9), kind: 'file_read', op: 'read', path: BEACON_NOTE, status: on && !beaconReachedModel ? 'denied' : 'completed', parent: 'assistant', client },
    { agent: 'gemini', at: s(3.9), kind: 'subagent_start', parent: 'assistant', client },
    { agent: 'gemini', at: s(4.6), kind: 'file_read', op: 'read', path: ALDER_NOTE, status: 'completed', parent: 'assistant', client },
  ];
  if (beaconReachedModel) {
    obs.push({ agent: 'gemini', at: s(5.2), kind: 'file_read', op: 'read', path: BEACON_NOTE, status: 'completed', parent: 'assistant', client });
  }
  obs.push(
    { agent: 'gemini', at: s(6.0), kind: 'file_write', op: 'write', path: '/Answers/Answer to Alder', status: released ? 'completed' : 'denied', parent: 'assistant', client },
    { agent: 'assistant', at: s(6.8), kind: 'file_write', op: 'write', path: `/Receipts/Receipt ${arm.receiptId}`, status: 'completed', client },
  );
  return obs;
}

function idleObservations(t0: number): Observation[] {
  return [{ agent: 'assistant', at: t0, kind: 'session_start', client: 'vervain-demo' }];
}

/** A DataMap source with the same {label, clock, interval, poll} contract as the stock harness. */
function replaySource(observations: Observation[], t0: number): DataMapSource {
  const sc = { observations, t0, span: 9000, title: 'Leak check' };
  return {
    label: 'Two companies, one AI assistant',
    clock: () => Date.now(),
    interval: 400,
    async poll() {
      const snap = snapshotAt(sc, Date.now());
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

  useEffect(() => {
    fetchDemoState().then(setDemo).catch(() => setDemo(null));
  }, []);

  const arm = paired ? armOf(paired, vervainOn) : null;
  const source = useMemo(
    () => replaySource(arm ? armObservations(arm, startedAt) : idleObservations(startedAt), startedAt),
    [arm, startedAt],
  );

  const mode = arm?.providerRuntime.mode ?? demo?.runtime.mode ?? null;
  const isLive = mode === 'live';
  const model = arm?.providerRuntime.model ?? demo?.runtime.configuredModel ?? 'Gemini 4 Carbon';

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const result = await runPairedProofRequest();
      setPaired(result.pairedRun);
      setStartedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The run failed.');
    } finally {
      setRunning(false);
    }
  }

  function toggle() {
    setVervainOn((v) => !v);
    if (paired) setStartedAt(Date.now());
  }

  const sentence = arm
    ? vervainOn
      ? "Vervain stopped Beacon's note before Gemini saw it. Alder still got its answer."
      : "Without Vervain, Beacon's private note went straight into Gemini."
    : "Two companies share one AI assistant. Run Alder's request: a search bug will also grab Beacon's private note.";

  return (
    <div className="lc-root">
      <header className="lc-bar">
        <div className="lc-brand">
          <BrandLogo className="lc-logo" decorative={false} />
          <span className="lc-name">Vervain</span>
        </div>
        <span className={`lc-chip ${isLive ? 'is-live' : 'is-mock'}`} title={`Model: ${model}`}>
          Alder is asking · Gemini 4 Carbon · {mode === null ? '...' : isLive ? 'LIVE' : 'MOCK'}
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
            {running ? 'Asking Gemini...' : "Run Alder's request"}
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
          key={`${paired?.runGroupId ?? 'idle'}-${vervainOn ? 'on' : 'off'}-${startedAt}`}
          source={source}
          initialSettings={{ physics: true }}
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

  const seen = arm.foreignChunkEnteredEnvelope ? "Alder's playbook and Beacon's private note" : "Alder's playbook only";
  const released = arm.releasedAnswerText !== null ? 'Answer sent to Alder' : 'No answer sent';

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
          {arm.counts.retrieved} notes (Alder's playbook, Beacon's strategy note)
        </dd>
        <dt>The AI saw</dt>
        <dd>{seen}</dd>
        <dt>Stopped</dt>
        <dd>{arm.counts.withheld} note{arm.counts.withheld === 1 ? '' : 's'}</dd>
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
        <p>Vervain off: the model's answer contained Beacon's secret project code (2 of 2 runs).</p>
        <p>Vervain on: Beacon's note was stopped, Alder got its answer, receipt verified.</p>
      </section>
    </aside>
  );
}
