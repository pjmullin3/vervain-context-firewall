# Vervain Inference-Security Evidence Threat Model

## 1. Mission & Claim Under Verification

Vervain claims:

> In a controlled fault-injection run on the named H200 configuration, Vervain stopped a foreign-scope physical KV block before the recorded vLLM attention backend dispatch, while the paired clean request completed unchanged.

This document defines the adversary model for **verification of evidence artifacts** (`inference-proof.v1`), **run directories** (`RUN_DIR`), and **verifier outputs** (`verifier-result.v1`). The verifier assumes the evidence producer (or an intermediary transport / UI layer) can be buggy, misconfigured, incomplete, stale, or actively adversarial.

## 2. Trust Boundaries & Untrusted Inputs

| Artifact / Surface | Trust Posture | Verification Rule |
| :--- | :--- | :--- |
| Producer `proof.json` / UI JSON | Untrusted | Strict RFC 8259 parsing, Draft 2020-12 schema check, independent RFC 8785 JCS SHA-256, cross-field relational joins. |
| Producer `ui_summary` block | Untrusted | Never overrides raw evidence; cross-checked field-by-field against raw-derived values (`FAIL_UI_SUMMARY_CONTRADICTION`). |
| Filenames (`h200.json`, `tp8_live.json`) | Untrusted | Never used to infer GPU model, TP rank count, or `evidence_status`. |
| Screenshots / console snippets | Not admissible | Rejected as provenance; independent on-disk files, manifests, receipts, and JSONL logs are required for `verify-run`. |
| Trust root bundle (`trust-root.v1`) | Explicit verifier input | Loaded only from `--trust-root`; `alg=none`, HMAC, unknown `key_id`, revoked keys, and expired keys fail closed. |
| Raw model inputs / KV tensors / secrets | Forbidden in exports | Zero-echo sanitizer scans keys, patterns, encoded planted values, PII/IPv4s, and high-entropy tokens across artifacts, logs, and outputs. |

## 3. Attack Surfaces & Defenses

### 3.1 Parser-Differential & Canonicalization Attacks
- **Threats**: Duplicate keys, escaped key aliasing (`\u0073tatus`), `__proto__`/`constructor`/`prototype` pollution keys, `NaN`/`Infinity`/`-Infinity`, `-0.0`/`-0`, 64-bit integer truncation (`|n| > 2^53 - 1`), lone UTF-16 surrogates, NUL bytes (`\u0000`), UTF-8 BOM, trailing tokens, deep nesting DoS, integer-vs-float mismatches.
- **Defenses**: Independent token scanner in Python (`evidence_verifier.strict_json`) and TypeScript (`@vervain/evidence-verifier`) before JSON decoding, followed by independent RFC 8785 JCS canonicalization and SHA-256 verification.

### 3.2 Cryptographic Binding & Replay Attacks
- **Threats**: 1-byte post-hash mutation, copied signature across `run_id` / `evidence_status` / `git_sha` / `vllm_sha`, untrusted or revoked `key_id`, missing signature under `--require-signature`, signature without `--trust-root`, replayed `run_id` with different digest/timestamps.
- **Defenses**: Domain-separated canonical signing payload (`VERVAIN_EVIDENCE_PROOF_V1`) binding `(artifact_sha256, run_id, evidence_status, git_sha, vllm_sha)` under Ed25519 + persistent anti-replay `--seen-run-ids` ledger.

### 3.3 Evidence-Status Laundering & Placeholder Forgery
- **Threats**: Labeling a `local_only` or synthetic mock artifact `live`/`recorded`; `NO GPU RUN RECORDED` placeholders; `TBD`/`N/A`/`0000...` SHAs; `sample_count == 0`.
- **Defenses**: Verifier status monotonicity (`local_only` and `incomplete` always cap verdict at `NO VERDICT`, never infer `live` or `recorded`); placeholder detection -> `FAIL_STATUS_LAUNDERING` / `FAIL_PLACEHOLDER_METRIC`.

### 3.4 Clock, Timestamp & Scope Window Manipulation
- **Threats**: `started_at > finished_at`, future timestamps beyond 300s skew, negative durations, causal events outside run window, expired scope envelopes (`decided_at >= expires_at`).
- **Defenses**: ISO-8601 UTC ordering checks across root, paired arms, lifecycle events, scope decisions, dispatch spans, and command receipts.

### 3.5 Hardware, Patch, Dirty State & Backend Misrepresentation
- **Threats**: Claiming single-H200 or 8xH200 (`tp_size=8`) without distinct GPU UUID digests or driver/CUDA/PyTorch/Triton/vLLM manifest; hiding dirty git state; reporting configured backend instead of runtime-observed backend; mismatched patch SHA across artifact, manifest, ranks, and disk files.
- **Defenses**: Cross-binding `environment`, `gpu_manifest`, `paired_runs[].ranks`, `backend_dispatch`, and on-disk SHA-256 hashing in `verify-run`.

### 3.6 KV Block Generation & ABA Reuse Attacks
- **Threats**: Missing `allocation_generation`, zero generation, stale generation reuse after `free`/`retire`, reading `UNASSIGNED`/`retired`/`free` blocks, same physical block reused across tenants without monotonic generation increment.
- **Defenses**: Monotonic per-physical-block generation checks joining `block_lifecycle` -> `scope_decisions` -> `backend_dispatch` -> `paired_runs`.

### 3.7 Cross-Tenant Acceptance & Prefix Laundering
- **Threats**: Admitting a block where `request_scope != block_scope`; inferring `PUBLIC` scope purely from `token_hash_match` without `owner_approved_immutable_prefix`; `policy_epoch` mismatch; trusting client-supplied scope headers (`public_client_can_supply_scope: true`).
- **Defenses**: Explicit policy-join and epoch checks (`FAIL_SCOPE_CROSS_TENANT_ACCEPTED`, `FAIL_SCOPE_PUBLIC_INFERRED`, `FAIL_POLICY_EPOCH_MISMATCH`, `FAIL_CLIENT_SCOPE_SPOOF_ACCEPTED`).

### 3.8 Fault-Injection Illusion & Paired Baseline Breakage
- **Threats**: Non-synthetic fault injection claim; foreign block present inside clean block tables; `native_fault_injected` showing zero probe influence; `vervain_fault_injected` entering dispatch anyway; `vervain_clean` or `vervain_allowed_after_fault` getting blocked (`fail-closed denial`); clean runs compared across different seeds/configs or violating stated equivalence tolerance; broken sequential hash receipt chain.
- **Defenses**: Full 4-arm paired join verification (`native_clean`, `native_fault_injected`, `vervain_clean`, `vervain_allowed_after_fault`, plus `vervain_fault_injected`), seed/config equivalence binding, and chained SHA-256 receipt verification.

### 3.9 Multi-GPU Tensor Parallel (8xH200 TP8) Split-Brain
- **Threats**: Claiming `tp_size=8` while providing `<8` rank records or duplicate GPU UUID digests; rank 0 blocking while ranks 1..7 dispatch unguarded (`FAIL_TP_RANK_DISAGREEMENT`); rank-local patch or backend skew.
- **Defenses**: Exact `0..tp_size-1` rank coverage, unique `gpu_uuid_sha256` per rank, and unanimous cross-rank agreement on backend, patch SHA, scope disposition, and pre-dispatch block status.

### 3.10 Performance & Exclusions Dishonesty
- **Threats**: Comparing H100 vs H200 or mismatched batch/sequence shapes; reporting percentages without raw baseline/candidate denominators; reporting `p95` with `sample_count < 20`; inverted `p50 > p95` latencies or `admitted + withheld > retrieved`; omitting active CUDA graphs, KV connectors, swap, offload, or speculation paths from `exclusions.unsupported_paths`.
- **Defenses**: Strict config equality checks, positive denominator checks, minimum `p95` sample threshold (`20`), monotonic percentile bounds, and explicit exclusion requirements.

### 3.11 Protected Content, Secret & PII Leaks
- **Threats**: Exporting raw prompts, completions, KV tensors, planted canary strings (raw, case-folded, hex, base64, base64url), API/PEM/Bearer/JWT keys, emails, SSNs, IPv4 addresses, or customer data inside artifacts, `RUN_DIR` logs, or rendered verifier outputs.
- **Defenses**: Zero-echo `sanitizer` scans untrusted inputs, disk logs, JSONL traces, and re-sanitizes `verification.json` / `verification.md` before emission.

### 3.12 Run-Directory Tampering & Receipt Forgery
- **Threats**: Escaping symlinks, duplicate/shadow `.bak` files, altered stdout/stderr or missing command receipts, unexpected non-zero command exits, mismatched JSONL dispatch spans vs artifact records.
- **Defenses**: `verify-run` directory hygiene checks, canonical `receipt_sha256` verification, independent file hashing, and JSONL cross-joins.

## 4. Verdict Algebra

Precedence order:

```
ERROR (exit 3) > FAIL (exit 1) > NO VERDICT (exit 2) > PASS (exit 0)
```

- Any `FAIL_*` check overrides any `NV_*` check (contradictions are never masked as merely incomplete).
- `PASS` requires `evidence_status in {"live", "recorded"}`, all invariants passing, no `NV_*`, and no `FAIL_*`.
- `PASS` establishes only satisfaction of this verifier's named invariants for the pinned configuration; it never implies universal security, certification, compliance, production readiness, or uninstrumented-path coverage.
