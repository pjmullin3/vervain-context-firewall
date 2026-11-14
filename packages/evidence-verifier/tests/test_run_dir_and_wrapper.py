"""
Tests for verify-run RUN_DIR provenance checks, symlink containment, command wrapper receipts,
and deterministic structural report snapshots.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import sys

from evidence_verifier.crypto import load_trust_root
from evidence_verifier.reason_codes import Verdict
from evidence_verifier.run_dir import verify_run_directory
from evidence_verifier.schema_validator import validate_against_schema

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "verification" / "fixtures"
RUN_DIRS = FIXTURES / "run_dirs"
sys.path.insert(0, str(REPO_ROOT / "verification"))
from run_wrapped import run_wrapped_command  # noqa: E402


def test_committed_run_dir_corpus(tmp_path: Path) -> None:
    expectations = json.loads((FIXTURES / "corpus_expectations.json").read_text(encoding="utf-8"))
    tr = load_trust_root(FIXTURES / "ephemeral_test_trust_root.json")

    for entry in expectations["run_dirs"]:
        rdir = FIXTURES / entry["dir"]
        out_dir = tmp_path / Path(entry["dir"]).name
        res = verify_run_directory(rdir, trust_root=tr, require_signature=True, out_dir=out_dir, write_outputs=True)
        assert res.verdict.value == entry["expected_verdict"], (
            f"{entry['dir']}: expected {entry['expected_verdict']}, got {res.verdict.value} ({res.result_dict['reason_codes']})"
        )
        assert entry["expected_reason_code"] in res.result_dict["reason_codes"]

        # Structural snapshot validation against verifier-result.v1.schema.json
        schema_errs = validate_against_schema(res.result_dict, "verifier-result.v1.schema.json")
        assert schema_errs == []
        assert (out_dir / "verification.json").is_file()
        assert (out_dir / "verification.md").is_file()


def test_verify_run_determinism_snapshot(tmp_path: Path) -> None:
    tr = load_trust_root(FIXTURES / "ephemeral_test_trust_root.json")
    rdir = RUN_DIRS / "valid_h200_tp8_run"
    out1 = verify_run_directory(rdir, trust_root=tr, require_signature=True, out_dir=tmp_path / "r1")
    out2 = verify_run_directory(rdir, trust_root=tr, require_signature=True, out_dir=tmp_path / "r2")

    # Compare structural fields excluding wall-clock verified_at
    d1 = dict(out1.result_dict)
    d2 = dict(out2.result_dict)
    d1.pop("verified_at")
    d2.pop("verified_at")
    assert d1 == d2
    assert d1["provenance_summary"]["tp_size_verified"] == 8
    assert d1["provenance_summary"]["ranks_verified"] == [0, 1, 2, 3, 4, 5, 6, 7]
    assert d1["impact_summary"]["foreign_block_stopped_before_dispatch"] is True
    assert d1["impact_summary"]["allowed_after_fault_completed"] is True


def test_verify_run_rejects_escaping_symlink(tmp_path: Path) -> None:
    tr = load_trust_root(FIXTURES / "ephemeral_test_trust_root.json")
    copied_run = tmp_path / "symlink_run"
    shutil.copytree(RUN_DIRS / "valid_h200_tp8_run", copied_run)
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    os.symlink(outside, copied_run / "escape_link.txt")

    res = verify_run_directory(copied_run, trust_root=tr, require_signature=True, write_outputs=False)
    assert res.verdict == Verdict.FAIL
    assert "FAIL_RUN_DIR_AMBIGUOUS_FILE" in res.result_dict["reason_codes"]


def test_command_wrapper_records_sanitized_receipt(tmp_path: Path, monkeypatch) -> None:
    secret_env = "AIza" + "SySecretEnvValueShouldNeverAppearInReceipt123"
    monkeypatch.setenv("GEMINI_API_KEY", secret_env)
    monkeypatch.setenv("VLLM_ATTENTION_BACKEND", "FLASH_ATTN")

    target_file = tmp_path / "output.txt"
    target_file.write_text("hello", encoding="utf-8")
    rcpt_path = tmp_path / "receipts" / "commands" / "01_test.json"
    stdout_path = tmp_path / "logs" / "out.log"
    stderr_path = tmp_path / "logs" / "err.log"

    rcpt = run_wrapped_command(
        step_id="01_test",
        run_id="run-wrapper-test-01",
        receipt_out=rcpt_path,
        cmd=[sys.executable, "-c", "import sys; print('safe_stdout'); print('safe_stderr', file=sys.stderr)", "--api-key", "SECRET_ARG_99"],
        repo_dir=REPO_ROOT,
        run_dir=tmp_path,
        stdout_out=stdout_path,
        stderr_out=stderr_path,
        expected_files=[target_file],
    )
    assert rcpt["exit_code"] == 0
    assert rcpt["command"]["argv_sanitized"][-1] == "[REDACTED]"
    assert "GEMINI_API_KEY" in rcpt["environment"]["redacted_env_keys"]
    assert rcpt["environment"]["safe_env_vars"]["VLLM_ATTENTION_BACKEND"] == "FLASH_ATTN"
    raw_rcpt = rcpt_path.read_text(encoding="utf-8")
    assert secret_env not in raw_rcpt
    assert "SECRET_ARG_99" not in raw_rcpt
    assert validate_against_schema(rcpt, "command-receipt.v1.schema.json") == []
