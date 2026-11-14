/**
 * Responsibility: Sober inspectable Evidence Receipt drawer displaying outcome sentence,
 * denominator-paired counts, epoch bindings, SHA-256 digests, mediated boundaries, exclusions,
 * JSON export download, and live receipt-chain verification.
 * Trust boundary: Renders content-free receipt fields only; zero protected fixture text.
 */

import { useState } from 'react';
import type {
  ArmExecutionView,
  LedgerVerificationResult,
} from '../../shared/contracts.js';
import { CoverageLimits } from './CoverageLimits.js';

export interface EvidenceDrawerProps {
  readonly execution: ArmExecutionView;
  readonly chainVerification: LedgerVerificationResult;
  readonly verifyingChain: boolean;
  readonly onVerifyChain: () => void;
}

export function EvidenceDrawer({
  execution,
  chainVerification,
  verifyingChain,
  onVerifyChain,
}: EvidenceDrawerProps) {
  const [showRawJson, setShowRawJson] = useState(false);
  const receipt = execution.receipt;
  const exportUrl = `/api/receipts/${encodeURIComponent(receipt.receipt_id)}/export`;

  return (
    <section className="panel-card" aria-label="Bounded evidence receipt" data-testid="evidence-drawer">
      <div className="panel-header">
        <div>
          <h3>Bounded Causal Receipt</h3>
          <span className="mono" style={{ color: 'var(--text-muted)' }}>
            {receipt.receipt_id} · {receipt.schema_version}
          </span>
        </div>

        <div className="action-cluster">
          <a
            href={exportUrl}
            download={`vervain-receipt-${receipt.receipt_id}.json`}
            className="btn btn--subtle"
            data-testid="btn-export-receipt"
          >
            Export receipt JSON
          </a>
          <button
            type="button"
            className="btn btn--subtle"
            data-testid="btn-verify-chain"
            disabled={verifyingChain}
            onClick={onVerifyChain}
          >
            {verifyingChain ? 'Verifying...' : 'Verify receipt chain'}
          </button>
          <button
            type="button"
            className="btn btn--subtle"
            data-testid="btn-toggle-receipt-json"
            aria-expanded={showRawJson}
            onClick={() => setShowRawJson((prev) => !prev)}
          >
            {showRawJson ? 'Hide JSON' : 'Inspect JSON'}
          </button>
        </div>
      </div>

      <p className="evidence-outcome" data-testid="evidence-outcome-sentence">
        {execution.outcomeSentence}
      </p>

      <div className="kv-grid">
        <div className="kv-pair">
          <span className="kv-key">Context admission count</span>
          <span className="kv-val" data-testid="evidence-admitted-denominator">
            {receipt.counts.admitted} of {receipt.counts.denominator_total_retrieved} retrieved
            chunks admitted ({receipt.counts.withheld} withheld, {receipt.counts.unknown} unknown)
          </span>
        </div>

        <div className="kv-pair">
          <span className="kv-key">Foreign chunk entered Gemini envelope</span>
          <span className="kv-val mono" data-testid="evidence-foreign-in-envelope">
            {receipt.outbound_envelope.foreign_tenant_chunk_present ? 'yes (control)' : 'no'}
          </span>
        </div>

        <div className="kv-pair">
          <span className="kv-key">Permitted work completed</span>
          <span className="kv-val mono" data-testid="evidence-permitted-completed">
            {receipt.permitted_task.completed ? 'true' : 'false'} ({receipt.permitted_task.basis})
          </span>
        </div>

        <div className="kv-pair">
          <span className="kv-key">Policy epoch (admission → release)</span>
          <span className="kv-val mono">
            {receipt.policy_id}@{receipt.policy_epoch_at_admission} → @
            {receipt.policy_epoch_at_release}
          </span>
        </div>
      </div>

      <div className="digest-list">
        <div className="digest-row">
          <span>Request ID</span>
          <span className="mono">{receipt.request_id}</span>
        </div>
        <div className="digest-row">
          <span>Outbound envelope SHA-256</span>
          <span className="mono">
            {receipt.outbound_envelope.envelope_sha256
              ? `${receipt.outbound_envelope.envelope_sha256.slice(0, 24)}…`
              : 'not_dispatched'}
          </span>
        </div>
        {receipt.sources.map((src) => (
          <div key={src.chunk_id} className="digest-row">
            <span>Source {src.chunk_id}</span>
            <span className="mono">
              {src.disposition}:{src.reason_code} · ver:{src.source_version_sha256.slice(0, 12)}
            </span>
          </div>
        ))}
        <div className="digest-row">
          <span>Prev receipt chain SHA-256</span>
          <span className="mono">{receipt.chain.previous_receipt_chain_sha256.slice(0, 24)}…</span>
        </div>
        <div className="digest-row">
          <span>Current receipt chain SHA-256</span>
          <span className="mono">{receipt.chain.current_receipt_chain_sha256.slice(0, 24)}…</span>
        </div>
        <div className="digest-row" data-testid="chain-verification-status">
          <span>Instance chain verification</span>
          <span className="mono">
            {chainVerification.verified
              ? `verified (${chainVerification.checkedEvents} events, ${chainVerification.checkedReceipts} receipts)`
              : `FAILED at index ${String(chainVerification.failureIndex)}: ${chainVerification.failureReason ?? 'tamper'}`}
          </span>
        </div>
      </div>

      <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
        {chainVerification.limitationNote}
      </div>

      {showRawJson && (
        <pre className="raw-json-pre" data-testid="receipt-raw-json">
          {JSON.stringify(receipt, null, 2)}
        </pre>
      )}

      <CoverageLimits
        mediatedBoundaries={receipt.mediated_boundaries}
        exclusions={receipt.exclusions}
      />
    </section>
  );
}
