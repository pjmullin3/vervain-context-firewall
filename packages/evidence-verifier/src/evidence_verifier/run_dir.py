"""
Responsibility: Independent run-directory (`RUN_DIR`) provenance verifier (`verify-run`).
Reads only local regular files inside `RUN_DIR`, enforces exact-once presence and anti-shadowing,
hashes source/patch files on disk, validates command receipts, joins dispatch_spans/events logs
to request_ids, checks per-rank agreement, and emits sanitized verification.json & verification.md.
Trust boundary: Never allocates, starts, stops, or probes cluster/GPU resources.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
from pathlib import Path
import re
from typing import Any

from .crypto import TrustRoot, parse_utc_iso
from .invariants import ArtifactVerificationReport, InvariantCheck, verify_artifact_data
from .reason_codes import Verdict, compute_verdict
from .renderer import render_verification_markdown, render_verifier_result_dict
from .sanitizer import sanitize_structure, sanitize_text
from .schema_validator import validate_against_schema
from .strict_json import (
    StrictJsonError,
    canonicalize_jcs,
    compute_command_receipt_sha256,
    parse_strict_json_bytes,
)

MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_PATCH_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True)
class RunDirVerificationOutput:
    result_dict: dict[str, Any]
    markdown_text: str
    verdict: Verdict


def _sha256_file(path: Path, max_bytes: int = MAX_JSON_BYTES) -> str:
    size = path.stat().st_size
    if size > max_bytes:
        raise ValueError(f"File {path.name} exceeds max size {max_bytes} bytes.")
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _ensure_safe_regular_file(path: Path, run_root: Path, *, max_bytes: int = MAX_JSON_BYTES) -> None:
    if "\x00" in str(path):
        raise ValueError("Null byte in path.")
    if path.is_symlink():
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(run_root):
            raise ValueError(f"Symlink escapes RUN_DIR: {path.name}")
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(run_root):
        raise ValueError(f"Path escapes RUN_DIR: {path.name}")
    if not resolved.is_file():
        raise ValueError(f"Non-regular file in RUN_DIR: {path.name}")
    if resolved.stat().st_size > max_bytes:
        raise ValueError(f"File exceeds size limit: {path.name}")


def _detect_shadow_files(run_root: Path) -> list[str]:
    """Detects near-duplicate or backup shadow files that create evidence ambiguity."""
    shadows: list[str] = []
    singleton_patterns = (
        re.compile(r"^artifact.*\.json$", re.IGNORECASE),
        re.compile(r"^manifest.*\.json$", re.IGNORECASE),
        re.compile(r"^dispatch_spans.*\.jsonl$", re.IGNORECASE),
        re.compile(r"^events.*\.jsonl$", re.IGNORECASE),
    )
    for item in run_root.rglob("*"):
        if not item.is_file() and not item.is_symlink():
            continue
        rel = item.relative_to(run_root).as_posix()
        name = item.name
        if name in ("verification.json", "verification.md"):
            continue
        if any(name.endswith(suf) for suf in (".bak", ".orig", ".tmp", ".copy")) or " (" in name:
            shadows.append(rel)
            continue
        if rel.count("/") == 0:
            if singleton_patterns[0].match(name) and name != "artifact.json":
                shadows.append(rel)
            elif singleton_patterns[1].match(name) and name != "manifest.json":
                shadows.append(rel)
        elif rel.startswith("logs/"):
            if singleton_patterns[2].match(name) and name != "dispatch_spans.jsonl":
                shadows.append(rel)
            elif singleton_patterns[3].match(name) and name != "events.jsonl":
                shadows.append(rel)
    return sorted(set(shadows))


def verify_run_directory(
    run_dir: Path,
    *,
    trust_root: TrustRoot | None = None,
    require_signature: bool = False,
    seen_run_ids_path: Path | None = None,
    forbidden_strings: list[str] | None = None,
    out_dir: Path | None = None,
    write_outputs: bool = True,
) -> RunDirVerificationOutput:
    """Independently verifies a local RUN_DIR and writes verification.json + verification.md."""
    run_root = run_dir.resolve(strict=True)
    if not run_root.is_dir():
        raise FileNotFoundError(f"RUN_DIR is not a directory: {run_dir}")

    extra_checks: list[InvariantCheck] = []
    extra_codes: list[str] = []

    def add_extra(check_id: str, inv_id: str, status: str, code: str, summary: str, refs: tuple[str, ...] = ()) -> None:
        extra_checks.append(InvariantCheck(check_id, inv_id, status, code, summary, refs))
        if status in ("fail", "no_verdict"):
            extra_codes.append(code)

    # 1. File hygiene & anti-shadowing check.
    for candidate in sorted(run_root.rglob("*")):
        rel = candidate.relative_to(run_root).as_posix()
        if candidate.is_dir():
            continue
        try:
            _ensure_safe_regular_file(candidate, run_root)
        except ValueError as exc:
            add_extra("rundir.file_hygiene", "RUN", "fail", "FAIL_RUN_DIR_AMBIGUOUS_FILE", str(exc), (rel,))

    shadows = _detect_shadow_files(run_root)
    if shadows:
        add_extra(
            "rundir.shadow_files",
            "RUN",
            "fail",
            "FAIL_RUN_DIR_AMBIGUOUS_FILE",
            f"Shadow or duplicate files detected in RUN_DIR: {', '.join(shadows)}.",
            tuple(shadows),
        )

    # 2. Load artifact.json (required exact-once).
    artifact_path = run_root / "artifact.json"
    if not artifact_path.exists():
        add_extra("rundir.artifact_missing", "RUN", "no_verdict", "NV_MISSING_JOIN_EVIDENCE", "Missing artifact.json in RUN_DIR.", ("artifact.json",))
        empty_rep = verify_artifact_data(
            {},
            trust_root=trust_root,
            require_signature=require_signature,
            forbidden_strings=forbidden_strings,
        )
        merged_codes = tuple(sorted(set(extra_codes) | {"NV_MISSING_JOIN_EVIDENCE"}))
        verdict = compute_verdict(list(merged_codes))
        rep = ArtifactVerificationReport(
            verdict=verdict,
            reason_codes=merged_codes,
            run_id=None,
            artifact_sha256_declared=None,
            artifact_sha256_computed=None,
            claimed_evidence_status="unknown",
            verified_evidence_status="unverified",
            checks=(),
            sanitizer_result=empty_rep.sanitizer_result,
            signature_result=empty_rep.signature_result,
            ui_present=False,
            ui_consistent=True,
            ui_mismatched_fields=(),
            provenance_summary=None,
            impact_summary=None,
            exclusions=(),
        )
        res_dict = render_verifier_result_dict(
            rep,
            target_type="run_dir",
            target_path=str(run_root),
            extra_checks=extra_checks,
            forbidden_strings=forbidden_strings,
        )
        md_text = render_verification_markdown(res_dict, forbidden_strings=forbidden_strings)
        return RunDirVerificationOutput(res_dict, md_text, verdict)

    # Detached signature if present
    detached_sig: dict[str, Any] | None = None
    sig_path = run_root / "artifact.sig"
    if sig_path.exists():
        try:
            sig_parsed = parse_strict_json_bytes(sig_path.read_bytes())
            if isinstance(sig_parsed, dict):
                detached_sig = sig_parsed
            else:
                add_extra("rundir.sig_parse", "J2", "fail", "FAIL_SIG_INVALID", "artifact.sig must be JSON object.", ("artifact.sig",))
        except StrictJsonError as exc:
            add_extra("rundir.sig_parse", "J2", "fail", exc.reason_code, f"artifact.sig parse failed: {exc.message}", ("artifact.sig",))

    # Optional RUN_DIR-local trust_root.json ONLY if explicit trust_root wasn't supplied?
    # Security rule: NEVER automatically trust a trust_root.json inside the untrusted RUN_DIR unless caller passed --trust-root!

    try:
        artifact_data = parse_strict_json_bytes(artifact_path.read_bytes())
    except StrictJsonError as exc:
        add_extra("rundir.artifact_parse", "PARSE", "fail", exc.reason_code, f"artifact.json parse error: {exc.message}", ("artifact.json",))
        artifact_data = {}

    base_report = verify_artifact_data(
        artifact_data,
        trust_root=trust_root,
        require_signature=require_signature,
        seen_run_ids_path=seen_run_ids_path,
        forbidden_strings=forbidden_strings,
        detached_signature=detached_sig,
    )

    art = artifact_data if isinstance(artifact_data, dict) else {}
    run_id = base_report.run_id
    is_gpu_claimed = base_report.claimed_evidence_status in ("live", "recorded")
    source = art.get("source") if isinstance(art.get("source"), dict) else {}
    manifest_art = art.get("runtime_manifest") if isinstance(art.get("runtime_manifest"), dict) else {}
    tp_size = manifest_art.get("tp_size") if isinstance(manifest_art.get("tp_size"), int) else 1

    # 3. Manifest check.
    manifest_path = run_root / "manifest.json"
    if not manifest_path.exists():
        add_extra(
            "rundir.manifest_missing",
            "J3",
            "fail" if is_gpu_claimed else "no_verdict",
            "FAIL_GPU_MANIFEST_CONTRADICTION" if is_gpu_claimed else "NV_MISSING_GPU_MANIFEST",
            "Missing manifest.json in RUN_DIR.",
            ("manifest.json",),
        )
    else:
        try:
            m_parsed = parse_strict_json_bytes(manifest_path.read_bytes())
            m_san = sanitize_structure(m_parsed, forbidden_strings=forbidden_strings)
            if not m_san.passed:
                for f in m_san.findings:
                    add_extra(f"rundir.manifest_san.{f.rule_id}", "SANITIZE", "fail", f.reason_code, f"manifest.json sanitizer hit at {f.json_pointer}.", ("manifest.json",))
            m_errs = validate_against_schema(m_parsed, "run-manifest.v1.schema.json")
            if m_errs:
                add_extra("rundir.manifest_schema", "J1", "fail", "FAIL_SCHEMA_INVALID", f"manifest.json schema invalid: {m_errs[0].message}", ("manifest.json",))
            if isinstance(m_parsed, dict):
                if m_parsed.get("run_id") != run_id:
                    add_extra("rundir.manifest_run_id", "J4", "fail", "FAIL_RUN_ID_MISMATCH", "manifest.json run_id differs from artifact.json.", ("manifest.json",))
                if m_parsed.get("evidence_status") != base_report.claimed_evidence_status:
                    add_extra("rundir.manifest_status", "J3", "fail", "FAIL_STATUS_LAUNDERING", "manifest.json evidence_status differs from artifact.json.", ("manifest.json",))
                if m_parsed.get("selected_runtime_backend") != manifest_art.get("selected_runtime_backend"):
                    add_extra("rundir.manifest_backend", "J6", "fail", "FAIL_BACKEND_INTENT_MISMATCH", "manifest.json selected_runtime_backend differs from artifact.", ("manifest.json",))
                if (
                    m_parsed.get("gpu_model") != manifest_art.get("gpu_model")
                    or m_parsed.get("gpu_count") != manifest_art.get("gpu_count")
                    or m_parsed.get("tp_size") != manifest_art.get("tp_size")
                    or m_parsed.get("gpu_uuids_sha256") != manifest_art.get("gpu_uuids_sha256")
                ):
                    add_extra("rundir.manifest_gpu", "J3", "fail", "FAIL_GPU_MANIFEST_CONTRADICTION", "manifest.json GPU/TP hardware differs from artifact.runtime_manifest.", ("manifest.json",))
                msrc = m_parsed.get("source") if isinstance(m_parsed.get("source"), dict) else {}
                if msrc.get("vllm_sha") != source.get("vllm_sha") or msrc.get("patch_sha256") != source.get("patch_sha256"):
                    add_extra("rundir.manifest_source", "J5", "fail", "FAIL_PATCH_DIGEST_MISMATCH", "manifest.json source SHA/patch differs from artifact.", ("manifest.json",))
                if msrc.get("git_dirty") != source.get("git_dirty"):
                    add_extra("rundir.manifest_dirty", "J5", "fail", "FAIL_DIRTY_STATE_HIDDEN", "manifest.json git_dirty contradicts artifact.source.git_dirty.", ("manifest.json",))

                # Expected files exact-once presence check
                for exp_rel in m_parsed.get("expected_files", []):
                    if isinstance(exp_rel, str):
                        target_f = run_root / exp_rel
                        if not target_f.exists():
                            add_extra(
                                f"rundir.expected_missing.{exp_rel}",
                                "RUN",
                                "fail" if is_gpu_claimed else "no_verdict",
                                "FAIL_MISSING_REQUIRED_JOIN" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
                                f"Expected file {exp_rel!r} declared in manifest.json is missing.",
                                (exp_rel,),
                            )
        except StrictJsonError as exc:
            add_extra("rundir.manifest_parse", "PARSE", "fail", exc.reason_code, f"manifest.json parse error: {exc.message}", ("manifest.json",))

    # 4. Independent source & patch file hashing.
    patch_disk = run_root / "sources" / "vllm.patch"
    if isinstance(source.get("patch_sha256"), str):
        if not patch_disk.exists():
            add_extra(
                "rundir.patch_missing",
                "J5",
                "fail" if is_gpu_claimed else "no_verdict",
                "FAIL_PATCH_DIGEST_MISMATCH" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
                "sources/vllm.patch missing from RUN_DIR.",
                ("sources/vllm.patch",),
            )
        else:
            actual_patch_sha = _sha256_file(patch_disk, max_bytes=MAX_PATCH_BYTES)
            if not hmac.compare_digest(actual_patch_sha, source["patch_sha256"]):
                add_extra(
                    "rundir.patch_hash",
                    "J5",
                    "fail",
                    "FAIL_PATCH_DIGEST_MISMATCH",
                    "SHA-256 of sources/vllm.patch on disk does not match artifact.source.patch_sha256.",
                    ("sources/vllm.patch",),
                )
            else:
                add_extra("rundir.patch_hash", "J5", "pass", "PASS_VERIFIED", "Independent SHA-256 of sources/vllm.patch matched.", ("sources/vllm.patch",))

    source_hashes_path = run_root / "sources" / "source_hashes.json"
    if source_hashes_path.exists():
        try:
            sh_map = parse_strict_json_bytes(source_hashes_path.read_bytes())
            if isinstance(sh_map, dict):
                for rel_s, exp_hash in sh_map.items():
                    cand = run_root / "sources" / "tracked" / rel_s
                    if not cand.exists():
                        add_extra(f"rundir.src_missing.{rel_s}", "J5", "fail", "FAIL_PATCH_DIGEST_MISMATCH", f"Tracked source {rel_s} missing.", (f"sources/tracked/{rel_s}",))
                    elif not isinstance(exp_hash, str) or not hmac.compare_digest(_sha256_file(cand), exp_hash):
                        add_extra(f"rundir.src_hash.{rel_s}", "J5", "fail", "FAIL_PATCH_DIGEST_MISMATCH", f"Tracked source {rel_s} SHA-256 mismatch.", (f"sources/tracked/{rel_s}",))
                # Also cross-check loaded_modules against source_hashes.json if matching basename/path
                for mod in source.get("loaded_modules", []):
                    if isinstance(mod, dict):
                        fp = mod.get("file_path")
                        fsha = mod.get("file_sha256")
                        if isinstance(fp, str) and fp in sh_map and sh_map[fp] != fsha:
                            add_extra(f"rundir.mod_hash.{fp}", "J5", "fail", "FAIL_PATCH_DIGEST_MISMATCH", f"loaded_module {fp} hash differs from source_hashes.json.", ("sources/source_hashes.json",))
        except StrictJsonError as exc:
            add_extra("rundir.src_hashes_parse", "PARSE", "fail", exc.reason_code, f"source_hashes.json error: {exc.message}", ("sources/source_hashes.json",))
    elif is_gpu_claimed:
        add_extra("rundir.src_hashes_missing", "J5", "fail", "FAIL_PATCH_DIGEST_MISMATCH", "sources/source_hashes.json missing on live/recorded run.", ("sources/source_hashes.json",))

    # 5. Command receipts verification.
    receipts_dir = run_root / "receipts" / "commands"
    receipt_files = sorted(receipts_dir.glob("*.json")) if receipts_dir.is_dir() else []
    receipts_verified_count = 0
    if not receipt_files:
        add_extra(
            "rundir.receipts_missing",
            "RUN",
            "fail" if is_gpu_claimed else "no_verdict",
            "FAIL_COMMAND_RECEIPT_INVALID" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
            "No command receipts found under receipts/commands/.",
            ("receipts/commands",),
        )
    else:
        seen_step_ids: set[str] = set()
        for rpath in receipt_files:
            rel_r = rpath.relative_to(run_root).as_posix()
            try:
                rdata = parse_strict_json_bytes(rpath.read_bytes())
                rsan = sanitize_structure(rdata, forbidden_strings=forbidden_strings)
                if not rsan.passed:
                    for f in rsan.findings:
                        add_extra(f"rundir.receipt_san.{rpath.name}.{f.rule_id}", "SANITIZE", "fail", f.reason_code, f"Command receipt {rel_r} failed sanitization.", (rel_r,))
                rerrs = validate_against_schema(rdata, "command-receipt.v1.schema.json")
                if rerrs:
                    add_extra(f"rundir.receipt_schema.{rpath.name}", "RUN", "fail", "FAIL_COMMAND_RECEIPT_INVALID", f"{rel_r} invalid schema: {rerrs[0].message}", (rel_r,))
                    continue
                assert isinstance(rdata, dict)
                expected_rsha = compute_command_receipt_sha256(rdata)
                if not hmac.compare_digest(str(rdata.get("receipt_sha256", "")), expected_rsha):
                    add_extra(f"rundir.receipt_digest.{rpath.name}", "RUN", "fail", "FAIL_COMMAND_RECEIPT_INVALID", f"{rel_r} receipt_sha256 mismatch.", (rel_r,))
                    continue
                step_id = str(rdata["step_id"])
                if step_id in seen_step_ids:
                    add_extra(f"rundir.receipt_dup.{step_id}", "RUN", "fail", "FAIL_RUN_DIR_AMBIGUOUS_FILE", f"Duplicate command receipt step_id {step_id!r}.", (rel_r,))
                    continue
                seen_step_ids.add(step_id)
                if rdata.get("run_id") != run_id:
                    add_extra(f"rundir.receipt_run_id.{step_id}", "J4", "fail", "FAIL_RUN_ID_MISMATCH", f"{rel_r} run_id mismatch.", (rel_r,))
                if rdata["exit_code"] != 0 and not rdata.get("expected_nonzero_control", False):
                    add_extra(f"rundir.receipt_exit.{step_id}", "RUN", "fail", "FAIL_COMMAND_RECEIPT_INVALID", f"{rel_r} exited with code {rdata['exit_code']}.", (rel_r,))
                git_info = rdata["git"]
                if git_info.get("git_sha") and source.get("git_sha") and git_info["git_sha"] != source["git_sha"]:
                    add_extra(f"rundir.receipt_git.{step_id}", "J5", "fail", "FAIL_PATCH_DIGEST_MISMATCH", f"{rel_r} git_sha differs from artifact.source.git_sha.", (rel_r,))
                try:
                    st = parse_utc_iso(rdata["started_at"])
                    fn = parse_utc_iso(rdata["finished_at"])
                    if fn < st:
                        add_extra(f"rundir.receipt_time.{step_id}", "J4", "fail", "FAIL_TIMESTAMP_REVERSED", f"{rel_r} finished_at < started_at.", (rel_r,))
                except ValueError:
                    add_extra(f"rundir.receipt_time.{step_id}", "J4", "fail", "FAIL_TIMESTAMP_REVERSED", f"{rel_r} invalid timestamps.", (rel_r,))

                for stdio_key, sha_key in (("stdout_relpath", "stdout_sha256"), ("stderr_relpath", "stderr_sha256")):
                    rel_io = rdata.get(stdio_key)
                    if isinstance(rel_io, str):
                        io_path = run_root / rel_io
                        if not io_path.exists():
                            add_extra(f"rundir.receipt_io_missing.{step_id}.{stdio_key}", "RUN", "fail", "FAIL_COMMAND_RECEIPT_INVALID", f"Referenced {rel_io} missing.", (rel_io,))
                        else:
                            io_san = sanitize_text(io_path.read_text(encoding="utf-8", errors="replace"), source_name=rel_io, forbidden_strings=forbidden_strings)
                            if not io_san.passed:
                                add_extra(f"rundir.receipt_io_san.{step_id}", "SANITIZE", "fail", io_san.findings[0].reason_code, f"{rel_io} failed sanitization.", (rel_io,))
                            if not hmac.compare_digest(_sha256_file(io_path), rdata[sha_key]):
                                add_extra(f"rundir.receipt_io_sha.{step_id}.{stdio_key}", "RUN", "fail", "FAIL_COMMAND_RECEIPT_INVALID", f"{rel_io} SHA-256 differs from {sha_key}.", (rel_io,))
                receipts_verified_count += 1
            except StrictJsonError as exc:
                add_extra(f"rundir.receipt_parse.{rpath.name}", "PARSE", "fail", exc.reason_code, f"{rel_r} parse error: {exc.message}", (rel_r,))

    # 6. Dispatch spans & events JSONL log joining.
    spans_path = run_root / "logs" / "dispatch_spans.jsonl"
    if not spans_path.exists():
        add_extra(
            "rundir.spans_missing",
            "J11",
            "fail" if is_gpu_claimed else "no_verdict",
            "FAIL_MISSING_REQUIRED_JOIN" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
            "Missing logs/dispatch_spans.jsonl in RUN_DIR.",
            ("logs/dispatch_spans.jsonl",),
        )
    else:
        raw_spans_text = spans_path.read_text(encoding="utf-8", errors="strict")
        sp_san = sanitize_text(raw_spans_text, source_name="logs/dispatch_spans.jsonl", forbidden_strings=forbidden_strings)
        if not sp_san.passed:
            add_extra("rundir.spans_san", "SANITIZE", "fail", sp_san.findings[0].reason_code, "dispatch_spans.jsonl failed sanitization.", ("logs/dispatch_spans.jsonl",))
        disk_spans: list[dict[str, Any]] = []
        for lno, line in enumerate(raw_spans_text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                obj = parse_strict_json_bytes(line.encode("utf-8"))
                if not isinstance(obj, dict):
                    add_extra(f"rundir.spans_type.{lno}", "J11", "fail", "FAIL_SCHEMA_INVALID", f"dispatch_spans line {lno} not an object.", ("logs/dispatch_spans.jsonl",))
                    continue
                if obj.get("run_id") != run_id:
                    add_extra(f"rundir.spans_run_id.{lno}", "J4", "fail", "FAIL_RUN_ID_MISMATCH", f"dispatch_spans line {lno} run_id mismatch.", ("logs/dispatch_spans.jsonl",))
                disk_spans.append(obj)
            except StrictJsonError as exc:
                add_extra(f"rundir.spans_parse.{lno}", "PARSE", "fail", exc.reason_code, f"dispatch_spans line {lno}: {exc.message}", ("logs/dispatch_spans.jsonl",))

        # Reconcile disk spans against artifact.backend_dispatch by (span_id, request_id, rank_id)
        art_spans = {
            (sp.get("span_id"), sp.get("request_id"), sp.get("rank_id")): sp
            for sp in art.get("backend_dispatch", [])
            if isinstance(sp, dict)
        }
        for ds in disk_spans:
            key = (ds.get("span_id"), ds.get("request_id"), ds.get("rank_id"))
            if key not in art_spans:
                add_extra("rundir.spans_unmatched", "J11", "fail", "FAIL_MISSING_REQUIRED_JOIN", f"Disk dispatch span {key} missing from artifact.backend_dispatch.", ("logs/dispatch_spans.jsonl",))
            else:
                asp = art_spans[key]
                if (
                    ds.get("entered_attention_dispatch") != asp.get("entered_attention_dispatch")
                    or ds.get("blocked_before_dispatch") != asp.get("blocked_before_dispatch")
                    or ds.get("selected_backend") != asp.get("selected_backend")
                ):
                    add_extra("rundir.spans_contradict", "J11", "fail", "FAIL_VIOLATION_ENTERED_DISPATCH", f"Disk dispatch span {key} contradicts artifact.backend_dispatch.", ("logs/dispatch_spans.jsonl",))

    events_path = run_root / "logs" / "events.jsonl"
    if not events_path.exists():
        add_extra(
            "rundir.events_missing",
            "J15",
            "fail" if is_gpu_claimed else "no_verdict",
            "FAIL_MISSING_REQUIRED_JOIN" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
            "Missing logs/events.jsonl in RUN_DIR.",
            ("logs/events.jsonl",),
        )
    else:
        ev_text = events_path.read_text(encoding="utf-8", errors="strict")
        ev_san = sanitize_text(ev_text, source_name="logs/events.jsonl", forbidden_strings=forbidden_strings)
        if not ev_san.passed:
            add_extra("rundir.events_san", "SANITIZE", "fail", ev_san.findings[0].reason_code, "events.jsonl failed sanitization.", ("logs/events.jsonl",))
        for lno, line in enumerate(ev_text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                obj = parse_strict_json_bytes(line.encode("utf-8"))
                if isinstance(obj, dict) and obj.get("run_id") != run_id:
                    add_extra(f"rundir.events_run_id.{lno}", "J4", "fail", "FAIL_RUN_ID_MISMATCH", f"events.jsonl line {lno} run_id mismatch.", ("logs/events.jsonl",))
            except StrictJsonError as exc:
                add_extra(f"rundir.events_parse.{lno}", "PARSE", "fail", exc.reason_code, f"events.jsonl line {lno}: {exc.message}", ("logs/events.jsonl",))

    # 7. Per-rank file checks (TP1 / TP2 / TP8).
    ranks_dir = run_root / "ranks"
    rank_files = sorted(ranks_dir.glob("rank_*.json")) if ranks_dir.is_dir() else []
    seen_disk_ranks: set[int] = set()
    for rf in rank_files:
        rel_rf = rf.relative_to(run_root).as_posix()
        try:
            rdata = parse_strict_json_bytes(rf.read_bytes())
            rsan = sanitize_structure(rdata, forbidden_strings=forbidden_strings)
            if not rsan.passed:
                add_extra(f"rundir.rank_san.{rf.name}", "SANITIZE", "fail", rsan.findings[0].reason_code, f"{rel_rf} failed sanitization.", (rel_rf,))
            if isinstance(rdata, dict):
                rk = rdata.get("rank_id")
                if not isinstance(rk, int) or rk in seen_disk_ranks:
                    add_extra(f"rundir.rank_dup.{rf.name}", "J12", "fail", "FAIL_TP_DUPLICATE_RANK", f"Invalid or duplicate rank_id in {rel_rf}.", (rel_rf,))
                else:
                    seen_disk_ranks.add(rk)
                if rdata.get("run_id") != run_id:
                    add_extra(f"rundir.rank_run_id.{rf.name}", "J4", "fail", "FAIL_RUN_ID_MISMATCH", f"{rel_rf} run_id mismatch.", (rel_rf,))
                if rdata.get("loaded_patch_sha256") != source.get("patch_sha256"):
                    add_extra(f"rundir.rank_patch.{rf.name}", "J5", "fail", "FAIL_PATCH_DIGEST_MISMATCH", f"{rel_rf} loaded_patch_sha256 mismatch.", (rel_rf,))
                if rdata.get("selected_runtime_backend") != manifest_art.get("selected_runtime_backend"):
                    add_extra(f"rundir.rank_backend.{rf.name}", "J6", "fail", "FAIL_BACKEND_INTENT_MISMATCH", f"{rel_rf} selected_runtime_backend mismatch.", (rel_rf,))
        except StrictJsonError as exc:
            add_extra(f"rundir.rank_parse.{rf.name}", "PARSE", "fail", exc.reason_code, f"{rel_rf}: {exc.message}", (rel_rf,))

    expected_ranks = set(range(tp_size))
    if seen_disk_ranks != expected_ranks:
        add_extra(
            "rundir.ranks_complete",
            "J12",
            "fail" if is_gpu_claimed else "no_verdict",
            "FAIL_TP_RANK_COUNT_MISMATCH" if is_gpu_claimed else "NV_TP_RANK_EVIDENCE_MISSING",
            f"RUN_DIR ranks/ contains {sorted(seen_disk_ranks)}, expected {sorted(expected_ranks)}.",
            ("ranks",),
        )

    # Combine base artifact report with RUN_DIR checks.
    all_reason_codes = list(base_report.reason_codes) if base_report.verdict != Verdict.PASS else []
    all_reason_codes.extend(extra_codes)
    combined_verdict = compute_verdict(all_reason_codes) if all_reason_codes else Verdict.PASS
    final_codes = ("PASS_VERIFIED",) if combined_verdict == Verdict.PASS else tuple(sorted(set(all_reason_codes)))
    verified_status = (
        base_report.claimed_evidence_status
        if combined_verdict == Verdict.PASS
        else (base_report.claimed_evidence_status if base_report.claimed_evidence_status in ("local_only", "incomplete") else "unverified")
    )

    combined_report = ArtifactVerificationReport(
        verdict=combined_verdict,
        reason_codes=final_codes,
        run_id=base_report.run_id,
        artifact_sha256_declared=base_report.artifact_sha256_declared,
        artifact_sha256_computed=base_report.artifact_sha256_computed,
        claimed_evidence_status=base_report.claimed_evidence_status,
        verified_evidence_status=verified_status,
        checks=base_report.checks,
        sanitizer_result=base_report.sanitizer_result,
        signature_result=base_report.signature_result,
        ui_present=base_report.ui_present,
        ui_consistent=base_report.ui_consistent,
        ui_mismatched_fields=base_report.ui_mismatched_fields,
        provenance_summary=base_report.provenance_summary,
        impact_summary=base_report.impact_summary,
        exclusions=base_report.exclusions,
    )

    result_dict = render_verifier_result_dict(
        combined_report,
        target_type="run_dir",
        target_path=str(run_root),
        extra_checks=extra_checks,
        command_receipts_verified=receipts_verified_count,
        forbidden_strings=forbidden_strings,
    )
    md_text = render_verification_markdown(result_dict, forbidden_strings=forbidden_strings)

    if write_outputs:
        dest_dir = out_dir.resolve() if out_dir is not None else run_root
        dest_dir.mkdir(parents=True, exist_ok=True)
        (dest_dir / "verification.json").write_text(canonicalize_jcs(result_dict) + "\n", encoding="utf-8")
        (dest_dir / "verification.md").write_text(md_text, encoding="utf-8")

    return RunDirVerificationOutput(result_dict=result_dict, markdown_text=md_text, verdict=combined_verdict)
