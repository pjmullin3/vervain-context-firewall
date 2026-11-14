/**
 * Responsibility: Exhaustive mathematical, online block-tiled recurrence, property-based,
 * adversarial IEEE-754, and HTTP authority-boundary verification for Scoped Attention.
 * Limitation: Reference scoped-attention proof. Not integrated with Gemini internals or a production vLLM attention backend. No latency or isolation claim.
 */

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SCOPED_ATTENTION_LIMITATION_LABEL } from '../../src/shared/config.js';
import type { ScopedAttentionProofView } from '../../src/shared/contracts.js';
import { API_ERROR_CODES } from '../../src/shared/reason-codes.js';
import { createAppInstance, type AppInstance } from '../../src/server/app.js';
import { loadServerConfig } from '../../src/server/config.js';
import { TENANT_FIXTURES } from '../../src/server/fixture.js';
import { DeterministicMockGeminiTransport } from '../../src/server/gemini.js';
import {
  buildScopedAttentionProofForSession,
  formatScopeHex,
  runReferencePagedAttention,
  type PagedKvPhysicalPool,
  type ScopedAttentionInput,
  type ScopedAttentionStatus,
} from '../../src/server/scoped-attention.js';

interface OnlineTiledRunResult {
  readonly status: ScopedAttentionStatus;
  readonly output: ReadonlyArray<number>;
  readonly normalizedRunningOutput: ReadonlyArray<number>;
  readonly mismatchCount: number;
  readonly finalMaxLogit: number;
  readonly finalLogSumExpDenom: number;
  readonly loadedPhysicalBlocks: ReadonlyArray<number>;
}

/**
 * Deterministic 32-bit PRNG (mulberry32) for reproducible property-based sweeps.
 */
function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randUniform(rng: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

function randInt(rng: () => number, loInclusive: number, hiExclusive: number): number {
  return loInclusive + Math.floor(rng() * (hiExclusive - loInclusive));
}

function maxAbsError(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let maxErr = 0;
  for (let i = 0; i < a.length; i += 1) {
    const err = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    if (Number.isNaN(err)) return Number.NaN;
    if (err > maxErr) maxErr = err;
  }
  return maxErr;
}

function isFiniteVec(vec: ReadonlyArray<number>, expectedLen: number): boolean {
  if (vec.length !== expectedLen) return false;
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}

/**
 * Pure test-side reference of the online block-tiled log-sum-exp recurrence
 * maintaining running `(m, l, O)` state over physical blocks in `blockTable`.
 *
 * Key structural property:
 *   When `enforceScopeMask` is enabled and `blockScopeTags[physId] >>> 0 !== requestScopeTag >>> 0`
 *   (or when a logical block has zero valid slots in `validityMask`), the block is skipped at the
 *   metadata header BEFORE indexing `pool.keys[physId]` or `pool.values[physId]`.
 *
 * Tracks both:
 *   - `output`: unnormalized running accumulator `tildeO` divided once by `l` at epilogue
 *   - `normalizedRunningOutput`: per-tile normalized running `O` rescaled at each active tile
 */
function runOnlineBlockSkippingPagedAttention(input: ScopedAttentionInput): OnlineTiledRunResult {
  const { query, blockTable, validityMask, requestScopeTag, enforceScopeMask, pool } = input;
  const d = pool.headDim;
  const blockSize = pool.blockSize;
  const numPhysical = pool.keys.length;

  const safeDim = Number.isInteger(d) && d > 0 ? d : 0;

  if (
    !Number.isInteger(d) ||
    d <= 0 ||
    !Number.isInteger(blockSize) ||
    blockSize <= 0 ||
    !Number.isInteger(requestScopeTag) ||
    pool.values.length !== numPhysical ||
    pool.blockScopeTags.length !== numPhysical ||
    !isFiniteVec(query, d) ||
    validityMask.length !== blockTable.length
  ) {
    return {
      status: 'failed_closed_invalid_input',
      output: new Array<number>(safeDim).fill(0),
      normalizedRunningOutput: new Array<number>(safeDim).fill(0),
      mismatchCount: 0,
      finalMaxLogit: Number.NEGATIVE_INFINITY,
      finalLogSumExpDenom: 0,
      loadedPhysicalBlocks: [],
    };
  }

  // Header-only validation pass: inspects blockTable IDs, validityMask slot lengths, and side-array tags
  for (let bIdx = 0; bIdx < blockTable.length; bIdx += 1) {
    const physId = blockTable[bIdx];
    const slotMask = validityMask[bIdx];
    if (
      typeof physId !== 'number' ||
      !Number.isInteger(physId) ||
      physId < 0 ||
      physId >= numPhysical ||
      !slotMask ||
      slotMask.length !== blockSize
    ) {
      return {
        status: 'failed_closed_invalid_block_id',
        output: new Array<number>(d).fill(0),
        normalizedRunningOutput: new Array<number>(d).fill(0),
        mismatchCount: 0,
        finalMaxLogit: Number.NEGATIVE_INFINITY,
        finalLogSumExpDenom: 0,
        loadedPhysicalBlocks: [],
      };
    }
    const tag = pool.blockScopeTags[physId];
    if (typeof tag !== 'number' || !Number.isInteger(tag)) {
      return {
        status: 'failed_closed_invalid_input',
        output: new Array<number>(d).fill(0),
        normalizedRunningOutput: new Array<number>(d).fill(0),
        mismatchCount: 0,
        finalMaxLogit: Number.NEGATIVE_INFINITY,
        finalLogSumExpDenom: 0,
        loadedPhysicalBlocks: [],
      };
    }
  }

  if (blockTable.length === 0) {
    return {
      status: 'refused_all_masked',
      output: new Array<number>(d).fill(0),
      normalizedRunningOutput: new Array<number>(d).fill(0),
      mismatchCount: 0,
      finalMaxLogit: Number.NEGATIVE_INFINITY,
      finalLogSumExpDenom: 0,
      loadedPhysicalBlocks: [],
    };
  }

  const scaleFactor = 1 / Math.sqrt(d);
  const reqScope = requestScopeTag >>> 0;

  let m = Number.NEGATIVE_INFINITY;
  let l = 0;
  const tildeO = new Array<number>(d).fill(0);
  const normO = new Array<number>(d).fill(0);
  let mismatchCount = 0;
  const loadedPhysicalBlocks: number[] = [];

  for (let bIdx = 0; bIdx < blockTable.length; bIdx += 1) {
    const physId = blockTable[bIdx]!;
    const slotMask = validityMask[bIdx]!;
    const blockScope = pool.blockScopeTags[physId]! >>> 0;
    const scopeMatches = blockScope === reqScope;
    const hasAnyValidToken = slotMask.some(Boolean);

    if (enforceScopeMask && !scopeMatches) {
      if (hasAnyValidToken) {
        mismatchCount += 1;
      }
      // Header-level block skip: K_block and V_block are NOT read for mismatched scopes
      continue;
    }

    if (!hasAnyValidToken) {
      // Header-level block skip: zero valid slots in this logical block
      continue;
    }

    // Authorized block with >= 1 valid slot: load K_block and V_block
    loadedPhysicalBlocks.push(physId);
    const kBlock = pool.keys[physId];
    const vBlock = pool.values[physId];
    if (!kBlock || !vBlock || kBlock.length !== blockSize || vBlock.length !== blockSize) {
      return {
        status: 'failed_closed_invalid_input',
        output: new Array<number>(d).fill(0),
        normalizedRunningOutput: new Array<number>(d).fill(0),
        mismatchCount: 0,
        finalMaxLogit: Number.NEGATIVE_INFINITY,
        finalLogSumExpDenom: 0,
        loadedPhysicalBlocks,
      };
    }

    const tileScores = new Array<number>(blockSize).fill(Number.NEGATIVE_INFINITY);
    let mTile = Number.NEGATIVE_INFINITY;

    for (let s = 0; s < blockSize; s += 1) {
      const kVec = kBlock[s];
      const vVec = vBlock[s];
      if (!kVec || !vVec || !isFiniteVec(kVec, d) || !isFiniteVec(vVec, d)) {
        return {
          status: 'failed_closed_invalid_input',
          output: new Array<number>(d).fill(0),
          normalizedRunningOutput: new Array<number>(d).fill(0),
          mismatchCount: 0,
          finalMaxLogit: Number.NEGATIVE_INFINITY,
          finalLogSumExpDenom: 0,
          loadedPhysicalBlocks,
        };
      }
      if (!slotMask[s]) {
        continue;
      }
      let dot = 0;
      for (let dim = 0; dim < d; dim += 1) {
        dot += query[dim]! * kVec[dim]!;
      }
      const scaled = dot * scaleFactor;
      tileScores[s] = scaled;
      if (scaled > mTile) {
        mTile = scaled;
      }
    }

    if (!Number.isFinite(mTile)) {
      return {
        status: 'refused_all_masked',
        output: new Array<number>(d).fill(0),
        normalizedRunningOutput: new Array<number>(d).fill(0),
        mismatchCount,
        finalMaxLogit: mTile,
        finalLogSumExpDenom: 0,
        loadedPhysicalBlocks,
      };
    }

    const mNew = Math.max(m, mTile);
    const alpha = m === Number.NEGATIVE_INFINITY ? 0 : Math.exp(m - mNew);

    let lTile = 0;
    const tileWeightedV = new Array<number>(d).fill(0);
    for (let s = 0; s < blockSize; s += 1) {
      if (!slotMask[s]) continue;
      const p = Math.exp(tileScores[s]! - mNew);
      lTile += p;
      const vVec = vBlock[s]!;
      for (let dim = 0; dim < d; dim += 1) {
        tileWeightedV[dim]! += p * vVec[dim]!;
      }
    }

    const lNew = alpha * l + lTile;
    if (!Number.isFinite(lNew) || lNew <= 0) {
      return {
        status: 'refused_all_masked',
        output: new Array<number>(d).fill(0),
        normalizedRunningOutput: new Array<number>(d).fill(0),
        mismatchCount,
        finalMaxLogit: mNew,
        finalLogSumExpDenom: lNew,
        loadedPhysicalBlocks,
      };
    }

    const prevScale = (alpha * l) / lNew;
    const invLNew = 1 / lNew;
    for (let dim = 0; dim < d; dim += 1) {
      tildeO[dim] = alpha * tildeO[dim]! + tileWeightedV[dim]!;
      normO[dim] = prevScale * normO[dim]! + invLNew * tileWeightedV[dim]!;
    }

    m = mNew;
    l = lNew;
  }

  if (l <= 0 || !Number.isFinite(m) || !Number.isFinite(l)) {
    return {
      status: 'refused_all_masked',
      output: new Array<number>(d).fill(0),
      normalizedRunningOutput: new Array<number>(d).fill(0),
      mismatchCount,
      finalMaxLogit: m,
      finalLogSumExpDenom: l,
      loadedPhysicalBlocks,
    };
  }

  const output = tildeO.map((v) => v / l);
  return {
    status: 'ok',
    output,
    normalizedRunningOutput: normO,
    mismatchCount,
    finalMaxLogit: m,
    finalLogSumExpDenom: l,
    loadedPhysicalBlocks,
  };
}

/**
 * Wraps a physical KV pool in read-tracking ES Proxies so tests can assert that
 * skipped foreign-scope or zero-valid-slot blocks never trigger `keys[physId]` or `values[physId]` reads.
 */
function createReadTrackedPool(pool: PagedKvPhysicalPool): {
  trackedPool: PagedKvPhysicalPool;
  keyBlockReads: number[];
  valueBlockReads: number[];
} {
  const keyBlockReads: number[] = [];
  const valueBlockReads: number[] = [];

  const keysProxy = new Proxy(pool.keys, {
    get(target, prop, receiver): unknown {
      if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) {
        keyBlockReads.push(Number(prop));
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const valuesProxy = new Proxy(pool.values, {
    get(target, prop, receiver): unknown {
      if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) {
        valueBlockReads.push(Number(prop));
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return {
    trackedPool: {
      blockSize: pool.blockSize,
      headDim: pool.headDim,
      keys: keysProxy,
      values: valuesProxy,
      blockScopeTags: pool.blockScopeTags,
      blockLabels: pool.blockLabels,
    },
    keyBlockReads,
    valueBlockReads,
  };
}

let activeApp: AppInstance | null = null;

async function startEphemeralTestServer(): Promise<{ baseUrl: string; app: AppInstance }> {
  const config = loadServerConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'mock',
    SESSION_SECRET: 'exhaustive_scoped_attention_test_secret_32b',
    GEMINI_MODEL: 'gemini-2.5-flash',
  });
  const app = createAppInstance({
    config,
    transport: new DeterministicMockGeminiTransport(),
    sleepFn: async () => {},
    emitLogsToStdout: false,
  });
  activeApp = app;

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (app.server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, app };
}

afterEach(async () => {
  if (activeApp) {
    const srv = activeApp.server;
    activeApp = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

describe('Scoped Attention Exhaustive Mathematical Verification', () => {
  it('verifies exact scaled dot-product scores = (Q @ K^T) / sqrt(d), pre-softmax masking, and normalization', () => {
    const d = 6;
    const blockSize = 3;
    const ownScope = 0x00a1de07;
    const foreignScope = 0x00beac11;

    const pool: PagedKvPhysicalPool = {
      blockSize,
      headDim: d,
      keys: [
        [
          [1.2, -0.5, 0.7, 0.3, -1.1, 0.4],
          [0.3, 0.9, -0.2, 1.4, 0.1, -0.6],
          [-0.8, 0.2, 1.5, -0.4, 0.6, 0.9],
        ],
        // Foreign block with extreme positive keys that would dominate maxActiveScore if masked after max-shift
        [
          [8000, 8000, 8000, 8000, 8000, 8000],
          [7500, 7500, 7500, 7500, 7500, 7500],
          [9000, 9000, 9000, 9000, 9000, 9000],
        ],
        [
          [0.6, -0.1, 0.4, 0.8, -0.3, 1.1],
          [1.0, 0.5, -0.7, 0.2, 0.9, -0.2],
          [5000, 5000, 5000, 5000, 5000, 5000], // invalid tail slot inside authorized block
        ],
      ],
      values: [
        [
          [0.2, 0.4, -0.1, 0.7, 0.3, -0.5],
          [-0.3, 0.8, 0.5, -0.2, 0.6, 0.1],
          [0.9, -0.4, 0.2, 0.3, -0.7, 0.8],
        ],
        [
          [-999, 999, -999, 999, -999, 999],
          [-888, 888, -888, 888, -888, 888],
          [-777, 777, -777, 777, -777, 777],
        ],
        [
          [0.5, 0.1, 0.6, -0.4, 0.2, 0.3],
          [-0.1, 0.7, -0.3, 0.5, 0.4, -0.2],
          [444, -444, 444, -444, 444, -444],
        ],
      ],
      blockScopeTags: [ownScope, foreignScope, ownScope],
    };

    const query = [0.7, 0.4, 0.5, 0.6, 0.3, 0.8];
    const blockTable = [0, 1, 2];
    const validityMask = [
      [true, true, true],
      [true, true, true],
      [true, true, false],
    ];

    const scoped = runReferencePagedAttention({
      query,
      blockTable,
      validityMask,
      requestScopeTag: ownScope,
      enforceScopeMask: true,
      pool,
    });

    const cleanAllowedTwin = runReferencePagedAttention({
      query,
      blockTable: [0, 2],
      validityMask: [
        [true, true, true],
        [true, true, false],
      ],
      requestScopeTag: ownScope,
      enforceScopeMask: false,
      pool,
    });

    expect(scoped.status).toBe('ok');
    expect(cleanAllowedTwin.status).toBe('ok');
    expect(Math.abs(scoped.scaleFactor - 1 / Math.sqrt(d))).toBeLessThanOrEqual(1e-15);

    // 1. Verify exact (Q @ K^T) / sqrt(d) equation at every logical slot:
    //    `scoped-attention.ts` computes `dot * (1 / Math.sqrt(d))` (exact match === 0), which
    //    agrees with `dot / Math.sqrt(d)` within 1 IEEE-754 float64 ULP (relative error <= 2 * EPSILON).
    for (let b = 0; b < blockTable.length; b += 1) {
      const physId = blockTable[b]!;
      for (let s = 0; s < blockSize; s += 1) {
        const kVec = pool.keys[physId]![s]!;
        let manualDot = 0;
        for (let dim = 0; dim < d; dim += 1) {
          manualDot += query[dim]! * kVec[dim]!;
        }
        const expectedMulScale = manualDot * (1 / Math.sqrt(d));
        const expectedDivSqrt = manualDot / Math.sqrt(d);
        const flatIdx = b * blockSize + s;
        expect(scoped.rawScores[flatIdx]).toBe(expectedMulScale);
        const relErr =
          Math.abs(scoped.rawScores[flatIdx]! - expectedDivSqrt) /
          Math.max(1, Math.abs(expectedDivSqrt));
        expect(relErr).toBeLessThanOrEqual(2 * Number.EPSILON);
        if (Math.abs(expectedDivSqrt) <= 100) {
          expect(Math.abs(scoped.rawScores[flatIdx]! - expectedDivSqrt)).toBeLessThanOrEqual(1e-12);
        }
      }
    }

    // 2. Verify combined mask applied BEFORE max-shifted softmax:
    // If maxActiveScore had included foreign block 1 (~12,125) or invalid slot [2][2] (~6,736),
    // authorized scores (~0.5) would underflow exp(0.5 - 12125) === 0 and refuse or distort output.
    expect(scoped.activeMask).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      true,
      true,
      false,
    ]);
    expect(scoped.mismatchCount).toBe(1);

    // Foreign post-mask mass and invalid-slot weight are exact 0
    expect(scoped.perBlockMass[1]).toBe(0);
    expect(scoped.weights[3]).toBe(0);
    expect(scoped.weights[4]).toBe(0);
    expect(scoped.weights[5]).toBe(0);
    expect(scoped.weights[8]).toBe(0);

    // Normalization sum(weights) == 1 within 1e-12
    const weightSum = scoped.weights.reduce((acc, w) => acc + w, 0);
    expect(Math.abs(weightSum - 1)).toBeLessThanOrEqual(1e-12);

    // Exact equivalence to clean allowed-only twin (blocks [0, 2] without foreign block)
    expect(maxAbsError(scoped.output, cleanAllowedTwin.output)).toBeLessThanOrEqual(1e-12);
  });

  it('verifies session proof invariants for both Alder and Beacon personas including exact limitation banner', () => {
    for (const fixture of [TENANT_FIXTURES.alder, TENANT_FIXTURES.beacon]) {
      const proof = buildScopedAttentionProofForSession(fixture);
      expect(proof.limitationBanner).toBe(
        'Reference scoped-attention proof. Not integrated with Gemini internals or a production vLLM attention backend. No latency or isolation claim.',
      );
      expect(proof.limitationBanner).toBe(SCOPED_ATTENTION_LIMITATION_LABEL);
      expect(proof.requestScopeHex).toBe(formatScopeHex(fixture.requestScopeTag));
      expect(proof.foreignPostMaskMass).toBe(0);
      expect(proof.mismatchCounter).toBe(1);
      expect(proof.cleanAllowedTwinMaxAbsDelta).toBeLessThanOrEqual(1e-12);
      expect(proof.contaminatedVsScopedL2Delta).toBeGreaterThan(1.0);
      expect(proof.allMaskedControlStatus).toBe('refused_all_masked_zero_nan');
      expect(proof.invalidBlockControlStatus).toBe('failed_closed_invalid_block_id');

      const scopedMassSum = proof.blocks.reduce((acc, b) => acc + b.scopedBlockMass, 0);
      expect(Math.abs(scopedMassSum - 1)).toBeLessThanOrEqual(1e-5); // rounded 6-digit view fields
      for (const blk of proof.blocks) {
        if (!blk.scopeMatchesRequest) {
          expect(blk.scopedBlockMass).toBe(0);
          expect(blk.scopedWeights.every((w) => w === 0)).toBe(true);
          expect(blk.maskDisposition).toBe('masked_scope_mismatch');
        }
      }
    }
  });
});

describe('Online Block-Tiled (m, l, O) Log-Sum-Exp Recurrence Equivalence', () => {
  it('matches runReferencePagedAttention within 1e-12 L-infinity across 80 seeded randomized paged block tables while skipping foreign KV block reads', () => {
    const rng = createMulberry32(0x5eedcafe);
    const dims = [1, 2, 3, 4, 8, 16, 32, 64, 128] as const;
    const blockSizes = [1, 2, 3, 4, 8, 16, 32] as const;
    const scopePalette = [
      0x00000000,
      0x00000001,
      0x00a1de07,
      0x00beac11,
      0x7fffffff,
      0x80000000,
      0x80000001,
      0xffffffff,
    ] as const;

    let okCount = 0;
    let refusedAllMaskedCount = 0;

    for (let trial = 0; trial < 80; trial += 1) {
      const d = dims[trial % dims.length]!;
      const blockSize = blockSizes[(trial * 3) % blockSizes.length]!;
      const numPhysical = randInt(rng, 2, 12);
      const tableLen = trial === 0 ? 0 : randInt(rng, 1, 16);
      const requestScopeTag = scopePalette[trial % scopePalette.length]!;

      // Select logit regime to cover moderate, wide [-1e4, +1e4], clustered +1e4, clustered -1e4,
      // and adversarial foreign-dominance (+1e4 foreign vs -1e4 own)
      const regime = trial % 5;

      const query: number[] = [];
      for (let dim = 0; dim < d; dim += 1) {
        query.push(dim === 0 ? 1.0 : randUniform(rng, -0.5, 0.5));
      }
      const qNormSq = query.reduce((acc, v) => acc + v * v, 0);
      const sqrtD = Math.sqrt(d);

      const blockScopeTags: number[] = [];
      const keys: number[][][] = [];
      const values: number[][][] = [];

      // Force roughly 20% of trials to have zero matching blocks in the pool
      const forceAllForeign = trial % 6 === 5;

      for (let p = 0; p < numPhysical; p += 1) {
        let tag: number;
        if (forceAllForeign) {
          tag = (requestScopeTag ^ 0x80000001) >>> 0;
        } else if (p === 0 && trial % 6 !== 4) {
          tag = requestScopeTag;
        } else {
          tag =
            rng() < 0.55
              ? requestScopeTag
              : scopePalette[randInt(rng, 0, scopePalette.length)]!;
        }
        blockScopeTags.push(tag);

        const isOwn = (tag >>> 0) === (requestScopeTag >>> 0);
        const kBlock: number[][] = [];
        const vBlock: number[][] = [];

        for (let s = 0; s < blockSize; s += 1) {
          // Construct kVec so (query @ kVec) / sqrt(d) lands in the target logit regime
          let targetScore: number;
          if (regime === 0) {
            targetScore = randUniform(rng, -6, 6);
          } else if (regime === 1) {
            targetScore = randUniform(rng, -1e4, 1e4);
          } else if (regime === 2) {
            targetScore = randUniform(rng, 9994, 10000);
          } else if (regime === 3) {
            targetScore = randUniform(rng, -10000, -9994);
          } else {
            // Regime 4: foreign blocks sit near +1e4 while authorized blocks sit near -1e4
            targetScore = isOwn
              ? randUniform(rng, -10000, -9995)
              : randUniform(rng, 9995, 10000);
          }

          // Choose kVec = alpha * query + perpNoise (approx), then exact-adjust kVec[0] for targetScore
          const baseScale = (targetScore * sqrtD) / qNormSq;
          const kVec: number[] = [];
          let partialDot = 0;
          for (let dim = 0; dim < d; dim += 1) {
            const val = baseScale * query[dim]! + randUniform(rng, -0.25, 0.25);
            kVec.push(val);
            if (dim > 0) {
              partialDot += query[dim]! * val;
            }
          }
          // Since query[0] === 1.0, set kVec[0] so (query @ kVec) / sqrt(d) === targetScore closely
          kVec[0] = targetScore * sqrtD - partialDot;
          kBlock.push(kVec);

          const vVec: number[] = [];
          for (let dim = 0; dim < d; dim += 1) {
            vVec.push(randUniform(rng, -4, 4));
          }
          vBlock.push(vVec);
        }

        keys.push(kBlock);
        values.push(vBlock);
      }

      // Build logical blockTable with repeated blocks, reordered blocks, partial tail masks, and empty blocks
      const blockTable: number[] = [];
      const validityMask: boolean[][] = [];
      const forceAllInvalidSlots = trial % 11 === 10;

      for (let b = 0; b < tableLen; b += 1) {
        // Occasionally repeat an earlier block ID to exercise shared/repeated physical blocks
        const physId =
          b > 1 && rng() < 0.35
            ? blockTable[randInt(rng, 0, b)]!
            : randInt(rng, 0, numPhysical);
        blockTable.push(physId);

        if (forceAllInvalidSlots || rng() < 0.15) {
          validityMask.push(new Array<boolean>(blockSize).fill(false));
        } else if (b === tableLen - 1 && blockSize > 1) {
          // Partial tail mask on final block
          const filled = randInt(rng, 1, blockSize);
          validityMask.push(
            Array.from({ length: blockSize }, (_, idx) => idx < filled),
          );
        } else {
          validityMask.push(
            Array.from({ length: blockSize }, () => rng() < 0.8),
          );
        }
      }

      const pool: PagedKvPhysicalPool = {
        blockSize,
        headDim: d,
        keys,
        values,
        blockScopeTags,
      };

      const reference = runReferencePagedAttention({
        query,
        blockTable,
        validityMask,
        requestScopeTag,
        enforceScopeMask: true,
        pool,
      });

      const { trackedPool, keyBlockReads, valueBlockReads } = createReadTrackedPool(pool);
      const online = runOnlineBlockSkippingPagedAttention({
        query,
        blockTable,
        validityMask,
        requestScopeTag,
        enforceScopeMask: true,
        pool: trackedPool,
      });

      expect(online.status).toBe(reference.status);
      expect(online.mismatchCount).toBe(reference.mismatchCount);
      expect(maxAbsError(online.output, reference.output)).toBeLessThanOrEqual(1e-12);
      expect(maxAbsError(online.normalizedRunningOutput, reference.output)).toBeLessThanOrEqual(
        1e-12,
      );

      // Verify zero foreign-scope KV block loads in the online block-skipping recurrence
      for (const loadedPhysId of keyBlockReads) {
        expect(pool.blockScopeTags[loadedPhysId]! >>> 0).toBe(requestScopeTag >>> 0);
      }
      for (const loadedPhysId of valueBlockReads) {
        expect(pool.blockScopeTags[loadedPhysId]! >>> 0).toBe(requestScopeTag >>> 0);
      }

      if (reference.status === 'ok') {
        okCount += 1;
        const sumWeights = reference.weights.reduce((acc, w) => acc + w, 0);
        expect(Math.abs(sumWeights - 1)).toBeLessThanOrEqual(1e-12);

        let foreignMass = 0;
        for (let b = 0; b < blockTable.length; b += 1) {
          const physId = blockTable[b]!;
          if ((pool.blockScopeTags[physId]! >>> 0) !== (requestScopeTag >>> 0)) {
            foreignMass += reference.perBlockMass[b]!;
          }
        }
        expect(foreignMass).toBe(0);
      } else {
        expect(reference.status).toBe('refused_all_masked');
        refusedAllMaskedCount += 1;
        expect(reference.output.every((v) => v === 0 && !Object.is(v, -0))).toBe(true);
        expect(online.output.every((v) => v === 0 && !Object.is(v, -0))).toBe(true);
      }
    }

    // Confirm both active and all-masked paths were thoroughly exercised across the 80 trials
    expect(okCount).toBeGreaterThanOrEqual(55);
    expect(refusedAllMaskedCount).toBeGreaterThanOrEqual(12);
  });

  it('preserves invariance under arbitrary block permutation when slots carry identical validity per block', () => {
    const pool: PagedKvPhysicalPool = {
      blockSize: 3,
      headDim: 8,
      keys: [
        [
          [1.1, -0.4, 0.2, 0.9, -0.5, 0.3, 0.7, -0.1],
          [0.4, 0.8, -0.6, 0.1, 0.5, -0.2, 0.3, 0.9],
          [-0.3, 0.2, 0.7, -0.8, 0.4, 0.6, -0.5, 0.2],
        ],
        // Foreign block
        [
          [500, 500, 500, 500, 500, 500, 500, 500],
          [600, 600, 600, 600, 600, 600, 600, 600],
          [700, 700, 700, 700, 700, 700, 700, 700],
        ],
        [
          [0.9, -0.1, 0.4, 0.3, 0.8, -0.7, 0.2, 0.5],
          [-0.6, 0.5, -0.2, 0.7, -0.3, 0.4, 0.8, -0.4],
          [0.2, -0.9, 0.5, 0.4, 0.1, 0.9, -0.3, 0.6],
        ],
        [
          [-0.2, 0.3, -0.4, 0.6, 0.7, -0.1, 0.5, -0.8],
          [0.7, -0.5, 0.9, -0.3, 0.2, 0.8, -0.6, 0.1],
          [999, 999, 999, 999, 999, 999, 999, 999],
        ],
      ],
      values: [
        [
          [0.3, -0.2, 0.5, 0.1, -0.4, 0.8, 0.2, -0.6],
          [0.7, 0.4, -0.1, 0.9, 0.2, -0.3, 0.6, 0.5],
          [-0.5, 0.6, 0.3, -0.2, 0.7, 0.1, -0.8, 0.4],
        ],
        [
          [-50, 50, -50, 50, -50, 50, -50, 50],
          [-60, 60, -60, 60, -60, 60, -60, 60],
          [-70, 70, -70, 70, -70, 70, -70, 70],
        ],
        [
          [0.1, 0.9, -0.4, 0.3, -0.6, 0.2, 0.7, -0.1],
          [-0.2, 0.3, 0.8, -0.5, 0.4, -0.7, 0.1, 0.9],
          [0.6, -0.8, 0.2, 0.7, -0.1, 0.5, -0.3, 0.2],
        ],
        [
          [0.4, -0.3, 0.6, -0.7, 0.5, 0.2, -0.4, 0.8],
          [-0.8, 0.7, -0.2, 0.4, -0.3, 0.6, 0.9, -0.5],
          [123, -123, 123, -123, 123, -123, 123, -123],
        ],
      ],
      blockScopeTags: [0x80000042, 0x00000042, 0x80000042, 0x80000042],
    };

    const query = [0.5, -0.3, 0.8, 0.2, -0.6, 0.4, 0.7, -0.1];
    const orderA = runOnlineBlockSkippingPagedAttention({
      query,
      blockTable: [0, 1, 2, 3, 0],
      validityMask: [
        [true, true, true],
        [true, true, true],
        [true, true, true],
        [true, true, false],
        [true, false, true],
      ],
      requestScopeTag: 0x80000042,
      enforceScopeMask: true,
      pool,
    });

    const orderB = runOnlineBlockSkippingPagedAttention({
      query,
      blockTable: [3, 0, 2, 1, 0],
      validityMask: [
        [true, true, false],
        [true, false, true],
        [true, true, true],
        [true, true, true],
        [true, true, true],
      ],
      requestScopeTag: 0x80000042,
      enforceScopeMask: true,
      pool,
    });

    expect(orderA.status).toBe('ok');
    expect(orderB.status).toBe('ok');
    expect(orderA.mismatchCount).toBe(1);
    expect(orderB.mismatchCount).toBe(1);
    expect(maxAbsError(orderA.output, orderB.output)).toBeLessThanOrEqual(1e-12);
  });
});

describe('Scoped Attention Adversarial IEEE-754, Uint32, and Bounds Edge Cases', () => {
  const basePool: PagedKvPhysicalPool = {
    blockSize: 2,
    headDim: 4,
    keys: [
      [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
      ],
      [
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    ],
    values: [
      [
        [0.25, 0.5, 0.75, 1.0],
        [1.0, 0.75, 0.5, 0.25],
      ],
      [
        [-5, 5, -5, 5],
        [-6, 6, -6, 6],
      ],
    ],
    blockScopeTags: [0x80000001, 0x00000001],
  };

  it('handles negative zero (-0) across query, keys, values, blockTable, and scope tags without producing -0 outputs', () => {
    const negZeroPool: PagedKvPhysicalPool = {
      blockSize: 2,
      headDim: 2,
      keys: [
        [
          [-0, -0],
          [0, -0],
        ],
      ],
      values: [
        [
          [-0, 0],
          [-0, -0],
        ],
      ],
      blockScopeTags: [-0],
    };

    expect(formatScopeHex(-0)).toBe('0x00000000');

    const res = runReferencePagedAttention({
      query: [-0, -0],
      blockTable: [-0],
      validityMask: [[true, true]],
      requestScopeTag: +0,
      enforceScopeMask: true,
      pool: negZeroPool,
    });

    expect(res.status).toBe('ok');
    expect(res.mismatchCount).toBe(0);
    expect(Math.abs(res.weights[0]! - 0.5)).toBeLessThanOrEqual(1e-15);
    expect(Math.abs(res.weights[1]! - 0.5)).toBeLessThanOrEqual(1e-15);
    for (const v of res.output) {
      expect(v).toBe(0);
      expect(Object.is(v, -0)).toBe(false);
    }
    for (const w of res.weights) {
      expect(Object.is(w, -0)).toBe(false);
    }
  });

  it('distinguishes high-bit uint32 scope tags (0x80000001 vs 0x00000001 and 0xffffffff vs 0x7fffffff)', () => {
    expect(formatScopeHex(0x80000001)).toBe('0x80000001');
    expect(formatScopeHex(0x00000001)).toBe('0x00000001');
    expect(formatScopeHex(0xffffffff)).toBe('0xffffffff');
    expect(formatScopeHex(0x7fffffff)).toBe('0x7fffffff');

    // Requesting high-bit 0x80000001 admits block 0 (0x80000001) and masks block 1 (0x00000001)
    const highBitRes = runReferencePagedAttention({
      query: [1, 1, 1, 1],
      blockTable: [0, 1],
      validityMask: [
        [true, true],
        [true, true],
      ],
      requestScopeTag: 0x80000001,
      enforceScopeMask: true,
      pool: basePool,
    });
    expect(highBitRes.status).toBe('ok');
    expect(highBitRes.mismatchCount).toBe(1);
    expect(highBitRes.perBlockMass[0]).toBeCloseTo(1, 12);
    expect(highBitRes.perBlockMass[1]).toBe(0);

    // Requesting low-bit 0x00000001 admits block 1 (0x00000001) and masks block 0 (0x80000001)
    const lowBitRes = runReferencePagedAttention({
      query: [1, 1, 1, 1],
      blockTable: [0, 1],
      validityMask: [
        [true, true],
        [true, true],
      ],
      requestScopeTag: 0x00000001,
      enforceScopeMask: true,
      pool: basePool,
    });
    expect(lowBitRes.status).toBe('ok');
    expect(lowBitRes.mismatchCount).toBe(1);
    expect(lowBitRes.perBlockMass[0]).toBe(0);
    expect(lowBitRes.perBlockMass[1]).toBeCloseTo(1, 12);

    // Verify boundary pair 0xffffffff vs 0x7fffffff refuses when only 0x7fffffff is present
    const maxUintPool: PagedKvPhysicalPool = {
      ...basePool,
      blockScopeTags: [0x7fffffff, 0x7fffffff],
    };
    const maxUintRes = runReferencePagedAttention({
      query: [1, 0, 0, 0],
      blockTable: [0, 1],
      validityMask: [
        [true, true],
        [true, true],
      ],
      requestScopeTag: 0xffffffff,
      enforceScopeMask: true,
      pool: maxUintPool,
    });
    expect(maxUintRes.status).toBe('refused_all_masked');
    expect(maxUintRes.mismatchCount).toBe(2);

    // Signed negative Int32 (-2147483647 === 0x80000001 | 0) fails closed unless explicitly unsigned (`>>> 0`)
    const signedNegativeRes = runReferencePagedAttention({
      query: [1, 1, 1, 1],
      blockTable: [0],
      validityMask: [[true, true]],
      requestScopeTag: 0x80000001 | 0,
      enforceScopeMask: true,
      pool: basePool,
    });
    expect(signedNegativeRes.status).toBe('failed_closed_invalid_input');

    const unsignedCoercedRes = runReferencePagedAttention({
      query: [1, 1, 1, 1],
      blockTable: [0],
      validityMask: [[true, true]],
      requestScopeTag: (0x80000001 | 0) >>> 0,
      enforceScopeMask: true,
      pool: basePool,
    });
    expect(unsignedCoercedRes.status).toBe('ok');
  });

  it('handles IEEE-754 subnormal floats cleanly without NaN or denormal division failure', () => {
    const minSubnormal = Number.MIN_VALUE; // ~5e-324
    const maxSubnormal = 2.2250738585072009e-308;

    const subnormalPool: PagedKvPhysicalPool = {
      blockSize: 2,
      headDim: 4,
      keys: [
        [
          [minSubnormal, -minSubnormal, maxSubnormal, 0],
          [maxSubnormal, minSubnormal, -maxSubnormal, minSubnormal],
        ],
        [
          [1e2, 1e2, 1e2, 1e2],
          [1e2, 1e2, 1e2, 1e2],
        ],
      ],
      values: [
        [
          [minSubnormal, maxSubnormal, -minSubnormal, 0.5],
          [maxSubnormal, -maxSubnormal, minSubnormal, 1.5],
        ],
        [
          [99, 99, 99, 99],
          [99, 99, 99, 99],
        ],
      ],
      blockScopeTags: [42, 99],
    };

    const query = [minSubnormal, maxSubnormal, minSubnormal, maxSubnormal];
    const ref = runReferencePagedAttention({
      query,
      blockTable: [0, 1],
      validityMask: [
        [true, true],
        [true, true],
      ],
      requestScopeTag: 42,
      enforceScopeMask: true,
      pool: subnormalPool,
    });
    const online = runOnlineBlockSkippingPagedAttention({
      query,
      blockTable: [0, 1],
      validityMask: [
        [true, true],
        [true, true],
      ],
      requestScopeTag: 42,
      enforceScopeMask: true,
      pool: subnormalPool,
    });

    expect(ref.status).toBe('ok');
    expect(online.status).toBe('ok');
    expect(ref.output.every(Number.isFinite)).toBe(true);
    expect(Math.abs(ref.weights[0]! + ref.weights[1]! - 1)).toBeLessThanOrEqual(1e-12);
    expect(ref.perBlockMass[1]).toBe(0);
    expect(maxAbsError(online.output, ref.output)).toBeLessThanOrEqual(1e-12);
  });

  it('fails closed on NaN, Infinity, and -Infinity in Q, K, V, and on dot-product float64 overflow', () => {
    const nonFiniteValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    for (const bad of nonFiniteValues) {
      // 1. Non-finite Q
      const badQ = runReferencePagedAttention({
        query: [1, bad, 0, 0],
        blockTable: [0],
        validityMask: [[true, true]],
        requestScopeTag: 0x80000001,
        enforceScopeMask: true,
        pool: basePool,
      });
      expect(badQ.status).toBe('failed_closed_invalid_input');
      expect(badQ.output.every((v) => v === 0)).toBe(true);

      // 2. Non-finite K in referenced block (even in validity-masked slot)
      const badKPool: PagedKvPhysicalPool = {
        ...basePool,
        keys: [
          [
            [1, 0, 0, 0],
            [0, bad, 0, 0],
          ],
          basePool.keys[1]!,
        ],
      };
      const badK = runReferencePagedAttention({
        query: [1, 0, 0, 0],
        blockTable: [0],
        validityMask: [[true, false]],
        requestScopeTag: 0x80000001,
        enforceScopeMask: true,
        pool: badKPool,
      });
      expect(badK.status).toBe('failed_closed_invalid_input');
      expect(badK.output.every((v) => v === 0)).toBe(true);

      // 3. Non-finite V in referenced block
      const badVPool: PagedKvPhysicalPool = {
        ...basePool,
        values: [
          [
            [0.5, 0.5, 0.5, bad],
            [0.5, 0.5, 0.5, 0.5],
          ],
          basePool.values[1]!,
        ],
      };
      const badV = runReferencePagedAttention({
        query: [1, 0, 0, 0],
        blockTable: [0],
        validityMask: [[true, true]],
        requestScopeTag: 0x80000001,
        enforceScopeMask: true,
        pool: badVPool,
      });
      expect(badV.status).toBe('failed_closed_invalid_input');
      expect(badV.output.every((v) => v === 0)).toBe(true);

      // 4. Non-finite requestScopeTag
      const badScope = runReferencePagedAttention({
        query: [1, 0, 0, 0],
        blockTable: [0],
        validityMask: [[true, true]],
        requestScopeTag: bad,
        enforceScopeMask: true,
        pool: basePool,
      });
      expect(badScope.status).toBe('failed_closed_invalid_input');
    }

    // 5. Finite Q and K whose dot product overflows float64 to +Infinity / -Infinity
    const overflowPool: PagedKvPhysicalPool = {
      blockSize: 2,
      headDim: 2,
      keys: [
        [
          [1e200, 1e200],
          [1e200, 1e200],
        ],
      ],
      values: [
        [
          [1, 2],
          [3, 4],
        ],
      ],
      blockScopeTags: [7],
    };
    const posOverflow = runReferencePagedAttention({
      query: [1e200, 1e200],
      blockTable: [0],
      validityMask: [[true, true]],
      requestScopeTag: 7,
      enforceScopeMask: true,
      pool: overflowPool,
    });
    expect(posOverflow.status).toBe('refused_all_masked');
    expect(posOverflow.output.every((v) => v === 0 && Number.isFinite(v))).toBe(true);

    const negOverflow = runReferencePagedAttention({
      query: [-1e200, -1e200],
      blockTable: [0],
      validityMask: [[true, true]],
      requestScopeTag: 7,
      enforceScopeMask: true,
      pool: overflowPool,
    });
    expect(negOverflow.status).toBe('refused_all_masked');
    expect(negOverflow.output.every((v) => v === 0 && Number.isFinite(v))).toBe(true);
  });

  it('fails closed on negative, fractional, non-finite, and out-of-bounds blockTable entries', () => {
    const invalidBlockIds = [
      -1,
      -999,
      -0.0001,
      0.5,
      1.999999,
      basePool.keys.length,
      basePool.keys.length + 50,
      Number.MAX_SAFE_INTEGER,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const badId of invalidBlockIds) {
      const ref = runReferencePagedAttention({
        query: [1, 0, 0, 0],
        blockTable: [0, badId],
        validityMask: [
          [true, true],
          [true, true],
        ],
        requestScopeTag: 0x80000001,
        enforceScopeMask: true,
        pool: basePool,
      });
      const online = runOnlineBlockSkippingPagedAttention({
        query: [1, 0, 0, 0],
        blockTable: [0, badId],
        validityMask: [
          [true, true],
          [true, true],
        ],
        requestScopeTag: 0x80000001,
        enforceScopeMask: true,
        pool: basePool,
      });

      expect(ref.status).toBe('failed_closed_invalid_block_id');
      expect(online.status).toBe('failed_closed_invalid_block_id');
      expect(ref.weights).toEqual([]);
      expect(ref.output).toEqual([0, 0, 0, 0]);
      expect(ref.perBlockMass).toEqual([0, 0]);
    }
  });

  it('fails closed on outer/inner validityMask dimension mismatches, pool shape mismatches, and empty blockTable', () => {
    // 1. Empty blockTable + empty validityMask -> refused_all_masked
    const emptyRes = runReferencePagedAttention({
      query: [1, 0, 0, 0],
      blockTable: [],
      validityMask: [],
      requestScopeTag: 0x80000001,
      enforceScopeMask: true,
      pool: basePool,
    });
    expect(emptyRes.status).toBe('refused_all_masked');
    expect(emptyRes.rawScores).toEqual([]);
    expect(emptyRes.activeMask).toEqual([]);
    expect(emptyRes.weights).toEqual([]);
    expect(emptyRes.perBlockMass).toEqual([]);
    expect(emptyRes.output).toEqual([0, 0, 0, 0]);

    // 2. Outer validityMask length != blockTable length -> failed_closed_invalid_input
    for (const badOuterMask of [[], [[true, true], [true, true]]]) {
      const outerMismatch = runReferencePagedAttention({
        query: [1, 0, 0, 0],
        blockTable: [0],
        validityMask: badOuterMask,
        requestScopeTag: 0x80000001,
        enforceScopeMask: true,
        pool: basePool,
      });
      expect(outerMismatch.status).toBe('failed_closed_invalid_input');
      expect(outerMismatch.output).toEqual([0, 0, 0, 0]);
    }

    // 3. Inner validityMask[b] length != pool.blockSize -> failed_closed_invalid_block_id
    for (const badInnerSlot of [[], [true], [true, true, false]]) {
      const innerMismatch = runReferencePagedAttention({
        query: [1, 0, 0, 0],
        blockTable: [0],
        validityMask: [badInnerSlot],
        requestScopeTag: 0x80000001,
        enforceScopeMask: true,
        pool: basePool,
      });
      expect(innerMismatch.status).toBe('failed_closed_invalid_block_id');
      expect(innerMismatch.output).toEqual([0, 0, 0, 0]);
    }

    // 4. Non-positive integer headDim or blockSize -> failed_closed_invalid_input
    for (const nonPos of [0, -4]) {
      const badDim = runReferencePagedAttention({
        query: [],
        blockTable: [],
        validityMask: [],
        requestScopeTag: 1,
        enforceScopeMask: true,
        pool: { ...basePool, headDim: nonPos },
      });
      expect(badDim.status).toBe('failed_closed_invalid_input');
      expect(badDim.output).toEqual([]);

      const badBlockSz = runReferencePagedAttention({
        query: [1, 0, 0, 0],
        blockTable: [],
        validityMask: [],
        requestScopeTag: 1,
        enforceScopeMask: true,
        pool: { ...basePool, blockSize: nonPos },
      });
      expect(badBlockSz.status).toBe('failed_closed_invalid_input');
    }

    // 5. Pool array length mismatch (blockScopeTags / values vs keys)
    const mismatchedTagsPool: PagedKvPhysicalPool = {
      ...basePool,
      blockScopeTags: [0x80000001],
    };
    const badTagsLen = runReferencePagedAttention({
      query: [1, 0, 0, 0],
      blockTable: [0],
      validityMask: [[true, true]],
      requestScopeTag: 0x80000001,
      enforceScopeMask: true,
      pool: mismatchedTagsPool,
    });
    expect(badTagsLen.status).toBe('failed_closed_invalid_input');
  });

  it('enforces strict uint32 tag bounds, safe headDim allocation, and partial-tail disposition', () => {
    // Finding A fixed: integers > 0xffffffff or < 0 fail closed instead of truncating modulo 2^32
    const over32BitTag = 0x1_0000_0000 + 0x00000001; // 4294967297
    expect(Number.isInteger(over32BitTag)).toBe(true);
    const rejectedOver32 = runReferencePagedAttention({
      query: [1, 1, 1, 1],
      blockTable: [1],
      validityMask: [[true, true]],
      requestScopeTag: over32BitTag,
      enforceScopeMask: true,
      pool: basePool,
    });
    expect(rejectedOver32.status).toBe('failed_closed_invalid_input');
    expect(rejectedOver32.output).toEqual([0, 0, 0, 0]);

    const rejectedNegativeTag = runReferencePagedAttention({
      query: [1, 1, 1, 1],
      blockTable: [0],
      validityMask: [[true, true]],
      requestScopeTag: -1,
      enforceScopeMask: true,
      pool: basePool,
    });
    expect(rejectedNegativeTag.status).toBe('failed_closed_invalid_input');

    // Finding B fixed: fractional/NaN/Infinity headDim fails closed cleanly without RangeError
    for (const nonIntDim of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 999999]) {
      const badDimRes = runReferencePagedAttention({
        query: [1, 0],
        blockTable: [],
        validityMask: [],
        requestScopeTag: 1,
        enforceScopeMask: true,
        pool: { ...basePool, headDim: nonIntDim },
      });
      expect(badDimRes.status).toBe('failed_closed_invalid_input');
      expect(badDimRes.output).toEqual([]);
    }

    // Finding C fixed: partially filled authorized tail block #3 ([true, false]) reports `admitted_partial_tail`
    const proof = buildScopedAttentionProofForSession(TENANT_FIXTURES.alder);
    const tailBlock = proof.blocks[3]!;
    expect(tailBlock.scopeMatchesRequest).toBe(true);
    expect(tailBlock.validTokenFlags).toEqual([true, false]);
    expect(tailBlock.scopedBlockMass).toBeGreaterThan(0);
    expect(tailBlock.maskDisposition).toBe('admitted_partial_tail');
  });
});

describe('HTTP Authority Boundary on GET /api/demo/scoped-attention', () => {
  it('binds requestScopeHex strictly to server session and rejects client scope / request_scope / X-Request-Scope overrides', async () => {
    const { baseUrl } = await startEphemeralTestServer();

    // Unauthenticated request -> 401 invalid_session
    const unauthRes = await fetch(`${baseUrl}/api/demo/scoped-attention`);
    expect(unauthRes.status).toBe(401);
    const unauthBody = (await unauthRes.json()) as { error: { code: string } };
    expect(unauthBody.error.code).toBe(API_ERROR_CODES.INVALID_SESSION);

    // Establish Alder session
    const alderSesRes = await fetch(`${baseUrl}/api/demo/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: 'alder' }),
    });
    expect(alderSesRes.status).toBe(200);
    const alderCookie = alderSesRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    // Clean GET returns server-bound Alder scope (0x00a1de07)
    const cleanAlderRes = await fetch(`${baseUrl}/api/demo/scoped-attention`, {
      headers: { Cookie: alderCookie },
    });
    expect(cleanAlderRes.status).toBe(200);
    const cleanAlderProof = (await cleanAlderRes.json()) as ScopedAttentionProofView;
    expect(cleanAlderProof.requestScopeHex).toBe('0x00a1de07');
    expect(cleanAlderProof.tenantContextLabel).toBe('Tenant Alder');
    expect(cleanAlderProof.foreignPostMaskMass).toBe(0);
    expect(cleanAlderProof.limitationBanner).toBe(SCOPED_ATTENTION_LIMITATION_LABEL);

    // Query parameter override attempts on GET /api/demo/scoped-attention -> 400 authority_override_rejected
    const queryOverrideParams = [
      'scope=0x00beac11',
      'request_scope=0x00beac11',
      'requestScope=0x00beac11',
      'scope_id=0x00beac11',
      'x_request_scope=0x00beac11',
      'tenant=tenant_beacon',
      'policy_epoch=99',
    ];

    for (const qs of queryOverrideParams) {
      const overrideRes = await fetch(`${baseUrl}/api/demo/scoped-attention?${qs}`, {
        headers: { Cookie: alderCookie },
      });
      expect(overrideRes.status).toBe(400);
      const errBody = (await overrideRes.json()) as { error: { code: string } };
      expect(errBody.error.code).toBe(API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED);
    }

    // Header override attempts on GET /api/demo/scoped-attention -> 400 authority_override_rejected
    const headerOverrides: ReadonlyArray<readonly [string, string]> = [
      ['X-Request-Scope', '0x00beac11'],
      ['x-request-scope', '0x00beac11'],
      ['Request-Scope', '0x00beac11'],
      ['X-Scope', '0x00beac11'],
      ['Scope', '0x00beac11'],
      ['X-Tenant-Id', 'tenant_beacon'],
    ];

    for (const [hdrName, hdrVal] of headerOverrides) {
      const overrideRes = await fetch(`${baseUrl}/api/demo/scoped-attention`, {
        headers: {
          Cookie: alderCookie,
          [hdrName]: hdrVal,
        },
      });
      expect(overrideRes.status).toBe(400);
      const errBody = (await overrideRes.json()) as { error: { code: string } };
      expect(errBody.error.code).toBe(API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED);
    }

    // Arbitrary unknown query parameter -> 400 unknown_field
    const unknownParamRes = await fetch(`${baseUrl}/api/demo/scoped-attention?debug=1`, {
      headers: { Cookie: alderCookie },
    });
    expect(unknownParamRes.status).toBe(400);
    const unknownBody = (await unknownParamRes.json()) as { error: { code: string } };
    expect(unknownBody.error.code).toBe(API_ERROR_CODES.UNKNOWN_FIELD);

    // POST to GET-only /api/demo/scoped-attention -> 405 method_not_allowed
    const postAttemptRes = await fetch(`${baseUrl}/api/demo/scoped-attention`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: alderCookie,
      },
      body: JSON.stringify({ scope: '0x00beac11' }),
    });
    expect(postAttemptRes.status).toBe(405);
    const postErrBody = (await postAttemptRes.json()) as { error: { code: string } };
    expect(postErrBody.error.code).toBe(API_ERROR_CODES.METHOD_NOT_ALLOWED);

    // Establish Beacon session and verify server-side scope switches strictly via session rotation
    const beaconSesRes = await fetch(`${baseUrl}/api/demo/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: alderCookie,
      },
      body: JSON.stringify({ persona: 'beacon' }),
    });
    expect(beaconSesRes.status).toBe(200);
    const beaconCookie = beaconSesRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const cleanBeaconRes = await fetch(`${baseUrl}/api/demo/scoped-attention`, {
      headers: { Cookie: beaconCookie },
    });
    expect(cleanBeaconRes.status).toBe(200);
    const cleanBeaconProof = (await cleanBeaconRes.json()) as ScopedAttentionProofView;
    expect(cleanBeaconProof.requestScopeHex).toBe('0x00beac11');
    expect(cleanBeaconProof.tenantContextLabel).toBe('Tenant Beacon');
    expect(cleanBeaconProof.foreignPostMaskMass).toBe(0);
  });
});
