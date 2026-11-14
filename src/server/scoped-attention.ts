/**
 * Responsibility: Executable mathematical reference proof for Scoped Attention over a tiny
 * paged KV block table with a separate scope-tag side array and pre-softmax scope masking.
 * Trust boundary: Request scope tag is derived strictly from server-owned session authority.
 * Reference algorithm evidence only; not integrated with Gemini internals or production vLLM.
 */

import { SCOPED_ATTENTION_LIMITATION_LABEL } from '../shared/config.js';
import type {
  ScopedAttentionProofView,
  ScopedBlockEvidence,
} from '../shared/contracts.js';
import { TENANT_FIXTURES } from './fixture.js';
import type { ServerAuthoritySnapshot } from './session.js';

export interface PagedKvPhysicalPool {
  readonly blockSize: number;
  readonly headDim: number;
  /** Shape: [numPhysicalBlocks][blockSize][headDim] */
  readonly keys: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>;
  /** Shape: [numPhysicalBlocks][blockSize][headDim] */
  readonly values: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>;
  /** Side metadata array: 32-bit unsigned scope tag per physical block id */
  readonly blockScopeTags: ReadonlyArray<number>;
  readonly blockLabels?: ReadonlyArray<string>;
}

export interface ScopedAttentionInput {
  readonly query: ReadonlyArray<number>;
  readonly blockTable: ReadonlyArray<number>;
  /** Per logical-block per-slot ordinary token validity (e.g. causal / filled-slot mask) */
  readonly validityMask: ReadonlyArray<ReadonlyArray<boolean>>;
  readonly requestScopeTag: number;
  readonly enforceScopeMask: boolean;
  readonly pool: PagedKvPhysicalPool;
}

export type ScopedAttentionStatus =
  | 'ok'
  | 'refused_all_masked'
  | 'failed_closed_invalid_block_id'
  | 'failed_closed_invalid_input';

export interface ScopedAttentionRunResult {
  readonly status: ScopedAttentionStatus;
  readonly scaleFactor: number;
  readonly rawScores: ReadonlyArray<number>;
  readonly activeMask: ReadonlyArray<boolean>;
  readonly weights: ReadonlyArray<number>;
  readonly output: ReadonlyArray<number>;
  readonly mismatchCount: number;
  readonly perBlockMass: ReadonlyArray<number>;
}

function isFiniteVector(vec: ReadonlyArray<number>, expectedLen: number): boolean {
  if (vec.length !== expectedLen) return false;
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}

function isValidUint32Tag(tag: unknown): tag is number {
  return typeof tag === 'number' && Number.isInteger(tag) && tag >= 0 && tag <= 0xffffffff;
}

function normalizeZero(v: number): number {
  return Object.is(v, -0) ? 0 : v;
}

export function formatScopeHex(tag: number): string {
  return `0x${(tag >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Executes scaled dot-product attention over a paged KV block table:
 *   scores = (Q @ K^T) / sqrt(d)
 *   combined_mask = ordinary_validity_mask AND (enforceScopeMask ? (block_scope == request_scope) : true)
 *   masked_scores = where(combined_mask, scores, -Infinity)
 *   weights = stable_softmax(masked_scores)
 *   output = weights @ V
 *
 * Fails closed without NaN/Infinity on out-of-range block IDs, non-finite inputs, or all-masked rows.
 */
export function runReferencePagedAttention(input: ScopedAttentionInput): ScopedAttentionRunResult {
  const { query, blockTable, validityMask, requestScopeTag, enforceScopeMask, pool } = input;
  const d = pool.headDim;
  const blockSize = pool.blockSize;
  const numPhysical = pool.keys.length;
  const safeDim = typeof d === 'number' && Number.isInteger(d) && d > 0 && d <= 4096 ? d : 0;

  if (
    safeDim === 0 ||
    !Number.isInteger(blockSize) ||
    blockSize <= 0 ||
    blockSize > 4096 ||
    !isValidUint32Tag(requestScopeTag) ||
    pool.values.length !== numPhysical ||
    pool.blockScopeTags.length !== numPhysical ||
    !pool.blockScopeTags.every(isValidUint32Tag) ||
    !isFiniteVector(query, safeDim) ||
    validityMask.length !== blockTable.length
  ) {
    return Object.freeze({
      status: 'failed_closed_invalid_input',
      scaleFactor: safeDim > 0 ? 1 / Math.sqrt(safeDim) : 0,
      rawScores: [],
      activeMask: [],
      weights: [],
      output: Object.freeze(new Array<number>(safeDim).fill(0)),
      mismatchCount: 0,
      perBlockMass: [],
    });
  }

  const scaleFactor = 1 / Math.sqrt(d);

  // Validate all physical block IDs and pool entries up front (fail-closed bounds check)
  for (let bIdx = 0; bIdx < blockTable.length; bIdx += 1) {
    const physId = blockTable[bIdx];
    const slotValidity = validityMask[bIdx];
    if (
      typeof physId !== 'number' ||
      !Number.isInteger(physId) ||
      physId < 0 ||
      physId >= numPhysical ||
      !slotValidity ||
      slotValidity.length !== blockSize
    ) {
      return Object.freeze({
        status: 'failed_closed_invalid_block_id',
        scaleFactor,
        rawScores: [],
        activeMask: [],
        weights: [],
        output: new Array<number>(d).fill(0),
        mismatchCount: 0,
        perBlockMass: new Array<number>(blockTable.length).fill(0),
      });
    }

    const kBlock = pool.keys[physId];
    const vBlock = pool.values[physId];
    const tag = pool.blockScopeTags[physId];
    if (
      !kBlock ||
      !vBlock ||
      kBlock.length !== blockSize ||
      vBlock.length !== blockSize ||
      typeof tag !== 'number' ||
      !Number.isInteger(tag)
    ) {
      return Object.freeze({
        status: 'failed_closed_invalid_input',
        scaleFactor,
        rawScores: [],
        activeMask: [],
        weights: [],
        output: new Array<number>(d).fill(0),
        mismatchCount: 0,
        perBlockMass: new Array<number>(blockTable.length).fill(0),
      });
    }

    for (let s = 0; s < blockSize; s += 1) {
      if (!isFiniteVector(kBlock[s] ?? [], d) || !isFiniteVector(vBlock[s] ?? [], d)) {
        return Object.freeze({
          status: 'failed_closed_invalid_input',
          scaleFactor,
          rawScores: [],
          activeMask: [],
          weights: [],
          output: new Array<number>(d).fill(0),
          mismatchCount: 0,
          perBlockMass: new Array<number>(blockTable.length).fill(0),
        });
      }
    }
  }

  if (blockTable.length === 0) {
    return Object.freeze({
      status: 'refused_all_masked',
      scaleFactor,
      rawScores: [],
      activeMask: [],
      weights: [],
      output: new Array<number>(d).fill(0),
      mismatchCount: 0,
      perBlockMass: [],
    });
  }

  const rawScores: number[] = [];
  const activeMask: boolean[] = [];
  const tokenValues: ReadonlyArray<number>[] = [];
  let mismatchCount = 0;

  for (let bIdx = 0; bIdx < blockTable.length; bIdx += 1) {
    const physId = blockTable[bIdx]!;
    const blockScope = pool.blockScopeTags[physId]! >>> 0;
    const reqScope = requestScopeTag >>> 0;
    const scopeMatches = blockScope === reqScope;
    const kBlock = pool.keys[physId]!;
    const vBlock = pool.values[physId]!;
    const slotMask = validityMask[bIdx]!;

    // Count block-level scope mismatch when block contains at least one valid token slot
    const hasAnyValidToken = slotMask.some(Boolean);
    if (enforceScopeMask && hasAnyValidToken && !scopeMatches) {
      mismatchCount += 1;
    }

    for (let s = 0; s < blockSize; s += 1) {
      const kVec = kBlock[s]!;
      const vVec = vBlock[s]!;
      let dot = 0;
      for (let dim = 0; dim < d; dim += 1) {
        dot += query[dim]! * kVec[dim]!;
      }
      const scaledScore = dot * scaleFactor;
      const ordinaryValid = Boolean(slotMask[s]);
      const combinedAllowed = ordinaryValid && (enforceScopeMask ? scopeMatches : true);

      rawScores.push(scaledScore);
      activeMask.push(combinedAllowed);
      tokenValues.push(vVec);
    }
  }

  // Max-shifted numerically stable softmax strictly over unmasked positions
  let maxActiveScore = -Infinity;
  let activeCount = 0;
  for (let i = 0; i < rawScores.length; i += 1) {
    if (activeMask[i]) {
      activeCount += 1;
      if (rawScores[i]! > maxActiveScore) {
        maxActiveScore = rawScores[i]!;
      }
    }
  }

  if (activeCount === 0 || !Number.isFinite(maxActiveScore)) {
    return Object.freeze({
      status: 'refused_all_masked',
      scaleFactor,
      rawScores: Object.freeze(rawScores),
      activeMask: Object.freeze(activeMask),
      weights: Object.freeze(new Array<number>(rawScores.length).fill(0)),
      output: Object.freeze(new Array<number>(d).fill(0)),
      mismatchCount,
      perBlockMass: Object.freeze(new Array<number>(blockTable.length).fill(0)),
    });
  }

  const unnormalized = new Array<number>(rawScores.length).fill(0);
  let sumExp = 0;
  for (let i = 0; i < rawScores.length; i += 1) {
    if (activeMask[i]) {
      const e = Math.exp(rawScores[i]! - maxActiveScore);
      unnormalized[i] = e;
      sumExp += e;
    }
  }

  if (!Number.isFinite(sumExp) || sumExp <= 0) {
    return Object.freeze({
      status: 'refused_all_masked',
      scaleFactor,
      rawScores: Object.freeze(rawScores),
      activeMask: Object.freeze(activeMask),
      weights: Object.freeze(new Array<number>(rawScores.length).fill(0)),
      output: Object.freeze(new Array<number>(d).fill(0)),
      mismatchCount,
      perBlockMass: Object.freeze(new Array<number>(blockTable.length).fill(0)),
    });
  }

  const weights = unnormalized.map((u, idx) =>
    activeMask[idx] ? normalizeZero(u / sumExp) : 0,
  );

  const output = new Array<number>(d).fill(0);
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i]!;
    if (w === 0) continue;
    const vVec = tokenValues[i]!;
    for (let dim = 0; dim < d; dim += 1) {
      output[dim]! = normalizeZero(output[dim]! + w * vVec[dim]!);
    }
  }

  const perBlockMass: number[] = [];
  for (let bIdx = 0; bIdx < blockTable.length; bIdx += 1) {
    let mass = 0;
    for (let s = 0; s < blockSize; s += 1) {
      mass += weights[bIdx * blockSize + s]!;
    }
    perBlockMass.push(mass);
  }

  return Object.freeze({
    status: 'ok',
    scaleFactor,
    rawScores: Object.freeze(rawScores),
    activeMask: Object.freeze(activeMask),
    weights: Object.freeze(weights),
    output: Object.freeze(output),
    mismatchCount,
    perBlockMass: Object.freeze(perBlockMass),
  });
}

function l2Distance(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let sumSq = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq);
}

function maxAbsDiff(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let max = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (diff > max) max = diff;
  }
  return max;
}

function roundVec(vec: ReadonlyArray<number>, digits = 6): readonly number[] {
  const factor = Math.pow(10, digits);
  return Object.freeze(vec.map((v) => normalizeZero(Math.round(v * factor) / factor)));
}

/**
 * Builds the deterministic 4-block Scoped Attention Lab proof bound to the caller's
 * server-owned `ServerAuthoritySnapshot` (never client-supplied scope).
 */
export function buildScopedAttentionProofForSession(
  authority: Pick<ServerAuthoritySnapshot, 'persona' | 'tenantLabel' | 'requestScopeTag'>,
): ScopedAttentionProofView {
  const ownScope = authority.requestScopeTag >>> 0;
  const foreignScope =
    authority.persona === 'alder'
      ? TENANT_FIXTURES.beacon.requestScopeTag >>> 0
      : TENANT_FIXTURES.alder.requestScopeTag >>> 0;
  const foreignLabel = authority.persona === 'alder' ? 'Tenant Beacon' : 'Tenant Alder';

  // Tiny inspectable pool: 4 physical blocks, block_size = 2 tokens, d = 4
  const pool: PagedKvPhysicalPool = {
    blockSize: 2,
    headDim: 4,
    keys: [
      // Physical block 0: Allowed block A (2 valid tokens)
      [
        [1.1, 0.4, -0.2, 0.5],
        [0.8, 0.6, 0.1, 0.3],
      ],
      // Physical block 1: Foreign-tenant block injected by buggy block table (high dot product!)
      [
        [1.6, 0.9, 0.3, 0.8],
        [1.3, 0.7, 0.2, 0.6],
      ],
      // Physical block 2: Allowed block B (2 valid tokens)
      [
        [0.5, 0.9, -0.1, 0.4],
        [0.3, 0.4, 0.5, -0.2],
      ],
      // Physical block 3: Partially filled allowed tail block (slot 0 valid, slot 1 unused/causal-masked)
      [
        [0.7, 0.2, 0.4, 0.5],
        [2.2, 2.2, 2.2, 2.2],
      ],
    ],
    values: [
      // Physical block 0 values (authorized commercial signal)
      [
        [0.4, 0.1, 0.8, 0.2],
        [0.3, 0.2, 0.7, 0.1],
      ],
      // Physical block 1 values (distinctive foreign vector so output shifts noticeably if unmasked)
      [
        [-1.8, 2.4, -1.5, 1.9],
        [-1.6, 2.1, -1.3, 1.7],
      ],
      // Physical block 2 values (authorized commercial signal)
      [
        [0.5, 0.3, 0.6, 0.2],
        [0.2, 0.4, 0.5, 0.3],
      ],
      // Physical block 3 values (tail token + unused slot)
      [
        [0.35, 0.25, 0.65, 0.15],
        [9.0, -9.0, 9.0, -9.0],
      ],
    ],
    blockScopeTags: [ownScope, foreignScope, ownScope, ownScope],
    blockLabels: [
      `${authority.tenantLabel} KV block #0 (authorized prefix)`,
      `${foreignLabel} KV block #1 (foreign-scope block)`,
      `${authority.tenantLabel} KV block #2 (authorized body)`,
      `${authority.tenantLabel} KV block #3 (tail: 1/2 slots filled)`,
    ],
  };

  const query = [1.0, 0.6, 0.1, 0.5];
  const contaminatedTable = [0, 1, 2, 3];
  const contaminatedValidity = [
    [true, true],
    [true, true],
    [true, true],
    [true, false],
  ];

  // 1. Baseline (without scope mask) over contaminated 4-block table
  const baseline = runReferencePagedAttention({
    query,
    blockTable: contaminatedTable,
    validityMask: contaminatedValidity,
    requestScopeTag: ownScope,
    enforceScopeMask: false,
    pool,
  });

  // 2. Scoped (with pre-softmax scope mask) over the exact same contaminated 4-block table
  const scoped = runReferencePagedAttention({
    query,
    blockTable: contaminatedTable,
    validityMask: contaminatedValidity,
    requestScopeTag: ownScope,
    enforceScopeMask: true,
    pool,
  });

  // 3. Clean allowed-only twin (blocks [0, 2, 3]) without and with scope mask
  const cleanTable = [0, 2, 3];
  const cleanValidity = [
    [true, true],
    [true, true],
    [true, false],
  ];
  const cleanBaseline = runReferencePagedAttention({
    query,
    blockTable: cleanTable,
    validityMask: cleanValidity,
    requestScopeTag: ownScope,
    enforceScopeMask: false,
    pool,
  });
  const cleanScoped = runReferencePagedAttention({
    query,
    blockTable: cleanTable,
    validityMask: cleanValidity,
    requestScopeTag: ownScope,
    enforceScopeMask: true,
    pool,
  });

  // 4. Fail-closed edge controls: all-masked row and out-of-range block ID
  const allMasked = runReferencePagedAttention({
    query,
    blockTable: [1],
    validityMask: [[true, true]],
    requestScopeTag: ownScope,
    enforceScopeMask: true,
    pool,
  });
  const invalidBlock = runReferencePagedAttention({
    query,
    blockTable: [0, 99],
    validityMask: [
      [true, true],
      [true, true],
    ],
    requestScopeTag: ownScope,
    enforceScopeMask: true,
    pool,
  });

  if (
    allMasked.status !== 'refused_all_masked' ||
    allMasked.output.some((v) => !Number.isFinite(v))
  ) {
    throw new Error('Scoped attention all-masked control failed invariant.');
  }
  if (invalidBlock.status !== 'failed_closed_invalid_block_id') {
    throw new Error('Scoped attention invalid-block control failed invariant.');
  }

  const blocks: ScopedBlockEvidence[] = contaminatedTable.map((physId, slotIdx) => {
    const startPos = slotIdx * pool.blockSize;
    const tag = pool.blockScopeTags[physId]! >>> 0;
    const matches = tag === ownScope;
    const validFlags = contaminatedValidity[slotIdx]!;
    return Object.freeze({
      logicalSlot: slotIdx,
      physicalBlockId: physId,
      blockLabel: pool.blockLabels?.[physId] ?? `Block ${physId}`,
      scopeTagHex: formatScopeHex(tag),
      scopeMatchesRequest: matches,
      tokenPositions: [startPos, startPos + 1],
      validTokenFlags: [...validFlags],
      rawScores: roundVec(baseline.rawScores.slice(startPos, startPos + 2), 4),
      baselineWeights: roundVec(baseline.weights.slice(startPos, startPos + 2), 6),
      scopedWeights: roundVec(scoped.weights.slice(startPos, startPos + 2), 6),
      baselineBlockMass: Number((baseline.perBlockMass[slotIdx] ?? 0).toFixed(6)),
      scopedBlockMass: Number((scoped.perBlockMass[slotIdx] ?? 0).toFixed(6)),
      maskDisposition: !matches
        ? 'masked_scope_mismatch'
        : validFlags.every(Boolean)
          ? 'admitted_to_softmax'
          : validFlags.some(Boolean)
            ? 'admitted_partial_tail'
            : 'masked_invalid_slot',
    });
  });

  const foreignBlockMass = scoped.perBlockMass[1] ?? 0;

  return Object.freeze({
    limitationBanner: SCOPED_ATTENTION_LIMITATION_LABEL,
    requestScopeHex: formatScopeHex(ownScope),
    tenantContextLabel: authority.tenantLabel,
    vectorDim: pool.headDim,
    scaleFactor: baseline.scaleFactor,
    queryVector: query,
    blocks: Object.freeze(blocks),
    baselineOutput: roundVec(baseline.output, 6),
    scopedOutput: roundVec(scoped.output, 6),
    cleanAllowedTwinBaselineOutput: roundVec(cleanBaseline.output, 6),
    cleanAllowedTwinScopedOutput: roundVec(cleanScoped.output, 6),
    contaminatedVsScopedL2Delta: Number(l2Distance(baseline.output, scoped.output).toFixed(6)),
    cleanAllowedTwinMaxAbsDelta: maxAbsDiff(cleanBaseline.output, cleanScoped.output),
    foreignPostMaskMass: foreignBlockMass,
    mismatchCounter: scoped.mismatchCount,
    allMaskedControlStatus: 'refused_all_masked_zero_nan',
    invalidBlockControlStatus: 'failed_closed_invalid_block_id',
    computedAtIso: new Date().toISOString(),
  });
}
