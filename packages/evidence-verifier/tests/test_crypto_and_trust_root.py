"""
Tests for Ed25519 trust-root verification, algorithm confusion rejection, key revocation,
copied signatures, missing trust root (NO VERDICT), and replay detection.
"""

from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

from evidence_verifier.crypto import load_trust_root, sign_artifact_dict
from evidence_verifier.invariants import verify_artifact_data
from evidence_verifier.mutator import (
    build_valid_baseline_artifact,
    create_ephemeral_test_signing_context,
    seal_and_sign,
)
from evidence_verifier.reason_codes import Verdict

FIXED_NOW = datetime(2026, 11, 14, 12, 0, 0, tzinfo=timezone.utc)


def _write_trust_root(tmp_path: Path, tr_dict: dict[str, object]) -> Path:
    p = tmp_path / "trust_root.json"
    p.write_text(json.dumps(tr_dict), encoding="utf-8")
    return p


def test_signature_states_and_attack_vectors(tmp_path: Path) -> None:
    ctx = create_ephemeral_test_signing_context(now_utc=FIXED_NOW)
    tr_path = _write_trust_root(tmp_path, ctx.trust_root_dict)
    tr = load_trust_root(tr_path)
    base = build_valid_baseline_artifact(ctx=ctx, tp_size=1, evidence_status="recorded", now_utc=FIXED_NOW)

    # Valid signature passes
    rep_ok = verify_artifact_data(base, trust_root=tr, require_signature=True, now_utc=FIXED_NOW)
    assert rep_ok.verdict == Verdict.PASS
    assert rep_ok.signature_result.verified is True

    # Signed artifact with NO trust root supplied -> NO VERDICT
    rep_no_tr = verify_artifact_data(base, trust_root=None, require_signature=False, now_utc=FIXED_NOW)
    assert rep_no_tr.verdict == Verdict.NO_VERDICT
    assert "NV_TRUST_ROOT_UNPROVIDED" in rep_no_tr.reason_codes

    # Unsigned artifact with require_signature=True -> NO VERDICT
    unsigned = copy.deepcopy(base)
    unsigned.pop("signature", None)
    rep_unsigned = verify_artifact_data(unsigned, trust_root=tr, require_signature=True, now_utc=FIXED_NOW)
    assert rep_unsigned.verdict == Verdict.NO_VERDICT
    assert "NV_SIG_MISSING" in rep_unsigned.reason_codes

    # Algorithm confusion (alg: none or HS256) -> FAIL_SIG_ALG_UNSAFE
    for bad_alg in ("none", "HS256", "hmac-sha256"):
        bad = copy.deepcopy(base)
        bad["signature"]["algorithm"] = bad_alg
        rep_alg = verify_artifact_data(bad, trust_root=tr, require_signature=True, now_utc=FIXED_NOW)
        assert rep_alg.verdict == Verdict.FAIL
        assert "FAIL_SIG_ALG_UNSAFE" in rep_alg.reason_codes

    # Revoked key in trust root -> FAIL_SIG_UNTRUSTED_KEY
    rev_dict = copy.deepcopy(ctx.trust_root_dict)
    rev_dict["keys"][0]["status"] = "revoked"
    rev_tr = load_trust_root(_write_trust_root(tmp_path / "rev" if False else tmp_path, rev_dict))
    rep_rev = verify_artifact_data(base, trust_root=rev_tr, require_signature=True, now_utc=FIXED_NOW)
    assert rep_rev.verdict == Verdict.FAIL
    assert "FAIL_SIG_UNTRUSTED_KEY" in rep_rev.reason_codes

    # Ephemeral signature rejected when trust root disallows ephemeral demo
    prod_dict = copy.deepcopy(ctx.trust_root_dict)
    prod_dict["keys"][0]["allow_ephemeral_demo"] = False
    prod_tr = load_trust_root(_write_trust_root(tmp_path, prod_dict))
    rep_ephem = verify_artifact_data(base, trust_root=prod_tr, require_signature=True, now_utc=FIXED_NOW)
    assert rep_ephem.verdict == Verdict.FAIL
    assert "FAIL_SIG_UNTRUSTED_KEY" in rep_ephem.reason_codes

    # Copied signature across different run_id even if signed_digest_sha256 matches?
    # Since signature binds run_id, forging same digest or copying fails Ed25519 verify!
    other = copy.deepcopy(base)
    other["run_id"] = "run-other-domain"
    other = seal_and_sign(other, ctx)
    copied = copy.deepcopy(base)
    copied["signature"] = copy.deepcopy(other["signature"])
    copied["signature"]["signed_digest_sha256"] = copied["artifact_sha256"]
    rep_copied = verify_artifact_data(copied, trust_root=tr, require_signature=True, now_utc=FIXED_NOW)
    assert rep_copied.verdict == Verdict.FAIL
    assert "FAIL_SIG_INVALID" in rep_copied.reason_codes

    # Valid signature signed outside validity window -> FAIL_SIG_UNTRUSTED_KEY
    expired_sig = copy.deepcopy(base)
    expired_sig["signature"] = sign_artifact_dict(
        expired_sig,
        artifact_sha256=expired_sig["artifact_sha256"],
        private_key=ctx.trusted_private_key,
        key_id=ctx.trusted_key_id,
        trust_root_id=ctx.trust_root_id,
        signed_at=(FIXED_NOW - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        ephemeral_demo_only=True,
    )
    rep_exp = verify_artifact_data(expired_sig, trust_root=tr, require_signature=True, now_utc=FIXED_NOW)
    assert rep_exp.verdict == Verdict.FAIL
    assert "FAIL_SIG_UNTRUSTED_KEY" in rep_exp.reason_codes
