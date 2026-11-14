"""
Tests cross-field invariants, adversarial corpus expectations (all 35 JSON fixtures),
mutation campaign runner, and property-based KV block ABA lifecycle state machine tests.
"""

from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import random

from evidence_verifier.crypto import load_trust_root
from evidence_verifier.invariants import verify_artifact_data
from evidence_verifier.mutator import (
    build_valid_baseline_artifact,
    create_ephemeral_test_signing_context,
    run_mutation_campaign,
    seal_and_sign,
)
from evidence_verifier.reason_codes import Verdict
from evidence_verifier.strict_json import StrictJsonError, parse_strict_json_bytes

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "verification" / "fixtures"
FIXED_NOW = datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc)


def test_full_committed_fixture_corpus(tmp_path: Path) -> None:
    expectations = json.loads((FIXTURES / "corpus_expectations.json").read_text(encoding="utf-8"))
    tr = load_trust_root(FIXTURES / "ephemeral_test_trust_root.json")
    base_tp8 = json.loads((FIXTURES / "valid_h200_tp8.json").read_text(encoding="utf-8"))
    seen_ledger = tmp_path / "seen_run_ids.json"
    seen_ledger.write_text(json.dumps({base_tp8["run_id"]: base_tp8["artifact_sha256"]}), encoding="utf-8")

    for entry in expectations["json_fixtures"]:
        fpath = FIXTURES / entry["file"]
        raw_bytes = fpath.read_bytes()
        try:
            parsed = parse_strict_json_bytes(raw_bytes)
        except StrictJsonError as exc:
            assert entry["expected_verdict"] == "FAIL", f"{entry['file']} unexpected parse error"
            assert exc.reason_code == entry["expected_reason_code"], f"{entry['file']} got {exc.reason_code}"
            continue

        rep = verify_artifact_data(
            parsed,
            trust_root=tr,
            require_signature=bool(entry.get("require_signature", False)),
            seen_run_ids_path=seen_ledger if entry.get("use_seen_ledger") else None,
            now_utc=FIXED_NOW,
        )
        assert rep.verdict.value == entry["expected_verdict"], (
            f"{entry['file']}: expected {entry['expected_verdict']}, got {rep.verdict.value} ({rep.reason_codes})"
        )
        assert entry["expected_reason_code"] in rep.reason_codes, (
            f"{entry['file']}: expected {entry['expected_reason_code']} in {rep.reason_codes}"
        )


def test_mutation_campaign_all_passes(tmp_path: Path) -> None:
    ctx = create_ephemeral_test_signing_context(now_utc=FIXED_NOW)
    tr_path = tmp_path / "tr.json"
    tr_path.write_text(json.dumps(ctx.trust_root_dict), encoding="utf-8")
    tr = load_trust_root(tr_path)
    base8 = build_valid_baseline_artifact(ctx=ctx, tp_size=8, evidence_status="recorded", now_utc=FIXED_NOW)
    campaign_res = run_mutation_campaign(base8, campaign="all", trust_root=tr, signing_ctx=ctx, tmp_dir=tmp_path)
    assert campaign_res["all_passed"] is True
    assert campaign_res["matched_cases"] == campaign_res["total_cases"] >= 31


def test_unsupported_schema_version_yields_no_verdict() -> None:
    art = json.loads((FIXTURES / "valid_h200_tp1.json").read_text(encoding="utf-8"))
    art["schema_version"] = "inference-proof.v99"
    tr = load_trust_root(FIXTURES / "ephemeral_test_trust_root.json")
    rep = verify_artifact_data(art, trust_root=tr, now_utc=FIXED_NOW)
    assert rep.verdict == Verdict.NO_VERDICT
    assert rep.reason_codes == ("NV_UNSUPPORTED_SCHEMA_VERSION",)


def test_property_kv_aba_lifecycle_generation_sequences(tmp_path: Path) -> None:
    """Property test: randomized free/reallocate transitions without gen increment must FAIL."""
    ctx = create_ephemeral_test_signing_context(now_utc=FIXED_NOW)
    tr_path = tmp_path / "tr.json"
    tr_path.write_text(json.dumps(ctx.trust_root_dict), encoding="utf-8")
    tr = load_trust_root(tr_path)
    base = build_valid_baseline_artifact(ctx=ctx, tp_size=1, evidence_status="recorded", now_utc=FIXED_NOW)
    rng = random.Random(42)

    for trial in range(15):
        art = copy.deepcopy(base)
        # Valid strictly monotonic ABA reallocations on blk-birch-001
        gen = 2
        seq = 3
        transitions = list(art["block_lifecycle"][0]["transitions"])
        for step in range(rng.randint(1, 5)):
            ts1 = (FIXED_NOW - timedelta(seconds=115 - step * 2)).strftime("%Y-%m-%dT%H:%M:%SZ")
            ts2 = (FIXED_NOW - timedelta(seconds=114 - step * 2)).strftime("%Y-%m-%dT%H:%M:%SZ")
            transitions.append(
                {
                    "seq": seq,
                    "from_state": "readable",
                    "to_state": "free",
                    "allocation_generation": gen,
                    "owner_scope": "UNASSIGNED",
                    "policy_epoch": 0,
                    "transitioned_at": ts1,
                    "correlation_id": f"corr-free-{trial}-{step}",
                }
            )
            seq += 1
            # On odd trials, reuse same generation (ABA bug!) -> must FAIL
            if trial % 2 == 1 and step == 0:
                next_gen = gen
            else:
                gen += 1
                next_gen = gen
            transitions.append(
                {
                    "seq": seq,
                    "from_state": "free",
                    "to_state": "readable",
                    "allocation_generation": next_gen,
                    "owner_scope": "scope:birch",
                    "policy_epoch": 1,
                    "transitioned_at": ts2,
                    "correlation_id": f"corr-realloc-{trial}-{step}",
                }
            )
            seq += 1

        art["block_lifecycle"][0]["transitions"] = transitions
        # Update active generation to latest valid gen on even trials
        if trial % 2 == 0:
            art["block_lifecycle"][0]["allocation_generation"] = gen
            art["paired_runs"]["native_clean"]["referenced_blocks"][0]["allocation_generation"] = gen
            art["paired_runs"]["native_fault_injected"]["referenced_blocks"][0]["allocation_generation"] = gen
            art["paired_runs"]["vervain_clean"]["referenced_blocks"][0]["allocation_generation"] = gen
            art["paired_runs"]["vervain_fault_injected"]["referenced_blocks"][0]["allocation_generation"] = gen
            art["paired_runs"]["vervain_allowed_after_fault"]["referenced_blocks"][0]["allocation_generation"] = gen
            for dec in art["scope_decisions"]:
                if dec["physical_block_alias"] == "blk-birch-001":
                    dec["allocation_generation"] = gen

        sealed = seal_and_sign(art, ctx)
        rep = verify_artifact_data(sealed, trust_root=tr, require_signature=True, now_utc=FIXED_NOW)
        if trial % 2 == 1:
            assert rep.verdict == Verdict.FAIL
            assert "FAIL_BLOCK_STALE_GENERATION" in rep.reason_codes
        else:
            assert rep.verdict == Verdict.PASS, f"Even trial {trial} failed: {rep.reason_codes}"
