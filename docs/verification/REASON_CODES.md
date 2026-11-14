# Vervain Evidence Verifier Reason Codes

All reason codes emitted by `evidence-verifier` (`reason_codes.py`) follow a fixed verdict mapping and exit-code contract:

- `PASS_*` -> Verdict `PASS` (CLI exit code `0`)
- `FAIL_*` -> Verdict `FAIL` (CLI exit code `1`)
- `NV_*` -> Verdict `NO VERDICT` (CLI exit code `2`)
- `VERIFIER_ERROR_*` -> Verdict `ERROR` (CLI exit code `3`)

Use `evidence-verifier explain <REASON_CODE>` for machine-readable lookup of any code's invariant, distinction rule, and remediation.

## `PASS` Codes (`exit 0`)

| Code | Severity | Category | Invariant |
| :--- | :--- | :--- | :--- |
| `PASS_VERIFIED` | INFO | Verification | All schema, canonical digest, signature (when required), provenance, causal join, KV lifecycle, pre-dispatch, equivalence, TP rank, performance, exclusion, and sanitization invariants satisfied for a live or recorded GPU run. |
| `PASS_SANITIZE_CLEAN` | INFO | Sanitization | No forbidden keys, raw prompts/outputs, planted values, KV tensors, credentials, network addresses, or customer PII detected. |

## `FAIL` Codes (`exit 1`)

| Code | Severity | Category | Invariant |
| :--- | :--- | :--- | :--- |
| `FAIL_PARSE_SYNTAX` | CRITICAL | Parser/Canon | Input artifact must be valid strict RFC 8259 UTF-8 JSON without BOM, trailing tokens, or excessive nesting depth. |
| `FAIL_CANON_DUPLICATE_KEY` | CRITICAL | Parser/Canon | Every JSON object across artifacts, manifests, receipts, and JSONL logs must have strictly unique keys after string unescaping. |
| `FAIL_CANON_NONFINITE_NUMBER` | CRITICAL | Parser/Canon | NaN, Infinity, -Infinity, and overflowed non-finite floats are strictly prohibited. |
| `FAIL_CANON_NEGATIVE_ZERO` | HIGH | Parser/Canon | `-0.0` (and `-0`) is prohibited to eliminate JCS sign-bit canonicalization divergence. |
| `FAIL_CANON_FLOAT_INT_MISMATCH` | HIGH | Parser/Canon | Integer-typed fields must be encoded as JSON integers without fractional syntax. |
| `FAIL_CANON_INT_OVERFLOW` | HIGH | Parser/Canon | JSON integers must stay within IEEE-754 exact safe integer bounds (`\|n\| <= 2^53 - 1`). |
| `FAIL_CANON_UNICODE_OR_NUL` | HIGH | Parser/Canon | Strings must not contain NUL bytes or lone UTF-16 surrogates. |
| `FAIL_CANON_PROTOTYPE_KEY` | CRITICAL | Parser/Canon | Object keys `__proto__`, `constructor`, and `prototype` are forbidden anywhere in the payload. |
| `FAIL_SCHEMA_INVALID` | HIGH | Schema | Artifact must conform to the supported JSON Schema (`inference-proof.v1.schema.json`) with `additionalProperties: false`. |
| `FAIL_DIGEST_MISMATCH` | CRITICAL | Integrity | `artifact_sha256` must equal the independent RFC 8785 JCS canonical SHA-256 over the artifact excluding `artifact_sha256` and `signature`. |
| `FAIL_SIG_ALG_UNSAFE` | CRITICAL | Signature | Signature algorithm must be an explicit asymmetric algorithm authorized by the trust root (`ed25519`); `alg=none` or HMAC downgrades are rejected. |
| `FAIL_SIG_INVALID` | CRITICAL | Signature | Cryptographic signature must verify over the domain-separated binding payload and match `signed_digest_sha256 == artifact_sha256`. |
| `FAIL_SIG_UNTRUSTED_KEY` | CRITICAL | Signature | Signing `key_id` must exist in the explicit `--trust-root` bundle, be active, within validity window, and permitted for the run. |
| `FAIL_SIG_KEY_ID_MISMATCH` | HIGH | Signature | Signature `trust_root_id` and `key_id` must unambiguously match the resolved trust-root entry. |
| `FAIL_SIG_REPLAY_OR_COPIED` | CRITICAL | Signature | Signature binding covers exact `run_id`, `evidence_status`, `git_sha`, `vllm_sha`, and `artifact_sha256`. |
| `FAIL_RUN_ID_MISMATCH` | CRITICAL | Provenance/Join | `run_id` must be identical across artifact root, `receipt_chain` events, manifest, command receipts, logs, and rank records. |
| `FAIL_RUN_ID_REPLAYED` | HIGH | Replay | `run_id` must not replay a previously verified run in the `--seen-run-ids` ledger with differing artifact digest or timestamps. |
| `FAIL_TIMESTAMP_REVERSED` | HIGH | Clock/Time | `started_at <= finished_at` across root, arms, and receipts; causal timestamps must be monotonically ordered with non-negative duration. |
| `FAIL_TIMESTAMP_FUTURE` | HIGH | Clock/Time | Artifact and event timestamps must not lie in the future beyond allowed clock skew (`300s`). |
| `FAIL_TIMESTAMP_OUT_OF_WINDOW` | HIGH | Clock/Time | All causal events must occur inside `[started_at, finished_at]` and scope envelopes must be valid at decision time (`issued_at <= decided_at < expires_at`). |
| `FAIL_STATUS_LAUNDERING` | CRITICAL | Status | `live` and `recorded` runs must not contain local/mock/synthetic-stub markers or `NO GPU RUN RECORDED` placeholders. |
| `FAIL_PLACEHOLDER_METRIC` | HIGH | Status | Metrics, SHAs, and hardware metadata must not contain placeholder sentinels (`TBD`, `N/A`, `0000...`, `sample_count == 0`). |
| `FAIL_UI_SUMMARY_CONTRADICTION` | CRITICAL | Integrity/UI | Optional `ui_summary` fields must strictly match values independently derived from raw records. |
| `FAIL_GPU_MANIFEST_CONTRADICTION` | CRITICAL | Provenance | `live` or `recorded` GPU/H200 claims require non-empty H200 GPU manifest with `gpu_count >= 1`, distinct `gpu_uuids_sha256`, driver, CUDA, PyTorch, Triton, vLLM, and launch config. |
| `FAIL_PATCH_DIGEST_MISMATCH` | CRITICAL | Provenance | `vllm_sha`, `patch_sha256`, `trace_sha256`, and `loaded_modules` digests must match across artifact, ranks, manifest, and on-disk `RUN_DIR` files. |
| `FAIL_DIRTY_STATE_HIDDEN` | HIGH | Provenance | `git_dirty` must be explicitly accurate across artifact, manifest, and command receipts. |
| `FAIL_BACKEND_INTENT_MISMATCH` | CRITICAL | Enforcement | Runtime-selected attention backend across manifest, artifact, `backend_dispatch` spans, and ranks must be consistent and must not substitute configured intent for runtime observation. |
| `FAIL_BLOCK_GEN_MISSING_OR_ZERO` | CRITICAL | KV Lifecycle | Every physical block reference, scope decision, and lifecycle entry must carry a positive integer `allocation_generation` (`>= 1`). |
| `FAIL_BLOCK_STALE_GENERATION` | CRITICAL | KV Lifecycle | Guarded block generation must match the active readable `block_lifecycle` generation; reassignment after `free`/`retire` must increment generation and stale generations must never be allowed. |
| `FAIL_BLOCK_UNASSIGNED_READ` | CRITICAL | KV Lifecycle | Blocks in `free`, `retired`, or `UNASSIGNED` state must never be admitted or read. |
| `FAIL_SCOPE_CROSS_TENANT_ACCEPTED` | CRITICAL | Enforcement | Foreign-scope blocks (`request_scope != block_scope` and `block_scope != PUBLIC`) must never receive `disposition=allow`. |
| `FAIL_SCOPE_PUBLIC_INFERRED` | CRITICAL | KV Lifecycle | `PUBLIC` scope must come from explicit owner-approved immutable prefix policy (`owner_approved_immutable_prefix`), never inferred from token-hash equality. |
| `FAIL_POLICY_EPOCH_MISMATCH` | HIGH | Enforcement | Admitted scope decisions require matching request `policy_epoch` and `block_policy_epoch`. |
| `FAIL_CLIENT_SCOPE_SPOOF_ACCEPTED` | CRITICAL | Auth/Scope | `trust_boundary.public_client_can_supply_scope` must be `false`. |
| `FAIL_INJECTION_NONSYNTHETIC` | HIGH | Safety/Claim | Fault injection must be explicitly controlled and synthetic (`synthetic_only=true`, `controlled_engine_internal_post_auth_substitution`). |
| `FAIL_CLEAN_CONTAMINATED` | CRITICAL | Isolation | The foreign physical block injected into fault runs must be strictly absent from `native_clean` and `vervain_clean` block tables. |
| `FAIL_NATIVE_FAULT_NO_INFLUENCE` | HIGH | Fault Proof | `native_fault_injected` must enter attention dispatch and exhibit nonzero planted-value influence in the bound probe. |
| `FAIL_VIOLATION_ENTERED_DISPATCH` | CRITICAL | Enforcement | `vervain_fault_injected` must be blocked before backend dispatch (`entered_attention_dispatch=false`, `blocked_before_dispatch=true`, `dispatched_at=null`, zero probe influence). |
| `FAIL_ALLOWED_REQUEST_BLOCKED` | HIGH | Correctness | `vervain_clean` and `vervain_allowed_after_fault` must both enter backend dispatch and complete normally after violation. |
| `FAIL_CLEAN_SEED_OR_CONFIG_MISMATCH` | HIGH | Equivalence | `native_clean` and `vervain_clean` must share identical seed and configuration digest matching correctness. |
| `FAIL_EQUIVALENCE_TOLERANCE_EXCEEDED` | HIGH | Equivalence | Clean numeric equivalence delta must be within stated `equivalence_tolerance` and marked `clean_equivalence_passed=true`. |
| `FAIL_MISSING_REQUIRED_JOIN` | CRITICAL | Join Integrity | In `live`/`recorded` artifacts claiming completion, all mandatory relational joins across `paired_runs`, `scope_decisions`, `block_lifecycle`, `backend_dispatch`, `correctness`, and `receipt_chain` must resolve. |
| `FAIL_RECEIPT_CHAIN_BROKEN` | CRITICAL | Integrity | `receipt_chain` hashes must link sequentially from `genesis_sha256` to `head_sha256` with contiguous `event_index`. |
| `FAIL_TP_RANK_COUNT_MISMATCH` | CRITICAL | Multi-GPU TP | Every paired arm and `RUN_DIR` rank set must include all `tp_size` unique ranks (`0..tp_size-1`) with distinct `gpu_uuid_sha256`. |
| `FAIL_TP_DUPLICATE_RANK` | CRITICAL | Multi-GPU TP | Rank IDs and GPU UUID digests per arm must be unique and contiguous over `0..tp_size-1`. |
| `FAIL_TP_RANK_DISAGREEMENT` | CRITICAL | Multi-GPU TP | All TP ranks must agree on logical scope decision, `loaded_patch_sha256`, `selected_backend`, and pre-dispatch block status. |
| `FAIL_UNSUPPORTED_PATH_OMITTED` | HIGH | Exclusions | Active or non-eager graph modes, `kv_connector`, offload, swap, and speculation must be explicitly disabled/fail-closed and declared in `exclusions.unsupported_paths`. |
| `FAIL_PERF_CONFIG_MISMATCH` | HIGH | Performance | Performance `baseline_config` and `candidate_config` must match on GPU model/count, model revision, backend, dtype, block_size, shapes, concurrency, warmup, and `sample_count`. |
| `FAIL_PERF_MISSING_DENOMINATOR` | HIGH | Performance | Every performance metric percentage must carry finite `abs_baseline`, `abs_candidate`, `denominator == abs_baseline > 0`, `delta_abs`, and `sample_count`. |
| `FAIL_PERF_INSUFFICIENT_SAMPLES` | MEDIUM | Performance | Reporting p95 latency/throughput requires `sample_count >= 20` (recommended `>= 30`). |
| `FAIL_PERF_IMPOSSIBLE_METRIC` | HIGH | Performance | Latencies/throughput/memory must be finite, non-negative, consistent (`p50 <= p95` for latency, `p50 >= p95` for throughput), and counts must obey `admitted + withheld <= retrieved`. |
| `FAIL_SECRET_LEAK_KEY_OR_TOKEN` | CRITICAL | Sanitization | Exported artifacts, logs, and reports must contain zero API keys, PEM keys, bearer/JWT tokens, cookies, credentials, or secret key names. |
| `FAIL_PROTECTED_CONTENT_PROMPT_OR_KV` | CRITICAL | Sanitization | Exported artifacts and reports must contain zero raw prompts, completions, chunk text, or KV tensor dumps. |
| `FAIL_PROTECTED_CONTENT_PLANTED_VALUE` | CRITICAL | Sanitization | Raw synthetic planted values (and hex/base64/base64url encodings thereof) must never appear in exported artifacts or reports. |
| `FAIL_PII_OR_NETWORK_ADDRESS_LEAK` | HIGH | Sanitization | Exported evidence must not leak unhashed IP addresses, emails, SSNs, street addresses, or customer PII. |
| `FAIL_RUN_DIR_AMBIGUOUS_FILE` | CRITICAL | Run Provenance | `RUN_DIR` files must be regular files contained within `RUN_DIR` with exact-once presence and zero shadow/backup duplicates. |
| `FAIL_COMMAND_RECEIPT_INVALID` | CRITICAL | Run Provenance | Command receipts must have valid canonical `receipt_sha256`, non-zero exit only on expected probe steps, and matching stdout/stderr digests. |

## `NO VERDICT` Codes (`exit 2`)

| Code | Severity | Category | Invariant |
| :--- | :--- | :--- | :--- |
| `NV_STATUS_LOCAL_ONLY` | INFO | Status | `local_only` artifacts cannot establish the H200 runtime claim. |
| `NV_STATUS_INCOMPLETE` | INFO | Status | `incomplete` artifacts omit required runtime, rank, or performance evidence. |
| `NV_UNSUPPORTED_SCHEMA_VERSION` | MEDIUM | Schema | `schema_version` must be supported by this verifier (`inference-proof.v1`). |
| `NV_TRUST_ROOT_UNPROVIDED` | MEDIUM | Signature | When signature verification is required or a signature is present without an explicit trust root, authenticity cannot be verified. |
| `NV_SIG_MISSING` | LOW | Signature | When `--require-signature` is set, artifact must include a detached or embedded signature. |
| `NV_MISSING_GPU_MANIFEST` | MEDIUM | Provenance | GPU runtime manifest fields (`gpu_model`, `gpu_count`, `gpu_uuids_sha256`, driver/CUDA) are missing on an incomplete/local artifact. |
| `NV_MISSING_ALLOCATION_GENERATION` | MEDIUM | KV Lifecycle | Physical block `allocation_generation` is absent/null on an incomplete/local artifact. |
| `NV_MISSING_JOIN_EVIDENCE` | MEDIUM | Join Integrity | Required causal join records (`scope_decisions`, `block_lifecycle`, `backend_dispatch`, or `RUN_DIR` files) are missing on an incomplete/local run. |
| `NV_TP_RANK_EVIDENCE_MISSING` | MEDIUM | Multi-GPU TP | Multi-rank TP evidence has fewer rank records than claimed `tp_size` on an incomplete run. |
| `NV_PERF_INCOMPLETE` | LOW | Performance | Performance section is null/uncollected on an incomplete artifact. |

## `ERROR` Codes (`exit 3`)

| Code | Severity | Category | Invariant |
| :--- | :--- | :--- | :--- |
| `VERIFIER_ERROR_CLI_ARGS` | HIGH | Verifier Ops | CLI arguments and subcommands must be valid. |
| `VERIFIER_ERROR_IO` | HIGH | Verifier Ops | Target paths must exist and be readable within size limits. |
| `VERIFIER_ERROR_TRUST_ROOT_INVALID` | CRITICAL | Verifier Ops | Explicit `--trust-root` bundle must validate against `trust-root.v1` schema. |
| `VERIFIER_ERROR_INTERNAL` | CRITICAL | Verifier Ops | No unhandled internal exception may occur during verification. |

Total catalog size: `73` codes (`2 PASS`, `57 FAIL`, `10 NO VERDICT`, `4 ERROR`).
