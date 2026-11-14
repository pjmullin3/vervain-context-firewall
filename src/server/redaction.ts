/**
 * Responsibility: Structured content-free logging, ANSI/control-character sanitization,
 * and recursive prohibited-substring scanning for receipts, logs, and API errors.
 * Trust boundary: Ensures untrusted strings, document text, prompts, responses, and secrets
 * never enter structured telemetry or exported audit artifacts.
 */

import crypto from 'node:crypto';

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export function domainSeparatedDigest(domain: string, value: string): string {
  return sha256Hex(`vervain.cf.v1:${domain}:${value}`);
}

/**
 * Strips control characters, newlines, and ANSI escape sequences from display strings
 * or safe error tokens before structured logging.
 */
export function sanitizeLogToken(raw: string, maxLen = 120): string {
  // Remove ANSI CSI sequences and ASCII control characters (0x00-0x1F, 0x7F-0x9F)
  const withoutAnsi = raw.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
  let cleaned = '';
  for (let i = 0; i < withoutAnsi.length && cleaned.length < maxLen; i += 1) {
    const code = withoutAnsi.charCodeAt(i);
    if ((code >= 0x20 && code <= 0x7e) || code >= 0xa0) {
      cleaned += withoutAnsi[i];
    } else {
      cleaned += ' ';
    }
  }
  return cleaned.trim();
}

export interface StructuredLogEntry {
  readonly timestamp_iso: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

export class SafeStructuredLogger {
  private readonly buffer: StructuredLogEntry[] = [];
  private readonly maxEntries: number;
  private readonly emitToStdout: boolean;

  constructor(options?: { maxEntries?: number; emitToStdout?: boolean }) {
    this.maxEntries = options?.maxEntries ?? 1000;
    this.emitToStdout = options?.emitToStdout ?? false;
  }

  public record(
    event: string,
    fields: Readonly<Record<string, string | number | boolean | null>>,
  ): StructuredLogEntry {
    const safeFields: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(fields)) {
      const safeKey = sanitizeLogToken(k, 64);
      if (typeof v === 'string') {
        safeFields[safeKey] = sanitizeLogToken(v, 160);
      } else if (typeof v === 'number') {
        safeFields[safeKey] = Number.isFinite(v) ? v : null;
      } else {
        safeFields[safeKey] = v;
      }
    }
    const entry: StructuredLogEntry = Object.freeze({
      timestamp_iso: new Date().toISOString(),
      event: sanitizeLogToken(event, 64),
      fields: Object.freeze(safeFields),
    });
    if (this.buffer.length >= this.maxEntries) {
      this.buffer.shift();
    }
    this.buffer.push(entry);
    if (this.emitToStdout) {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    }
    return entry;
  }

  public snapshot(): readonly StructuredLogEntry[] {
    return [...this.buffer];
  }
}

const SECRET_LIKE_PATTERNS: readonly RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /vervain_cf_sid=/i,
  /__Host-vervain_cf_sid=/i,
];

/**
 * Recursively scans any JSON-serializable structure for prohibited exact substrings
 * (such as raw fixture text, planted values, prompts, responses, cookies, or API keys)
 * and secret-like token patterns. Returns the path of the first violation, or null if clean.
 */
export function findProhibitedContentInObject(
  value: unknown,
  forbiddenSubstrings: readonly string[],
  currentPath = '$',
): { path: string; reason: string } | null {
  const nonEmptyForbidden = forbiddenSubstrings.filter((s) => s.length >= 6);

  const inspectString = (str: string, path: string): { path: string; reason: string } | null => {
    for (const needle of nonEmptyForbidden) {
      if (str.includes(needle)) {
        return { path, reason: 'contains_prohibited_fixture_or_secret_substring' };
      }
    }
    for (const pattern of SECRET_LIKE_PATTERNS) {
      if (pattern.test(str)) {
        return { path, reason: 'matches_secret_or_cookie_pattern' };
      }
    }
    return null;
  };

  const walk = (node: unknown, path: string): { path: string; reason: string } | null => {
    if (typeof node === 'string') {
      return inspectString(node, path);
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const hit = walk(node[i], `${path}[${i}]`);
        if (hit) return hit;
      }
      return null;
    }
    if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const keyHit = inspectString(k, `${path}.${k}(key)`);
        if (keyHit) return keyHit;
        const valHit = walk(v, `${path}.${k}`);
        if (valHit) return valHit;
      }
    }
    return null;
  };

  return walk(value, currentPath);
}
