/**
 * Responsibility: Pure UI view-state types and selection helpers for the judge workspace.
 * Trust boundary: Client presentation state only; holds no authority.
 */

import type {
  ArmExecutionView,
  ArmId,
  DemoStateResponse,
  LedgerVerificationResult,
  ProvenanceNodeId,
  ScopedAttentionProofView,
} from '../shared/contracts.js';

export type ActiveStageFocus = 'paired' | 'single';

export interface WorkspaceUiState {
  readonly loadingInitial: boolean;
  readonly activeAction:
    | null
    | 'switching_persona'
    | 'running_paired'
    | 'running_clean'
    | 'running_revoke'
    | 'resetting'
    | 'verifying_chain'
    | 'loading_scoped_lab';
  readonly errorBanner: string | null;
  readonly demoState: DemoStateResponse | null;
  readonly stageFocus: ActiveStageFocus;
  readonly inspectedArm: ArmId;
  readonly selectedNodeId: ProvenanceNodeId;
  readonly chainVerification: LedgerVerificationResult | null;
  readonly scopedLabOpen: boolean;
  readonly scopedProof: ScopedAttentionProofView | null;
  readonly runPulseCounter: number;
}

export const INITIAL_WORKSPACE_UI_STATE: WorkspaceUiState = {
  loadingInitial: true,
  activeAction: null,
  errorBanner: null,
  demoState: null,
  stageFocus: 'paired',
  inspectedArm: 'native_plus_vervain',
  selectedNodeId: 'context_gate',
  chainVerification: null,
  scopedLabOpen: false,
  scopedProof: null,
  runPulseCounter: 0,
};

export function resolveInspectedArmExecution(state: WorkspaceUiState): ArmExecutionView | null {
  const demo = state.demoState;
  if (!demo) return null;
  if (state.stageFocus === 'single' && demo.latestSingleRun) {
    return demo.latestSingleRun;
  }
  if (demo.latestPairedRun) {
    return state.inspectedArm === 'native_only'
      ? demo.latestPairedRun.nativeOnly
      : demo.latestPairedRun.nativePlusVervain;
  }
  return demo.latestSingleRun;
}
