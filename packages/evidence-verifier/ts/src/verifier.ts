/**
 * Responsibility: Typed consumer and independent lightweight verifier + Python CLI bridge
 * for the Vervain lead TypeScript application and Daybreak integration.
 * Trust boundary: Never promotes local_only/incomplete to PASS; never trusts ui_summary over raw data.
 */

import { execFileSync } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { sanitizeStructure, type SanitizerResult } from './sanitizer.js';
import { StrictJsonError, computeArtifactSha256, parseStrictJson } from './strict-json.js';

export type VerifierVerdict = 'PASS' | 'FAIL' | 'NO VERDICT' | 'ERROR';
export type EvidenceStatus = 'live' | 'recorded' | 'local_only' | 'incomplete';

export interface VerifierResultV1 {
  schema_version: 'verifier-result.v1';
  verdict: VerifierVerdict;
  exit_code: 0 | 1 | 2 | 3;
  primary_reason_code: string;
  reason_codes: string[];
  target_type: 'artifact' | 'run_dir';
  target_path: string;
  run_id: string | null;
  artifact_sha256_declared: string | null;
  artifact_sha256_computed: string | null;
  claimed_evidence_status: EvidenceStatus | 'unknown';
  verified_evidence_status: EvidenceStatus | 'unverified';
  sanitizer_result: {
    passed: boolean;
    rules_checked: number;
    finding_count: number;
  };
  claim_boundary: string;
}

export interface LocalVerifySummary {
  verdict: VerifierVerdict;
  exitCode: 0 | 1 | 2;
  reasonCodes: string[];
  computedSha256: string | null;
  declaredSha256: string | null;
  sanitizer: SanitizerResult;
}

function shaEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Performs independent in-process TypeScript strict parse, sanitization, JCS SHA-256 verification,
 * status honesty check, and UI-summary contradiction check before rendering an artifact in Node/TS.
 */
export function verifyArtifactDigestAndSummaryLocal(rawJsonText: string): LocalVerifySummary {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(rawJsonText);
  } catch (err) {
    const code = err instanceof StrictJsonError ? err.reasonCode : 'FAIL_PARSE_SYNTAX';
    return {
      verdict: 'FAIL',
      exitCode: 1,
      reasonCodes: [code],
      computedSha256: null,
      declaredSha256: null,
      sanitizer: { passed: false, findingCount: 0, findings: [] },
    };
  }

  const san = sanitizeStructure(parsed);
  const codes: string[] = san.findings.map((f) => f.reasonCode);

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      verdict: 'FAIL',
      exitCode: 1,
      reasonCodes: [...new Set([...codes, 'FAIL_SCHEMA_INVALID'])],
      computedSha256: null,
      declaredSha256: null,
      sanitizer: san,
    };
  }

  const art = parsed as Record<string, unknown>;
  if (art['schema_version'] !== 'inference-proof.v1') {
    return {
      verdict: codes.length > 0 ? 'FAIL' : 'NO VERDICT',
      exitCode: codes.length > 0 ? 1 : 2,
      reasonCodes: [...new Set([...codes, 'NV_UNSUPPORTED_SCHEMA_VERSION'])],
      computedSha256: null,
      declaredSha256: typeof art['artifact_sha256'] === 'string' ? art['artifact_sha256'] : null,
      sanitizer: san,
    };
  }

  const computed = computeArtifactSha256(art);
  const declared = typeof art['artifact_sha256'] === 'string' ? art['artifact_sha256'] : '';
  if (!declared || !shaEqual(declared, computed)) {
    codes.push('FAIL_DIGEST_MISMATCH');
  }

  const status = art['evidence_status'];
  if (status === 'local_only') codes.push('NV_STATUS_LOCAL_ONLY');
  else if (status === 'incomplete') codes.push('NV_STATUS_INCOMPLETE');

  const ui = art['ui_summary'];
  if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
    const uiRec = ui as Record<string, unknown>;
    if (uiRec['evidence_status'] !== status) {
      codes.push('FAIL_UI_SUMMARY_CONTRADICTION');
    }
  }

  const hasFail = codes.some((c) => c.startsWith('FAIL_'));
  const hasNv = codes.some((c) => c.startsWith('NV_'));
  const verdict: VerifierVerdict = hasFail ? 'FAIL' : hasNv ? 'NO VERDICT' : 'PASS';
  const exitCode: 0 | 1 | 2 = verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2;
  return {
    verdict,
    exitCode,
    reasonCodes: codes.length > 0 ? [...new Set(codes)].sort() : ['PASS_VERIFIED'],
    computedSha256: computed,
    declaredSha256: declared || null,
    sanitizer: san,
  };
}

/**
 * Invokes the authoritative Python `evidence-verifier` CLI safely (shell=false) on an artifact path.
 */
export function runPythonVerifierCli(params: {
  pythonBin?: string;
  verifierPackageSrc: string;
  artifactPath: string;
  trustRootPath?: string;
  requireSignature?: boolean;
}): VerifierResultV1 {
  const args = ['-m', 'evidence_verifier', 'verify', params.artifactPath];
  if (params.trustRootPath) {
    args.push('--trust-root', params.trustRootPath);
  }
  if (params.requireSignature) {
    args.push('--require-signature');
  }
  try {
    const stdout = execFileSync(params.pythonBin ?? 'python3', args, {
      env: { ...process.env, PYTHONPATH: params.verifierPackageSrc },
      encoding: 'utf8',
    });
    return parseStrictJson(stdout) as VerifierResultV1;
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (typeof e.stdout === 'string' && e.stdout.trim().startsWith('{')) {
      return parseStrictJson(e.stdout) as VerifierResultV1;
    }
    throw err;
  }
}
