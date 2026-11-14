/**
 * Responsibility: Independent deterministic pre-inference context admission gate.
 * Trust boundary: Evaluates every candidate chunk in strict 6-step order against server-owned
 * authority and frozen provenance. Only chunks passing all checks are minted as `AdmittedChunk`
 * instances sealed in a module-private WeakSet; rejected chunk text is stripped immediately.
 */

import {
  ALLOWED_CLASSIFICATIONS_BY_DESTINATION,
  DESTINATION_GEMINI_CONTEXT,
  MAX_ADMITTED_CHUNKS,
  MAX_CHUNK_UTF8_BYTES,
  type DeclaredDestination,
} from '../shared/config.js';
import {
  ADMISSION_REASONS,
  type AdmissionReasonCode,
  type ChunkDisposition,
} from '../shared/reason-codes.js';
import { lookupFrozenRecordBySourceId, type ServerStoredRecord } from './fixture.js';
import { sha256Hex } from './redaction.js';
import type { ServerAuthoritySnapshot } from './session.js';

declare const ADMITTED_CHUNK_BRAND: unique symbol;

export interface AdmittedChunk {
  readonly [ADMITTED_CHUNK_BRAND]: 'verified_by_vervain_admission_gate';
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceVersionSha256: string;
  readonly contentSha256: string;
  readonly tenantId: string;
  readonly policyEpoch: number;
  readonly classification: string;
  readonly text: string;
}

const VERIFIED_ADMITTED_CHUNKS = new WeakSet<AdmittedChunk>();

function mintAdmittedChunk(params: {
  chunkId: string;
  sourceId: string;
  sourceVersionSha256: string;
  contentSha256: string;
  tenantId: string;
  policyEpoch: number;
  classification: string;
  text: string;
}): AdmittedChunk {
  const obj = Object.freeze({
    chunkId: params.chunkId,
    sourceId: params.sourceId,
    sourceVersionSha256: params.sourceVersionSha256,
    contentSha256: params.contentSha256,
    tenantId: params.tenantId,
    policyEpoch: params.policyEpoch,
    classification: params.classification,
    text: params.text,
  }) as unknown as AdmittedChunk;
  VERIFIED_ADMITTED_CHUNKS.add(obj);
  return obj;
}

/**
 * Runtime verification that `chunk` was genuinely minted by `evaluateContextAdmission`
 * and not forged via TypeScript type casting.
 */
export function isVerifiedAdmittedChunk(chunk: unknown): chunk is AdmittedChunk {
  return (
    typeof chunk === 'object' &&
    chunk !== null &&
    VERIFIED_ADMITTED_CHUNKS.has(chunk as AdmittedChunk)
  );
}

/**
 * Content-free decision metadata recorded for each candidate chunk.
 * Never retains raw `text`.
 */
export interface ChunkAdmissionDecision {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceVersionSha256: string;
  readonly contentSha256: string;
  readonly recordTenantId: string;
  readonly recordTenantLabel: string;
  readonly recordPolicyEpoch: number;
  readonly classification: string;
  readonly disposition: ChunkDisposition;
  readonly reasonCode: AdmissionReasonCode;
}

export interface ContextAdmissionResult {
  readonly admittedChunks: readonly AdmittedChunk[];
  readonly decisions: readonly ChunkAdmissionDecision[];
  readonly counts: {
    readonly retrieved: number;
    readonly admitted: number;
    readonly withheld: number;
    readonly unknown: number;
  };
}

const SAFE_ID_REGEX = /^[a-zA-Z0-9/_.-]{3,96}$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

export interface AdmissionOptions {
  readonly destination?: DeclaredDestination;
  readonly maxChunkUtf8Bytes?: number;
  readonly maxAdmittedChunks?: number;
  readonly recordLookupFn?: (sourceId: string) => ServerStoredRecord | undefined;
}

/**
 * Evaluates untrusted retrieved candidate chunks in exact 6-step deterministic order:
 * 1. schema is complete and recognized;
 * 2. source version and content digest match the frozen server record;
 * 3. record tenant equals session tenant;
 * 4. record epoch is valid for current authority;
 * 5. classification is allowed for declared destination (`gemini.context`);
 * 6. fixed size and count limits are satisfied.
 */
export function evaluateContextAdmission(
  candidateChunks: readonly unknown[],
  authority: Pick<ServerAuthoritySnapshot, 'tenantId' | 'policyEpoch'>,
  options?: AdmissionOptions,
): ContextAdmissionResult {
  const destination = options?.destination ?? DESTINATION_GEMINI_CONTEXT;
  const maxChunkUtf8Bytes = options?.maxChunkUtf8Bytes ?? MAX_CHUNK_UTF8_BYTES;
  const maxAdmittedChunks = options?.maxAdmittedChunks ?? MAX_ADMITTED_CHUNKS;
  const lookupRecord = options?.recordLookupFn ?? lookupFrozenRecordBySourceId;
  const allowedClassifications = ALLOWED_CLASSIFICATIONS_BY_DESTINATION[destination];

  const admittedChunks: AdmittedChunk[] = [];
  const decisions: ChunkAdmissionDecision[] = [];

  let admittedCount = 0;
  let withheldCount = 0;
  let unknownCount = 0;

  candidateChunks.forEach((rawCandidate, idx) => {
    const fallbackId = `chk_unrecognized_${idx}`;

    // Step 1: Schema is complete and recognized
    if (rawCandidate === null || typeof rawCandidate !== 'object' || Array.isArray(rawCandidate)) {
      unknownCount += 1;
      decisions.push(
        Object.freeze({
          chunkId: fallbackId,
          sourceId: 'unrecognized',
          sourceVersionSha256: '0'.repeat(64),
          contentSha256: '0'.repeat(64),
          recordTenantId: 'unknown',
          recordTenantLabel: 'Unknown',
          recordPolicyEpoch: -1,
          classification: 'unknown',
          disposition: 'unknown',
          reasonCode: ADMISSION_REASONS.MALFORMED_CHUNK,
        }),
      );
      return;
    }

    const rec = rawCandidate as Record<string, unknown>;
    const chunkId = rec['chunk_id'];
    const sourceId = rec['source_id'];
    const sourceVersionSha256 = rec['source_version_sha256'];
    const tenantId = rec['tenant_id'];
    const tenantLabel = rec['tenant_label'];
    const policyEpoch = rec['policy_epoch'];
    const classification = rec['classification'];
    const text = rec['text'];
    const contentSha256 = rec['content_sha256'];

    if (
      typeof chunkId !== 'string' ||
      typeof sourceId !== 'string' ||
      typeof sourceVersionSha256 !== 'string' ||
      typeof tenantId !== 'string' ||
      typeof policyEpoch !== 'number' ||
      !Number.isInteger(policyEpoch) ||
      policyEpoch < 0 ||
      typeof classification !== 'string' ||
      typeof text !== 'string' ||
      typeof contentSha256 !== 'string'
    ) {
      unknownCount += 1;
      decisions.push(
        Object.freeze({
          chunkId: typeof chunkId === 'string' && SAFE_ID_REGEX.test(chunkId) ? chunkId : fallbackId,
          sourceId:
            typeof sourceId === 'string' && SAFE_ID_REGEX.test(sourceId) ? sourceId : 'unrecognized',
          sourceVersionSha256:
            typeof sourceVersionSha256 === 'string' && SHA256_HEX_REGEX.test(sourceVersionSha256)
              ? sourceVersionSha256
              : '0'.repeat(64),
          contentSha256:
            typeof contentSha256 === 'string' && SHA256_HEX_REGEX.test(contentSha256)
              ? contentSha256
              : '0'.repeat(64),
          recordTenantId:
            typeof tenantId === 'string' && SAFE_ID_REGEX.test(tenantId) ? tenantId : 'unknown',
          recordTenantLabel: typeof tenantLabel === 'string' ? tenantLabel.slice(0, 48) : 'Unknown',
          recordPolicyEpoch:
            typeof policyEpoch === 'number' && Number.isInteger(policyEpoch) ? policyEpoch : -1,
          classification:
            typeof classification === 'string' && SAFE_ID_REGEX.test(classification)
              ? classification
              : 'unknown',
          disposition: 'unknown',
          reasonCode: ADMISSION_REASONS.SCHEMA_INCOMPLETE,
        }),
      );
      return;
    }

    if (
      !SAFE_ID_REGEX.test(chunkId) ||
      !SAFE_ID_REGEX.test(sourceId) ||
      !SAFE_ID_REGEX.test(tenantId) ||
      !SAFE_ID_REGEX.test(classification) ||
      !SHA256_HEX_REGEX.test(sourceVersionSha256) ||
      !SHA256_HEX_REGEX.test(contentSha256) ||
      text.includes('\u0000')
    ) {
      unknownCount += 1;
      decisions.push(
        Object.freeze({
          chunkId: SAFE_ID_REGEX.test(chunkId) ? chunkId : fallbackId,
          sourceId: SAFE_ID_REGEX.test(sourceId) ? sourceId : 'unrecognized',
          sourceVersionSha256: SHA256_HEX_REGEX.test(sourceVersionSha256)
            ? sourceVersionSha256
            : '0'.repeat(64),
          contentSha256: SHA256_HEX_REGEX.test(contentSha256) ? contentSha256 : '0'.repeat(64),
          recordTenantId: SAFE_ID_REGEX.test(tenantId) ? tenantId : 'unknown',
          recordTenantLabel: typeof tenantLabel === 'string' ? tenantLabel.slice(0, 48) : 'Unknown',
          recordPolicyEpoch: policyEpoch,
          classification: SAFE_ID_REGEX.test(classification) ? classification : 'unknown',
          disposition: 'unknown',
          reasonCode: ADMISSION_REASONS.MISSING_PROVENANCE,
        }),
      );
      return;
    }

    const safeLabel = typeof tenantLabel === 'string' && tenantLabel.length > 0 ? tenantLabel : tenantId;

    // Step 2: Source version and content digest match the frozen server record
    const authoritativeRecord = lookupRecord(sourceId);
    if (!authoritativeRecord) {
      withheldCount += 1;
      decisions.push(
        Object.freeze({
          chunkId,
          sourceId,
          sourceVersionSha256,
          contentSha256,
          recordTenantId: tenantId,
          recordTenantLabel: safeLabel,
          recordPolicyEpoch: policyEpoch,
          classification,
          disposition: 'withheld',
          reasonCode: ADMISSION_REASONS.UNRECOGNIZED_SOURCE,
        }),
      );
      return;
    }

    const computedTextSha256 = sha256Hex(text);
    if (
      authoritativeRecord.chunkId !== chunkId ||
      authoritativeRecord.sourceVersionSha256 !== sourceVersionSha256 ||
      authoritativeRecord.contentSha256 !== contentSha256 ||
      computedTextSha256 !== authoritativeRecord.contentSha256 ||
      authoritativeRecord.tenantId !== tenantId ||
      authoritativeRecord.policyEpoch !== policyEpoch ||
      authoritativeRecord.classification !== classification
    ) {
      withheldCount += 1;
      decisions.push(
        Object.freeze({
          chunkId,
          sourceId,
          sourceVersionSha256,
          contentSha256: computedTextSha256,
          recordTenantId: authoritativeRecord.tenantId,
          recordTenantLabel: authoritativeRecord.tenantLabel,
          recordPolicyEpoch: authoritativeRecord.policyEpoch,
          classification: authoritativeRecord.classification,
          disposition: 'withheld',
          reasonCode: ADMISSION_REASONS.DIGEST_MISMATCH,
        }),
      );
      return;
    }

    // Step 3: Record tenant equals session tenant
    if (authoritativeRecord.tenantId !== authority.tenantId) {
      withheldCount += 1;
      decisions.push(
        Object.freeze({
          chunkId,
          sourceId,
          sourceVersionSha256,
          contentSha256,
          recordTenantId: authoritativeRecord.tenantId,
          recordTenantLabel: authoritativeRecord.tenantLabel,
          recordPolicyEpoch: authoritativeRecord.policyEpoch,
          classification: authoritativeRecord.classification,
          disposition: 'withheld',
          reasonCode: ADMISSION_REASONS.TENANT_MISMATCH,
        }),
      );
      return;
    }

    // Step 4: Record epoch is valid for current authority
    if (authoritativeRecord.policyEpoch !== authority.policyEpoch) {
      withheldCount += 1;
      decisions.push(
        Object.freeze({
          chunkId,
          sourceId,
          sourceVersionSha256,
          contentSha256,
          recordTenantId: authoritativeRecord.tenantId,
          recordTenantLabel: authoritativeRecord.tenantLabel,
          recordPolicyEpoch: authoritativeRecord.policyEpoch,
          classification: authoritativeRecord.classification,
          disposition: 'withheld',
          reasonCode: ADMISSION_REASONS.STALE_POLICY_EPOCH,
        }),
      );
      return;
    }

    // Step 5: Classification is allowed for declared destination `gemini.context`
    if (!allowedClassifications.includes(authoritativeRecord.classification)) {
      withheldCount += 1;
      decisions.push(
        Object.freeze({
          chunkId,
          sourceId,
          sourceVersionSha256,
          contentSha256,
          recordTenantId: authoritativeRecord.tenantId,
          recordTenantLabel: authoritativeRecord.tenantLabel,
          recordPolicyEpoch: authoritativeRecord.policyEpoch,
          classification: authoritativeRecord.classification,
          disposition: 'withheld',
          reasonCode: ADMISSION_REASONS.DISALLOWED_CLASSIFICATION,
        }),
      );
      return;
    }

    // Step 6: Fixed size and count limits are satisfied
    const utf8Bytes = Buffer.byteLength(authoritativeRecord.text, 'utf8');
    if (utf8Bytes > maxChunkUtf8Bytes) {
      withheldCount += 1;
      decisions.push(
        Object.freeze({
          chunkId,
          sourceId,
          sourceVersionSha256,
          contentSha256,
          recordTenantId: authoritativeRecord.tenantId,
          recordTenantLabel: authoritativeRecord.tenantLabel,
          recordPolicyEpoch: authoritativeRecord.policyEpoch,
          classification: authoritativeRecord.classification,
          disposition: 'withheld',
          reasonCode: ADMISSION_REASONS.CHUNK_SIZE_EXCEEDED,
        }),
      );
      return;
    }

    if (admittedCount >= maxAdmittedChunks) {
      withheldCount += 1;
      decisions.push(
        Object.freeze({
          chunkId,
          sourceId,
          sourceVersionSha256,
          contentSha256,
          recordTenantId: authoritativeRecord.tenantId,
          recordTenantLabel: authoritativeRecord.tenantLabel,
          recordPolicyEpoch: authoritativeRecord.policyEpoch,
          classification: authoritativeRecord.classification,
          disposition: 'withheld',
          reasonCode: ADMISSION_REASONS.CHUNK_COUNT_EXCEEDED,
        }),
      );
      return;
    }

    // Passed all 6 checks -> mint verified AdmittedChunk
    admittedCount += 1;
    admittedChunks.push(
      mintAdmittedChunk({
        chunkId: authoritativeRecord.chunkId,
        sourceId: authoritativeRecord.sourceId,
        sourceVersionSha256: authoritativeRecord.sourceVersionSha256,
        contentSha256: authoritativeRecord.contentSha256,
        tenantId: authoritativeRecord.tenantId,
        policyEpoch: authoritativeRecord.policyEpoch,
        classification: authoritativeRecord.classification,
        text: authoritativeRecord.text,
      }),
    );

    decisions.push(
      Object.freeze({
        chunkId: authoritativeRecord.chunkId,
        sourceId: authoritativeRecord.sourceId,
        sourceVersionSha256: authoritativeRecord.sourceVersionSha256,
        contentSha256: authoritativeRecord.contentSha256,
        recordTenantId: authoritativeRecord.tenantId,
        recordTenantLabel: authoritativeRecord.tenantLabel,
        recordPolicyEpoch: authoritativeRecord.policyEpoch,
        classification: authoritativeRecord.classification,
        disposition: 'admitted',
        reasonCode: ADMISSION_REASONS.VALID_AUTHORITY_AND_PROVENANCE,
      }),
    );
  });

  return {
    admittedChunks: Object.freeze(admittedChunks),
    decisions: Object.freeze(decisions),
    counts: Object.freeze({
      retrieved: candidateChunks.length,
      admitted: admittedCount,
      withheld: withheldCount,
      unknown: unknownCount,
    }),
  };
}
