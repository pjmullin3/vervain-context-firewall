import type { ValidationIssue } from "./types.js";

/**
 * Untrusted evidence hygiene:
 * - Reject protected field keys anywhere in the input graph
 * - Reject network URLs, IP addresses, emails, credentials, and raw secrets
 * - Strip/reject control characters and bidi override codepoints
 * - Enforce explicit string and collection caps
 * - Escape HTML entities for plain-text / non-React output sinks
 */

export const LIMITS = Object.freeze({
  maxGraphDepth: 12,
  maxGraphNodes: 1500,
  maxIdLength: 64,
  maxShortLabelLength: 120,
  maxNoteLength: 260,
  maxExclusions: 12,
  maxUnmediatedSurfaces: 8,
  maxLineageItems: 8,
  maxBlocksPerLane: 8,
  maxStepsPerLane: 9
} as const);

const FORBIDDEN_PROTECTED_KEY_PATTERNS: readonly RegExp[] = [
  /(?:^|[_-])prompt(?:$|[_-])/i,
  /^prompt$/i,
  /raw[_-]?prompt/i,
  /system[_-]?prompt/i,
  /planted[_-]?value/i,
  /(?:^|[_-])canary(?:$|[_-])/i,
  /protected[_-]?output/i,
  /raw[_-]?output/i,
  /completion[_-]?text/i,
  /response[_-]?body/i,
  /kv[_-]?tensor/i,
  /tensor[_-]?(?:bytes|data|values|blob|dump)/i,
  /(?:^|[_-])secret(?:s)?(?:$|[_-])/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /(?:^|[_-])credential(?:s)?(?:$|[_-])/i,
  /(?:^|[_-])password(?:$|[_-])/i,
  /(?:^|[_-])authorization(?:$|[_-])/i,
  /(?:^|[_-])cookie(?:$|[_-])/i,
  /bearer[_-]?token/i,
  /access[_-]?token/i,
  /session[_-]?token/i,
  /(?:^|[_-])address(?:$|[_-])/i,
  /ip[_-]?addr/i,
  /mac[_-]?addr/i,
  /endpoint[_-]?url/i,
  /webhook/i,
  /(?:^|[_-])email(?:$|[_-])/i,
  /(?:^|[_-])dsn(?:$|[_-])/i
];

const UNSAFE_STRING_VALUE_PATTERNS: readonly { label: string; regex: RegExp }[] = [
  { label: "network URL scheme", regex: /\b(?:https?|wss?|tcp|ssh|ftp|file|postgres|redis):\/\//i },
  {
    label: "IPv4 address",
    regex: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/
  },
  { label: "email address", regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { label: "PEM block", regex: /-----BEGIN [A-Z0-9 ]+-----/ },
  {
    label: "credential prefix",
    regex: /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{12,})\b/
  },
  {
    label: "JWT structure",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/
  }
];

// Disallow ASCII control characters and Unicode bidirectional formatting overrides.
const UNSAFE_CONTROL_OR_BIDI_REGEX =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function isForbiddenProtectedKey(key: string): boolean {
  return FORBIDDEN_PROTECTED_KEY_PATTERNS.some((regex) => regex.test(key));
}

export function scanUntrustedGraph(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let visitedNodes = 0;

  function visit(node: unknown, path: string, depth: number): void {
    visitedNodes += 1;
    if (visitedNodes > LIMITS.maxGraphNodes) {
      if (!issues.some((i) => i.code === "COLLECTION_CAP_EXCEEDED" && i.path === "$")) {
        issues.push({
          code: "COLLECTION_CAP_EXCEEDED",
          path: "$",
          message: `Input graph exceeds maximum node count (${LIMITS.maxGraphNodes}).`
        });
      }
      return;
    }

    if (depth > LIMITS.maxGraphDepth) {
      issues.push({
        code: "COLLECTION_CAP_EXCEEDED",
        path,
        message: `Input nesting depth exceeds maximum (${LIMITS.maxGraphDepth}).`
      });
      return;
    }

    if (typeof node === "string") {
      if (UNSAFE_CONTROL_OR_BIDI_REGEX.test(node)) {
        issues.push({
          code: "UNSAFE_VALUE_PATTERN",
          path,
          message: "String value contains disallowed control or bidirectional override characters."
        });
      }
      for (const rule of UNSAFE_STRING_VALUE_PATTERNS) {
        if (rule.regex.test(node)) {
          issues.push({
            code: "UNSAFE_VALUE_PATTERN",
            path,
            message: `String value rejected due to disallowed ${rule.label}.`
          });
          break;
        }
      }
      return;
    }

    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        issues.push({
          code: "NON_FINITE_OR_IMPOSSIBLE_NUMBER",
          path,
          message: "Numeric value must be finite (NaN and Infinity are rejected)."
        });
      }
      return;
    }

    if (Array.isArray(node)) {
      if (node.length > 64) {
        issues.push({
          code: "COLLECTION_CAP_EXCEEDED",
          path,
          message: "Array length exceeds maximum allowed Untrusted Input cap (64)."
        });
        return;
      }
      for (let idx = 0; idx < node.length; idx += 1) {
        visit(node[idx], `${path}[${idx}]`, depth + 1);
      }
      return;
    }

    if (node !== null && typeof node === "object") {
      const proto = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) {
        issues.push({
          code: "INVALID_ROOT_OBJECT",
          path,
          message: "Evidence objects must be plain JSON records."
        });
        return;
      }
      const keys = Object.keys(node as Record<string, unknown>);
      if (keys.length > 48) {
        issues.push({
          code: "COLLECTION_CAP_EXCEEDED",
          path,
          message: "Object key count exceeds maximum cap (48)."
        });
        return;
      }
      for (const key of keys) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          issues.push({
            code: "FORBIDDEN_PROTECTED_FIELD",
            path: `${path}.${key}`,
            message: "Prototype-polluting property key rejected."
          });
          continue;
        }
        if (isForbiddenProtectedKey(key)) {
          issues.push({
            code: "FORBIDDEN_PROTECTED_FIELD",
            path: `${path}.${key}`,
            message: `Protected or sensitive field '${escapeHtml(key.slice(0, 40))}' is strictly forbidden in replay evidence.`
          });
          continue;
        }
        visit((node as Record<string, unknown>)[key], `${path}.${key}`, depth + 1);
      }
    }
  }

  visit(input, "$", 0);
  return issues;
}

const SAFE_IDENTIFIER_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;
const SHA256_PREFIXED_REGEX = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA_OR_UNRECORDED_REGEX = /^(?:[a-f0-9]{7,40}|unrecorded)$/;
const ISO_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export function validateSafeId(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  maxLength: number = LIMITS.maxIdLength
): string {
  if (typeof value !== "string") {
    issues.push({
      code: "INVALID_SCALAR_TYPE",
      path,
      message: "Expected string identifier."
    });
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    issues.push({
      code: "TEXT_CAP_EXCEEDED",
      path,
      message: `Identifier must be 1..${maxLength} characters.`
    });
    return "";
  }
  if (!SAFE_IDENTIFIER_REGEX.test(trimmed)) {
    issues.push({
      code: "UNSAFE_VALUE_PATTERN",
      path,
      message: "Identifier contains disallowed characters."
    });
    return "";
  }
  return trimmed;
}

export function validateBoundedText(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  maxLength: number = LIMITS.maxNoteLength
): string {
  if (typeof value !== "string") {
    issues.push({
      code: "INVALID_SCALAR_TYPE",
      path,
      message: "Expected bounded text string."
    });
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    issues.push({
      code: "INVALID_SCALAR_TYPE",
      path,
      message: "Text field must not be empty."
    });
    return "";
  }
  if (trimmed.length > maxLength) {
    issues.push({
      code: "TEXT_CAP_EXCEEDED",
      path,
      message: `Text length (${trimmed.length}) exceeds cap (${maxLength}).`
    });
    return "";
  }
  return trimmed;
}

export function validateSha256Prefixed(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): string {
  if (typeof value !== "string" || !SHA256_PREFIXED_REGEX.test(value)) {
    issues.push({
      code: "UNSAFE_VALUE_PATTERN",
      path,
      message: "Expected lowercase sha256:<64-hex> digest."
    });
    return "";
  }
  return value;
}

export function validateGitShaOrUnrecorded(
  value: unknown,
  path: string,
  allowUnrecorded: boolean,
  issues: ValidationIssue[]
): string {
  if (typeof value !== "string" || !GIT_SHA_OR_UNRECORDED_REGEX.test(value)) {
    issues.push({
      code: "UNSAFE_VALUE_PATTERN",
      path,
      message: "Expected lowercase git commit SHA (7..40 hex chars)."
    });
    return "";
  }
  if (value === "unrecorded" && !allowUnrecorded) {
    issues.push({
      code: "UNSAFE_VALUE_PATTERN",
      path,
      message: "'unrecorded' git SHA is permitted only for incomplete runs."
    });
    return "";
  }
  return value;
}

export function validateIsoUtcTimestamp(
  value: unknown,
  path: string,
  issues: ValidationIssue[]
): string {
  if (typeof value !== "string" || !ISO_UTC_REGEX.test(value) || Number.isNaN(Date.parse(value))) {
    issues.push({
      code: "UNSAFE_VALUE_PATTERN",
      path,
      message: "Expected valid ISO-8601 UTC timestamp ending in 'Z'."
    });
    return "";
  }
  return value;
}

export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepFreeze(item);
    }
  } else {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(obj);
}
