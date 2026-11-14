import { loadSafeFixture } from "./fixtures.js";
import { parseEvidenceBundle } from "./parser.js";
import {
  CANONICAL_TIMELINE_STEPS,
  type LaneId,
  type TimelineStepIndex,
  type ValidatedEvidenceBundle,
  type ValidationIssue
} from "./types.js";

export type ReplaySurfaceKind =
  | "empty"
  | "loading"
  | "invalid"
  | "verifier_failed"
  | "incomplete"
  | "unsupported"
  | "stale"
  | "ready";

export type PlaybackStatus = "static" | "playing" | "paused";

export interface ReplayMachineState {
  readonly surfaceKind: ReplaySurfaceKind;
  readonly evidenceRef: ValidatedEvidenceBundle | null;
  readonly validationIssues: readonly ValidationIssue[];
  readonly activeLane: LaneId;
  readonly activeStepIndex: TimelineStepIndex;
  readonly maxRecordedStepIndex: TimelineStepIndex;
  readonly playback: PlaybackStatus;
  readonly receiptOpen: boolean;
  readonly reducedMotion: boolean;
}

export type ReplayMachineAction =
  | { readonly type: "SET_EMPTY" }
  | { readonly type: "SET_LOADING" }
  | {
      readonly type: "LOAD_EVIDENCE";
      readonly input: unknown;
      readonly fromFixture?: boolean;
      readonly initialLane?: LaneId;
      readonly initialStepIndex?: TimelineStepIndex;
    }
  | { readonly type: "START_DEMO" }
  | { readonly type: "PAUSE" }
  | { readonly type: "TICK" }
  | { readonly type: "STEP_NEXT" }
  | { readonly type: "STEP_PREV" }
  | { readonly type: "RESTART" }
  | { readonly type: "SELECT_STEP"; readonly stepIndex: TimelineStepIndex }
  | { readonly type: "SET_LANE"; readonly lane: LaneId }
  | { readonly type: "OPEN_RECEIPT" }
  | { readonly type: "CLOSE_RECEIPT" }
  | { readonly type: "TOGGLE_RECEIPT" }
  | { readonly type: "SET_REDUCED_MOTION"; readonly reducedMotion: boolean };

function clampStepIndex(n: number): TimelineStepIndex {
  if (n <= 1) return 1;
  if (n >= 9) return 9;
  return n as TimelineStepIndex;
}

export function computeMaxRecordedStepIndex(
  validated: ValidatedEvidenceBundle,
  lane: LaneId
): TimelineStepIndex {
  const steps = validated.bundle.lanes[lane].steps;
  let lastRecorded = 1;
  for (const step of steps) {
    if (step.recorded) {
      lastRecorded = step.step_index;
    }
  }
  return clampStepIndex(lastRecorded);
}

export function classifySurfaceKind(validated: ValidatedEvidenceBundle): ReplaySurfaceKind {
  if (validated.verifierFailed) {
    return "verifier_failed";
  }
  if (validated.bundle.source_status === "unsupported") {
    return "unsupported";
  }
  if (validated.bundle.source_status === "incomplete") {
    return "incomplete";
  }
  if (validated.bundle.freshness === "stale") {
    return "stale";
  }
  return "ready";
}

export function defaultPosterStepForEvidence(
  validated: ValidatedEvidenceBundle,
  lane: LaneId
): TimelineStepIndex {
  const maxStep = computeMaxRecordedStepIndex(validated, lane);
  // Default static poster state shows step 7 (critical boundary dispatch/clip moment)
  // when recorded, so the attention aperture comparison is immediately visible on first paint.
  if (maxStep >= 7) {
    return 7;
  }
  return maxStep;
}

export interface CreateReplayStateOptions {
  readonly status?: "empty" | "loading" | "loaded";
  readonly evidence?: unknown;
  readonly fromFixture?: boolean;
  readonly initialLane?: LaneId;
  readonly initialStepIndex?: TimelineStepIndex;
  readonly receiptOpen?: boolean;
  readonly reducedMotion?: boolean;
}

export function createReplayState(options: CreateReplayStateOptions = {}): ReplayMachineState {
  const activeLane: LaneId = options.initialLane ?? "native_plus_vervain";
  const receiptOpen = Boolean(options.receiptOpen);
  const reducedMotion = Boolean(options.reducedMotion);

  if (options.status === "loading") {
    return {
      surfaceKind: "loading",
      evidenceRef: null,
      validationIssues: [],
      activeLane,
      activeStepIndex: 1,
      maxRecordedStepIndex: 1,
      playback: "static",
      receiptOpen,
      reducedMotion
    };
  }

  if (options.status === "empty" || options.evidence === undefined || options.evidence === null) {
    return {
      surfaceKind: "empty",
      evidenceRef: null,
      validationIssues: [],
      activeLane,
      activeStepIndex: 1,
      maxRecordedStepIndex: 1,
      playback: "static",
      receiptOpen,
      reducedMotion
    };
  }

  const parsed = options.fromFixture
    ? loadSafeFixture(options.evidence)
    : parseEvidenceBundle(options.evidence);

  if (!parsed.ok) {
    return {
      surfaceKind: "invalid",
      evidenceRef: null,
      validationIssues: parsed.issues,
      activeLane,
      activeStepIndex: 1,
      maxRecordedStepIndex: 1,
      playback: "static",
      receiptOpen,
      reducedMotion
    };
  }

  const validated = parsed.value;
  const maxRecorded = computeMaxRecordedStepIndex(validated, activeLane);
  const initialStep = options.initialStepIndex
    ? clampStepIndex(options.initialStepIndex)
    : defaultPosterStepForEvidence(validated, activeLane);

  return {
    surfaceKind: classifySurfaceKind(validated),
    evidenceRef: validated,
    validationIssues: [],
    activeLane,
    activeStepIndex: initialStep,
    maxRecordedStepIndex: maxRecorded,
    playback: "static",
    receiptOpen,
    reducedMotion
  };
}

export function replayReducer(
  state: ReplayMachineState,
  action: ReplayMachineAction
): ReplayMachineState {
  switch (action.type) {
    case "SET_EMPTY":
      return createReplayState({
        status: "empty",
        initialLane: state.activeLane,
        reducedMotion: state.reducedMotion
      });

    case "SET_LOADING":
      return createReplayState({
        status: "loading",
        initialLane: state.activeLane,
        reducedMotion: state.reducedMotion
      });

    case "LOAD_EVIDENCE":
      return createReplayState({
        status: "loaded",
        evidence: action.input,
        fromFixture: action.fromFixture,
        initialLane: action.initialLane ?? state.activeLane,
        initialStepIndex: action.initialStepIndex,
        receiptOpen: state.receiptOpen,
        reducedMotion: state.reducedMotion
      });

    case "START_DEMO": {
      if (!state.evidenceRef) {
        return state;
      }
      const maxStep = state.maxRecordedStepIndex;
      const shouldResetToStart =
        state.playback === "static" || state.activeStepIndex >= maxStep;
      const startStep: TimelineStepIndex = shouldResetToStart ? 1 : state.activeStepIndex;
      return {
        ...state,
        activeStepIndex: startStep,
        playback: maxStep > 1 ? "playing" : "static"
      };
    }

    case "PAUSE": {
      if (state.playback !== "playing") {
        return state;
      }
      return {
        ...state,
        playback: "paused"
      };
    }

    case "TICK": {
      if (state.playback !== "playing" || !state.evidenceRef) {
        return state;
      }
      if (state.activeStepIndex >= state.maxRecordedStepIndex) {
        return {
          ...state,
          playback: "static"
        };
      }
      const nextStep = clampStepIndex(state.activeStepIndex + 1);
      const reachedEnd = nextStep >= state.maxRecordedStepIndex;
      return {
        ...state,
        activeStepIndex: nextStep,
        playback: reachedEnd ? "static" : "playing"
      };
    }

    case "STEP_NEXT": {
      if (!state.evidenceRef) {
        return state;
      }
      const nextStep =
        state.activeStepIndex < state.maxRecordedStepIndex
          ? clampStepIndex(state.activeStepIndex + 1)
          : state.maxRecordedStepIndex;
      return {
        ...state,
        activeStepIndex: nextStep,
        playback: "paused"
      };
    }

    case "STEP_PREV": {
      if (!state.evidenceRef) {
        return state;
      }
      const prevStep =
        state.activeStepIndex > 1 ? clampStepIndex(state.activeStepIndex - 1) : 1;
      return {
        ...state,
        activeStepIndex: prevStep,
        playback: "paused"
      };
    }

    case "RESTART": {
      if (!state.evidenceRef) {
        return state;
      }
      return {
        ...state,
        activeStepIndex: 1,
        playback: "paused"
      };
    }

    case "SELECT_STEP": {
      if (!state.evidenceRef) {
        return state;
      }
      const validStep = CANONICAL_TIMELINE_STEPS.some((s) => s.index === action.stepIndex);
      if (!validStep) {
        return state;
      }
      return {
        ...state,
        activeStepIndex: action.stepIndex,
        playback: state.playback === "playing" ? "paused" : state.playback
      };
    }

    case "SET_LANE": {
      // Critical invariant: switching modes NEVER alters the underlying evidenceRef.
      if (action.lane === state.activeLane) {
        return state;
      }
      const nextMax = state.evidenceRef
        ? computeMaxRecordedStepIndex(state.evidenceRef, action.lane)
        : 1;
      return {
        ...state,
        activeLane: action.lane,
        maxRecordedStepIndex: nextMax,
        playback: state.playback === "playing" ? "paused" : state.playback
      };
    }

    case "OPEN_RECEIPT":
      return { ...state, receiptOpen: true };

    case "CLOSE_RECEIPT":
      return { ...state, receiptOpen: false };

    case "TOGGLE_RECEIPT":
      return { ...state, receiptOpen: !state.receiptOpen };

    case "SET_REDUCED_MOTION":
      return { ...state, reducedMotion: action.reducedMotion };
  }
}
