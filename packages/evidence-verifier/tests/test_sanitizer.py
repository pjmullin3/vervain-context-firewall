"""
Tests for zero-echo sanitizer covering forbidden keys, secret regexes, PII,
raw/hex/base64 planted values, high-entropy strings, and safe report rendering.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
import pytest

from evidence_verifier.invariants import verify_artifact_data
from evidence_verifier.reason_codes import Verdict
from evidence_verifier.renderer import render_verification_markdown, render_verifier_result_dict
from evidence_verifier.sanitizer import sanitize_structure, sanitize_text

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "verification" / "fixtures"


@pytest.mark.parametrize(
    ("key_name", "expected_code"),
    [
        ("raw_prompt", "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV"),
        ("plantedValue", "FAIL_PROTECTED_CONTENT_PLANTED_VALUE"),
        ("kv_tensor", "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV"),
        ("api_key", "FAIL_SECRET_LEAK_KEY_OR_TOKEN"),
        ("privateKey", "FAIL_SECRET_LEAK_KEY_OR_TOKEN"),
        ("ip_address", "FAIL_PII_OR_NETWORK_ADDRESS_LEAK"),
        ("emailAddress", "FAIL_PII_OR_NETWORK_ADDRESS_LEAK"),
    ],
)
def test_sanitizer_rejects_forbidden_keys_without_echoing(key_name: str, expected_code: str) -> None:
    secret_payload = "TOP_SECRET_VALUE_SHOULD_NEVER_ECHO_9988"
    res = sanitize_structure({"safe": {key_name: secret_payload}})
    assert not res.passed
    assert any(f.reason_code == expected_code for f in res.findings)
    serialized = json.dumps([f.__dict__ for f in res.findings])
    assert secret_payload not in serialized


def test_sanitizer_detects_planted_value_encodings_and_secrets() -> None:
    planted = "AlderQuarterlyMergeCode771"
    planted_hex = planted.encode("utf-8").hex()
    planted_b64 = base64.b64encode(planted.encode("utf-8")).decode("ascii")
    pem_block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"
    fake_api = "AIzaSyDummySecretKeyForUnitTest987654321"
    fake_email = "alice@alder.example.com"

    for bad_val in (planted, planted_hex, planted_b64, pem_block, fake_api, fake_email):
        res = sanitize_structure({"note": bad_val}, forbidden_strings=[planted])
        assert not res.passed
        serialized = json.dumps([f.__dict__ for f in res.findings])
        assert bad_val not in serialized
        assert planted not in serialized


def test_verifier_and_renderer_never_echo_leaked_secret() -> None:
    art = json.loads((FIXTURES / "valid_h200_tp1.json").read_text(encoding="utf-8"))
    leaked = "sk-proj-UltraSecretLeakedTokenValue1234567890"
    art["exclusions"]["limitations"].append(leaked)
    rep = verify_artifact_data(art, forbidden_strings=["AlderCanary999"])
    assert rep.verdict == Verdict.FAIL
    assert "FAIL_SECRET_LEAK_KEY_OR_TOKEN" in rep.reason_codes

    res_dict = render_verifier_result_dict(rep, target_type="artifact", target_path="test.json")
    md_text = render_verification_markdown(res_dict)
    assert leaked not in json.dumps(res_dict)
    assert leaked not in md_text
    assert sanitize_text(md_text).passed is True
