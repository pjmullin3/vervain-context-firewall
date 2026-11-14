"""
Responsibility: Safe deterministic renderer producing verifier-result.v1 JSON (`verification.json`)
and human-readable Markdown (`verification.md`) without protected content or overclaiming.
Trust boundary: Sanitizes every rendered output prior to emission; never echoes secret values.
"""

from __future__ import annotations

from datetime import datetime, timezone
import subprocess
from pathlib import Path
from typing import Any

from . import __version__
from .invariants import ArtifactVerificationReport, InvariantCheck
from .reason_codes import EXIT_CODE_BY_VERDICT, REASON_CODES, SEVERITY_RANK
from .sanitizer import sanitize_structure, sanitize_text
from .strict_json import canonicalize_jcs

CLAIM_BOUNDARY_TEXT = (
    "PASS means only that the supplied artifact (and run directory, when checked) satisfies "
    "this verifier's named invariants for the pinned configuration. It does not establish "
    "universal security, production readiness, compliance, certification, absence of all GPU "
    "reads outside instrumented boundaries, or absence of vulnerabilities."
)


def _get_verifier_git_sha() -> str:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=str(Path(__file__).resolve().parent),
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
        ).strip()
        if len(out) == 40:
            return out
    except Exception:
        pass
    return "0" * 40


def _pick_primary_reason_code(reason_codes: tuple[str, ...]) -> str:
    if not reason_codes:
        return "NV_STATUS_INCOMPLETE"
    ordered = sorted(
        reason_codes,
        key=lambda c: (
            SEVERITY_RANK.get(REASON_CODES[c].severity if c in REASON_CODES else "CRITICAL", 0),
            c,
        ),
    )
    return ordered[0]


def _redact_unsafe_text(val: str | None, *, forbidden_strings: list[str] | None = None) -> str | None:
    if val is None:
        return None
    res = sanitize_text(val, forbidden_strings=forbidden_strings)
    if res.passed:
        return val
    return f"[REDACTED_UNSAFE_TEXT:{res.findings[0].reason_code}]"


def _redact_unsafe_value(obj: Any, *, forbidden_strings: list[str] | None = None) -> Any:
    if isinstance(obj, str):
        return _redact_unsafe_text(obj, forbidden_strings=forbidden_strings)
    if isinstance(obj, list):
        return [_redact_unsafe_value(item, forbidden_strings=forbidden_strings) for item in obj]
    if isinstance(obj, dict):
        san_out: dict[str, Any] = {}
        for k, v in obj.items():
            # Keep safe metadata dicts sanitized by key/value before emission.
            key_san = sanitize_structure({k: "ok"}, forbidden_strings=forbidden_strings)
            safe_k = k if key_san.passed else f"redacted_key_{len(san_out)}"
            san_out[safe_k] = _redact_unsafe_value(v, forbidden_strings=forbidden_strings)
        return san_out
    return obj


def render_verifier_result_dict(
    report: ArtifactVerificationReport,
    *,
    target_type: str,
    target_path: str,
    extra_checks: list[InvariantCheck] | None = None,
    command_receipts_verified: int = 0,
    verified_at: str | None = None,
    forbidden_strings: list[str] | None = None,
) -> dict[str, Any]:
    """Builds a verifier-result.v1 dictionary and validates it through the sanitizer."""
    all_checks = list(report.checks)
    if extra_checks:
        all_checks.extend(extra_checks)

    all_checks_sorted = sorted(all_checks, key=lambda c: (c.invariant_id, c.check_id, c.reason_code))
    primary_code = _pick_primary_reason_code(report.reason_codes)

    prov = dict(report.provenance_summary) if report.provenance_summary is not None else None
    if prov is not None:
        prov["command_receipts_verified"] = command_receipts_verified
        prov = _redact_unsafe_value(prov, forbidden_strings=forbidden_strings)

    impact = _redact_unsafe_value(report.impact_summary, forbidden_strings=forbidden_strings)
    exclusions = [_redact_unsafe_text(x, forbidden_strings=forbidden_strings) or "[REDACTED]" for x in report.exclusions]
    safe_target_path = _redact_unsafe_text(target_path, forbidden_strings=forbidden_strings) or "[REDACTED]"
    safe_run_id = _redact_unsafe_text(report.run_id, forbidden_strings=forbidden_strings)

    limitations = [
        CLAIM_BOUNDARY_TEXT,
        "Controlled synthetic fault injection inside the named configuration; not a public stock-vLLM exploit.",
        "No provider-internal Gemini memory visibility or uninstrumented backend/connector claim.",
    ]

    payload: dict[str, Any] = {
        "schema_version": "verifier-result.v1",
        "verdict": report.verdict.value,
        "exit_code": EXIT_CODE_BY_VERDICT[report.verdict],
        "primary_reason_code": primary_code,
        "reason_codes": list(report.reason_codes),
        "target_type": target_type,
        "target_path": safe_target_path,
        "run_id": safe_run_id,
        "artifact_sha256_declared": _redact_unsafe_text(report.artifact_sha256_declared, forbidden_strings=forbidden_strings),
        "artifact_sha256_computed": report.artifact_sha256_computed,
        "claimed_evidence_status": _redact_unsafe_text(report.claimed_evidence_status, forbidden_strings=forbidden_strings),
        "verified_evidence_status": report.verified_evidence_status,
        "verifier": {
            "name": "vervain-evidence-verifier",
            "version": __version__,
            "git_sha": _get_verifier_git_sha(),
            "trust_root_required": report.signature_result.trust_root_required,
        },
        "checks": [
            {
                "check_id": c.check_id,
                "invariant_id": c.invariant_id,
                "status": c.status,
                "reason_code": c.reason_code,
                "summary": _redact_unsafe_text(c.summary, forbidden_strings=forbidden_strings) or "[REDACTED]",
                "evidence_refs": [
                    _redact_unsafe_text(ref, forbidden_strings=forbidden_strings) or "[REDACTED]"
                    for ref in c.evidence_refs
                ],
            }
            for c in all_checks_sorted
        ],
        "sanitizer_result": {
            "passed": report.sanitizer_result.passed,
            "rules_checked": report.sanitizer_result.rules_checked,
            "finding_count": report.sanitizer_result.finding_count,
            "findings": [
                {
                    "rule_id": f.rule_id,
                    "json_pointer": _redact_unsafe_text(f.json_pointer, forbidden_strings=forbidden_strings) or "[REDACTED]",
                    "reason_code": f.reason_code,
                    "redacted_preview": f.redacted_preview,
                }
                for f in report.sanitizer_result.findings
            ],
        },
        "signature_result": {
            "checked": report.signature_result.checked,
            "trust_root_required": report.signature_result.trust_root_required,
            "verified": report.signature_result.verified,
            "key_id": _redact_unsafe_text(report.signature_result.key_id, forbidden_strings=forbidden_strings),
            "reason_code": report.signature_result.reason_code,
        },
        "ui_summary_crosscheck": {
            "present": report.ui_present,
            "consistent": report.ui_consistent,
            "mismatched_fields": list(report.ui_mismatched_fields),
        },
        "provenance_summary": prov,
        "impact_summary": impact,
        "exclusions": exclusions,
        "claim_boundary": CLAIM_BOUNDARY_TEXT,
        "limitations": limitations,
        "verified_at": verified_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # Self-sanitize rendered output before returning so protected content never leaks out.
    out_san = sanitize_structure(payload, forbidden_strings=forbidden_strings)
    if not out_san.passed:
        raise ValueError(
            f"Rendered verifier result failed output sanitization ({out_san.findings[0].reason_code})."
        )
    return payload


def render_verification_markdown(result: dict[str, Any], *, forbidden_strings: list[str] | None = None) -> str:
    """Renders safe deterministic verification.md strictly from sanitized verifier-result.v1 fields."""
    prov = result.get("provenance_summary") or {}
    imp = result.get("impact_summary") or {}
    lines: list[str] = [
        f"# Vervain Independent Evidence Verification: {result['verdict']}",
        "",
        f"- **Verdict:** `{result['verdict']}` (exit `{result['exit_code']}`)",
        f"- **Primary Reason Code:** `{result['primary_reason_code']}`",
        f"- **Reason Codes:** {', '.join(f'`{c}`' for c in result['reason_codes'])}",
        f"- **Target:** `{result['target_type']}` (`{result['target_path']}`)",
        f"- **Run ID:** `{result.get('run_id')}`",
        f"- **Evidence Status (Claimed -> Verified):** `{result['claimed_evidence_status']}` -> `{result['verified_evidence_status']}`",
        f"- **Artifact SHA-256 (Computed):** `{result.get('artifact_sha256_computed')}`",
        f"- **Verified At (UTC):** `{result['verified_at']}`",
        "",
        "## Provenance & Runtime Binding",
        "",
        f"- **GPU:** `{prov.get('gpu_model')}` x `{prov.get('gpu_count')}` (TP `{prov.get('tp_size_verified')}`, ranks `{prov.get('ranks_verified')}`)",
        f"- **vLLM SHA:** `{prov.get('vllm_sha')}`",
        f"- **Patch SHA-256:** `{prov.get('patch_sha256')}`",
        f"- **Selected Runtime Backend:** `{prov.get('selected_runtime_backend')}`",
        f"- **Command Receipts Verified:** `{prov.get('command_receipts_verified')}`",
        f"- **Signature Verified:** `{result['signature_result']['verified']}` (`{result['signature_result']['reason_code']}`)",
        f"- **Sanitizer Passed:** `{result['sanitizer_result']['passed']}` (`findings={result['sanitizer_result']['finding_count']}`)",
        "",
        "## Scoped KV Firewall Impact Summary (Raw-Derived)",
        "",
        f"- **Foreign block stopped before dispatch (`vervain_fault_injected`):** `{imp.get('foreign_block_stopped_before_dispatch')}`",
        f"- **Native baseline fault entered dispatch (`native_fault_injected`):** `{imp.get('native_fault_entered_dispatch')}`",
        f"- **Clean equivalence within tolerance (`native_clean` vs `vervain_clean`):** `{imp.get('clean_equivalence_within_tolerance')}`",
        f"- **Permitted follow-up completed after violation:** `{imp.get('allowed_after_fault_completed')}`",
        f"- **TTFT Delta (%):** `{imp.get('ttft_delta_pct')}` (sample_count=`{imp.get('ttft_sample_count')}`)",
        "",
        "## Invariant Checks",
        "",
        "| Invariant | Check ID | Status | Reason Code | Summary |",
        "| :--- | :--- | :--- | :--- | :--- |",
    ]
    for chk in result["checks"]:
        summary_safe = str(chk["summary"]).replace("|", "\\|").replace("\n", " ")
        lines.append(
            f"| `{chk['invariant_id']}` | `{chk['check_id']}` | `{chk['status']}` | `{chk['reason_code']}` | {summary_safe} |"
        )
    lines.extend(["", "## Exclusions & Claim Boundary", ""])
    for ex in result.get("exclusions", []):
        lines.append(f"- {ex}")
    lines.extend(["", f"> **Claim Boundary:** {result['claim_boundary']}", ""])

    md = "\n".join(lines)
    md_san = sanitize_text(md, source_name="verification.md", forbidden_strings=forbidden_strings)
    if not md_san.passed:
        raise ValueError(
            f"Rendered verification.md failed output sanitization ({md_san.findings[0].reason_code})."
        )
    return md


def render_canonical_json(result: dict[str, Any]) -> str:
    return canonicalize_jcs(result)
