/**
 * Responsibility: Root single-page judge workspace coordinating session bootstrap,
 * paired proof execution, clean/revocation scenarios, causal graph inspection,
 * receipt chain verification, and the Scoped Attention Reference Lab.
 * Trust boundary: Browser client shell; all authority and enforcement reside on the server.
 */

import { useCallback, useEffect, useState } from 'react';
import type { PersonaId, ProvenanceNodeId } from '../shared/contracts.js';
import {
  ClientApiError,
  createOrSwitchPersonaSession,
  fetchDemoState,
  fetchEnterpriseArchitecture,
  fetchScopedAttentionProof,
  resetDemoSessionRequest,
  runCleanDemoRequest,
  runPairedProofRequest,
  runRevokeDuringGenerationRequest,
  verifyLedgerChainRequest,
} from './api.js';
import { EnterpriseArchitectureStrip } from './components/EnterpriseArchitectureStrip.js';
import { EvidenceDrawer } from './components/EvidenceDrawer.js';
import { PairedLanes } from './components/PairedLanes.js';
import { ProvenanceGraph } from './components/ProvenanceGraph.js';
import { ScenarioControls } from './components/ScenarioControls.js';
import { ScopedAttentionLab } from './components/ScopedAttentionLab.js';
import { StatusStrip } from './components/StatusStrip.js';
import {
  INITIAL_WORKSPACE_UI_STATE,
  resolveInspectedArmExecution,
  type WorkspaceUiState,
} from './state.js';

export function App() {
  const [ui, setUi] = useState<WorkspaceUiState>(INITIAL_WORKSPACE_UI_STATE);

  const bootstrapSessionAndState = useCallback(async () => {
    setUi((prev) => ({ ...prev, loadingInitial: true, errorBanner: null }));
    const autoOpenReplayFromUrl =
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('run');
    try {
      const state = await fetchDemoState();
      const [arch, initialScopedProof] = await Promise.all([
        fetchEnterpriseArchitecture().catch(() => null),
        autoOpenReplayFromUrl ? fetchScopedAttentionProof().catch(() => null) : Promise.resolve(null),
      ]);
      setUi((prev) => ({
        ...prev,
        loadingInitial: false,
        demoState: state,
        enterpriseArchitecture: arch,
        scopedProof: initialScopedProof ?? prev.scopedProof,
        scopedLabOpen: initialScopedProof !== null ? true : prev.scopedLabOpen,
        chainVerification: state.ledgerSummary,
      }));
    } catch (err: unknown) {
      if (err instanceof ClientApiError && err.status === 401) {
        try {
          await createOrSwitchPersonaSession('alder');
          const [freshState, arch, initialScopedProof] = await Promise.all([
            fetchDemoState(),
            fetchEnterpriseArchitecture().catch(() => null),
            autoOpenReplayFromUrl
              ? fetchScopedAttentionProof().catch(() => null)
              : Promise.resolve(null),
          ]);
          setUi((prev) => ({
            ...prev,
            loadingInitial: false,
            demoState: freshState,
            enterpriseArchitecture: arch,
            scopedProof: initialScopedProof ?? prev.scopedProof,
            scopedLabOpen: initialScopedProof !== null ? true : prev.scopedLabOpen,
            chainVerification: freshState.ledgerSummary,
          }));
          return;
        } catch (innerErr: unknown) {
          setUi((prev) => ({
            ...prev,
            loadingInitial: false,
            errorBanner:
              innerErr instanceof Error
                ? innerErr.message
                : 'Unable to initialize synthetic demo session.',
          }));
          return;
        }
      }
      setUi((prev) => ({
        ...prev,
        loadingInitial: false,
        errorBanner: err instanceof Error ? err.message : 'Unable to load workspace state.',
      }));
    }
  }, []);

  useEffect(() => {
    void bootstrapSessionAndState();
  }, [bootstrapSessionAndState]);

  const handleSwitchPersona = async (persona: PersonaId): Promise<void> => {
    setUi((prev) => ({ ...prev, activeAction: 'switching_persona', errorBanner: null }));
    try {
      await createOrSwitchPersonaSession(persona);
      const freshState = await fetchDemoState();
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        demoState: freshState,
        chainVerification: freshState.ledgerSummary,
        scopedProof: null,
        scopedLabOpen: false,
        stageFocus: 'paired',
        inspectedArm: 'native_plus_vervain',
        selectedNodeId: 'context_gate',
      }));
    } catch (err: unknown) {
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        errorBanner: err instanceof Error ? err.message : 'Persona rotation failed.',
      }));
    }
  };

  const handleRunPaired = async (): Promise<void> => {
    if (ui.activeAction !== null) return;
    setUi((prev) => ({ ...prev, activeAction: 'running_paired', errorBanner: null }));
    try {
      const res = await runPairedProofRequest();
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        stageFocus: 'paired',
        inspectedArm: 'native_plus_vervain',
        selectedNodeId: 'context_gate',
        chainVerification: res.ledgerSummary,
        runPulseCounter: prev.runPulseCounter + 1,
        demoState: prev.demoState
          ? {
              ...prev.demoState,
              session: res.session,
              latestPairedRun: res.pairedRun,
              ledgerSummary: res.ledgerSummary,
            }
          : null,
      }));
    } catch (err: unknown) {
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        errorBanner: err instanceof Error ? err.message : 'Paired proof request failed.',
      }));
    }
  };

  const handleRunClean = async (): Promise<void> => {
    if (ui.activeAction !== null) return;
    setUi((prev) => ({ ...prev, activeAction: 'running_clean', errorBanner: null }));
    try {
      const res = await runCleanDemoRequest();
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        stageFocus: 'single',
        selectedNodeId: 'context_gate',
        chainVerification: res.ledgerSummary,
        runPulseCounter: prev.runPulseCounter + 1,
        demoState: prev.demoState
          ? {
              ...prev.demoState,
              session: res.session,
              latestSingleRun: res.run,
              ledgerSummary: res.ledgerSummary,
            }
          : null,
      }));
    } catch (err: unknown) {
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        errorBanner: err instanceof Error ? err.message : 'Clean request failed.',
      }));
    }
  };

  const handleRunRevoke = async (): Promise<void> => {
    if (ui.activeAction !== null) return;
    setUi((prev) => ({ ...prev, activeAction: 'running_revoke', errorBanner: null }));
    try {
      const res = await runRevokeDuringGenerationRequest();
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        stageFocus: 'single',
        selectedNodeId: 'release_gate',
        chainVerification: res.ledgerSummary,
        runPulseCounter: prev.runPulseCounter + 1,
        demoState: prev.demoState
          ? {
              ...prev.demoState,
              session: res.session,
              latestSingleRun: res.run,
              ledgerSummary: res.ledgerSummary,
            }
          : null,
      }));
    } catch (err: unknown) {
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        errorBanner: err instanceof Error ? err.message : 'Epoch revocation run failed.',
      }));
    }
  };

  const handleReset = async (): Promise<void> => {
    if (ui.activeAction !== null) return;
    setUi((prev) => ({ ...prev, activeAction: 'resetting', errorBanner: null }));
    try {
      await resetDemoSessionRequest();
      const freshState = await fetchDemoState();
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        demoState: freshState,
        chainVerification: freshState.ledgerSummary,
        stageFocus: 'paired',
        inspectedArm: 'native_plus_vervain',
        selectedNodeId: 'context_gate',
      }));
    } catch (err: unknown) {
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        errorBanner: err instanceof Error ? err.message : 'Reset failed.',
      }));
    }
  };

  const handleVerifyChain = async (): Promise<void> => {
    setUi((prev) => ({ ...prev, activeAction: 'verifying_chain', errorBanner: null }));
    try {
      const check = await verifyLedgerChainRequest();
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        chainVerification: check,
      }));
    } catch (err: unknown) {
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        errorBanner: err instanceof Error ? err.message : 'Ledger verification failed.',
      }));
    }
  };

  const handleToggleScopedLab = async (): Promise<void> => {
    if (ui.scopedLabOpen) {
      setUi((prev) => ({ ...prev, scopedLabOpen: false }));
      return;
    }
    if (ui.scopedProof) {
      setUi((prev) => ({ ...prev, scopedLabOpen: true }));
      return;
    }
    setUi((prev) => ({ ...prev, activeAction: 'loading_scoped_lab', errorBanner: null }));
    try {
      const proof = await fetchScopedAttentionProof();
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        scopedLabOpen: true,
        scopedProof: proof,
      }));
    } catch (err: unknown) {
      setUi((prev) => ({
        ...prev,
        activeAction: null,
        errorBanner: err instanceof Error ? err.message : 'Scoped attention proof failed.',
      }));
    }
  };

  if (ui.loadingInitial || !ui.demoState) {
    return (
      <main className="app-shell" data-testid="app-loading">
        <div style={{ padding: '32px 0', color: 'var(--text-muted)' }}>
          {ui.errorBanner ?? 'Initializing synthetic session boundary...'}
        </div>
      </main>
    );
  }

  const { demoState } = ui;
  const hasPaired = demoState.latestPairedRun !== null;
  const hasSingle = demoState.latestSingleRun !== null;
  const activeMode: 'empty' | 'paired' | 'single' =
    ui.stageFocus === 'single' && hasSingle
      ? 'single'
      : hasPaired
        ? 'paired'
        : hasSingle
          ? 'single'
          : 'empty';

  const inspectedExecution = resolveInspectedArmExecution(ui);

  return (
    <div className="app-shell">
      <StatusStrip session={demoState.session} runtime={demoState.runtime} />

      <main>
        <ScenarioControls
          session={demoState.session}
          frozenQuery={demoState.frozenQuery}
          querySha256={demoState.querySha256}
          fixtureId={demoState.fixtureId}
          activeAction={ui.activeAction}
          onSwitchPersona={(p) => void handleSwitchPersona(p)}
          onRunPaired={() => void handleRunPaired()}
          onRunClean={() => void handleRunClean()}
          onRunRevoke={() => void handleRunRevoke()}
          onReset={() => void handleReset()}
        />

        {ui.errorBanner && (
          <div className="banner banner--error" role="alert" data-testid="error-banner">
            <span>{ui.errorBanner}</span>
            <button
              type="button"
              className="btn btn--subtle"
              onClick={() => setUi((prev) => ({ ...prev, errorBanner: null }))}
            >
              Dismiss
            </button>
          </div>
        )}

        {demoState.session.persona === 'alder' && demoState.session.policyEpoch > 7 && (
          <div className="banner banner--warning" data-testid="revoked-epoch-banner">
            <span>
              Session policy epoch is currently{' '}
              <strong className="mono">alder-context@{demoState.session.policyEpoch}</strong>{' '}
              (epoch 7 context revoked). Subsequent requests withhold epoch-7 chunks with{' '}
              <span className="mono">stale_policy_epoch</span> until you reset the synthetic
              session.
            </span>
          </div>
        )}

        {hasPaired && hasSingle && (
          <div className="view-switcher">
            <div className="tab-group" role="tablist" aria-label="Execution view mode">
              <button
                type="button"
                className={`tab-btn ${activeMode === 'paired' ? 'tab-btn--active' : ''}`}
                data-testid="switch-to-paired-view"
                onClick={() => setUi((prev) => ({ ...prev, stageFocus: 'paired' }))}
              >
                Paired Defect Comparison
              </button>
              <button
                type="button"
                className={`tab-btn ${activeMode === 'single' ? 'tab-btn--active' : ''}`}
                data-testid="switch-to-single-view"
                onClick={() => setUi((prev) => ({ ...prev, stageFocus: 'single' }))}
              >
                Latest Single Run ({demoState.latestSingleRun?.receipt.scenario})
              </button>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {demoState.runtime.instanceLifetimeNote}
            </span>
          </div>
        )}

        <PairedLanes
          mode={activeMode}
          nativeOnly={demoState.latestPairedRun?.nativeOnly ?? null}
          nativePlusVervain={demoState.latestPairedRun?.nativePlusVervain ?? null}
          singleRun={demoState.latestSingleRun}
          inspectedArm={ui.inspectedArm}
          onSelectArmForInspection={(arm) =>
            setUi((prev) => ({ ...prev, inspectedArm: arm }))
          }
        />

        {inspectedExecution && (
          <div className="workspace-lower-grid">
            <ProvenanceGraph
              execution={inspectedExecution}
              selectedNodeId={ui.selectedNodeId}
              onSelectNode={(nodeId: ProvenanceNodeId) =>
                setUi((prev) => ({ ...prev, selectedNodeId: nodeId }))
              }
              runPulseCounter={ui.runPulseCounter}
              pairedAvailable={activeMode === 'paired'}
              onSwitchInspectedArm={(arm) =>
                setUi((prev) => ({ ...prev, inspectedArm: arm }))
              }
            />

            <EvidenceDrawer
              execution={inspectedExecution}
              chainVerification={ui.chainVerification ?? demoState.ledgerSummary}
              verifyingChain={ui.activeAction === 'verifying_chain'}
              onVerifyChain={() => void handleVerifyChain()}
            />
          </div>
        )}

        {ui.enterpriseArchitecture && (
          <EnterpriseArchitectureStrip
            presets={ui.enterpriseArchitecture.presets}
            engineProfiles={ui.enterpriseArchitecture.engineProfiles}
            inferenceProof={ui.enterpriseArchitecture.inferenceProof}
          />
        )}

        <ScopedAttentionLab
          isOpen={ui.scopedLabOpen}
          loading={ui.activeAction === 'loading_scoped_lab'}
          proof={ui.scopedProof}
          inferenceProof={ui.enterpriseArchitecture?.inferenceProof ?? null}
          onToggle={() => void handleToggleScopedLab()}
        />
      </main>
    </div>
  );
}
