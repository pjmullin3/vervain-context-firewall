/**
 * Adversarial release-boundary tests for model-authored provenance.
 *
 * A model response is untrusted data. In particular, `sources_used` must not be
 * allowed to assert that an unauthorized or non-admitted source influenced the
 * answer. The release gate must bind every released source identifier to the
 * exact server-built outbound envelope for this request.
 */

import { describe, expect, it } from 'vitest';

import { ResponseReleaseGate } from '../../src/server/release.js';
import { SessionStore } from '../../src/server/session.js';
import { RELEASE_REASONS } from '../../src/shared/reason-codes.js';

describe('Daybreak: model-output provenance binding', () => {
  it('withholds a response that cites a source absent from the admitted envelope', () => {
    const store = new SessionStore({
      secret: 'daybreak_test_secret_at_least_32_characters',
      ttlMs: 60_000,
    });
    const gate = new ResponseReleaseGate();
    const { snapshot } = store.createOrRotateSession('alder');

    const evaluation = gate.evaluateRelease({
      requestId: 'req_daybreak_forged_source',
      authorityAtAdmission: snapshot,
      sessionStore: store,
      allowedSourceIds: ['alder/renewal-playbook-v3'],
      candidate: {
        rawText:
          '{"answer":"A safe-looking answer.","sources_used":["beacon/strategy-note-v2"]}',
        parsedAnswer: 'A safe-looking answer.',
        parsedSourcesUsed: ['beacon/strategy-note-v2'],
      },
    });

    expect(evaluation.decision).toBe('withheld');
    expect(evaluation.reasonCode).toBe(RELEASE_REASONS.UNBOUND_SOURCE_CITATION);
    expect(evaluation.releasedAnswer).toBeNull();
    expect(evaluation.releasedSourcesUsed).toEqual([]);
  });
});
