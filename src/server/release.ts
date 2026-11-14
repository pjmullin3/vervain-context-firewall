/**
 * Responsibility: Nonstreaming response release gate enforcing live session authority
 * continuity (`sessionId`, `tenantId`, `principalId`, `expiresAtMs`, `policyEpoch`),
 * single-release idempotency, model-citation binding, and bounded exact synthetic
 * planted-value detection.
 * Trust boundary: Final server boundary before model output reaches the browser.
 */

import {
  RELEASE_REASONS,
  type ReleaseDecision,
  type ReleaseReasonCode,
} from '../shared/reason-codes.js';
import { SYNTHETIC_PLANTED_VALUE } from './fixture.js';
import { sha256Hex } from './redaction.js';
import type { ServerAuthoritySnapshot, SessionStore } from './session.js';

export interface ReleaseCandidateOutput {
  readonly rawText: string;
  readonly parsedAnswer: string;
  readonly parsedSourcesUsed: readonly string[];
}

export interface ReleaseGateEvaluation {
  readonly decision: ReleaseDecision;
  readonly reasonCode: ReleaseReasonCode;
  readonly policyEpochAtRelease: number;
  readonly plantedValueExactMatch: boolean;
  readonly releasedAnswer: string | null;
  readonly releasedSourcesUsed: readonly string[];
  readonly responseSha256: string | null;
  readonly responseUtf8Bytes: number;
}

export class ResponseReleaseGate {
  private readonly completedRequestIds = new Set<string>();
  private readonly plantedValues: readonly string[];

  constructor(plantedValues: readonly string[] = [SYNTHETIC_PLANTED_VALUE]) {
    this.plantedValues = plantedValues.filter((v) => v.length > 0);
  }

  public containsPlantedValue(text: string): boolean {
    return this.plantedValues.some((needle) => text.includes(needle));
  }

  /**
   * Evaluates whether a candidate Gemini response may be released to the caller.
   * Reloads the session from `sessionStore`, checks single-release idempotency,
   * verifies tenant/principal/expiry/epoch continuity, runs the exact planted-value scan,
   * and requires every model-claimed source to exist in the server-built envelope.
   */
  public evaluateRelease(params: {
    requestId: string;
    authorityAtAdmission: ServerAuthoritySnapshot;
    sessionStore: SessionStore;
    allowedSourceIds: readonly string[];
    candidate: ReleaseCandidateOutput;
  }): ReleaseGateEvaluation {
    const { requestId, authorityAtAdmission, sessionStore, allowedSourceIds, candidate } = params;

    const combinedCandidateText = `${candidate.rawText}\n${candidate.parsedAnswer}\n${candidate.parsedSourcesUsed.join(',')}`;
    const plantedMatch = this.containsPlantedValue(combinedCandidateText);
    const candidateBytes = Buffer.byteLength(candidate.parsedAnswer, 'utf8');

    if (this.completedRequestIds.has(requestId)) {
      return Object.freeze({
        decision: 'withheld',
        reasonCode: RELEASE_REASONS.DUPLICATE_RELEASE_BLOCKED,
        policyEpochAtRelease: authorityAtAdmission.policyEpoch,
        plantedValueExactMatch: plantedMatch,
        releasedAnswer: null,
        releasedSourcesUsed: [],
        responseSha256: null,
        responseUtf8Bytes: 0,
      });
    }
    this.completedRequestIds.add(requestId);

    const liveLookup = sessionStore.getSnapshotBySessionId(authorityAtAdmission.sessionId);
    if (!liveLookup.ok) {
      return Object.freeze({
        decision: 'withheld',
        reasonCode:
          liveLookup.reason === 'expired'
            ? RELEASE_REASONS.SESSION_EXPIRED
            : RELEASE_REASONS.SESSION_MISSING,
        policyEpochAtRelease: authorityAtAdmission.policyEpoch,
        plantedValueExactMatch: plantedMatch,
        releasedAnswer: null,
        releasedSourcesUsed: [],
        responseSha256: null,
        responseUtf8Bytes: 0,
      });
    }

    const live = liveLookup.snapshot;

    if (
      live.sessionId !== authorityAtAdmission.sessionId ||
      live.tenantId !== authorityAtAdmission.tenantId ||
      live.principalId !== authorityAtAdmission.principalId ||
      live.stateGeneration !== authorityAtAdmission.stateGeneration
    ) {
      return Object.freeze({
        decision: 'withheld',
        reasonCode: RELEASE_REASONS.AUTHORITY_MISMATCH,
        policyEpochAtRelease: live.policyEpoch,
        plantedValueExactMatch: plantedMatch,
        releasedAnswer: null,
        releasedSourcesUsed: [],
        responseSha256: null,
        responseUtf8Bytes: 0,
      });
    }

    if (live.policyEpoch !== authorityAtAdmission.policyEpoch) {
      return Object.freeze({
        decision: 'withheld',
        reasonCode: RELEASE_REASONS.POLICY_EPOCH_CHANGED,
        policyEpochAtRelease: live.policyEpoch,
        plantedValueExactMatch: plantedMatch,
        releasedAnswer: null,
        releasedSourcesUsed: [],
        responseSha256: null,
        responseUtf8Bytes: 0,
      });
    }

    if (plantedMatch) {
      return Object.freeze({
        decision: 'withheld',
        reasonCode: RELEASE_REASONS.PLANTED_VALUE_DETECTED,
        policyEpochAtRelease: live.policyEpoch,
        plantedValueExactMatch: true,
        releasedAnswer: null,
        releasedSourcesUsed: [],
        responseSha256: null,
        responseUtf8Bytes: 0,
      });
    }

    const allowedSources = new Set(allowedSourceIds);
    const hasUnboundSourceCitation = candidate.parsedSourcesUsed.some(
      (sourceId) => !allowedSources.has(sourceId),
    );

    if (hasUnboundSourceCitation) {
      return Object.freeze({
        decision: 'withheld',
        reasonCode: RELEASE_REASONS.UNBOUND_SOURCE_CITATION,
        policyEpochAtRelease: live.policyEpoch,
        plantedValueExactMatch: false,
        releasedAnswer: null,
        releasedSourcesUsed: [],
        responseSha256: null,
        responseUtf8Bytes: 0,
      });
    }

    const responseSha256 = sha256Hex(candidate.parsedAnswer);

    return Object.freeze({
      decision: 'released',
      reasonCode: RELEASE_REASONS.AUTHORITY_VERIFIED,
      policyEpochAtRelease: live.policyEpoch,
      plantedValueExactMatch: false,
      releasedAnswer: candidate.parsedAnswer,
      releasedSourcesUsed: Object.freeze([...candidate.parsedSourcesUsed]),
      responseSha256,
      responseUtf8Bytes: candidateBytes,
    });
  }
}
