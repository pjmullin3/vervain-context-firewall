/**
 * Responsibility: Wave 3 adversarial red-team tests targeting `/api/inference-proof`,
 * `/api/demo/enterprise-architecture`, enriched `/api/demo/scoped-attention` KV lifecycle modes
 * and epoch-bound prefix-cache salting, filesystem/signature fail-closed paths in
 * `loadConfiguredInferenceProofStatus`, and parser/canonicalizer/status-laundering/zero-echo
 * sanitizer attacks on `evaluateInferenceProofArtifactRaw`.
 * Trust boundary: Exercises untrusted wire HTTP, filesystem, and JSON artifact boundaries.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCOPED_ATTENTION_LIMITATION_LABEL } from '../../src/shared/config.js';
import type {
  DemoStateResponse,
  EnterpriseArchitectureResponse,
  InferenceProofStatusView,
  ScopedAttentionProofView,
} from '../../src/shared/contracts.js';
import { API_ERROR_CODES } from '../../src/shared/reason-codes.js';
import { createAppInstance, type AppInstance } from '../../src/server/app.js';
import { loadServerConfig } from '../../src/server/config.js';
import { SYNTHETIC_PLANTED_VALUE } from '../../src/server/fixture.js';
import {
  DeterministicMockGeminiTransport,
  SpyGeminiTransport,
} from '../../src/server/gemini.js';
import {
  INFERENCE_PROOF_NO_ARTIFACT_CLAIM_BOUNDARY,
  computeInferenceProofSha256,
  evaluateInferenceProofArtifactRaw,
  loadConfiguredInferenceProofStatus,
} from '../../src/server/inference-proof.js';
import {
  createProxyInstrumentedKvPool,
  runOnlineTiledFlashAttention,
} from '../../src/server/open-weight-workbench.js';

const TEST_SESSION_SECRET = 'adversarial_wave3_redteam_secret_32bytes!';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);
const HEX_D = 'd'.repeat(64);
const HEX_E = 'e'.repeat(64);
const HEX_F = 'f'.repeat(64);
const GIT_SHA_1 = '1'.repeat(40);
const GIT_SHA_2 = '2'.repeat(40);

interface RunningTestHarness {
  baseUrl: string;
  port: number;
  spy: SpyGeminiTransport;
  app: AppInstance;
  advanceTimeMs: (deltaMs: number) => void;
}

let activeServer: AppInstance['server'] | null = null;
const tempDirsToClean: string[] = [];

function createTempDir(prefix = 'vervain-wave3-adv-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirsToClean.push(dir);
  return dir;
}

async function startHarness(overrides?: Record<string, string>): Promise<RunningTestHarness> {
  let currentNowMs = 1_763_120_000_000;
  const spy = new SpyGeminiTransport(new DeterministicMockGeminiTransport());
  const config = loadServerConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'mock',
    SESSION_SECRET: TEST_SESSION_SECRET,
    SESSION_TTL_MS: '60000',
    MAX_GEMINI_CALLS_PER_SESSION: '40',
    MAX_GEMINI_CALLS_PER_WINDOW: '120',
    RATE_LIMIT_MUTATIONS_PER_MINUTE: '100',
    ...overrides,
  });

  const app = createAppInstance({
    config,
    transport: spy,
    nowFn: () => currentNowMs,
    sleepFn: async () => {},
    emitLogsToStdout: false,
  });
  activeServer = app.server;

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (app.server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    spy,
    app,
    advanceTimeMs: (deltaMs: number) => {
      currentNowMs += deltaMs;
    },
  };
}

afterEach(async () => {
  if (activeServer) {
    const srv = activeServer;
    activeServer = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirsToClean.length > 0) {
    const dir = tempDirsToClean.pop();
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup for chmod tests
      }
    }
  }
});

async function createPersonaCookie(baseUrl: string, persona: 'alder' | 'beacon'): Promise<string> {
  const res = await fetch(`${baseUrl}/api/demo/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  expect(res.status).toBe(200);
  const rawSetCookie = res.headers.get('set-cookie') ?? '';
  return rawSetCookie.split(';')[0] ?? '';
}

async function sendRawWireRequest(params: {
  port: number;
  method: string;
  requestTarget: string;
  headerLines: readonly string[];
  body?: string;
}): Promise<{ statusCode: number; headersRaw: string; bodyText: string }> {
  const bodyBuf = Buffer.from(params.body ?? '', 'utf8');
  const lines = [
    `${params.method} ${params.requestTarget} HTTP/1.1`,
    `Host: 127.0.0.1:${params.port}`,
    'Connection: close',
    ...params.headerLines,
  ];
  if (params.body !== undefined) {
    lines.push(`Content-Length: ${bodyBuf.length}`);
  }
  const headBuf = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');
  const payload = Buffer.concat([headBuf, bodyBuf]);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ host: '127.0.0.1', port: params.port }, () => {
      socket.write(payload);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const full = Buffer.concat(chunks).toString('utf8');
      const sepIdx = full.indexOf('\r\n\r\n');
      const headersRaw = sepIdx >= 0 ? full.slice(0, sepIdx) : full;
      const bodyText = sepIdx >= 0 ? full.slice(sepIdx + 4) : '';
      const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(headersRaw);
      const statusCode = statusMatch ? Number.parseInt(statusMatch[1]!, 10) : 0;
      resolve({ statusCode, headersRaw, bodyText });
    });
  });
}

function buildBaselineValidInferenceProof(
  overrides?: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  const runId = 'run-wave3-h200-baseline-001';
  const base: Record<string, unknown> = {
    schema_version: 'inference-proof.v1',
    evidence_status: 'recorded',
    run_id: runId,
    started_at: '2026-11-14T12:00:00Z',
    finished_at: '2026-11-14T12:00:18Z',
    source: {
      git_sha: GIT_SHA_1,
      git_dirty: false,
      vllm_sha: GIT_SHA_2,
      patch_sha256: HEX_A,
      patch_path: 'engine/patches/vllm-scoped-kv-firewall.patch',
      loaded_modules: [
        {
          module_name: 'vervain_scope.backend_guard',
          file_path: 'vervain_scope/backend_guard.py',
          file_sha256: HEX_B,
        },
      ],
      trace_sha256: HEX_C,
    },
    runtime_manifest: {
      gpu_model: 'NVIDIA H200',
      gpu_count: 1,
      gpu_uuids_sha256: [HEX_D],
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
      model_revision: 'rev-20261114',
      tokenizer_revision: 'tok-20261114',
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
      host_id_digest: HEX_E,
      nccl_version: '2.23.4',
      nccl_transport_digest: HEX_F,
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
        config_digest: HEX_A,
        started_at: '2026-11-14T12:00:02Z',
        finished_at: '2026-11-14T12:00:03Z',
        outcome: 'completed',
        output_sha256: HEX_B,
        entered_attention_dispatch: true,
        foreign_block_injected: false,
        referenced_blocks: [{ physical_block_alias: 'blk-birch-001', allocation_generation: 2 }],
        ranks: [
          {
            rank_id: 0,
            worker_id: 'worker-r0',
            gpu_uuid_sha256: HEX_D,
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
        config_digest: HEX_A,
        started_at: '2026-11-14T12:00:04Z',
        finished_at: '2026-11-14T12:00:05Z',
        outcome: 'contaminated_control_completed',
        output_sha256: HEX_C,
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
            gpu_uuid_sha256: HEX_D,
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
        config_digest: HEX_A,
        started_at: '2026-11-14T12:00:06Z',
        finished_at: '2026-11-14T12:00:07Z',
        outcome: 'completed',
        output_sha256: HEX_B,
        entered_attention_dispatch: true,
        foreign_block_injected: false,
        referenced_blocks: [{ physical_block_alias: 'blk-birch-001', allocation_generation: 2 }],
        ranks: [
          {
            rank_id: 0,
            worker_id: 'worker-r0',
            gpu_uuid_sha256: HEX_D,
            loaded_patch_sha256: HEX_A,
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
        config_digest: HEX_A,
        started_at: '2026-11-14T12:00:08Z',
        finished_at: '2026-11-14T12:00:09Z',
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
            gpu_uuid_sha256: HEX_D,
            loaded_patch_sha256: HEX_A,
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
        config_digest: HEX_A,
        started_at: '2026-11-14T12:00:10Z',
        finished_at: '2026-11-14T12:00:11Z',
        outcome: 'completed',
        output_sha256: HEX_B,
        entered_attention_dispatch: true,
        foreign_block_injected: false,
        referenced_blocks: [{ physical_block_alias: 'blk-birch-001', allocation_generation: 2 }],
        ranks: [
          {
            rank_id: 0,
            worker_id: 'worker-r0',
            gpu_uuid_sha256: HEX_D,
            loaded_patch_sha256: HEX_A,
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
        decided_at: '2026-11-14T12:00:06Z',
        envelope_issued_at: '2026-11-14T11:59:50Z',
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
        decided_at: '2026-11-14T12:00:08Z',
        envelope_issued_at: '2026-11-14T11:59:50Z',
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
        decided_at: '2026-11-14T12:00:10Z',
        envelope_issued_at: '2026-11-14T11:59:50Z',
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
        cache_key_digest: HEX_E,
        rank_id: 0,
        transitions: [
          {
            seq: 0,
            from_state: 'none',
            to_state: 'free',
            allocation_generation: 1,
            owner_scope: 'UNASSIGNED',
            policy_epoch: 0,
            transitioned_at: '2026-11-14T12:00:00Z',
            correlation_id: 'corr-0',
          },
          {
            seq: 1,
            from_state: 'free',
            to_state: 'readable',
            allocation_generation: 2,
            owner_scope: 'scope:birch',
            policy_epoch: 1,
            transitioned_at: '2026-11-14T12:00:01Z',
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
        checked_at: '2026-11-14T12:00:08Z',
        decision_ref: 'dec-vf-r0-foreign',
      },
    ],
    correctness: {
      seed: 42,
      config_digest: HEX_A,
      equivalence_tolerance: 1e-5,
      measured_max_abs_delta: 0,
      clean_equivalence_passed: true,
      planted_value_influence_probe: {
        probe_id: 'probe-01',
        planted_value_sha256: HEX_F,
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
      genesis_sha256: HEX_A,
      head_sha256: HEX_C,
      event_count: 2,
      events: [
        {
          event_index: 0,
          run_id: runId,
          request_id: 'req-nc-01',
          event_type: 'arm_native_clean',
          recorded_at: '2026-11-14T12:00:03Z',
          prev_sha256: HEX_A,
          event_sha256: HEX_B,
          canonical_event_sha256: HEX_B,
        },
        {
          event_index: 1,
          run_id: runId,
          request_id: 'req-vf-04',
          event_type: 'arm_vervain_fault_injected',
          recorded_at: '2026-11-14T12:00:09Z',
          prev_sha256: HEX_B,
          event_sha256: HEX_C,
          canonical_event_sha256: HEX_C,
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

describe('Wave 3 Adversarial: HTTP Session Auth, Query Smuggling, Method Guards & Pre-GPU-GO Honesty', () => {
  const wave2Routes = ['/api/inference-proof', '/api/demo/enterprise-architecture'] as const;

  it('1. rejects unauthenticated, malformed, tampered, and expired sessions on /api/inference-proof and /api/demo/enterprise-architecture', async () => {
    const { baseUrl, advanceTimeMs } = await startHarness();
    const alderCookie = await createPersonaCookie(baseUrl, 'alder');
    const rawToken = alderCookie.slice('vervain_cf_sid='.length);
    const [sid, mac] = rawToken.split('.') as [string, string];
    const forgedMac = crypto
      .createHmac('sha256', 'attacker_wrong_session_secret_32b_min!')
      .update(`vervain.session.v1:${sid}`, 'utf8')
      .digest('hex');

    const invalidCookieHeaders: ReadonlyArray<string | null> = [
      null,
      '',
      'vervain_cf_sid=',
      `vervain_cf_sid=${sid}`,
      `vervain_cf_sid=${sid}.${forgedMac}`,
      `vervain_cf_sid=${sid}.${mac.slice(0, 62)}00`,
    ];

    for (const route of wave2Routes) {
      for (const badCookie of invalidCookieHeaders) {
        const res = await fetch(`${baseUrl}${route}`, {
          headers: badCookie !== null ? { Cookie: badCookie } : {},
        });
        expect(res.status, `${route} cookie=${String(badCookie)}`).toBe(401);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe(API_ERROR_CODES.INVALID_SESSION);
        expect(JSON.stringify(body)).not.toContain('presets');
        expect(JSON.stringify(body)).not.toContain('badgeState');
      }
    }

    // Create one fresh cookie per Wave 2 route before advancing clock past 60s TTL
    // (resolveCookieToken prunes an expired session on first touch, returning session_expired
    // on first probe and invalid_session on subsequent replay).
    const expCookieProof = await createPersonaCookie(baseUrl, 'alder');
    const expCookieArch = await createPersonaCookie(baseUrl, 'beacon');
    advanceTimeMs(60_001);

    for (const [route, expCookie] of [
      ['/api/inference-proof', expCookieProof],
      ['/api/demo/enterprise-architecture', expCookieArch],
    ] as const) {
      const expiredRes = await fetch(`${baseUrl}${route}`, {
        headers: { Cookie: expCookie },
      });
      expect(expiredRes.status).toBe(401);
      const expiredBody = (await expiredRes.json()) as { error: { code: string } };
      expect(expiredBody.error.code).toBe(API_ERROR_CODES.SESSION_EXPIRED);

      // Replaying the pruned cookie fails closed with 401 invalid_session
      const replayRes = await fetch(`${baseUrl}${route}`, {
        headers: { Cookie: expCookie },
      });
      expect(replayRes.status).toBe(401);
      const replayBody = (await replayRes.json()) as { error: { code: string } };
      expect(replayBody.error.code).toBe(API_ERROR_CODES.INVALID_SESSION);
    }
  });

  it('2. rejects query-parameter smuggling, authority query/header overrides, and duplicate Cookie headers with 400', async () => {
    const { baseUrl, port } = await startHarness();
    const alderCookie = await createPersonaCookie(baseUrl, 'alder');
    const beaconCookie = await createPersonaCookie(baseUrl, 'beacon');

    const authorityQuerySmuggling = [
      'tenant_id=beacon',
      'scope=1',
      'request_scope=0x00beac11',
      'policy_epoch=99',
      'principal=principal:beacon-operator',
      'x_tenant=tenant_beacon',
    ];

    const configAndPresetSmuggling = [
      'artifactPath=/etc/passwd',
      'trustRoot=/tmp/x',
      'preset=neocloud_shared_gpu',
      'foo=bar',
      'pythonVerifierSrc=/tmp/attacker',
      'requireSignature=0',
    ];

    for (const route of wave2Routes) {
      for (const qs of authorityQuerySmuggling) {
        const res = await fetch(`${baseUrl}${route}?${qs}`, {
          headers: { Cookie: alderCookie },
        });
        expect(res.status, `${route}?${qs}`).toBe(400);
        const err = (await res.json()) as { error: { code: string } };
        expect(err.error.code).toBe(API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED);
      }

      for (const qs of configAndPresetSmuggling) {
        const res = await fetch(`${baseUrl}${route}?${qs}`, {
          headers: { Cookie: alderCookie },
        });
        expect(res.status, `${route}?${qs}`).toBe(400);
        const err = (await res.json()) as { error: { code: string } };
        expect([
          API_ERROR_CODES.UNKNOWN_FIELD,
          API_ERROR_CODES.INVALID_REQUEST,
          API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED,
        ]).toContain(err.error.code);
      }

      // Authority override headers on GET must also be rejected with 400
      for (const [hdr, val] of [
        ['X-Tenant', 'tenant_beacon'],
        ['X-Scope', '1'],
        ['X-Policy-Epoch', '99'],
      ] as const) {
        const hdrRes = await fetch(`${baseUrl}${route}`, {
          headers: { Cookie: alderCookie, [hdr]: val },
        });
        expect(hdrRes.status).toBe(400);
        const hdrErr = (await hdrRes.json()) as { error: { code: string } };
        expect(hdrErr.error.code).toBe(API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED);
      }

      // Raw TCP duplicate Cookie header smuggling must be rejected with 400
      const dupCookieWire = await sendRawWireRequest({
        port,
        method: 'GET',
        requestTarget: route,
        headerLines: [`Cookie: ${alderCookie}`, `cOoKiE: ${beaconCookie}`],
      });
      expect(dupCookieWire.statusCode).toBe(400);
      expect(JSON.parse(dupCookieWire.bodyText)).toMatchObject({
        error: { code: API_ERROR_CODES.AMBIGUOUS_JSON_PAYLOAD },
      });
    }
  });

  it('3. rejects wrong HTTP methods (POST, PUT, DELETE, PATCH, OPTIONS) on Wave 2 endpoints with 405 method_not_allowed', async () => {
    const { baseUrl } = await startHarness();
    const alderCookie = await createPersonaCookie(baseUrl, 'alder');
    const wrongMethods = ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const;

    for (const route of wave2Routes) {
      for (const method of wrongMethods) {
        const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
        const res = await fetch(`${baseUrl}${route}`, {
          method,
          headers: {
            Cookie: alderCookie,
            ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(hasBody ? { body: '{}' } : {}),
        });
        expect(res.status, `${method} ${route}`).toBe(405);
        const err = (await res.json()) as { error: { code: string } };
        expect(err.error.code).toBe(API_ERROR_CODES.METHOD_NOT_ALLOWED);
      }
    }
  });

  it('4. reports NO GPU RUN RECORDED / NOT_CONFIGURED / runtimeManifest: null with zero fake H200 telemetry prior to GPU GO', async () => {
    const { baseUrl } = await startHarness();
    const alderCookie = await createPersonaCookie(baseUrl, 'alder');
    const beaconCookie = await createPersonaCookie(baseUrl, 'beacon');

    for (const cookie of [alderCookie, beaconCookie]) {
      const [proofRes, archRes] = await Promise.all([
        fetch(`${baseUrl}/api/inference-proof`, { headers: { Cookie: cookie } }),
        fetch(`${baseUrl}/api/demo/enterprise-architecture`, { headers: { Cookie: cookie } }),
      ]);
      expect(proofRes.status).toBe(200);
      expect(archRes.status).toBe(200);

      const proofBody = (await proofRes.json()) as InferenceProofStatusView;
      const archBody = (await archRes.json()) as EnterpriseArchitectureResponse;

      for (const status of [proofBody, archBody.inferenceProof]) {
        expect(status.badgeState).toBe('NO GPU RUN RECORDED');
        expect(status.verifierVerdict).toBe('NOT_CONFIGURED');
        expect(status.primaryReasonCode).toBe('NO_ARTIFACT_CONFIGURED');
        expect(status.reasonCodes).toEqual(['NO_ARTIFACT_CONFIGURED']);
        expect(status.claimedEvidenceStatus).toBe('none');
        expect(status.verifiedEvidenceStatus).toBe('none');
        expect(status.runId).toBeNull();
        expect(status.artifactSha256Declared).toBeNull();
        expect(status.artifactSha256Computed).toBeNull();
        expect(status.digestMatch).toBeNull();
        expect(status.runtimeManifest).toBeNull();
        expect(status.exclusions).toEqual([]);
        expect(status.claimBoundary).toBe(INFERENCE_PROOF_NO_ARTIFACT_CLAIM_BOUNDARY);

        const serializedStatus = JSON.stringify(status);
        expect(serializedStatus).not.toContain('NVIDIA H200');
        expect(serializedStatus).not.toContain('LIVE H200 RUN');
        expect(serializedStatus).not.toContain('RECORDED H200 RUN');
        expect(serializedStatus).not.toContain('FLASH_ATTN');
        expect(serializedStatus).not.toContain('PASS_VERIFIED');
      }

      // Enterprise architecture response must carry explicit limitation banner and honest engine statuses
      expect(archBody.limitationNote).toBe(SCOPED_ATTENTION_LIMITATION_LABEL);
      expect(archBody.presets).toHaveLength(4);
      expect(archBody.engineProfiles).toHaveLength(5);
      for (const profile of archBody.engineProfiles) {
        if (profile.engineId === 'gemini_api') {
          expect(profile.demoEvidenceStatus).toBe('active_in_this_app');
        } else {
          expect(profile.demoEvidenceStatus).toBe('reference_simulation_only');
        }
      }
    }
  });
});

describe('Wave 3 Adversarial: Server-Bound KV Lifecycle, Prefix Salt Epoch Rotation & Zero-KV-Read Tile Invariants', () => {
  it('5. binds kvModes, onlineTileSteps, and prefixHashSaltedHex strictly to server session and rotates prefixHashSaltedHex on epoch 7 -> 8', async () => {
    const { baseUrl, app } = await startHarness();

    // Force identical principalDisplay across Alder and Beacon to confirm display strings never drive cache salt
    const sharedDisplay = 'collision-probe@shared.example';
    const alderSession = app.context.sessionStore.createOrRotateSession(
      'alder',
      null,
      sharedDisplay,
    );
    const beaconSession = app.context.sessionStore.createOrRotateSession(
      'beacon',
      null,
      sharedDisplay,
    );
    const alderCookie = `${app.context.config.sessionCookieName}=${alderSession.cookieToken}`;
    const beaconCookie = `${app.context.config.sessionCookieName}=${beaconSession.cookieToken}`;

    const [alderEpoch7Res, beaconRes] = await Promise.all([
      fetch(`${baseUrl}/api/demo/scoped-attention`, { headers: { Cookie: alderCookie } }),
      fetch(`${baseUrl}/api/demo/scoped-attention`, { headers: { Cookie: beaconCookie } }),
    ]);
    expect(alderEpoch7Res.status).toBe(200);
    expect(beaconRes.status).toBe(200);

    const alderEpoch7 = (await alderEpoch7Res.json()) as ScopedAttentionProofView;
    const beaconEpoch11 = (await beaconRes.json()) as ScopedAttentionProofView;

    expect(alderEpoch7.requestScopeHex).toBe('0x00a1de07');
    expect(beaconEpoch11.requestScopeHex).toBe('0x00beac11');
    expect(alderEpoch7.kvModes).toHaveLength(4);
    expect(beaconEpoch11.kvModes).toHaveLength(4);
    expect(alderEpoch7.onlineTileSteps).toHaveLength(4);
    expect(beaconEpoch11.onlineTileSteps).toHaveLength(4);

    const alderSaltEpoch7 = alderEpoch7.kvModes![0]!.prefixHashSaltedHex;
    const alderUnguardedEpoch7 = alderEpoch7.kvModes![0]!.prefixHashUnguardedHex;
    const beaconSaltEpoch11 = beaconEpoch11.kvModes![0]!.prefixHashSaltedHex;
    const beaconUnguardedEpoch11 = beaconEpoch11.kvModes![0]!.prefixHashUnguardedHex;

    expect(alderUnguardedEpoch7).toMatch(/^[0-9a-f]{64}$/);
    expect(alderSaltEpoch7).toMatch(/^[0-9a-f]{64}$/);
    expect(beaconSaltEpoch11).toMatch(/^[0-9a-f]{64}$/);

    // Un-salted APC digest collides across Alder and Beacon; HMAC-salted digest separates them
    expect(alderUnguardedEpoch7).toBe(beaconUnguardedEpoch11);
    expect(alderSaltEpoch7).not.toBe(beaconSaltEpoch11);

    for (const mode of alderEpoch7.kvModes!) {
      expect(mode.prefixHashUnguardedHex).toBe(alderUnguardedEpoch7);
      expect(mode.prefixHashSaltedHex).toBe(alderSaltEpoch7);
      expect(mode.governedForeignMass).toBe(0);
      expect(mode.unguardedForeignMass).toBeGreaterThan(0);
      expect(mode.maxOutputDeltaVsCleanTwin).toBeLessThanOrEqual(1e-12);
    }

    // Advance Alder policy epoch 7 -> 8 via POST /api/demo/revoke-during-generation
    const revokeRes = await fetch(`${baseUrl}/api/demo/revoke-during-generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alderCookie },
      body: '{}',
    });
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as {
      session: DemoStateResponse['session'];
      run: NonNullable<DemoStateResponse['latestSingleRun']>;
    };
    expect(revokeBody.session.policyEpoch).toBe(8);
    expect(revokeBody.run.policyEpochAtAdmission).toBe(7);
    expect(revokeBody.run.policyEpochAtRelease).toBe(8);
    expect(revokeBody.run.releaseDecision).toBe('withheld');

    // Subsequent GET /api/demo/scoped-attention must rotate Alder's prefixHashSaltedHex for epoch 8
    const [alderEpoch8Res, beaconAfterRes] = await Promise.all([
      fetch(`${baseUrl}/api/demo/scoped-attention`, { headers: { Cookie: alderCookie } }),
      fetch(`${baseUrl}/api/demo/scoped-attention`, { headers: { Cookie: beaconCookie } }),
    ]);
    const alderEpoch8 = (await alderEpoch8Res.json()) as ScopedAttentionProofView;
    const beaconAfter = (await beaconAfterRes.json()) as ScopedAttentionProofView;

    const alderSaltEpoch8 = alderEpoch8.kvModes![0]!.prefixHashSaltedHex;
    expect(alderSaltEpoch8).toMatch(/^[0-9a-f]{64}$/);
    expect(alderSaltEpoch8).not.toBe(alderSaltEpoch7);
    expect(alderSaltEpoch8).not.toBe(beaconSaltEpoch11);
    expect(alderEpoch8.kvModes![0]!.prefixHashUnguardedHex).toBe(alderUnguardedEpoch7);

    // Beacon's concurrent session salt must be untouched by Alder's epoch rotation
    expect(beaconAfter.kvModes![0]!.prefixHashSaltedHex).toBe(beaconSaltEpoch11);

    // Resetting Alder restores epoch 7 and deterministically reproduces the epoch-7 salted digest
    const resetRes = await fetch(`${baseUrl}/api/demo/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: alderCookie },
      body: '{}',
    });
    expect(resetRes.status).toBe(200);
    const alderPostReset = (await (
      await fetch(`${baseUrl}/api/demo/scoped-attention`, { headers: { Cookie: alderCookie } })
    ).json()) as ScopedAttentionProofView;
    expect(alderPostReset.kvModes![0]!.prefixHashSaltedHex).toBe(alderSaltEpoch7);
  });

  it('6. enforces kvTensorReadsPerformed === 0 on every foreign-scope and stale-generation tile over HTTP and direct Proxy pools', async () => {
    const { baseUrl } = await startHarness();
    const alderCookie = await createPersonaCookie(baseUrl, 'alder');
    const beaconCookie = await createPersonaCookie(baseUrl, 'beacon');

    for (const [cookie, expectedOwnHex, expectedForeignHex] of [
      [alderCookie, '0x00a1de07', '0x00beac11'],
      [beaconCookie, '0x00beac11', '0x00a1de07'],
    ] as const) {
      const res = await fetch(`${baseUrl}/api/demo/scoped-attention`, {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const proof = (await res.json()) as ScopedAttentionProofView;
      const steps = proof.onlineTileSteps ?? [];
      expect(steps.length).toBeGreaterThanOrEqual(4);

      let sawAuthorized = false;
      let sawSkipped = false;

      for (const step of steps) {
        if (
          step.headerCheckDisposition === 'skipped_foreign_scope_zero_kv_read' ||
          step.headerCheckDisposition === 'skipped_stale_generation_zero_kv_read'
        ) {
          sawSkipped = true;
          expect(step.kvTensorReadsPerformed).toBe(0);
          if (step.headerCheckDisposition === 'skipped_foreign_scope_zero_kv_read') {
            expect(step.blockScopeHex).toBe(expectedForeignHex);
          }
        } else {
          sawAuthorized = true;
          expect(step.headerCheckDisposition).toBe('loaded_authorized_tile');
          expect(step.blockScopeHex).toBe(expectedOwnHex);
          expect(step.allocationGeneration).toBe(step.expectedGeneration);
          expect(step.allocationGeneration).toBeGreaterThanOrEqual(1);
          expect(step.kvTensorReadsPerformed).toBeGreaterThan(0);
        }
      }

      expect(sawAuthorized).toBe(true);
      expect(sawSkipped).toBe(true);

      // Running (m_i, l_i, O_i) accumulator after skipped step #1 must equal step #0 verbatim
      expect(steps[1]!.headerCheckDisposition).toBe('skipped_foreign_scope_zero_kv_read');
      expect(steps[1]!.runningMaxLogitM).toBe(steps[0]!.runningMaxLogitM);
      expect(steps[1]!.runningDenomL).toBe(steps[0]!.runningDenomL);
      expect(steps[1]!.runningNormalizedOutput).toEqual(steps[0]!.runningNormalizedOutput);
    }

    // Direct Proxy-instrumented stress test: foreign scope + ABA stale gen + invalid gen 0 in one sequence
    const multiFaultPool = createProxyInstrumentedKvPool({
      blockSize: 2,
      headDim: 4,
      keys: [
        [
          [0.9, 0.2, 0.1, 0.4],
          [0.5, 0.3, 0.2, 0.1],
        ],
        [
          [9.9, 9.9, 9.9, 9.9],
          [8.8, 8.8, 8.8, 8.8],
        ],
        [
          [7.7, 7.7, 7.7, 7.7],
          [6.6, 6.6, 6.6, 6.6],
        ],
        [
          [5.5, 5.5, 5.5, 5.5],
          [4.4, 4.4, 4.4, 4.4],
        ],
      ],
      values: [
        [
          [0.2, 0.4, 0.6, 0.8],
          [0.1, 0.3, 0.5, 0.7],
        ],
        [
          [-50, 50, -50, 50],
          [-40, 40, -40, 40],
        ],
        [
          [-30, 30, -30, 30],
          [-20, 20, -20, 20],
        ],
        [
          [-10, 10, -10, 10],
          [-5, 5, -5, 5],
        ],
      ],
      blockScopeTags: [0x00a1de07, 0x00beac11, 0x00a1de07, 0x00a1de07],
      blockGenerations: [3, 4, 9, 0],
    });

    const multiRun = runOnlineTiledFlashAttention({
      query: [1.0, 0.5, 0.2, 0.3],
      blockTable: [0, 1, 2, 3],
      expectedGenerations: [3, 4, 8, 0],
      validityMask: [
        [true, true],
        [true, true],
        [true, true],
        [true, true],
      ],
      requestScopeTag: 0x00a1de07,
      enforceHeaderGuard: true,
      instrumented: multiFaultPool,
    });

    expect(multiRun.unauthorizedScalarReads).toBe(0);
    expect(multiRun.unauthorizedBlockTouches).toBe(0);
    expect(multiRun.steps[0]!.headerCheckDisposition).toBe('loaded_authorized_tile');
    expect(multiRun.steps[0]!.kvTensorReadsPerformed).toBe(16);
    expect(multiRun.steps[1]!.headerCheckDisposition).toBe('skipped_foreign_scope_zero_kv_read');
    expect(multiRun.steps[1]!.kvTensorReadsPerformed).toBe(0);
    expect(multiRun.steps[2]!.headerCheckDisposition).toBe('skipped_stale_generation_zero_kv_read');
    expect(multiRun.steps[2]!.kvTensorReadsPerformed).toBe(0);
    expect(multiRun.steps[3]!.headerCheckDisposition).toBe('skipped_stale_generation_zero_kv_read');
    expect(multiRun.steps[3]!.kvTensorReadsPerformed).toBe(0);
    expect(multiFaultPool.getScalarReadsForBlock(1)).toBe(0);
    expect(multiFaultPool.getScalarReadsForBlock(2)).toBe(0);
    expect(multiFaultPool.getScalarReadsForBlock(3)).toBe(0);
  });
});

describe('Wave 3 Adversarial: Filesystem & Signature Edge Cases in loadConfiguredInferenceProofStatus', () => {
  it('7. fails closed on missing path, directory path, corrupt binary UTF-8 bytes, and chmod-unreadable artifacts', async () => {
    const tmpDir = createTempDir();

    // 7a. Missing file path
    const missingPath = path.join(tmpDir, 'does-not-exist-proof.json');
    const missingStatus = loadConfiguredInferenceProofStatus({ artifactPath: missingPath });
    expect(missingStatus.badgeState).toBe('VERIFICATION FAILED');
    expect(missingStatus.verifierVerdict).toBe('ERROR');
    expect(missingStatus.primaryReasonCode).toBe('VERIFIER_ERROR_IO');
    expect(missingStatus.runtimeManifest).toBeNull();

    // 7b. Directory path (os.tmpdir())
    const dirStatus = loadConfiguredInferenceProofStatus({ artifactPath: os.tmpdir() });
    expect(dirStatus.badgeState).toBe('VERIFICATION FAILED');
    expect(dirStatus.verifierVerdict).toBe('ERROR');
    expect(dirStatus.primaryReasonCode).toBe('VERIFIER_ERROR_IO');
    expect(dirStatus.runtimeManifest).toBeNull();

    // 7c. Corrupt binary bytes (invalid UTF-8 sequences + embedded canary/secret)
    const corruptBinaryPath = path.join(tmpDir, 'corrupt-binary.bin');
    const binaryPayload = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xa0, 0xa1, 0x80]),
      Buffer.from(`leak:${SYNTHETIC_PLANTED_VALUE}:AIzaSyFakeGoogleKey12345678901234567890`, 'utf8'),
      Buffer.from([0xc0, 0xaf, 0xf5, 0xff]),
    ]);
    fs.writeFileSync(corruptBinaryPath, binaryPayload);

    const corruptStatus = loadConfiguredInferenceProofStatus({ artifactPath: corruptBinaryPath });
    expect(corruptStatus.badgeState).toBe('VERIFICATION FAILED');
    expect(corruptStatus.verifierVerdict).toBe('FAIL');
    expect(corruptStatus.primaryReasonCode).toBe('FAIL_PARSE_SYNTAX');
    expect(corruptStatus.sanitizerPassed).toBe(false);
    expect(corruptStatus.runtimeManifest).toBeNull();
    expect(JSON.stringify(corruptStatus)).not.toContain(SYNTHETIC_PLANTED_VALUE);
    expect(JSON.stringify(corruptStatus)).not.toContain('AIzaSyFakeGoogleKey12345678901234567890');

    // 7d. Unreadable file permissions (when running as non-root)
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const unreadablePath = path.join(tmpDir, 'unreadable-proof.json');
      fs.writeFileSync(
        unreadablePath,
        JSON.stringify(buildBaselineValidInferenceProof()),
        'utf8',
      );
      fs.chmodSync(unreadablePath, 0o000);
      try {
        const unreadableStatus = loadConfiguredInferenceProofStatus({
          artifactPath: unreadablePath,
        });
        expect(unreadableStatus.badgeState).toBe('VERIFICATION FAILED');
        expect(unreadableStatus.verifierVerdict).toBe('ERROR');
        expect(unreadableStatus.primaryReasonCode).toBe('VERIFIER_ERROR_IO');
        expect(unreadableStatus.runtimeManifest).toBeNull();
      } finally {
        fs.chmodSync(unreadablePath, 0o600);
      }
    }

    // 7e. End-to-end HTTP check with directory path in server config never throws 500
    const { baseUrl } = await startHarness({
      INFERENCE_PROOF_ARTIFACT_PATH: os.tmpdir(),
    });
    const alderCookie = await createPersonaCookie(baseUrl, 'alder');
    const httpDirRes = await fetch(`${baseUrl}/api/inference-proof`, {
      headers: { Cookie: alderCookie },
    });
    expect(httpDirRes.status).toBe(200);
    const httpDirBody = (await httpDirRes.json()) as InferenceProofStatusView;
    expect(httpDirBody.badgeState).toBe('VERIFICATION FAILED');
    expect(httpDirBody.verifierVerdict).toBe('ERROR');
    expect(httpDirBody.runtimeManifest).toBeNull();
  });

  it('8. fails closed when requireSignature is true without authoritative Python trust-root confirmation', () => {
    const tmpDir = createTempDir();

    // 8a. Valid unsigned artifact with requireSignature: true -> NO VERDICT (NV_SIG_MISSING)
    const unsignedPath = path.join(tmpDir, 'unsigned.json');
    const unsignedArt = buildBaselineValidInferenceProof();
    fs.writeFileSync(unsignedPath, JSON.stringify(unsignedArt), 'utf8');

    const unsignedStatus = loadConfiguredInferenceProofStatus({
      artifactPath: unsignedPath,
      requireSignature: true,
    });
    expect(unsignedStatus.verifierVerdict).toBe('NO VERDICT');
    expect(unsignedStatus.badgeState).toBe('NO VERDICT');
    expect(unsignedStatus.reasonCodes).toContain('NV_SIG_MISSING');
    expect(unsignedStatus.verifiedEvidenceStatus).toBe('unverified');

    // 8b. Artifact carrying a self-consistent Ed25519 signature object, but NO Python verifier configured
    const signedPath = path.join(tmpDir, 'self-signed.json');
    const signedArt = buildBaselineValidInferenceProof();
    signedArt['signature'] = {
      algorithm: 'ed25519',
      key_id: 'untrusted-key-01',
      trust_root_id: 'untrusted-root-01',
      signed_digest_sha256: signedArt['artifact_sha256'],
      signature_value: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      ephemeral_demo_only: true,
      signed_at: '2026-11-14T12:00:19Z',
    };
    fs.writeFileSync(signedPath, JSON.stringify(signedArt), 'utf8');

    const unconfirmedSigStatus = loadConfiguredInferenceProofStatus({
      artifactPath: signedPath,
      pythonVerifierSrc: null,
      requireSignature: true,
    });
    expect(unconfirmedSigStatus.verifierVerdict).toBe('NO VERDICT');
    expect(unconfirmedSigStatus.badgeState).toBe('NO VERDICT');
    expect(unconfirmedSigStatus.reasonCodes).toContain('NV_TRUST_ROOT_UNPROVIDED');
    expect(unconfirmedSigStatus.verifiedEvidenceStatus).toBe('unverified');

    // 8c. Signature algorithm downgrade ('none' / 'hs256') and replayed signature digest -> FAIL
    const algNoneArt = structuredClone(signedArt);
    (algNoneArt['signature'] as Record<string, unknown>)['algorithm'] = 'none';
    const algNoneStatus = evaluateInferenceProofArtifactRaw(JSON.stringify(algNoneArt), {
      requireSignature: true,
    });
    expect(algNoneStatus.verifierVerdict).toBe('FAIL');
    expect(algNoneStatus.badgeState).toBe('VERIFICATION FAILED');
    expect(algNoneStatus.reasonCodes).toContain('FAIL_SIG_ALG_UNSAFE');

    const replayedSigArt = structuredClone(signedArt);
    (replayedSigArt['signature'] as Record<string, unknown>)['signed_digest_sha256'] = HEX_F;
    const replayedSigStatus = evaluateInferenceProofArtifactRaw(JSON.stringify(replayedSigArt), {
      requireSignature: true,
    });
    expect(replayedSigStatus.verifierVerdict).toBe('FAIL');
    expect(replayedSigStatus.badgeState).toBe('VERIFICATION FAILED');
    expect(replayedSigStatus.reasonCodes).toContain('FAIL_SIG_REPLAY_OR_COPIED');

    // 8d. Existing pythonVerifierSrc directory lacking evidence_verifier module -> ERROR / VERIFICATION FAILED
    const emptyPySrcDir = path.join(tmpDir, 'empty_py_src');
    fs.mkdirSync(emptyPySrcDir, { recursive: true });
    const missingModStatus = loadConfiguredInferenceProofStatus({
      artifactPath: signedPath,
      pythonVerifierSrc: emptyPySrcDir,
      requireSignature: true,
    });
    expect(missingModStatus.badgeState).toBe('VERIFICATION FAILED');
    expect(missingModStatus.verifierVerdict).toBe('ERROR');
    expect(missingModStatus.reasonCodes).toContain('VERIFIER_ERROR_INTERNAL');
  });
});

describe('Wave 3 Adversarial: Strict JSON Parser, Status Laundering, Invariant Forgery & Zero-Echo Sanitizer Attacks', () => {
  it('9. rejects deep JSON nesting (> 64 levels) and duplicate keys inside nested runtime_manifest and scope_decisions', () => {
    // 9a. Deep object nesting (depth 68 > 64)
    const deepNestedObjects = `${'{"nested":'.repeat(68)}1${'}'.repeat(68)}`;
    const deepObjRes = evaluateInferenceProofArtifactRaw(deepNestedObjects);
    expect(deepObjRes.badgeState).toBe('VERIFICATION FAILED');
    expect(deepObjRes.verifierVerdict).toBe('FAIL');
    expect(deepObjRes.primaryReasonCode).toBe('FAIL_PARSE_SYNTAX');
    expect(deepObjRes.runtimeManifest).toBeNull();

    // 9b. Deep array nesting inside an inference-proof.v1 wrapper (depth 70 > 64)
    const deepArrayJson = `{"schema_version":"inference-proof.v1","exclusions":{"limitations":${'['.repeat(68)}"x"${']'.repeat(68)}}}`;
    const deepArrRes = evaluateInferenceProofArtifactRaw(deepArrayJson);
    expect(deepArrRes.badgeState).toBe('VERIFICATION FAILED');
    expect(deepArrRes.verifierVerdict).toBe('FAIL');
    expect(deepArrRes.primaryReasonCode).toBe('FAIL_PARSE_SYNTAX');

    // 9c. Duplicate keys inside nested runtime_manifest (raw and Unicode-escaped)
    const dupManifestPayloads = [
      '{"schema_version":"inference-proof.v1","runtime_manifest":{"gpu_model":"NONE_LOCAL_ONLY","gpu_model":"NVIDIA H200"}}',
      '{"schema_version":"inference-proof.v1","runtime_manifest":{"gpu_model":"NVIDIA H200","gpu_\\u006dodel":"NONE_LOCAL_ONLY"}}',
      '{"schema_version":"inference-proof.v1","runtime_manifest":{"tp_size":1,"\\u0074p_size":8}}',
      '{"schema_version":"inference-proof.v1","scope_decisions":[{"disposition":"deny_scope_mismatch","disposition":"allow"}]}',
    ];

    for (const raw of dupManifestPayloads) {
      const res = evaluateInferenceProofArtifactRaw(raw);
      expect(res.badgeState, raw).toBe('VERIFICATION FAILED');
      expect(res.verifierVerdict, raw).toBe('FAIL');
      expect(res.primaryReasonCode, raw).toBe('FAIL_CANON_DUPLICATE_KEY');
      expect(res.runtimeManifest, raw).toBeNull();
    }
  });

  it('10. rejects __proto__, constructor, and prototype keys (literal and Unicode-escaped) without polluting Object.prototype', () => {
    const prototypePayloads = [
      '{"schema_version":"inference-proof.v1","__proto__":{"pollutedWave3":true}}',
      '{"schema_version":"inference-proof.v1","runtime_manifest":{"__proto__":{"gpu_model":"NVIDIA H200"}}}',
      '{"schema_version":"inference-proof.v1","runtime_manifest":{"\\u005f\\u005fproto\\u005f\\u005f":{"pollutedWave3":true}}}',
      '{"schema_version":"inference-proof.v1","runtime_manifest":{"constructor":{"prototype":{"pollutedWave3":true}}}}',
      '{"schema_version":"inference-proof.v1","exclusions":{"construct\\u006fr":"bad"}}',
      '{"schema_version":"inference-proof.v1","paired_runs":{"protot\\u0079pe":"bad"}}',
    ];

    for (const raw of prototypePayloads) {
      const res = evaluateInferenceProofArtifactRaw(raw);
      expect(res.badgeState, raw).toBe('VERIFICATION FAILED');
      expect(res.verifierVerdict, raw).toBe('FAIL');
      expect(res.primaryReasonCode, raw).toBe('FAIL_CANON_PROTOTYPE_KEY');
      expect(res.runtimeManifest, raw).toBeNull();
    }

    expect(({} as Record<string, unknown>)['pollutedWave3']).toBeUndefined();
  });

  it('11. rejects -0.0 / -0 float literals, float underflow to -0, non-finite numbers, 53-bit integer overflow, and UTF-8 BOM', () => {
    const negativeZeroPayloads = [
      '{"schema_version":"inference-proof.v1","correctness":{"measured_max_abs_delta":-0.0}}',
      '{"schema_version":"inference-proof.v1","correctness":{"measured_max_abs_delta":-0}}',
      '{"schema_version":"inference-proof.v1","correctness":{"measured_max_abs_delta":-0.00000}}',
      '{"schema_version":"inference-proof.v1","correctness":{"measured_max_abs_delta":-0.0e10}}',
      '{"schema_version":"inference-proof.v1","correctness":{"measured_max_abs_delta":-1e-400}}',
    ];

    for (const raw of negativeZeroPayloads) {
      const res = evaluateInferenceProofArtifactRaw(raw);
      expect(res.badgeState, raw).toBe('VERIFICATION FAILED');
      expect(res.verifierVerdict, raw).toBe('FAIL');
      expect(res.primaryReasonCode, raw).toBe('FAIL_CANON_NEGATIVE_ZERO');
    }

    for (const nonFiniteLiteral of ['NaN', 'Infinity', '1e500']) {
      const raw = `{"schema_version":"inference-proof.v1","delta":${nonFiniteLiteral}}`;
      const res = evaluateInferenceProofArtifactRaw(raw);
      expect(res.badgeState, raw).toBe('VERIFICATION FAILED');
      expect(res.verifierVerdict, raw).toBe('FAIL');
      expect(res.primaryReasonCode, raw).toBe('FAIL_CANON_NONFINITE_NUMBER');
    }

    const negInfRes = evaluateInferenceProofArtifactRaw(
      '{"schema_version":"inference-proof.v1","delta":-Infinity}',
    );
    expect(negInfRes.badgeState).toBe('VERIFICATION FAILED');
    expect(negInfRes.verifierVerdict).toBe('FAIL');
    expect(['FAIL_CANON_NONFINITE_NUMBER', 'FAIL_PARSE_SYNTAX']).toContain(
      negInfRes.primaryReasonCode,
    );

    const overflowRes = evaluateInferenceProofArtifactRaw(
      '{"schema_version":"inference-proof.v1","seed":9007199254740993}',
    );
    expect(overflowRes.verifierVerdict).toBe('FAIL');
    expect(overflowRes.primaryReasonCode).toBe('FAIL_CANON_INT_OVERFLOW');

    const bomRes = evaluateInferenceProofArtifactRaw(
      `\ufeff${JSON.stringify(buildBaselineValidInferenceProof())}`,
    );
    expect(bomRes.verifierVerdict).toBe('FAIL');
    expect(bomRes.primaryReasonCode).toBe('FAIL_PARSE_SYNTAX');
  });

  it('12. rejects lone UTF-16 surrogates (\\ud800 / \\udfff) and raw/escaped NUL bytes (\\u0000) in keys and values', () => {
    const unicodeAndNulPayloads = [
      '{"schema_version":"inference-proof.v1","run_id":"bad-high-\\ud800-surrogate"}',
      '{"schema_version":"inference-proof.v1","run_id":"bad-low-\\udfff-surrogate"}',
      '{"schema_version":"inference-proof.v1","run_id":"reversed-\\udc00\\ud800-pair"}',
      '{"schema_version":"inference-proof.v1","\\ud800":"lone-surrogate-in-key"}',
      `{"schema_version":"inference-proof.v1","run_id":"literal-\ud800-surrogate"}`,
      '{"schema_version":"inference-proof.v1","run_id":"escaped-\\u0000-nul"}',
      '{"schema_version":"inference-proof.v1","key\\u0000nul":"val"}',
      '{"schema_version":"inference-proof.v1","run_id":"raw-\u0000-nul"}',
    ];

    for (const raw of unicodeAndNulPayloads) {
      const res = evaluateInferenceProofArtifactRaw(raw);
      expect(res.badgeState).toBe('VERIFICATION FAILED');
      expect(res.verifierVerdict).toBe('FAIL');
      expect(res.primaryReasonCode).toBe('FAIL_CANON_UNICODE_OR_NUL');
      expect(res.runtimeManifest).toBeNull();
    }
  });

  it('13. blocks status laundering across local_only, incomplete, ui_summary.evidence_status=live, and mock hardware markers', () => {
    // 13a. local_only paired with ui_summary: { evidence_status: 'live' } and valid recomputed digest
    const localWithLiveUi = buildBaselineValidInferenceProof({
      evidence_status: 'local_only',
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
    const localWithLiveUiRes = evaluateInferenceProofArtifactRaw(JSON.stringify(localWithLiveUi));
    expect(localWithLiveUiRes.digestMatch).toBe(true);
    expect(localWithLiveUiRes.verifierVerdict).toBe('FAIL');
    expect(localWithLiveUiRes.badgeState).toBe('VERIFICATION FAILED');
    expect(localWithLiveUiRes.reasonCodes).toContain('FAIL_UI_SUMMARY_CONTRADICTION');
    expect(localWithLiveUiRes.reasonCodes).toContain('NV_STATUS_LOCAL_ONLY');

    // 13b. incomplete paired with ui_summary: { evidence_status: 'live' } and valid recomputed digest
    const incompleteWithLiveUi = buildBaselineValidInferenceProof({
      evidence_status: 'incomplete',
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
    const incompleteWithLiveUiRes = evaluateInferenceProofArtifactRaw(
      JSON.stringify(incompleteWithLiveUi),
    );
    expect(incompleteWithLiveUiRes.digestMatch).toBe(true);
    expect(incompleteWithLiveUiRes.verifierVerdict).toBe('FAIL');
    expect(incompleteWithLiveUiRes.badgeState).toBe('VERIFICATION FAILED');
    expect(incompleteWithLiveUiRes.reasonCodes).toContain('FAIL_UI_SUMMARY_CONTRADICTION');
    expect(incompleteWithLiveUiRes.reasonCodes).toContain('NV_STATUS_INCOMPLETE');

    // 13c. local_only and incomplete with omitted ui_summary + valid digest -> NO VERDICT (never PASS or LIVE H200 RUN)
    for (const nonLiveStatus of ['local_only', 'incomplete'] as const) {
      const noUiArt = buildBaselineValidInferenceProof({ evidence_status: nonLiveStatus });
      delete noUiArt['ui_summary'];
      noUiArt['artifact_sha256'] = computeInferenceProofSha256(noUiArt);
      const res = evaluateInferenceProofArtifactRaw(JSON.stringify(noUiArt));
      expect(res.digestMatch).toBe(true);
      expect(res.verifierVerdict).toBe('NO VERDICT');
      expect(res.badgeState).not.toBe('LIVE H200 RUN');
      expect(res.badgeState).not.toBe('RECORDED H200 RUN');
    }

    // 13d. Claiming 'live' while carrying LOCAL_CPU topology, mock GPU model, or placeholder_notice
    const mockHardwareLive = buildBaselineValidInferenceProof({
      evidence_status: 'live',
    });
    (mockHardwareLive['runtime_manifest'] as Record<string, unknown>)['topology'] = 'LOCAL_CPU';
    (mockHardwareLive['ui_summary'] as Record<string, unknown>)['evidence_status'] = 'live';
    mockHardwareLive['artifact_sha256'] = computeInferenceProofSha256(mockHardwareLive);

    const mockHardwareRes = evaluateInferenceProofArtifactRaw(JSON.stringify(mockHardwareLive));
    expect(mockHardwareRes.digestMatch).toBe(true);
    expect(mockHardwareRes.verifierVerdict).toBe('FAIL');
    expect(mockHardwareRes.badgeState).toBe('VERIFICATION FAILED');
    expect(mockHardwareRes.reasonCodes).toContain('FAIL_STATUS_LAUNDERING');
  });

  it('14. rejects forged scope-decision, ABA block-generation, paired-run dispatch, and receipt-chain violations even when JCS SHA-256 is recomputed', () => {
    const mutationAttacks: Array<{
      name: string;
      mutate: (art: Record<string, unknown>) => void;
      expectedCode: string;
    }> = [
      {
        name: 'client scope spoofing enabled in trust_boundary',
        mutate: (art) => {
          (art['trust_boundary'] as Record<string, unknown>)['public_client_can_supply_scope'] =
            true;
        },
        expectedCode: 'FAIL_CLIENT_SCOPE_SPOOF_ACCEPTED',
      },
      {
        name: 'PUBLIC block inferred from token_equality',
        mutate: (art) => {
          const dec0 = (art['scope_decisions'] as Array<Record<string, unknown>>)[0]!;
          dec0['block_scope'] = 'PUBLIC';
          dec0['public_basis'] = 'token_equality';
          dec0['token_equality_used_for_public'] = true;
        },
        expectedCode: 'FAIL_SCOPE_PUBLIC_INFERRED',
      },
      {
        name: 'cross-tenant allow decision in scope_decisions',
        mutate: (art) => {
          const dec0 = (art['scope_decisions'] as Array<Record<string, unknown>>)[0]!;
          dec0['block_scope'] = 'scope:alder';
          dec0['disposition'] = 'allow';
        },
        expectedCode: 'FAIL_SCOPE_CROSS_TENANT_ACCEPTED',
      },
      {
        name: 'ABA free-to-readable reuse without generation increment',
        mutate: (art) => {
          const blk0 = (art['block_lifecycle'] as Array<Record<string, unknown>>)[0]!;
          const tr = blk0['transitions'] as Array<Record<string, unknown>>;
          tr.push(
            {
              seq: 2,
              from_state: 'readable',
              to_state: 'free',
              allocation_generation: 2,
              owner_scope: 'UNASSIGNED',
              policy_epoch: 0,
              transitioned_at: '2026-11-14T12:00:12Z',
              correlation_id: 'corr-2',
            },
            {
              seq: 3,
              from_state: 'free',
              to_state: 'readable',
              allocation_generation: 2,
              owner_scope: 'scope:birch',
              policy_epoch: 1,
              transitioned_at: '2026-11-14T12:00:13Z',
              correlation_id: 'corr-3',
            },
          );
        },
        expectedCode: 'FAIL_BLOCK_STALE_GENERATION',
      },
      {
        name: 'nonzero planted-value influence under vervain_fault_injected',
        mutate: (art) => {
          const corr = art['correctness'] as Record<string, unknown>;
          const probe = corr['planted_value_influence_probe'] as Record<string, unknown>;
          probe['vervain_fault_injected_influence_score'] = 0.05;
        },
        expectedCode: 'FAIL_VIOLATION_ENTERED_DISPATCH',
      },
      {
        name: 'broken receipt_chain head_sha256 link',
        mutate: (art) => {
          (art['receipt_chain'] as Record<string, unknown>)['head_sha256'] = HEX_F;
        },
        expectedCode: 'FAIL_RECEIPT_CHAIN_BROKEN',
      },
    ];

    for (const attack of mutationAttacks) {
      const forged = structuredClone(buildBaselineValidInferenceProof());
      attack.mutate(forged);
      forged['artifact_sha256'] = computeInferenceProofSha256(forged);

      const res = evaluateInferenceProofArtifactRaw(JSON.stringify(forged));
      expect(res.digestMatch, attack.name).toBe(true);
      expect(res.verifierVerdict, attack.name).toBe('FAIL');
      expect(res.badgeState, attack.name).toBe('VERIFICATION FAILED');
      expect(res.reasonCodes, attack.name).toContain(attack.expectedCode);
    }
  });

  it('15. enforces zero-echo sanitization for BEACON_PROJECT_EMBER_742 (raw, hex, base64, base64url), Google API key, and private IP 10.24.8.19', () => {
    const rawCanary = SYNTHETIC_PLANTED_VALUE; // BEACON_PROJECT_EMBER_742
    const hexCanary = Buffer.from(rawCanary, 'utf8').toString('hex');
    const base64Canary = Buffer.from(rawCanary, 'utf8').toString('base64');
    const base64UrlDirect = Buffer.from(rawCanary, 'utf8').toString('base64url');
    // Prefix '??>' (0x3f, 0x3f, 0x3e -> 'Pz8+' in base64, 'Pz8-' in base64url) forces URL-safe '-' alphabet
    const base64UrlWithUrlSafeChars = Buffer.from(`??>${rawCanary}`, 'utf8').toString('base64url');
    expect(base64UrlWithUrlSafeChars).toContain('-');

    const googleApiKey = 'AIzaSyFakeGoogleKey12345678901234567890';
    const privateIp = '10.24.8.19';

    const allForbiddenNeedles = [
      rawCanary,
      hexCanary,
      base64Canary,
      base64UrlDirect,
      base64UrlWithUrlSafeChars,
      googleApiKey,
      privateIp,
    ];

    const injectionVectors: Array<{
      label: string;
      buildRaw: () => string;
      expectedReasonCode: string;
    }> = [
      {
        label: 'raw canary in runtime_manifest.gpu_model and run_id',
        buildRaw: () => {
          const art = buildBaselineValidInferenceProof({ run_id: `run-${rawCanary}` });
          (art['runtime_manifest'] as Record<string, unknown>)['gpu_model'] =
            `H200-${rawCanary}`;
          art['artifact_sha256'] = computeInferenceProofSha256(art);
          return JSON.stringify(art);
        },
        expectedReasonCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
      },
      {
        label: 'hex canary in exclusions.limitations',
        buildRaw: () => {
          const art = buildBaselineValidInferenceProof();
          (art['exclusions'] as Record<string, unknown>)['limitations'] = [
            `hex-trace:${hexCanary}`,
          ];
          art['artifact_sha256'] = computeInferenceProofSha256(art);
          return JSON.stringify(art);
        },
        expectedReasonCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
      },
      {
        label: 'base64 canary in runtime_manifest.model_id',
        buildRaw: () => {
          const art = buildBaselineValidInferenceProof();
          (art['runtime_manifest'] as Record<string, unknown>)['model_id'] = base64Canary;
          art['artifact_sha256'] = computeInferenceProofSha256(art);
          return JSON.stringify(art);
        },
        expectedReasonCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
      },
      {
        label: 'base64url canary (both direct and URL-safe "-" alphabet) in exclusions.unmediated_boundaries',
        buildRaw: () => {
          const art = buildBaselineValidInferenceProof();
          (art['exclusions'] as Record<string, unknown>)['unmediated_boundaries'] = [
            base64UrlDirect,
            base64UrlWithUrlSafeChars,
          ];
          art['artifact_sha256'] = computeInferenceProofSha256(art);
          return JSON.stringify(art);
        },
        expectedReasonCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
      },
      {
        label: 'Google API key + private IPv4 10.24.8.19 + all canary encodings combined',
        buildRaw: () => {
          const art = buildBaselineValidInferenceProof({
            run_id: `run-${privateIp}`,
          });
          const manifest = art['runtime_manifest'] as Record<string, unknown>;
          manifest['gpu_model'] = `NVIDIA H200 (${privateIp})`;
          manifest['model_id'] = googleApiKey;
          const excl = art['exclusions'] as Record<string, unknown>;
          excl['limitations'] = [
            rawCanary,
            hexCanary,
            base64Canary,
            base64UrlWithUrlSafeChars,
            googleApiKey,
            privateIp,
          ];
          art['artifact_sha256'] = computeInferenceProofSha256(art);
          return JSON.stringify(art);
        },
        expectedReasonCode: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
      },
      {
        label: 'malformed JSON syntax combined with raw/hex/base64url canary + Google API key + 10.24.8.19',
        buildRaw: () =>
          `{"schema_version":"inference-proof.v1","leak":"${rawCanary} ${hexCanary} ${base64UrlWithUrlSafeChars} ${googleApiKey} ${privateIp}", BROKEN_JSON`,
        expectedReasonCode: 'FAIL_PARSE_SYNTAX',
      },
    ];

    for (const vec of injectionVectors) {
      const statusView = evaluateInferenceProofArtifactRaw(vec.buildRaw());
      expect(statusView.sanitizerPassed, vec.label).toBe(false);
      expect(statusView.sanitizerFindingsCount, vec.label).toBeGreaterThan(0);
      expect(statusView.badgeState, vec.label).toBe('VERIFICATION FAILED');
      expect(statusView.verifierVerdict, vec.label).toBe('FAIL');
      expect(statusView.reasonCodes, vec.label).toContain(vec.expectedReasonCode);
      expect(statusView.runId, vec.label).toBeNull();
      expect(statusView.artifactSha256Declared, vec.label).toBeNull();
      expect(statusView.runtimeManifest, vec.label).toBeNull();
      expect(statusView.exclusions, vec.label).toEqual([]);

      const serialized = JSON.stringify(statusView).toLowerCase();
      for (const needle of allForbiddenNeedles) {
        expect(serialized, `${vec.label} leaked ${needle}`).not.toContain(needle.toLowerCase());
      }
    }
  });

  it('16. guarantees zero secret/canary/IP echo over wire HTTP on /api/inference-proof and /api/demo/enterprise-architecture when disk artifact is poisoned', async () => {
    const tmpDir = createTempDir();
    const poisonedPath = path.join(tmpDir, 'poisoned-inference-proof.json');

    const rawCanary = SYNTHETIC_PLANTED_VALUE;
    const hexCanary = Buffer.from(rawCanary, 'utf8').toString('hex');
    const base64Canary = Buffer.from(rawCanary, 'utf8').toString('base64');
    const base64UrlCanary = Buffer.from(`??>${rawCanary}`, 'utf8').toString('base64url');
    const googleApiKey = 'AIzaSyFakeGoogleKey12345678901234567890';
    const privateIp = '10.24.8.19';

    const poisonedArt = buildBaselineValidInferenceProof({
      run_id: `run-${privateIp}`,
    });
    const manifest = poisonedArt['runtime_manifest'] as Record<string, unknown>;
    manifest['gpu_model'] = `NVIDIA H200 @ ${privateIp}`;
    manifest['model_id'] = googleApiKey;
    const excl = poisonedArt['exclusions'] as Record<string, unknown>;
    excl['limitations'] = [rawCanary, hexCanary, base64Canary, base64UrlCanary];
    poisonedArt['artifact_sha256'] = computeInferenceProofSha256(poisonedArt);

    fs.writeFileSync(poisonedPath, JSON.stringify(poisonedArt), 'utf8');

    const { baseUrl } = await startHarness({
      INFERENCE_PROOF_ARTIFACT_PATH: poisonedPath,
    });
    const alderCookie = await createPersonaCookie(baseUrl, 'alder');

    const [proofRes, archRes] = await Promise.all([
      fetch(`${baseUrl}/api/inference-proof`, { headers: { Cookie: alderCookie } }),
      fetch(`${baseUrl}/api/demo/enterprise-architecture`, { headers: { Cookie: alderCookie } }),
    ]);
    expect(proofRes.status).toBe(200);
    expect(archRes.status).toBe(200);

    const proofRawText = await proofRes.text();
    const archRawText = await archRes.text();

    for (const rawWireBody of [proofRawText, archRawText]) {
      const lower = rawWireBody.toLowerCase();
      for (const secretNeedle of [
        rawCanary,
        hexCanary,
        base64Canary,
        base64UrlCanary,
        googleApiKey,
        privateIp,
      ]) {
        expect(lower).not.toContain(secretNeedle.toLowerCase());
      }
    }

    const proofJson = JSON.parse(proofRawText) as InferenceProofStatusView;
    const archJson = JSON.parse(archRawText) as EnterpriseArchitectureResponse;

    for (const view of [proofJson, archJson.inferenceProof]) {
      expect(view.sanitizerPassed).toBe(false);
      expect(view.badgeState).toBe('VERIFICATION FAILED');
      expect(view.verifierVerdict).toBe('FAIL');
      expect(view.runtimeManifest).toBeNull();
      expect(view.runId).toBeNull();
      expect(view.exclusions).toEqual([]);
    }
  });

  it('17. Cycle 8 regressions: odd-nibble hex canary, zero manifest exposure on non-PASS, -Infinity reason code, tp_size/receipt_chain bounds, and query-order authority priority', async () => {
    // 8a. Odd-nibble-prefixed mixed-case hex canary must fail sanitizer with zero echo
    const oddHexMixedCase =
      'f' + Buffer.from('Beacon_Project_Ember_742', 'utf8').toString('hex');
    const oddHexArt = buildBaselineValidInferenceProof();
    (oddHexArt['exclusions'] as Record<string, unknown>)['limitations'] = [
      `nibble-shifted:${oddHexMixedCase}`,
    ];
    oddHexArt['artifact_sha256'] = computeInferenceProofSha256(oddHexArt);
    const oddHexRes = evaluateInferenceProofArtifactRaw(JSON.stringify(oddHexArt));
    expect(oddHexRes.sanitizerPassed).toBe(false);
    expect(oddHexRes.verifierVerdict).toBe('FAIL');
    expect(oddHexRes.reasonCodes).toContain('FAIL_PROTECTED_CONTENT_PLANTED_VALUE');
    expect(oddHexRes.runtimeManifest).toBeNull();
    expect(oddHexRes.exclusions).toEqual([]);
    expect(JSON.stringify(oddHexRes).toLowerCase()).not.toContain(
      oddHexMixedCase.toLowerCase(),
    );

    // 8b. Non-PASS verdicts (FAIL digest tampering, FAIL status laundering, NO VERDICT incomplete,
    // and Python CLI FAIL override) must never expose runtimeManifest or exclusions even when sanitizer passes
    const tamperedDigestArt = buildBaselineValidInferenceProof();
    (tamperedDigestArt['runtime_manifest'] as Record<string, unknown>)['gpu_model'] =
      'NVIDIA H200 FORGED';
    const tamperedRes = evaluateInferenceProofArtifactRaw(JSON.stringify(tamperedDigestArt));
    expect(tamperedRes.sanitizerPassed).toBe(true);
    expect(tamperedRes.verifierVerdict).toBe('FAIL');
    expect(tamperedRes.runtimeManifest).toBeNull();
    expect(tamperedRes.exclusions).toEqual([]);

    const incompleteArt = buildBaselineValidInferenceProof({
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
    expect(incompleteRes.sanitizerPassed).toBe(true);
    expect(incompleteRes.verifierVerdict).toBe('NO VERDICT');
    expect(incompleteRes.runtimeManifest).toBeNull();
    expect(incompleteRes.exclusions).toEqual([]);

    // Python CLI FAIL override on locally valid artifact must also withhold runtimeManifest
    const tmpDir = createTempDir('vervain-cycle8-py-fail-');
    const validArtPath = path.join(tmpDir, 'locally-valid.json');
    fs.writeFileSync(
      validArtPath,
      JSON.stringify(buildBaselineValidInferenceProof()),
      'utf8',
    );
    const stubPkgDir = path.join(tmpDir, 'py_src', 'evidence_verifier');
    fs.mkdirSync(stubPkgDir, { recursive: true });
    fs.writeFileSync(path.join(stubPkgDir, '__init__.py'), '', 'utf8');
    fs.writeFileSync(
      path.join(stubPkgDir, '__main__.py'),
      [
        'import json, sys',
        'out = {',
        '  "schema_version": "verifier-result.v1",',
        '  "verdict": "FAIL",',
        '  "exit_code": 1,',
        '  "primary_reason_code": "FAIL_SIG_INVALID",',
        '  "reason_codes": ["FAIL_SIG_INVALID"],',
        '  "sanitizer_result": {"passed": True, "rules_checked": 10, "finding_count": 0}',
        '}',
        'sys.stdout.write(json.dumps(out) + "\\n")',
        'sys.exit(1)',
      ].join('\n'),
      'utf8',
    );
    const pyFailMerged = loadConfiguredInferenceProofStatus({
      artifactPath: validArtPath,
      pythonVerifierSrc: path.join(tmpDir, 'py_src'),
    });
    expect(pyFailMerged.verifierVerdict).toBe('FAIL');
    expect(pyFailMerged.runtimeManifest).toBeNull();
    expect(pyFailMerged.exclusions).toEqual([]);

    // 8c. -Infinity literal must yield FAIL_CANON_NONFINITE_NUMBER rather than FAIL_PARSE_SYNTAX
    const negInfRes = evaluateInferenceProofArtifactRaw(
      '{"schema_version":"inference-proof.v1","delta":-Infinity}',
    );
    expect(negInfRes.verifierVerdict).toBe('FAIL');
    expect(negInfRes.primaryReasonCode).toBe('FAIL_CANON_NONFINITE_NUMBER');
    expect(negInfRes.reasonCodes).toContain('FAIL_CANON_NONFINITE_NUMBER');

    // 8d. Non-positive/fractional tp_size and non-hex64 receipt_chain hashes must fail invariants
    for (const badTp of [0, -2, 0.5]) {
      const badTpArt = buildBaselineValidInferenceProof();
      (badTpArt['runtime_manifest'] as Record<string, unknown>)['tp_size'] = badTp;
      (badTpArt['ui_summary'] as Record<string, unknown>)['tp_size'] = badTp;
      badTpArt['artifact_sha256'] = computeInferenceProofSha256(badTpArt);
      const badTpRes = evaluateInferenceProofArtifactRaw(JSON.stringify(badTpArt));
      expect(badTpRes.verifierVerdict, `tp_size=${String(badTp)}`).toBe('FAIL');
      expect(badTpRes.reasonCodes, `tp_size=${String(badTp)}`).toContain(
        'FAIL_GPU_MANIFEST_CONTRADICTION',
      );
    }

    const badChainArt = buildBaselineValidInferenceProof();
    const badChain = badChainArt['receipt_chain'] as Record<string, unknown>;
    badChain['genesis_sha256'] = 'short-non-hex';
    badChain['head_sha256'] = 'short-non-hex';
    badChain['event_count'] = 1;
    badChain['events'] = [
      {
        event_index: 0,
        run_id: badChainArt['run_id'],
        request_id: 'req-nc-01',
        event_type: 'arm_native_clean',
        recorded_at: '2026-11-14T12:00:03Z',
        prev_sha256: 'short-non-hex',
        event_sha256: 'short-non-hex',
        canonical_event_sha256: 'short-non-hex',
      },
    ];
    badChainArt['artifact_sha256'] = computeInferenceProofSha256(badChainArt);
    const badChainRes = evaluateInferenceProofArtifactRaw(JSON.stringify(badChainArt));
    expect(badChainRes.verifierVerdict).toBe('FAIL');
    expect(badChainRes.reasonCodes).toContain('FAIL_RECEIPT_CHAIN_BROKEN');

    // 8e. Query parameter ordering must never downgrade authority_override_rejected to unknown_field
    const { baseUrl } = await startHarness();
    const alderCookie = await createPersonaCookie(baseUrl, 'alder');
    for (const route of ['/api/inference-proof', '/api/demo/enterprise-architecture'] as const) {
      for (const smuggledQs of [
        'foo=bar&tenant_id=beacon',
        'preset=neocloud_shared_gpu&scope=1',
        'benign=1&policy_epoch=99',
      ]) {
        const res = await fetch(`${baseUrl}${route}?${smuggledQs}`, {
          headers: { Cookie: alderCookie },
        });
        expect(res.status, `${route}?${smuggledQs}`).toBe(400);
        const errBody = (await res.json()) as { error: { code: string } };
        expect(errBody.error.code, `${route}?${smuggledQs}`).toBe(
          API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED,
        );
      }
    }
  });
});
