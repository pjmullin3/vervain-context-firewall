/**
 * Responsibility: Numerical and adversarial property tests for the Scoped Attention
 * reference proof (`src/server/scoped-attention.ts`).
 * Trust boundary: Confirms pre-softmax scope masking, clean allowed-twin equivalence,
 * fail-closed NaN-free behavior on all-masked and invalid blocks, and server-owned scope tags.
 */

import { describe, expect, it } from 'vitest';
import { SCOPED_ATTENTION_LIMITATION_LABEL } from '../../src/shared/config.js';
import { TENANT_FIXTURES } from '../../src/server/fixture.js';
import {
  buildScopedAttentionProofForSession,
  runReferencePagedAttention,
  type PagedKvPhysicalPool,
} from '../../src/server/scoped-attention.js';

const TEST_POOL: PagedKvPhysicalPool = {
  blockSize: 2,
  headDim: 4,
  keys: [
    [
      [1.0, 0.2, -0.3, 0.5],
      [0.7, 0.5, 0.1, 0.2],
    ],
    [
      [2.1, 1.4, 0.5, 1.1],
      [1.9, 1.2, 0.4, 0.9],
    ],
    [
      [0.4, 0.8, 0.2, -0.1],
      [0.0, 0.0, 0.0, 0.0],
    ],
  ],
  values: [
    [
      [0.5, 0.2, 0.9, 0.1],
      [0.4, 0.3, 0.8, 0.2],
    ],
    [
      [-3.0, 4.0, -2.5, 3.5],
      [-2.8, 3.8, -2.2, 3.1],
    ],
    [
      [0.6, 0.1, 0.7, 0.3],
      [10.0, -10.0, 10.0, -10.0],
    ],
  ],
  blockScopeTags: [101, 202, 101],
};

describe('Scoped Attention Reference Proof Math', () => {
  it('assigns nonzero mass to foreign block in baseline and zero mass (<= 1e-12) when scoped', () => {
    const proof = buildScopedAttentionProofForSession(TENANT_FIXTURES.alder);
    expect(proof.limitationBanner).toBe(SCOPED_ATTENTION_LIMITATION_LABEL);

    const foreignBlock = proof.blocks.find((b) => !b.scopeMatchesRequest);
    expect(foreignBlock).toBeDefined();
    expect(foreignBlock!.baselineBlockMass).toBeGreaterThan(0.2);
    expect(foreignBlock!.scopedBlockMass).toBe(0);
    expect(proof.foreignPostMaskMass).toBeLessThanOrEqual(1e-12);
    expect(proof.mismatchCounter).toBe(1);
    expect(proof.cleanAllowedTwinMaxAbsDelta).toBeLessThanOrEqual(1e-12);
  });

  it('matches baseline and scoped outputs on a clean block table within 1e-12 tolerance', () => {
    const query = [0.9, 0.4, 0.2, 0.6];
    const cleanTable = [0, 2];
    const validity = [
      [true, true],
      [true, false], // combines causal/slot mask with scope mask
    ];

    const baseline = runReferencePagedAttention({
      query,
      blockTable: cleanTable,
      validityMask: validity,
      requestScopeTag: 101,
      enforceScopeMask: false,
      pool: TEST_POOL,
    });
    const scoped = runReferencePagedAttention({
      query,
      blockTable: cleanTable,
      validityMask: validity,
      requestScopeTag: 101,
      enforceScopeMask: true,
      pool: TEST_POOL,
    });

    expect(baseline.status).toBe('ok');
    expect(scoped.status).toBe('ok');
    expect(scoped.mismatchCount).toBe(0);
    // Slot [1][1] was validity-masked -> must stay 0 in both
    expect(scoped.weights[3]).toBe(0);

    for (let i = 0; i < baseline.output.length; i += 1) {
      expect(Math.abs(baseline.output[i]! - scoped.output[i]!)).toBeLessThanOrEqual(1e-12);
    }
  });

  it('handles reordered blocks, repeated blocks, empty blocks, and extreme logits stably', () => {
    const extremePool: PagedKvPhysicalPool = {
      blockSize: 2,
      headDim: 2,
      keys: [
        [
          [500, 500],
          [499, 499],
        ],
        [
          [900, 900],
          [900, 900],
        ],
      ],
      values: [
        [
          [1, 0],
          [0, 1],
        ],
        [
          [-99, 99],
          [-99, 99],
        ],
      ],
      blockScopeTags: [7, 11],
    };

    // Repeated + reordered table [1, 0, 1, 0] with large logits
    const res = runReferencePagedAttention({
      query: [2, 2],
      blockTable: [1, 0, 1, 0],
      validityMask: [
        [true, true],
        [true, true],
        [false, false], // empty block (0 valid slots)
        [true, false],
      ],
      requestScopeTag: 7,
      enforceScopeMask: true,
      pool: extremePool,
    });

    expect(res.status).toBe('ok');
    // Block index 0 has valid tokens & foreign tag -> counted once; block index 2 has 0 valid slots -> not counted
    expect(res.mismatchCount).toBe(1);
    expect(res.perBlockMass[0]).toBe(0);
    expect(res.perBlockMass[2]).toBe(0);
    const totalMass = res.weights.reduce((acc, w) => acc + w, 0);
    expect(Math.abs(totalMass - 1)).toBeLessThanOrEqual(1e-12);
    expect(res.output.every(Number.isFinite)).toBe(true);
  });

  it('fails closed without NaN or Infinity on all-masked rows, invalid block IDs, and non-finite inputs', () => {
    // All-masked because only foreign block is present
    const allMasked = runReferencePagedAttention({
      query: [1, 0, 0, 0],
      blockTable: [1],
      validityMask: [[true, true]],
      requestScopeTag: 101,
      enforceScopeMask: true,
      pool: TEST_POOL,
    });
    expect(allMasked.status).toBe('refused_all_masked');
    expect(allMasked.weights.every((w) => w === 0)).toBe(true);
    expect(allMasked.output.every((v) => v === 0 && Number.isFinite(v))).toBe(true);

    // Out-of-range and negative block IDs
    for (const badId of [-1, 99, 1.5]) {
      const badBlock = runReferencePagedAttention({
        query: [1, 0, 0, 0],
        blockTable: [0, badId],
        validityMask: [
          [true, true],
          [true, true],
        ],
        requestScopeTag: 101,
        enforceScopeMask: true,
        pool: TEST_POOL,
      });
      expect(badBlock.status).toBe('failed_closed_invalid_block_id');
      expect(badBlock.output.every((v) => v === 0)).toBe(true);
    }

    // Non-finite query vector
    const nanQuery = runReferencePagedAttention({
      query: [Number.NaN, 0, 0, 0],
      blockTable: [0],
      validityMask: [[true, true]],
      requestScopeTag: 101,
      enforceScopeMask: true,
      pool: TEST_POOL,
    });
    expect(nanQuery.status).toBe('failed_closed_invalid_input');
    expect(nanQuery.output.every((v) => v === 0)).toBe(true);
  });
});
