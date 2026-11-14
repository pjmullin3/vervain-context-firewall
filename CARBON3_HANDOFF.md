# CARBON 3 HANDOFF — Independent Vervain Inference-Security Evidence Verifier

- **Worktree:** `/Users/pjmullin/Desktop/vervain-carbon-evidence-lane`
- **Branch:** `carbon/evidence` (unmerged; do not merge directly without integration review)
- **Implementation Commit SHA:** `1f40eb05a8a47bf0ab619cc541bfa48b1a0f7622` (196 files)
- **Handoff Files:** `CARBON3_HANDOFF.md`, `HANDOFF.json` (committed immediately after implementation commit)
- **GPU Hold Status:** Respected 100%. No remote GPU, pod, cluster, or network call was executed during overnight verification. External H200 allocations for separate challenges remain completely untouched; bounded H200 / 8xH200 (`verify_h200_run.sh`) runs wait for PJ's explicit `GPU GO` at/after the 10:30 AM PT directed window.

## 1. File Inventory (Owned Paths Only)

All 196 implementation files (plus 2 handoff files) sit strictly within the owned directories (`schemas/verification/`, `packages/evidence-verifier/`, `verification/`, `docs/verification/`, `CARBON3_HANDOFF.md`, `HANDOFF.json`):

### JSON Schemas (Draft 2020-12) — `schemas/verification/`
- `schemas/verification/inference-proof.v1.schema.json`
- `schemas/verification/verifier-result.v1.schema.json`
- `schemas/verification/command-receipt.v1.schema.json`
- `schemas/verification/run-manifest.v1.schema.json`
- `schemas/verification/trust-root.v1.schema.json`

### Python Verifier Package — `packages/evidence-verifier/`
- `packages/evidence-verifier/pyproject.toml`
- `packages/evidence-verifier/README.md`
- `packages/evidence-verifier/src/evidence_verifier/__init__.py`
- `packages/evidence-verifier/src/evidence_verifier/__main__.py`
- `packages/evidence-verifier/src/evidence_verifier/cli.py`
- `packages/evidence-verifier/src/evidence_verifier/strict_json.py`
- `packages/evidence-verifier/src/evidence_verifier/schema_validator.py`
- `packages/evidence-verifier/src/evidence_verifier/crypto.py`
- `packages/evidence-verifier/src/evidence_verifier/sanitizer.py`
- `packages/evidence-verifier/src/evidence_verifier/invariants.py`
- `packages/evidence-verifier/src/evidence_verifier/renderer.py`
- `packages/evidence-verifier/src/evidence_verifier/run_dir.py`
- `packages/evidence-verifier/src/evidence_verifier/mutator.py`
- `packages/evidence-verifier/src/evidence_verifier/reason_codes.py`

### Python Test Suite — `packages/evidence-verifier/tests/` (40 tests)
- `packages/evidence-verifier/tests/test_strict_json_and_canonical.py`
- `packages/evidence-verifier/tests/test_crypto_and_trust_root.py`
- `packages/evidence-verifier/tests/test_invariants_and_corpus.py`
- `packages/evidence-verifier/tests/test_sanitizer.py`
- `packages/evidence-verifier/tests/test_run_dir_and_wrapper.py`
- `packages/evidence-verifier/tests/test_cli_and_ts.py`

### Zero-Dependency TypeScript Companion — `packages/evidence-verifier/ts/`
- `packages/evidence-verifier/ts/package.json`
- `packages/evidence-verifier/ts/tsconfig.json`
- `packages/evidence-verifier/ts/types/node/index.d.ts`
- `packages/evidence-verifier/ts/src/index.ts`
- `packages/evidence-verifier/ts/src/strict-json.ts`
- `packages/evidence-verifier/ts/src/sanitizer.ts`
- `packages/evidence-verifier/ts/src/verifier.ts`

### Verification Tooling & Adversarial Fixtures — `verification/`
- `verification/run_local_gates.py` — offline CI gate runner (format/AST annotations, compile, pyflakes, `tsc`, `pytest`, secret scan, offline dependency check)
- `verification/run_wrapped.py` — bounded command receipt wrapper recording git SHA/dirty state, sanitized argv/env, stdout/stderr SHA-256, exit code, and `receipt_sha256`
- `verification/verify_h200_run.sh` — read-only bounded `RUN_DIR` verifier launcher for PJ / Daybreak post-`GPU GO`
- `verification/generate_fixtures.py` — deterministic fixture corpus generator
- `verification/fixtures/` — 157 committed files (`corpus_expectations.json`, `ephemeral_test_trust_root.json`, `valid_h200_tp1.json`, `valid_h200_tp8.json`, `local_only.json`, `incomplete.json`, 31 adversarial mutation JSONs in `adversarial/`, and 7 `RUN_DIR` trees in `run_dirs/`).

### Documentation — `docs/verification/`
- `docs/verification/THREAT_MODEL.md`
- `docs/verification/REASON_CODES.md`
- `docs/verification/INTEGRATION.md`
- `docs/verification/H200_VERIFICATION_RUNBOOK.md`

## 2. Supported Schema Versions

| Schema File | Supported `schema_version` | Purpose |
| :--- | :--- | :--- |
| `inference-proof.v1.schema.json` | `inference-proof.v1` | Primary signed/hashed proof artifact |
| `verifier-result.v1.schema.json` | `verifier-result.v1` | Machine-readable output (`verification.json`) |
| `run-manifest.v1.schema.json` | `run-manifest.v1` | `RUN_DIR` manifest binding `disk_manifest` |
| `command-receipt.v1.schema.json` | `command-receipt.v1` | Bounded execution provenance receipt |
| `trust-root.v1.schema.json` | `trust-root.v1` | Explicit Ed25519 trust-root keyset |

## 3. Verdict & Reason-Code Summary

Exit codes and precedence: `ERROR (3) > FAIL (1) > NO VERDICT (2) > PASS (0)`.
Catalog total: **73 reason codes** (full table in `docs/verification/REASON_CODES.md` and `evidence_verifier.reason_codes`).

| Verdict | Exit Code | Code Prefix | Count | Semantics |
| :--- | :--- | :--- | :--- | :--- |
| `PASS` | `0` | `PASS_*` | `2` | Supplied artifact (`live`/`recorded`) satisfies all named verifier invariants. |
| `FAIL` | `1` | `FAIL_*` | `57` | Contradiction, broken invariant, tampering, or unsafe content/secret leak found. |
| `NO VERDICT` | `2` | `NV_*` | `10` | `local_only`, `incomplete`, missing trust root/signature, or missing join files. |
| `ERROR` | `3` | `VERIFIER_ERROR_*` | `4` | Invalid CLI args, unreadable path, invalid trust root, or internal error. |

## 4. Adversarial Fixture & Mutation Counts

- **Committed JSON artifacts:** `35` total (`2` valid H200 TP1/TP8 baselines, `1` `local_only`, `1` `incomplete`, `31` single/structural adversarial mutations matching expected verdicts and reason codes).
- **Committed `RUN_DIR` corpora:** `7` total (`valid_h200_tp8_run` -> `PASS`, `missing_spans_incomplete_run` -> `NO VERDICT`, plus `tampered_patch_run`, `shadow_file_run`, `rank_disagreement_tp8_run`, `receipt_digest_mismatch_run`, `leaked_secret_log_run` -> `FAIL`).
- **Live mutation engine (`evidence-verifier mutate ARTIFACT --campaign all`):** `31` deterministic mutations covering parser differentials, digest/signature/replay tampering, timestamps, status laundering, UI contradictions, H200 manifest, patch SHA mismatch, runtime backend divergence, block ABA generations, cross-tenant / inferred `PUBLIC` scope, pre-dispatch failure, clean contamination, seed/config equivalence, TP8 rank missing/disagreement, unsupported path omission, performance denominator/`p95` sample bounds, negative/non-finite metrics, and planted secret/content leaks.

## 5. Verification Gates & Command Results

Run offline (no GPU, no network, `PYTHONDONTWRITEBYTECODE=1`):

1. `PYTHONDONTWRITEBYTECODE=1 python3 verification/run_local_gates.py`
   - `format_and_annotations`: **PASS**
   - `compileall`: **PASS**
   - `pyflakes`: **PASS**
   - `ts_typecheck_and_build` (`tsc -p packages/evidence-verifier/ts/tsconfig.json`): **PASS**
   - `pytest`: **PASS** (`40 passed` across 6 test modules, 0 skipped, 0 failed)
   - `secret_scan`: **PASS** (`0` hits outside allowlisted intentional test fixtures)
   - `dependency_and_offline_scan`: **PASS** (zero unapproved deps, zero network calls)
2. `bash verification/verify_h200_run.sh verification/fixtures/run_dirs/valid_h200_tp8_run --trust-root verification/fixtures/ephemeral_test_trust_root.json --require-signature --out-dir /tmp/h200_smoke_out`
   - Exit `0`: `PASS recorded PASS_VERIFIED` (`gpu_count=8`, `gpu_model="NVIDIA H200"`, `tp_size_verified=8`, `ranks_verified=[0,1,2,3,4,5,6,7]`, `selected_runtime_backend="FLASH_ATTN"`).
3. `python3 -m evidence_verifier explain FAIL_VIOLATION_ENTERED_DISPATCH` / `NV_STATUS_LOCAL_ONLY`
   - Valid JSON metadata printed deterministically to stdout.

## 6. Integration Summary

- **Carbon 1 (Lead App):** Compile `packages/evidence-verifier/ts/tsconfig.json` and call `runPythonVerifierCli` (`verify` / `verify-run`) alongside `verifyArtifactDigestAndSummaryLocal`; render badge strictly from `verifier-result.v1` (`verdict`, `verified_evidence_status`, `primary_reason_code`, `claim_boundary`).
- **Carbon 2 (vLLM Inference Lane):** Wrap every build/launch/eval command with `verification/run_wrapped.py` and emit `artifact.json`, signed `artifact.sig` (against real run trust root), `manifest.json`, `sources/`, `logs/events.jsonl`, `logs/dispatch_spans.jsonl`, `ranks/rank_*.json`, and `receipts/commands/*.json`.
- **Daybreak / PJ Post-GPU GO:** Invoke `bash verification/verify_h200_run.sh <RUN_DIR> --trust-root <REAL_TRUST_ROOT> --require-signature --seen-run-ids <LEDGER> --forbidden-strings-file <PLANTED_VALUES_FILE>`.

## 7. Exact Limitations & Claim Boundaries

1. **No live cluster/GPU execution occurred in Carbon 3 overnight.** Committed PASS fixtures represent deterministic synthetic `recorded` test structures using an ephemeral test trust root (`verification/fixtures/ephemeral_test_trust_root.json`); do NOT use that test trust root for production/judge H200 acceptance.
2. **Scoped claim only:** `PASS` indicates only that the supplied artifact (and `RUN_DIR`, if applicable) meets this verifier's named invariants under the stated exclusions (eager mode, disabled KV connectors/offload/swap/speculation). It does not establish universal security, production readiness, compliance, certification, or protection outside instrumented paths.
3. **Environment tooling:** `ruff` and `mypy` are not installed in the host Python environment; offline checks enforce AST syntax compilation, `pyflakes` static lint, public function annotation presence verification, and strict `tsc` typechecking.
4. **Python bytecode hygiene:** `.gitignore` in the base worktree is unowned by Carbon 3 and omits `__pycache__`/`.pytest_cache`; run Python gates with `PYTHONDONTWRITEBYTECODE=1` to keep `git status` clean.
