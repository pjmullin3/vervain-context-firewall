/**
 * Responsibility: Interactive 6-stage causal trace scrubber allowing step-by-step inspection
 * and timed replay across Authority, Retrieval, Context Gate, Provider Envelope, Release Gate,
 * and Receipt Chain boundaries while honoring prefers-reduced-motion.
 * Trust boundary: Pure client playback state controller; mutates zero server or receipt data.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProvenanceEdgeView, ProvenanceNodeId } from '../../shared/contracts.js';

export type CausalStageNumber = 1 | 2 | 3 | 4 | 5 | 6;
export type ReplayStageSelection = 'all' | CausalStageNumber;

export interface CausalStageDescriptor {
  readonly stage: CausalStageNumber;
  readonly label: string;
  readonly primaryNodeId: ProvenanceNodeId;
}

export const CAUSAL_STAGES: readonly CausalStageDescriptor[] = [
  { stage: 1, label: '1. Authority', primaryNodeId: 'authority' },
  { stage: 2, label: '2. Retrieval', primaryNodeId: 'retriever' },
  { stage: 3, label: '3. Context Gate', primaryNodeId: 'context_gate' },
  { stage: 4, label: '4. Provider Envelope', primaryNodeId: 'gemini' },
  { stage: 5, label: '5. Release Gate', primaryNodeId: 'release_gate' },
  { stage: 6, label: '6. Receipt Chain', primaryNodeId: 'receipt' },
] as const;

export function getNodeCausalStage(nodeId: ProvenanceNodeId): CausalStageNumber {
  switch (nodeId) {
    case 'authority':
      return 1;
    case 'retriever':
    case 'source_alder':
    case 'source_beacon':
      return 2;
    case 'context_gate':
      return 3;
    case 'gemini':
      return 4;
    case 'release_gate':
    case 'reply':
      return 5;
    case 'receipt':
      return 6;
  }
}

export function getEdgeCausalStage(edge: ProvenanceEdgeView): CausalStageNumber {
  if (edge.to === 'receipt') {
    return 6;
  }
  if (edge.from === 'release_gate' || edge.to === 'release_gate') {
    if (edge.from === 'context_gate' && edge.to === 'release_gate') {
      return 4;
    }
    return 5;
  }
  if (edge.to === 'gemini') {
    return 4;
  }
  if (edge.to === 'context_gate') {
    return 3;
  }
  return 2;
}

export function resolveCausalElementOpacity(
  itemStage: CausalStageNumber,
  activeStage: ReplayStageSelection,
): number {
  if (activeStage === 'all') {
    return 1;
  }
  if (itemStage === activeStage) {
    return 1;
  }
  if (itemStage < activeStage) {
    return 0.78;
  }
  return 0.28;
}

function isReducedMotionPreferred(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface CausalReplayScrubberProps {
  readonly requestId: string;
  readonly activeStage: ReplayStageSelection;
  readonly onSelectStage: (stage: ReplayStageSelection, primaryNodeId?: ProvenanceNodeId) => void;
}

const STEP_DURATION_MS = 400;

export function CausalReplayScrubber({
  requestId,
  activeStage,
  onSelectStage,
}: CausalReplayScrubberProps) {
  const [playingRequestId, setPlayingRequestId] = useState<string | null>(null);
  const timersRef = useRef<number[]>([]);
  const isPlaying = playingRequestId === requestId;

  const clearTimers = useCallback(() => {
    for (const timerId of timersRef.current) {
      window.clearTimeout(timerId);
    }
    timersRef.current = [];
  }, []);

  useEffect(() => {
    clearTimers();
    return () => {
      clearTimers();
    };
  }, [requestId, clearTimers]);

  const handleManualStage = (stage: ReplayStageSelection, nodeId?: ProvenanceNodeId): void => {
    clearTimers();
    setPlayingRequestId(null);
    onSelectStage(stage, nodeId);
  };

  const handlePrev = (): void => {
    clearTimers();
    setPlayingRequestId(null);
    if (activeStage === 'all') {
      const last = CAUSAL_STAGES[5];
      if (last) {
        onSelectStage(last.stage, last.primaryNodeId);
      }
      return;
    }
    if (activeStage === 1) {
      onSelectStage('all', 'context_gate');
      return;
    }
    const prevStage = (activeStage - 1) as CausalStageNumber;
    const descriptor = CAUSAL_STAGES.find((s) => s.stage === prevStage);
    onSelectStage(prevStage, descriptor?.primaryNodeId);
  };

  const handleNext = (): void => {
    clearTimers();
    setPlayingRequestId(null);
    if (activeStage === 'all') {
      const first = CAUSAL_STAGES[0];
      if (first) {
        onSelectStage(first.stage, first.primaryNodeId);
      }
      return;
    }
    if (activeStage === 6) {
      onSelectStage('all', 'context_gate');
      return;
    }
    const nextStage = (activeStage + 1) as CausalStageNumber;
    const descriptor = CAUSAL_STAGES.find((s) => s.stage === nextStage);
    onSelectStage(nextStage, descriptor?.primaryNodeId);
  };

  const handleReplay = (): void => {
    clearTimers();

    if (isPlaying) {
      setPlayingRequestId(null);
      onSelectStage('all', 'context_gate');
      return;
    }

    if (isReducedMotionPreferred()) {
      setPlayingRequestId(null);
      onSelectStage('all', 'context_gate');
      return;
    }

    const first = CAUSAL_STAGES[0];
    if (!first) return;

    setPlayingRequestId(requestId);
    onSelectStage(first.stage, first.primaryNodeId);

    for (let idx = 1; idx < CAUSAL_STAGES.length; idx += 1) {
      const target = CAUSAL_STAGES[idx];
      if (!target) continue;
      const timerId = window.setTimeout(() => {
        onSelectStage(target.stage, target.primaryNodeId);
      }, idx * STEP_DURATION_MS);
      timersRef.current.push(timerId);
    }

    const finishTimerId = window.setTimeout(() => {
      timersRef.current = [];
      setPlayingRequestId(null);
      onSelectStage('all', 'context_gate');
    }, CAUSAL_STAGES.length * STEP_DURATION_MS);
    timersRef.current.push(finishTimerId);
  };

  return (
    <div
      data-testid="causal-replay-scrubber"
      role="region"
      aria-label="Causal step replay scrubber"
      style={{
        marginTop: 8,
        padding: '7px 10px',
        background: 'var(--bg-inset)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '6px 10px',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
        <button
          type="button"
          className={`tab-btn ${isPlaying ? 'tab-btn--active' : ''}`}
          data-testid="replay-play"
          aria-pressed={isPlaying}
          onClick={handleReplay}
          style={{ fontWeight: 600 }}
        >
          {isPlaying ? 'Replay trace (active)' : 'Replay trace'}
        </button>
        <button
          type="button"
          className="tab-btn"
          data-testid="replay-prev"
          onClick={handlePrev}
        >
          Step Prev
        </button>
        <button
          type="button"
          className="tab-btn"
          data-testid="replay-next"
          onClick={handleNext}
        >
          Step Next
        </button>
      </div>

      <div
        role="group"
        aria-label="Causal boundary stages"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}
      >
        <button
          type="button"
          className={`tab-btn ${activeStage === 'all' ? 'tab-btn--active' : ''}`}
          data-testid="replay-stage-all"
          aria-pressed={activeStage === 'all'}
          onClick={() => handleManualStage('all', 'context_gate')}
          style={{ padding: '4px 8px', fontSize: 11 }}
        >
          All 6 stages
        </button>

        {CAUSAL_STAGES.map((item) => {
          const isCurrent = activeStage === item.stage;
          const isCompleted = activeStage !== 'all' && item.stage < activeStage;
          return (
            <button
              key={item.stage}
              type="button"
              className={`tab-btn ${isCurrent ? 'tab-btn--active' : ''}`}
              data-testid={`replay-stage-${item.stage}`}
              aria-pressed={isCurrent}
              onClick={() => handleManualStage(item.stage, item.primaryNodeId)}
              style={{
                padding: '4px 8px',
                fontSize: 11,
                borderColor: isCompleted ? 'rgba(155, 138, 245, 0.24)' : undefined,
                color: isCompleted ? 'var(--text-primary)' : undefined,
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
