/**
 * Adversarial evidence-verifier tests. A cryptographically valid event chain is
 * incomplete if any event is not covered by exactly one chained receipt.
 */

import { describe, expect, it } from 'vitest';

import { AuditLedger } from '../../src/server/ledger.js';

describe('Daybreak: receipt coverage completeness', () => {
  it('does not report a ledger with an orphan event as verified', () => {
    const ledger = new AuditLedger();
    ledger.appendEvent({
      eventId: 'evt_orphan_retrieval',
      requestId: 'req_orphan',
      sessionDigestSha256: 'a'.repeat(64),
      stage: 'retrieval',
      timestampIso: '2026-11-14T12:00:00.000Z',
      payload: { retrieved_count: 1 },
    });

    const verification = ledger.verifyChain();
    expect(verification.verified).toBe(false);
    expect(verification.failureReason).toBe('unreceipted_ledger_events');
    expect(verification.failureIndex).toBe(0);
  });
});
