/**
 * Responsibility: Verifies client bundle and repository source hygiene:
 *   1. Zero Google API keys, GEMINI_API_KEY values, or .env files in dist/client (when built).
 *   2. Zero @google/genai SDK code bundled into dist/client or imported in client/shared modules.
 *   3. Zero references to the private reference checkout path in dist/client or runtime code.
 *   4. Zero tracked .env secret files or hardcoded Google API keys in tracked files.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface HygieneViolation {
  readonly rule: string;
  readonly location: string;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

interface HygieneSummary {
  readonly status: 'pass' | 'fail';
  readonly distClientBuilt: boolean;
  readonly distClientFilesScanned: number;
  readonly sourceFilesScanned: number;
  readonly checks: readonly string[];
  readonly violations: readonly HygieneViolation[];
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// Construct sensitive tokens dynamically so this verifier never contains literal trigger strings.
const GOOGLE_KEY_PREFIX = ['AI', 'za'].join('');
const GOOGLE_KEY_REGEX = new RegExp(`${GOOGLE_KEY_PREFIX}[0-9A-Za-z_-]{20,}`);
const SYNTHETIC_TEST_KEY_MARKER = /(fake|test|mock|synthetic|dummy|sample|example|00000|12345)/i;
const GEMINI_KEY_IDENT = ['GEMINI', 'API', 'KEY'].join('_');
const NON_EMPTY_GEMINI_ENV_REGEX = new RegExp(`^\\s*${GEMINI_KEY_IDENT}\\s*=\\s*\\S+`);
const GENAI_SDK_SPECIFIER = ['@google', 'genai'].join('/');
const GENAI_SDK_CLASS = ['Google', 'GenAI'].join('');
const GENAI_API_HOST = ['generativelanguage', 'googleapis', 'com'].join('.');
const PRIVATE_REF_PATH = ['/Users', 'pjmullin', 'Desktop', 'vervain-carbon-reference'].join('/');
const PRIVATE_REF_SLUG = ['vervain', 'carbon', 'reference'].join('-');

function toPosixRelative(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function walkDirectory(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const results: string[] = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      results.push(...walkDirectory(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results.sort();
}

function listTrackedFiles(): string[] {
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

function isDotEnvSecretFile(fileName: string): boolean {
  if (fileName === '.env.example') {
    return false;
  }
  return fileName === '.env' || fileName.startsWith('.env.');
}

function scanLines(
  absPath: string,
  checkLine: (line: string, lineNumber: number, relPath: string) => void,
): void {
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    return;
  }
  const relPath = toPosixRelative(absPath);
  const raw = fs.readFileSync(absPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    checkLine(line, i + 1, relPath);
  }
}

function main(): void {
  const violations: HygieneViolation[] = [];
  const configuredLiveSecret = (process.env[GEMINI_KEY_IDENT] ?? '').trim();

  const recordViolation = (
    rule: string,
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

  // 1. Inspect dist/client if built
  const distClientDir = path.join(REPO_ROOT, 'dist', 'client');
  const distClientBuilt = fs.existsSync(distClientDir) && fs.statSync(distClientDir).isDirectory();
  const distClientFiles = distClientBuilt ? walkDirectory(distClientDir) : [];

  for (const absFile of distClientFiles) {
    const relPath = toPosixRelative(absFile);
    const baseName = path.basename(absFile);

    if (isDotEnvSecretFile(baseName) || baseName === '.env.example') {
      recordViolation(
        'dist_dotenv_file_present',
        relPath,
        1,
        'Environment file found inside dist/client.',
      );
    }

    scanLines(absFile, (line, lineNumber, rel) => {
      if (GOOGLE_KEY_REGEX.test(line)) {
        recordViolation(
          'dist_google_api_key_pattern',
          rel,
          lineNumber,
          'Google API key pattern detected in client bundle output.',
        );
      }
      if (line.includes(GEMINI_KEY_IDENT)) {
        recordViolation(
          'dist_gemini_key_identifier',
          rel,
          lineNumber,
          `${GEMINI_KEY_IDENT} reference detected in client bundle output.`,
        );
      }
      if (configuredLiveSecret.length >= 8 && line.includes(configuredLiveSecret)) {
        recordViolation(
          'dist_gemini_key_value',
          rel,
          lineNumber,
          'Active environment API key value detected in client bundle output.',
        );
      }
      if (
        line.includes(GENAI_SDK_SPECIFIER) ||
        line.includes(GENAI_SDK_CLASS) ||
        line.includes(GENAI_API_HOST)
      ) {
        recordViolation(
          'dist_google_genai_bundled',
          rel,
          lineNumber,
          'Server-only Google GenAI SDK marker detected in dist/client.',
        );
      }
      if (line.includes(PRIVATE_REF_PATH) || line.includes(PRIVATE_REF_SLUG)) {
        recordViolation(
          'dist_private_reference_path',
          rel,
          lineNumber,
          'Private reference checkout path detected in dist/client.',
        );
      }
    });
  }

  // 2. Inspect tracked files and runtime source files
  const trackedRelFiles = listTrackedFiles();
  for (const rel of trackedRelFiles) {
    const baseName = path.basename(rel);
    if (isDotEnvSecretFile(baseName)) {
      recordViolation(
        'tracked_dotenv_secret_file',
        rel,
        1,
        'Secret .env file must never be tracked by Git.',
      );
    }
  }

  const runtimeAbsFiles = [
    ...walkDirectory(path.join(REPO_ROOT, 'src')),
    ...walkDirectory(path.join(REPO_ROOT, 'scripts')),
    path.join(REPO_ROOT, 'index.html'),
    path.join(REPO_ROOT, 'vite.config.ts'),
    path.join(REPO_ROOT, 'package.json'),
  ].filter((p) => fs.existsSync(p));

  const allSourceSet = new Set<string>([
    ...trackedRelFiles.map((rel) => path.join(REPO_ROOT, rel)),
    ...runtimeAbsFiles,
  ]);
  const runtimeSet = new Set<string>(runtimeAbsFiles);

  let sourceFilesScanned = 0;

  for (const absFile of Array.from(allSourceSet).sort()) {
    if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
      continue;
    }
    const relPath = toPosixRelative(absFile);
    if (relPath.startsWith('dist/') || relPath.startsWith('node_modules/')) {
      continue;
    }
    if (relPath === 'package-lock.json') {
      continue;
    }

    sourceFilesScanned += 1;
    const isClientOrShared =
      relPath.startsWith('src/client/') || relPath.startsWith('src/shared/');
    const isTestFile =
      relPath.startsWith('tests/') ||
      relPath.startsWith('verification/') ||
      relPath.startsWith('packages/evidence-verifier/') ||
      relPath.startsWith('packages/judge-replay/tests/');
    const isRuntimeCode = runtimeSet.has(absFile);
    const baseName = path.basename(relPath);

    scanLines(absFile, (line, lineNumber, rel) => {
      const keyMatch = GOOGLE_KEY_REGEX.exec(line);
      if (keyMatch) {
        const isSyntheticRedactionFixture =
          isTestFile && SYNTHETIC_TEST_KEY_MARKER.test(keyMatch[0]);
        if (!isSyntheticRedactionFixture) {
          recordViolation(
            'source_google_api_key_pattern',
            rel,
            lineNumber,
            'Hardcoded Google API key pattern detected in source file.',
          );
        }
      }
      if (configuredLiveSecret.length >= 8 && line.includes(configuredLiveSecret)) {
        recordViolation(
          'source_gemini_key_value',
          rel,
          lineNumber,
          'Active environment API key value detected in tracked/source file.',
        );
      }
      if (baseName.startsWith('.env') && NON_EMPTY_GEMINI_ENV_REGEX.test(line)) {
        recordViolation(
          'dotenv_nonempty_gemini_key',
          rel,
          lineNumber,
          `${GEMINI_KEY_IDENT} must remain empty in template env files.`,
        );
      }
      if (isClientOrShared) {
        if (line.includes(GENAI_SDK_SPECIFIER) || line.includes(GENAI_SDK_CLASS)) {
          recordViolation(
            'client_source_genai_import',
            rel,
            lineNumber,
            'Client/shared module must not import or reference @google/genai.',
          );
        }
        if (line.includes(GEMINI_KEY_IDENT)) {
          recordViolation(
            'client_source_gemini_key_ident',
            rel,
            lineNumber,
            `Client/shared module must not reference ${GEMINI_KEY_IDENT}.`,
          );
        }
      }
      if (isRuntimeCode && line.includes(PRIVATE_REF_PATH)) {
        recordViolation(
          'runtime_private_reference_path',
          rel,
          lineNumber,
          'Runtime code must not reference the external reference checkout path.',
        );
      }
    });
  }

  const summary: HygieneSummary = {
    status: violations.length === 0 ? 'pass' : 'fail',
    distClientBuilt,
    distClientFilesScanned: distClientFiles.length,
    sourceFilesScanned,
    checks: [
      'zero_google_api_keys_and_dotenv_in_dist_client',
      'zero_google_genai_sdk_in_dist_client_and_browser_sources',
      'zero_private_reference_paths_in_dist_client_and_runtime_code',
      'zero_tracked_dotenv_secrets_in_repository',
    ],
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
