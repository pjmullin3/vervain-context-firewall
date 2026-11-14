/**
 * Responsibility: Zero-echo sanitizer for TypeScript/Node verifier consumers.
 * Trust boundary: Rejects forbidden keys, secret regexes, PII, and planted values before display.
 */

export interface SanitizerFinding {
  ruleId: string;
  jsonPointer: string;
  reasonCode: string;
  redactedPreview: string;
}

export interface SanitizerResult {
  passed: boolean;
  findingCount: number;
  findings: SanitizerFinding[];
}

const FORBIDDEN_KEYS: Record<string, string> = {
  rawprompt: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  prompt: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  prompttext: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  systemprompt: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  messages: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  rawresponse: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  completion: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  plantedvalue: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
  rawplantedvalue: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
  canary: 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE',
  kvtensor: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  kvtensors: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  kvcache: 'FAIL_PROTECTED_CONTENT_PROMPT_OR_KV',
  secret: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  apikey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  geminiapikey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  privatekey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  signingkey: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  password: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  cookie: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  authorization: 'FAIL_SECRET_LEAK_KEY_OR_TOKEN',
  email: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  ipaddress: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
  ssn: 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK',
};

const VALUE_PATTERNS: ReadonlyArray<[string, string, RegExp]> = [
  ['SEC_GOOGLE_API_KEY', 'FAIL_SECRET_LEAK_KEY_OR_TOKEN', /AIza[0-9A-Za-z\-_]{20,}/],
  ['SEC_OPENAI_KEY', 'FAIL_SECRET_LEAK_KEY_OR_TOKEN', /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{20,}/],
  ['SEC_GITHUB_TOKEN', 'FAIL_SECRET_LEAK_KEY_OR_TOKEN', /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/],
  ['SEC_PEM_PRIVATE_KEY', 'FAIL_SECRET_LEAK_KEY_OR_TOKEN', /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/],
  ['SEC_BEARER_TOKEN', 'FAIL_SECRET_LEAK_KEY_OR_TOKEN', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i],
  ['PII_EMAIL', 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['PII_IPV4', 'FAIL_PII_OR_NETWORK_ADDRESS_LEAK', /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/],
  ['CONTENT_PLANTED_DEFAULT', 'FAIL_PROTECTED_CONTENT_PLANTED_VALUE', /VERVAIN_PLANTED_[A-Z0-9_]{4,}|ALDER_CANARY_[A-Z0-9_]{4,}/i],
];

export function sanitizeStructure(data: unknown): SanitizerResult {
  const findings: SanitizerFinding[] = [];

  const scanString = (val: string, ptr: string): void => {
    for (const [ruleId, reasonCode, re] of VALUE_PATTERNS) {
      if (re.test(val)) {
        findings.push({
          ruleId,
          jsonPointer: ptr,
          reasonCode,
          redactedPreview: `[REDACTED_LEN_${val.length}]`,
        });
      }
    }
  };

  const walk = (node: unknown, ptr: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, idx) => walk(item, `${ptr}[${idx}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      const rec = node as Record<string, unknown>;
      for (const k of Object.keys(rec)) {
        const childPtr = `${ptr}.${k}`;
        const norm = k.toLowerCase().replace(/[^a-z0-9]/g, '');
        const hitCode = FORBIDDEN_KEYS[norm];
        if (hitCode) {
          findings.push({
            ruleId: `KEY_${norm.toUpperCase()}`,
            jsonPointer: childPtr,
            reasonCode: hitCode,
            redactedPreview: '[REDACTED_KEY_VALUE]',
          });
        }
        scanString(k, `${childPtr}#key`);
        walk(rec[k], childPtr);
      }
      return;
    }
    if (typeof node === 'string') {
      scanString(node, ptr);
    }
  };

  walk(data, '$');
  return {
    passed: findings.length === 0,
    findingCount: findings.length,
    findings,
  };
}
