/**
 * Responsibility: M1 deterministic unit tests for authority derivation, strict JSON/header
 * validation, tenant-filtered vs broken retrieval, 6-step context admission, Sink-branded
 * envelope assembly, release-time epoch/planted-value checks, and hash-chained receipts.
 * Trust boundary: Automated local verification suite using deterministic in-memory stores.
 */

import { describe, expect, it } from 'vitest';
import { DESTINATION_GEMINI_CONTEXT } from '../../src/shared/config.js';
import {
  detectClientAuthorityOverride,
  parseStrictJson,
  validatePersonaSessionPayload,
} from '../../src/shared/contracts.js';
import { ADMISSION_REASONS, API_ERROR_CODES, RELEASE_REASONS } from '../../src/shared/reason-codes.js';
import {
  evaluateContextAdmission,
  isVerifiedAdmittedChunk,
  type AdmittedChunk,
} from '../../src/server/admission.js';
import { buildVervainGeminiEnvelope } from '../../src/server/envelope.js';
import {
  ALDER_RECORD,
  BEACON_RECORD,
  FROZEN_QUERY_SHA256,
  SYNTHETIC_PLANTED_VALUE,
  getProtectedFixtureSubstrings,
} from '../../src/server/fixture.js';
import { AuditLedger, canonicalJsonString } from '../../src/server/ledger.js';
import { buildAndAppendRunReceipt } from '../../src/server/receipts.js';
import { findProhibitedContentInObject } from '../../src/server/redaction.js';
import { ResponseReleaseGate } from '../../src/server/release.js';
import {
  retrieveBrokenControlChunks,
  retrieveTenantScopedChunks,
} from '../../src/server/retrieval.js';
import { SessionStore } from '../../src/server/session.js';

describe('M1 Security Core: Strict JSON and Authority Rejection', () => {
  it('rejects duplicate JSON object keys including Unicode-escaped duplicates', () => {
    const plainDup = parseStrictJson('{"persona":"alder","persona":"beacon"}');
    expect(plainDup.ok).toBe(false);
    if (!plainDup.ok) {
      expect(plainDup.code).toBe(API_ERROR_CODES.AMBIGUOUS_JSON_PAYLOAD);
    }

    const escapedDup = parseStrictJson('{"persona":"alder","\\u0070ersona":"beacon"}');
    expect(escapedDup.ok).toBe(false);
    if (!escapedDup.ok) {
      expect(escapedDup.code).toBe(API_ERROR_CODES.AMBIGUOUS_JSON_PAYLOAD);
    }
  });

  it('rejects __proto__, constructor, and prototype keys at any depth', () => {
    for (const payload of [
      '{"__proto__":{"tenant":"beacon"}}',
      '{"nested":{"constructor":{"prototype":{}}}}',
      '{"prototype":"bad"}',
    ]) {
      const res = parseStrictJson(payload);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe(API_ERROR_CODES.FORBIDDEN_JSON_KEY);
      }
    }
  });

  it('detects client-supplied tenant, principal, epoch, scope, and model overrides across headers, query, and body', () => {
    const headerOverride = detectClientAuthorityOverride({
      rawHeaders: ['Host', 'localhost:8080', 'X-Tenant-Id', 'tenant_beacon'],
      searchParams: new URLSearchParams(),
    });
    expect(headerOverride?.code).toBe(API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED);

    const queryOverride = detectClientAuthorityOverride({
      rawHeaders: [],
      searchParams: new URLSearchParams('policy_epoch=99'),
    });
    expect(queryOverride?.code).toBe(API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED);

    const bodyOverride = detectClientAuthorityOverride({
      rawHeaders: [],
      searchParams: new URLSearchParams(),
      bodyValue: { persona: 'alder', request_scope: '0x00beac11' },
    });
    expect(bodyOverride?.code).toBe(API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED);

    const unknownCheck = validatePersonaSessionPayload({ persona: 'alder', extra: 1 });
    expect(unknownCheck.ok).toBe(false);
    if (!unknownCheck.ok) {
      expect(unknownCheck.code).toBe(API_ERROR_CODES.UNKNOWN_FIELD);
    }
  });
});

describe('M1 Security Core: Session Rotation and Isolation', () => {
  it('rotates session IDs when switching persona and invalidates prior cookie', () => {
    const store = new SessionStore({
      secret: 'unit_test_secret_at_least_32_characters_long',
      ttlMs: 60_000,
    });
    const first = store.createOrRotateSession('alder');
    const second = store.createOrRotateSession('beacon', first.cookieToken);

    expect(second.snapshot.sessionId).not.toBe(first.snapshot.sessionId);
    expect(store.resolveCookieToken(first.cookieToken).ok).toBe(false);
    const resolvedSecond = store.resolveCookieToken(second.cookieToken);
    expect(resolvedSecond.ok).toBe(true);
    if (resolvedSecond.ok) {
      expect(resolvedSecond.snapshot.tenantId).toBe('tenant_beacon');
      expect(resolvedSecond.snapshot.policyEpoch).toBe(11);
    }
  });

  it('isolates two concurrent sessions even when given identical principal display strings', () => {
    const store = new SessionStore({
      secret: 'unit_test_secret_at_least_32_characters_long',
      ttlMs: 60_000,
    });
    const alderSes = store.createOrRotateSession('alder', null, 'shared-operator-display');
    const beaconSes = store.createOrRotateSession('beacon', null, 'shared-operator-display');

    store.registerSessionReceipt(alderSes.snapshot.sessionId, 1, 'rcpt_alder_only_123456');

    expect(store.ownsReceipt(alderSes.snapshot.sessionId, 'rcpt_alder_only_123456')).toBe(true);
    expect(store.ownsReceipt(beaconSes.snapshot.sessionId, 'rcpt_alder_only_123456')).toBe(false);

    // Resetting beacon does not touch alder
    store.resetSessionState(beaconSes.snapshot.sessionId);
    expect(store.ownsReceipt(alderSes.snapshot.sessionId, 'rcpt_alder_only_123456')).toBe(true);
  });
});

describe('M1 Security Core: Retrieval, 6-Step Admission, and Branded Envelope', () => {
  it('applies tenant, epoch, and classification predicates in the safe store query', () => {
    const store = new SessionStore({
      secret: 'unit_test_secret_at_least_32_characters_long',
      ttlMs: 60_000,
    });
    const { snapshot: alder } = store.createOrRotateSession('alder');
    const safeRes = retrieveTenantScopedChunks(alder, DESTINATION_GEMINI_CONTEXT);

    expect(safeRes.queryAudit.appliedTenantPredicate).toBe('tenant_alder');
    expect(safeRes.queryAudit.appliedEpochPredicate).toBe(7);
    expect(safeRes.chunks).toHaveLength(1);
    expect(safeRes.chunks[0]?.source_id).toBe(ALDER_RECORD.sourceId);

    // Beacon has restricted-strategy record only -> native store projection returns 0 for gemini.context
    const { snapshot: beacon } = store.createOrRotateSession('beacon');
    const beaconSafeRes = retrieveTenantScopedChunks(beacon, DESTINATION_GEMINI_CONTEXT);
    expect(beaconSafeRes.chunks).toHaveLength(0);
  });

  it('catches foreign, malformed, digest-tampered, stale, disallowed, and oversized chunks in 6-step order', () => {
    const alderAuthority = { tenantId: 'tenant_alder' as const, policyEpoch: 7 };
    const broken = retrieveBrokenControlChunks('cross_tenant_filter_omission');
    expect(broken.chunks).toHaveLength(2);

    const evaluated = evaluateContextAdmission(broken.chunks, alderAuthority);
    expect(evaluated.counts).toEqual({
      retrieved: 2,
      admitted: 1,
      withheld: 1,
      unknown: 0,
    });
    expect(evaluated.admittedChunks).toHaveLength(1);
    expect(evaluated.admittedChunks[0]?.sourceId).toBe(ALDER_RECORD.sourceId);

    const beaconDec = evaluated.decisions.find((d) => d.sourceId === BEACON_RECORD.sourceId);
    expect(beaconDec?.disposition).toBe('withheld');
    expect(beaconDec?.reasonCode).toBe(ADMISSION_REASONS.TENANT_MISMATCH);

    // Step 1: malformed / incomplete schema -> unknown
    const malformed = evaluateContextAdmission([{ chunk_id: 'bad' }], alderAuthority);
    expect(malformed.decisions[0]?.disposition).toBe('unknown');
    expect(malformed.decisions[0]?.reasonCode).toBe(ADMISSION_REASONS.SCHEMA_INCOMPLETE);

    // Step 2: digest mismatch -> withheld
    const validChunk = broken.chunks[0]!;
    const tamperedText = evaluateContextAdmission(
      [{ ...validChunk, text: `${validChunk.text} modified` }],
      alderAuthority,
    );
    expect(tamperedText.decisions[0]?.reasonCode).toBe(ADMISSION_REASONS.DIGEST_MISMATCH);

    // Step 4: stale epoch -> withheld
    const staleEval = evaluateContextAdmission([validChunk], {
      tenantId: 'tenant_alder',
      policyEpoch: 8,
    });
    expect(staleEval.decisions[0]?.reasonCode).toBe(ADMISSION_REASONS.STALE_POLICY_EPOCH);

    // Step 5: disallowed classification under Beacon authority -> withheld
    const beaconBrokenEval = evaluateContextAdmission([broken.chunks[1]!], {
      tenantId: 'tenant_beacon',
      policyEpoch: 11,
    });
    expect(beaconBrokenEval.decisions[0]?.reasonCode).toBe(
      ADMISSION_REASONS.DISALLOWED_CLASSIFICATION,
    );

    // Step 6: size & count limits -> withheld
    const sizeExceeded = evaluateContextAdmission([validChunk], alderAuthority, {
      maxChunkUtf8Bytes: 16,
    });
    expect(sizeExceeded.decisions[0]?.reasonCode).toBe(ADMISSION_REASONS.CHUNK_SIZE_EXCEEDED);

    const countExceeded = evaluateContextAdmission([validChunk, validChunk], alderAuthority, {
      maxAdmittedChunks: 1,
    });
    expect(countExceeded.counts.admitted).toBe(1);
    expect(countExceeded.decisions[1]?.reasonCode).toBe(ADMISSION_REASONS.CHUNK_COUNT_EXCEEDED);
  });

  it('prevents forged unchecked chunks from entering buildVervainGeminiEnvelope at runtime', () => {
    const forged = {
      chunkId: BEACON_RECORD.chunkId,
      sourceId: BEACON_RECORD.sourceId,
      sourceVersionSha256: BEACON_RECORD.sourceVersionSha256,
      contentSha256: BEACON_RECORD.contentSha256,
      tenantId: BEACON_RECORD.tenantId,
      policyEpoch: BEACON_RECORD.policyEpoch,
      classification: BEACON_RECORD.classification,
      text: BEACON_RECORD.text,
    } as unknown as AdmittedChunk;

    expect(isVerifiedAdmittedChunk(forged)).toBe(false);
    expect(() =>
      buildVervainGeminiEnvelope({
        requestId: 'req_forge_test',
        queryText: 'Query',
        admittedChunks: [forged],
        model: 'gemini-2.5-flash',
        temperature: 0,
        maxOutputTokens: 128,
      }),
    ).toThrow(/unchecked chunk/i);
  });
});

describe('M1 Security Core: Release Gate, Canonical Receipts, and Chain Tamper Detection', () => {
  it('withholds on epoch change, session expiry, planted-value match, and duplicate replay', () => {
    let now = 1_700_000_000_000;
    const store = new SessionStore({
      secret: 'unit_test_secret_at_least_32_characters_long',
      ttlMs: 10_000,
      nowFn: () => now,
    });
    const gate = new ResponseReleaseGate();

    // 1. Valid unchanged release + replay block
    const { snapshot: s1 } = store.createOrRotateSession('alder');
    const okRel = gate.evaluateRelease({
      requestId: 'req_1',
      authorityAtAdmission: s1,
      sessionStore: store,
      allowedSourceIds: ['alder/renewal-playbook-v3'],
      candidate: {
        rawText: '{"answer":"Discount up to 12 percent.","sources_used":["alder/renewal-playbook-v3"]}',
        parsedAnswer: 'Discount up to 12 percent.',
        parsedSourcesUsed: ['alder/renewal-playbook-v3'],
      },
    });
    expect(okRel.decision).toBe('released');
    expect(okRel.reasonCode).toBe(RELEASE_REASONS.AUTHORITY_VERIFIED);

    const replayRel = gate.evaluateRelease({
      requestId: 'req_1',
      authorityAtAdmission: s1,
      sessionStore: store,
      allowedSourceIds: ['alder/renewal-playbook-v3'],
      candidate: {
        rawText: '{"answer":"Discount up to 12 percent.","sources_used":[]}',
        parsedAnswer: 'Discount up to 12 percent.',
        parsedSourcesUsed: [],
      },
    });
    expect(replayRel.decision).toBe('withheld');
    expect(replayRel.reasonCode).toBe(RELEASE_REASONS.DUPLICATE_RELEASE_BLOCKED);

    // 2. Epoch increment before release -> withheld
    const { snapshot: s2 } = store.createOrRotateSession('alder');
    store.incrementPolicyEpoch(s2.sessionId);
    const epochRel = gate.evaluateRelease({
      requestId: 'req_2',
      authorityAtAdmission: s2,
      sessionStore: store,
      allowedSourceIds: [],
      candidate: {
        rawText: '{"answer":"Allowed text","sources_used":[]}',
        parsedAnswer: 'Allowed text',
        parsedSourcesUsed: [],
      },
    });
    expect(epochRel.decision).toBe('withheld');
    expect(epochRel.reasonCode).toBe(RELEASE_REASONS.POLICY_EPOCH_CHANGED);

    // 3. Planted value in mocked output -> withheld
    const { snapshot: s3 } = store.createOrRotateSession('alder');
    const plantedRel = gate.evaluateRelease({
      requestId: 'req_3',
      authorityAtAdmission: s3,
      sessionStore: store,
      allowedSourceIds: [],
      candidate: {
        rawText: `{"answer":"Code ${SYNTHETIC_PLANTED_VALUE}","sources_used":[]}`,
        parsedAnswer: `Code ${SYNTHETIC_PLANTED_VALUE}`,
        parsedSourcesUsed: [],
      },
    });
    expect(plantedRel.decision).toBe('withheld');
    expect(plantedRel.reasonCode).toBe(RELEASE_REASONS.PLANTED_VALUE_DETECTED);
    expect(plantedRel.releasedAnswer).toBeNull();

    // 4. Expired session -> withheld
    const { snapshot: s4 } = store.createOrRotateSession('alder');
    now += 20_000;
    const expiredRel = gate.evaluateRelease({
      requestId: 'req_4',
      authorityAtAdmission: s4,
      sessionStore: store,
      allowedSourceIds: [],
      candidate: {
        rawText: '{"answer":"Allowed","sources_used":[]}',
        parsedAnswer: 'Allowed',
        parsedSourcesUsed: [],
      },
    });
    expect(expiredRel.decision).toBe('withheld');
    expect(expiredRel.reasonCode).toBe(RELEASE_REASONS.SESSION_EXPIRED);
  });

  it('produces content-free canonical receipts and fails chain verification when tampered', () => {
    const store = new SessionStore({
      secret: 'unit_test_secret_at_least_32_characters_long',
      ttlMs: 60_000,
    });
    const ledger = new AuditLedger();
    const { snapshot: alder, cookieToken } = store.createOrRotateSession('alder');
    const broken = retrieveBrokenControlChunks('cross_tenant_filter_omission');
    const admission = evaluateContextAdmission(broken.chunks, alder);

    const receipt = buildAndAppendRunReceipt({
      ledger,
      requestId: 'req_chain_1',
      scenario: 'paired_defect',
      arm: 'native_plus_vervain',
      authorityAtAdmission: alder,
      policyEpochAtRelease: alder.policyEpoch,
      querySha256: FROZEN_QUERY_SHA256,
      retrievedChunks: broken.chunks,
      admissionDecisions: admission.decisions,
      envelopeSha256: 'a'.repeat(64),
      admittedChunkCount: 1,
      foreignTenantChunkInEnvelope: false,
      modelId: 'gemini-2.5-flash',
      transportMode: 'mock',
      providerCallAttempted: true,
      providerOutcome: 'succeeded',
      providerLatencyMs: 12,
      providerRetryCount: 0,
      releaseDecision: 'released',
      releaseReasonCode: 'authority_verified',
      responseSha256: 'b'.repeat(64),
      responseUtf8Bytes: 64,
      plantedValueExactMatch: false,
      permittedTaskCompleted: true,
      permittedTaskBasis: 'released_authorized_answer_under_unchanged_epoch',
      startedAtMs: 1_700_000_000_000,
      completedAtMs: 1_700_000_000_015,
      extraSecretsToRedactCheck: ['AIzaSySyntheticTestSecretKeyValue123456', cookieToken],
    });

    // Recursive secret/content check
    const leak = findProhibitedContentInObject(
      JSON.parse(canonicalJsonString(receipt)),
      getProtectedFixtureSubstrings([cookieToken, alder.sessionId, 'AIzaSySyntheticTestSecretKeyValue123456']),
    );
    expect(leak).toBeNull();

    // Verify intact chain
    const intact = ledger.verifyChain();
    expect(intact.verified).toBe(true);
    expect(intact.checkedEvents).toBe(6);
    expect(intact.checkedReceipts).toBe(1);

    // Tamper with an earlier event payload -> chain verification MUST fail
    ledger.tamperEventAtIndexForTest(1, (orig) => ({
      ...orig,
      payload: { ...orig.payload, withheld_count: 0 },
    }));
    const tampered = ledger.verifyChain();
    expect(tampered.verified).toBe(false);
    expect(tampered.failureIndex).toBe(1);
  });
});
