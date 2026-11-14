/**
 * Adversarial runtime-boundary tests for the scoped-attention reference.
 * Scope tags are uint32 security labels and must never be accepted through
 * JavaScript's lossy `>>> 0` coercion.
 */

import { describe, expect, it } from 'vitest';

import {
  runReferencePagedAttention,
  type PagedKvPhysicalPool,
} from '../../src/server/scoped-attention.js';

const BASE_POOL: PagedKvPhysicalPool = {
  blockSize: 1,
  headDim: 1,
  keys: [[[1]]],
  values: [[[99]]],
  blockScopeTags: [0xffff_ffff],
};

describe('Daybreak: scoped-attention runtime label validation', () => {
  it('rejects a negative request tag that aliases uint32 max', () => {
    const result = runReferencePagedAttention({
      query: [1],
      blockTable: [0],
      validityMask: [[true]],
      requestScopeTag: -1,
      enforceScopeMask: true,
      pool: BASE_POOL,
    });
    expect(result.status).toBe('failed_closed_invalid_input');
    expect(result.output).toEqual([0]);
  });

  it('rejects a negative block tag that aliases a valid request tag', () => {
    const aliasedPool: PagedKvPhysicalPool = {
      ...BASE_POOL,
      blockScopeTags: [-1],
    };
    const result = runReferencePagedAttention({
      query: [1],
      blockTable: [0],
      validityMask: [[true]],
      requestScopeTag: 0xffff_ffff,
      enforceScopeMask: true,
      pool: aliasedPool,
    });
    expect(result.status).toBe('failed_closed_invalid_input');
    expect(result.output).toEqual([0]);
  });

  it('rejects non-boolean validity entries instead of truthy-coercing them', () => {
    const result = runReferencePagedAttention({
      query: [1],
      blockTable: [0],
      validityMask: [['true'] as unknown as readonly boolean[]],
      requestScopeTag: 0xffff_ffff,
      enforceScopeMask: true,
      pool: BASE_POOL,
    });
    expect(result.status).toBe('failed_closed_invalid_input');
    expect(result.output).toEqual([0]);
  });
});
