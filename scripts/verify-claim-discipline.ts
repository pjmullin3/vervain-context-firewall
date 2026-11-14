/**
 * Responsibility: Enforces copy and claim discipline across client/shared modules,
 * documentation, one-pagers, demo/video scripts, and verification scripts:
 *   1. Zero prohibited overclaim words or phrases (case-insensitive word-boundary checks).
 *   2. Zero em dash characters (U+2014).
 *   3. Presence of SCOPED_ATTENTION_LIMITATION_LABEL in src/shared/config.ts and
 *      SCOPED_ATTENTION_NOTE.md (when present).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPED_ATTENTION_LIMITATION_LABEL } from '../src/shared/config.js';

interface ClaimViolation {
  readonly rule: 'prohibited_overclaim' | 'em_dash_character' | 'missing_scoped_limitation_label';
  readonly location: string;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

interface ClaimSummary {
  readonly status: 'pass' | 'fail';
  readonly filesScanned: number;
  readonly scannedPaths: readonly string[];
  readonly scopedLimitationVerifiedInConfig: boolean;
  readonly scopedNotePresent: boolean;
  readonly scopedLimitationVerifiedInNote: boolean | null;
  readonly violationLocations: readonly string[];
  readonly violations: readonly ClaimViolation[];
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// Construct prohibited terms via concatenation so this script never contains literal banned words.
const PROHIBITED_PATTERNS: ReadonlyArray<{ readonly term: string; readonly regex: RegExp }> = (
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
).map(([partA, partB]) => {
  const term = `${partA}${partB}`;
  const patternBody = term
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return {
    term,
    regex: new RegExp(`\\b${patternBody}\\b`, 'i'),
  };
});

const EM_DASH = String.fromCharCode(0x2014);
const SCOPED_LABEL_SYMBOL = 'SCOPED_ATTENTION_LIMITATION_LABEL';

const ROOT_DOC_TARGETS: readonly string[] = [
  'README.md',
  'DESIGN.md',
  'SECURITY.md',
  'SECURITY_LEDGER.md',
  'DAYBREAK_SECURITY_REPORT.md',
  'EXECUTIVE_ENTERPRISE_BRIEF.md',
  'THREAT_MODEL.md',
  'CLAIMS.md',
  'ORIGIN_MAP.md',
  'BUILD_PROOF.md',
  'DEMO_SCRIPT.md',
  'SCOPED_ATTENTION_NOTE.md',
  'ONE_PAGER_TEAM.txt',
  'ONE_PAGER_IDEA.txt',
  'VIDEO_SCRIPT_2_MIN.md',
  'VIDEO_SCRIPT_1_MIN.md',
];

function toPosixRelative(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function walkDirectory(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const collected: string[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collected.push(...walkDirectory(full));
    } else if (entry.isFile()) {
      collected.push(full);
    }
  }
  return collected.sort();
}

function main(): void {
  const violations: ClaimViolation[] = [];

  const recordViolation = (
    rule: ClaimViolation['rule'],
    relPath: string,
    line: number,
    detail: string,
  ): void => {
    violations.push({
      rule,
      location: `${relPath}:${line}`,
      file: relPath,
      line,
      detail,
    });
  };

  const candidateFiles = new Set<string>([
    ...walkDirectory(path.join(REPO_ROOT, 'src', 'client')),
    ...walkDirectory(path.join(REPO_ROOT, 'src', 'shared')),
    ...walkDirectory(path.join(REPO_ROOT, 'scripts')),
  ]);

  for (const docName of ROOT_DOC_TARGETS) {
    const absDoc = path.join(REPO_ROOT, docName);
    if (fs.existsSync(absDoc) && fs.statSync(absDoc).isFile()) {
      candidateFiles.add(absDoc);
    }
  }

  const sortedFiles = Array.from(candidateFiles).sort();
  const scannedPaths: string[] = [];

  for (const absFile of sortedFiles) {
    const relPath = toPosixRelative(absFile);
    scannedPaths.push(relPath);
    const content = fs.readFileSync(absFile, 'utf8');
    const lines = content.split(/\r?\n/);

    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? '';
      const lineNo = idx + 1;

      if (line.includes(EM_DASH)) {
        recordViolation(
          'em_dash_character',
          relPath,
          lineNo,
          'Em dash (U+2014) is prohibited; use standard ASCII punctuation.',
        );
      }

      for (const item of PROHIBITED_PATTERNS) {
        const match = item.regex.exec(line);
        if (match) {
          recordViolation(
            'prohibited_overclaim',
            relPath,
            lineNo,
            `Prohibited claim term matched ("${match[0]}").`,
          );
        }
      }
    }
  }

  // Verify SCOPED_ATTENTION_LIMITATION_LABEL in src/shared/config.ts
  const sharedConfigRel = 'src/shared/config.ts';
  const sharedConfigAbs = path.join(REPO_ROOT, 'src', 'shared', 'config.ts');
  let scopedLimitationVerifiedInConfig = false;

  if (!fs.existsSync(sharedConfigAbs)) {
    recordViolation(
      'missing_scoped_limitation_label',
      sharedConfigRel,
      1,
      'Required file src/shared/config.ts is missing.',
    );
  } else {
    const configSource = fs.readFileSync(sharedConfigAbs, 'utf8');
    if (
      configSource.includes(SCOPED_LABEL_SYMBOL) &&
      typeof SCOPED_ATTENTION_LIMITATION_LABEL === 'string' &&
      SCOPED_ATTENTION_LIMITATION_LABEL.trim().length > 0
    ) {
      scopedLimitationVerifiedInConfig = true;
    } else {
      recordViolation(
        'missing_scoped_limitation_label',
        sharedConfigRel,
        1,
        `${SCOPED_LABEL_SYMBOL} must be exported as a non-empty constant in src/shared/config.ts.`,
      );
    }
  }

  // Verify SCOPED_ATTENTION_LIMITATION_LABEL in SCOPED_ATTENTION_NOTE.md when present
  const scopedNoteRel = 'SCOPED_ATTENTION_NOTE.md';
  const scopedNoteAbs = path.join(REPO_ROOT, scopedNoteRel);
  const scopedNotePresent = fs.existsSync(scopedNoteAbs) && fs.statSync(scopedNoteAbs).isFile();
  let scopedLimitationVerifiedInNote: boolean | null = null;

  if (scopedNotePresent) {
    const noteContent = fs.readFileSync(scopedNoteAbs, 'utf8');
    if (
      noteContent.includes(SCOPED_LABEL_SYMBOL) ||
      noteContent.includes(SCOPED_ATTENTION_LIMITATION_LABEL)
    ) {
      scopedLimitationVerifiedInNote = true;
    } else {
      scopedLimitationVerifiedInNote = false;
      recordViolation(
        'missing_scoped_limitation_label',
        scopedNoteRel,
        1,
        `SCOPED_ATTENTION_NOTE.md must include ${SCOPED_LABEL_SYMBOL} or its exact notice text.`,
      );
    }
  }

  const summary: ClaimSummary = {
    status: violations.length === 0 ? 'pass' : 'fail',
    filesScanned: scannedPaths.length,
    scannedPaths,
    scopedLimitationVerifiedInConfig,
    scopedNotePresent,
    scopedLimitationVerifiedInNote,
    violationLocations: violations.map((v) => v.location),
    violations,
  };

  if (violations.length > 0) {
    process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exit(1);
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

main();
