#!/usr/bin/env python3
"""
Responsibility: Deterministic red-team and golden fixture generator for Vervain's Carbon 3
independent evidence verifier. Generates valid H200 TP1/TP8, local_only, incomplete,
31+ adversarial JSON artifacts, and complete RUN_DIR fixture trees.
Trust boundary: Uses only synthetic tenants (Alder, Birch) and ephemeral test keys.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sys
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]
_PKG_SRC = _REPO_ROOT / "packages" / "evidence-verifier" / "src"
if str(_PKG_SRC) not in sys.path:
    sys.path.insert(0, str(_PKG_SRC))

from evidence_verifier.mutator import (  # noqa: E402
    SigningContext,
    build_valid_baseline_artifact,
    create_ephemeral_test_signing_context,
    get_mutation_catalog,
    seal_and_sign,
)
from evidence_verifier.strict_json import canonicalize_jcs, compute_command_receipt_sha256  # noqa: E402

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
FIXED_NOW = datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc)


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _build_run_dir(
    dest_dir: Path,
    *,
    artifact: dict[str, Any],
    ctx: SigningContext,
    patch_bytes: bytes,
    source_bytes: bytes,
) -> None:
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    (dest_dir / "sources" / "tracked" / "vervain_scope").mkdir(parents=True, exist_ok=True)
    (dest_dir / "receipts" / "commands").mkdir(parents=True, exist_ok=True)
    (dest_dir / "logs").mkdir(parents=True, exist_ok=True)
    (dest_dir / "ranks").mkdir(parents=True, exist_ok=True)

    # Align artifact source hashes with actual on-disk bytes!
    art = copy.deepcopy(artifact)
    patch_sha = _sha256_bytes(patch_bytes)
    src_sha = _sha256_bytes(source_bytes)
    art["source"]["patch_sha256"] = patch_sha
    art["source"]["loaded_modules"][0]["file_sha256"] = src_sha
    for arm in art["paired_runs"].values():
        if arm["arm_id"].startswith("vervain_"):
            for r in arm["ranks"]:
                r["loaded_patch_sha256"] = patch_sha
    art = seal_and_sign(art, ctx)

    (dest_dir / "artifact.json").write_text(canonicalize_jcs(art) + "\n", encoding="utf-8")
    (dest_dir / "artifact.sig").write_text(canonicalize_jcs(art["signature"]) + "\n", encoding="utf-8")

    (dest_dir / "sources" / "vllm.patch").write_bytes(patch_bytes)
    (dest_dir / "sources" / "tracked" / "vervain_scope" / "backend_guard.py").write_bytes(source_bytes)
    source_hashes = {"vervain_scope/backend_guard.py": src_sha}
    (dest_dir / "sources" / "source_hashes.json").write_text(canonicalize_jcs(source_hashes) + "\n", encoding="utf-8")

    # Logs: dispatch_spans.jsonl & events.jsonl
    span_lines = []
    for sp in art["backend_dispatch"]:
        row = dict(sp)
        row["run_id"] = art["run_id"]
        span_lines.append(canonicalize_jcs(row))
    (dest_dir / "logs" / "dispatch_spans.jsonl").write_text("\n".join(span_lines) + "\n", encoding="utf-8")

    ev_lines = [canonicalize_jcs(ev) for ev in art["receipt_chain"]["events"]]
    (dest_dir / "logs" / "events.jsonl").write_text("\n".join(ev_lines) + "\n", encoding="utf-8")

    # Per-rank files
    tp_size = art["runtime_manifest"]["tp_size"]
    expected_files = [
        "artifact.json",
        "manifest.json",
        "sources/vllm.patch",
        "sources/source_hashes.json",
        "logs/dispatch_spans.jsonl",
        "logs/events.jsonl",
    ]
    for rk in range(tp_size):
        rpath = f"ranks/rank_{rk}.json"
        expected_files.append(rpath)
        rdata = {
            "run_id": art["run_id"],
            "rank_id": rk,
            "gpu_uuid_sha256": art["runtime_manifest"]["gpu_uuids_sha256"][rk] if rk < len(art["runtime_manifest"]["gpu_uuids_sha256"]) else None,
            "loaded_vllm_sha": art["source"]["vllm_sha"],
            "loaded_patch_sha256": patch_sha,
            "selected_runtime_backend": art["runtime_manifest"]["selected_runtime_backend"],
            "enforced_fault_decision": "deny_fail_closed",
            "entered_attention_dispatch_on_fault": False,
        }
        (dest_dir / rpath).write_text(canonicalize_jcs(rdata) + "\n", encoding="utf-8")

    # Command receipts + stdio logs
    stdout_bytes = b"vervain bounded paired run completed: foreign block stopped before dispatch\n"
    stderr_bytes = b""
    (dest_dir / "logs" / "step1_stdout.log").write_bytes(stdout_bytes)
    (dest_dir / "logs" / "step1_stderr.log").write_bytes(stderr_bytes)
    rcpt: dict[str, Any] = {
        "schema_version": "command-receipt.v1",
        "receipt_id": f"rcpt-01-{art['run_id']}",
        "run_id": art["run_id"],
        "step_id": "01_paired_h200_run",
        "command": {
            "executable": "python3",
            "argv_sanitized": ["python3", "scripts/inference-proof/run_paired.py", "--tp", str(tp_size)],
            "argv_redacted_indices": [],
            "working_dir_digest": _sha256_bytes(b"/workspace/vervain"),
        },
        "exit_code": 0,
        "expected_nonzero_control": False,
        "signal": None,
        "started_at": art["started_at"],
        "finished_at": art["finished_at"],
        "duration_ms": 12450.0,
        "git": {
            "git_sha": art["source"]["git_sha"],
            "git_dirty_before": art["source"]["git_dirty"],
            "git_dirty_after": art["source"]["git_dirty"],
            "dirty_entries_count": 0,
            "branch": "carbon/scoped-attention",
        },
        "environment": {
            "safe_env_vars": {"VLLM_ATTENTION_BACKEND": "FLASH_ATTN"},
            "redacted_env_keys": ["GEMINI_API_KEY"],
            "env_digest_sha256": _sha256_bytes(b"vervain.env.v1\nsynthetic"),
        },
        "host_id_digest": art["runtime_manifest"]["host_id_digest"],
        "stdout_sha256": _sha256_bytes(stdout_bytes),
        "stderr_sha256": _sha256_bytes(stderr_bytes),
        "stdout_bytes": len(stdout_bytes),
        "stderr_bytes": len(stderr_bytes),
        "stdout_relpath": "logs/step1_stdout.log",
        "stderr_relpath": "logs/step1_stderr.log",
        "expected_files": [],
        "receipt_sha256": "0" * 64,
    }
    rcpt["receipt_sha256"] = compute_command_receipt_sha256(rcpt)
    (dest_dir / "receipts" / "commands" / "01_paired_h200_run.json").write_text(
        canonicalize_jcs(rcpt) + "\n", encoding="utf-8"
    )

    manifest = {
        "schema_version": "run-manifest.v1",
        "run_id": art["run_id"],
        "evidence_status": art["evidence_status"],
        "created_at": art["started_at"],
        "source": {
            "git_sha": art["source"]["git_sha"],
            "git_dirty": art["source"]["git_dirty"],
            "vllm_sha": art["source"]["vllm_sha"],
            "patch_sha256": patch_sha,
            "trace_sha256": art["source"]["trace_sha256"],
        },
        "gpu_model": art["runtime_manifest"]["gpu_model"],
        "gpu_count": art["runtime_manifest"]["gpu_count"],
        "gpu_uuids_sha256": art["runtime_manifest"]["gpu_uuids_sha256"],
        "tp_size": tp_size,
        "configured_backend": art["runtime_manifest"]["configured_backend"],
        "selected_runtime_backend": art["runtime_manifest"]["selected_runtime_backend"],
        "model_id": art["runtime_manifest"]["model_id"],
        "model_revision": art["runtime_manifest"]["model_revision"],
        "expected_files": expected_files,
    }
    (dest_dir / "manifest.json").write_text(canonicalize_jcs(manifest) + "\n", encoding="utf-8")


def generate_all_fixtures(out_root: Path = FIXTURES_DIR) -> dict[str, Any]:
    if out_root.exists():
        shutil.rmtree(out_root)
    adv_dir = out_root / "adversarial"
    run_dirs_root = out_root / "run_dirs"
    adv_dir.mkdir(parents=True, exist_ok=True)
    run_dirs_root.mkdir(parents=True, exist_ok=True)

    ctx = create_ephemeral_test_signing_context(now_utc=FIXED_NOW)
    (out_root / "ephemeral_test_trust_root.json").write_text(
        json.dumps(ctx.trust_root_dict, indent=2) + "\n", encoding="utf-8"
    )

    base_tp1 = build_valid_baseline_artifact(ctx=ctx, tp_size=1, evidence_status="recorded", now_utc=FIXED_NOW)
    base_tp8 = build_valid_baseline_artifact(ctx=ctx, tp_size=8, evidence_status="recorded", now_utc=FIXED_NOW)
    local_only = build_valid_baseline_artifact(ctx=ctx, tp_size=1, evidence_status="local_only", now_utc=FIXED_NOW)
    incomplete = copy.deepcopy(base_tp8)
    incomplete["evidence_status"] = "incomplete"
    incomplete["ui_summary"]["evidence_status"] = "incomplete"
    incomplete["performance"] = None
    incomplete["ui_summary"]["ttft_delta_pct"] = None
    incomplete = seal_and_sign(incomplete, ctx)

    (out_root / "valid_h200_tp1.json").write_text(json.dumps(base_tp1, indent=2) + "\n", encoding="utf-8")
    (out_root / "valid_h200_tp8.json").write_text(json.dumps(base_tp8, indent=2) + "\n", encoding="utf-8")
    (out_root / "local_only.json").write_text(json.dumps(local_only, indent=2) + "\n", encoding="utf-8")
    (out_root / "incomplete.json").write_text(json.dumps(incomplete, indent=2) + "\n", encoding="utf-8")

    expectations: list[dict[str, Any]] = [
        {"file": "valid_h200_tp1.json", "expected_verdict": "PASS", "expected_reason_code": "PASS_VERIFIED"},
        {"file": "valid_h200_tp8.json", "expected_verdict": "PASS", "expected_reason_code": "PASS_VERIFIED"},
        {"file": "local_only.json", "expected_verdict": "NO VERDICT", "expected_reason_code": "NV_STATUS_LOCAL_ONLY"},
        {"file": "incomplete.json", "expected_verdict": "NO VERDICT", "expected_reason_code": "NV_STATUS_INCOMPLETE"},
    ]

    for case in get_mutation_catalog():
        mutated = case.mutate_fn(base_tp8, ctx)
        fname = f"adversarial/{case.case_id}.json"
        if isinstance(mutated, str):
            (out_root / fname).write_text(mutated + "\n", encoding="utf-8")
        else:
            (out_root / fname).write_text(json.dumps(mutated, indent=2) + "\n", encoding="utf-8")
        expectations.append(
            {
                "file": fname,
                "case_id": case.case_id,
                "campaign": case.campaign,
                "expected_verdict": case.expected_verdict.value,
                "expected_reason_code": case.expected_reason_code,
                "require_signature": case.require_signature,
                "use_seen_ledger": case.use_seen_ledger,
            }
        )

    patch_bytes = b"diff --git a/vllm/attention.py b/vllm/attention.py\n+verify_block_scopes()\n"
    source_bytes = b"# synthetic tracked guard source\ndef verify_block_scopes():\n    return True\n"

    # 1. Valid TP8 RUN_DIR
    _build_run_dir(
        run_dirs_root / "valid_h200_tp8_run",
        artifact=base_tp8,
        ctx=ctx,
        patch_bytes=patch_bytes,
        source_bytes=source_bytes,
    )
    # 2. Tampered patch file on disk
    _build_run_dir(
        run_dirs_root / "tampered_patch_run",
        artifact=base_tp8,
        ctx=ctx,
        patch_bytes=patch_bytes,
        source_bytes=source_bytes,
    )
    (run_dirs_root / "tampered_patch_run" / "sources" / "vllm.patch").write_bytes(b"tampered patch bytes\n")

    # 3. Missing dispatch spans on incomplete run -> NO VERDICT
    _build_run_dir(
        run_dirs_root / "missing_spans_incomplete_run",
        artifact=incomplete,
        ctx=ctx,
        patch_bytes=patch_bytes,
        source_bytes=source_bytes,
    )
    (run_dirs_root / "missing_spans_incomplete_run" / "logs" / "dispatch_spans.jsonl").unlink()

    # 4. Shadow/duplicate file in RUN_DIR -> FAIL
    _build_run_dir(
        run_dirs_root / "shadow_file_run",
        artifact=base_tp8,
        ctx=ctx,
        patch_bytes=patch_bytes,
        source_bytes=source_bytes,
    )
    shutil.copy2(
        run_dirs_root / "shadow_file_run" / "manifest.json",
        run_dirs_root / "shadow_file_run" / "manifest (1).json",
    )

    # 5. Rank disagreement on TP8 RUN_DIR -> FAIL
    _build_run_dir(
        run_dirs_root / "rank_disagreement_tp8_run",
        artifact=base_tp8,
        ctx=ctx,
        patch_bytes=patch_bytes,
        source_bytes=source_bytes,
    )
    r3_path = run_dirs_root / "rank_disagreement_tp8_run" / "ranks" / "rank_3.json"
    r3 = json.loads(r3_path.read_text(encoding="utf-8"))
    r3["selected_runtime_backend"] = "TRITON_ATTN"
    r3_path.write_text(canonicalize_jcs(r3) + "\n", encoding="utf-8")

    # 6. Receipt stdout digest mismatch -> FAIL
    _build_run_dir(
        run_dirs_root / "receipt_digest_mismatch_run",
        artifact=base_tp8,
        ctx=ctx,
        patch_bytes=patch_bytes,
        source_bytes=source_bytes,
    )
    (run_dirs_root / "receipt_digest_mismatch_run" / "logs" / "step1_stdout.log").write_bytes(b"altered stdout\n")

    # 7. Leaked secret in stdout log -> FAIL
    _build_run_dir(
        run_dirs_root / "leaked_secret_log_run",
        artifact=base_tp8,
        ctx=ctx,
        patch_bytes=patch_bytes,
        source_bytes=source_bytes,
    )
    (run_dirs_root / "leaked_secret_log_run" / "logs" / "step1_stdout.log").write_bytes(
        b"debug GEMINI_API_KEY=AIzaSyDummyLeakForVerificationTest987654\n"
    )

    manifest_summary = {
        "schema_version": "corpus-expectations.v1",
        "total_json_fixtures": len(expectations),
        "adversarial_count": len(expectations) - 4,
        "run_dirs": [
            {"dir": "run_dirs/valid_h200_tp8_run", "expected_verdict": "PASS", "expected_reason_code": "PASS_VERIFIED"},
            {"dir": "run_dirs/tampered_patch_run", "expected_verdict": "FAIL", "expected_reason_code": "FAIL_PATCH_DIGEST_MISMATCH"},
            {"dir": "run_dirs/missing_spans_incomplete_run", "expected_verdict": "NO VERDICT", "expected_reason_code": "NV_MISSING_JOIN_EVIDENCE"},
            {"dir": "run_dirs/shadow_file_run", "expected_verdict": "FAIL", "expected_reason_code": "FAIL_RUN_DIR_AMBIGUOUS_FILE"},
            {"dir": "run_dirs/rank_disagreement_tp8_run", "expected_verdict": "FAIL", "expected_reason_code": "FAIL_BACKEND_INTENT_MISMATCH"},
            {"dir": "run_dirs/receipt_digest_mismatch_run", "expected_verdict": "FAIL", "expected_reason_code": "FAIL_COMMAND_RECEIPT_INVALID"},
            {"dir": "run_dirs/leaked_secret_log_run", "expected_verdict": "FAIL", "expected_reason_code": "FAIL_SECRET_LEAK_KEY_OR_TOKEN"},
        ],
        "json_fixtures": expectations,
    }
    (out_root / "corpus_expectations.json").write_text(
        json.dumps(manifest_summary, indent=2) + "\n", encoding="utf-8"
    )
    return manifest_summary


if __name__ == "__main__":
    summary = generate_all_fixtures()
    print(f"Generated {summary['total_json_fixtures']} JSON fixtures and {len(summary['run_dirs'])} RUN_DIR trees.")
