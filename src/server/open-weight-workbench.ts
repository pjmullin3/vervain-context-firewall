/**
 * Responsibility: Deterministic reference KV lifecycle workbench, Proxy-instrumented online
 * tiled FlashAttention-2 `(m_i, l_i, O_i)` recurrence, HMAC-salted prefix-cache key derivation,
 * open-weight engine architectural profiles, and enterprise deployment presets.
 * Trust boundary: Derives scope tags, tenant identifiers, and policy epochs strictly from
 * server-owned `ServerAuthoritySnapshot`. Reference simulation math only; not wired to GPU HBM.
 */

import crypto from 'node:crypto';
import { SCOPED_ATTENTION_LIMITATION_LABEL } from '../shared/config.js';
import type {
  EnterprisePresetSummary,
  KvLifecycleModeEvidence,
  OnlineTileStepEvidence,
  OpenWeightEngineProfile,
} from '../shared/contracts.js';
import { TENANT_FIXTURES } from './fixture.js';
import {
  formatScopeHex,
  runReferencePagedAttention,
  type PagedKvPhysicalPool,
} from './scoped-attention.js';
import type { ServerAuthoritySnapshot } from './session.js';

export const OPEN_WEIGHT_WORKBENCH_LIMITATION_LABEL = SCOPED_ATTENTION_LIMITATION_LABEL;

/**
 * Shared tokenized system instruction prefix (Qwen2.5 chat template token IDs)
 * used to demonstrate un-salted APC/Radix token-hash collision vs HMAC-salted separation.
 */
export const SHARED_SYSTEM_PREFIX_TOKENS: readonly number[] = Object.freeze([
  151644, 8948, 198, 2610, 525, 264, 10950, 17847, 13, 151645,
]);

const PREFIX_CACHE_DOMAIN_KEY = Buffer.from(
  'vervain.open-weight.prefix-cache-salt.v1',
  'utf8',
);

const OPEN_WEIGHT_ENGINE_PROFILES: readonly OpenWeightEngineProfile[] = Object.freeze([
  Object.freeze({
    engineId: 'vllm',
    displayName: 'vLLM (V1 Engine)',
    deploymentClass: 'open_weight_self_hosted',
    kvAndPrefixSurface: 'PagedAttention block_table + APC token hash',
    unguardedFailureMode:
      'Un-salted Automatic Prefix Caching (APC) keys hash raw token IDs without tenant scope or policy epoch, and corrupted or stale block_table entries reference residual physical KV blocks in GPU HBM.',
    vervainEnforcementHook:
      'Server-derived cache_salt HMAC(tenantId, requestScopeTag, policyEpoch) on APC block hashes plus pre-dispatch (scopeTag, allocationGeneration) side-table validation.',
    demoEvidenceStatus: 'reference_simulation_only',
  }),
  Object.freeze({
    engineId: 'sglang',
    displayName: 'SGLang Runtime',
    deploymentClass: 'open_weight_self_hosted',
    kvAndPrefixSurface: 'RadixAttention tree cache',
    unguardedFailureMode:
      'Shared RadixAttention prefix-tree edges match longest common token sequences across concurrent multi-tenant requests when tree nodes lack tenant scope and epoch partitioning.',
    vervainEnforcementHook:
      'Scope-partitioned RadixAttention tree lookup keys bound to server session authority and monotonic policy-epoch node invalidation prior to decode scheduling.',
    demoEvidenceStatus: 'reference_simulation_only',
  }),
  Object.freeze({
    engineId: 'ollama',
    displayName: 'Ollama / llama.cpp Runner',
    deploymentClass: 'open_weight_self_hosted',
    kvAndPrefixSurface: 'local runner KV slot cache',
    unguardedFailureMode:
      'Shared single-node runner slots retain prior prompt KV state across sequential calls when prompt-similarity slot reuse executes without per-tenant eviction.',
    vervainEnforcementHook:
      'Gateway-assigned slot ownership tag, mandatory KV slot clear on tenant or policy-epoch change, and release-time authority recheck.',
    demoEvidenceStatus: 'reference_simulation_only',
  }),
  Object.freeze({
    engineId: 'dynamo',
    displayName: 'NVIDIA Dynamo Disaggregated Pool',
    deploymentClass: 'neocloud_disaggregated',
    kvAndPrefixSurface: 'disaggregated prefill/decode KV router',
    unguardedFailureMode:
      'KV-aware cluster routers steer requests toward prefill workers advertising matching token-prefix hashes or reuse remote RDMA block descriptors after policy epoch rotation.',
    vervainEnforcementHook:
      'HMAC-salted KV router lookup digest and descriptor-bound (scopeTag, allocationGeneration, policyEpoch) verification before prefill-to-decode KV transfer admission.',
    demoEvidenceStatus: 'reference_simulation_only',
  }),
  Object.freeze({
    engineId: 'gemini_api',
    displayName: 'Google Gemini Hosted API',
    deploymentClass: 'hosted_frontier_api',
    kvAndPrefixSurface: 'outbound context envelope + release epoch gate',
    unguardedFailureMode:
      'Provider-internal KV memory and weights sit outside customer control; once a foreign retrieved chunk enters the outbound prompt envelope, post-generation text filters run too late.',
    vervainEnforcementHook:
      'Pre-transmission per-chunk tenant and epoch admission gate on the outbound context envelope, paired with release-time epoch re-verification and hash-chained causal receipts.',
    demoEvidenceStatus: 'active_in_this_app',
  }),
]);

const ENTERPRISE_PRESETS: readonly EnterprisePresetSummary[] = Object.freeze([
  Object.freeze({
    presetId: 'northstar_commercial',
    label: 'Northstar Commercial Renewal Desk',
    sector: 'B2B SaaS Revenue Operations',
    iamUpstream: 'Okta OIDC workforce session (principal:alder-operator, tenant_alder, epoch 7)',
    inferenceRuntimeTarget: 'Google Gemini 2.5 Flash mediated by Vervain Context Firewall',
    downstreamEgress: 'Browser renewal workspace release gate + SIEM causal receipt stream',
    postIamBlindSpot:
      'Workforce IAM authenticates the Alder operator at login, but an unscoped retriever omits the tenant filter and returns a restricted Beacon strategy note beside Alder renewal terms.',
    preEgressFailureWhyDlpIsLate:
      'Once the foreign Beacon chunk crosses into the Gemini context envelope, attention layers condition token generation on restricted strategy context before output regexes inspect the reply.',
    vervainInterventionSummary:
      'Evaluates 2 retrieved chunks before transmission, admits 1 of 2 authorized Alder chunks, withholds 1 of 2 foreign Beacon chunks, and re-checks epoch 7 before browser release.',
    retrievedDenominator: 2,
    admittedCount: 1,
    withheldCount: 1,
    primaryWithholdReason: 'tenant_mismatch',
  }),
  Object.freeze({
    presetId: 'neocloud_shared_gpu',
    label: 'Shared H200 Neocloud Open-Weight Pool',
    sector: 'AI Infrastructure / Multi-Tenant GPU Serving',
    iamUpstream: 'mTLS ingress gateway mapping tenant claims to server-owned 32-bit scope tags',
    inferenceRuntimeTarget: 'Self-hosted vLLM TP8 (Qwen2.5-72B-Instruct) with PagedAttention + APC',
    downstreamEgress: 'Token stream gateway + Carbon 3 inference-proof.v1 verifier',
    postIamBlindSpot:
      'HTTP ingress authenticates the caller token, yet inside the shared worker pool Automatic Prefix Caching hashes raw token IDs and free-list block reuse leaves prior KV vectors in HBM.',
    preEgressFailureWhyDlpIsLate:
      'Scaled dot-product attention over a foreign or stale physical KV block shifts output logits inside BF16 tensor math without necessarily emitting literal substrings that egress scanners flag.',
    vervainInterventionSummary:
      'Salts APC hashes with HMAC(tenantId, scopeTag, policyEpoch) and checks (scopeTag, allocationGeneration) headers across 4 logical KV blocks, admitting 3 of 4 blocks and skipping 1 of 4 unauthorized blocks with zero KV reads.',
    retrievedDenominator: 4,
    admittedCount: 3,
    withheldCount: 1,
    primaryWithholdReason: 'deny_scope_mismatch',
  }),
  Object.freeze({
    presetId: 'institutional_mnpi_wall',
    label: 'Institutional Research vs Advisory Wall',
    sector: 'Capital Markets / Information Barrier Operations',
    iamUpstream: 'Entra ID SAML + wall-crossing entitlement service with monotonic policy epochs',
    inferenceRuntimeTarget: 'VPC-hosted SGLang / vLLM equity research copilot + frontier fallback',
    downstreamEgress: 'Analyst memo terminal + append-only supervisory receipt ledger',
    postIamBlindSpot:
      'An equity research analyst authenticated in public-side coverage triggers synthesis right as control-room staff add an issuer to the restricted watch list and increment the policy epoch.',
    preEgressFailureWhyDlpIsLate:
      'In-flight token generation started under the prior epoch has already conditioned on pre-wall deal notes; egress keyword rules cannot distinguish admission epoch from release epoch.',
    vervainInterventionSummary:
      'Evaluates 4 retrieved issuer documents, admits 2 of 4 public-side filings, withholds 2 of 4 restricted advisory notes at admission, and withholds in-flight replies if policyEpochAtRelease advances.',
    retrievedDenominator: 4,
    admittedCount: 2,
    withheldCount: 2,
    primaryWithholdReason: 'stale_policy_epoch',
  }),
  Object.freeze({
    presetId: 'clinical_care_triage',
    label: 'Regional Care Network Clinical Handoff',
    sector: 'Healthcare Provider Operations',
    iamUpstream: 'SMART on FHIR clinician OIDC session bound to active unit encounter',
    inferenceRuntimeTarget: 'Self-hosted open-weight clinical summarizer (vLLM / Dynamo pool)',
    downstreamEgress: 'EHR handoff draft view + content-free SHA-256 audit receipt log',
    postIamBlindSpot:
      'Clinician SSO verifies hospital identity, but hybrid chart retrieval pulls 5 encounter segments across affiliated clinics including 2 behavioral-health notes outside active unit scope.',
    preEgressFailureWhyDlpIsLate:
      'Post-generation PHI scrubbers either strip clinical terms needed for the permitted unit handoff or miss cross-encounter details already blended into triage reasoning.',
    vervainInterventionSummary:
      'Applies unit-scoped admission across 5 retrieved chart segments, admitting 3 of 5 active-encounter segments while withholding 2 of 5 out-of-scope segments and logging zero-PHI SHA-256 receipts.',
    retrievedDenominator: 5,
    admittedCount: 3,
    withheldCount: 2,
    primaryWithholdReason: 'disallowed_classification',
  }),
]);

export function getOpenWeightEngineProfiles(): readonly OpenWeightEngineProfile[] {
  return OPEN_WEIGHT_ENGINE_PROFILES;
}

export function getEnterprisePresets(): readonly EnterprisePresetSummary[] {
  return ENTERPRISE_PRESETS;
}

function normalizeZero(v: number): number {
  return Object.is(v, -0) ? 0 : v;
}

function maxAbsDiff(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let max = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (diff > max) max = diff;
  }
  return normalizeZero(max);
}

/**
 * Computes the un-salted stock prefix-cache SHA-256 over raw token IDs only.
 * Identical system prefixes across tenants or policy epochs collide onto the same digest.
 */
export function computeUnsaltedPrefixCacheHash(tokens: readonly number[]): string {
  return crypto
    .createHash('sha256')
    .update(`apc.unsalted.v1:${tokens.join(',')}`, 'utf8')
    .digest('hex');
}

/**
 * Computes the Vervain HMAC-SHA256 salted prefix-cache key bound to server-owned
 * `tenantId`, 32-bit `requestScopeTag`, and `policyEpoch` alongside the token sequence.
 */
export function computeSaltedPrefixCacheHash(
  tokens: readonly number[],
  authority: Pick<ServerAuthoritySnapshot, 'tenantId' | 'requestScopeTag' | 'policyEpoch'>,
): string {
  const scopeHex = formatScopeHex(authority.requestScopeTag >>> 0);
  const payload = [
    'vervain.apc.salted.v1',
    authority.tenantId,
    scopeHex,
    `epoch=${authority.policyEpoch}`,
    `tokens=${tokens.join(',')}`,
  ].join('|');
  return crypto.createHmac('sha256', PREFIX_CACHE_DOMAIN_KEY).update(payload, 'utf8').digest('hex');
}

export interface InstrumentedKvPoolResult {
  readonly pool: PagedKvPhysicalPool;
  readonly blockGenerations: readonly number[];
  getScalarReadsForBlock(physicalBlockId: number): number;
  getTouchesForBlock(physicalBlockId: number): number;
  getTotalScalarReads(): number;
  resetCounters(): void;
}

/**
 * Wraps a 3D `[numPhysicalBlocks][blockSize][headDim]` KV pool in nested `Proxy` getters
 * that count every block-level access and every scalar element read (`K[b][s][d]`, `V[b][s][d]`).
 */
export function createProxyInstrumentedKvPool(params: {
  readonly blockSize: number;
  readonly headDim: number;
  readonly keys: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>;
  readonly values: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>;
  readonly blockScopeTags: ReadonlyArray<number>;
  readonly blockGenerations: ReadonlyArray<number>;
  readonly blockLabels?: ReadonlyArray<string>;
}): InstrumentedKvPoolResult {
  const numBlocks = params.keys.length;
  const scalarReadsByBlock = new Array<number>(numBlocks).fill(0);
  const blockTouches = new Array<number>(numBlocks).fill(0);

  const wrapTensor3D = (
    tensor: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>,
  ): ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>> =>
    new Proxy(tensor, {
      get(target, prop, receiver) {
        if (typeof prop === 'string') {
          const bIdx = Number(prop);
          if (Number.isInteger(bIdx) && bIdx >= 0 && bIdx < target.length) {
            blockTouches[bIdx] = (blockTouches[bIdx] ?? 0) + 1;
            const blockSlice = target[bIdx]!;
            return new Proxy(blockSlice, {
              get(bTarget, slotProp, bReceiver) {
                if (typeof slotProp === 'string') {
                  const sIdx = Number(slotProp);
                  if (Number.isInteger(sIdx) && sIdx >= 0 && sIdx < bTarget.length) {
                    const vecSlice = bTarget[sIdx]!;
                    return new Proxy(vecSlice, {
                      get(vTarget, dimProp, vReceiver) {
                        if (typeof dimProp === 'string') {
                          const dIdx = Number(dimProp);
                          if (Number.isInteger(dIdx) && dIdx >= 0 && dIdx < vTarget.length) {
                            scalarReadsByBlock[bIdx] = (scalarReadsByBlock[bIdx] ?? 0) + 1;
                            return vTarget[dIdx];
                          }
                        }
                        return Reflect.get(vTarget, dimProp, vReceiver);
                      },
                    });
                  }
                }
                return Reflect.get(bTarget, slotProp, bReceiver);
              },
            });
          }
        }
        return Reflect.get(target, prop, receiver);
      },
    });

  const proxiedPool: PagedKvPhysicalPool = Object.freeze({
    blockSize: params.blockSize,
    headDim: params.headDim,
    keys: wrapTensor3D(params.keys),
    values: wrapTensor3D(params.values),
    blockScopeTags: Object.freeze([...params.blockScopeTags]),
    blockLabels: params.blockLabels ? Object.freeze([...params.blockLabels]) : undefined,
  });

  return {
    pool: proxiedPool,
    blockGenerations: Object.freeze([...params.blockGenerations]),
    getScalarReadsForBlock: (bIdx: number): number => scalarReadsByBlock[bIdx] ?? 0,
    getTouchesForBlock: (bIdx: number): number => blockTouches[bIdx] ?? 0,
    getTotalScalarReads: (): number => scalarReadsByBlock.reduce((acc, n) => acc + n, 0),
    resetCounters: (): void => {
      scalarReadsByBlock.fill(0);
      blockTouches.fill(0);
    },
  };
}

export interface OnlineTiledFlashRunResult {
  readonly steps: readonly OnlineTileStepEvidence[];
  readonly finalOutput: readonly number[];
  readonly finalMaxLogitM: number | null;
  readonly finalDenomL: number;
  readonly perSlotMass: readonly number[];
  readonly unauthorizedScalarReads: number;
  readonly unauthorizedBlockTouches: number;
}

/**
 * Executes the FlashAttention-2 online softmax `(m_i, l_i, O_i)` tile recurrence step-by-step
 * over a `Proxy`-instrumented KV pool. When `enforceHeaderGuard` is true, `(scopeTag, generation)`
 * side-array headers are validated BEFORE indexing `pool.keys[physId]` or `pool.values[physId]`,
 * skipping foreign-scope or stale-generation tiles with `0` KV tensor reads.
 */
export function runOnlineTiledFlashAttention(params: {
  readonly query: ReadonlyArray<number>;
  readonly blockTable: ReadonlyArray<number>;
  readonly expectedGenerations: ReadonlyArray<number>;
  readonly validityMask: ReadonlyArray<ReadonlyArray<boolean>>;
  readonly requestScopeTag: number;
  readonly enforceHeaderGuard: boolean;
  readonly instrumented: InstrumentedKvPoolResult;
}): OnlineTiledFlashRunResult {
  const {
    query,
    blockTable,
    expectedGenerations,
    validityMask,
    requestScopeTag,
    enforceHeaderGuard,
    instrumented,
  } = params;
  instrumented.resetCounters();

  const { pool, blockGenerations } = instrumented;
  const d = pool.headDim;
  const blockSize = pool.blockSize;
  const scaleFactor = 1 / Math.sqrt(d);
  const reqScope = requestScopeTag >>> 0;

  let runningM = Number.NEGATIVE_INFINITY;
  let runningL = 0;
  const unnormalizedO = new Array<number>(d).fill(0);
  let normalizedO: readonly number[] = Object.freeze(new Array<number>(d).fill(0));

  const steps: OnlineTileStepEvidence[] = [];
  const loadedTileScores: Array<{ slotIdx: number; scores: readonly number[] }> = [];
  let unauthorizedScalarReads = 0;
  let unauthorizedBlockTouches = 0;

  for (let stepIdx = 0; stepIdx < blockTable.length; stepIdx += 1) {
    const physId = blockTable[stepIdx]!;
    const expectedGen = expectedGenerations[stepIdx]!;
    const actualGen = blockGenerations[physId]!;
    const blockScope = pool.blockScopeTags[physId]! >>> 0;
    const scopeMatches = blockScope === reqScope;
    const genMatches = Number.isInteger(actualGen) && actualGen >= 1 && actualGen === expectedGen;

    const readsBefore = instrumented.getTotalScalarReads();
    const touchesBefore = instrumented.getTouchesForBlock(physId);

    if (enforceHeaderGuard && !scopeMatches) {
      const readsDelta = instrumented.getTotalScalarReads() - readsBefore;
      const touchDelta = instrumented.getTouchesForBlock(physId) - touchesBefore;
      unauthorizedScalarReads += readsDelta;
      unauthorizedBlockTouches += touchDelta;

      steps.push(
        Object.freeze({
          stepIndex: stepIdx,
          logicalSlot: stepIdx,
          physicalBlockId: physId,
          blockScopeHex: formatScopeHex(blockScope),
          allocationGeneration: actualGen,
          expectedGeneration: expectedGen,
          headerCheckDisposition: 'skipped_foreign_scope_zero_kv_read',
          kvTensorReadsPerformed: readsDelta,
          runningMaxLogitM: Number.isFinite(runningM) ? normalizeZero(runningM) : null,
          runningDenomL: normalizeZero(runningL),
          runningNormalizedOutput: normalizedO,
        }),
      );
      continue;
    }

    if (enforceHeaderGuard && !genMatches) {
      const readsDelta = instrumented.getTotalScalarReads() - readsBefore;
      const touchDelta = instrumented.getTouchesForBlock(physId) - touchesBefore;
      unauthorizedScalarReads += readsDelta;
      unauthorizedBlockTouches += touchDelta;

      steps.push(
        Object.freeze({
          stepIndex: stepIdx,
          logicalSlot: stepIdx,
          physicalBlockId: physId,
          blockScopeHex: formatScopeHex(blockScope),
          allocationGeneration: actualGen,
          expectedGeneration: expectedGen,
          headerCheckDisposition: 'skipped_stale_generation_zero_kv_read',
          kvTensorReadsPerformed: readsDelta,
          runningMaxLogitM: Number.isFinite(runningM) ? normalizeZero(runningM) : null,
          runningDenomL: normalizeZero(runningL),
          runningNormalizedOutput: normalizedO,
        }),
      );
      continue;
    }

    // Header check passed (or unguarded baseline): load valid token slots from physical tile
    const kTile = pool.keys[physId]!;
    const vTile = pool.values[physId]!;
    const slotMask = validityMask[stepIdx]!;

    const tileScores: number[] = [];
    const tileValues: number[][] = [];

    for (let s = 0; s < blockSize; s += 1) {
      if (!slotMask[s]) continue;
      const kVec = kTile[s]!;
      const vVec = vTile[s]!;
      let dot = 0;
      const vLoaded = new Array<number>(d);
      for (let dim = 0; dim < d; dim += 1) {
        dot += query[dim]! * kVec[dim]!;
        vLoaded[dim] = vVec[dim]!;
      }
      tileScores.push(dot * scaleFactor);
      tileValues.push(vLoaded);
    }

    if (tileScores.length > 0) {
      let tileMax = Number.NEGATIVE_INFINITY;
      for (const sc of tileScores) {
        if (sc > tileMax) tileMax = sc;
      }
      const nextM = Math.max(runningM, tileMax);
      const rescalePrior = Number.isFinite(runningM) ? Math.exp(runningM - nextM) : 0;

      for (let dim = 0; dim < d; dim += 1) {
        unnormalizedO[dim] = unnormalizedO[dim]! * rescalePrior;
      }

      let tileL = 0;
      for (let t = 0; t < tileScores.length; t += 1) {
        const p = Math.exp(tileScores[t]! - nextM);
        tileL += p;
        const vVec = tileValues[t]!;
        for (let dim = 0; dim < d; dim += 1) {
          unnormalizedO[dim] = unnormalizedO[dim]! + p * vVec[dim]!;
        }
      }

      runningM = nextM;
      runningL = runningL * rescalePrior + tileL;
      normalizedO = Object.freeze(
        unnormalizedO.map((acc) => normalizeZero(acc / runningL)),
      );
      loadedTileScores.push({ slotIdx: stepIdx, scores: tileScores });
    }

    const readsDelta = instrumented.getTotalScalarReads() - readsBefore;
    steps.push(
      Object.freeze({
        stepIndex: stepIdx,
        logicalSlot: stepIdx,
        physicalBlockId: physId,
        blockScopeHex: formatScopeHex(blockScope),
        allocationGeneration: actualGen,
        expectedGeneration: expectedGen,
        headerCheckDisposition: 'loaded_authorized_tile',
        kvTensorReadsPerformed: readsDelta,
        runningMaxLogitM: Number.isFinite(runningM) ? normalizeZero(runningM) : null,
        runningDenomL: normalizeZero(runningL),
        runningNormalizedOutput: normalizedO,
      }),
    );
  }

  const perSlotMass = new Array<number>(blockTable.length).fill(0);
  if (runningL > 0 && Number.isFinite(runningM)) {
    for (const entry of loadedTileScores) {
      let mass = 0;
      for (const sc of entry.scores) {
        mass += Math.exp(sc - runningM) / runningL;
      }
      perSlotMass[entry.slotIdx] = normalizeZero(mass);
    }
  }

  return Object.freeze({
    steps: Object.freeze(steps),
    finalOutput: normalizedO,
    finalMaxLogitM: Number.isFinite(runningM) ? normalizeZero(runningM) : null,
    finalDenomL: normalizeZero(runningL),
    perSlotMass: Object.freeze(perSlotMass),
    unauthorizedScalarReads,
    unauthorizedBlockTouches,
  });
}

export interface OpenWeightKvWorkbenchView {
  readonly kvModes: readonly KvLifecycleModeEvidence[];
  readonly onlineTileSteps: readonly OnlineTileStepEvidence[];
  readonly engineProfiles: readonly OpenWeightEngineProfile[];
  readonly zeroForeignKvReadsVerified: boolean;
}

/**
 * Builds the 4-mode Open-Weight KV Lifecycle Workbench bound to the caller's server-owned
 * `ServerAuthoritySnapshot` using deterministic PagedAttention, HMAC prefix-hash salting,
 * ABA generation header checks, and Proxy-instrumented online `(m_i, l_i, O_i)` recurrence.
 */
export function buildOpenWeightKvWorkbenchForSession(
  authority: Pick<
    ServerAuthoritySnapshot,
    'persona' | 'tenantId' | 'tenantLabel' | 'policyEpoch' | 'requestScopeTag'
  >,
): OpenWeightKvWorkbenchView {
  const ownScope = authority.requestScopeTag >>> 0;
  const foreignFixture =
    authority.persona === 'alder' ? TENANT_FIXTURES.beacon : TENANT_FIXTURES.alder;
  const foreignScope = foreignFixture.requestScopeTag >>> 0;

  const rawKeys: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>> = [
    [
      [1.1, 0.4, -0.2, 0.5],
      [0.8, 0.6, 0.1, 0.3],
    ],
    [
      [1.6, 0.9, 0.3, 0.8],
      [1.3, 0.7, 0.2, 0.6],
    ],
    [
      [0.5, 0.9, -0.1, 0.4],
      [0.3, 0.4, 0.5, -0.2],
    ],
    [
      [0.7, 0.2, 0.4, 0.5],
      [2.2, 2.2, 2.2, 2.2],
    ],
  ];

  const rawValues: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>> = [
    [
      [0.4, 0.1, 0.8, 0.2],
      [0.3, 0.2, 0.7, 0.1],
    ],
    [
      [-1.8, 2.4, -1.5, 1.9],
      [-1.6, 2.1, -1.3, 1.7],
    ],
    [
      [0.5, 0.3, 0.6, 0.2],
      [0.2, 0.4, 0.5, 0.3],
    ],
    [
      [0.35, 0.25, 0.65, 0.15],
      [9.0, -9.0, 9.0, -9.0],
    ],
  ];

  const basePool: PagedKvPhysicalPool = {
    blockSize: 2,
    headDim: 4,
    keys: rawKeys,
    values: rawValues,
    blockScopeTags: [ownScope, foreignScope, ownScope, ownScope],
  };

  const query = [1.0, 0.6, 0.1, 0.5];
  const contaminatedTable = [0, 1, 2, 3];
  const contaminatedValidity = [
    [true, true],
    [true, true],
    [true, true],
    [true, false],
  ];
  const cleanTable = [0, 2, 3];
  const cleanValidity = [
    [true, true],
    [true, true],
    [true, false],
  ];

  // Clean allowed-only reference twin
  const cleanTwin = runReferencePagedAttention({
    query,
    blockTable: cleanTable,
    validityMask: cleanValidity,
    requestScopeTag: ownScope,
    enforceScopeMask: true,
    pool: basePool,
  });

  // Prefix cache hashes: un-salted vs HMAC-salted
  const prefixHashUnguardedHex = computeUnsaltedPrefixCacheHash(SHARED_SYSTEM_PREFIX_TOKENS);
  const prefixHashSaltedHex = computeSaltedPrefixCacheHash(SHARED_SYSTEM_PREFIX_TOKENS, authority);
  const foreignPrefixHashUnguardedHex = computeUnsaltedPrefixCacheHash(SHARED_SYSTEM_PREFIX_TOKENS);
  const foreignPrefixHashSaltedHex = computeSaltedPrefixCacheHash(SHARED_SYSTEM_PREFIX_TOKENS, {
    tenantId: foreignFixture.tenantId,
    requestScopeTag: foreignScope,
    policyEpoch: foreignFixture.initialPolicyEpoch,
  });

  // Mode 1: Contaminated block_table
  const mode1Unguarded = runReferencePagedAttention({
    query,
    blockTable: contaminatedTable,
    validityMask: contaminatedValidity,
    requestScopeTag: ownScope,
    enforceScopeMask: false,
    pool: basePool,
  });
  const mode1Governed = runReferencePagedAttention({
    query,
    blockTable: contaminatedTable,
    validityMask: contaminatedValidity,
    requestScopeTag: ownScope,
    enforceScopeMask: true,
    pool: basePool,
  });
  const mode1Delta = maxAbsDiff(mode1Governed.output, cleanTwin.output);

  // Mode 2: Prefix-cache hash collision (un-salted hit vs HMAC-salted separation)
  const unsaltedCollided = prefixHashUnguardedHex === foreignPrefixHashUnguardedHex;
  const saltedSeparated = prefixHashSaltedHex !== foreignPrefixHashSaltedHex;
  if (!unsaltedCollided || !saltedSeparated) {
    throw new Error('Prefix cache salting invariant failed.');
  }

  const mode2UnguardedTable = unsaltedCollided ? contaminatedTable : cleanTable;
  const mode2UnguardedValidity = unsaltedCollided ? contaminatedValidity : cleanValidity;
  const mode2Unguarded = runReferencePagedAttention({
    query,
    blockTable: mode2UnguardedTable,
    validityMask: mode2UnguardedValidity,
    requestScopeTag: ownScope,
    enforceScopeMask: false,
    pool: basePool,
  });

  const mode2GovernedTable = saltedSeparated ? cleanTable : contaminatedTable;
  const mode2GovernedValidity = saltedSeparated ? cleanValidity : contaminatedValidity;
  const mode2Governed = runReferencePagedAttention({
    query,
    blockTable: mode2GovernedTable,
    validityMask: mode2GovernedValidity,
    requestScopeTag: ownScope,
    enforceScopeMask: true,
    pool: basePool,
  });
  const mode2Delta = maxAbsDiff(mode2Governed.output, cleanTwin.output);

  // Mode 3: Stale allocation generation (ABA free at gen 4, reassigned at gen 5 without HBM zeroing)
  // Physical block #1 now carries ownScope at active generation 5, while stale descriptor expects gen 4!
  const staleInstrumented = createProxyInstrumentedKvPool({
    blockSize: 2,
    headDim: 4,
    keys: rawKeys,
    values: rawValues,
    blockScopeTags: [ownScope, ownScope, ownScope, ownScope],
    blockGenerations: [2, 5, 3, 6],
  });
  const staleExpectedGenerations = [2, 4, 3, 6];

  const mode3Unguarded = runOnlineTiledFlashAttention({
    query,
    blockTable: contaminatedTable,
    expectedGenerations: staleExpectedGenerations,
    validityMask: contaminatedValidity,
    requestScopeTag: ownScope,
    enforceHeaderGuard: false,
    instrumented: staleInstrumented,
  });
  const mode3Governed = runOnlineTiledFlashAttention({
    query,
    blockTable: contaminatedTable,
    expectedGenerations: staleExpectedGenerations,
    validityMask: contaminatedValidity,
    requestScopeTag: ownScope,
    enforceHeaderGuard: true,
    instrumented: staleInstrumented,
  });
  const mode3StaleBlockReads = staleInstrumented.getScalarReadsForBlock(1);
  const mode3StaleBlockTouches = staleInstrumented.getTouchesForBlock(1);
  const mode3Delta = maxAbsDiff(mode3Governed.finalOutput, cleanTwin.output);

  // Mode 4: Online tiled FlashAttention-2 (m_i, l_i, O_i) recurrence over Proxy-instrumented pool
  const foreignInstrumented = createProxyInstrumentedKvPool({
    blockSize: 2,
    headDim: 4,
    keys: rawKeys,
    values: rawValues,
    blockScopeTags: [ownScope, foreignScope, ownScope, ownScope],
    blockGenerations: [2, 4, 3, 6],
  });
  const foreignExpectedGenerations = [2, 4, 3, 6];

  const mode4Unguarded = runOnlineTiledFlashAttention({
    query,
    blockTable: contaminatedTable,
    expectedGenerations: foreignExpectedGenerations,
    validityMask: contaminatedValidity,
    requestScopeTag: ownScope,
    enforceHeaderGuard: false,
    instrumented: foreignInstrumented,
  });
  const mode4Governed = runOnlineTiledFlashAttention({
    query,
    blockTable: contaminatedTable,
    expectedGenerations: foreignExpectedGenerations,
    validityMask: contaminatedValidity,
    requestScopeTag: ownScope,
    enforceHeaderGuard: true,
    instrumented: foreignInstrumented,
  });
  const mode4ForeignBlockReads = foreignInstrumented.getScalarReadsForBlock(1);
  const mode4ForeignBlockTouches = foreignInstrumented.getTouchesForBlock(1);
  const mode4Delta = maxAbsDiff(mode4Governed.finalOutput, cleanTwin.output);

  const zeroForeignKvReadsVerified =
    mode4ForeignBlockReads === 0 &&
    mode4ForeignBlockTouches === 0 &&
    mode4Governed.unauthorizedScalarReads === 0 &&
    mode4Governed.unauthorizedBlockTouches === 0 &&
    mode4Governed.steps[1]?.kvTensorReadsPerformed === 0 &&
    mode3StaleBlockReads === 0 &&
    mode3StaleBlockTouches === 0 &&
    mode3Governed.unauthorizedScalarReads === 0 &&
    mode3Governed.unauthorizedBlockTouches === 0 &&
    mode3Governed.steps[1]?.kvTensorReadsPerformed === 0;

  const kvModes: readonly KvLifecycleModeEvidence[] = Object.freeze([
    Object.freeze({
      modeId: 'contaminated_block_table',
      title: 'Contaminated PagedAttention block_table',
      engineSurface: 'vLLM PagedAttention block_table[seq_id] -> physical HBM block IDs',
      defectMechanism:
        'Post-IAM scheduler or block-table indexing defect maps foreign physical block #1 into the active 4-block sequence table.',
      vervainControl:
        'Pre-softmax block scope-tag comparison masks physical block #1 to -Infinity before exponential normalization.',
      unguardedOutcomeSummary: `Unguarded attention assigns ${(mode1Unguarded.perBlockMass[1] ?? 0).toFixed(4)} softmax mass to foreign physical block #1, shifting the output vector.`,
      governedOutcomeSummary: `Scope-masked attention assigns 0.0000 mass to foreign block #1 and matches the clean 3-block twin within ${mode1Delta.toExponential(2)}.`,
      unguardedForeignMass: Number((mode1Unguarded.perBlockMass[1] ?? 0).toFixed(6)),
      governedForeignMass: mode1Governed.perBlockMass[1] ?? 0,
      prefixHashUnguardedHex,
      prefixHashSaltedHex,
      maxOutputDeltaVsCleanTwin: mode1Delta,
    }),
    Object.freeze({
      modeId: 'prefix_cache_hash_collision',
      title: 'Un-salted APC / Radix Prefix Hash Collision',
      engineSurface: 'Automatic Prefix Caching (APC) & RadixAttention token-sequence hash lookup',
      defectMechanism:
        'Shared system instruction tokens produce an identical SHA-256 prefix digest across tenants and policy epochs when cache keys omit authority salt.',
      vervainControl:
        'HMAC-SHA256 cache_salt binds server-owned (tenantId, requestScopeTag, policyEpoch) into every prefix lookup key.',
      unguardedOutcomeSummary: `Un-salted digest ${prefixHashUnguardedHex.slice(0, 12)}... collides across Alder and Beacon, reusing foreign cached block #1 (${(mode2Unguarded.perBlockMass[1] ?? 0).toFixed(4)} foreign mass).`,
      governedOutcomeSummary: `Salted digest ${prefixHashSaltedHex.slice(0, 12)}... separates tenants and epochs, preventing cross-scope prefix reuse (0 foreign mass).`,
      unguardedForeignMass: Number((mode2Unguarded.perBlockMass[1] ?? 0).toFixed(6)),
      governedForeignMass: 0,
      prefixHashUnguardedHex,
      prefixHashSaltedHex,
      maxOutputDeltaVsCleanTwin: mode2Delta,
    }),
    Object.freeze({
      modeId: 'stale_allocation_generation',
      title: 'ABA Block Reuse & Stale Allocation Generation',
      engineSurface: 'Free-list physical KV block allocator without HBM byte zeroization',
      defectMechanism:
        'Physical block #1 is freed at generation 4 and reassigned at generation 5 without clearing residual KV vectors while a stale descriptor still cites generation 4.',
      vervainControl:
        'Monotonic (scopeTag, allocationGeneration) header check rejects stale generation 4 != 5 prior to any KV tensor slice access.',
      unguardedOutcomeSummary: `Allocator index lookup ignores generation 4 != 5 and reads residual HBM vectors (${(mode3Unguarded.perSlotMass[1] ?? 0).toFixed(4)} stale-block mass).`,
      governedOutcomeSummary: `Header guard skips stale generation 4 != 5 on physical block #1 with ${mode3StaleBlockReads} KV scalar reads and ${mode3Delta.toExponential(2)} delta vs clean twin.`,
      unguardedForeignMass: Number((mode3Unguarded.perSlotMass[1] ?? 0).toFixed(6)),
      governedForeignMass: mode3Governed.perSlotMass[1] ?? 0,
      prefixHashUnguardedHex,
      prefixHashSaltedHex,
      maxOutputDeltaVsCleanTwin: mode3Delta,
    }),
    Object.freeze({
      modeId: 'online_tiled_flash_recurrence',
      title: 'Online Tiled FlashAttention-2 (m_i, l_i, O_i) Skip',
      engineSurface: 'Tiled streaming FlashAttention-2 (m_i, l_i, O_i) accumulator loop',
      defectMechanism:
        'Naive post-load masking still streams foreign K and V tiles into SRAM before zeroing scores; unguarded recurrence folds foreign tile #1 into running (m_i, l_i, O_i).',
      vervainControl:
        'Pre-tile header check skips unauthorized physical block #1 before K/V tile load, leaving running (m_i, l_i, O_i) untouched with 0 KV element reads.',
      unguardedOutcomeSummary: `Unguarded recurrence loads foreign tile #1 (16 scalar reads), assigning ${(mode4Unguarded.perSlotMass[1] ?? 0).toFixed(4)} mass to foreign values.`,
      governedOutcomeSummary: `Proxy-verified tile loop skips foreign block #1 with ${mode4ForeignBlockReads} KV scalar reads and converges to clean twin within ${mode4Delta.toExponential(2)}.`,
      unguardedForeignMass: Number((mode4Unguarded.perSlotMass[1] ?? 0).toFixed(6)),
      governedForeignMass: mode4Governed.perSlotMass[1] ?? 0,
      prefixHashUnguardedHex,
      prefixHashSaltedHex,
      maxOutputDeltaVsCleanTwin: mode4Delta,
    }),
  ]);

  return Object.freeze({
    kvModes,
    onlineTileSteps: mode4Governed.steps,
    engineProfiles: OPEN_WEIGHT_ENGINE_PROFILES,
    zeroForeignKvReadsVerified,
  });
}
