# H200 & 8xH200 Verification Runbook

## 1. Hard Cluster & Non-Interference Constraints

1. **No GPU activity before PJ's explicit `GPU GO`**: Never connect to, probe, allocate, start, stop, or discover GPUs or remote pods without PJ's live authorization (`10:00 AM PT` hold; directed single-H200 / 8xH200 cluster window at `10:30 AM PT`).
2. **Do not touch external H200 allocations**: Separate H200s reserved for another challenge must remain completely untouched. `verify_h200_run.sh` operates strictly read-only on a locally materialized `RUN_DIR` and never runs SSH, `nvidia-smi` cluster discovery, SLURM/Kubernetes calls, or pod orchestration.
3. **Never infer hardware from filenames**: A file named `h200_tp8.json` is never trusted without a bound GPU manifest (`gpu_model`, `gpu_count`, unique `gpu_uuids_sha256`, driver, CUDA, PyTorch, Triton, vLLM SHA, and per-rank hardware records).

## 2. What Single-H200 (TP1) & 8xH200 (TP8) Verification Checks

### Single-H200 (`tp_size = 1`, 141 GB HBM3e)
- Verifies `environment.gpu_manifest.gpu_count == 1` and `tp_size == 1`, with `"H200"` in `gpu_model` and exact `len(gpu_uuids_sha256) == 1`.
- Binds runtime-selected backend (`VLLM_ATTENTION_BACKEND` runtime observation matching `backend_dispatch` spans, never just startup CLI intent).
- Verifies 4-arm evidence + post-violation follow-up (`native_clean`, `native_fault_injected`, `vervain_clean`, `vervain_fault_injected`, `vervain_allowed_after_fault`).
- Verifies every foreign block is rejected with a positive non-stale `allocation_generation` before `attention_dispatch`, while `vervain_clean` matches `native_clean` within stated numeric tolerance under identical seed/config, and `vervain_allowed_after_fault` completes after the violation.
- Verifies TTFT/throughput/memory overhead comparisons carry explicit raw baseline, candidate, and denominator (`sample_count >= 20` when p95 is reported) and list disabled unsupported paths (CUDA graphs, KV connectors, swap, offload, speculation).

### 8xH200 (`tp_size = 8`, NVSwitch multi-rank)
- Enforces every single-H200 check **plus**:
  - `environment.gpu_manifest.gpu_count == 8` with `8` distinct SHA-256 hashed GPU UUIDs (`len(set(gpu_uuids_sha256)) == 8`).
  - Every paired arm and `RUN_DIR/logs/rank_0.json..rank_7.json` must contain **all 8 contiguous ranks (`0..7`)** with unique `gpu_uuid_sha256` digests matching the manifest (`FAIL_TP_RANK_COUNT_MISMATCH` / `FAIL_TP_DUPLICATE_RANK`).
  - Unanimous cross-rank agreement (`FAIL_TP_RANK_DISAGREEMENT`) on logical `disposition`, `loaded_patch_sha256`, `selected_backend`, and pre-dispatch block status (`rank 0` blocking while ranks `1..7` dispatch is caught as `FAIL`).
  - Performance impact covers all-rank collective synchronization overhead (`abs_baseline`, `abs_candidate`, `denominator`, `sample_count >= 20` for p95) on matched 8xH200 topology.

## 3. Bounded Verification Procedure (Post-GPU GO)

Once Carbon 2 / PJ has written the completed run directory `$RUN_DIR` locally (with `proof.json`, `manifest.json`, `artifacts/patch.diff`, `logs/`, and `receipts/commands/`), run:

```bash
bash verification/verify_h200_run.sh "$RUN_DIR" \
  --trust-root /path/to/trust_root.json \
  --require-signature \
  --seen-run-ids /path/to/seen_run_ids.json \
  --forbidden-strings-file /path/to/planted_values.txt
```

Note: Keep `/path/to/planted_values.txt` outside `RUN_DIR` and never commit it to git.

## 4. Interpreting Outputs (`verification.json` & `verification.md`)

- **Exit `0` (`PASS`)**: `verification.json` (`verifier-result.v1`) and `verification.md` confirm `verified_evidence_status` is `live` or `recorded`, zero `FAIL_*` or `NV_*` codes exist, Ed25519 signature verified against `--trust-root`, and zero secrets/planted values appear anywhere in the run directory.
- **Exit `1` (`FAIL`)**: Contradiction or security violation detected (e.g., `FAIL_VIOLATION_ENTERED_DISPATCH`, `FAIL_TP_RANK_DISAGREEMENT`, `FAIL_PATCH_DIGEST_MISMATCH`, `FAIL_PROTECTED_CONTENT_PLANTED_VALUE`). Inspect `verification.json` -> `checks[]` and `reason_codes` without reading raw protected tensors.
- **Exit `2` (`NO VERDICT`)**: Artifact is `local_only`, `incomplete`, missing `--trust-root` for a signed/required check, or missing join files. Do not promote to `PASS` or present as an H200 runtime result.
- **Exit `3` (`ERROR`)**: Bad arguments, unreadable directory, invalid `trust-root.v1` schema, or internal error.

## 5. Pre-Submit Sanity Check Before Presenting to Judges

Before showing any run in the Carbon demo UI:

1. Run `verification/verify_h200_run.sh` on the finalized `RUN_DIR`.
2. Verify `jq -r '.verdict + " " + .verified_evidence_status + " " + .primary_reason_code' "$RUN_DIR/verification.json"` returns `PASS live PASS_VERIFIED` (or `PASS recorded PASS_VERIFIED`).
3. Confirm `verification/run_local_gates.py` passes cleanly on the workspace (`all_passed: true`, zero secret scan hits).
