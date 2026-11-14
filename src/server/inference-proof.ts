/**
 * Responsibility: Independent TypeScript consumer, RFC 8259/8785 strict JSON + JCS SHA-256
 * verifier, zero-echo secret/planted-value sanitizer, and optional Carbon 3 Python CLI bridge
 * for self-hosted GPU `inference-proof.v1` artifacts.
 * Trust boundary: Never promotes `local_only` or `incomplete` runs to `PASS`, never trusts
 * `ui_summary` over raw paired-run records, and never echoes leaked secrets or planted values.
 */

import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SCOPED_ATTENTION_LIMITATION_LABEL } from '../shared/config.js';
import type {
  InferenceProofBadgeState,
  InferenceProofStatusView,
} from '../shared/contracts.js';
import {
  SYNTHETIC_PLANTED_VALUE,
  getProtectedFixtureSubstrings,
} from './fixture.js';

export const INFERENCE_PROOF_NO_ARTIFACT_CLAIM_BOUNDARY =
  'No self-hosted GPU inference-proof.v1 artifact is configured on this server instance. Scoped Attention in this demo runs as a deterministic TypeScript reference proof only.';

export const INFERENCE_PROOF_EVALUATED_CLAIM_BOUNDARY =
  `PASS indicates only that the supplied inference-proof.v1 artifact satisfies named structural, canonical-digest, sanitization, and paired-run invariants for its pinned runtime configuration. ${SCOPED_ATTENTION_LIMITATION_LABEL}`;

const SUPPORTED_SCHEMA_VERSION = 'inference-proof.v1';
const MAX_JSON_DEPTH = 64;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const REQUIRED_ROOT_KEYS = [
  'schema_version',
  'evidence_status',
  'run_id',
  'started_at',
  'finished_at',
  'source',
  'runtime_manifest',
  'trust_boundary',
  'scenario',
  'paired_runs',
  'scope_decisions',
  'block_lifecycle',
  'backend_dispatch',
  'correctness',
  'performance',
  'receipt_chain',
  'exclusions',
  'artifact_sha256',
] as const;

const ALLOWED_ROOT_KEYS = new Set<string>([
  ...REQUIRED_ROOT_KEYS,
  'signature',
  'ui_summary',
]);

const EXPECTED_PAIRED_ARMS = [
  'native_clean',
  'native_fault_injected',
  'vervain_clean',
  'vervain_fault_injected',
  'vervain_allowed_after_fault',
] as const;

export interface EvaluateInferenceProofOptions {
  readonly requireSignature?: boolean;
  readonly nowIso?: string;
}

export interface LoadConfiguredInferenceProofOptions {
  readonly artifactPath?: string | null;
  readonly pythonVerifierSrc?: string | null;
  readonly trustRootPath?: string | null;
  readonly requireSignature?: boolean;
  readonly nowIso?: string;
}

export class InferenceProofStrictJsonError extends Error {
  public readonly reasonCode: string;
  public readonly jsonPath: string;

  constructor(reasonCode: string, message: string, jsonPath = '$') {
    super(message);
    this.name = 'InferenceProofStrictJsonError';
    this.reasonCode = reasonCode;
    this.jsonPath = jsonPath;
  }
}

export interface ZeroEchoSanitizerFinding {
  readonly ruleId: string;
  readonly jsonPointer: string;
  readonly reasonCode: string;
}

export interface ZeroEchoSanitizerSummary {
  readonly passed: boolean;
  readonly findingCount: number;
  readonly reasonCodes: readonly string[];
  readonly findings: readonly ZeroEchoSanitizerFinding[];
}

const FORBIDDEN_NORMALIZED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  rawprompt: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  prompt: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  prompttext: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  systemprompt: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  messages: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  rawresponse: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  responsetext: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  completion: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  outputtext: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  rawoutput: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  chunktext: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  documenttext: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  sourcetext: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  contexttext: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  rawcontext: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  groundtruth: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  plantedvalue: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
  rawplantedvalue: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
  plantedsecret: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
  canary: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
  canaryvalue: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
  canarytext: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
  kvtensor: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  kvtensors: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  kvcache: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  keytensor: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  valuetensor: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  kcache: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  vcache: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  tensorbytes: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  rawweights: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  rawlogits: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  embeddingvector: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  secret: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  clientsecret: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  sessionsecret: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  hmacsecret: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  apikey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  geminiapikey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  openaiapikey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  anthropicapikey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  hftoken: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  accesstoken: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  refreshtoken: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  idtoken: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  bearertoken: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  authtoken: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  token: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  cookie: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  setcookie: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  sessioncookie: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  password: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  passwd: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  passphrase: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  credential: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  credentials: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  privatekey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  signingkey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  pem: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  sshkey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  awssecretaccesskey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  serviceaccountkey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  authorization: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  scopeenvelope: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  signedscopeenvelope: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  email: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  emailaddress: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  phone: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  phonenumber: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  ssn: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  socialsecuritynumber: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  address: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  ipaddress: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  hostip: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  streetaddress: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  homeaddress: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  customerdata: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  customername: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  fullname: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  dateofbirth: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  creditcard: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  bankaccount: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  iban: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
});

const VALUE_SANITIZER_PATTERNS: ReadonlyArray<readonly [string, string, RegExp]> = [
  ['SEC_GOOGLE_API_KEY', 'FAIL_SECRET_LEAK_KEY_OR_TOKEN', /AIza[0-9A-Za-z\-_]{20,}/],
  [
    'SEC_OPENAI_OR_ANTHROPIC_KEY',
    'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
    /sk-(?:proj-|svcacct-|admin-|ant-(?:api\d{2}-)?)?[A-Za-z0-9_\-]{20,}/,
  ],
  [
    'SEC_GITHUB_TOKEN',
    'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
    /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}/,
  ],
  ['SEC_HF_TOKEN', 'FAIL_SECRET_LEAK_KEY_OR_TOKEN', /hf_[A-Za-z0-9]{20,}/],
  ['SEC_AWS_ACCESS_KEY', 'FAIL_SECRET_LEAK_KEY_OR_TOKEN', /(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}/],
  [
    'SEC_PEM_PRIVATE_KEY',
    'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
    /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/,
  ],
  ['SEC_BEARER_TOKEN', 'FAIL_SECRET_LEAK_KEY_OR_TOKEN', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i],
  ['SEC_BASIC_AUTH', 'FAIL_SECRET_LEAK_KEY_OR_TOKEN', /\bBasic\s+[A-Za-z0-9+/=]{12,}/i],
  [
    'SEC_JWT_TOKEN',
    'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  ],
  [
    'SEC_SESSION_COOKIE',
    'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
    /(?:vervain_cf_sid|__Host-vervain_cf_sid|JSESSIONID|connect\.sid|sessionid)=[^;\s]+/i,
  ],
  [
    'PII_EMAIL',
    'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  ],
  ['PII_SSN', 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK', /\b\d{3}-\d{2}-\d{4}\b/],
  [
    'PII_IPV4',
    'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
    /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/,
  ],
  [
    'CONTENT_RAW_PROMPT_MARKER',
    'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
    /\b(?:BEGIN\s+RAW\s+PROMPT|SYSTEM\s+PROMPT\s*:|KV_TENSOR_DUMP)\b/i,
  ],
  [
    'CONTENT_PLANTED_PATTERN',
    'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
    /VERVAIN_PLANTED_[A-Z0-9_]{4,}|ALDER_CANARY_[A-Z0-9_]{4,}|BEACON_PROJECT_[A-Z0-9_]{4,}/i,
  ],
];

interface PlantedEncodingVariant {
  readonly needleLower: string;
  readonly tag: string;
  readonly reasonCode: string;
}

function buildPlantedVariants(): readonly PlantedEncodingVariant[] {
  const variants: PlantedEncodingVariant[] = [];
  const plantedCandidates = [SYNTHETIC_PLANTED_VALUE];
  for (const raw of plantedCandidates) {
    const forms = [raw, raw.toLowerCase(), raw.toUpperCase()];
    for (const form of forms) {
      const buf = Buffer.from(form, 'utf8');
      const b64 = buf.toString('base64');
      const b64Unpadded = b64.replace(/=+$/, '');
      const b64Url = buf.toString('base64url');
      variants.push({
        needleLower: form.toLowerCase(),
        tag: 'RAW',
        reasonCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
      });
      variants.push({
        needleLower: buf.toString('hex').toLowerCase(),
        tag: 'HEX',
        reasonCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
      });
      variants.push({
        needleLower: b64.toLowerCase(),
        tag: 'BASE64',
        reasonCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
      });
      variants.push({
        needleLower: b64Unpadded.toLowerCase(),
        tag: 'BASE64_UNPADDED',
        reasonCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
      });
      variants.push({
        needleLower: b64Url.toLowerCase(),
        tag: 'BASE64URL',
        reasonCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
      });
    }
  }

  for (const protectedText of getProtectedFixtureSubstrings()) {
    if (protectedText === SYNTHETIC_PLANTED_VALUE || protectedText.length < 12) continue;
    variants.push({
      needleLower: protectedText.toLowerCase(),
      tag: 'FIXTURE_TEXT',
      reasonCode: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
    });
  }

  const dedup = new Map<string, PlantedEncodingVariant>();
  for (const item of variants) {
    if (!dedup.has(item.needleLower)) {
      dedup.set(item.needleLower, item);
    }
  }
  return Object.freeze([...dedup.values()]);
}

const PLANTED_VARIANTS = buildPlantedVariants();
const PLANTED_LOWER = SYNTHETIC_PLANTED_VALUE.toLowerCase();

function containsDecodedPlantedValue(val: string): boolean {
  const hexMatches = val.match(/[0-9a-fA-F]{32,}/g);
  if (hexMatches) {
    for (const candidate of hexMatches) {
      for (const nibbleOffset of [0, 1]) {
        const shifted = candidate.slice(nibbleOffset);
        if (shifted.length < 32) continue;
        const evenHex = shifted.length % 2 === 0 ? shifted : shifted.slice(0, -1);
        try {
          const decoded = Buffer.from(evenHex, 'hex').toString('utf8').toLowerCase();
          if (decoded.includes(PLANTED_LOWER)) {
            return true;
          }
          for (const variant of PLANTED_VARIANTS) {
            if (variant.tag === 'FIXTURE_TEXT' && decoded.includes(variant.needleLower)) {
              return true;
            }
          }
        } catch {
          // Ignore non-UTF8 binary digests
        }
      }
    }
  }

  const b64Matches = val.match(/[A-Za-z0-9+/_-]{24,}={0,2}/g);
  if (b64Matches) {
    for (const candidate of b64Matches) {
      const normalized = candidate.replace(/-/g, '+').replace(/_/g, '/');
      for (const offset of [0, 1, 2, 3]) {
        const sub = normalized.slice(offset);
        if (sub.length < 24) continue;
        const padLen = (4 - (sub.length % 4)) % 4;
        const padded = sub + '='.repeat(padLen);
        try {
          const decoded = Buffer.from(padded, 'base64').toString('utf8').toLowerCase();
          if (decoded.includes(PLANTED_LOWER)) {
            return true;
          }
          for (const variant of PLANTED_VARIANTS) {
            if (variant.tag === 'FIXTURE_TEXT' && decoded.includes(variant.needleLower)) {
              return true;
            }
          }
        } catch {
          // Ignore invalid base64 slices
        }
      }
    }
  }

  return false;
}

function scanStringZeroEcho(
  val: string,
  pointer: string,
  findings: ZeroEchoSanitizerFinding[],
): void {
  for (const [ruleId, reasonCode, pattern] of VALUE_SANITIZER_PATTERNS) {
    if (pattern.test(val)) {
      findings.push({ ruleId, jsonPointer: pointer, reasonCode });
    }
  }

  const valLower = val.toLowerCase();
  for (const variant of PLANTED_VARIANTS) {
    if (valLower.includes(variant.needleLower)) {
      findings.push({
        ruleId: `PLANTED_${variant.tag}`,
        jsonPointer: pointer,
        reasonCode: variant.reasonCode,
      });
    }
  }

  if (containsDecodedPlantedValue(val)) {
    findings.push({
      ruleId: 'PLANTED_DECODED_BYTES',
      jsonPointer: pointer,
      reasonCode: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
    });
  }
}

function finalizeSanitizerFindings(
  rawFindings: readonly ZeroEchoSanitizerFinding[],
): ZeroEchoSanitizerSummary {
  const seen = new Set<string>();
  const unique: ZeroEchoSanitizerFinding[] = [];
  const sorted = [...rawFindings].sort((a, b) => {
    if (a.reasonCode !== b.reasonCode) return a.reasonCode.localeCompare(b.reasonCode);
    if (a.jsonPointer !== b.jsonPointer) return a.jsonPointer.localeCompare(b.jsonPointer);
    return a.ruleId.localeCompare(b.ruleId);
  });

  for (const f of sorted) {
    const key = `${f.ruleId}|${f.jsonPointer}|${f.reasonCode}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(Object.freeze(f));
    }
  }

  const reasonCodes = [...new Set(unique.map((f) => f.reasonCode))];
  return Object.freeze({
    passed: unique.length === 0,
    findingCount: unique.length,
    reasonCodes: Object.freeze(reasonCodes),
    findings: Object.freeze(unique),
  });
}

/**
 * Recursively scans a parsed JSON structure for forbidden content/secret keys, credentials,
 * network addresses, emails, and raw/hex/base64 synthetic planted values with zero secret echo.
 */
export function sanitizeInferenceProofStructure(data: unknown): ZeroEchoSanitizerSummary {
  const findings: ZeroEchoSanitizerFinding[] = [];

  const walk = (node: unknown, ptr: string): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        walk(node[i], `${ptr}[${i}]`);
      }
      return;
    }
    if (node !== null && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      for (const k of Object.keys(rec)) {
        const childPtr = `${ptr}.${k}`;
        const normKey = k.toLowerCase().replace(/[^a-z0-9]/g, '');
        const forbiddenCode = FORBIDDEN_NORMALIZED_KEYS[normKey];
        if (forbiddenCode) {
          findings.push({
            ruleId: `KEY_${normKey.toUpperCase()}`,
            jsonPointer: childPtr,
            reasonCode: forbiddenCode,
          });
        }
        scanStringZeroEcho(k, `${childPtr}#key`, findings);
        walk(rec[k], childPtr);
      }
      return;
    }
    if (typeof node === 'string') {
      scanStringZeroEcho(node, ptr, findings);
    }
  };

  walk(data, '$');
  return finalizeSanitizerFindings(findings);
}

function sanitizeRawTextZeroEcho(rawText: string): ZeroEchoSanitizerSummary {
  const findings: ZeroEchoSanitizerFinding[] = [];
  const lines = rawText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    scanStringZeroEcho(line, `raw:line_${i + 1}`, findings);
  }
  return finalizeSanitizerFindings(findings);
}

function isCleanDisplayString(val: string): boolean {
  const findings: ZeroEchoSanitizerFinding[] = [];
  scanStringZeroEcho(val, '$.display', findings);
  return findings.length === 0;
}

/**
 * Strictly parses RFC 8259 JSON while rejecting BOM, NUL bytes, lone surrogates,
 * duplicate keys, prototype keys (`__proto__`, `constructor`, `prototype`),
 * non-finite numbers, `-0` / `-0.0`, integer overflow, and excessive depth.
 */
export function parseStrictInferenceProofJson(raw: string, maxDepth = MAX_JSON_DEPTH): unknown {
  if (raw.startsWith('\ufeff')) {
    throw new InferenceProofStrictJsonError('FAIL_PARSE_SYNTAX', 'UTF-8 BOM is not permitted.');
  }
  if (raw.includes('\u0000')) {
    throw new InferenceProofStrictJsonError(
      'FAIL_CANON_UNICODE_OR_NUL',
      'Raw NUL byte is not permitted.',
    );
  }

  const len = raw.length;
  let idx = 0;

  const skipWs = (): void => {
    while (idx < len) {
      const c = raw.charCodeAt(idx);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        idx += 1;
      } else {
        break;
      }
    }
  };

  const readString = (jsonPath: string): string => {
    const start = idx;
    idx += 1;
    while (idx < len) {
      const c = raw.charCodeAt(idx);
      if (c === 0x22) {
        idx += 1;
        const slice = raw.slice(start, idx);
        let decoded: string;
        try {
          decoded = JSON.parse(slice) as string;
        } catch {
          throw new InferenceProofStrictJsonError(
            'FAIL_PARSE_SYNTAX',
            'Malformed JSON string escape.',
            jsonPath,
          );
        }
        if (decoded.includes('\u0000')) {
          throw new InferenceProofStrictJsonError(
            'FAIL_CANON_UNICODE_OR_NUL',
            'Decoded NUL character is forbidden.',
            jsonPath,
          );
        }
        for (let i = 0; i < decoded.length; i += 1) {
          const code = decoded.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = decoded.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) {
              throw new InferenceProofStrictJsonError(
                'FAIL_CANON_UNICODE_OR_NUL',
                'Lone UTF-16 high surrogate is forbidden.',
                jsonPath,
              );
            }
            i += 1;
          } else if (code >= 0xdc00 && code <= 0xdfff) {
            throw new InferenceProofStrictJsonError(
              'FAIL_CANON_UNICODE_OR_NUL',
              'Lone UTF-16 low surrogate is forbidden.',
              jsonPath,
            );
          }
        }
        return decoded;
      }
      if (c < 0x20) {
        throw new InferenceProofStrictJsonError(
          'FAIL_PARSE_SYNTAX',
          'Unescaped control character in JSON string.',
          jsonPath,
        );
      }
      if (c === 0x5c) {
        if (idx + 1 >= len) {
          throw new InferenceProofStrictJsonError(
            'FAIL_PARSE_SYNTAX',
            'Unterminated escape sequence in JSON string.',
            jsonPath,
          );
        }
        idx += 2;
        continue;
      }
      idx += 1;
    }
    throw new InferenceProofStrictJsonError(
      'FAIL_PARSE_SYNTAX',
      'Unterminated JSON string.',
      jsonPath,
    );
  };

  const readNumber = (jsonPath: string): number => {
    const start = idx;
    if (raw[idx] === '-') idx += 1;
    if (idx >= len) {
      throw new InferenceProofStrictJsonError('FAIL_PARSE_SYNTAX', 'Invalid JSON number.', jsonPath);
    }
    if (raw[idx] === '0') {
      idx += 1;
      if (idx < len && /\d/.test(raw[idx] ?? '')) {
        throw new InferenceProofStrictJsonError(
          'FAIL_PARSE_SYNTAX',
          'Leading zero in JSON number.',
          jsonPath,
        );
      }
    } else if (/\d/.test(raw[idx] ?? '')) {
      while (idx < len && /\d/.test(raw[idx] ?? '')) idx += 1;
    } else {
      throw new InferenceProofStrictJsonError(
        'FAIL_PARSE_SYNTAX',
        'Invalid JSON number syntax.',
        jsonPath,
      );
    }

    let isFloat = false;
    if (raw[idx] === '.') {
      isFloat = true;
      idx += 1;
      if (idx >= len || !/\d/.test(raw[idx] ?? '')) {
        throw new InferenceProofStrictJsonError(
          'FAIL_PARSE_SYNTAX',
          'Missing fractional digits in JSON number.',
          jsonPath,
        );
      }
      while (idx < len && /\d/.test(raw[idx] ?? '')) idx += 1;
    }
    if (raw[idx] === 'e' || raw[idx] === 'E') {
      isFloat = true;
      idx += 1;
      if (raw[idx] === '+' || raw[idx] === '-') idx += 1;
      if (idx >= len || !/\d/.test(raw[idx] ?? '')) {
        throw new InferenceProofStrictJsonError(
          'FAIL_PARSE_SYNTAX',
          'Missing exponent digits in JSON number.',
          jsonPath,
        );
      }
      while (idx < len && /\d/.test(raw[idx] ?? '')) idx += 1;
    }

    const lexeme = raw.slice(start, idx);
    if (lexeme === '-0') {
      throw new InferenceProofStrictJsonError(
        'FAIL_CANON_NEGATIVE_ZERO',
        'Negative zero (-0) is forbidden.',
        jsonPath,
      );
    }
    const num = Number(lexeme);
    if (!Number.isFinite(num)) {
      throw new InferenceProofStrictJsonError(
        'FAIL_CANON_NONFINITE_NUMBER',
        'Non-finite JSON number is forbidden.',
        jsonPath,
      );
    }
    if (Object.is(num, -0) || (lexeme.startsWith('-') && num === 0)) {
      throw new InferenceProofStrictJsonError(
        'FAIL_CANON_NEGATIVE_ZERO',
        'Negative zero (-0.0) is forbidden.',
        jsonPath,
      );
    }
    if (!isFloat && !Number.isSafeInteger(num)) {
      throw new InferenceProofStrictJsonError(
        'FAIL_CANON_INT_OVERFLOW',
        'Integer exceeds IEEE-754 53-bit exact range.',
        jsonPath,
      );
    }
    return num;
  };

  const readValue = (depth: number, jsonPath: string): unknown => {
    if (depth > maxDepth) {
      throw new InferenceProofStrictJsonError(
        'FAIL_PARSE_SYNTAX',
        'JSON nesting depth limit exceeded.',
        jsonPath,
      );
    }
    skipWs();
    if (idx >= len) {
      throw new InferenceProofStrictJsonError(
        'FAIL_PARSE_SYNTAX',
        'Unexpected end of JSON input.',
        jsonPath,
      );
    }
    const ch = raw[idx];
    if (ch === '{') {
      idx += 1;
      skipWs();
      const obj = Object.create(null) as Record<string, unknown>;
      if (raw[idx] === '}') {
        idx += 1;
        return obj;
      }
      const seen = new Set<string>();
      while (true) {
        skipWs();
        if (raw[idx] !== '"') {
          throw new InferenceProofStrictJsonError(
            'FAIL_PARSE_SYNTAX',
            'Expected quoted JSON object key.',
            jsonPath,
          );
        }
        const key = readString(jsonPath);
        const keyPath = `${jsonPath}.${key}`;
        if (PROTOTYPE_KEYS.has(key)) {
          throw new InferenceProofStrictJsonError(
            'FAIL_CANON_PROTOTYPE_KEY',
            'Prototype-related object key is forbidden.',
            keyPath,
          );
        }
        if (seen.has(key)) {
          throw new InferenceProofStrictJsonError(
            'FAIL_CANON_DUPLICATE_KEY',
            'Duplicate JSON object key is forbidden.',
            keyPath,
          );
        }
        seen.add(key);
        skipWs();
        if (raw[idx] !== ':') {
          throw new InferenceProofStrictJsonError(
            'FAIL_PARSE_SYNTAX',
            'Expected colon after JSON object key.',
            keyPath,
          );
        }
        idx += 1;
        obj[key] = readValue(depth + 1, keyPath);
        skipWs();
        if (raw[idx] === ',') {
          idx += 1;
          continue;
        }
        if (raw[idx] === '}') {
          idx += 1;
          return obj;
        }
        throw new InferenceProofStrictJsonError(
          'FAIL_PARSE_SYNTAX',
          'Expected comma or closing brace in JSON object.',
          jsonPath,
        );
      }
    }
    if (ch === '[') {
      idx += 1;
      skipWs();
      const arr: unknown[] = [];
      if (raw[idx] === ']') {
        idx += 1;
        return arr;
      }
      let elem = 0;
      while (true) {
        arr.push(readValue(depth + 1, `${jsonPath}[${elem}]`));
        elem += 1;
        skipWs();
        if (raw[idx] === ',') {
          idx += 1;
          continue;
        }
        if (raw[idx] === ']') {
          idx += 1;
          return arr;
        }
        throw new InferenceProofStrictJsonError(
          'FAIL_PARSE_SYNTAX',
          'Expected comma or closing bracket in JSON array.',
          jsonPath,
        );
      }
    }
    if (ch === '"') return readString(jsonPath);
    if (
      raw.startsWith('NaN', idx) ||
      raw.startsWith('Infinity', idx) ||
      raw.startsWith('-Infinity', idx)
    ) {
      throw new InferenceProofStrictJsonError(
        'FAIL_CANON_NONFINITE_NUMBER',
        'Non-finite literal is forbidden.',
        jsonPath,
      );
    }
    if (ch === '-' || /\d/.test(ch ?? '')) return readNumber(jsonPath);
    if (raw.startsWith('true', idx)) {
      idx += 4;
      return true;
    }
    if (raw.startsWith('false', idx)) {
      idx += 5;
      return false;
    }
    if (raw.startsWith('null', idx)) {
      idx += 4;
      return null;
    }
    throw new InferenceProofStrictJsonError(
      'FAIL_PARSE_SYNTAX',
      'Unexpected JSON token.',
      jsonPath,
    );
  };

  const parsed = readValue(1, '$');
  skipWs();
  if (idx !== len) {
    throw new InferenceProofStrictJsonError(
      'FAIL_PARSE_SYNTAX',
      'Trailing tokens after root JSON value.',
      '$',
    );
  }
  return parsed;
}

/**
 * Serializes a value using RFC 8785 JSON Canonicalization Scheme (JCS).
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InferenceProofStrictJsonError(
        'FAIL_CANON_NONFINITE_NUMBER',
        'Non-finite float in JCS canonicalization.',
      );
    }
    if (Object.is(value, -0)) {
      throw new InferenceProofStrictJsonError(
        'FAIL_CANON_NEGATIVE_ZERO',
        'Negative zero in JCS canonicalization.',
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJcs(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    const parts: string[] = [];
    for (const k of keys) {
      if (PROTOTYPE_KEYS.has(k)) {
        throw new InferenceProofStrictJsonError(
          'FAIL_CANON_PROTOTYPE_KEY',
          'Prototype key in JCS canonicalization.',
        );
      }
      parts.push(`${JSON.stringify(k)}:${canonicalizeJcs(rec[k])}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new InferenceProofStrictJsonError('FAIL_PARSE_SYNTAX', 'Unsupported value type.');
}

/**
 * Computes the independent RFC 8785 JCS SHA-256 digest of an `inference-proof.v1` object,
 * excluding `artifact_sha256` and `signature`.
 */
export function computeInferenceProofSha256(artifact: Readonly<Record<string, unknown>>): string {
  const clone = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(artifact)) {
    if (k === 'artifact_sha256' || k === 'signature') continue;
    clone[k] = artifact[k];
  }
  const canonical = canonicalizeJcs(clone);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function timingSafeHexDigestEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length !== 64) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function isFiniteNum(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

function parseSafeClaimedStatus(
  raw: unknown,
): InferenceProofStatusView['claimedEvidenceStatus'] {
  if (raw === 'live' || raw === 'recorded' || raw === 'local_only' || raw === 'incomplete') {
    return raw;
  }
  return 'none';
}

function extractSafeRunId(raw: unknown, sanitizerPassed: boolean): string | null {
  if (!sanitizerPassed || typeof raw !== 'string') return null;
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(raw)) return null;
  return isCleanDisplayString(raw) ? raw : null;
}

function extractSafeSha256(raw: unknown, sanitizerPassed: boolean): string | null {
  if (!sanitizerPassed || typeof raw !== 'string') return null;
  if (!/^[0-9a-f]{64}$/.test(raw)) return null;
  return raw;
}

function extractRuntimeManifestView(
  art: Record<string, unknown>,
  sanitizerPassed: boolean,
): InferenceProofStatusView['runtimeManifest'] {
  if (!sanitizerPassed) return null;
  const manifest = art['runtime_manifest'];
  const trustBoundary = art['trust_boundary'];
  if (!isPlainRecord(manifest) || !isPlainRecord(trustBoundary)) return null;

  const gpuModelRaw = manifest['gpu_model'];
  const gpuModel =
    typeof gpuModelRaw === 'string' && gpuModelRaw.trim().length > 0 && isCleanDisplayString(gpuModelRaw)
      ? gpuModelRaw
      : 'NONE';
  const gpuCount =
    typeof manifest['gpu_count'] === 'number' && Number.isInteger(manifest['gpu_count'])
      ? manifest['gpu_count']
      : 0;
  const tpSize =
    typeof manifest['tp_size'] === 'number' && Number.isInteger(manifest['tp_size'])
      ? manifest['tp_size']
      : 1;
  const vllmVersion =
    typeof manifest['vllm_version'] === 'string' && isCleanDisplayString(manifest['vllm_version'])
      ? manifest['vllm_version']
      : null;
  const engineName = vllmVersion ? `vLLM ${vllmVersion}` : 'vLLM';
  const modelId =
    typeof manifest['model_id'] === 'string' && isCleanDisplayString(manifest['model_id'])
      ? manifest['model_id']
      : 'unknown';
  const selectedBackend =
    typeof manifest['selected_runtime_backend'] === 'string' &&
    isCleanDisplayString(manifest['selected_runtime_backend'])
      ? manifest['selected_runtime_backend']
      : 'unknown';
  const kvDtype =
    typeof manifest['kv_dtype'] === 'string' && isCleanDisplayString(manifest['kv_dtype'])
      ? manifest['kv_dtype']
      : 'unknown';
  const blockSize =
    typeof manifest['block_size'] === 'number' && Number.isInteger(manifest['block_size'])
      ? manifest['block_size']
      : 16;
  const prefixCachingEnabled = Boolean(manifest['prefix_caching']);
  const guardMode =
    typeof trustBoundary['guard_mode'] === 'string' &&
    isCleanDisplayString(trustBoundary['guard_mode'])
      ? trustBoundary['guard_mode']
      : 'unknown';

  return Object.freeze({
    gpuModel,
    gpuCount,
    tpSize,
    engineName,
    modelId,
    selectedBackend,
    kvDtype,
    blockSize,
    prefixCachingEnabled,
    guardMode,
  });
}

function extractExclusionsList(
  art: Record<string, unknown>,
  sanitizerPassed: boolean,
): readonly string[] {
  if (!sanitizerPassed) return Object.freeze([]);
  const excl = art['exclusions'];
  if (!isPlainRecord(excl)) return Object.freeze([]);

  const collected: string[] = [];
  const unmediated = excl['unmediated_boundaries'];
  if (Array.isArray(unmediated)) {
    for (const item of unmediated) {
      if (typeof item === 'string' && isCleanDisplayString(item)) {
        collected.push(item);
      }
    }
  }
  const limitations = excl['limitations'];
  if (Array.isArray(limitations)) {
    for (const item of limitations) {
      if (typeof item === 'string' && isCleanDisplayString(item)) {
        collected.push(item);
      }
    }
  }
  const unsupported = excl['unsupported_paths'];
  if (Array.isArray(unsupported)) {
    for (const entry of unsupported) {
      if (
        isPlainRecord(entry) &&
        typeof entry['path_name'] === 'string' &&
        typeof entry['status'] === 'string' &&
        typeof entry['reason'] === 'string'
      ) {
        const formatted = `${entry['path_name']}=${entry['status']}: ${entry['reason']}`;
        if (isCleanDisplayString(formatted)) {
          collected.push(formatted);
        }
      }
    }
  }
  return Object.freeze(collected);
}

function evaluateCoreInvariants(
  art: Record<string, unknown>,
  computedSha: string,
  requireSignature: boolean,
): string[] {
  const codes: string[] = [];

  for (const reqKey of REQUIRED_ROOT_KEYS) {
    if (!(reqKey in art)) {
      codes.push('FAIL_SCHEMA_INVALID');
      break;
    }
  }
  for (const key of Object.keys(art)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) {
      codes.push('FAIL_SCHEMA_INVALID');
      break;
    }
  }

  const rawStatus = art['evidence_status'];
  if (
    rawStatus !== 'live' &&
    rawStatus !== 'recorded' &&
    rawStatus !== 'local_only' &&
    rawStatus !== 'incomplete'
  ) {
    codes.push('FAIL_SCHEMA_INVALID');
    return codes;
  }

  const isGpuClaimed = rawStatus === 'live' || rawStatus === 'recorded';
  if (rawStatus === 'local_only') {
    codes.push('NV_STATUS_LOCAL_ONLY');
  } else if (rawStatus === 'incomplete') {
    codes.push('NV_STATUS_INCOMPLETE');
  }

  const source = art['source'];
  const manifest = art['runtime_manifest'];
  const trustBoundary = art['trust_boundary'];
  const scenario = art['scenario'];
  const pairedRuns = art['paired_runs'];
  const scopeDecisions = art['scope_decisions'];
  const blockLifecycle = art['block_lifecycle'];
  const backendDispatch = art['backend_dispatch'];
  const correctness = art['correctness'];
  const performance = art['performance'];
  const receiptChain = art['receipt_chain'];
  const exclusions = art['exclusions'];

  if (
    typeof art['run_id'] !== 'string' ||
    typeof art['started_at'] !== 'string' ||
    typeof art['finished_at'] !== 'string' ||
    !isPlainRecord(source) ||
    !isPlainRecord(manifest) ||
    !isPlainRecord(trustBoundary) ||
    !isPlainRecord(scenario) ||
    !isPlainRecord(pairedRuns) ||
    !Array.isArray(scopeDecisions) ||
    !Array.isArray(blockLifecycle) ||
    !Array.isArray(backendDispatch) ||
    !isPlainRecord(correctness) ||
    (performance !== null && !isPlainRecord(performance)) ||
    !isPlainRecord(receiptChain) ||
    !isPlainRecord(exclusions)
  ) {
    codes.push('FAIL_SCHEMA_INVALID');
    return codes;
  }

  // Signature block validation and policy check
  if ('signature' in art && art['signature'] !== undefined) {
    const sig = art['signature'];
    if (!isPlainRecord(sig)) {
      codes.push('FAIL_SIG_INVALID');
    } else {
      const alg = sig['algorithm'];
      const signedDigest = sig['signed_digest_sha256'];
      if (typeof alg !== 'string' || alg.toLowerCase() !== 'ed25519') {
        codes.push('FAIL_SIG_ALG_UNSAFE');
      } else if (
        typeof signedDigest !== 'string' ||
        !timingSafeHexDigestEqual(signedDigest, computedSha)
      ) {
        codes.push('FAIL_SIG_REPLAY_OR_COPIED');
      } else if (requireSignature) {
        codes.push('NV_TRUST_ROOT_UNPROVIDED');
      }
    }
  } else if (requireSignature) {
    codes.push('NV_SIG_MISSING');
  }

  // Status honesty vs mock/local hardware markers
  const gpuModel = manifest['gpu_model'];
  const gpuCount = manifest['gpu_count'];
  const tpSize = manifest['tp_size'];
  const topology = manifest['topology'];
  const placeholderNotice = scenario['placeholder_notice'];

  const hasMockMarkers =
    topology === 'LOCAL_CPU' ||
    (typeof gpuModel === 'string' && /local|mock|no gpu run recorded/i.test(gpuModel)) ||
    placeholderNotice === 'NO GPU RUN RECORDED';

  if (typeof tpSize !== 'number' || !Number.isInteger(tpSize) || tpSize < 1) {
    codes.push('FAIL_GPU_MANIFEST_CONTRADICTION');
  }

  if (isGpuClaimed) {
    if (hasMockMarkers) {
      codes.push('FAIL_STATUS_LAUNDERING');
    }
    const gpuUuids = Array.isArray(manifest['gpu_uuids_sha256'])
      ? manifest['gpu_uuids_sha256']
      : [];
    if (
      typeof gpuModel !== 'string' ||
      gpuModel.trim().length === 0 ||
      typeof gpuCount !== 'number' ||
      !Number.isInteger(gpuCount) ||
      gpuCount < 1 ||
      gpuUuids.length !== gpuCount ||
      new Set(gpuUuids).size !== gpuCount ||
      typeof tpSize !== 'number' ||
      !Number.isInteger(tpSize) ||
      tpSize < 1 ||
      tpSize > gpuCount
    ) {
      codes.push('FAIL_GPU_MANIFEST_CONTRADICTION');
    }
    if (performance === null) {
      codes.push('FAIL_MISSING_REQUIRED_JOIN');
    }
  }

  // Trust boundary and synthetic injection checks
  if (trustBoundary['public_client_can_supply_scope'] !== false) {
    codes.push('FAIL_CLIENT_SCOPE_SPOOF_ACCEPTED');
  }
  if (
    scenario['synthetic_only'] !== true ||
    scenario['injection_type'] !== 'controlled_engine_internal_post_auth_substitution'
  ) {
    codes.push('FAIL_INJECTION_NONSYNTHETIC');
  }
  if (
    typeof scenario['foreign_owner_scope'] === 'string' &&
    scenario['foreign_owner_scope'] === scenario['victim_request_scope']
  ) {
    codes.push('FAIL_SCOPE_CROSS_TENANT_ACCEPTED');
  }

  // Backend consistency
  const configuredBackend = manifest['configured_backend'];
  const selectedBackend = manifest['selected_runtime_backend'];
  if (
    typeof configuredBackend === 'string' &&
    typeof selectedBackend === 'string' &&
    configuredBackend !== selectedBackend
  ) {
    codes.push('FAIL_BACKEND_INTENT_MISMATCH');
  }

  // Block lifecycle ABA and positive generation invariants
  for (const brec of blockLifecycle) {
    if (!isPlainRecord(brec)) continue;
    const bgen = brec['allocation_generation'];
    if (bgen !== null && (typeof bgen !== 'number' || !Number.isInteger(bgen) || bgen < 1)) {
      codes.push('FAIL_BLOCK_GEN_MISSING_OR_ZERO');
    }
    const transitions = brec['transitions'];
    if (Array.isArray(transitions)) {
      let seenTerminal = false;
      let terminalGen = typeof bgen === 'number' ? bgen : 0;
      let prevSeq = -1;
      for (const tr of transitions) {
        if (!isPlainRecord(tr)) continue;
        const seq = tr['seq'];
        const tgen = tr['allocation_generation'];
        const fromSt = tr['from_state'];
        const toSt = tr['to_state'];
        if (tgen !== null && (typeof tgen !== 'number' || !Number.isInteger(tgen) || tgen < 1)) {
          codes.push('FAIL_BLOCK_GEN_MISSING_OR_ZERO');
        }
        if (typeof seq === 'number') {
          if (seq <= prevSeq) codes.push('FAIL_BLOCK_STALE_GENERATION');
          prevSeq = seq;
        }
        if (toSt === 'free' || toSt === 'retired') {
          seenTerminal = true;
          if (typeof tgen === 'number') terminalGen = tgen;
        } else if (
          seenTerminal &&
          (fromSt === 'free' || fromSt === 'retired') &&
          (toSt === 'reserved' || toSt === 'writing' || toSt === 'readable')
        ) {
          if (typeof tgen === 'number' && tgen <= terminalGen) {
            codes.push('FAIL_BLOCK_STALE_GENERATION');
          }
        }
      }
    }
  }

  // Scope decision invariants
  for (const dec of scopeDecisions) {
    if (!isPlainRecord(dec)) continue;
    const dgen = dec['allocation_generation'];
    if (dgen !== null && (typeof dgen !== 'number' || !Number.isInteger(dgen) || dgen < 1)) {
      codes.push('FAIL_BLOCK_GEN_MISSING_OR_ZERO');
    }
    if (dec['token_equality_used_for_public'] === true || dec['public_basis'] === 'token_equality') {
      codes.push('FAIL_SCOPE_PUBLIC_INFERRED');
    }
    if (dec['disposition'] === 'allow') {
      const rscope = dec['request_scope'];
      const bscope = dec['block_scope'];
      if (bscope === 'UNASSIGNED' || rscope === 'UNASSIGNED') {
        codes.push('FAIL_BLOCK_UNASSIGNED_READ');
      } else if (bscope === 'PUBLIC') {
        if (dec['public_basis'] !== 'owner_approved_immutable_prefix') {
          codes.push('FAIL_SCOPE_PUBLIC_INFERRED');
        }
      } else if (rscope !== bscope) {
        codes.push('FAIL_SCOPE_CROSS_TENANT_ACCEPTED');
      }
      if (dec['policy_epoch'] !== dec['block_policy_epoch']) {
        codes.push('FAIL_POLICY_EPOCH_MISMATCH');
      }
    }
  }

  // Paired runs numerical and outcome invariants
  const foreignAlias = scenario['foreign_block_alias'];
  for (const armName of EXPECTED_PAIRED_ARMS) {
    const arm = pairedRuns[armName];
    if (!isPlainRecord(arm)) {
      codes.push(isGpuClaimed ? 'FAIL_MISSING_REQUIRED_JOIN' : 'NV_MISSING_JOIN_EVIDENCE');
      continue;
    }

    const refBlocks = Array.isArray(arm['referenced_blocks']) ? arm['referenced_blocks'] : [];
    const refAliases = new Set<string>();
    for (const bref of refBlocks) {
      if (isPlainRecord(bref)) {
        if (typeof bref['physical_block_alias'] === 'string') {
          refAliases.add(bref['physical_block_alias']);
        }
        const gen = bref['allocation_generation'];
        if (gen !== null && (typeof gen !== 'number' || !Number.isInteger(gen) || gen < 1)) {
          codes.push('FAIL_BLOCK_GEN_MISSING_OR_ZERO');
        }
      }
    }

    if (
      (armName === 'native_clean' || armName === 'vervain_clean') &&
      typeof foreignAlias === 'string' &&
      refAliases.has(foreignAlias)
    ) {
      codes.push('FAIL_CLEAN_CONTAMINATED');
    }

    if (armName === 'vervain_fault_injected') {
      if (arm['outcome'] !== 'blocked_fail_closed' || arm['entered_attention_dispatch'] !== false) {
        codes.push('FAIL_VIOLATION_ENTERED_DISPATCH');
      }
      if (isFiniteNum(arm['foreign_mass']) && arm['foreign_mass'] > 0) {
        codes.push('FAIL_VIOLATION_ENTERED_DISPATCH');
      }
      const ranks = Array.isArray(arm['ranks']) ? arm['ranks'] : [];
      for (const rk of ranks) {
        if (isPlainRecord(rk) && rk['entered_attention_dispatch'] === true) {
          codes.push('FAIL_VIOLATION_ENTERED_DISPATCH');
        }
      }
    } else if (
      armName === 'native_clean' ||
      armName === 'vervain_clean' ||
      armName === 'vervain_allowed_after_fault'
    ) {
      if (arm['outcome'] !== 'completed' || arm['entered_attention_dispatch'] !== true) {
        codes.push('FAIL_ALLOWED_REQUEST_BLOCKED');
      }
    } else if (armName === 'native_fault_injected') {
      if (arm['entered_attention_dispatch'] !== true || arm['foreign_block_injected'] !== true) {
        codes.push('FAIL_NATIVE_FAULT_NO_INFLUENCE');
      }
    }
  }

  // Correctness & planted-value influence probe invariants
  const nc = isPlainRecord(pairedRuns['native_clean']) ? pairedRuns['native_clean'] : {};
  const vc = isPlainRecord(pairedRuns['vervain_clean']) ? pairedRuns['vervain_clean'] : {};
  const vf = isPlainRecord(pairedRuns['vervain_fault_injected'])
    ? pairedRuns['vervain_fault_injected']
    : {};
  const va = isPlainRecord(pairedRuns['vervain_allowed_after_fault'])
    ? pairedRuns['vervain_allowed_after_fault']
    : {};

  if (
    nc['seed'] !== vc['seed'] ||
    nc['seed'] !== correctness['seed'] ||
    nc['config_digest'] !== vc['config_digest'] ||
    nc['config_digest'] !== correctness['config_digest']
  ) {
    codes.push('FAIL_CLEAN_SEED_OR_CONFIG_MISMATCH');
  }

  const tol = correctness['equivalence_tolerance'];
  const delta = correctness['measured_max_abs_delta'];
  const eqPassed = correctness['clean_equivalence_passed'];
  if (!isFiniteNum(tol) || !isFiniteNum(delta) || eqPassed !== true || delta > tol || delta < 0) {
    codes.push('FAIL_EQUIVALENCE_TOLERANCE_EXCEEDED');
  }

  const probe = correctness['planted_value_influence_probe'];
  let vervainProbeInf: number | null = null;
  if (!isPlainRecord(probe)) {
    codes.push('FAIL_SCHEMA_INVALID');
  } else {
    const natInf = probe['native_fault_injected_influence_score'];
    const verInf = probe['vervain_fault_injected_influence_score'];
    vervainProbeInf = isFiniteNum(verInf) ? verInf : null;
    if (
      probe['raw_planted_value_omitted'] !== true ||
      probe['baseline_nonzero_influence'] !== true ||
      !isFiniteNum(natInf) ||
      natInf <= 0
    ) {
      codes.push('FAIL_NATIVE_FAULT_NO_INFLUENCE');
    }
    if (probe['vervain_zero_or_blocked'] !== true || !isFiniteNum(verInf) || verInf !== 0) {
      codes.push('FAIL_VIOLATION_ENTERED_DISPATCH');
    }
  }

  // Receipt chain sequential link check
  const isHex64 = (val: unknown): val is string =>
    typeof val === 'string' && /^[0-9a-f]{64}$/.test(val);
  const chainEvents = Array.isArray(receiptChain['events']) ? receiptChain['events'] : [];
  if (
    receiptChain['event_count'] !== chainEvents.length ||
    chainEvents.length === 0 ||
    !isHex64(receiptChain['genesis_sha256']) ||
    !isHex64(receiptChain['head_sha256'])
  ) {
    codes.push('FAIL_RECEIPT_CHAIN_BROKEN');
  } else {
    let prevHash: unknown = receiptChain['genesis_sha256'];
    for (let i = 0; i < chainEvents.length; i += 1) {
      const ev = chainEvents[i];
      if (!isPlainRecord(ev)) {
        codes.push('FAIL_RECEIPT_CHAIN_BROKEN');
        break;
      }
      if (ev['run_id'] !== art['run_id']) {
        codes.push('FAIL_RUN_ID_MISMATCH');
      }
      if (
        ev['event_index'] !== i ||
        !isHex64(ev['prev_sha256']) ||
        !isHex64(ev['event_sha256']) ||
        !isHex64(ev['canonical_event_sha256']) ||
        ev['prev_sha256'] !== prevHash ||
        ev['event_sha256'] !== ev['canonical_event_sha256']
      ) {
        codes.push('FAIL_RECEIPT_CHAIN_BROKEN');
      }
      prevHash = ev['event_sha256'];
    }
    if (prevHash !== receiptChain['head_sha256']) {
      codes.push('FAIL_RECEIPT_CHAIN_BROKEN');
    }
  }

  // Non-trust ui_summary contradiction check against raw-derived values
  if ('ui_summary' in art && art['ui_summary'] !== undefined) {
    const ui = art['ui_summary'];
    if (!isPlainRecord(ui)) {
      codes.push('FAIL_SCHEMA_INVALID');
    } else {
      const rawForeignStopped =
        vf['outcome'] === 'blocked_fail_closed' &&
        vf['entered_attention_dispatch'] === false &&
        vervainProbeInf === 0;
      const rawEquivPassed =
        eqPassed === true && isFiniteNum(tol) && isFiniteNum(delta) && delta <= tol;
      const rawAllowedCompleted =
        va['outcome'] === 'completed' &&
        va['entered_attention_dispatch'] === true &&
        correctness['allowed_after_fault_completed_after_violation'] === true;

      let ttftDeltaRaw: number | null = null;
      if (isPlainRecord(performance) && isPlainRecord(performance['metrics'])) {
        const ttftMetric = performance['metrics']['ttft_ms'];
        if (isPlainRecord(ttftMetric) && isFiniteNum(ttftMetric['delta_pct'])) {
          ttftDeltaRaw = ttftMetric['delta_pct'];
        }
      }

      const uiTtft = ui['ttft_delta_pct'];
      const ttftMismatch =
        (ttftDeltaRaw !== null && isFiniteNum(uiTtft) && Math.abs(uiTtft - ttftDeltaRaw) > 1e-3) ||
        (ttftDeltaRaw === null && uiTtft !== null && uiTtft !== undefined);

      if (
        ui['evidence_status'] !== rawStatus ||
        ui['foreign_block_stopped'] !== rawForeignStopped ||
        ui['clean_equivalence_passed'] !== rawEquivPassed ||
        ui['allowed_after_fault_completed'] !== rawAllowedCompleted ||
        ui['selected_runtime_backend'] !== selectedBackend ||
        ui['gpu_model'] !== gpuModel ||
        ui['tp_size'] !== tpSize ||
        ttftMismatch
      ) {
        codes.push('FAIL_UI_SUMMARY_CONTRADICTION');
      }
    }
  }

  return codes;
}

const FAIL_PRIORITY_ORDER: readonly string[] = [
  'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
  'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  'FAIL_CANON_DUPLICATE_KEY',
  'FAIL_CANON_PROTOTYPE_KEY',
  'FAIL_CANON_UNICODE_OR_NUL',
  'FAIL_CANON_NEGATIVE_ZERO',
  'FAIL_CANON_NONFINITE_NUMBER',
  'FAIL_CANON_INT_OVERFLOW',
  'FAIL_PARSE_SYNTAX',
  'FAIL_DIGEST_MISMATCH',
  'FAIL_UI_SUMMARY_CONTRADICTION',
  'FAIL_STATUS_LAUNDERING',
];

function selectPrimaryReasonCode(
  verdict: InferenceProofStatusView['verifierVerdict'],
  reasonCodes: readonly string[],
  claimedStatus: InferenceProofStatusView['claimedEvidenceStatus'],
): string {
  if (verdict === 'PASS') return 'PASS_VERIFIED';
  if (verdict === 'NOT_CONFIGURED') return 'NO_ARTIFACT_CONFIGURED';

  if (verdict === 'ERROR') {
    const errCode = reasonCodes.find((c) => c.startsWith('VERIFIER_ERROR_'));
    return errCode ?? reasonCodes[0] ?? 'VERIFIER_ERROR_INTERNAL';
  }

  if (verdict === 'FAIL') {
    for (const preferred of FAIL_PRIORITY_ORDER) {
      if (reasonCodes.includes(preferred)) return preferred;
    }
    const firstFail = reasonCodes.find((c) => c.startsWith('FAIL_'));
    return firstFail ?? reasonCodes[0] ?? 'FAIL_SCHEMA_INVALID';
  }

  // NO VERDICT
  if (reasonCodes.includes('NV_UNSUPPORTED_SCHEMA_VERSION')) {
    return 'NV_UNSUPPORTED_SCHEMA_VERSION';
  }
  if (claimedStatus === 'local_only' && reasonCodes.includes('NV_STATUS_LOCAL_ONLY')) {
    return 'NV_STATUS_LOCAL_ONLY';
  }
  if (claimedStatus === 'incomplete' && reasonCodes.includes('NV_STATUS_INCOMPLETE')) {
    return 'NV_STATUS_INCOMPLETE';
  }
  const firstNv = reasonCodes.find((c) => c.startsWith('NV_'));
  return firstNv ?? reasonCodes[0] ?? 'NV_STATUS_INCOMPLETE';
}

function mapBadgeAndVerdict(params: {
  reasonCodes: readonly string[];
  claimedStatus: InferenceProofStatusView['claimedEvidenceStatus'];
}): {
  badgeState: InferenceProofBadgeState;
  verifierVerdict: InferenceProofStatusView['verifierVerdict'];
  verifiedEvidenceStatus: InferenceProofStatusView['verifiedEvidenceStatus'];
  primaryReasonCode: string;
  normalizedCodes: readonly string[];
} {
  const unique = [...new Set(params.reasonCodes)];
  const hasError = unique.some((c) => c.startsWith('VERIFIER_ERROR_'));
  const hasFail = unique.some((c) => c.startsWith('FAIL_'));
  const hasNv = unique.some((c) => c.startsWith('NV_'));

  // Never allow local_only, incomplete, or none to become PASS even if caller omitted NV codes
  const forcedNonPassStatus =
    params.claimedStatus === 'local_only'
      ? 'NV_STATUS_LOCAL_ONLY'
      : params.claimedStatus === 'incomplete'
        ? 'NV_STATUS_INCOMPLETE'
        : params.claimedStatus === 'none'
          ? 'FAIL_SCHEMA_INVALID'
          : null;

  if (forcedNonPassStatus && !unique.includes(forcedNonPassStatus)) {
    unique.push(forcedNonPassStatus);
  }

  const effectiveHasFail = hasFail || unique.some((c) => c.startsWith('FAIL_'));
  const effectiveHasNv = hasNv || unique.some((c) => c.startsWith('NV_'));

  let verifierVerdict: InferenceProofStatusView['verifierVerdict'];
  if (effectiveHasFail) {
    verifierVerdict = 'FAIL';
  } else if (hasError) {
    verifierVerdict = 'ERROR';
  } else if (effectiveHasNv) {
    verifierVerdict = 'NO VERDICT';
  } else {
    verifierVerdict = 'PASS';
  }

  const normalizedCodes =
    verifierVerdict === 'PASS' ? Object.freeze(['PASS_VERIFIED']) : Object.freeze([...unique].sort());

  const primaryReasonCode = selectPrimaryReasonCode(
    verifierVerdict,
    normalizedCodes,
    params.claimedStatus,
  );

  let badgeState: InferenceProofBadgeState;
  let verifiedEvidenceStatus: InferenceProofStatusView['verifiedEvidenceStatus'];

  if (verifierVerdict === 'FAIL' || verifierVerdict === 'ERROR') {
    badgeState = 'VERIFICATION FAILED';
    verifiedEvidenceStatus = 'unverified';
  } else if (normalizedCodes.includes('NV_UNSUPPORTED_SCHEMA_VERSION')) {
    badgeState = 'UNSUPPORTED';
    verifiedEvidenceStatus = 'unverified';
  } else if (verifierVerdict === 'NO VERDICT') {
    if (params.claimedStatus === 'local_only') {
      badgeState = 'LOCAL TEST';
      verifiedEvidenceStatus = 'local_only';
    } else if (params.claimedStatus === 'incomplete') {
      badgeState = 'INCOMPLETE';
      verifiedEvidenceStatus = 'incomplete';
    } else {
      badgeState = 'NO VERDICT';
      verifiedEvidenceStatus = 'unverified';
    }
  } else {
    if (params.claimedStatus === 'live') {
      badgeState = 'LIVE H200 RUN';
      verifiedEvidenceStatus = 'live';
    } else {
      badgeState = 'RECORDED H200 RUN';
      verifiedEvidenceStatus = 'recorded';
    }
  }

  return {
    badgeState,
    verifierVerdict,
    verifiedEvidenceStatus,
    primaryReasonCode,
    normalizedCodes,
  };
}

/**
 * Evaluates a raw `inference-proof.v1` JSON string completely in-process with strict
 * RFC 8259/8785 parsing, zero-echo sanitization, JCS SHA-256 recomputation, and Carbon 3
 * status honesty rules.
 */
export function evaluateInferenceProofArtifactRaw(
  rawJsonText: string,
  options?: EvaluateInferenceProofOptions,
): InferenceProofStatusView {
  const checkedAtIso = options?.nowIso ?? new Date().toISOString();
  const requireSignature = Boolean(options?.requireSignature);

  let parsed: unknown;
  try {
    parsed = parseStrictInferenceProofJson(rawJsonText);
  } catch (err) {
    const parseCode =
      err instanceof InferenceProofStrictJsonError ? err.reasonCode : 'FAIL_PARSE_SYNTAX';
    const rawSan = sanitizeRawTextZeroEcho(rawJsonText);
    const combinedCodes = [...new Set([parseCode, ...rawSan.reasonCodes])];
    return Object.freeze({
      badgeState: 'VERIFICATION FAILED',
      verifierVerdict: 'FAIL',
      primaryReasonCode: parseCode,
      reasonCodes: Object.freeze(combinedCodes),
      claimedEvidenceStatus: 'none',
      verifiedEvidenceStatus: 'unverified',
      runId: null,
      artifactSha256Declared: null,
      artifactSha256Computed: null,
      digestMatch: null,
      sanitizerPassed: rawSan.passed,
      sanitizerFindingsCount: rawSan.findingCount,
      runtimeManifest: null,
      exclusions: Object.freeze([]),
      claimBoundary: INFERENCE_PROOF_EVALUATED_CLAIM_BOUNDARY,
      checkedAtIso,
    });
  }

  const san = sanitizeInferenceProofStructure(parsed);
  const codes: string[] = [...san.reasonCodes];

  if (!isPlainRecord(parsed)) {
    codes.push('FAIL_SCHEMA_INVALID');
    const mapped = mapBadgeAndVerdict({ reasonCodes: codes, claimedStatus: 'none' });
    return Object.freeze({
      badgeState: mapped.badgeState,
      verifierVerdict: mapped.verifierVerdict,
      primaryReasonCode: mapped.primaryReasonCode,
      reasonCodes: mapped.normalizedCodes,
      claimedEvidenceStatus: 'none',
      verifiedEvidenceStatus: 'unverified',
      runId: null,
      artifactSha256Declared: null,
      artifactSha256Computed: null,
      digestMatch: null,
      sanitizerPassed: san.passed,
      sanitizerFindingsCount: san.findingCount,
      runtimeManifest: null,
      exclusions: Object.freeze([]),
      claimBoundary: INFERENCE_PROOF_EVALUATED_CLAIM_BOUNDARY,
      checkedAtIso,
    });
  }

  const claimedStatus = parseSafeClaimedStatus(parsed['evidence_status']);
  const runId = extractSafeRunId(parsed['run_id'], san.passed);
  const declaredShaSafe = extractSafeSha256(parsed['artifact_sha256'], san.passed);

  if (parsed['schema_version'] !== SUPPORTED_SCHEMA_VERSION) {
    codes.push('NV_UNSUPPORTED_SCHEMA_VERSION');
    const hasSanitizerFail = codes.some((c) => c.startsWith('FAIL_'));
    const normalized = Object.freeze([...new Set(codes)].sort());
    return Object.freeze({
      badgeState: hasSanitizerFail ? 'VERIFICATION FAILED' : 'UNSUPPORTED',
      verifierVerdict: hasSanitizerFail ? 'FAIL' : 'NO VERDICT',
      primaryReasonCode: hasSanitizerFail
        ? selectPrimaryReasonCode('FAIL', normalized, claimedStatus)
        : 'NV_UNSUPPORTED_SCHEMA_VERSION',
      reasonCodes: normalized,
      claimedEvidenceStatus: claimedStatus,
      verifiedEvidenceStatus: 'unverified',
      runId,
      artifactSha256Declared: declaredShaSafe,
      artifactSha256Computed: null,
      digestMatch: null,
      sanitizerPassed: san.passed,
      sanitizerFindingsCount: san.findingCount,
      runtimeManifest: null,
      exclusions: Object.freeze([]),
      claimBoundary: INFERENCE_PROOF_EVALUATED_CLAIM_BOUNDARY,
      checkedAtIso,
    });
  }

  const computedSha = computeInferenceProofSha256(parsed);
  const rawDeclared = typeof parsed['artifact_sha256'] === 'string' ? parsed['artifact_sha256'] : '';
  const digestMatch = timingSafeHexDigestEqual(rawDeclared, computedSha);
  if (!digestMatch) {
    codes.push('FAIL_DIGEST_MISMATCH');
  }

  const invariantCodes = evaluateCoreInvariants(parsed, computedSha, requireSignature);
  codes.push(...invariantCodes);

  const mapped = mapBadgeAndVerdict({
    reasonCodes: codes,
    claimedStatus,
  });

  const allowManifestExposure = san.passed && mapped.verifierVerdict === 'PASS';

  return Object.freeze({
    badgeState: mapped.badgeState,
    verifierVerdict: mapped.verifierVerdict,
    primaryReasonCode: mapped.primaryReasonCode,
    reasonCodes: mapped.normalizedCodes,
    claimedEvidenceStatus: claimedStatus,
    verifiedEvidenceStatus: mapped.verifiedEvidenceStatus,
    runId,
    artifactSha256Declared: declaredShaSafe,
    artifactSha256Computed: computedSha,
    digestMatch,
    sanitizerPassed: san.passed,
    sanitizerFindingsCount: san.findingCount,
    runtimeManifest: extractRuntimeManifestView(parsed, allowManifestExposure),
    exclusions: extractExclusionsList(parsed, allowManifestExposure),
    claimBoundary: INFERENCE_PROOF_EVALUATED_CLAIM_BOUNDARY,
    checkedAtIso,
  });
}

interface PythonCliParsedResult {
  readonly verdict: 'PASS' | 'FAIL' | 'NO VERDICT' | 'ERROR';
  readonly primaryReasonCode: string;
  readonly reasonCodes: readonly string[];
  readonly sanitizerPassed: boolean;
  readonly sanitizerFindingCount: number;
}

function invokePythonEvidenceVerifier(params: {
  pythonVerifierSrc: string;
  artifactPath: string;
  trustRootPath?: string | null;
  requireSignature: boolean;
}): PythonCliParsedResult {
  const args = ['-m', 'evidence_verifier', 'verify', params.artifactPath];
  if (params.trustRootPath && params.trustRootPath.trim().length > 0) {
    args.push('--trust-root', params.trustRootPath.trim());
  }
  if (params.requireSignature) {
    args.push('--require-signature');
  }

  const minimalEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
    PYTHONPATH: params.pythonVerifierSrc,
    PYTHONDONTWRITEBYTECODE: '1',
    LC_ALL: 'C.UTF-8',
    LANG: 'C.UTF-8',
  };

  let rawStdout: string | null = null;
  try {
    rawStdout = execFileSync('python3', args, {
      env: minimalEnv,
      encoding: 'utf8',
      shell: false,
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    const execErr = err as { stdout?: string | Buffer };
    if (typeof execErr.stdout === 'string') {
      rawStdout = execErr.stdout;
    } else if (Buffer.isBuffer(execErr.stdout)) {
      rawStdout = execErr.stdout.toString('utf8');
    } else {
      return {
        verdict: 'ERROR',
        primaryReasonCode: 'VERIFIER_ERROR_INTERNAL',
        reasonCodes: ['VERIFIER_ERROR_INTERNAL'],
        sanitizerPassed: true,
        sanitizerFindingCount: 0,
      };
    }
  }

  const trimmed = rawStdout.trim();
  if (!trimmed.startsWith('{')) {
    return {
      verdict: 'ERROR',
      primaryReasonCode: 'VERIFIER_ERROR_INTERNAL',
      reasonCodes: ['VERIFIER_ERROR_INTERNAL'],
      sanitizerPassed: true,
      sanitizerFindingCount: 0,
    };
  }

  let parsedCli: unknown;
  try {
    parsedCli = parseStrictInferenceProofJson(trimmed);
  } catch {
    return {
      verdict: 'ERROR',
      primaryReasonCode: 'VERIFIER_ERROR_INTERNAL',
      reasonCodes: ['VERIFIER_ERROR_INTERNAL'],
      sanitizerPassed: true,
      sanitizerFindingCount: 0,
    };
  }

  if (!isPlainRecord(parsedCli)) {
    return {
      verdict: 'ERROR',
      primaryReasonCode: 'VERIFIER_ERROR_INTERNAL',
      reasonCodes: ['VERIFIER_ERROR_INTERNAL'],
      sanitizerPassed: true,
      sanitizerFindingCount: 0,
    };
  }

  const rawVerdict = parsedCli['verdict'];
  const verdict: PythonCliParsedResult['verdict'] =
    rawVerdict === 'PASS' ||
    rawVerdict === 'FAIL' ||
    rawVerdict === 'NO VERDICT' ||
    rawVerdict === 'ERROR'
      ? rawVerdict
      : 'ERROR';

  const rawCodes = Array.isArray(parsedCli['reason_codes'])
    ? parsedCli['reason_codes'].filter((c): c is string => typeof c === 'string')
    : typeof parsedCli['reason_code'] === 'string'
      ? [parsedCli['reason_code']]
      : [];

  const primary =
    typeof parsedCli['primary_reason_code'] === 'string'
      ? parsedCli['primary_reason_code']
      : rawCodes[0] ?? (verdict === 'PASS' ? 'PASS_VERIFIED' : 'VERIFIER_ERROR_INTERNAL');

  const sanRec = parsedCli['sanitizer_result'];
  const sanPassed = isPlainRecord(sanRec) && typeof sanRec['passed'] === 'boolean'
    ? sanRec['passed']
    : !rawCodes.some((c) =>
        c === 'FAIL_SECRET_LEAK_KEY_OR_TOKEN' ||
        c === 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV' ||
        c === 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE' ||
        c === 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
      );
  const sanCount =
    isPlainRecord(sanRec) && typeof sanRec['finding_count'] === 'number'
      ? sanRec['finding_count']
      : sanPassed
        ? 0
        : 1;

  return {
    verdict,
    primaryReasonCode: primary,
    reasonCodes: rawCodes.length > 0 ? rawCodes : [primary],
    sanitizerPassed: sanPassed,
    sanitizerFindingCount: sanCount,
  };
}

/**
 * Loads and verifies the configured `inference-proof.v1` artifact from disk, returning
 * `NO GPU RUN RECORDED` (`NOT_CONFIGURED`) when unset, or combining the independent
 * TypeScript check with the authoritative Carbon 3 Python CLI when `pythonVerifierSrc` exists.
 */
export function loadConfiguredInferenceProofStatus(
  options?: LoadConfiguredInferenceProofOptions,
): InferenceProofStatusView {
  const checkedAtIso = options?.nowIso ?? new Date().toISOString();
  const rawArtifactPath = (options?.artifactPath ?? '').trim();

  if (rawArtifactPath.length === 0) {
    return Object.freeze({
      badgeState: 'NO GPU RUN RECORDED',
      verifierVerdict: 'NOT_CONFIGURED',
      primaryReasonCode: 'NO_ARTIFACT_CONFIGURED',
      reasonCodes: Object.freeze(['NO_ARTIFACT_CONFIGURED']),
      claimedEvidenceStatus: 'none',
      verifiedEvidenceStatus: 'none',
      runId: null,
      artifactSha256Declared: null,
      artifactSha256Computed: null,
      digestMatch: null,
      sanitizerPassed: true,
      sanitizerFindingsCount: 0,
      runtimeManifest: null,
      exclusions: Object.freeze([]),
      claimBoundary: INFERENCE_PROOF_NO_ARTIFACT_CLAIM_BOUNDARY,
      checkedAtIso,
    });
  }

  const resolvedArtifactPath = path.resolve(rawArtifactPath);
  let rawBytes: Buffer;
  try {
    const stat = fs.statSync(resolvedArtifactPath);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
      return Object.freeze({
        badgeState: 'VERIFICATION FAILED',
        verifierVerdict: 'ERROR',
        primaryReasonCode: 'VERIFIER_ERROR_IO',
        reasonCodes: Object.freeze(['VERIFIER_ERROR_IO']),
        claimedEvidenceStatus: 'none',
        verifiedEvidenceStatus: 'unverified',
        runId: null,
        artifactSha256Declared: null,
        artifactSha256Computed: null,
        digestMatch: null,
        sanitizerPassed: true,
        sanitizerFindingsCount: 0,
        runtimeManifest: null,
        exclusions: Object.freeze([]),
        claimBoundary: INFERENCE_PROOF_EVALUATED_CLAIM_BOUNDARY,
        checkedAtIso,
      });
    }
    rawBytes = fs.readFileSync(resolvedArtifactPath);
  } catch {
    return Object.freeze({
      badgeState: 'VERIFICATION FAILED',
      verifierVerdict: 'ERROR',
      primaryReasonCode: 'VERIFIER_ERROR_IO',
      reasonCodes: Object.freeze(['VERIFIER_ERROR_IO']),
      claimedEvidenceStatus: 'none',
      verifiedEvidenceStatus: 'unverified',
      runId: null,
      artifactSha256Declared: null,
      artifactSha256Computed: null,
      digestMatch: null,
      sanitizerPassed: true,
      sanitizerFindingsCount: 0,
      runtimeManifest: null,
      exclusions: Object.freeze([]),
      claimBoundary: INFERENCE_PROOF_EVALUATED_CLAIM_BOUNDARY,
      checkedAtIso,
    });
  }

  let rawJsonText: string;
  try {
    rawJsonText = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch {
    const fallbackSan = sanitizeRawTextZeroEcho(rawBytes.toString('utf8'));
    const badUtf8Codes = [...new Set(['FAIL_PARSE_SYNTAX', ...fallbackSan.reasonCodes])];
    return Object.freeze({
      badgeState: 'VERIFICATION FAILED',
      verifierVerdict: 'FAIL',
      primaryReasonCode: 'FAIL_PARSE_SYNTAX',
      reasonCodes: Object.freeze(badUtf8Codes),
      claimedEvidenceStatus: 'none',
      verifiedEvidenceStatus: 'unverified',
      runId: null,
      artifactSha256Declared: null,
      artifactSha256Computed: null,
      digestMatch: null,
      sanitizerPassed: fallbackSan.passed,
      sanitizerFindingsCount: fallbackSan.findingCount,
      runtimeManifest: null,
      exclusions: Object.freeze([]),
      claimBoundary: INFERENCE_PROOF_EVALUATED_CLAIM_BOUNDARY,
      checkedAtIso,
    });
  }

  const requireSignature = Boolean(options?.requireSignature);
  const localStatus = evaluateInferenceProofArtifactRaw(rawJsonText, {
    requireSignature,
    nowIso: checkedAtIso,
  });

  const rawPythonSrc = (options?.pythonVerifierSrc ?? '').trim();
  if (rawPythonSrc.length === 0 || !fs.existsSync(rawPythonSrc)) {
    return localStatus;
  }

  const pyRes = invokePythonEvidenceVerifier({
    pythonVerifierSrc: path.resolve(rawPythonSrc),
    artifactPath: resolvedArtifactPath,
    trustRootPath: options?.trustRootPath,
    requireSignature,
  });

  // Merge local zero-echo / strict-JSON findings with authoritative Python Carbon 3 result.
  const combinedSanPassed = localStatus.sanitizerPassed && pyRes.sanitizerPassed;
  const combinedSanCount = Math.max(
    localStatus.sanitizerFindingsCount,
    pyRes.sanitizerFindingCount,
  );

  const mergedCodes: string[] = [];
  for (const localCode of localStatus.reasonCodes) {
    if (localCode === 'PASS_VERIFIED') continue;
    // Allow authoritative Python trust-root verification to resolve local NV_TRUST_ROOT_UNPROVIDED
    if (localCode === 'NV_TRUST_ROOT_UNPROVIDED' && pyRes.verdict === 'PASS') continue;
    mergedCodes.push(localCode);
  }
  for (const pyCode of pyRes.reasonCodes) {
    if (pyCode === 'PASS_VERIFIED') continue;
    mergedCodes.push(pyCode);
  }

  if (localStatus.claimedEvidenceStatus === 'none' && localStatus.verifierVerdict === 'FAIL') {
    const failCodes = [...new Set([...localStatus.reasonCodes, ...mergedCodes])];
    return Object.freeze({
      ...localStatus,
      reasonCodes: Object.freeze(failCodes),
      sanitizerPassed: combinedSanPassed,
      sanitizerFindingsCount: combinedSanCount,
      runtimeManifest: null,
      exclusions: Object.freeze([]),
    });
  }

  const mapped = mapBadgeAndVerdict({
    reasonCodes: mergedCodes,
    claimedStatus: localStatus.claimedEvidenceStatus,
  });

  // Preserve Python primary reason code when Python drove a FAIL, NO VERDICT, or ERROR
  const chosenPrimary =
    pyRes.verdict !== 'PASS' &&
    mapped.normalizedCodes.includes(pyRes.primaryReasonCode) &&
    (mapped.verifierVerdict === pyRes.verdict ||
      (pyRes.verdict === 'FAIL' && mapped.verifierVerdict === 'FAIL'))
      ? pyRes.primaryReasonCode
      : mapped.primaryReasonCode;

  const allowMergedManifest = combinedSanPassed && mapped.verifierVerdict === 'PASS';
  let mergedManifest: InferenceProofStatusView['runtimeManifest'] = null;
  let mergedExclusions: readonly string[] = Object.freeze([]);
  if (allowMergedManifest) {
    if (localStatus.runtimeManifest !== null) {
      mergedManifest = localStatus.runtimeManifest;
      mergedExclusions = localStatus.exclusions;
    } else {
      try {
        const parsedForMerge = parseStrictInferenceProofJson(rawJsonText);
        if (isPlainRecord(parsedForMerge)) {
          mergedManifest = extractRuntimeManifestView(parsedForMerge, true);
          mergedExclusions = extractExclusionsList(parsedForMerge, true);
        }
      } catch {
        mergedManifest = null;
        mergedExclusions = Object.freeze([]);
      }
    }
  }

  return Object.freeze({
    badgeState: mapped.badgeState,
    verifierVerdict: mapped.verifierVerdict,
    primaryReasonCode: chosenPrimary,
    reasonCodes: mapped.normalizedCodes,
    claimedEvidenceStatus: localStatus.claimedEvidenceStatus,
    verifiedEvidenceStatus: mapped.verifiedEvidenceStatus,
    runId: combinedSanPassed ? localStatus.runId : null,
    artifactSha256Declared: combinedSanPassed ? localStatus.artifactSha256Declared : null,
    artifactSha256Computed: localStatus.artifactSha256Computed,
    digestMatch: localStatus.digestMatch,
    sanitizerPassed: combinedSanPassed,
    sanitizerFindingsCount: combinedSanCount,
    runtimeManifest: mergedManifest,
    exclusions: mergedExclusions,
    claimBoundary: INFERENCE_PROOF_EVALUATED_CLAIM_BOUNDARY,
    checkedAtIso,
  });
}
