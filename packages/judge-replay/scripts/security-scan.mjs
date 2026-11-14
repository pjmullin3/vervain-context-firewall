import { readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(pkgRoot, "../..");

const ALLOWED_OWNED_PREFIXES = [
  "packages/judge-replay/",
  "fixtures/judge-replay/",
  "docs/judge-replay/",
  "CARBON4_HANDOFF.md",
  "HANDOFF.json"
];

const SECRET_PATTERNS = [
  { name: "PEM private key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", regex: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "API key sk-*", regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "JWT token", regex: /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/ }
];

const BANNED_OVERCLAIM_PATTERNS = [
  { name: "proves", regex: /\bproves\b/i },
  { name: "guarantees", regex: /\bguarantees\b/i },
  { name: "secure", regex: /\bsecure\b/i },
  { name: "compliant", regex: /\bcompliant\b/i },
  { name: "certified", regex: /\bcertified\b/i },
  { name: "production ready", regex: /\bproduction[- ]ready\b/i },
  { name: "zero overhead", regex: /\bzero[- ]overhead\b/i },
  { name: "all engines", regex: /\ball engines\b/i }
];

const FORBIDDEN_ASSET_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf"
]);

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
  ".git"
]);

const failures = [];

function walkFiles(dirPath, out = []) {
  for (const entry of readdirSync(dirPath)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = resolve(dirPath, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, out);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// 1. Check npm audit
try {
  execFileSync("npm", ["audit", "--audit-level=low"], {
    cwd: pkgRoot,
    stdio: "pipe"
  });
} catch (err) {
  failures.push(`npm audit failed: ${String(err)}`);
}

// 2. Check owned path boundaries in git status
const gitPorcelain = execFileSync("git", ["status", "--porcelain", "-uall"], {
  cwd: repoRoot,
  encoding: "utf8"
});

for (const rawLine of gitPorcelain.split("\n")) {
  if (!rawLine.trim()) continue;
  const filePath = rawLine.slice(3).trim().replace(/^"(.*)"$/, "$1");
  const allowed = ALLOWED_OWNED_PREFIXES.some(
    (prefix) => filePath === prefix || filePath.startsWith(prefix)
  );
  if (!allowed) {
    failures.push(`Modified or untracked file outside owned boundary: ${filePath}`);
  }
}

// 3. Scan owned files
const scanRoots = [
  resolve(repoRoot, "packages/judge-replay"),
  resolve(repoRoot, "fixtures/judge-replay"),
  resolve(repoRoot, "docs/judge-replay")
];
for (const optionalRootFile of ["CARBON4_HANDOFF.md", "HANDOFF.json"]) {
  const candidate = resolve(repoRoot, optionalRootFile);
  try {
    if (statSync(candidate).isFile()) {
      scanRoots.push(candidate);
    }
  } catch {
    // Not created yet during intermediate steps
  }
}

const allFiles = [];
for (const root of scanRoots) {
  const st = statSync(root);
  if (st.isDirectory()) {
    walkFiles(root, allFiles);
  } else {
    allFiles.push(root);
  }
}

for (const filePath of allFiles) {
  const rel = relative(repoRoot, filePath);
  const ext = extname(filePath).toLowerCase();

  if (FORBIDDEN_ASSET_EXTS.has(ext)) {
    failures.push(`Forbidden binary/private asset file detected: ${rel}`);
    continue;
  }

  if (rel.endsWith("package-lock.json")) continue;

  const content = readFileSync(filePath, "utf8");

  for (const rule of SECRET_PATTERNS) {
    if (rule.regex.test(content)) {
      failures.push(`Secret scan matched '${rule.name}' in ${rel}`);
    }
  }

  // Em-dash check across product code, fixtures, docs, and handoff
  if (
    !rel.endsWith("scripts/security-scan.mjs") &&
    !rel.includes("/tests/") &&
    content.includes("\u2014")
  ) {
    failures.push(`Em dash (\\u2014) found in ${rel}; use ASCII punctuation instead.`);
  }

  // Overclaim scan in src/, demo/, and fixtures/
  if (
    (rel.startsWith("packages/judge-replay/src/") ||
      rel.startsWith("packages/judge-replay/demo/") ||
      rel.startsWith("fixtures/judge-replay/")) &&
    !rel.endsWith("src/copyContract.ts")
  ) {
    for (const claim of BANNED_OVERCLAIM_PATTERNS) {
      if (claim.regex.test(content)) {
        failures.push(`Banned unbounded claim word '${claim.name}' found in ${rel}`);
      }
    }
  }

  // No network calls inside package src/
  if (rel.startsWith("packages/judge-replay/src/")) {
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(content)) {
      failures.push(`Disallowed network API call found in ${rel}`);
    }
  }

  // Fixture pre-GPU honesty rules
  if (rel.startsWith("fixtures/judge-replay/") && ext === ".json") {
    if (!content.includes("NO GPU RUN RECORDED")) {
      failures.push(`Fixture ${rel} must explicitly include 'NO GPU RUN RECORDED'`);
    }
    try {
      const parsed = JSON.parse(content);
      if (parsed.source_status === "live" || parsed.source_status === "recorded") {
        failures.push(
          `Fixture ${rel} cannot claim '${parsed.source_status}' before an H200 artifact exists`
        );
      }
      if (parsed.gpu_run_recorded !== false) {
        failures.push(`Fixture ${rel} must set gpu_run_recorded: false`);
      }
    } catch (err) {
      failures.push(`Fixture ${rel} is not valid JSON: ${String(err)}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Security and integrity scan FAILED:");
  for (const item of failures) {
    console.error(`  - ${item}`);
  }
  process.exit(1);
}

console.log(
  `Security & integrity scan PASSED (${allFiles.length} owned files checked, 0 vulnerabilities, 0 secrets, 0 banned claims).`
);
