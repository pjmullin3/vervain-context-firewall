/**
 * Responsibility: Unit and adversarial tests for `src/server/inference-proof.ts` and
 * `src/server/open-weight-workbench.ts`.
 * Trust boundary: Verifies Carbon 3 status honesty, strict RFC 8259/8785 JSON/JCS digesting,
 * zero-echo secret and raw/hex/base64 planted-value sanitization, HMAC prefix-cache salting,
 * ABA generation rejection, Proxy zero-foreign-KV-read enforcement, and <= 1e-12 online
 * FlashAttention-2 `(m_i, l_i, O_i)` equivalence.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCOPED_ATTENTION_LIMITATION_LABEL } from '../../src/shared/config.js';
import {
  SYNTHETIC_PLANTED_VALUE,
  TENANT_FIXTURES,
} from '../../src/server/fixture.js';
import {
  INFERENCE_PROOF_NO_ARTIFACT_CLAIM_BOUNDARY,
  canonicalizeJcs,
  computeInferenceProofSha256,
  evaluateInferenceProofArtifactRaw,
  loadConfiguredInferenceProofStatus,
} from '../../src/server/inference-proof.js';
import {
  OPEN_WEIGHT_WORKBENCH_LIMITATION_LABEL,
  SHARED_SYSTEM_PREFIX_TOKENS,
  buildOpenWeightKvWorkbenchForSession,
  computeSaltedPrefixCacheHash,
  computeUnsaltedPrefixCacheHash,
  createProxyInstrumentedKvPool,
  getEnterprisePresets,
  getOpenWeightEngineProfiles,
  runOnlineTiledFlashAttention,
} from '../../src/server/open-weight-workbench.js';
import {
  buildScopedAttentionProofForSession,
  runReferencePagedAttention,
} from '../../src/server/scoped-attention.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');
const IN_REPO_FIXTURES_DIR = path.join(REPO_ROOT, 'verification', 'fixtures');
const IN_REPO_PYTHON_SRC = path.join(REPO_ROOT, 'packages', 'evidence-verifier', 'src');
const SIBLING_CARBON3_ROOT = path.resolve(REPO_ROOT, '..', 'vervain-carbon-evidence-lane');
const SIBLING_FIXTURES_DIR = fs.existsSync(IN_REPO_FIXTURES_DIR)
  ? IN_REPO_FIXTURES_DIR
  : path.join(SIBLING_CARBON3_ROOT, 'verification', 'fixtures');
const SIBLING_PYTHON_SRC = fs.existsSync(IN_REPO_PYTHON_SRC)
  ? IN_REPO_PYTHON_SRC
  : path.join(SIBLING_CARBON3_ROOT, 'packages', 'evidence-verifier', 'src');

const H_A = 'a'.repeat(64);
const H_B = 'b'.repeat(64);
const H_C = 'c'.repeat(64);
const H_D = 'd'.repeat(64);
const H_E = 'e'.repeat(64);
const H_F = 'f'.repeat(64);
const GIT_1 = '1'.repeat(40);
const GIT_2 = '2'.repeat(40);

function buildSelfContainedInferenceProofFixture(
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  const runId = 'run-vervain-h200-selfcontained-001';
  const base: Record<string, unknown> = {
    schema_version: 'inference-proof.v1',
    evidence_status: 'recorded',
    run_id: runId,
    started_at: '2026-11-14T11:58:00Z',
    finished_at: '2026-11-14T11:58:20Z',
    source: {
      git_sha: GIT_1,
      git_dirty: false,
      vllm_sha: GIT_2,
      patch_sha256: H_A,
      patch_path: 'engine/patches/vllm-scoped-kv-firewall.patch',
      loaded_modules: [
        {
          module_name: 'vervain_scope.backend_guard',
          file_path: 'vervain_scope/backend_guard.py',
          file_sha256: H_B,
        },
      ],
      trace_sha256: H_C,
    },
    runtime_manifest: {
      gpu_model: 'NVIDIA H200',
      gpu_count: 1,
      gpu_uuids_sha256: [H_D],
      topology: 'TP1',
      driver_version: '565.57.01',
      cuda_version: '12.6',
      torch_version: '2.6.0',
      triton_version: '3.2.0',
      vllm_version: '0.28.0',
      flash_attn_version: '2.7.2',
      flashinfer_version: 'disabled',
      python_version: '3.12.7',
      model_id: 'Qwen/Qwen2.5-72B-Instruct',
      model_revision: 'rev-pinned-20261114',
      tokenizer_revision: 'tok-pinned-20261114',
      configured_backend: 'FLASH_ATTN',
      selected_runtime_backend: 'FLASH_ATTN',
      kv_dtype: 'bf16',
      block_size: 16,
      prefix_caching: true,
      graph_mode: 'eager',
      tp_size: 1,
      cp_size: 1,
      speculation: 'disabled',
      offload: 'disabled',
      swap: 'disabled',
      kv_connector: 'disabled',
      launch_command_sanitized: ['vllm', 'serve', 'Qwen/Qwen2.5-72B-Instruct', '--enforce-eager'],
      host_id_digest: H_E,
      nccl_version: '2.23.4',
      nccl_transport_digest: H_F,
    },
    trust_boundary: {
      guard_mode: 'strict-host',
      public_client_can_supply_scope: false,
      scope_envelope_integrity: 'hmac_sha256_server_side',
      mediated_boundaries: ['gateway_admission', 'pre_attention_dispatch_guard'],
      claim_scope: 'Controlled synthetic fault injection on named H200 configuration only.',
    },
    scenario: {
      scenario_id: 'alder-birch-kv-fault-v1',
      synthetic_only: true,
      injection_type: 'controlled_engine_internal_post_auth_substitution',
      tenants: [
        { tenant_alias: 'Alder', scope_id: 'scope:alder' },
        { tenant_alias: 'Birch', scope_id: 'scope:birch' },
      ],
      foreign_block_alias: 'blk-alder-foreign-009',
      foreign_owner_scope: 'scope:alder',
      victim_request_scope: 'scope:birch',
      placeholder_notice: null,
    },
    paired_runs: {
      native_clean: {
        arm_id: 'native_clean',
        request_id: 'req-nc-01',
        request_scope: 'scope:birch',
        policy_epoch: 1,
        seed: 42,
        config_digest: H_A,
        started_at: '2026-11-14T11:58:06Z',
        finished_at: '2026-11-14T11:58:07Z',
        outcome: 'completed',
        output_sha256: H_B,
        entered_attention_dispatch: true,
        foreign_block_injected: false,
        referenced_blocks: [{ physical_block_alias: 'blk-birch-001', allocation_generation: 2 }],
        ranks: [
          {
            rank_id: 0,
            worker_id: 'worker-r0',
            gpu_uuid_sha256: H_D,
            loaded_patch_sha256: null,
            enforced_decision: 'unmediated_native',
            decision_ref: null,
            entered_attention_dispatch: true,
          },
        ],
      },
      native_fault_injected: {
        arm_id: 'native_fault_injected',
        request_id: 'req-nf-02',
        request_scope: 'scope:birch',
        policy_epoch: 1,
        seed: 42,
        config_digest: H_A,
        started_at: '2026-11-14T11:58:08Z',
        finished_at: '2026-11-14T11:58:09Z',
        outcome: 'contaminated_control_completed',
        output_sha256: H_C,
        entered_attention_dispatch: true,
        foreign_block_injected: true,
        referenced_blocks: [
          { physical_block_alias: 'blk-birch-001', allocation_generation: 2 },
          { physical_block_alias: 'blk-alder-foreign-009', allocation_generation: 3 },
        ],
        ranks: [
          {
            rank_id: 0,
            worker_id: 'worker-r0',
            gpu_uuid_sha256: H_D,
            loaded_patch_sha256: null,
            enforced_decision: 'unmediated_native',
            decision_ref: null,
            entered_attention_dispatch: true,
          },
        ],
      },
      vervain_clean: {
        arm_id: 'vervain_clean',
        request_id: 'req-vc-03',
        request_scope: 'scope:birch',
        policy_epoch: 1,
        seed: 42,
        config_digest: H_A,
        started_at: '2026-11-14T11:58:10Z',
        finished_at: '2026-11-14T11:58:11Z',
        outcome: 'completed',
        output_sha256: H_B,
        entered_attention_dispatch: true,
        foreign_block_injected: false,
        referenced_blocks: [{ physical_block_alias: 'blk-birch-001', allocation_generation: 2 }],
        ranks: [
          {
            rank_id: 0,
            worker_id: 'worker-r0',
            gpu_uuid_sha256: H_D,
            loaded_patch_sha256: H_A,
            enforced_decision: 'allow',
            decision_ref: 'dec-vc-r0',
            entered_attention_dispatch: true,
          },
        ],
      },
      vervain_fault_injected: {
        arm_id: 'vervain_fault_injected',
        request_id: 'req-vf-04',
        request_scope: 'scope:birch',
        policy_epoch: 1,
        seed: 42,
        config_digest: H_A,
        started_at: '2026-11-14T11:58:12Z',
        finished_at: '2026-11-14T11:58:13Z',
        outcome: 'blocked_fail_closed',
        output_sha256: null,
        entered_attention_dispatch: false,
        foreign_block_injected: true,
        referenced_blocks: [
          { physical_block_alias: 'blk-birch-001', allocation_generation: 2 },
          { physical_block_alias: 'blk-alder-foreign-009', allocation_generation: 3 },
        ],
        ranks: [
          {
            rank_id: 0,
            worker_id: 'worker-r0',
            gpu_uuid_sha256: H_D,
            loaded_patch_sha256: H_A,
            enforced_decision: 'deny_fail_closed',
            decision_ref: 'dec-vf-r0-foreign',
            entered_attention_dispatch: false,
          },
        ],
      },
      vervain_allowed_after_fault: {
        arm_id: 'vervain_allowed_after_fault',
        request_id: 'req-va-05',
        request_scope: 'scope:birch',
        policy_epoch: 1,
        seed: 42,
        config_digest: H_A,
        started_at: '2026-11-14T11:58:14Z',
        finished_at: '2026-11-14T11:58:15Z',
        outcome: 'completed',
        output_sha256: H_B,
        entered_attention_dispatch: true,
        foreign_block_injected: false,
        referenced_blocks: [{ physical_block_alias: 'blk-birch-001', allocation_generation: 2 }],
        ranks: [
          {
            rank_id: 0,
            worker_id: 'worker-r0',
            gpu_uuid_sha256: H_D,
            loaded_patch_sha256: H_A,
            enforced_decision: 'allow',
            decision_ref: 'dec-va-r0',
            entered_attention_dispatch: true,
          },
        ],
      },
    },
    scope_decisions: [
      {
        decision_id: 'dec-vc-r0',
        request_id: 'req-vc-03',
        rank_id: 0,
        physical_block_alias: 'blk-birch-001',
        allocation_generation: 2,
        request_scope: 'scope:birch',
        block_scope: 'scope:birch',
        policy_epoch: 1,
        block_policy_epoch: 1,
        decision_point: 'pre_attention_dispatch_guard',
        disposition: 'allow',
        public_basis: 'not_applicable',
        token_equality_used_for_public: false,
        decided_at: '2026-11-14T11:58:10Z',
        envelope_issued_at: '2026-11-14T11:57:50Z',
        envelope_expires_at: '2026-11-14T12:05:00Z',
      },
      {
        decision_id: 'dec-vf-r0-foreign',
        request_id: 'req-vf-04',
        rank_id: 0,
        physical_block_alias: 'blk-alder-foreign-009',
        allocation_generation: 3,
        request_scope: 'scope:birch',
        block_scope: 'scope:alder',
        policy_epoch: 1,
        block_policy_epoch: 1,
        decision_point: 'pre_attention_dispatch_guard',
        disposition: 'deny_scope_mismatch',
        public_basis: 'not_applicable',
        token_equality_used_for_public: false,
        decided_at: '2026-11-14T11:58:12Z',
        envelope_issued_at: '2026-11-14T11:57:50Z',
        envelope_expires_at: '2026-11-14T12:05:00Z',
      },
      {
        decision_id: 'dec-va-r0',
        request_id: 'req-va-05',
        rank_id: 0,
        physical_block_alias: 'blk-birch-001',
        allocation_generation: 2,
        request_scope: 'scope:birch',
        block_scope: 'scope:birch',
        policy_epoch: 1,
        block_policy_epoch: 1,
        decision_point: 'pre_attention_dispatch_guard',
        disposition: 'allow',
        public_basis: 'not_applicable',
        token_equality_used_for_public: false,
        decided_at: '2026-11-14T11:58:14Z',
        envelope_issued_at: '2026-11-14T11:57:50Z',
        envelope_expires_at: '2026-11-14T12:05:00Z',
      },
    ],
    block_lifecycle: [
      {
        physical_block_alias: 'blk-birch-001',
        allocation_generation: 2,
        owner_scope: 'scope:birch',
        policy_epoch: 1,
        state: 'readable',
        cache_key_digest: H_E,
        rank_id: 0,
        transitions: [
          {
            seq: 0,
            from_state: 'none',
            to_state: 'free',
            allocation_generation: 1,
            owner_scope: 'UNASSIGNED',
            policy_epoch: 0,
            transitioned_at: '2026-11-14T11:58:01Z',
            correlation_id: 'corr-0',
          },
          {
            seq: 1,
            from_state: 'free',
            to_state: 'readable',
            allocation_generation: 2,
            owner_scope: 'scope:birch',
            policy_epoch: 1,
            transitioned_at: '2026-11-14T11:58:02Z',
            correlation_id: 'corr-1',
          },
        ],
      },
    ],
    backend_dispatch: [
      {
        span_id: 'span-vf-r0',
        request_id: 'req-vf-04',
        rank_id: 0,
        selected_backend: 'FLASH_ATTN',
        entered_attention_dispatch: false,
        blocked_before_dispatch: true,
        dispatched_at: null,
        checked_at: '2026-11-14T11:58:12Z',
        decision_ref: 'dec-vf-r0-foreign',
      },
    ],
    correctness: {
      seed: 42,
      config_digest: H_A,
      equivalence_tolerance: 1e-5,
      measured_max_abs_delta: 0,
      clean_equivalence_passed: true,
      planted_value_influence_probe: {
        probe_id: 'probe-01',
        planted_value_sha256: H_F,
        raw_planted_value_omitted: true,
        native_fault_injected_influence_score: 0.42,
        baseline_nonzero_influence: true,
        vervain_fault_injected_influence_score: 0,
        vervain_zero_or_blocked: true,
      },
      allowed_after_fault_completed_after_violation: true,
      violating_request_id: 'req-vf-04',
      allowed_after_fault_request_id: 'req-va-05',
    },
    performance: {
      metrics: {
        ttft_ms: {
          delta_pct: 1.25,
        },
      },
    },
    receipt_chain: {
      chain_algorithm: 'sha256',
      genesis_sha256: H_A,
      head_sha256: H_C,
      event_count: 2,
      events: [
        {
          event_index: 0,
          run_id: runId,
          request_id: 'req-nc-01',
          event_type: 'arm_native_clean',
          recorded_at: '2026-11-14T11:58:07Z',
          prev_sha256: H_A,
          event_sha256: H_B,
          canonical_event_sha256: H_B,
        },
        {
          event_index: 1,
          run_id: runId,
          request_id: 'req-vf-04',
          event_type: 'arm_vervain_fault_injected',
          recorded_at: '2026-11-14T11:58:13Z',
          prev_sha256: H_B,
          event_sha256: H_C,
          canonical_event_sha256: H_C,
        },
      ],
    },
    exclusions: {
      unsupported_paths: [
        {
          path_name: 'kv_connector',
          status: 'disabled',
          reason: 'Disaggregated KV connectors are out of scope.',
        },
      ],
      unmediated_boundaries: ['Provider-internal Gemini memory'],
      limitations: ['Controlled internal post-auth substitution test on pinned vLLM commit only.'],
      synthetic_injection_disclosure: 'Synthetic tenants Alder and Birch.',
    },
    ui_summary: {
      evidence_status: 'recorded',
      foreign_block_stopped: true,
      clean_equivalence_passed: true,
      allowed_after_fault_completed: true,
      selected_runtime_backend: 'FLASH_ATTN',
      gpu_model: 'NVIDIA H200',
      tp_size: 1,
      ttft_delta_pct: 1.25,
    },
    ...overrides,
  };

  base['artifact_sha256'] = computeInferenceProofSha256(base);
  return base;
}

describe('Carbon 3 inference-proof.v1 Verifier & Status Honesty', () => {
  it('1. returns NO GPU RUN RECORDED / NOT_CONFIGURED when no artifact path is configured', () => {
    const defaultStatus = loadConfiguredInferenceProofStatus();
    expect(defaultStatus.badgeState).toBe('NO GPU RUN RECORDED');
    expect(defaultStatus.verifierVerdict).toBe('NOT_CONFIGURED');
    expect(defaultStatus.primaryReasonCode).toBe('NO_ARTIFACT_CONFIGURED');
    expect(defaultStatus.reasonCodes).toEqual(['NO_ARTIFACT_CONFIGURED']);
    expect(defaultStatus.claimedEvidenceStatus).toBe('none');
    expect(defaultStatus.verifiedEvidenceStatus).toBe('none');
    expect(defaultStatus.runId).toBeNull();
    expect(defaultStatus.artifactSha256Declared).toBeNull();
    expect(defaultStatus.artifactSha256Computed).toBeNull();
    expect(defaultStatus.digestMatch).toBeNull();
    expect(defaultStatus.sanitizerPassed).toBe(true);
    expect(defaultStatus.sanitizerFindingsCount).toBe(0);
    expect(defaultStatus.runtimeManifest).toBeNull();
    expect(defaultStatus.exclusions).toEqual([]);
    expect(defaultStatus.claimBoundary).toBe(INFERENCE_PROOF_NO_ARTIFACT_CLAIM_BOUNDARY);

    const blankStatus = loadConfiguredInferenceProofStatus({ artifactPath: '   ' });
    expect(blankStatus.badgeState).toBe('NO GPU RUN RECORDED');
    expect(blankStatus.verifierVerdict).toBe('NOT_CONFIGURED');
  });

  it('2. verifies valid recorded and live self-contained inference-proof.v1 fixtures and enforces requireSignature', () => {
    const recordedArt = buildSelfContainedInferenceProofFixture();
    const recordedRes = evaluateInferenceProofArtifactRaw(JSON.stringify(recordedArt));
    expect(recordedRes.badgeState).toBe('RECORDED H200 RUN');
    expect(recordedRes.verifierVerdict).toBe('PASS');
    expect(recordedRes.primaryReasonCode).toBe('PASS_VERIFIED');
    expect(recordedRes.verifiedEvidenceStatus).toBe('recorded');
    expect(recordedRes.digestMatch).toBe(true);
    expect(recordedRes.sanitizerPassed).toBe(true);
    expect(recordedRes.runtimeManifest?.gpuModel).toBe('NVIDIA H200');
    expect(recordedRes.runtimeManifest?.selectedBackend).toBe('FLASH_ATTN');
    expect(recordedRes.exclusions.length).toBeGreaterThanOrEqual(3);

    // Without Python trust-root confirmation, requireSignature downgrades to NO VERDICT
    const unsignedReqRes = evaluateInferenceProofArtifactRaw(JSON.stringify(recordedArt), {
      requireSignature: true,
    });
    expect(unsignedReqRes.badgeState).toBe('NO VERDICT');
    expect(unsignedReqRes.verifierVerdict).toBe('NO VERDICT');
    expect(unsignedReqRes.reasonCodes).toContain('NV_SIG_MISSING');

    const liveArt = buildSelfContainedInferenceProofFixture({
      evidence_status: 'live',
      ui_summary: {
        evidence_status: 'live',
        foreign_block_stopped: true,
        clean_equivalence_passed: true,
        allowed_after_fault_completed: true,
        selected_runtime_backend: 'FLASH_ATTN',
        gpu_model: 'NVIDIA H200',
        tp_size: 1,
        ttft_delta_pct: 1.25,
      },
    });
    const liveRes = evaluateInferenceProofArtifactRaw(JSON.stringify(liveArt));
    expect(liveRes.badgeState).toBe('LIVE H200 RUN');
    expect(liveRes.verifierVerdict).toBe('PASS');
    expect(liveRes.verifiedEvidenceStatus).toBe('live');
  });

  it('3. verifies Carbon 3 valid_h200_tp8.json and Python CLI bridge (both standalone and sibling corpus)', () => {
    // Standalone Python CLI bridge check using a temporary evidence_verifier module
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vervain-proof-test-'));
    try {
      const artPath = path.join(tmpDir, 'artifact.json');
      const recordedArt = buildSelfContainedInferenceProofFixture();
      recordedArt['signature'] = {
        algorithm: 'ed25519',
        key_id: 'test-key-01',
        trust_root_id: 'test-root-01',
        signed_digest_sha256: recordedArt['artifact_sha256'],
        signature_value: 'dGVzdHNpZw==',
        ephemeral_demo_only: true,
        signed_at: '2026-11-14T11:58:20Z',
      };
      fs.writeFileSync(artPath, JSON.stringify(recordedArt), 'utf8');

      //Without Python verifier, requireSignature yields NO VERDICT (NV_TRUST_ROOT_UNPROVIDED)
      const localNoPy = loadConfiguredInferenceProofStatus({
        artifactPath: artPath,
        requireSignature: true,
      });
      expect(localNoPy.badgeState).toBe('NO VERDICT');
      expect(localNoPy.verifierVerdict).toBe('NO VERDICT');
      expect(localNoPy.reasonCodes).toContain('NV_TRUST_ROOT_UNPROVIDED');

      // Stub a minimal Python evidence_verifier module to verify execFileSync integration
      const stubPkgDir = path.join(tmpDir, 'py_src', 'evidence_verifier');
      fs.mkdirSync(stubPkgDir, { recursive: true });
      fs.writeFileSync(path.join(stubPkgDir, '__init__.py'), '', 'utf8');
      fs.writeFileSync(
        path.join(stubPkgDir, '__main__.py'),
        [
          'import json, sys',
          'out = {',
          '  "schema_version": "verifier-result.v1",',
          '  "verdict": "PASS",',
          '  "exit_code": 0,',
          '  "primary_reason_code": "PASS_VERIFIED",',
          '  "reason_codes": ["PASS_VERIFIED"],',
          '  "sanitizer_result": {"passed": True, "rules_checked": 10, "finding_count": 0}',
          '}',
          'sys.stdout.write(json.dumps(out) + "\\n")',
          'sys.exit(0)',
        ].join('\n'),
        'utf8',
      );

      const confirmedByPy = loadConfiguredInferenceProofStatus({
        artifactPath: artPath,
        pythonVerifierSrc: path.join(tmpDir, 'py_src'),
        requireSignature: true,
      });
      expect(confirmedByPy.badgeState).toBe('RECORDED H200 RUN');
      expect(confirmedByPy.verifierVerdict).toBe('PASS');
      expect(confirmedByPy.primaryReasonCode).toBe('PASS_VERIFIED');

      // Also test against the real Carbon 3 sibling valid_h200_tp8.json if present on disk
      const siblingTp8 = path.join(SIBLING_FIXTURES_DIR, 'valid_h200_tp8.json');
      const siblingTrustRoot = path.join(SIBLING_FIXTURES_DIR, 'ephemeral_test_trust_root.json');
      if (fs.existsSync(siblingTp8)) {
        const rawTp8 = fs.readFileSync(siblingTp8, 'utf8');
        const tp8Local = evaluateInferenceProofArtifactRaw(rawTp8);
        expect(tp8Local.badgeState).toBe('RECORDED H200 RUN');
        expect(tp8Local.verifierVerdict).toBe('PASS');
        expect(tp8Local.digestMatch).toBe(true);
        expect(tp8Local.runtimeManifest?.tpSize).toBe(8);
        expect(tp8Local.runtimeManifest?.gpuCount).toBe(8);

        if (fs.existsSync(SIBLING_PYTHON_SRC) && fs.existsSync(siblingTrustRoot)) {
          const tp8Full = loadConfiguredInferenceProofStatus({
            artifactPath: siblingTp8,
            pythonVerifierSrc: SIBLING_PYTHON_SRC,
            trustRootPath: siblingTrustRoot,
            requireSignature: true,
          });
          expect(tp8Full.badgeState).toBe('RECORDED H200 RUN');
          expect(tp8Full.verifierVerdict).toBe('PASS');
          expect(tp8Full.primaryReasonCode).toBe('PASS_VERIFIED');
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('4. never promotes local_only or incomplete artifacts to PASS and catches status laundering', () => {
    const localOnlyArt = buildSelfContainedInferenceProofFixture({
      evidence_status: 'local_only',
      runtime_manifest: {
        gpu_model: 'NONE_LOCAL_ONLY',
        gpu_count: 0,
        gpu_uuids_sha256: [],
        topology: 'LOCAL_CPU',
        driver_version: null,
        cuda_version: null,
        torch_version: '2.6.0',
        triton_version: null,
        vllm_version: '0.28.0',
        flash_attn_version: null,
        flashinfer_version: 'disabled',
        python_version: '3.12.7',
        model_id: 'Qwen/Qwen2.5-72B-Instruct',
        model_revision: 'rev-pinned-20261114',
        tokenizer_revision: 'tok-pinned-20261114',
        configured_backend: 'FLASH_ATTN',
        selected_runtime_backend: 'FLASH_ATTN',
        kv_dtype: 'bf16',
        block_size: 16,
        prefix_caching: true,
        graph_mode: 'eager',
        tp_size: 1,
        cp_size: 1,
        speculation: 'disabled',
        offload: 'disabled',
        swap: 'disabled',
        kv_connector: 'disabled',
        launch_command_sanitized: ['vllm', 'serve', 'Qwen/Qwen2.5-72B-Instruct'],
        host_id_digest: H_E,
      },
      ui_summary: {
        evidence_status: 'local_only',
        foreign_block_stopped: true,
        clean_equivalence_passed: true,
        allowed_after_fault_completed: true,
        selected_runtime_backend: 'FLASH_ATTN',
        gpu_model: 'NONE_LOCAL_ONLY',
        tp_size: 1,
        ttft_delta_pct: 1.25,
      },
    });
    const localRes = evaluateInferenceProofArtifactRaw(JSON.stringify(localOnlyArt));
    expect(localRes.badgeState).toBe('LOCAL TEST');
    expect(localRes.verifierVerdict).toBe('NO VERDICT');
    expect(localRes.primaryReasonCode).toBe('NV_STATUS_LOCAL_ONLY');
    expect(localRes.verifiedEvidenceStatus).toBe('local_only');

    const incompleteArt = buildSelfContainedInferenceProofFixture({
      evidence_status: 'incomplete',
      performance: null,
      ui_summary: {
        evidence_status: 'incomplete',
        foreign_block_stopped: true,
        clean_equivalence_passed: true,
        allowed_after_fault_completed: true,
        selected_runtime_backend: 'FLASH_ATTN',
        gpu_model: 'NVIDIA H200',
        tp_size: 1,
        ttft_delta_pct: null,
      },
    });
    const incompleteRes = evaluateInferenceProofArtifactRaw(JSON.stringify(incompleteArt));
    expect(incompleteRes.badgeState).toBe('INCOMPLETE');
    expect(incompleteRes.verifierVerdict).toBe('NO VERDICT');
    expect(incompleteRes.primaryReasonCode).toBe('NV_STATUS_INCOMPLETE');
    expect(incompleteRes.verifiedEvidenceStatus).toBe('incomplete');

    // Also test sibling local_only.json if present
    const siblingLocal = path.join(SIBLING_FIXTURES_DIR, 'local_only.json');
    if (fs.existsSync(siblingLocal)) {
      const sibRes = evaluateInferenceProofArtifactRaw(fs.readFileSync(siblingLocal, 'utf8'));
      expect(sibRes.badgeState).toBe('LOCAL TEST');
      expect(sibRes.verifierVerdict).toBe('NO VERDICT');
      expect(sibRes.primaryReasonCode).toBe('NV_STATUS_LOCAL_ONLY');
    }

    // Status laundering: claiming 'recorded' on LOCAL_CPU hardware
    const launderedArt = buildSelfContainedInferenceProofFixture({
      evidence_status: 'recorded',
      runtime_manifest: localOnlyArt['runtime_manifest'],
      ui_summary: {
        ...(localOnlyArt['ui_summary'] as Record<string, unknown>),
        evidence_status: 'recorded',
      },
    });
    const launderedRes = evaluateInferenceProofArtifactRaw(JSON.stringify(launderedArt));
    expect(launderedRes.badgeState).toBe('VERIFICATION FAILED');
    expect(launderedRes.verifierVerdict).toBe('FAIL');
    expect(launderedRes.reasonCodes).toContain('FAIL_STATUS_LAUNDERING');
  });

  it('5. marks unsupported schema_version as UNSUPPORTED unless sanitizer fails', () => {
    const futureClean = buildSelfContainedInferenceProofFixture({
      schema_version: 'inference-proof.v99',
    });
    const cleanRes = evaluateInferenceProofArtifactRaw(JSON.stringify(futureClean));
    expect(cleanRes.badgeState).toBe('UNSUPPORTED');
    expect(cleanRes.verifierVerdict).toBe('NO VERDICT');
    expect(cleanRes.primaryReasonCode).toBe('NV_UNSUPPORTED_SCHEMA_VERSION');

    const futureLeaked = {
      schema_version: 'inference-proof.v99',
      raw_prompt: 'confidential user prompt',
    };
    const leakedRes = evaluateInferenceProofArtifactRaw(JSON.stringify(futureLeaked));
    expect(leakedRes.badgeState).toBe('VERIFICATION FAILED');
    expect(leakedRes.verifierVerdict).toBe('FAIL');
    expect(leakedRes.sanitizerPassed).toBe(false);
    expect(leakedRes.reasonCodes).toContain('FAIL_PROTECTED_CONTENT_PROMPT_OR_KV');
  });

  it('6. rejects single-byte digest tampering via timing-safe JCS SHA-256 comparison', () => {
    const validArt = buildSelfContainedInferenceProofFixture();
    // Mutate run_id after sealing without updating artifact_sha256
    const tampered = {
      ...validArt,
      run_id: 'run-vervain-h200-selfcontained-002',
    };
    const res = evaluateInferenceProofArtifactRaw(canonicalizeJcs(tampered));
    expect(res.badgeState).toBe('VERIFICATION FAILED');
    expect(res.verifierVerdict).toBe('FAIL');
    expect(res.digestMatch).toBe(false);
    expect(res.reasonCodes).toContain('FAIL_DIGEST_MISMATCH');
  });

  it('7. rejects duplicate JSON keys, prototype keys, NUL bytes, non-finite numbers, and -0.0', () => {
    const dupKeyRaw =
      '{"schema_version":"inference-proof.v1","evidence_status":"local_only","evidence_status":"recorded"}';
    const dupRes = evaluateInferenceProofArtifactRaw(dupKeyRaw);
    expect(dupRes.badgeState).toBe('VERIFICATION FAILED');
    expect(dupRes.verifierVerdict).toBe('FAIL');
    expect(dupRes.primaryReasonCode).toBe('FAIL_CANON_DUPLICATE_KEY');

    for (const protoKey of ['__proto__', 'constructor', 'prototype']) {
      const protoRaw = `{"schema_version":"inference-proof.v1","nested":{"${protoKey}":"bad"}}`;
      const protoRes = evaluateInferenceProofArtifactRaw(protoRaw);
      expect(protoRes.badgeState).toBe('VERIFICATION FAILED');
      expect(protoRes.verifierVerdict).toBe('FAIL');
      expect(protoRes.primaryReasonCode).toBe('FAIL_CANON_PROTOTYPE_KEY');
    }

    const nulRaw = '{"schema_version":"inference-proof.v1","run_id":"abc\\u0000def"}';
    const nulRes = evaluateInferenceProofArtifactRaw(nulRaw);
    expect(nulRes.verifierVerdict).toBe('FAIL');
    expect(nulRes.primaryReasonCode).toBe('FAIL_CANON_UNICODE_OR_NUL');

    const negZeroRaw = '{"schema_version":"inference-proof.v1","delta":-0.0}';
    const negZeroRes = evaluateInferenceProofArtifactRaw(negZeroRaw);
    expect(negZeroRes.verifierVerdict).toBe('FAIL');
    expect(negZeroRes.primaryReasonCode).toBe('FAIL_CANON_NEGATIVE_ZERO');

    const nanRaw = '{"schema_version":"inference-proof.v1","delta":NaN}';
    const nanRes = evaluateInferenceProofArtifactRaw(nanRaw);
    expect(nanRes.verifierVerdict).toBe('FAIL');
    expect(nanRes.primaryReasonCode).toBe('FAIL_CANON_NONFINITE_NUMBER');
  });

  it('8. rejects ui_summary contradictions and paired_runs invariant violations even with valid digest', () => {
    const uiContradictionArt = buildSelfContainedInferenceProofFixture({
      evidence_status: 'local_only',
      ui_summary: {
        evidence_status: 'recorded',
        foreign_block_stopped: true,
        clean_equivalence_passed: true,
        allowed_after_fault_completed: true,
        selected_runtime_backend: 'FLASH_ATTN',
        gpu_model: 'NVIDIA H200',
        tp_size: 1,
        ttft_delta_pct: 1.25,
      },
    });
    const uiRes = evaluateInferenceProofArtifactRaw(JSON.stringify(uiContradictionArt));
    expect(uiRes.badgeState).toBe('VERIFICATION FAILED');
    expect(uiRes.verifierVerdict).toBe('FAIL');
    expect(uiRes.digestMatch).toBe(true);
    expect(uiRes.reasonCodes).toContain('FAIL_UI_SUMMARY_CONTRADICTION');

    // Paired-run violation: foreign block entered dispatch under Vervain arm
    const base = buildSelfContainedInferenceProofFixture();
    const badPaired = structuredClone(base);
    const vf = (badPaired['paired_runs'] as Record<string, Record<string, unknown>>)[
      'vervain_fault_injected'
    ]!;
    vf['entered_attention_dispatch'] = true;
    vf['outcome'] = 'contaminated_control_completed';
    badPaired['artifact_sha256'] = computeInferenceProofSha256(badPaired);

    const badPairedRes = evaluateInferenceProofArtifactRaw(JSON.stringify(badPaired));
    expect(badPairedRes.badgeState).toBe('VERIFICATION FAILED');
    expect(badPairedRes.verifierVerdict).toBe('FAIL');
    expect(badPairedRes.reasonCodes).toContain('FAIL_VIOLATION_ENTERED_DISPATCH');
  });

  it('9. rejects forbidden keys, secrets, PII, and raw/hex/base64 SYNTHETIC_PLANTED_VALUE with zero echo', () => {
    const plantedHex = Buffer.from(SYNTHETIC_PLANTED_VALUE, 'utf8').toString('hex');
    const plantedB64 = Buffer.from(SYNTHETIC_PLANTED_VALUE, 'utf8').toString('base64');
    const plantedShiftedB64 = Buffer.from(`pad:${SYNTHETIC_PLANTED_VALUE}`, 'utf8').toString(
      'base64',
    );
    const fakeGoogleKey = 'AIzaSyD9exampleSecretTokenValue123456';
    const fakeIp = '192.168.42.17';
    const fakeEmail = 'leak-test@alder-corp.example';

    const leakCases: Array<{
      label: string;
      mutate: (art: Record<string, unknown>) => void;
      expectedCode: string;
      forbiddenEchoes: string[];
    }> = [
      {
        label: 'raw planted value',
        mutate: (art) => {
          (art['exclusions'] as Record<string, unknown>)['limitations'] = [
            `Note: ${SYNTHETIC_PLANTED_VALUE}`,
          ];
        },
        expectedCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
        forbiddenEchoes: [SYNTHETIC_PLANTED_VALUE],
      },
      {
        label: 'hex planted value',
        mutate: (art) => {
          (art['exclusions'] as Record<string, unknown>)['limitations'] = [plantedHex];
        },
        expectedCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
        forbiddenEchoes: [plantedHex, SYNTHETIC_PLANTED_VALUE],
      },
      {
        label: 'base64 planted value',
        mutate: (art) => {
          (art['exclusions'] as Record<string, unknown>)['limitations'] = [plantedB64];
        },
        expectedCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
        forbiddenEchoes: [plantedB64, SYNTHETIC_PLANTED_VALUE],
      },
      {
        label: 'shifted base64 planted value',
        mutate: (art) => {
          (art['exclusions'] as Record<string, unknown>)['limitations'] = [plantedShiftedB64];
        },
        expectedCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
        forbiddenEchoes: [plantedShiftedB64, SYNTHETIC_PLANTED_VALUE],
      },
      {
        label: 'forbidden chunk_text & authorization keys + API key + IPv4 + email',
        mutate: (art) => {
          art['chunk_text'] = 'raw confidential document body';
          art['authorization'] = `Bearer ${fakeGoogleKey}`;
          (art['exclusions'] as Record<string, unknown>)['limitations'] = [
            `host ${fakeIp} contact ${fakeEmail}`,
          ];
        },
        expectedCode: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
        forbiddenEchoes: [
          'raw confidential document body',
          fakeGoogleKey,
          fakeIp,
          fakeEmail,
        ],
      },
    ];

    for (const testCase of leakCases) {
      const mutated = buildSelfContainedInferenceProofFixture();
      testCase.mutate(mutated);
      mutated['artifact_sha256'] = computeInferenceProofSha256(mutated);

      const res = evaluateInferenceProofArtifactRaw(JSON.stringify(mutated));
      expect(res.badgeState, testCase.label).toBe('VERIFICATION FAILED');
      expect(res.verifierVerdict, testCase.label).toBe('FAIL');
      expect(res.sanitizerPassed, testCase.label).toBe(false);
      expect(res.sanitizerFindingsCount, testCase.label).toBeGreaterThan(0);
      expect(res.reasonCodes, testCase.label).toContain(testCase.expectedCode);
      expect(res.runtimeManifest, testCase.label).toBeNull();
      expect(res.exclusions, testCase.label).toEqual([]);

      const serialized = JSON.stringify(res);
      for (const secretStr of testCase.forbiddenEchoes) {
        expect(serialized.toLowerCase()).not.toContain(secretStr.toLowerCase());
      }
    }
  });
});

describe('Open-Weight KV Lifecycle Workbench, Engine Profiles & Enterprise Presets', () => {
  it('10. exposes all 5 engine profiles and all 4 enterprise presets with exact denominators', () => {
    const engines = getOpenWeightEngineProfiles();
    expect(engines.map((e) => e.engineId)).toEqual([
      'vllm',
      'sglang',
      'ollama',
      'dynamo',
      'gemini_api',
    ]);
    expect(engines.find((e) => e.engineId === 'vllm')?.kvAndPrefixSurface).toContain(
      'PagedAttention block_table + APC token hash',
    );
    expect(engines.find((e) => e.engineId === 'sglang')?.kvAndPrefixSurface).toContain(
      'RadixAttention tree cache',
    );
    expect(engines.find((e) => e.engineId === 'ollama')?.kvAndPrefixSurface).toContain(
      'local runner KV slot cache',
    );
    expect(engines.find((e) => e.engineId === 'dynamo')?.kvAndPrefixSurface).toContain(
      'disaggregated prefill/decode KV router',
    );
    const geminiProfile = engines.find((e) => e.engineId === 'gemini_api');
    expect(geminiProfile?.kvAndPrefixSurface).toContain(
      'outbound context envelope + release epoch gate',
    );
    expect(geminiProfile?.demoEvidenceStatus).toBe('active_in_this_app');

    const presets = getEnterprisePresets();
    expect(presets.map((p) => p.presetId)).toEqual([
      'northstar_commercial',
      'neocloud_shared_gpu',
      'institutional_mnpi_wall',
      'clinical_care_triage',
    ]);
    for (const preset of presets) {
      expect(preset.retrievedDenominator).toBeGreaterThanOrEqual(2);
      expect(preset.admittedCount).toBeGreaterThanOrEqual(1);
      expect(preset.withheldCount).toBeGreaterThanOrEqual(1);
      expect(preset.admittedCount + preset.withheldCount).toBe(preset.retrievedDenominator);
    }
  });

  it('11. separates HMAC-salted prefix hashes across Alder vs Beacon and across epoch 7 vs epoch 8', () => {
    const unsaltedAlder = computeUnsaltedPrefixCacheHash(SHARED_SYSTEM_PREFIX_TOKENS);
    const unsaltedBeacon = computeUnsaltedPrefixCacheHash(SHARED_SYSTEM_PREFIX_TOKENS);
    expect(unsaltedAlder).toBe(unsaltedBeacon);
    expect(unsaltedAlder).toMatch(/^[0-9a-f]{64}$/);

    const saltedAlderEpoch7 = computeSaltedPrefixCacheHash(SHARED_SYSTEM_PREFIX_TOKENS, {
      tenantId: 'tenant_alder',
      requestScopeTag: TENANT_FIXTURES.alder.requestScopeTag,
      policyEpoch: 7,
    });
    const saltedAlderEpoch8 = computeSaltedPrefixCacheHash(SHARED_SYSTEM_PREFIX_TOKENS, {
      tenantId: 'tenant_alder',
      requestScopeTag: TENANT_FIXTURES.alder.requestScopeTag,
      policyEpoch: 8,
    });
    const saltedBeaconEpoch11 = computeSaltedPrefixCacheHash(SHARED_SYSTEM_PREFIX_TOKENS, {
      tenantId: 'tenant_beacon',
      requestScopeTag: TENANT_FIXTURES.beacon.requestScopeTag,
      policyEpoch: 11,
    });

    expect(saltedAlderEpoch7).toMatch(/^[0-9a-f]{64}$/);
    expect(saltedAlderEpoch7).not.toBe(unsaltedAlder);
    expect(saltedAlderEpoch7).not.toBe(saltedBeaconEpoch11);
    expect(saltedAlderEpoch7).not.toBe(saltedAlderEpoch8);
  });

  it('12. executes all 4 KV lifecycle modes deterministically for Alder and Beacon with <= 1e-12 equivalence', () => {
    for (const persona of ['alder', 'beacon'] as const) {
      const fixture = TENANT_FIXTURES[persona];
      const wb = buildOpenWeightKvWorkbenchForSession({
        persona: fixture.persona,
        tenantId: fixture.tenantId,
        tenantLabel: fixture.tenantLabel,
        policyEpoch: fixture.initialPolicyEpoch,
        requestScopeTag: fixture.requestScopeTag,
      });

      expect(wb.zeroForeignKvReadsVerified).toBe(true);
      expect(wb.kvModes.map((m) => m.modeId)).toEqual([
        'contaminated_block_table',
        'prefix_cache_hash_collision',
        'stale_allocation_generation',
        'online_tiled_flash_recurrence',
      ]);

      for (const mode of wb.kvModes) {
        expect(mode.unguardedForeignMass).toBeGreaterThan(0.3);
        expect(mode.governedForeignMass).toBe(0);
        expect(mode.maxOutputDeltaVsCleanTwin).toBeLessThanOrEqual(1e-12);
        expect(mode.prefixHashUnguardedHex).not.toBe(mode.prefixHashSaltedHex);
      }
    }
  });

  it('13. rejects ABA stale generation (4 != 5) before KV read with Proxy-verified 0 reads', () => {
    const ownScope = TENANT_FIXTURES.alder.requestScopeTag;
    const instrumented = createProxyInstrumentedKvPool({
      blockSize: 2,
      headDim: 4,
      keys: [
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
      ],
      values: [
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
      ],
      // Physical block #1 has matching scopeTag (ABA intra-tenant reuse!) at generation 5
      blockScopeTags: [ownScope, ownScope, ownScope, ownScope],
      blockGenerations: [2, 5, 3, 6],
    });

    const abaRun = runOnlineTiledFlashAttention({
      query: [1.0, 0.6, 0.1, 0.5],
      blockTable: [0, 1, 2, 3],
      expectedGenerations: [2, 4, 3, 6], // Stale descriptor cites generation 4 != 5
      validityMask: [
        [true, true],
        [true, true],
        [true, true],
        [true, false],
      ],
      requestScopeTag: ownScope,
      enforceHeaderGuard: true,
      instrumented,
    });

    const step1 = abaRun.steps[1]!;
    expect(step1.headerCheckDisposition).toBe('skipped_stale_generation_zero_kv_read');
    expect(step1.allocationGeneration).toBe(5);
    expect(step1.expectedGeneration).toBe(4);
    expect(step1.kvTensorReadsPerformed).toBe(0);
    expect(instrumented.getScalarReadsForBlock(1)).toBe(0);
    expect(instrumented.getTouchesForBlock(1)).toBe(0);
  });

  it('14. verifies Proxy 0 foreign KV reads and <= 1e-12 online (m_i, l_i, O_i) equivalence vs reference PagedAttention', () => {
    const alder = TENANT_FIXTURES.alder;
    const wb = buildOpenWeightKvWorkbenchForSession({
      persona: alder.persona,
      tenantId: alder.tenantId,
      tenantLabel: alder.tenantLabel,
      policyEpoch: alder.initialPolicyEpoch,
      requestScopeTag: alder.requestScopeTag,
    });

    expect(wb.onlineTileSteps).toHaveLength(4);
    expect(wb.onlineTileSteps.map((s) => s.headerCheckDisposition)).toEqual([
      'loaded_authorized_tile',
      'skipped_foreign_scope_zero_kv_read',
      'loaded_authorized_tile',
      'loaded_authorized_tile',
    ]);
    // Exact scalar K+V element reads: 2*2*4=16 on block 0, 0 on foreign block 1, 16 on block 2, 1*2*4=8 on half-filled tail block 3
    expect(wb.onlineTileSteps.map((s) => s.kvTensorReadsPerformed)).toEqual([16, 0, 16, 8]);

    // Running state stays identical across skipped foreign tile step 1
    expect(wb.onlineTileSteps[1]!.runningMaxLogitM).toBe(wb.onlineTileSteps[0]!.runningMaxLogitM);
    expect(wb.onlineTileSteps[1]!.runningDenomL).toBe(wb.onlineTileSteps[0]!.runningDenomL);
    expect(wb.onlineTileSteps[1]!.runningNormalizedOutput).toEqual(
      wb.onlineTileSteps[0]!.runningNormalizedOutput,
    );

    // Compare final online normalized output directly against unrounded clean reference PagedAttention
    const cleanRef = runReferencePagedAttention({
      query: [1.0, 0.6, 0.1, 0.5],
      blockTable: [0, 2, 3],
      validityMask: [
        [true, true],
        [true, true],
        [true, false],
      ],
      requestScopeTag: alder.requestScopeTag,
      enforceScopeMask: true,
      pool: {
        blockSize: 2,
        headDim: 4,
        keys: [
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
        ],
        values: [
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
        ],
        blockScopeTags: [
          alder.requestScopeTag,
          TENANT_FIXTURES.beacon.requestScopeTag,
          alder.requestScopeTag,
          alder.requestScopeTag,
        ],
      },
    });

    const finalOnlineOut = wb.onlineTileSteps[3]!.runningNormalizedOutput;
    for (let dim = 0; dim < 4; dim += 1) {
      expect(Math.abs(finalOnlineOut[dim]! - cleanRef.output[dim]!)).toBeLessThanOrEqual(1e-12);
    }

    const sessionProof = buildScopedAttentionProofForSession(alder);
    expect(sessionProof.limitationBanner).toBe(SCOPED_ATTENTION_LIMITATION_LABEL);
    expect(OPEN_WEIGHT_WORKBENCH_LIMITATION_LABEL).toBe(SCOPED_ATTENTION_LIMITATION_LABEL);
  });

  it('15. enforces copy and claim discipline (zero em dashes and zero banned claim terms) across owned files and outputs', () => {
    const emDash = String.fromCharCode(0x2014);
    const prohibitedRegexes = (
      [
        ['pro', 'ves'],
        ['guaran', 'tees'],
        ['compli', 'ant'],
        ['certi', 'fied'],
        ['unhack', 'able'],
        ['sec', 'ure'],
        ['leak-', 'proof'],
        ['controls all ', 'prompts'],
        ['sees hidden ', 'reasoning'],
        ['stops all prompt ', 'injection'],
      ] as const
    ).map(([a, b]) => {
      const body = `${a}${b}`
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+');
      return new RegExp(`\\b${body}\\b`, 'i');
    });

    const ownedFiles = [
      path.join(REPO_ROOT, 'src', 'server', 'inference-proof.ts'),
      path.join(REPO_ROOT, 'src', 'server', 'open-weight-workbench.ts'),
      path.join(REPO_ROOT, 'tests', 'unit', 'inference-proof-and-kv-lifecycle.test.ts'),
    ];

    for (const filePath of ownedFiles) {
      const source = fs.readFileSync(filePath, 'utf8');
      expect(source.includes(emDash), `em dash in ${filePath}`).toBe(false);
      for (const re of prohibitedRegexes) {
        expect(re.exec(source), `prohibited term ${re} in ${filePath}`).toBeNull();
      }
    }

    const runtimeSerialized = JSON.stringify({
      defaultProof: loadConfiguredInferenceProofStatus(),
      evaluatedProof: evaluateInferenceProofArtifactRaw(
        JSON.stringify(buildSelfContainedInferenceProofFixture()),
      ),
      presets: getEnterprisePresets(),
      engines: getOpenWeightEngineProfiles(),
      workbench: buildOpenWeightKvWorkbenchForSession({
        persona: TENANT_FIXTURES.alder.persona,
        tenantId: TENANT_FIXTURES.alder.tenantId,
        tenantLabel: TENANT_FIXTURES.alder.tenantLabel,
        policyEpoch: TENANT_FIXTURES.alder.initialPolicyEpoch,
        requestScopeTag: TENANT_FIXTURES.alder.requestScopeTag,
      }),
    });

    expect(runtimeSerialized.includes(emDash)).toBe(false);
    for (const re of prohibitedRegexes) {
      expect(re.exec(runtimeSerialized)).toBeNull();
    }
  });
});
