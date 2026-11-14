# vervain-evidence-verifier

Independent, deterministic verification package for Vervain KV-cache inference-security evidence (`inference-proof.v1`, `run-manifest.v1`, `command-receipt.v1`, `trust-root.v1`, and `verifier-result.v1`).

## Scope & Claim Discipline

- **`PASS`** (`exit 0`): The supplied artifact (and run directory, when `verify-run` is used) satisfies all named invariants in this verifier for the pinned configuration, and claimed status is `live` or `recorded`.
- **`FAIL`** (`exit 1`): At least one contradiction, tampering indicator, missing/broken security invariant, unsafe protected content leak, or parser-differential hazard was detected.
- **`NO VERDICT`** (`exit 2`): Required verification evidence, trust root, or GPU hardware/runtime binding is absent, unsupported, `local_only`, or `incomplete`.
- **`ERROR`** (`exit 3`): Invalid CLI invocation, missing path input, malformed trust root, or verifier internal failure.

`PASS` never means universal security, production readiness, compliance, certification, zero overhead, or absence of all vulnerabilities outside the instrumented pre-dispatch boundary.

## Components

- `evidence_verifier.strict_json`: Strict RFC 8259 UTF-8 parser rejecting duplicate keys, escaped duplicate keys (`\u0073tatus`), `__proto__`/`constructor`/`prototype`, `NaN`/`Infinity`/`-Infinity`, `-0`/`-0.0`, integers outside `[-(2^53-1), 2^53-1]`, lone surrogates, NUL bytes, BOMs, and excessive depth; paired with independent RFC 8785 (JCS) canonicalizer and SHA-256 digest computation.
- `evidence_verifier.schema_validator`: JSON Schema Draft 2020-12 validator with strict `int` vs `bool`/`float` enforcement.
- `evidence_verifier.crypto`: Ed25519 trust-root verification (`keys`, revocation, key-type enforcement, domain-separated canonical signing payload) and anti-replay `run_id` ledger check.
- `evidence_verifier.sanitizer`: Zero-echo content and secret scanner for forbidden keys, API tokens, private keys, PII/IPv4/email leaks, high-entropy strings, and raw/case-folded/hex/base64/base64url planted values.
- `evidence_verifier.invariants`: Cross-field join engine checking H200 / 8xH200 TP1/TP2/TP8 GPU & rank binding, monotonic block allocation generations (catching ABA reuse), `request_scope`/`block_scope`/`policy_epoch` decision joins, pre-dispatch blocking on foreign blocks, clean baseline equivalence and post-violation completion, paired performance denominators (`sample_count >= 20` for p95), and exclusions/UI consistency.
- `evidence_verifier.run_dir`: `RUN_DIR` provenance verifier checking file hygiene (no symlinks escaping or shadow duplicates), independent source/patch hashing, command receipt verification, `events.jsonl` / `dispatch_spans.jsonl` request-id matching, rank agreement, and safe output rendering.
- `evidence_verifier.mutator`: Programmatic adversarial corpus generator covering 31+ single-field and structural security mutations.
- `packages/evidence-verifier/ts/`: Zero-dependency TypeScript/Node companion implementing strict JSON parsing, JCS canonicalization, SHA-256 verification, zero-echo sanitization, UI cross-checks, and a typed bridge to the Python CLI (`verify` / `verify-run`).

## CLI Usage

```bash
PYTHONPATH=packages/evidence-verifier/src python3 -m evidence_verifier verify ARTIFACT.json --trust-root TRUST_ROOT.json --require-signature
PYTHONPATH=packages/evidence-verifier/src python3 -m evidence_verifier verify-run RUN_DIR --trust-root TRUST_ROOT.json --require-signature
PYTHONPATH=packages/evidence-verifier/src python3 -m evidence_verifier mutate BASELINE.json --campaign all
PYTHONPATH=packages/evidence-verifier/src python3 -m evidence_verifier sanitize ARTIFACT.json
PYTHONPATH=packages/evidence-verifier/src python3 -m evidence_verifier explain FAIL_BACKEND_MISMATCH
```
