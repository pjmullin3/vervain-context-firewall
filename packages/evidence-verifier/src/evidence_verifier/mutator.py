"""
Responsibility: Red-team fixture generator and security-critical mutation campaign engine.
Produces valid H200 TP1/TP8, local_only, incomplete, and 30+ adversarial mutations across
all verifier invariants and asserts that every mutation triggers its exact expected verdict
and reason code.
Trust boundary: Uses only synthetic tenants (Alder, Birch) and ephemeral test signing keys.
"""

from __future__ import annotations

import base64
import copy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from typing import Any, Callable

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .crypto import TrustRoot, load_trust_root, sign_artifact_dict
from .invariants import verify_artifact_data
from .reason_codes import Verdict
from .strict_json import StrictJsonError, canonicalize_jcs, compute_artifact_sha256, parse_strict_json_bytes


@dataclass(frozen=True)
class MutationCase:
    case_id: str
    campaign: str
    description: str
    expected_verdict: Verdict
    expected_reason_code: str
    mutate_fn: Callable[[dict[str, Any], "SigningContext"], dict[str, Any] | str]
    use_untrusted_root: bool = False
    require_signature: bool = False
    use_seen_ledger: bool = False


@dataclass(frozen=True)
class SigningContext:
    trusted_private_key: Ed25519PrivateKey
    trusted_key_id: str
    trust_root_id: str
    trust_root_dict: dict[str, Any]
    untrusted_private_key: Ed25519PrivateKey


def create_ephemeral_test_signing_context(now_utc: datetime | None = None) -> SigningContext:
    """Creates an isolated Ed25519 signing context strictly for local fixture/mutation tests."""
    now = now_utc or datetime.now(timezone.utc)
    priv = Ed25519PrivateKey.generate()
    pub_b64 = base64.b64encode(priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode("ascii")
    untrusted_priv = Ed25519PrivateKey.generate()

    tr_id = "vervain-test-trust-root-v1"
    key_id = "vervain-test-ed25519-01"
    tr_dict = {
        "schema_version": "trust-root.v1",
        "trust_root_id": tr_id,
        "keys": [
            {
                "key_id": key_id,
                "algorithm": "ed25519",
                "public_key_b64": pub_b64,
                "status": "active",
                "purpose": "inference-proof-signing",
                "not_before": (now - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "not_after": (now + timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "allow_ephemeral_demo": True,
            }
        ],
    }
    return SigningContext(
        trusted_private_key=priv,
        trusted_key_id=key_id,
        trust_root_id=tr_id,
        trust_root_dict=tr_dict,
        untrusted_private_key=untrusted_priv,
    )


def _sha_label(label: str) -> str:
    return hashlib.sha256(label.encode("utf-8")).hexdigest()


def _sha1_label(label: str) -> str:
    return hashlib.sha1(label.encode("utf-8")).hexdigest()


def seal_and_sign(artifact: dict[str, Any], ctx: SigningContext | None = None, *, signed_at: str | None = None) -> dict[str, Any]:
    """Recomputes canonical artifact_sha256 and optionally signs the artifact."""
    out = copy.deepcopy(artifact)
    out.pop("signature", None)
    out["artifact_sha256"] = compute_artifact_sha256(out)
    if ctx is not None:
        out["signature"] = sign_artifact_dict(
            out,
            artifact_sha256=out["artifact_sha256"],
            private_key=ctx.trusted_private_key,
            key_id=ctx.trusted_key_id,
            trust_root_id=ctx.trust_root_id,
            signed_at=signed_at or out["finished_at"],
            ephemeral_demo_only=True,
        )
    return out


def build_valid_baseline_artifact(
    *,
    ctx: SigningContext | None = None,
    tp_size: int = 8,
    evidence_status: str = "recorded",
    now_utc: datetime | None = None,
) -> dict[str, Any]:
    """Constructs a complete, internally consistent H200 (TP1 or TP8) synthetic proof artifact."""
    now = now_utc or datetime.now(timezone.utc)
    t0 = (now - timedelta(seconds=120)).strftime("%Y-%m-%dT%H:%M:%SZ")
    t1 = (now - timedelta(seconds=100)).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_env_iss = (now - timedelta(seconds=130)).strftime("%Y-%m-%dT%H:%M:%SZ")
    t_env_exp = (now + timedelta(seconds=300)).strftime("%Y-%m-%dT%H:%M:%SZ")

    run_id = f"run-vervain-h200-tp{tp_size}-001"
    vllm_sha = _sha1_label("vllm-pinned-commit-0.28.0")
    git_sha = _sha1_label("vervain-carbon-evidence-head")
    patch_sha = _sha_label("vllm-scoped-kv-firewall.patch.v1")
    trace_sha = _sha_label("SOURCE_TRACE.md.v1")
    cfg_digest = _sha_label("seed42-bf16-flashattn-qwen")
    backend = "FLASH_ATTN"
    gpu_model = "NVIDIA H200" if evidence_status in ("live", "recorded") else "NONE_LOCAL_ONLY"
    gpu_count = tp_size if evidence_status in ("live", "recorded") else 0
    gpu_uuids = [_sha_label(f"GPU-H200-UUID-{r}") for r in range(gpu_count)]

    alder_scope = "scope:alder"
    birch_scope = "scope:birch"

    # Physical blocks per rank
    block_lifecycle: list[dict[str, Any]] = []
    for r in range(tp_size):
        block_lifecycle.append(
            {
                "physical_block_alias": "blk-birch-001",
                "allocation_generation": 2,
                "owner_scope": birch_scope,
                "policy_epoch": 1,
                "state": "readable",
                "cache_key_digest": _sha_label("birch-prefix-key"),
                "rank_id": r,
                "transitions": [
                    {
                        "seq": 0,
                        "from_state": "none",
                        "to_state": "free",
                        "allocation_generation": 1,
                        "owner_scope": "UNASSIGNED",
                        "policy_epoch": 0,
                        "transitioned_at": (now - timedelta(seconds=118)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "correlation_id": f"corr-init-birch-r{r}",
                    },
                    {
                        "seq": 1,
                        "from_state": "free",
                        "to_state": "reserved",
                        "allocation_generation": 2,
                        "owner_scope": birch_scope,
                        "policy_epoch": 1,
                        "transitioned_at": (now - timedelta(seconds=117)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "correlation_id": f"corr-alloc-birch-r{r}",
                    },
                    {
                        "seq": 2,
                        "from_state": "reserved",
                        "to_state": "readable",
                        "allocation_generation": 2,
                        "owner_scope": birch_scope,
                        "policy_epoch": 1,
                        "transitioned_at": (now - timedelta(seconds=116)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "correlation_id": f"corr-ready-birch-r{r}",
                    },
                ],
            }
        )
        block_lifecycle.append(
            {
                "physical_block_alias": "blk-alder-foreign-009",
                "allocation_generation": 3,
                "owner_scope": alder_scope,
                "policy_epoch": 1,
                "state": "readable",
                "cache_key_digest": _sha_label("alder-secret-prefix-key"),
                "rank_id": r,
                "transitions": [
                    {
                        "seq": 0,
                        "from_state": "free",
                        "to_state": "readable",
                        "allocation_generation": 3,
                        "owner_scope": alder_scope,
                        "policy_epoch": 1,
                        "transitioned_at": (now - timedelta(seconds=115)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "correlation_id": f"corr-ready-alder-r{r}",
                    }
                ],
            }
        )

    arms_spec = [
        ("native_clean", "req-nc-01", 114, 113, "completed", True, False, [{"physical_block_alias": "blk-birch-001", "allocation_generation": 2}], "unmediated_native", None),
        ("native_fault_injected", "req-nf-02", 112, 111, "contaminated_control_completed", True, True, [{"physical_block_alias": "blk-birch-001", "allocation_generation": 2}, {"physical_block_alias": "blk-alder-foreign-009", "allocation_generation": 3}], "unmediated_native", None),
        ("vervain_clean", "req-vc-03", 110, 109, "completed", True, False, [{"physical_block_alias": "blk-birch-001", "allocation_generation": 2}], "allow", "allow"),
        ("vervain_fault_injected", "req-vf-04", 108, 107, "blocked_fail_closed", False, True, [{"physical_block_alias": "blk-birch-001", "allocation_generation": 2}, {"physical_block_alias": "blk-alder-foreign-009", "allocation_generation": 3}], "deny_fail_closed", "deny_scope_mismatch"),
        ("vervain_allowed_after_fault", "req-va-05", 106, 105, "completed", True, False, [{"physical_block_alias": "blk-birch-001", "allocation_generation": 2}], "allow", "allow"),
    ]

    paired_runs: dict[str, Any] = {}
    scope_decisions: list[dict[str, Any]] = []
    backend_dispatch: list[dict[str, Any]] = []
    chain_events: list[dict[str, Any]] = []
    genesis = _sha_label("genesis:" + run_id)
    prev_sha = genesis

    for ev_idx, (arm_id, req_id, s_off, e_off, outcome, entered, injected, ref_blocks, rank_dec, disp_type) in enumerate(arms_spec):
        arm_start = (now - timedelta(seconds=s_off)).strftime("%Y-%m-%dT%H:%M:%SZ")
        arm_end = (now - timedelta(seconds=e_off)).strftime("%Y-%m-%dT%H:%M:%SZ")
        dec_ts = (now - timedelta(seconds=s_off)).strftime("%Y-%m-%dT%H:%M:%SZ")

        rank_records: list[dict[str, Any]] = []
        for r in range(tp_size):
            primary_dref: str | None = None
            if arm_id.startswith("vervain_"):
                for b in ref_blocks:
                    balias = str(b["physical_block_alias"])
                    bgen = int(b["allocation_generation"])
                    is_foreign = balias == "blk-alder-foreign-009"
                    did = f"dec-{arm_id}-r{r}-{balias}"
                    if not is_foreign and primary_dref is None:
                        primary_dref = did
                    if is_foreign:
                        primary_dref = did
                    scope_decisions.append(
                        {
                            "decision_id": did,
                            "request_id": req_id,
                            "rank_id": r,
                            "physical_block_alias": balias,
                            "allocation_generation": bgen,
                            "request_scope": birch_scope,
                            "block_scope": alder_scope if is_foreign else birch_scope,
                            "policy_epoch": 1,
                            "block_policy_epoch": 1,
                            "decision_point": "pre_attention_dispatch_guard",
                            "disposition": "deny_scope_mismatch" if is_foreign else "allow",
                            "public_basis": "not_applicable",
                            "token_equality_used_for_public": False,
                            "decided_at": dec_ts,
                            "envelope_issued_at": t_env_iss,
                            "envelope_expires_at": t_env_exp,
                        }
                    )

            backend_dispatch.append(
                {
                    "span_id": f"span-{arm_id}-r{r}",
                    "request_id": req_id,
                    "rank_id": r,
                    "selected_backend": backend,
                    "entered_attention_dispatch": entered,
                    "blocked_before_dispatch": not entered,
                    "dispatched_at": arm_end if entered else None,
                    "checked_at": dec_ts,
                    "decision_ref": primary_dref,
                }
            )

            rank_records.append(
                {
                    "rank_id": r,
                    "worker_id": f"worker-r{r}",
                    "gpu_uuid_sha256": gpu_uuids[r] if r < len(gpu_uuids) else None,
                    "loaded_patch_sha256": patch_sha if arm_id.startswith("vervain_") else None,
                    "enforced_decision": rank_dec,
                    "decision_ref": primary_dref,
                    "entered_attention_dispatch": entered,
                }
            )

        out_sha = _sha_label("clean-output-seed42") if arm_id in ("native_clean", "vervain_clean", "vervain_allowed_after_fault") else (
            _sha_label("contaminated-output") if arm_id == "native_fault_injected" else None
        )
        paired_runs[arm_id] = {
            "arm_id": arm_id,
            "request_id": req_id,
            "request_scope": birch_scope,
            "policy_epoch": 1,
            "seed": 42,
            "config_digest": cfg_digest,
            "started_at": arm_start,
            "finished_at": arm_end,
            "outcome": outcome,
            "output_sha256": out_sha,
            "entered_attention_dispatch": entered,
            "foreign_block_injected": injected,
            "referenced_blocks": ref_blocks,
            "ranks": rank_records,
        }

        ev_sha = _sha_label(f"{prev_sha}:{run_id}:{req_id}:{outcome}")
        chain_events.append(
            {
                "event_index": ev_idx,
                "run_id": run_id,
                "request_id": req_id,
                "event_type": f"arm_{arm_id}",
                "recorded_at": arm_end,
                "prev_sha256": prev_sha,
                "event_sha256": ev_sha,
                "canonical_event_sha256": ev_sha,
            }
        )
        prev_sha = ev_sha

    perf_cfg = {
        "gpu_model": gpu_model,
        "gpu_count": gpu_count,
        "model_id": "Qwen/Qwen2.5-72B-Instruct",
        "model_revision": "rev-pinned-20261114",
        "selected_runtime_backend": backend,
        "kv_dtype": "bf16",
        "block_size": 16,
        "prefix_caching": True,
        "graph_mode": "eager",
        "tp_size": tp_size,
        "prompt_tokens": 2048,
        "output_tokens": 64,
        "concurrency": 1,
        "warmup_count": 5,
        "sample_count": 30,
    }

    def mk_metric(b: float, c: float, p50_b: float, p50_c: float, p95_b: float, p95_c: float, unit: str) -> dict[str, Any]:
        d_abs = round(c - b, 6)
        d_pct = round((d_abs / b) * 100.0, 6)
        return {
            "p50": {"baseline": p50_b, "candidate": p50_c},
            "p95": {"baseline": p95_b, "candidate": p95_c},
            "abs_baseline": b,
            "abs_candidate": c,
            "delta_abs": d_abs,
            "delta_pct": d_pct,
            "denominator": b,
            "unit": unit,
            "sample_count": 30,
            "warmup_count": 5,
        }

    artifact: dict[str, Any] = {
        "schema_version": "inference-proof.v1",
        "evidence_status": evidence_status,
        "run_id": run_id,
        "started_at": t0,
        "finished_at": t1,
        "source": {
            "git_sha": git_sha,
            "git_dirty": False,
            "vllm_sha": vllm_sha,
            "patch_sha256": patch_sha,
            "patch_path": "engine/patches/vllm-scoped-kv-firewall.patch",
            "loaded_modules": [
                {
                    "module_name": "vervain_scope.backend_guard",
                    "file_path": "vervain_scope/backend_guard.py",
                    "file_sha256": _sha_label("vervain_scope/backend_guard.py"),
                }
            ],
            "trace_sha256": trace_sha,
        },
        "runtime_manifest": {
            "gpu_model": gpu_model,
            "gpu_count": gpu_count,
            "gpu_uuids_sha256": gpu_uuids,
            "topology": f"TP{tp_size}" if evidence_status in ("live", "recorded") else "LOCAL_CPU",
            "driver_version": "565.57.01" if evidence_status in ("live", "recorded") else None,
            "cuda_version": "12.6" if evidence_status in ("live", "recorded") else None,
            "torch_version": "2.6.0",
            "triton_version": "3.2.0" if evidence_status in ("live", "recorded") else None,
            "vllm_version": "0.28.0",
            "flash_attn_version": "2.7.2" if evidence_status in ("live", "recorded") else None,
            "flashinfer_version": "disabled",
            "python_version": "3.12.7",
            "model_id": "Qwen/Qwen2.5-72B-Instruct",
            "model_revision": "rev-pinned-20261114",
            "tokenizer_revision": "tok-pinned-20261114",
            "configured_backend": backend,
            "selected_runtime_backend": backend,
            "kv_dtype": "bf16",
            "block_size": 16,
            "prefix_caching": True,
            "graph_mode": "eager",
            "tp_size": tp_size,
            "cp_size": 1,
            "speculation": "disabled",
            "offload": "disabled",
            "swap": "disabled",
            "kv_connector": "disabled",
            "launch_command_sanitized": [
                "vllm",
                "serve",
                "Qwen/Qwen2.5-72B-Instruct",
                "--tensor-parallel-size",
                str(tp_size),
                "--enforce-eager",
            ],
            "host_id_digest": _sha_label("h200-cluster-node-01"),
            "nccl_version": "2.23.4" if tp_size > 1 else None,
            "nccl_transport_digest": _sha_label("nccl-nvlink-h200") if tp_size > 1 else None,
        },
        "trust_boundary": {
            "guard_mode": "strict-host",
            "public_client_can_supply_scope": False,
            "scope_envelope_integrity": "hmac_sha256_server_side",
            "mediated_boundaries": ["gateway_admission", "pre_attention_dispatch_guard"],
            "claim_scope": "Controlled synthetic fault injection on named H200 configuration only.",
        },
        "scenario": {
            "scenario_id": "alder-birch-kv-fault-v1",
            "synthetic_only": True,
            "injection_type": "controlled_engine_internal_post_auth_substitution",
            "tenants": [
                {"tenant_alias": "Alder", "scope_id": alder_scope},
                {"tenant_alias": "Birch", "scope_id": birch_scope},
            ],
            "foreign_block_alias": "blk-alder-foreign-009",
            "foreign_owner_scope": alder_scope,
            "victim_request_scope": birch_scope,
            "placeholder_notice": "NO GPU RUN RECORDED" if evidence_status == "local_only" else None,
        },
        "paired_runs": paired_runs,
        "scope_decisions": scope_decisions,
        "block_lifecycle": block_lifecycle,
        "backend_dispatch": backend_dispatch,
        "correctness": {
            "seed": 42,
            "config_digest": cfg_digest,
            "equivalence_tolerance": 1e-5,
            "measured_max_abs_delta": 0.0,
            "clean_equivalence_passed": True,
            "planted_value_influence_probe": {
                "probe_id": "probe-alder-planted-01",
                "planted_value_sha256": _sha_label("synthetic-planted-secret-for-probe-only"),
                "raw_planted_value_omitted": True,
                "native_fault_injected_influence_score": 0.42,
                "baseline_nonzero_influence": True,
                "vervain_fault_injected_influence_score": 0.0,
                "vervain_zero_or_blocked": True,
            },
            "allowed_after_fault_completed_after_violation": True,
            "violating_request_id": "req-vf-04",
            "allowed_after_fault_request_id": "req-va-05",
        },
        "performance": {
            "baseline_config": perf_cfg,
            "candidate_config": copy.deepcopy(perf_cfg),
            "interleaved_order": True,
            "startup_compile_ms": {"baseline": 4120.0, "candidate": 4185.0},
            "metrics": {
                "ttft_ms": mk_metric(48.0, 48.6, 47.5, 48.1, 52.0, 52.8, "ms"),
                "itl_ms": mk_metric(12.0, 12.1, 11.9, 12.0, 13.5, 13.6, "ms"),
                "req_per_sec": mk_metric(10.0, 9.9, 10.0, 9.9, 9.4, 9.3, "req/s"),
                "tok_per_sec": mk_metric(640.0, 633.6, 640.0, 633.6, 601.6, 595.2, "tok/s"),
                "peak_gpu_mem_mb": mk_metric(74200.0, 74212.0, 74200.0, 74212.0, 74250.0, 74262.0, "MB"),
                "guard_us": mk_metric(10.0, 18.0, 9.5, 17.8, 12.0, 22.0, "us"),
                "mismatch_us": mk_metric(10.0, 14.0, 9.5, 13.8, 12.0, 17.0, "us"),
            },
        },
        "receipt_chain": {
            "chain_algorithm": "sha256",
            "genesis_sha256": genesis,
            "head_sha256": prev_sha,
            "event_count": len(chain_events),
            "events": chain_events,
        },
        "exclusions": {
            "unsupported_paths": [
                {"path_name": "kv_connector", "status": "disabled", "reason": "Disaggregated KV connectors are out of scope."},
                {"path_name": "cudagraph_full", "status": "disabled", "reason": "Eager mode enforced for exact per-step block validation."},
            ],
            "unmediated_boundaries": [
                "Provider-internal Gemini memory",
                "Physical GPU HBM byte zeroization after free",
            ],
            "limitations": [
                "Controlled internal post-auth substitution test on pinned vLLM commit only.",
                "Does not establish universal isolation across uninstrumented kernels.",
            ],
            "synthetic_injection_disclosure": "Synthetic tenants Alder and Birch with controlled internal block substitution.",
        },
        "artifact_sha256": "0" * 64,
        "ui_summary": {
            "evidence_status": evidence_status,
            "foreign_block_stopped": True,
            "clean_equivalence_passed": True,
            "allowed_after_fault_completed": True,
            "selected_runtime_backend": backend,
            "gpu_model": gpu_model,
            "tp_size": tp_size,
            "ttft_delta_pct": 1.25,
        },
    }
    return seal_and_sign(artifact, ctx)


def get_mutation_catalog() -> list[MutationCase]:
    """Returns the complete 31-case adversarial mutation suite."""

    def m_one_byte_digest(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["correctness"]["seed"] = 43  # flip without re-hashing
        return d

    def m_untrusted_sig(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["signature"] = sign_artifact_dict(
            d,
            artifact_sha256=d["artifact_sha256"],
            private_key=ctx.untrusted_private_key,
            key_id="unknown-rogue-key-99",
            trust_root_id=ctx.trust_root_id,
            signed_at=d["finished_at"],
            ephemeral_demo_only=True,
        )
        return d

    def m_copied_sig(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        other = copy.deepcopy(art)
        other["run_id"] = "run-other-999"
        other_sealed = seal_and_sign(other, ctx)
        d = copy.deepcopy(art)
        d["signature"] = other_sealed["signature"]
        return d

    def m_missing_sig(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d.pop("signature", None)
        return d

    def m_replayed_run_id(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        return copy.deepcopy(art)

    def m_future_ts(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["started_at"] = "2099-01-01T00:00:00Z"
        d["finished_at"] = "2099-01-01T00:01:00Z"
        return seal_and_sign(d, ctx)

    def m_reversed_ts(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["started_at"], d["finished_at"] = d["finished_at"], d["started_at"]
        return seal_and_sign(d, ctx)

    def m_h200_no_manifest(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["runtime_manifest"]["gpu_count"] = 0
        d["runtime_manifest"]["gpu_uuids_sha256"] = []
        d["runtime_manifest"]["driver_version"] = None
        return seal_and_sign(d, ctx)

    def m_backend_mismatch(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["runtime_manifest"]["configured_backend"] = "FLASH_ATTN"
        d["runtime_manifest"]["selected_runtime_backend"] = "TRITON_ATTN"
        return seal_and_sign(d, ctx)

    def m_patch_sha_mismatch(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["paired_runs"]["vervain_clean"]["ranks"][0]["loaded_patch_sha256"] = _sha_label("different-patch")
        return seal_and_sign(d, ctx)

    def m_missing_gen(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["evidence_status"] = "incomplete"
        d["ui_summary"]["evidence_status"] = "incomplete"
        d["paired_runs"]["vervain_clean"]["referenced_blocks"][0]["allocation_generation"] = None
        return seal_and_sign(d, ctx)

    def m_stale_gen_reuse(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        # Reassign blk-birch-001 to gen=5 while scope_decisions still allows gen=2
        d["block_lifecycle"].append(
            {
                "physical_block_alias": "blk-birch-001",
                "allocation_generation": 5,
                "owner_scope": "scope:birch",
                "policy_epoch": 1,
                "state": "readable",
                "cache_key_digest": _sha_label("birch-new-gen5"),
                "rank_id": 0,
                "transitions": [
                    {
                        "seq": 0,
                        "from_state": "free",
                        "to_state": "readable",
                        "allocation_generation": 5,
                        "owner_scope": "scope:birch",
                        "policy_epoch": 1,
                        "transitioned_at": d["started_at"],
                        "correlation_id": "corr-gen5",
                    }
                ],
            }
        )
        return seal_and_sign(d, ctx)

    def m_wrong_tenant_accepted(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        for dec in d["scope_decisions"]:
            if dec["request_id"] == "req-vf-04" and dec["block_scope"] == "scope:alder":
                dec["disposition"] = "allow"
                break
        return seal_and_sign(d, ctx)

    def m_public_token_equality(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["scope_decisions"][0]["block_scope"] = "PUBLIC"
        d["scope_decisions"][0]["public_basis"] = "token_equality"
        d["scope_decisions"][0]["token_equality_used_for_public"] = True
        return seal_and_sign(d, ctx)

    def m_violation_dispatched(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        for sp in d["backend_dispatch"]:
            if sp["request_id"] == "req-vf-04":
                sp["entered_attention_dispatch"] = True
                sp["blocked_before_dispatch"] = False
                sp["dispatched_at"] = d["finished_at"]
                break
        return seal_and_sign(d, ctx)

    def m_allowed_also_blocked(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["paired_runs"]["vervain_allowed_after_fault"]["outcome"] = "blocked_fail_closed"
        d["paired_runs"]["vervain_allowed_after_fault"]["entered_attention_dispatch"] = False
        return seal_and_sign(d, ctx)

    def m_allowed_before_violation(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        vf = d["paired_runs"]["vervain_fault_injected"]
        va = d["paired_runs"]["vervain_allowed_after_fault"]
        vf["started_at"], va["started_at"] = va["started_at"], vf["started_at"]
        vf["finished_at"], va["finished_at"] = va["finished_at"], vf["finished_at"]
        return seal_and_sign(d, ctx)

    def m_seed_mismatch(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["paired_runs"]["vervain_clean"]["seed"] = 99
        return seal_and_sign(d, ctx)

    def m_perf_hw_mismatch(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["performance"]["candidate_config"]["gpu_model"] = "NVIDIA A100"
        return seal_and_sign(d, ctx)

    def m_p95_few_samples(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["performance"]["baseline_config"]["sample_count"] = 5
        d["performance"]["candidate_config"]["sample_count"] = 5
        d["performance"]["metrics"]["ttft_ms"]["sample_count"] = 5
        return seal_and_sign(d, ctx)

    def m_percent_missing_abs(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["performance"]["metrics"]["ttft_ms"]["abs_baseline"] = None
        d["performance"]["metrics"]["ttft_ms"]["denominator"] = None
        return seal_and_sign(d, ctx)

    def m_tp8_missing_ranks(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["evidence_status"] = "incomplete"
        d["ui_summary"]["evidence_status"] = "incomplete"
        d["paired_runs"]["vervain_clean"]["ranks"] = d["paired_runs"]["vervain_clean"]["ranks"][:4]
        return seal_and_sign(d, ctx)

    def m_rank_disagreement(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["paired_runs"]["vervain_fault_injected"]["ranks"][1]["entered_attention_dispatch"] = True
        d["paired_runs"]["vervain_fault_injected"]["ranks"][1]["enforced_decision"] = "allow"
        return seal_and_sign(d, ctx)

    def m_unsupported_omitted(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["runtime_manifest"]["kv_connector"] = "nixl_v1"
        d["exclusions"]["unsupported_paths"] = []
        return seal_and_sign(d, ctx)

    def m_local_mislabeled_live(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["evidence_status"] = "live"
        d["scenario"]["placeholder_notice"] = "NO GPU RUN RECORDED"
        return seal_and_sign(d, ctx)

    def m_placeholder_metric(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["performance"]["metrics"]["itl_ms"]["abs_candidate"] = "TBD"
        return seal_and_sign(d, ctx)

    def m_nonfinite_raw(art: dict[str, Any], ctx: SigningContext) -> str:
        raw = canonicalize_jcs(art)
        return raw.replace('"measured_max_abs_delta":0', '"measured_max_abs_delta":NaN')

    def m_negative_latency(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["performance"]["metrics"]["ttft_ms"]["abs_candidate"] = -4.2
        return seal_and_sign(d, ctx)

    def m_secret_leak(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["exclusions"]["limitations"].append("leaked_key=AIzaSyDummySecretKeyForSanitizerTest12345")
        return seal_and_sign(d, ctx)

    def m_ui_contradiction(art: dict[str, Any], ctx: SigningContext) -> dict[str, Any]:
        d = copy.deepcopy(art)
        d["paired_runs"]["vervain_fault_injected"]["outcome"] = "completed"
        d["paired_runs"]["vervain_fault_injected"]["entered_attention_dispatch"] = True
        d["ui_summary"]["foreign_block_stopped"] = True
        return seal_and_sign(d, ctx)

    def m_duplicate_key_raw(art: dict[str, Any], ctx: SigningContext) -> str:
        raw = canonicalize_jcs(art)
        return raw.replace('"evidence_status":"recorded"', '"evidence_status":"incomplete","evidence_status":"recorded"', 1)

    return [
        MutationCase("mut_one_byte_digest", "digest", "Changed field without updating artifact_sha256", Verdict.FAIL, "FAIL_DIGEST_MISMATCH", m_one_byte_digest),
        MutationCase("mut_untrusted_signature", "signature", "Valid digest signed by untrusted key", Verdict.FAIL, "FAIL_SIG_UNTRUSTED_KEY", m_untrusted_sig),
        MutationCase("mut_copied_signature", "signature", "Signature copied from another run_id", Verdict.FAIL, "FAIL_SIG_REPLAY_OR_COPIED", m_copied_sig),
        MutationCase("mut_missing_signature", "signature", "Signature missing when required", Verdict.NO_VERDICT, "NV_SIG_MISSING", m_missing_sig, require_signature=True),
        MutationCase("mut_replayed_run_id", "provenance", "Replayed run_id present in seen ledger", Verdict.FAIL, "FAIL_RUN_ID_REPLAYED", m_replayed_run_id, use_seen_ledger=True),
        MutationCase("mut_future_timestamp", "timestamps", "Future timestamp beyond clock skew", Verdict.FAIL, "FAIL_TIMESTAMP_FUTURE", m_future_ts),
        MutationCase("mut_reversed_timestamps", "timestamps", "finished_at < started_at", Verdict.FAIL, "FAIL_TIMESTAMP_REVERSED", m_reversed_ts),
        MutationCase("mut_h200_missing_gpu_manifest", "provenance", "Claimed H200 with zero GPU manifest", Verdict.FAIL, "FAIL_GPU_MANIFEST_CONTRADICTION", m_h200_no_manifest),
        MutationCase("mut_backend_mismatch", "backend", "Configured backend differs from runtime backend", Verdict.FAIL, "FAIL_BACKEND_INTENT_MISMATCH", m_backend_mismatch),
        MutationCase("mut_patch_sha_mismatch", "provenance", "Rank loaded patch SHA differs from source", Verdict.FAIL, "FAIL_PATCH_DIGEST_MISMATCH", m_patch_sha_mismatch),
        MutationCase("mut_missing_generation", "generations", "Missing allocation_generation on incomplete run", Verdict.NO_VERDICT, "NV_MISSING_ALLOCATION_GENERATION", m_missing_gen),
        MutationCase("mut_stale_generation_reuse", "generations", "Stale generation admitted after newer allocation", Verdict.FAIL, "FAIL_BLOCK_STALE_GENERATION", m_stale_gen_reuse),
        MutationCase("mut_wrong_tenant_accepted", "isolation", "Alder foreign block allowed for Birch request", Verdict.FAIL, "FAIL_SCOPE_CROSS_TENANT_ACCEPTED", m_wrong_tenant_accepted),
        MutationCase("mut_public_inferred_token_equality", "isolation", "PUBLIC inferred from token equality", Verdict.FAIL, "FAIL_SCOPE_PUBLIC_INFERRED", m_public_token_equality),
        MutationCase("mut_violating_request_dispatched", "isolation", "Violating request entered attention dispatch", Verdict.FAIL, "FAIL_VIOLATION_ENTERED_DISPATCH", m_violation_dispatched),
        MutationCase("mut_allowed_request_blocked", "isolation", "Allowed follow-up request also blocked", Verdict.FAIL, "FAIL_ALLOWED_REQUEST_BLOCKED", m_allowed_also_blocked),
        MutationCase("mut_allowed_before_violation", "timestamps", "Allowed follow-up timestamp precedes violation", Verdict.FAIL, "FAIL_TIMESTAMP_REVERSED", m_allowed_before_violation),
        MutationCase("mut_equivalence_seed_mismatch", "equivalence", "Clean native vs Vervain compared across different seeds", Verdict.FAIL, "FAIL_CLEAN_SEED_OR_CONFIG_MISMATCH", m_seed_mismatch),
        MutationCase("mut_perf_hw_mismatch", "performance", "Performance baseline vs candidate GPU mismatch", Verdict.FAIL, "FAIL_PERF_CONFIG_MISMATCH", m_perf_hw_mismatch),
        MutationCase("mut_p95_insufficient_samples", "performance", "p95 reported with sample_count=5", Verdict.FAIL, "FAIL_PERF_INSUFFICIENT_SAMPLES", m_p95_few_samples),
        MutationCase("mut_percent_missing_absolutes", "performance", "Percent delta with missing baseline/denominator", Verdict.FAIL, "FAIL_PERF_MISSING_DENOMINATOR", m_percent_missing_abs),
        MutationCase("mut_tp8_missing_ranks", "ranks", "TP8 claim with only 4 enforcing rank records", Verdict.NO_VERDICT, "NV_TP_RANK_EVIDENCE_MISSING", m_tp8_missing_ranks),
        MutationCase("mut_rank_disagreement", "ranks", "Rank 1 disagrees with rank 0 on fault blocking", Verdict.FAIL, "FAIL_TP_RANK_DISAGREEMENT", m_rank_disagreement),
        MutationCase("mut_unsupported_path_omitted", "exclusions", "Active kv_connector omitted from exclusions", Verdict.FAIL, "FAIL_UNSUPPORTED_PATH_OMITTED", m_unsupported_omitted),
        MutationCase("mut_local_mislabeled_live", "provenance", "Local placeholder marker labeled live", Verdict.FAIL, "FAIL_STATUS_LAUNDERING", m_local_mislabeled_live),
        MutationCase("mut_placeholder_metric", "numbers", "Placeholder string TBD in metric", Verdict.FAIL, "FAIL_PLACEHOLDER_METRIC", m_placeholder_metric),
        MutationCase("mut_nonfinite_nan", "numbers", "Raw JSON NaN in measured delta", Verdict.FAIL, "FAIL_CANON_NONFINITE_NUMBER", m_nonfinite_raw),
        MutationCase("mut_negative_latency", "numbers", "Negative latency metric", Verdict.FAIL, "FAIL_PERF_IMPOSSIBLE_METRIC", m_negative_latency),
        MutationCase("mut_secret_leak", "sanitizer", "API key pattern leaked in exclusions", Verdict.FAIL, "FAIL_SECRET_LEAK_KEY_OR_TOKEN", m_secret_leak),
        MutationCase("mut_ui_summary_contradiction", "summary", "ui_summary claims blocked while raw entered dispatch", Verdict.FAIL, "FAIL_UI_SUMMARY_CONTRADICTION", m_ui_contradiction),
        MutationCase("mut_duplicate_json_key", "parse", "Duplicate JSON object key smuggling", Verdict.FAIL, "FAIL_CANON_DUPLICATE_KEY", m_duplicate_key_raw),
    ]


def run_mutation_campaign(
    baseline_artifact: dict[str, Any],
    *,
    campaign: str = "all",
    trust_root: TrustRoot | None = None,
    signing_ctx: SigningContext | None = None,
    tmp_dir: Path | None = None,
) -> dict[str, Any]:
    """Runs selected mutation cases and asserts every mutation triggers its expected verdict & code."""
    ctx = signing_ctx or create_ephemeral_test_signing_context()
    tr = trust_root
    if tr is None and tmp_dir is not None:
        tr_path = tmp_dir / "ephemeral_trust_root.json"
        tr_path.write_text(json.dumps(ctx.trust_root_dict), encoding="utf-8")
        tr = load_trust_root(tr_path)

    # Ensure baseline has a valid signature under ctx if we didn't get an external trust root.
    if trust_root is None:
        base_signed = seal_and_sign(baseline_artifact, ctx)
    else:
        base_signed = copy.deepcopy(baseline_artifact)

    # Prepare temp seen-run-ids ledger if tmp_dir available
    seen_path: Path | None = None
    if tmp_dir is not None:
        seen_path = tmp_dir / "seen_run_ids.json"
        seen_path.write_text(json.dumps({base_signed["run_id"]: base_signed["artifact_sha256"]}), encoding="utf-8")

    catalog = get_mutation_catalog()
    selected = catalog if campaign == "all" else [c for c in catalog if c.campaign == campaign]

    results: list[dict[str, Any]] = []
    passed_count = 0
    for case in selected:
        mutated = case.mutate_fn(base_signed, ctx)
        if isinstance(mutated, str):
            try:
                parse_strict_json_bytes(mutated.encode("utf-8"))
                actual_verdict = Verdict.ERROR
                actual_codes = ("VERIFIER_ERROR_INTERNAL",)
            except StrictJsonError as exc:
                actual_verdict = Verdict.FAIL
                actual_codes = (exc.reason_code,)
        else:
            if case.use_seen_ledger and seen_path is None:
                actual_verdict = Verdict.ERROR
                actual_codes = ("VERIFIER_ERROR_IO",)
            else:
                rep = verify_artifact_data(
                    mutated,
                    trust_root=tr,
                    require_signature=case.require_signature,
                    seen_run_ids_path=seen_path if case.use_seen_ledger else None,
                )
                actual_verdict = rep.verdict
                actual_codes = rep.reason_codes

        matched = (actual_verdict == case.expected_verdict) and (case.expected_reason_code in actual_codes)
        if matched:
            passed_count += 1
        results.append(
            {
                "case_id": case.case_id,
                "campaign": case.campaign,
                "expected_verdict": case.expected_verdict.value,
                "expected_reason_code": case.expected_reason_code,
                "actual_verdict": actual_verdict.value,
                "actual_reason_codes": list(actual_codes),
                "matched": matched,
            }
        )

    all_passed = len(selected) > 0 and passed_count == len(selected)
    return {
        "schema_version": "mutation-campaign.v1",
        "campaign": campaign,
        "total_cases": len(selected),
        "matched_cases": passed_count,
        "all_passed": all_passed,
        "results": results,
    }
