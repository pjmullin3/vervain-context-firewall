/**
 * Responsibility: Independent TypeScript/Node RFC 8259 strict JSON parser and RFC 8785 (JCS)
 * canonicalizer + SHA-256 digest computation.
 * Trust boundary: Rejects duplicate keys, prototype keys, NaN/Infinity, -0.0, integer overflow,
 * lone surrogates, NUL bytes, BOM, and excessive nesting before trusting parsed objects.
 */

import { createHash } from 'node:crypto';

export const MAX_SAFE_INT = 9007199254740991;
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class StrictJsonError extends Error {
  readonly reasonCode: string;
  readonly jsonPath: string;

  constructor(reasonCode: string, message: string, jsonPath: string = '$') {
    super(message);
    this.name = 'StrictJsonError';
    this.reasonCode = reasonCode;
    this.jsonPath = jsonPath;
  }
}

export function parseStrictJson(raw: string, maxDepth = 64): unknown {
  if (raw.startsWith('\ufeff')) {
    throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'UTF-8 BOM is not permitted.');
  }
  if (raw.includes('\u0000')) {
    throw new StrictJsonError('FAIL_CANON_UNICODE_OR_NUL', 'Raw NUL byte is not permitted.');
  }

  const len = raw.length;
  let idx = 0;

  const skipWs = (): void => {
    while (idx < len) {
      const c = raw.charCodeAt(idx);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) idx += 1;
      else break;
    }
  };

  const readString = (path: string): string => {
    const start = idx;
    idx += 1;
    while (idx < len) {
      const c = raw.charCodeAt(idx);
      if (c === 0x22) {
        idx += 1;
        const slice = raw.slice(start, idx);
        // Validate lone surrogates & \u0000
        const decoded = JSON.parse(slice) as string;
        if (decoded.includes('\u0000')) {
          throw new StrictJsonError('FAIL_CANON_UNICODE_OR_NUL', 'NUL escape is forbidden.', path);
        }
        for (let i = 0; i < decoded.length; i += 1) {
          const code = decoded.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = decoded.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) {
              throw new StrictJsonError('FAIL_CANON_UNICODE_OR_NUL', 'Lone high surrogate.', path);
            }
            i += 1;
          } else if (code >= 0xdc00 && code <= 0xdfff) {
            throw new StrictJsonError('FAIL_CANON_UNICODE_OR_NUL', 'Lone low surrogate.', path);
          }
        }
        return decoded;
      }
      if (c < 0x20) {
        throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Unescaped control character in string.', path);
      }
      if (c === 0x5c) {
        idx += 2;
        continue;
      }
      idx += 1;
    }
    throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Unterminated JSON string.', path);
  };

  const readNumber = (path: string): number => {
    const start = idx;
    if (raw[idx] === '-') idx += 1;
    if (idx >= len) throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Invalid number.', path);
    if (raw[idx] === '0') {
      idx += 1;
      if (idx < len && /\d/.test(raw[idx] ?? '')) {
        throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Leading zero in number.', path);
      }
    } else if (/\d/.test(raw[idx] ?? '')) {
      while (idx < len && /\d/.test(raw[idx] ?? '')) idx += 1;
    } else {
      throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Invalid number syntax.', path);
    }

    let isFloat = false;
    if (raw[idx] === '.') {
      isFloat = true;
      idx += 1;
      if (idx >= len || !/\d/.test(raw[idx] ?? '')) {
        throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Missing fractional digits.', path);
      }
      while (idx < len && /\d/.test(raw[idx] ?? '')) idx += 1;
    }
    if (raw[idx] === 'e' || raw[idx] === 'E') {
      isFloat = true;
      idx += 1;
      if (raw[idx] === '+' || raw[idx] === '-') idx += 1;
      if (idx >= len || !/\d/.test(raw[idx] ?? '')) {
        throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Missing exponent digits.', path);
      }
      while (idx < len && /\d/.test(raw[idx] ?? '')) idx += 1;
    }

    const lexeme = raw.slice(start, idx);
    if (lexeme === '-0') {
      throw new StrictJsonError('FAIL_CANON_NEGATIVE_ZERO', 'Negative zero (-0) is forbidden.', path);
    }
    const num = Number(lexeme);
    if (!Number.isFinite(num)) {
      throw new StrictJsonError('FAIL_CANON_NONFINITE_NUMBER', 'Overflowed non-finite float.', path);
    }
    if (Object.is(num, -0)) {
      throw new StrictJsonError('FAIL_CANON_NEGATIVE_ZERO', 'Negative zero (-0.0) is forbidden.', path);
    }
    if (!isFloat && !Number.isSafeInteger(num)) {
      throw new StrictJsonError('FAIL_CANON_INT_OVERFLOW', 'Integer exceeds 53-bit safe bounds.', path);
    }
    return num;
  };

  const readValue = (depth: number, path: string): unknown => {
    if (depth > maxDepth) {
      throw new StrictJsonError('FAIL_PARSE_SYNTAX', `Nesting depth exceeds ${maxDepth}.`, path);
    }
    skipWs();
    if (idx >= len) throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Unexpected end of input.', path);
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
          throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Expected quoted object key.', path);
        }
        const key = readString(path);
        const keyPath = `${path}.${key}`;
        if (PROTOTYPE_KEYS.has(key)) {
          throw new StrictJsonError('FAIL_CANON_PROTOTYPE_KEY', `Forbidden prototype key: ${key}`, keyPath);
        }
        if (seen.has(key)) {
          throw new StrictJsonError('FAIL_CANON_DUPLICATE_KEY', 'Duplicate object key detected.', keyPath);
        }
        seen.add(key);
        skipWs();
        if (raw[idx] !== ':') {
          throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Expected colon.', keyPath);
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
        throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Expected comma or closing brace.', path);
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
        arr.push(readValue(depth + 1, `${path}[${elem}]`));
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
        throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Expected comma or closing bracket.', path);
      }
    }
    if (ch === '"') return readString(path);
    if (ch === '-' || /\d/.test(ch ?? '')) return readNumber(path);
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
    if (raw.startsWith('NaN', idx) || raw.startsWith('Infinity', idx) || raw.startsWith('-Infinity', idx)) {
      throw new StrictJsonError('FAIL_CANON_NONFINITE_NUMBER', 'Non-finite literal is forbidden.', path);
    }
    throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Unexpected JSON token.', path);
  };

  const parsed = readValue(1, '$');
  skipWs();
  if (idx !== len) {
    throw new StrictJsonError('FAIL_PARSE_SYNTAX', 'Trailing tokens after JSON root value.', '$');
  }
  return parsed;
}

export function canonicalizeJcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new StrictJsonError('FAIL_CANON_NONFINITE_NUMBER', 'Non-finite float in canonicalization.');
    }
    if (Object.is(value, -0)) {
      throw new StrictJsonError('FAIL_CANON_NEGATIVE_ZERO', 'Negative zero in canonicalization.');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJcs(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort(); // JS default sort orders by UTF-16 code unit per RFC 8785!
    const parts: string[] = [];
    for (const k of keys) {
      if (PROTOTYPE_KEYS.has(k)) {
        throw new StrictJsonError('FAIL_CANON_PROTOTYPE_KEY', `Forbidden prototype key: ${k}`);
      }
      parts.push(`${JSON.stringify(k)}:${canonicalizeJcs(rec[k])}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new StrictJsonError('FAIL_PARSE_SYNTAX', `Unsupported value type: ${typeof value}`);
}

export function computeArtifactSha256(artifact: Record<string, unknown>): string {
  const clone = Object.create(null) as Record<string, unknown>;
  for (const k of Object.keys(artifact)) {
    if (k === 'artifact_sha256' || k === 'signature') continue;
    clone[k] = artifact[k];
  }
  const canon = canonicalizeJcs(clone);
  return createHash('sha256').update(canon, 'utf8').digest('hex');
}
