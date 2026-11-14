/**
 * Responsibility: Tenant-scoped ordinary retrieval and the isolated synthetic broken-control
 * retriever (`cross_tenant_filter_omission`).
 * Trust boundary: Ordinary retrieval applies tenant, policy-epoch, and destination-classification
 * predicates directly in the store query. The broken control omits predicates only for the named
 * synthetic defect scenario and is never a default or flag-enabled production path.
 */

import {
  ALLOWED_CLASSIFICATIONS_BY_DESTINATION,
  type DeclaredDestination,
} from '../shared/config.js';
import {
  FROZEN_RECORDS,
  type ServerStoredRecord,
} from './fixture.js';
import type { ServerAuthoritySnapshot } from './session.js';

export interface RetrievedChunk {
  readonly chunk_id: string;
  readonly source_id: string;
  readonly source_version_sha256: string;
  readonly tenant_id: string;
  readonly tenant_label: string;
  readonly policy_epoch: number;
  readonly classification: string;
  readonly text: string;
  readonly content_sha256: string;
  readonly retrieval_rank: number;
  readonly retrieval_score: number;
  readonly retrieval_basis:
    | 'store_predicate_tenant_epoch_classification'
    | 'synthetic_defect_missing_tenant_predicate';
}

export interface StoreQueryAudit {
  readonly mode: 'safe_tenant_scoped' | 'cross_tenant_filter_omission';
  readonly appliedTenantPredicate: string | null;
  readonly appliedEpochPredicate: number | null;
  readonly appliedAllowedClassifications: readonly string[] | null;
  readonly scannedRecords: number;
  readonly matchedRecords: number;
}

export interface RetrievalExecutionResult {
  readonly chunks: readonly RetrievedChunk[];
  readonly queryAudit: StoreQueryAudit;
}

function toRetrievedChunk(
  record: ServerStoredRecord,
  rank: number,
  score: number,
  basis: RetrievedChunk['retrieval_basis'],
): RetrievedChunk {
  return Object.freeze({
    chunk_id: record.chunkId,
    source_id: record.sourceId,
    source_version_sha256: record.sourceVersionSha256,
    tenant_id: record.tenantId,
    tenant_label: record.tenantLabel,
    policy_epoch: record.policyEpoch,
    classification: record.classification,
    text: record.text,
    content_sha256: record.contentSha256,
    retrieval_rank: rank,
    retrieval_score: score,
    retrieval_basis: basis,
  });
}

/**
 * Safe store query: applies tenant equality, epoch validity (`record.policyEpoch === authority.policyEpoch`),
 * and destination classification predicates inside the store scan.
 */
export function retrieveTenantScopedChunks(
  authority: Pick<ServerAuthoritySnapshot, 'tenantId' | 'policyEpoch'>,
  destination: DeclaredDestination,
  recordsStore: readonly ServerStoredRecord[] = FROZEN_RECORDS,
): RetrievalExecutionResult {
  const allowedClassifications = ALLOWED_CLASSIFICATIONS_BY_DESTINATION[destination];

  const matched = recordsStore.filter(
    (record) =>
      record.tenantId === authority.tenantId &&
      record.policyEpoch === authority.policyEpoch &&
      allowedClassifications.includes(record.classification),
  );

  const chunks = matched.map((record, idx) =>
    toRetrievedChunk(
      record,
      idx + 1,
      Number((0.94 - idx * 0.07).toFixed(2)),
      'store_predicate_tenant_epoch_classification',
    ),
  );

  return {
    chunks,
    queryAudit: {
      mode: 'safe_tenant_scoped',
      appliedTenantPredicate: authority.tenantId,
      appliedEpochPredicate: authority.policyEpoch,
      appliedAllowedClassifications: allowedClassifications,
      scannedRecords: recordsStore.length,
      matchedRecords: chunks.length,
    },
  };
}

/**
 * Intentionally broken control retriever used exclusively for the frozen
 * `cross_tenant_filter_omission` scenario in the paired proof.
 * Simulates an application retrieval bug where the tenant predicate was omitted.
 */
export function retrieveBrokenControlChunks(
  frozenScenario: 'cross_tenant_filter_omission',
  recordsStore: readonly ServerStoredRecord[] = FROZEN_RECORDS,
): RetrievalExecutionResult {
  if (frozenScenario !== 'cross_tenant_filter_omission') {
    throw new Error('Unsupported synthetic defect scenario identifier.');
  }

  const chunks = recordsStore.map((record, idx) =>
    toRetrievedChunk(
      record,
      idx + 1,
      Number((0.94 - idx * 0.05).toFixed(2)),
      'synthetic_defect_missing_tenant_predicate',
    ),
  );

  return {
    chunks,
    queryAudit: {
      mode: 'cross_tenant_filter_omission',
      appliedTenantPredicate: null,
      appliedEpochPredicate: null,
      appliedAllowedClassifications: null,
      scannedRecords: recordsStore.length,
      matchedRecords: chunks.length,
    },
  };
}
