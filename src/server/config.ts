/**
 * Responsibility: Server-only environment and Gemini runtime configuration.
 * Trust boundary: Trusted server process only; never import into browser modules or serialize raw secrets.
 */

import crypto from 'node:crypto';
import type { RuntimeMode } from '../shared/contracts.js';

export interface ServerConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly geminiApiKey: string | null;
  readonly geminiModel: string;
  readonly demoMode: RuntimeMode;
  readonly allowLiveGeminiInTests: boolean;
  readonly sessionSecret: string;
  readonly sessionCookieName: string;
  readonly sessionTtlMs: number;
  readonly maxSessionsInMemory: number;
  readonly maxGeminiCallsPerSession: number;
  readonly maxGeminiCallsPerWindow: number;
  readonly geminiWindowMs: number;
  readonly rateLimitMutationsPerMinute: number;
  readonly geminiTemperature: number;
  readonly geminiMaxOutputTokens: number;
  readonly geminiTimeoutMs: number;
  readonly geminiMaxRetries: number;
  readonly geminiRetryBaseDelayMs: number;
  readonly inferenceProofArtifactPath: string | null;
  readonly evidenceVerifierPythonPath: string | null;
  readonly inferenceProofTrustRootPath: string | null;
  readonly inferenceProofRequireSignature: boolean;
}

const SAFE_MODEL_ID_PATTERN = /^[a-zA-Z0-9._-]{3,80}$/;

const EPHEMERAL_DEV_SECRET = crypto.randomBytes(32).toString('hex');

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

/**
 * Loads and validates server configuration from an environment dictionary.
 * Never logs or exposes `geminiApiKey` or `sessionSecret`.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawEnv = env.NODE_ENV;
  const nodeEnv: ServerConfig['nodeEnv'] =
    rawEnv === 'production' ? 'production' : rawEnv === 'test' ? 'test' : 'development';

  const port = parsePositiveInt(env.PORT, 8080, 1, 65535);

  const trimmedKey = (env.GEMINI_API_KEY ?? '').trim();
  const geminiApiKey = trimmedKey.length > 0 ? trimmedKey : null;

  const candidateModel = (env.GEMINI_MODEL ?? 'gemini-2.5-flash').trim();
  const geminiModel = SAFE_MODEL_ID_PATTERN.test(candidateModel)
    ? candidateModel
    : 'gemini-2.5-flash';

  const rawDemoMode = (env.DEMO_MODE ?? 'live').trim().toLowerCase();
  const demoMode: RuntimeMode = rawDemoMode === 'mock' ? 'mock' : 'live';

  const allowLiveGeminiInTests = env.ALLOW_LIVE_GEMINI === '1';

  const rawSecret = (env.SESSION_SECRET ?? '').trim();
  const sessionSecret = rawSecret.length >= 32 ? rawSecret : EPHEMERAL_DEV_SECRET;

  return Object.freeze({
    nodeEnv,
    port,
    geminiApiKey,
    geminiModel,
    demoMode,
    allowLiveGeminiInTests,
    sessionSecret,
    sessionCookieName: nodeEnv === 'production' ? '__Host-vervain_cf_sid' : 'vervain_cf_sid',
    sessionTtlMs: parsePositiveInt(env.SESSION_TTL_MS, 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    maxSessionsInMemory: 2048,
    maxGeminiCallsPerSession: parsePositiveInt(env.MAX_GEMINI_CALLS_PER_SESSION, 12, 1, 200),
    maxGeminiCallsPerWindow: parsePositiveInt(env.MAX_GEMINI_CALLS_PER_WINDOW, 60, 1, 2000),
    geminiWindowMs: 10 * 60 * 1000,
    rateLimitMutationsPerMinute: parsePositiveInt(env.RATE_LIMIT_MUTATIONS_PER_MINUTE, 20, 1, 500),
    geminiTemperature: 0,
    geminiMaxOutputTokens: 256,
    geminiTimeoutMs: parsePositiveInt(env.GEMINI_TIMEOUT_MS, 12000, 500, 60000),
    geminiMaxRetries: parsePositiveInt(env.GEMINI_MAX_RETRIES, 2, 0, 5),
    geminiRetryBaseDelayMs: parsePositiveInt(env.GEMINI_RETRY_BASE_DELAY_MS, 250, 10, 5000),
    inferenceProofArtifactPath: (env.INFERENCE_PROOF_ARTIFACT_PATH ?? '').trim() || null,
    evidenceVerifierPythonPath:
      (env.EVIDENCE_VERIFIER_PYTHONPATH ?? env.INFERENCE_PROOF_PYTHON_VERIFIER_SRC ?? '').trim() ||
      null,
    inferenceProofTrustRootPath: (env.INFERENCE_PROOF_TRUST_ROOT_PATH ?? '').trim() || null,
    inferenceProofRequireSignature: env.INFERENCE_PROOF_REQUIRE_SIGNATURE === '1',
  });
}
