#!/usr/bin/env python3
"""
Responsibility: Bounded command wrapper that executes a child command without a shell and
records an atomic, sanitized command-receipt.v1 JSON receipt (exact argv, exit code, UTC
timestamps, git SHA & pre/post dirty state, environment digest, stdout/stderr SHA-256,
and expected output file hashes).
Trust boundary: Never leaks raw environment secrets or flagged CLI secret arguments.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import uuid
from typing import Any

# Allow importing evidence_verifier from sibling package when uninstalled.
_REPO_ROOT = Path(__file__).resolve().parents[1]
_PKG_SRC = _REPO_ROOT / "packages" / "evidence-verifier" / "src"
if str(_PKG_SRC) not in sys.path:
    sys.path.insert(0, str(_PKG_SRC))

from evidence_verifier.sanitizer import SECRET_REGEX_RULES, sanitize_structure, sanitize_text  # noqa: E402
from evidence_verifier.strict_json import canonicalize_jcs, compute_command_receipt_sha256  # noqa: E402

SENSITIVE_ENV_KEY_RE = re.compile(
    r"(KEY|SECRET|TOKEN|PASS|AUTH|COOKIE|CREDENTIAL|PRIVATE|CERT|DSN|DATABASE_URL|CONNECTION_STRING)",
    re.IGNORECASE,
)
SAFE_ALLOWLISTED_ENV_KEYS = frozenset(
    {
        "ALLOW_LIVE_GEMINI",
        "CUDA_VISIBLE_DEVICES",
        "DEMO_MODE",
        "GEMINI_MODEL",
        "NCCL_DEBUG",
        "NODE_ENV",
        "OMP_NUM_THREADS",
        "PYTHONUNBUFFERED",
        "TORCH_COMPILE_DISABLE",
        "TRITON_CACHE_DIR",
        "VLLM_ATTENTION_BACKEND",
        "VLLM_USE_V1",
    }
)
DEFAULT_SECRET_FLAGS = frozenset({"--api-key", "--token", "--secret", "--password", "--signing-key"})


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _capture_git_state(repo_dir: Path) -> dict[str, Any]:
    def _run_git(args: list[str]) -> str | None:
        try:
            return subprocess.check_output(
                ["git", *args],
                cwd=str(repo_dir),
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=3,
            ).strip()
        except Exception:
            return None

    sha = _run_git(["rev-parse", "HEAD"])
    branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    porcelain = _run_git(["status", "--porcelain"])
    dirty = None if porcelain is None else (len(porcelain) > 0)
    count = None if porcelain is None else (0 if not porcelain else len(porcelain.splitlines()))
    return {
        "git_sha": sha if sha and len(sha) == 40 else None,
        "git_dirty": dirty,
        "dirty_entries_count": count,
        "branch": branch,
    }


def _sanitize_argv(argv: list[str], extra_flags: set[str]) -> tuple[list[str], list[int]]:
    secret_flags = DEFAULT_SECRET_FLAGS | extra_flags
    sanitized: list[str] = []
    redacted_indices: list[int] = []
    redact_next = False
    for idx, arg in enumerate(argv):
        if redact_next:
            sanitized.append("[REDACTED]")
            redacted_indices.append(idx)
            redact_next = False
            continue
        if "=" in arg:
            flag, val = arg.split("=", 1)
            if flag.lower() in secret_flags or any(p.search(val) for _, _, p in SECRET_REGEX_RULES):
                sanitized.append(f"{flag}=[REDACTED]")
                redacted_indices.append(idx)
                continue
        if arg.lower() in secret_flags:
            sanitized.append(arg)
            redact_next = True
            continue
        if any(p.search(arg) for _, _, p in SECRET_REGEX_RULES):
            sanitized.append("[REDACTED]")
            redacted_indices.append(idx)
            continue
        sanitized.append(arg)
    return sanitized, redacted_indices


def _build_environment_summary() -> dict[str, Any]:
    safe_env: dict[str, str] = {}
    redacted_keys: list[str] = []
    digest_lines = ["vervain.env.v1"]

    for k in sorted(os.environ.keys()):
        v = os.environ[k]
        # Aggregate digest binds exact key=value without exposing secrets.
        entry_hash = _sha256_bytes(f"{k}={v}".encode("utf-8"))
        digest_lines.append(f"{k}={entry_hash}")

        is_secret_key = bool(SENSITIVE_ENV_KEY_RE.search(k))
        is_secret_val = not sanitize_text(v, source_name="env").passed
        if is_secret_key or is_secret_val:
            redacted_keys.append(k)
        elif k in SAFE_ALLOWLISTED_ENV_KEYS or k.startswith("VLLM_"):
            safe_env[k] = v[:512]

    return {
        "safe_env_vars": safe_env,
        "redacted_env_keys": sorted(redacted_keys),
        "env_digest_sha256": _sha256_bytes("\n".join(digest_lines).encode("utf-8")),
    }


def run_wrapped_command(
    *,
    step_id: str,
    run_id: str,
    receipt_out: Path,
    cmd: list[str],
    repo_dir: Path | None = None,
    run_dir: Path | None = None,
    stdout_out: Path | None = None,
    stderr_out: Path | None = None,
    expected_files: list[Path] | None = None,
    redact_flags: set[str] | None = None,
    expected_nonzero_control: bool = False,
) -> dict[str, Any]:
    if not cmd:
        raise ValueError("Command argv cannot be empty.")

    cwd = Path.cwd().resolve()
    git_root = (repo_dir or cwd).resolve()
    git_before = _capture_git_state(git_root)
    env_summary = _build_environment_summary()
    argv_san, redacted_idx = _sanitize_argv(cmd, redact_flags or set())

    started_dt = datetime.now(timezone.utc)
    proc = subprocess.run(
        cmd,
        shell=False,
        capture_output=True,
        check=False,
    )
    finished_dt = datetime.now(timezone.utc)
    duration_ms = max(0.0, (finished_dt - started_dt).total_seconds() * 1000.0)
    git_after = _capture_git_state(git_root)

    if stdout_out is not None:
        stdout_out.parent.mkdir(parents=True, exist_ok=True)
        stdout_out.write_bytes(proc.stdout)
    if stderr_out is not None:
        stderr_out.parent.mkdir(parents=True, exist_ok=True)
        stderr_out.write_bytes(proc.stderr)

    run_root = run_dir.resolve() if run_dir is not None else None
    stdout_rel = (
        stdout_out.resolve().relative_to(run_root).as_posix()
        if (stdout_out is not None and run_root is not None and stdout_out.resolve().is_relative_to(run_root))
        else None
    )
    stderr_rel = (
        stderr_out.resolve().relative_to(run_root).as_posix()
        if (stderr_out is not None and run_root is not None and stderr_out.resolve().is_relative_to(run_root))
        else None
    )

    exp_entries: list[dict[str, Any]] = []
    for ef in expected_files or []:
        ef_res = ef.resolve()
        if ef_res.is_file():
            rel = ef_res.relative_to(run_root).as_posix() if (run_root and ef_res.is_relative_to(run_root)) else ef.name
            exp_entries.append(
                {
                    "relative_path": rel,
                    "sha256": _sha256_file(ef_res),
                    "size_bytes": ef_res.stat().st_size,
                    "present_exactly_once": True,
                }
            )

    exit_code = proc.returncode if proc.returncode >= 0 else 0
    signal_num = -proc.returncode if proc.returncode < 0 else None

    receipt: dict[str, Any] = {
        "schema_version": "command-receipt.v1",
        "receipt_id": f"rcpt-{step_id}-{uuid.uuid4().hex[:12]}",
        "run_id": run_id,
        "step_id": step_id,
        "command": {
            "executable": Path(cmd[0]).name,
            "argv_sanitized": argv_san,
            "argv_redacted_indices": redacted_idx,
            "working_dir_digest": _sha256_bytes(str(cwd).encode("utf-8")),
        },
        "exit_code": exit_code,
        "expected_nonzero_control": expected_nonzero_control,
        "signal": signal_num,
        "started_at": started_dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "finished_at": finished_dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "duration_ms": round(duration_ms, 3),
        "git": {
            "git_sha": git_before["git_sha"],
            "git_dirty_before": git_before["git_dirty"],
            "git_dirty_after": git_after["git_dirty"],
            "dirty_entries_count": git_after["dirty_entries_count"],
            "branch": git_before["branch"],
        },
        "environment": env_summary,
        "host_id_digest": _sha256_bytes(socket.gethostname().encode("utf-8")),
        "stdout_sha256": _sha256_bytes(proc.stdout),
        "stderr_sha256": _sha256_bytes(proc.stderr),
        "stdout_bytes": len(proc.stdout),
        "stderr_bytes": len(proc.stderr),
        "stdout_relpath": stdout_rel,
        "stderr_relpath": stderr_rel,
        "expected_files": exp_entries,
        "receipt_sha256": "0" * 64,
    }
    receipt["receipt_sha256"] = compute_command_receipt_sha256(receipt)

    san_res = sanitize_structure(receipt)
    if not san_res.passed:
        raise ValueError(f"Command receipt failed sanitization ({san_res.findings[0].reason_code}).")

    receipt_out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(receipt_out.parent), prefix=".rcpt_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(canonicalize_jcs(receipt) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_name, receipt_out)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)

    return receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Bounded command provenance wrapper for Vervain runs.")
    parser.add_argument("--step-id", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--receipt-out", type=Path, required=True)
    parser.add_argument("--repo-dir", type=Path, default=None)
    parser.add_argument("--run-dir", type=Path, default=None)
    parser.add_argument("--stdout-out", type=Path, default=None)
    parser.add_argument("--stderr-out", type=Path, default=None)
    parser.add_argument("--expected-file", type=Path, action="append", default=[])
    parser.add_argument("--redact-argv-flag", action="append", default=[])
    parser.add_argument("--expected-nonzero-control", action="store_true")
    parser.add_argument("cmd", nargs=argparse.REMAINDER)

    args = parser.parse_args(argv)
    cmd = list(args.cmd)
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        sys.stderr.write("Error: missing command after --\n")
        return 3

    receipt = run_wrapped_command(
        step_id=args.step_id,
        run_id=args.run_id,
        receipt_out=args.receipt_out,
        cmd=cmd,
        repo_dir=args.repo_dir,
        run_dir=args.run_dir,
        stdout_out=args.stdout_out,
        stderr_out=args.stderr_out,
        expected_files=args.expected_file,
        redact_flags=set(args.redact_argv_flag),
        expected_nonzero_control=args.expected_nonzero_control,
    )
    sys.stdout.write(canonicalize_jcs(receipt) + "\n")
    return 0 if (receipt["exit_code"] == 0 or args.expected_nonzero_control) else receipt["exit_code"]


if __name__ == "__main__":
    raise SystemExit(main())
