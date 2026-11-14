/**
 * Responsibility: Deterministic canonical JSON serialization, append-only in-memory event
 * ledger, and cryptographic SHA-256 receipt/event chain verification.
 * Trust boundary: Tamper-evident relative to the live server process. Explicitly does not
 * detect full-instance rollback or restart loss without an external checkpoint.
 */

import { LEDGER_EVENT_SCHEMA_VERSION } from '../shared/config.js';
import type { ContextReceipt, LedgerVerificationResult } from '../shared/contracts.js';
import { sha256Hex } from './redaction.js';

export const GENESIS_CHAIN_SHA256 = '0'.repeat(64);

/**
 * Produces a deterministic canonical JSON string with lexicographically sorted object keys.
 * Rejects non-finite numbers and `undefined` values at the root.
 */
export function canonicalJsonString(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot canonicalize non-finite number.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonString(item ?? null)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonString(rec[k])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`Unsupported type in canonicalJsonString: ${typeof value}`);
}

export type LedgerEventStage =
  | 'retrieval'
  | 'admission'
  | 'provider_dispatch'
  | 'provider_completion'
  | 'release_decision'
  | 'observed_outcome';

export interface LedgerEventRecord {
  readonly schema_version: string;
  readonly event_index: number;
  readonly event_id: string;
  readonly request_id: string;
  readonly session_digest_sha256: string;
  readonly stage: LedgerEventStage;
  readonly timestamp_iso: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly prev_event_sha256: string;
  readonly event_sha256: string;
}

export function computeEventSha256(eventWithoutHash: Omit<LedgerEventRecord, 'event_sha256'>): string {
  return sha256Hex(canonicalJsonString(eventWithoutHash));
}

export function computeReceiptChainSha256(params: {
  previousReceiptChainSha256: string;
  receiptBodyWithoutChainHash: Omit<ContextReceipt, 'chain'> & {
    chain: Omit<ContextReceipt['chain'], 'current_receipt_chain_sha256'>;
  };
  eventHashesInRun: readonly string[];
}): string {
  return sha256Hex(
    canonicalJsonString({
      prev_receipt_chain_sha256: params.previousReceiptChainSha256,
      event_hashes: params.eventHashesInRun,
      receipt: params.receiptBodyWithoutChainHash,
    }),
  );
}

function cloneAndDeepFreezePayload(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const freezeRec = (val: unknown): unknown => {
    if (val === null || typeof val !== 'object') {
      return val;
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        freezeRec(item);
      }
      return Object.freeze(val);
    }
    for (const key of Object.keys(val as Record<string, unknown>)) {
      freezeRec((val as Record<string, unknown>)[key]);
    }
    return Object.freeze(val);
  };
  const cloned = JSON.parse(canonicalJsonString(payload)) as Record<string, unknown>;
  return freezeRec(cloned) as Readonly<Record<string, unknown>>;
}

const ROLLBACK_LIMITATION_NOTE =
  'In-memory SHA-256 chain detects mutation or reordering within this live server instance; without an external checkpoint it does not detect full-store rollback or instance restart.';

export class AuditLedger {
  private readonly events: LedgerEventRecord[] = [];
  private readonly receipts = new Map<string, ContextReceipt>();
  private readonly receiptOrder: Array<{
    receiptId: string;
    eventHashesInRun: readonly string[];
  }> = [];
  private headReceiptChainSha256: string = GENESIS_CHAIN_SHA256;
  private simulateWriteFailure = false;

  public setSimulatedWriteFailureForTest(enabled: boolean): void {
    this.simulateWriteFailure = enabled;
  }

  public appendEvent(params: {
    eventId: string;
    requestId: string;
    sessionDigestSha256: string;
    stage: LedgerEventStage;
    timestampIso: string;
    payload: Readonly<Record<string, unknown>>;
  }): LedgerEventRecord {
    if (this.simulateWriteFailure) {
      throw new Error('Simulated ledger append failure.');
    }
    if (this.events.some((e) => e.event_id === params.eventId)) {
      throw new Error('Duplicate ledger event_id rejected.');
    }
    const eventIndex = this.events.length;
    const prevHash =
      eventIndex === 0 ? GENESIS_CHAIN_SHA256 : this.events[eventIndex - 1]!.event_sha256;

    const frozenPayload = cloneAndDeepFreezePayload(params.payload);
    const base: Omit<LedgerEventRecord, 'event_sha256'> = {
      schema_version: LEDGER_EVENT_SCHEMA_VERSION,
      event_index: eventIndex,
      event_id: params.eventId,
      request_id: params.requestId,
      session_digest_sha256: params.sessionDigestSha256,
      stage: params.stage,
      timestamp_iso: params.timestampIso,
      payload: frozenPayload,
      prev_event_sha256: prevHash,
    };

    const eventSha256 = computeEventSha256(base);
    const fullRecord: LedgerEventRecord = Object.freeze({
      ...base,
      event_sha256: eventSha256,
    });
    this.events.push(fullRecord);
    return fullRecord;
  }

  public getPreviousReceiptChainSha256(): string {
    return this.headReceiptChainSha256;
  }

  public recordReceipt(
    receipt: ContextReceipt,
    eventHashesInRun: readonly string[],
  ): ContextReceipt {
    if (this.simulateWriteFailure) {
      throw new Error('Simulated ledger receipt write failure.');
    }
    if (this.receipts.has(receipt.receipt_id)) {
      throw new Error('Duplicate receipt_id rejected.');
    }
    if (receipt.chain.previous_receipt_chain_sha256 !== this.headReceiptChainSha256) {
      throw new Error('Receipt chain predecessor mismatch during append.');
    }
    this.receipts.set(receipt.receipt_id, receipt);
    this.receiptOrder.push({
      receiptId: receipt.receipt_id,
      eventHashesInRun: [...eventHashesInRun],
    });
    this.headReceiptChainSha256 = receipt.chain.current_receipt_chain_sha256;
    return receipt;
  }

  public getReceiptById(receiptId: string): ContextReceipt | undefined {
    return this.receipts.get(receiptId);
  }

  public getEventsForRequest(requestId: string): readonly LedgerEventRecord[] {
    return this.events.filter((e) => e.request_id === requestId);
  }

  /**
   * Verifies every event hash, sequential link, and receipt chain digest from genesis.
   */
  public verifyChain(): LedgerVerificationResult {
    let expectedPrevEventHash = GENESIS_CHAIN_SHA256;

    for (let i = 0; i < this.events.length; i += 1) {
      const ev = this.events[i]!;
      if (ev.event_index !== i) {
        return {
          verified: false,
          checkedEvents: i,
          checkedReceipts: 0,
          headChainSha256: this.headReceiptChainSha256,
          failureIndex: i,
          failureReason: `event_index_mismatch_expected_${i}_got_${ev.event_index}`,
          limitationNote: ROLLBACK_LIMITATION_NOTE,
        };
      }
      if (ev.prev_event_sha256 !== expectedPrevEventHash) {
        return {
          verified: false,
          checkedEvents: i,
          checkedReceipts: 0,
          headChainSha256: this.headReceiptChainSha256,
          failureIndex: i,
          failureReason: 'prev_event_sha256_link_broken',
          limitationNote: ROLLBACK_LIMITATION_NOTE,
        };
      }
      const { event_sha256, ...withoutHash } = ev;
      const recomputed = computeEventSha256(withoutHash);
      if (recomputed !== event_sha256) {
        return {
          verified: false,
          checkedEvents: i,
          checkedReceipts: 0,
          headChainSha256: this.headReceiptChainSha256,
          failureIndex: i,
          failureReason: 'event_canonical_sha256_mismatch',
          limitationNote: ROLLBACK_LIMITATION_NOTE,
        };
      }
      expectedPrevEventHash = event_sha256;
    }

    const liveEventHashByIndex = new Map<number, string>();
    for (const ev of this.events) {
      liveEventHashByIndex.set(ev.event_index, ev.event_sha256);
    }

    let expectedPrevReceiptHash = GENESIS_CHAIN_SHA256;
    for (let rIdx = 0; rIdx < this.receiptOrder.length; rIdx += 1) {
      const entry = this.receiptOrder[rIdx]!;
      const receipt = this.receipts.get(entry.receiptId);
      if (!receipt) {
        return {
          verified: false,
          checkedEvents: this.events.length,
          checkedReceipts: rIdx,
          headChainSha256: this.headReceiptChainSha256,
          failureIndex: rIdx,
          failureReason: 'missing_receipt_in_chain',
          limitationNote: ROLLBACK_LIMITATION_NOTE,
        };
      }
      if (receipt.chain.previous_receipt_chain_sha256 !== expectedPrevReceiptHash) {
        return {
          verified: false,
          checkedEvents: this.events.length,
          checkedReceipts: rIdx,
          headChainSha256: this.headReceiptChainSha256,
          failureIndex: rIdx,
          failureReason: 'previous_receipt_chain_sha256_mismatch',
          limitationNote: ROLLBACK_LIMITATION_NOTE,
        };
      }

      // Confirm events referenced by this receipt still match live event hashes
      const liveSliceHashes: string[] = [];
      for (
        let idx = receipt.chain.first_event_index;
        idx <= receipt.chain.last_event_index;
        idx += 1
      ) {
        const h = liveEventHashByIndex.get(idx);
        if (!h) {
          return {
            verified: false,
            checkedEvents: this.events.length,
            checkedReceipts: rIdx,
            headChainSha256: this.headReceiptChainSha256,
            failureIndex: idx,
            failureReason: 'receipt_event_range_missing_from_ledger',
            limitationNote: ROLLBACK_LIMITATION_NOTE,
          };
        }
        liveSliceHashes.push(h);
      }

      const { current_receipt_chain_sha256, ...chainWithoutCurrent } = receipt.chain;
      const recomputedReceiptHash = computeReceiptChainSha256({
        previousReceiptChainSha256: receipt.chain.previous_receipt_chain_sha256,
        receiptBodyWithoutChainHash: {
          ...receipt,
          chain: chainWithoutCurrent,
        },
        eventHashesInRun: liveSliceHashes,
      });

      if (recomputedReceiptHash !== current_receipt_chain_sha256) {
        return {
          verified: false,
          checkedEvents: this.events.length,
          checkedReceipts: rIdx,
          headChainSha256: this.headReceiptChainSha256,
          failureIndex: rIdx,
          failureReason: 'current_receipt_chain_sha256_mismatch',
          limitationNote: ROLLBACK_LIMITATION_NOTE,
        };
      }

      expectedPrevReceiptHash = current_receipt_chain_sha256;
    }

    return {
      verified: true,
      checkedEvents: this.events.length,
      checkedReceipts: this.receiptOrder.length,
      headChainSha256: this.headReceiptChainSha256,
      failureIndex: null,
      failureReason: null,
      limitationNote: ROLLBACK_LIMITATION_NOTE,
    };
  }

  /**
   * Test-only helper used by unit/adversarial suites to mutate or reorder stored events
   * and confirm `verifyChain()` detects tampering.
   */
  public tamperEventAtIndexForTest(
    index: number,
    mutator: (original: LedgerEventRecord) => LedgerEventRecord,
  ): void {
    const existing = this.events[index];
    if (!existing) {
      throw new Error(`No ledger event at index ${index}`);
    }
    this.events[index] = mutator(existing);
  }

  public swapEventsForTest(indexA: number, indexB: number): void {
    const a = this.events[indexA];
    const b = this.events[indexB];
    if (!a || !b) {
      throw new Error('Invalid event swap indices');
    }
    this.events[indexA] = b;
    this.events[indexB] = a;
  }
}
