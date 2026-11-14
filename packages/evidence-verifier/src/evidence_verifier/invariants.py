"""
Responsibility: Evaluates all cross-field invariants, relational ID joins, KV block generation
monotonicity, TP rank completeness/agreement, runtime backend binding, equivalence, performance
denominators, exclusions, and UI summary non-trust cross-checks on inference-proof.v1 artifacts.
Trust boundary: Never infers higher status; missing evidence -> NO VERDICT, contradiction -> FAIL.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hmac
import math
import re
from typing import Any

from .crypto import (
    SignatureCheckResult,
    TrustRoot,
    check_seen_run_ids,
    parse_utc_iso,
    verify_artifact_signature,
)
from .reason_codes import Verdict, compute_verdict
from .sanitizer import SanitizerResult, sanitize_structure
from .schema_validator import SUPPORTED_INFERENCE_PROOF_VERSION, validate_against_schema
from .strict_json import compute_artifact_sha256

CLOCK_SKEW_TOLERANCE = timedelta(seconds=300)
MIN_P95_SAMPLES = 20
PLACEHOLDER_STRINGS = frozenset(
    {"tbd", "n/a", "na", "none_recorded", "placeholder", "dummy", "no gpu run recorded", "unknown"}
)
EXPECTED_ARMS = (
    "native_clean",
    "native_fault_injected",
    "vervain_clean",
    "vervain_fault_injected",
    "vervain_allowed_after_fault",
)
ZERO_HASH_64 = "0" * 64
ZERO_SHA1_40 = "0" * 40


@dataclass(frozen=True)
class InvariantCheck:
    check_id: str
    invariant_id: str
    status: str  # pass | fail | no_verdict | skipped
    reason_code: str
    summary: str
    evidence_refs: tuple[str, ...]


@dataclass(frozen=True)
class ArtifactVerificationReport:
    verdict: Verdict
    reason_codes: tuple[str, ...]
    run_id: str | None
    artifact_sha256_declared: str | None
    artifact_sha256_computed: str | None
    claimed_evidence_status: str
    verified_evidence_status: str
    checks: tuple[InvariantCheck, ...]
    sanitizer_result: SanitizerResult
    signature_result: SignatureCheckResult
    ui_present: bool
    ui_consistent: bool
    ui_mismatched_fields: tuple[str, ...]
    provenance_summary: dict[str, Any] | None
    impact_summary: dict[str, Any] | None
    exclusions: tuple[str, ...]


def _is_placeholder_str(val: Any) -> bool:
    if not isinstance(val, str):
        return False
    low = val.strip().lower()
    if low in PLACEHOLDER_STRINGS:
        return True
    if "no gpu run recorded" in low:
        return True
    if re.fullmatch(r"0{16,64}", low):
        return True
    return False


def _is_finite_num(val: Any) -> bool:
    return isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(float(val))


def verify_artifact_data(
    artifact: Any,
    *,
    trust_root: TrustRoot | None = None,
    require_signature: bool = False,
    seen_run_ids_path: Any = None,
    forbidden_strings: list[str] | None = None,
    now_utc: datetime | None = None,
    detached_signature: dict[str, Any] | None = None,
) -> ArtifactVerificationReport:
    """Runs sanitizer, schema, canonical digest, signature, and all cross-field invariants."""
    checks: list[InvariantCheck] = []
    reason_codes: list[str] = []
    now = now_utc or datetime.now(timezone.utc)

    def add_check(
        check_id: str,
        invariant_id: str,
        status: str,
        reason_code: str,
        summary: str,
        refs: tuple[str, ...] = (),
    ) -> None:
        checks.append(InvariantCheck(check_id, invariant_id, status, reason_code, summary, refs))
        if status in ("fail", "no_verdict"):
            reason_codes.append(reason_code)

    # 1. Sanitizer runs first so secrets/raw content always fail closed immediately.
    san_res = sanitize_structure(artifact, forbidden_strings=forbidden_strings)
    if not san_res.passed:
        for finding in san_res.findings:
            add_check(
                f"sanitize.{finding.rule_id}",
                "SANITIZE",
                "fail",
                finding.reason_code,
                f"Sanitizer matched {finding.rule_id} at {finding.json_pointer} ({finding.redacted_preview}).",
                (finding.json_pointer,),
            )
    else:
        add_check("sanitize.clean", "SANITIZE", "pass", "PASS_SANITIZE_CLEAN", "Zero protected content or secret hits.")

    if not isinstance(artifact, dict):
        add_check("schema.root_object", "J1", "fail", "FAIL_SCHEMA_INVALID", "Root artifact must be a JSON object.", ("$",))
        return ArtifactVerificationReport(
            verdict=Verdict.FAIL,
            reason_codes=tuple(sorted(set(reason_codes))),
            run_id=None,
            artifact_sha256_declared=None,
            artifact_sha256_computed=None,
            claimed_evidence_status="unknown",
            verified_evidence_status="unverified",
            checks=tuple(checks),
            sanitizer_result=san_res,
            signature_result=SignatureCheckResult(False, require_signature, False, None, "NV_SIG_MISSING", "Invalid root."),
            ui_present=False,
            ui_consistent=True,
            ui_mismatched_fields=(),
            provenance_summary=None,
            impact_summary=None,
            exclusions=(),
        )

    run_id = artifact.get("run_id") if isinstance(artifact.get("run_id"), str) else None
    claimed_status = artifact.get("evidence_status") if artifact.get("evidence_status") in ("live", "recorded", "local_only", "incomplete") else "unknown"
    declared_sha = artifact.get("artifact_sha256") if isinstance(artifact.get("artifact_sha256"), str) else None
    schema_ver = artifact.get("schema_version")

    # 2. Schema version check.
    if schema_ver != SUPPORTED_INFERENCE_PROOF_VERSION:
        add_check(
            "schema.version",
            "J1",
            "no_verdict",
            "NV_UNSUPPORTED_SCHEMA_VERSION",
            f"Unsupported schema_version {schema_ver!r}; expected {SUPPORTED_INFERENCE_PROOF_VERSION!r}.",
            ("$.schema_version",),
        )
        return ArtifactVerificationReport(
            verdict=compute_verdict(reason_codes),
            reason_codes=tuple(sorted(set(reason_codes))),
            run_id=run_id,
            artifact_sha256_declared=declared_sha,
            artifact_sha256_computed=None,
            claimed_evidence_status=claimed_status,
            verified_evidence_status="unverified",
            checks=tuple(checks),
            sanitizer_result=san_res,
            signature_result=SignatureCheckResult(False, require_signature, False, None, "NV_SIG_MISSING", "Skipped."),
            ui_present="ui_summary" in artifact,
            ui_consistent=True,
            ui_mismatched_fields=(),
            provenance_summary=None,
            impact_summary=None,
            exclusions=(),
        )

    # 3. Canonical digest check (independent RFC 8785 JCS SHA-256).
    computed_sha = compute_artifact_sha256(artifact)
    if not declared_sha or not hmac.compare_digest(declared_sha, computed_sha):
        add_check(
            "integrity.digest",
            "J1",
            "fail",
            "FAIL_DIGEST_MISMATCH",
            "Declared artifact_sha256 does not match independent RFC 8785 JCS canonical SHA-256.",
            ("$.artifact_sha256",),
        )
    else:
        add_check(
            "integrity.digest",
            "J1",
            "pass",
            "PASS_VERIFIED",
            "artifact_sha256 matches independent RFC 8785 canonical SHA-256.",
            ("$.artifact_sha256",),
        )

    # 4. Signature & replay checks (J2, J4-replay).
    sig_res = verify_artifact_signature(
        artifact,
        computed_sha256=computed_sha,
        trust_root=trust_root,
        require_signature=require_signature,
        detached_signature=detached_signature,
    )
    if sig_res.reason_code != "PASS_VERIFIED":
        status_flag = "no_verdict" if sig_res.reason_code.startswith("NV_") else "fail"
        add_check("integrity.signature", "J2", status_flag, sig_res.reason_code, sig_res.detail, ("$.signature",))
    elif sig_res.checked:
        add_check("integrity.signature", "J2", "pass", "PASS_VERIFIED", sig_res.detail, ("$.signature",))

    if run_id is not None:
        fresh_ok, replay_msg = check_seen_run_ids(seen_run_ids_path, run_id=run_id, artifact_sha256=computed_sha)
        if not fresh_ok:
            add_check("provenance.replay", "J4", "fail", "FAIL_RUN_ID_REPLAYED", replay_msg, ("$.run_id",))

    # 5. Schema validation (after checking version, digest, signature).
    schema_errors = validate_against_schema(artifact, "inference-proof.v1.schema.json")
    # Defer nullable-placeholder checks to specific semantic invariants if applicable,
    # while catching true structural/additionalProperties/float-int errors immediately.
    for s_err in schema_errors:
        if s_err.reason_code == "FAIL_CANON_FLOAT_INT_MISMATCH":
            add_check("schema.float_int", "J1", "fail", "FAIL_CANON_FLOAT_INT_MISMATCH", s_err.message, (s_err.json_path,))
        elif s_err.json_path.startswith("$.performance.metrics.") and any(
            x in s_err.json_path for x in (".abs_", ".delta_", ".denominator")
        ):
            # Handled precisely in performance invariant below
            continue
        else:
            add_check("schema.structure", "J1", "fail", "FAIL_SCHEMA_INVALID", f"{s_err.json_path}: {s_err.message}", (s_err.json_path,))

    # Extract core sections defensively.
    source = artifact.get("source") if isinstance(artifact.get("source"), dict) else {}
    manifest = artifact.get("runtime_manifest") if isinstance(artifact.get("runtime_manifest"), dict) else {}
    trust_boundary = artifact.get("trust_boundary") if isinstance(artifact.get("trust_boundary"), dict) else {}
    scenario = artifact.get("scenario") if isinstance(artifact.get("scenario"), dict) else {}
    paired_runs = artifact.get("paired_runs") if isinstance(artifact.get("paired_runs"), dict) else {}
    scope_decisions = artifact.get("scope_decisions") if isinstance(artifact.get("scope_decisions"), list) else []
    block_lifecycle = artifact.get("block_lifecycle") if isinstance(artifact.get("block_lifecycle"), list) else []
    backend_dispatch = artifact.get("backend_dispatch") if isinstance(artifact.get("backend_dispatch"), list) else []
    correctness = artifact.get("correctness") if isinstance(artifact.get("correctness"), dict) else {}
    performance = artifact.get("performance") if isinstance(artifact.get("performance"), dict) else None
    receipt_chain = artifact.get("receipt_chain") if isinstance(artifact.get("receipt_chain"), dict) else {}
    exclusions = artifact.get("exclusions") if isinstance(artifact.get("exclusions"), dict) else {}
    ui_summary = artifact.get("ui_summary") if isinstance(artifact.get("ui_summary"), dict) else None

    # 6. Evidence status honesty (J3).
    is_gpu_claimed = claimed_status in ("live", "recorded")
    gpu_model = manifest.get("gpu_model")
    gpu_count = manifest.get("gpu_count")
    gpu_uuids = manifest.get("gpu_uuids_sha256") if isinstance(manifest.get("gpu_uuids_sha256"), list) else []
    tp_size = manifest.get("tp_size") if isinstance(manifest.get("tp_size"), int) else 0
    placeholder_notice = scenario.get("placeholder_notice")
    has_mock_markers = (
        manifest.get("topology") == "LOCAL_CPU"
        or (isinstance(gpu_model, str) and "local" in gpu_model.lower())
        or (isinstance(gpu_model, str) and "mock" in gpu_model.lower())
        or placeholder_notice == "NO GPU RUN RECORDED"
    )

    if claimed_status == "local_only":
        add_check(
            "status.honesty",
            "J3",
            "no_verdict",
            "NV_STATUS_LOCAL_ONLY",
            "Artifact is marked local_only; cannot establish H200 hardware claim.",
            ("$.evidence_status",),
        )
    elif claimed_status == "incomplete":
        add_check(
            "status.honesty",
            "J3",
            "no_verdict",
            "NV_STATUS_INCOMPLETE",
            "Artifact is marked incomplete; required evidence is partial or absent.",
            ("$.evidence_status",),
        )
    elif is_gpu_claimed:
        if has_mock_markers:
            add_check(
                "status.laundering",
                "J3",
                "fail",
                "FAIL_STATUS_LAUNDERING",
                f"evidence_status={claimed_status!r} contains local/mock/NO GPU RUN RECORDED indicators.",
                ("$.evidence_status", "$.runtime_manifest.gpu_model", "$.scenario.placeholder_notice"),
            )
        missing_gpu_fields = (
            not isinstance(gpu_model, str)
            or not gpu_model.strip()
            or _is_placeholder_str(gpu_model)
            or not isinstance(gpu_count, int)
            or gpu_count < 1
            or len(gpu_uuids) != gpu_count
            or len(set(gpu_uuids)) != gpu_count
            or not isinstance(manifest.get("driver_version"), str)
            or not isinstance(manifest.get("cuda_version"), str)
            or not isinstance(manifest.get("triton_version"), str)
        )
        if missing_gpu_fields:
            add_check(
                "provenance.gpu_manifest",
                "J3",
                "fail",
                "FAIL_GPU_MANIFEST_CONTRADICTION",
                "live/recorded GPU claim lacks complete non-duplicate GPU manifest (gpu_model, gpu_count, unique gpu_uuids_sha256, driver, CUDA, Triton).",
                ("$.runtime_manifest",),
            )
        elif "h200" in gpu_model.lower() and tp_size > gpu_count:
            add_check(
                "provenance.gpu_count_vs_tp",
                "J3",
                "fail",
                "FAIL_GPU_MANIFEST_CONTRADICTION",
                f"tp_size={tp_size} exceeds gpu_count={gpu_count}.",
                ("$.runtime_manifest.tp_size", "$.runtime_manifest.gpu_count"),
            )
        else:
            add_check(
                "provenance.gpu_manifest",
                "J3",
                "pass",
                "PASS_VERIFIED",
                f"GPU manifest bound: {gpu_model} x{gpu_count} (TP{tp_size}).",
                ("$.runtime_manifest",),
            )

    if not is_gpu_claimed and (
        not isinstance(gpu_model, str) or not isinstance(gpu_count, int) or gpu_count < 1 or len(gpu_uuids) == 0
    ):
        add_check(
            "provenance.gpu_manifest_missing",
            "J3",
            "no_verdict",
            "NV_MISSING_GPU_MANIFEST",
            "GPU manifest fields are absent on non-GPU artifact.",
            ("$.runtime_manifest",),
        )

    # Check explicit placeholder values anywhere in provenance/manifest.
    for fld in ("vllm_sha", "git_sha"):
        v = source.get(fld)
        if v == ZERO_SHA1_40 or _is_placeholder_str(v):
            add_check(
                f"provenance.placeholder.{fld}",
                "J5",
                "fail" if is_gpu_claimed else "no_verdict",
                "FAIL_PLACEHOLDER_METRIC" if is_gpu_claimed else "NV_STATUS_INCOMPLETE",
                f"source.{fld} contains sentinel/placeholder value.",
                (f"$.source.{fld}",),
            )
    for fld in ("patch_sha256", "trace_sha256"):
        v = source.get(fld)
        if v is None or v == ZERO_HASH_64 or _is_placeholder_str(v):
            add_check(
                f"provenance.placeholder.{fld}",
                "J5",
                "fail" if is_gpu_claimed else "no_verdict",
                "FAIL_PLACEHOLDER_METRIC" if is_gpu_claimed else "NV_STATUS_INCOMPLETE",
                f"source.{fld} is missing or contains placeholder digest.",
                (f"$.source.{fld}",),
            )

    # 7. Timestamps & chronological ordering (J4).
    root_start_dt: datetime | None = None
    root_end_dt: datetime | None = None
    try:
        root_start_dt = parse_utc_iso(str(artifact.get("started_at", "")))
        root_end_dt = parse_utc_iso(str(artifact.get("finished_at", "")))
        if root_end_dt < root_start_dt:
            add_check(
                "time.root_order",
                "J4",
                "fail",
                "FAIL_TIMESTAMP_REVERSED",
                "Root finished_at precedes started_at.",
                ("$.started_at", "$.finished_at"),
            )
        if root_start_dt > now + CLOCK_SKEW_TOLERANCE or root_end_dt > now + CLOCK_SKEW_TOLERANCE:
            add_check(
                "time.root_future",
                "J4",
                "fail",
                "FAIL_TIMESTAMP_FUTURE",
                "Artifact timestamp is in the future beyond 300s skew tolerance.",
                ("$.started_at", "$.finished_at"),
            )
    except ValueError:
        add_check(
            "time.root_parse",
            "J4",
            "fail",
            "FAIL_TIMESTAMP_REVERSED",
            "Invalid UTC RFC 3339 root timestamps.",
            ("$.started_at", "$.finished_at"),
        )

    # 8. Source & dirty state & runtime backend binding (J5, J6).
    patch_sha = source.get("patch_sha256")
    loaded_modules = source.get("loaded_modules") if isinstance(source.get("loaded_modules"), list) else []
    if is_gpu_claimed and not loaded_modules:
        add_check(
            "provenance.loaded_modules",
            "J5",
            "fail",
            "FAIL_PATCH_DIGEST_MISMATCH",
            "live/recorded run requires non-empty source.loaded_modules binding.",
            ("$.source.loaded_modules",),
        )
    if not isinstance(source.get("git_dirty"), bool):
        add_check(
            "provenance.dirty_explicit",
            "J5",
            "fail",
            "FAIL_DIRTY_STATE_HIDDEN",
            "source.git_dirty must be an explicit boolean.",
            ("$.source.git_dirty",),
        )

    configured_backend = manifest.get("configured_backend")
    selected_backend = manifest.get("selected_runtime_backend")
    if not isinstance(selected_backend, str) or selected_backend.lower() in ("auto", "unknown", "unset", ""):
        add_check(
            "backend.runtime_bound",
            "J6",
            "fail" if is_gpu_claimed else "no_verdict",
            "FAIL_BACKEND_INTENT_MISMATCH" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
            "selected_runtime_backend must reflect observed runtime selection, not auto/unknown.",
            ("$.runtime_manifest.selected_runtime_backend",),
        )
    elif isinstance(configured_backend, str) and configured_backend != selected_backend:
        add_check(
            "backend.intent_vs_runtime",
            "J6",
            "fail",
            "FAIL_BACKEND_INTENT_MISMATCH",
            f"configured_backend ({configured_backend}) differs from selected_runtime_backend ({selected_backend}).",
            ("$.runtime_manifest.configured_backend", "$.runtime_manifest.selected_runtime_backend"),
        )

    # 9. Trust boundary & controlled synthetic injection (J10).
    if trust_boundary.get("public_client_can_supply_scope") is not False:
        add_check(
            "auth.client_scope",
            "J10",
            "fail",
            "FAIL_CLIENT_SCOPE_SPOOF_ACCEPTED",
            "public_client_can_supply_scope must be false.",
            ("$.trust_boundary.public_client_can_supply_scope",),
        )

    if (
        scenario.get("synthetic_only") is not True
        or scenario.get("injection_type") != "controlled_engine_internal_post_auth_substitution"
    ):
        add_check(
            "scenario.synthetic_injection",
            "J10",
            "fail",
            "FAIL_INJECTION_NONSYNTHETIC",
            "Fault injection must be explicitly controlled and synthetic.",
            ("$.scenario.synthetic_only", "$.scenario.injection_type"),
        )

    foreign_block_alias = scenario.get("foreign_block_alias")
    foreign_owner_scope = scenario.get("foreign_owner_scope")
    victim_request_scope = scenario.get("victim_request_scope")
    if isinstance(foreign_owner_scope, str) and isinstance(victim_request_scope, str) and foreign_owner_scope == victim_request_scope:
        add_check(
            "scenario.distinct_scopes",
            "J10",
            "fail",
            "FAIL_SCOPE_CROSS_TENANT_ACCEPTED",
            "foreign_owner_scope must differ from victim_request_scope.",
            ("$.scenario.foreign_owner_scope", "$.scenario.victim_request_scope"),
        )

    # 10. Block lifecycle & generation invariants (J8).
    lifecycle_by_key: dict[tuple[str, int, int], dict[str, Any]] = {}
    missing_gen_found = False
    for idx, brec in enumerate(block_lifecycle):
        if not isinstance(brec, dict):
            continue
        balias = brec.get("physical_block_alias")
        bgen = brec.get("allocation_generation")
        brank = brec.get("rank_id")
        if bgen is None:
            missing_gen_found = True
            continue
        if not isinstance(bgen, int) or bgen < 1:
            add_check(
                f"lifecycle.gen_positive.{idx}",
                "J8",
                "fail",
                "FAIL_BLOCK_GEN_MISSING_OR_ZERO",
                f"block_lifecycle[{idx}] has non-positive allocation_generation={bgen}.",
                (f"$.block_lifecycle[{idx}].allocation_generation",),
            )
            continue
        if isinstance(balias, str) and isinstance(brank, int):
            lifecycle_by_key[(balias, bgen, brank)] = brec

        # Check transition sequence monotonicity and free/retired -> active generation increment.
        transitions = brec.get("transitions") if isinstance(brec.get("transitions"), list) else []
        prev_seq = -1
        prev_t_dt: datetime | None = None
        seen_terminal = False
        terminal_gen = bgen
        for tidx, tr in enumerate(transitions):
            if not isinstance(tr, dict):
                continue
            seq = tr.get("seq")
            tgen = tr.get("allocation_generation")
            from_st = tr.get("from_state")
            to_st = tr.get("to_state")
            if tgen is None:
                missing_gen_found = True
                continue
            if not isinstance(tgen, int) or tgen < 1:
                add_check(
                    f"lifecycle.tr_gen.{idx}.{tidx}",
                    "J8",
                    "fail",
                    "FAIL_BLOCK_GEN_MISSING_OR_ZERO",
                    "Lifecycle transition has non-positive allocation_generation.",
                    (f"$.block_lifecycle[{idx}].transitions[{tidx}].allocation_generation",),
                )
            if isinstance(seq, int):
                if seq <= prev_seq:
                    add_check(
                        f"lifecycle.seq.{idx}.{tidx}",
                        "J8",
                        "fail",
                        "FAIL_BLOCK_STALE_GENERATION",
                        "Lifecycle transition seq is not strictly increasing.",
                        (f"$.block_lifecycle[{idx}].transitions[{tidx}].seq",),
                    )
                prev_seq = seq
            try:
                tr_dt = parse_utc_iso(str(tr.get("transitioned_at", "")))
                if prev_t_dt is not None and tr_dt < prev_t_dt:
                    add_check(
                        f"lifecycle.time.{idx}.{tidx}",
                        "J4",
                        "fail",
                        "FAIL_TIMESTAMP_REVERSED",
                        "Lifecycle transitions are not chronologically ordered.",
                        (f"$.block_lifecycle[{idx}].transitions[{tidx}].transitioned_at",),
                    )
                prev_t_dt = tr_dt
                if root_start_dt and root_end_dt and (tr_dt < root_start_dt or tr_dt > root_end_dt):
                    add_check(
                        f"lifecycle.window.{idx}.{tidx}",
                        "J4",
                        "fail",
                        "FAIL_TIMESTAMP_OUT_OF_WINDOW",
                        "Lifecycle transition timestamp falls outside run window.",
                        (f"$.block_lifecycle[{idx}].transitions[{tidx}].transitioned_at",),
                    )
            except ValueError:
                pass

            if to_st in ("free", "retired"):
                seen_terminal = True
                if isinstance(tgen, int):
                    terminal_gen = tgen
            elif seen_terminal and from_st in ("free", "retired") and to_st in ("reserved", "writing", "readable"):
                if isinstance(tgen, int) and tgen <= terminal_gen:
                    add_check(
                        f"lifecycle.aba_reallocate.{idx}.{tidx}",
                        "J8",
                        "fail",
                        "FAIL_BLOCK_STALE_GENERATION",
                        "Block reused after free/retired without incrementing allocation_generation.",
                        (f"$.block_lifecycle[{idx}].transitions[{tidx}].allocation_generation",),
                    )

    # Check latest active generation per (physical_block_alias, rank_id) to catch stale generation usage.
    max_gen_by_block_rank: dict[tuple[str, int], int] = {}
    for (balias, bgen, brank) in lifecycle_by_key:
        cur = max_gen_by_block_rank.get((balias, brank), 0)
        if bgen > cur:
            max_gen_by_block_rank[(balias, brank)] = bgen

    # 11. Scope decisions join & PUBLIC / epoch / stale generation checks (J7, J8, J9).
    decisions_by_id: dict[str, dict[str, Any]] = {}
    decisions_by_req_rank_block: dict[tuple[str, int, str, int], dict[str, Any]] = {}
    for idx, dec in enumerate(scope_decisions):
        if not isinstance(dec, dict):
            continue
        did = dec.get("decision_id")
        req_id = dec.get("request_id")
        rank_id = dec.get("rank_id")
        balias = dec.get("physical_block_alias")
        dgen = dec.get("allocation_generation")
        rscope = dec.get("request_scope")
        bscope = dec.get("block_scope")
        pepoch = dec.get("policy_epoch")
        bepoch = dec.get("block_policy_epoch")
        disp = dec.get("disposition")
        pbasis = dec.get("public_basis")
        tok_eq = dec.get("token_equality_used_for_public")

        if isinstance(did, str):
            decisions_by_id[did] = dec

        if dgen is None:
            missing_gen_found = True
        elif not isinstance(dgen, int) or dgen < 1:
            add_check(
                f"scope.gen_positive.{idx}",
                "J8",
                "fail",
                "FAIL_BLOCK_GEN_MISSING_OR_ZERO",
                f"scope_decisions[{idx}] has invalid allocation_generation={dgen}.",
                (f"$.scope_decisions[{idx}].allocation_generation",),
            )
        elif isinstance(req_id, str) and isinstance(rank_id, int) and isinstance(balias, str):
            decisions_by_req_rank_block[(req_id, rank_id, balias, dgen)] = dec

        # Envelope & decision timing
        try:
            dec_dt = parse_utc_iso(str(dec.get("decided_at", "")))
            iss_dt = parse_utc_iso(str(dec.get("envelope_issued_at", "")))
            exp_dt = parse_utc_iso(str(dec.get("envelope_expires_at", "")))
            if dec_dt > now + CLOCK_SKEW_TOLERANCE:
                add_check(f"scope.future.{idx}", "J4", "fail", "FAIL_TIMESTAMP_FUTURE", "Decision timestamp in future.", (f"$.scope_decisions[{idx}].decided_at",))
            if dec_dt < iss_dt or dec_dt >= exp_dt:
                add_check(
                    f"scope.envelope_window.{idx}",
                    "J4",
                    "fail",
                    "FAIL_TIMESTAMP_OUT_OF_WINDOW",
                    "Scope decision occurred outside envelope validity window [issued_at, expires_at).",
                    (f"$.scope_decisions[{idx}].decided_at",),
                )
            if root_start_dt and root_end_dt and (dec_dt < root_start_dt or dec_dt > root_end_dt):
                add_check(
                    f"scope.run_window.{idx}",
                    "J4",
                    "fail",
                    "FAIL_TIMESTAMP_OUT_OF_WINDOW",
                    "Scope decision timestamp outside run window.",
                    (f"$.scope_decisions[{idx}].decided_at",),
                )
        except ValueError:
            pass

        # PUBLIC inference check
        if tok_eq is True or pbasis == "token_equality":
            add_check(
                f"scope.public_inferred.{idx}",
                "J9",
                "fail",
                "FAIL_SCOPE_PUBLIC_INFERRED",
                "PUBLIC scope cannot be inferred from token equality.",
                (f"$.scope_decisions[{idx}].public_basis", f"$.scope_decisions[{idx}].token_equality_used_for_public"),
            )

        if disp == "allow":
            if bscope == "UNASSIGNED" or rscope == "UNASSIGNED":
                add_check(
                    f"scope.unassigned_allow.{idx}",
                    "J8",
                    "fail",
                    "FAIL_BLOCK_UNASSIGNED_READ",
                    "UNASSIGNED scope cannot be allowed.",
                    (f"$.scope_decisions[{idx}]",),
                )
            elif bscope == "PUBLIC":
                if pbasis != "owner_approved_immutable_prefix":
                    add_check(
                        f"scope.public_basis.{idx}",
                        "J9",
                        "fail",
                        "FAIL_SCOPE_PUBLIC_INFERRED",
                        "Allowing PUBLIC block requires explicit owner_approved_immutable_prefix basis.",
                        (f"$.scope_decisions[{idx}].public_basis",),
                    )
            elif rscope != bscope:
                add_check(
                    f"scope.cross_tenant.{idx}",
                    "J9",
                    "fail",
                    "FAIL_SCOPE_CROSS_TENANT_ACCEPTED",
                    f"Cross-tenant block {bscope!r} was allowed for request scope {rscope!r}.",
                    (f"$.scope_decisions[{idx}]",),
                )
            if pepoch != bepoch:
                add_check(
                    f"scope.epoch.{idx}",
                    "J9",
                    "fail",
                    "FAIL_POLICY_EPOCH_MISMATCH",
                    "Admitted decision has mismatched request policy_epoch and block_policy_epoch.",
                    (f"$.scope_decisions[{idx}].policy_epoch", f"$.scope_decisions[{idx}].block_policy_epoch"),
                )

            # Join to lifecycle & stale/free check
            if isinstance(balias, str) and isinstance(dgen, int) and isinstance(rank_id, int):
                lrec = lifecycle_by_key.get((balias, dgen, rank_id))
                if lrec is None:
                    add_check(
                        f"scope.lifecycle_join.{idx}",
                        "J7",
                        "fail" if is_gpu_claimed else "no_verdict",
                        "FAIL_MISSING_REQUIRED_JOIN" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
                        f"scope_decisions[{idx}] cannot join to block_lifecycle ({balias}, gen={dgen}, rank={rank_id}).",
                        (f"$.scope_decisions[{idx}]",),
                    )
                else:
                    if lrec.get("state") in ("free", "retired"):
                        add_check(
                            f"scope.free_read.{idx}",
                            "J8",
                            "fail",
                            "FAIL_BLOCK_UNASSIGNED_READ",
                            f"Admitted block {balias} gen={dgen} is in terminal/free state {lrec.get('state')!r}.",
                            (f"$.scope_decisions[{idx}]",),
                        )
                    if lrec.get("owner_scope") != bscope or lrec.get("policy_epoch") != bepoch:
                        add_check(
                            f"scope.lifecycle_conflict.{idx}",
                            "J7",
                            "fail",
                            "FAIL_SCOPE_CROSS_TENANT_ACCEPTED",
                            "scope_decisions block_scope/epoch conflicts with block_lifecycle owner_scope/epoch.",
                            (f"$.scope_decisions[{idx}]",),
                        )
                    max_gen = max_gen_by_block_rank.get((balias, rank_id), dgen)
                    if dgen < max_gen:
                        add_check(
                            f"scope.stale_gen.{idx}",
                            "J8",
                            "fail",
                            "FAIL_BLOCK_STALE_GENERATION",
                            f"Admitted stale generation {dgen} < latest generation {max_gen} for {balias}.",
                            (f"$.scope_decisions[{idx}].allocation_generation",),
                        )

    # 12. Dispatch spans indexing (J6, J11).
    spans_by_req_rank: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for idx, sp in enumerate(backend_dispatch):
        if not isinstance(sp, dict):
            continue
        req_id = sp.get("request_id")
        rank_id = sp.get("rank_id")
        sp_backend = sp.get("selected_backend")
        entered = sp.get("entered_attention_dispatch")
        blocked = sp.get("blocked_before_dispatch")
        disp_at = sp.get("dispatched_at")

        if isinstance(selected_backend, str) and isinstance(sp_backend, str) and sp_backend != selected_backend:
            add_check(
                f"dispatch.backend.{idx}",
                "J6",
                "fail",
                "FAIL_BACKEND_INTENT_MISMATCH",
                f"Dispatch span backend {sp_backend!r} differs from manifest selected_runtime_backend {selected_backend!r}.",
                (f"$.backend_dispatch[{idx}].selected_backend",),
            )
        if entered is True and blocked is True:
            add_check(
                f"dispatch.contradiction.{idx}",
                "J11",
                "fail",
                "FAIL_VIOLATION_ENTERED_DISPATCH",
                "Dispatch span claims both entered_attention_dispatch=true and blocked_before_dispatch=true.",
                (f"$.backend_dispatch[{idx}]",),
            )
        if entered is True and disp_at is None:
            add_check(
                f"dispatch.missing_time.{idx}",
                "J11",
                "fail",
                "FAIL_SCHEMA_INVALID",
                "Dispatch span with entered_attention_dispatch=true must have dispatched_at timestamp.",
                (f"$.backend_dispatch[{idx}].dispatched_at",),
            )
        if isinstance(req_id, str) and isinstance(rank_id, int):
            spans_by_req_rank.setdefault((req_id, rank_id), []).append(sp)

    # 13. Paired runs, isolation, pre-dispatch blocking, allowed follow-up, and TP rank agreement (J10, J11, J12).
    arm_times: dict[str, tuple[datetime, datetime]] = {}
    for arm_name in EXPECTED_ARMS:
        arm = paired_runs.get(arm_name)
        if not isinstance(arm, dict):
            add_check(
                f"paired.{arm_name}.missing",
                "J7",
                "fail" if is_gpu_claimed else "no_verdict",
                "FAIL_MISSING_REQUIRED_JOIN" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
                f"Missing paired arm {arm_name!r}.",
                (f"$.paired_runs.{arm_name}",),
            )
            continue

        req_id = arm.get("request_id")
        req_scope = arm.get("request_scope")
        arm_epoch = arm.get("policy_epoch")
        outcome = arm.get("outcome")
        entered_arm = arm.get("entered_attention_dispatch")
        ref_blocks = arm.get("referenced_blocks") if isinstance(arm.get("referenced_blocks"), list) else []
        ranks = arm.get("ranks") if isinstance(arm.get("ranks"), list) else []

        # Arm timestamp window
        try:
            a_start = parse_utc_iso(str(arm.get("started_at", "")))
            a_end = parse_utc_iso(str(arm.get("finished_at", "")))
            arm_times[arm_name] = (a_start, a_end)
            if a_end < a_start:
                add_check(f"paired.{arm_name}.time_rev", "J4", "fail", "FAIL_TIMESTAMP_REVERSED", f"{arm_name} finished_at < started_at.", (f"$.paired_runs.{arm_name}",))
            if root_start_dt and root_end_dt and (a_start < root_start_dt or a_end > root_end_dt):
                add_check(f"paired.{arm_name}.window", "J4", "fail", "FAIL_TIMESTAMP_OUT_OF_WINDOW", f"{arm_name} outside root time window.", (f"$.paired_runs.{arm_name}",))
        except ValueError:
            pass

        # Referenced blocks checks: positive generation & clean-vs-injected foreign block presence
        ref_aliases: set[str] = set()
        for bidx, bref in enumerate(ref_blocks):
            if not isinstance(bref, dict):
                continue
            balias = bref.get("physical_block_alias")
            bgen = bref.get("allocation_generation")
            if isinstance(balias, str):
                ref_aliases.add(balias)
            if bgen is None:
                missing_gen_found = True
            elif not isinstance(bgen, int) or bgen < 1:
                add_check(
                    f"paired.{arm_name}.gen.{bidx}",
                    "J8",
                    "fail",
                    "FAIL_BLOCK_GEN_MISSING_OR_ZERO",
                    f"{arm_name}.referenced_blocks[{bidx}] has invalid allocation_generation={bgen}.",
                    (f"$.paired_runs.{arm_name}.referenced_blocks[{bidx}].allocation_generation",),
                )

        if arm_name in ("native_clean", "vervain_clean") and isinstance(foreign_block_alias, str):
            if foreign_block_alias in ref_aliases:
                add_check(
                    f"isolation.clean_contaminated.{arm_name}",
                    "J10",
                    "fail",
                    "FAIL_CLEAN_CONTAMINATED",
                    f"Foreign block {foreign_block_alias!r} appeared in clean run {arm_name!r}.",
                    (f"$.paired_runs.{arm_name}.referenced_blocks",),
                )
        if arm_name in ("native_fault_injected", "vervain_fault_injected") and isinstance(foreign_block_alias, str):
            if foreign_block_alias not in ref_aliases:
                add_check(
                    f"isolation.fault_missing.{arm_name}",
                    "J10",
                    "fail" if is_gpu_claimed else "no_verdict",
                    "FAIL_MISSING_REQUIRED_JOIN" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
                    f"Controlled foreign block {foreign_block_alias!r} absent from injected run {arm_name!r}.",
                    (f"$.paired_runs.{arm_name}.referenced_blocks",),
                )

        # TP rank completeness & uniqueness & agreement (J12)
        seen_rank_ids: set[int] = set()
        seen_gpu_uuids: set[str] = set()
        rank_decisions: set[str] = set()
        rank_dispatches: set[bool] = set()
        for ridx, rrec in enumerate(ranks):
            if not isinstance(rrec, dict):
                continue
            rk = rrec.get("rank_id")
            ruuid = rrec.get("gpu_uuid_sha256")
            rpatch = rrec.get("loaded_patch_sha256")
            rdec = rrec.get("enforced_decision")
            rdref = rrec.get("decision_ref")
            rent = rrec.get("entered_attention_dispatch")

            if isinstance(rk, int):
                if rk in seen_rank_ids:
                    add_check(
                        f"ranks.duplicate.{arm_name}.{rk}",
                        "J12",
                        "fail",
                        "FAIL_TP_DUPLICATE_RANK",
                        f"Duplicate rank_id={rk} in {arm_name}.",
                        (f"$.paired_runs.{arm_name}.ranks[{ridx}].rank_id",),
                    )
                seen_rank_ids.add(rk)
            if isinstance(ruuid, str):
                if ruuid in seen_gpu_uuids:
                    add_check(
                        f"ranks.dup_uuid.{arm_name}.{ridx}",
                        "J12",
                        "fail",
                        "FAIL_TP_DUPLICATE_RANK",
                        f"Duplicate gpu_uuid_sha256 in {arm_name}.ranks.",
                        (f"$.paired_runs.{arm_name}.ranks[{ridx}].gpu_uuid_sha256",),
                    )
                seen_gpu_uuids.add(ruuid)
            elif is_gpu_claimed:
                add_check(
                    f"ranks.missing_uuid.{arm_name}.{ridx}",
                    "J12",
                    "fail",
                    "FAIL_GPU_MANIFEST_CONTRADICTION",
                    f"Missing gpu_uuid_sha256 on rank {rk} for live/recorded run.",
                    (f"$.paired_runs.{arm_name}.ranks[{ridx}].gpu_uuid_sha256",),
                )

            if arm_name.startswith("vervain_"):
                if isinstance(patch_sha, str) and rpatch != patch_sha:
                    add_check(
                        f"ranks.patch.{arm_name}.{ridx}",
                        "J5",
                        "fail",
                        "FAIL_PATCH_DIGEST_MISMATCH",
                        f"Rank {rk} loaded_patch_sha256 differs from source.patch_sha256.",
                        (f"$.paired_runs.{arm_name}.ranks[{ridx}].loaded_patch_sha256",),
                    )
                if not isinstance(rdref, str) or rdref not in decisions_by_id:
                    add_check(
                        f"ranks.decision_ref.{arm_name}.{ridx}",
                        "J7",
                        "fail" if is_gpu_claimed else "no_verdict",
                        "FAIL_MISSING_REQUIRED_JOIN" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
                        f"Rank {rk} decision_ref in {arm_name} does not join to scope_decisions.",
                        (f"$.paired_runs.{arm_name}.ranks[{ridx}].decision_ref",),
                    )
                else:
                    ref_disp = decisions_by_id[rdref].get("disposition")
                    if arm_name == "vervain_fault_injected" and ref_disp == "allow":
                        add_check(
                            f"ranks.decision_allow_fault.{arm_name}.{ridx}",
                            "J11",
                            "fail",
                            "FAIL_SCOPE_CROSS_TENANT_ACCEPTED",
                            f"Rank {rk} decision_ref for vervain_fault_injected points to disposition=allow.",
                            (f"$.paired_runs.{arm_name}.ranks[{ridx}].decision_ref",),
                        )
                    elif arm_name in ("vervain_clean", "vervain_allowed_after_fault") and ref_disp != "allow":
                        add_check(
                            f"ranks.decision_deny_allowed.{arm_name}.{ridx}",
                            "J11",
                            "fail",
                            "FAIL_ALLOWED_REQUEST_BLOCKED",
                            f"Rank {rk} decision_ref for {arm_name} has non-allow disposition {ref_disp!r}.",
                            (f"$.paired_runs.{arm_name}.ranks[{ridx}].decision_ref",),
                        )

            if isinstance(rdec, str):
                rank_decisions.add(rdec)
            if isinstance(rent, bool):
                rank_dispatches.add(rent)

            # Check every referenced block has a scope decision on this rank for Vervain arms
            if arm_name.startswith("vervain_") and isinstance(req_id, str) and isinstance(rk, int):
                for bref in ref_blocks:
                    if not isinstance(bref, dict):
                        continue
                    bal = bref.get("physical_block_alias")
                    bgn = bref.get("allocation_generation")
                    if isinstance(bal, str) and isinstance(bgn, int):
                        dec_match = decisions_by_req_rank_block.get((req_id, rk, bal, bgn))
                        if dec_match is None:
                            add_check(
                                f"joins.block_decision.{arm_name}.{rk}.{bal}",
                                "J7",
                                "fail" if is_gpu_claimed else "no_verdict",
                                "FAIL_MISSING_REQUIRED_JOIN" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
                                f"Missing scope_decisions entry for ({req_id}, rank={rk}, {bal}, gen={bgn}).",
                                (f"$.paired_runs.{arm_name}.referenced_blocks",),
                            )
                        else:
                            if dec_match.get("request_scope") != req_scope or dec_match.get("policy_epoch") != arm_epoch:
                                add_check(
                                    f"joins.scope_epoch.{arm_name}.{rk}.{bal}",
                                    "J7",
                                    "fail",
                                    "FAIL_POLICY_EPOCH_MISMATCH",
                                    "Scope decision request_scope/policy_epoch conflicts with paired arm.",
                                    ("$.scope_decisions",),
                                )

            # Check dispatch spans join for (req_id, rank_id)
            if isinstance(req_id, str) and isinstance(rk, int):
                spans = spans_by_req_rank.get((req_id, rk), [])
                if not spans:
                    add_check(
                        f"joins.dispatch_span.{arm_name}.{rk}",
                        "J11",
                        "fail" if is_gpu_claimed else "no_verdict",
                        "FAIL_MISSING_REQUIRED_JOIN" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
                        f"Missing backend_dispatch span for {arm_name} ({req_id}, rank={rk}).",
                        ("$.backend_dispatch",),
                    )
                else:
                    if arm_name == "vervain_fault_injected":
                        if any(sp.get("entered_attention_dispatch") is True or sp.get("blocked_before_dispatch") is not True for sp in spans):
                            add_check(
                                f"dispatch.violation_entered.{rk}",
                                "J11",
                                "fail",
                                "FAIL_VIOLATION_ENTERED_DISPATCH",
                                f"Violating request entered attention dispatch on rank {rk}.",
                                ("$.backend_dispatch",),
                            )
                    elif arm_name in ("native_clean", "native_fault_injected", "vervain_clean", "vervain_allowed_after_fault"):
                        if not any(sp.get("entered_attention_dispatch") is True and sp.get("blocked_before_dispatch") is False for sp in spans):
                            add_check(
                                f"dispatch.allowed_blocked.{arm_name}.{rk}",
                                "J11",
                                "fail",
                                "FAIL_ALLOWED_REQUEST_BLOCKED",
                                f"Permitted/baseline request {arm_name} failed to enter attention dispatch on rank {rk}.",
                                ("$.backend_dispatch",),
                            )

        if tp_size >= 1:
            expected_rank_set = set(range(tp_size))
            if len(seen_rank_ids) < tp_size or seen_rank_ids != expected_rank_set:
                status_flag = "fail" if is_gpu_claimed else "no_verdict"
                code = "FAIL_TP_RANK_COUNT_MISMATCH" if is_gpu_claimed else "NV_TP_RANK_EVIDENCE_MISSING"
                add_check(
                    f"ranks.count.{arm_name}",
                    "J12",
                    status_flag,
                    code,
                    f"{arm_name} recorded ranks {sorted(seen_rank_ids)} but manifest tp_size={tp_size} requires 0..{tp_size - 1}.",
                    (f"$.paired_runs.{arm_name}.ranks",),
                )
        if len(rank_decisions) > 1 or len(rank_dispatches) > 1:
            add_check(
                f"ranks.disagreement.{arm_name}",
                "J12",
                "fail",
                "FAIL_TP_RANK_DISAGREEMENT",
                f"TP ranks disagreed on decision or dispatch in {arm_name}.",
                (f"$.paired_runs.{arm_name}.ranks",),
            )

        # Arm-level outcome assertions
        if arm_name == "vervain_fault_injected":
            if outcome != "blocked_fail_closed" or entered_arm is not False:
                add_check(
                    "arm.vervain_fault_outcome",
                    "J11",
                    "fail",
                    "FAIL_VIOLATION_ENTERED_DISPATCH",
                    "vervain_fault_injected must have outcome=blocked_fail_closed and entered_attention_dispatch=false.",
                    ("$.paired_runs.vervain_fault_injected",),
                )
        elif arm_name in ("native_clean", "vervain_clean", "vervain_allowed_after_fault"):
            if outcome != "completed" or entered_arm is not True:
                add_check(
                    f"arm.allowed_outcome.{arm_name}",
                    "J11",
                    "fail",
                    "FAIL_ALLOWED_REQUEST_BLOCKED",
                    f"{arm_name} must enter dispatch and complete normally (got outcome={outcome!r}).",
                    (f"$.paired_runs.{arm_name}",),
                )

    if missing_gen_found:
        add_check(
            "lifecycle.missing_generation",
            "J8",
            "fail" if is_gpu_claimed else "no_verdict",
            "FAIL_BLOCK_GEN_MISSING_OR_ZERO" if is_gpu_claimed else "NV_MISSING_ALLOCATION_GENERATION",
            "One or more physical block references omit allocation_generation.",
            ("$.paired_runs", "$.scope_decisions", "$.block_lifecycle"),
        )

    # Allowed follow-up must complete strictly after or at fault completion timestamp.
    if "vervain_fault_injected" in arm_times and "vervain_allowed_after_fault" in arm_times:
        fault_start, fault_end = arm_times["vervain_fault_injected"]
        allow_start, allow_end = arm_times["vervain_allowed_after_fault"]
        if allow_start < fault_end or allow_end < fault_end:
            add_check(
                "time.allowed_after_fault",
                "J4",
                "fail",
                "FAIL_TIMESTAMP_REVERSED",
                "vervain_allowed_after_fault must execute after vervain_fault_injected.",
                ("$.paired_runs.vervain_fault_injected", "$.paired_runs.vervain_allowed_after_fault"),
            )

    # 14. Correctness equivalence & planted-value probe (J13).
    nc = paired_runs.get("native_clean") if isinstance(paired_runs.get("native_clean"), dict) else {}
    vc = paired_runs.get("vervain_clean") if isinstance(paired_runs.get("vervain_clean"), dict) else {}
    vf = paired_runs.get("vervain_fault_injected") if isinstance(paired_runs.get("vervain_fault_injected"), dict) else {}
    va = paired_runs.get("vervain_allowed_after_fault") if isinstance(paired_runs.get("vervain_allowed_after_fault"), dict) else {}

    corr_seed = correctness.get("seed")
    corr_cfg = correctness.get("config_digest")
    if (
        nc.get("seed") != vc.get("seed")
        or nc.get("seed") != corr_seed
        or nc.get("config_digest") != vc.get("config_digest")
        or nc.get("config_digest") != corr_cfg
    ):
        add_check(
            "correctness.seed_config",
            "J13",
            "fail",
            "FAIL_CLEAN_SEED_OR_CONFIG_MISMATCH",
            "native_clean, vervain_clean, and correctness must share identical seed and config_digest.",
            ("$.correctness", "$.paired_runs.native_clean", "$.paired_runs.vervain_clean"),
        )

    tol = correctness.get("equivalence_tolerance")
    delta = correctness.get("measured_max_abs_delta")
    eq_pass = correctness.get("clean_equivalence_passed")
    if not _is_finite_num(tol) or not _is_finite_num(delta) or eq_pass is not True or float(delta) > float(tol):
        add_check(
            "correctness.equivalence",
            "J13",
            "fail",
            "FAIL_EQUIVALENCE_TOLERANCE_EXCEEDED",
            "Clean equivalence tolerance exceeded or clean_equivalence_passed is false.",
            ("$.correctness.measured_max_abs_delta", "$.correctness.equivalence_tolerance"),
        )

    probe = correctness.get("planted_value_influence_probe") if isinstance(correctness.get("planted_value_influence_probe"), dict) else {}
    nat_inf = probe.get("native_fault_injected_influence_score")
    ver_inf = probe.get("vervain_fault_injected_influence_score")
    if (
        probe.get("raw_planted_value_omitted") is not True
        or probe.get("baseline_nonzero_influence") is not True
        or not _is_finite_num(nat_inf)
        or float(nat_inf) <= 0.0
    ):
        add_check(
            "correctness.native_influence",
            "J13",
            "fail",
            "FAIL_NATIVE_FAULT_NO_INFLUENCE",
            "native_fault_injected must demonstrate nonzero planted-value influence.",
            ("$.correctness.planted_value_influence_probe",),
        )
    if probe.get("vervain_zero_or_blocked") is not True or not _is_finite_num(ver_inf) or float(ver_inf) != 0.0:
        add_check(
            "correctness.vervain_influence",
            "J13",
            "fail",
            "FAIL_VIOLATION_ENTERED_DISPATCH",
            "vervain_fault_injected probe influence must be 0.0 (blocked before dispatch).",
            ("$.correctness.planted_value_influence_probe",),
        )
    if (
        correctness.get("allowed_after_fault_completed_after_violation") is not True
        or correctness.get("violating_request_id") != vf.get("request_id")
        or correctness.get("allowed_after_fault_request_id") != va.get("request_id")
    ):
        add_check(
            "correctness.allowed_after_fault_join",
            "J11",
            "fail",
            "FAIL_ALLOWED_REQUEST_BLOCKED",
            "allowed_after_fault join or completion flag failed.",
            ("$.correctness",),
        )

    # 15. Performance parity, sample counts, and denominator checks (J14).
    ttft_delta_pct_raw: float | None = None
    ttft_sample_count_raw: int | None = None
    if performance is None:
        add_check(
            "performance.absent",
            "J14",
            "fail" if is_gpu_claimed else "no_verdict",
            "FAIL_PERF_MISSING_DENOMINATOR" if is_gpu_claimed else "NV_PERF_INCOMPLETE",
            "Performance section is null.",
            ("$.performance",),
        )
    else:
        b_cfg = performance.get("baseline_config") if isinstance(performance.get("baseline_config"), dict) else {}
        c_cfg = performance.get("candidate_config") if isinstance(performance.get("candidate_config"), dict) else {}
        parity_keys = (
            "gpu_model",
            "gpu_count",
            "model_id",
            "model_revision",
            "selected_runtime_backend",
            "kv_dtype",
            "block_size",
            "prefix_caching",
            "graph_mode",
            "tp_size",
            "prompt_tokens",
            "output_tokens",
            "concurrency",
            "warmup_count",
            "sample_count",
        )
        mismatched_perf_keys = [k for k in parity_keys if b_cfg.get(k) != c_cfg.get(k)]
        if mismatched_perf_keys:
            add_check(
                "performance.config_parity",
                "J14",
                "fail",
                "FAIL_PERF_CONFIG_MISMATCH",
                f"Performance baseline_config and candidate_config differ on: {', '.join(mismatched_perf_keys)}.",
                ("$.performance.baseline_config", "$.performance.candidate_config"),
            )
        if is_gpu_claimed and (
            b_cfg.get("gpu_model") != gpu_model
            or b_cfg.get("gpu_count") != gpu_count
            or b_cfg.get("model_revision") != manifest.get("model_revision")
            or b_cfg.get("selected_runtime_backend") != selected_backend
        ):
            add_check(
                "performance.manifest_parity",
                "J14",
                "fail",
                "FAIL_PERF_CONFIG_MISMATCH",
                "Performance config does not match runtime_manifest GPU/model/backend.",
                ("$.performance.baseline_config", "$.runtime_manifest"),
            )

        cfg_samples = b_cfg.get("sample_count") if isinstance(b_cfg.get("sample_count"), int) else 0
        metrics_map = performance.get("metrics") if isinstance(performance.get("metrics"), dict) else {}
        for mname in ("ttft_ms", "itl_ms", "req_per_sec", "tok_per_sec", "peak_gpu_mem_mb", "guard_us", "mismatch_us"):
            m = metrics_map.get(mname)
            if not isinstance(m, dict):
                continue
            sc = m.get("sample_count")
            abs_b = m.get("abs_baseline")
            abs_c = m.get("abs_candidate")
            d_abs = m.get("delta_abs")
            d_pct = m.get("delta_pct")
            denom = m.get("denominator")
            p50 = m.get("p50") if isinstance(m.get("p50"), dict) else {}
            p95 = m.get("p95") if isinstance(m.get("p95"), dict) else None

            if any(_is_placeholder_str(x) for x in (abs_b, abs_c, d_abs, d_pct, denom, p50.get("baseline"), p50.get("candidate"))) or sc == 0:
                add_check(
                    f"performance.placeholder.{mname}",
                    "J14",
                    "fail",
                    "FAIL_PLACEHOLDER_METRIC",
                    f"Metric {mname} contains placeholder value or sample_count=0.",
                    (f"$.performance.metrics.{mname}",),
                )
                continue

            if not all(_is_finite_num(x) for x in (abs_b, abs_c, d_abs, d_pct, denom)):
                add_check(
                    f"performance.missing_abs.{mname}",
                    "J14",
                    "fail",
                    "FAIL_PERF_MISSING_DENOMINATOR",
                    f"Metric {mname} is missing abs_baseline, abs_candidate, denominator, or delta.",
                    (f"$.performance.metrics.{mname}",),
                )
                continue

            fb, fc, fd_abs, fd_pct, fdenom = float(abs_b), float(abs_c), float(d_abs), float(d_pct), float(denom)
            if fb < 0 or fc < 0 or fdenom <= 0:
                add_check(
                    f"performance.negative.{mname}",
                    "J14",
                    "fail",
                    "FAIL_PERF_IMPOSSIBLE_METRIC",
                    f"Metric {mname} has negative baseline/candidate or non-positive denominator.",
                    (f"$.performance.metrics.{mname}",),
                )
                continue

            if abs(fdenom - fb) > 1e-6 or abs(fd_abs - (fc - fb)) > 1e-4 or abs(fd_pct - ((fd_abs / fdenom) * 100.0)) > 1e-2:
                add_check(
                    f"performance.math.{mname}",
                    "J14",
                    "fail",
                    "FAIL_PERF_MISSING_DENOMINATOR",
                    f"Metric {mname} denominator or delta math does not reconcile with abs_baseline/abs_candidate.",
                    (f"$.performance.metrics.{mname}",),
                )

            if p50 and _is_finite_num(p50.get("baseline")) and _is_finite_num(p50.get("candidate")):
                if float(p50["baseline"]) < 0 or float(p50["candidate"]) < 0:
                    add_check(f"performance.p50_neg.{mname}", "J14", "fail", "FAIL_PERF_IMPOSSIBLE_METRIC", f"{mname}.p50 cannot be negative.", (f"$.performance.metrics.{mname}.p50",))

            if p95 is not None:
                if not isinstance(sc, int) or sc < MIN_P95_SAMPLES:
                    add_check(
                        f"performance.p95_samples.{mname}",
                        "J14",
                        "fail",
                        "FAIL_PERF_INSUFFICIENT_SAMPLES",
                        f"{mname}.p95 reported with sample_count={sc} < {MIN_P95_SAMPLES}.",
                        (f"$.performance.metrics.{mname}.p95", f"$.performance.metrics.{mname}.sample_count"),
                    )
                if (
                    _is_finite_num(p95.get("baseline"))
                    and _is_finite_num(p95.get("candidate"))
                    and _is_finite_num(p50.get("baseline"))
                    and _is_finite_num(p50.get("candidate"))
                ):
                    if mname in ("ttft_ms", "itl_ms", "guard_us", "mismatch_us", "peak_gpu_mem_mb"):
                        if float(p95["baseline"]) < float(p50["baseline"]) or float(p95["candidate"]) < float(p50["candidate"]):
                            add_check(
                                f"performance.p95_order.{mname}",
                                "J14",
                                "fail",
                                "FAIL_PERF_IMPOSSIBLE_METRIC",
                                f"{mname} has p95 < p50.",
                                (f"$.performance.metrics.{mname}",),
                            )

            if isinstance(sc, int) and sc != cfg_samples:
                add_check(
                    f"performance.sample_mismatch.{mname}",
                    "J14",
                    "fail",
                    "FAIL_PERF_CONFIG_MISMATCH",
                    f"{mname}.sample_count ({sc}) differs from baseline_config.sample_count ({cfg_samples}).",
                    (f"$.performance.metrics.{mname}.sample_count",),
                )

            if mname == "ttft_ms":
                ttft_delta_pct_raw = fd_pct
                ttft_sample_count_raw = sc if isinstance(sc, int) else None

    # 16. Receipt chain & run_id consistency (J4, J15).
    events = receipt_chain.get("events") if isinstance(receipt_chain.get("events"), list) else []
    genesis = receipt_chain.get("genesis_sha256")
    head = receipt_chain.get("head_sha256")
    expected_count = receipt_chain.get("event_count")
    if expected_count != len(events):
        add_check(
            "receipt_chain.count",
            "J15",
            "fail",
            "FAIL_RECEIPT_CHAIN_BROKEN",
            f"receipt_chain.event_count ({expected_count}) != len(events) ({len(events)}).",
            ("$.receipt_chain.event_count",),
        )
    prev_hash = genesis
    seen_chain_reqs: set[str] = set()
    for idx, ev in enumerate(events):
        if not isinstance(ev, dict):
            continue
        if ev.get("run_id") != run_id:
            add_check(
                f"receipt_chain.run_id.{idx}",
                "J4",
                "fail",
                "FAIL_RUN_ID_MISMATCH",
                f"receipt_chain.events[{idx}].run_id does not match root run_id.",
                (f"$.receipt_chain.events[{idx}].run_id",),
            )
        if ev.get("event_index") != idx or ev.get("prev_sha256") != prev_hash or ev.get("event_sha256") != ev.get("canonical_event_sha256"):
            add_check(
                f"receipt_chain.link.{idx}",
                "J15",
                "fail",
                "FAIL_RECEIPT_CHAIN_BROKEN",
                f"receipt_chain broken at event_index={idx}.",
                (f"$.receipt_chain.events[{idx}]",),
            )
        prev_hash = ev.get("event_sha256")
        if isinstance(ev.get("request_id"), str):
            seen_chain_reqs.add(ev["request_id"])
    if events and prev_hash != head:
        add_check(
            "receipt_chain.head",
            "J15",
            "fail",
            "FAIL_RECEIPT_CHAIN_BROKEN",
            "receipt_chain head_sha256 does not match final event_sha256.",
            ("$.receipt_chain.head_sha256",),
        )
    for arm_name in EXPECTED_ARMS:
        arm = paired_runs.get(arm_name)
        if isinstance(arm, dict) and isinstance(arm.get("request_id"), str):
            if arm["request_id"] not in seen_chain_reqs:
                add_check(
                    f"receipt_chain.arm_event.{arm_name}",
                    "J15",
                    "fail" if is_gpu_claimed else "no_verdict",
                    "FAIL_MISSING_REQUIRED_JOIN" if is_gpu_claimed else "NV_MISSING_JOIN_EVIDENCE",
                    f"Arm {arm_name} request_id missing from receipt_chain.events.",
                    ("$.receipt_chain.events",),
                )

    # 17. Exclusions & unsupported path enforcement (J16).
    unsupported_entries = exclusions.get("unsupported_paths") if isinstance(exclusions.get("unsupported_paths"), list) else []
    declared_paths = {
        e.get("path_name"): e.get("status")
        for e in unsupported_entries
        if isinstance(e, dict) and isinstance(e.get("path_name"), str)
    }
    feature_checks = (
        ("graph_mode", manifest.get("graph_mode"), ("eager", "cudagraph_disabled")),
        ("kv_connector", manifest.get("kv_connector"), ("disabled",)),
        ("offload", manifest.get("offload"), ("disabled",)),
        ("swap", manifest.get("swap"), ("disabled",)),
        ("speculation", manifest.get("speculation"), ("disabled",)),
    )
    for fname, fval, safe_vals in feature_checks:
        if isinstance(fval, str) and fval not in safe_vals:
            if declared_paths.get(fname) not in ("disabled", "fail_closed", "not_claimed"):
                add_check(
                    f"exclusions.missing.{fname}",
                    "J16",
                    "fail",
                    "FAIL_UNSUPPORTED_PATH_OMITTED",
                    f"Non-baseline path {fname}={fval!r} is active or unmediated but omitted from exclusions.unsupported_paths.",
                    ("$.runtime_manifest", "$.exclusions.unsupported_paths"),
                )

    # 18. UI summary non-trust cross-check (J17).
    raw_foreign_stopped = (
        vf.get("outcome") == "blocked_fail_closed"
        and vf.get("entered_attention_dispatch") is False
        and (_is_finite_num(ver_inf) and float(ver_inf) == 0.0)
    )
    raw_allowed_completed = (
        va.get("outcome") == "completed"
        and va.get("entered_attention_dispatch") is True
        and correctness.get("allowed_after_fault_completed_after_violation") is True
    )
    raw_equiv_passed = bool(eq_pass is True and _is_finite_num(tol) and _is_finite_num(delta) and float(delta) <= float(tol))

    ui_present = ui_summary is not None
    ui_mismatched: list[str] = []
    if ui_summary is not None:
        comparisons: list[tuple[str, Any, Any]] = [
            ("evidence_status", ui_summary.get("evidence_status"), claimed_status),
            ("foreign_block_stopped", ui_summary.get("foreign_block_stopped"), raw_foreign_stopped),
            ("clean_equivalence_passed", ui_summary.get("clean_equivalence_passed"), raw_equiv_passed),
            ("allowed_after_fault_completed", ui_summary.get("allowed_after_fault_completed"), raw_allowed_completed),
            ("selected_runtime_backend", ui_summary.get("selected_runtime_backend"), selected_backend),
            ("gpu_model", ui_summary.get("gpu_model"), gpu_model),
            ("tp_size", ui_summary.get("tp_size"), tp_size),
        ]
        for fname, uval, rval in comparisons:
            if uval != rval:
                ui_mismatched.append(fname)
        ui_ttft = ui_summary.get("ttft_delta_pct")
        if ttft_delta_pct_raw is not None and _is_finite_num(ui_ttft):
            if abs(float(ui_ttft) - ttft_delta_pct_raw) > 1e-3:
                ui_mismatched.append("ttft_delta_pct")
        elif ui_ttft is not None and ttft_delta_pct_raw is None:
            ui_mismatched.append("ttft_delta_pct")

        if ui_mismatched:
            add_check(
                "ui.contradiction",
                "J17",
                "fail",
                "FAIL_UI_SUMMARY_CONTRADICTION",
                f"ui_summary contradicts raw evidence on: {', '.join(ui_mismatched)}.",
                ("$.ui_summary",),
            )
        else:
            add_check(
                "ui.consistent",
                "J17",
                "pass",
                "PASS_VERIFIED",
                "ui_summary agrees with raw-derived values.",
                ("$.ui_summary",),
            )

    # Final verdict computation.
    if not any(c.status in ("fail", "no_verdict") for c in checks):
        add_check(
            "overall.verified",
            "J1",
            "pass",
            "PASS_VERIFIED",
            "All schema, digest, provenance, join, KV generation, pre-dispatch, equivalence, performance, exclusion, and sanitization invariants passed.",
            ("$",),
        )
        final_verdict = Verdict.PASS
        reason_codes_final: tuple[str, ...] = ("PASS_VERIFIED",)
        verified_status = claimed_status
    else:
        final_verdict = compute_verdict(reason_codes)
        reason_codes_final = tuple(sorted(set(reason_codes)))
        verified_status = claimed_status if claimed_status in ("local_only", "incomplete") else "unverified"

    ranks_verified = sorted(
        {
            r.get("rank_id")
            for arm_val in paired_runs.values()
            if isinstance(arm_val, dict)
            for r in (arm_val.get("ranks") or [])
            if isinstance(r, dict) and isinstance(r.get("rank_id"), int)
        }
    )
    provenance_summary = {
        "gpu_model": gpu_model if isinstance(gpu_model, str) else None,
        "gpu_count": gpu_count if isinstance(gpu_count, int) else 0,
        "tp_size_verified": tp_size if isinstance(tp_size, int) else 0,
        "ranks_verified": ranks_verified,
        "vllm_sha": source.get("vllm_sha") if isinstance(source.get("vllm_sha"), str) else None,
        "patch_sha256": patch_sha if isinstance(patch_sha, str) else None,
        "selected_runtime_backend": selected_backend if isinstance(selected_backend, str) else None,
        "command_receipts_verified": 0,
    }
    nf = paired_runs.get("native_fault_injected") if isinstance(paired_runs.get("native_fault_injected"), dict) else {}
    impact_summary = {
        "foreign_block_stopped_before_dispatch": bool(raw_foreign_stopped),
        "native_fault_entered_dispatch": bool(nf.get("entered_attention_dispatch") is True),
        "clean_equivalence_within_tolerance": bool(raw_equiv_passed),
        "allowed_after_fault_completed": bool(raw_allowed_completed),
        "ttft_delta_pct": ttft_delta_pct_raw,
        "ttft_sample_count": ttft_sample_count_raw,
    }
    excl_list: list[str] = []
    for item in exclusions.get("unmediated_boundaries") or []:
        if isinstance(item, str):
            excl_list.append(item)
    for item in exclusions.get("limitations") or []:
        if isinstance(item, str):
            excl_list.append(item)
    for up in unsupported_entries:
        if isinstance(up, dict) and isinstance(up.get("path_name"), str):
            excl_list.append(f"{up['path_name']}={up.get('status')}: {up.get('reason')}")

    return ArtifactVerificationReport(
        verdict=final_verdict,
        reason_codes=reason_codes_final,
        run_id=run_id,
        artifact_sha256_declared=declared_sha,
        artifact_sha256_computed=computed_sha,
        claimed_evidence_status=claimed_status,
        verified_evidence_status=verified_status,
        checks=tuple(checks),
        sanitizer_result=san_res,
        signature_result=sig_res,
        ui_present=ui_present,
        ui_consistent=len(ui_mismatched) == 0,
        ui_mismatched_fields=tuple(ui_mismatched),
        provenance_summary=provenance_summary,
        impact_summary=impact_summary,
        exclusions=tuple(excl_list),
    )
