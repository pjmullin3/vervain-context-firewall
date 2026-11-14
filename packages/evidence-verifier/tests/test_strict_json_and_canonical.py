"""
Tests for strict RFC 8259 parser, RFC 8785 JCS canonicalization, and Python-vs-Node differential parity.
"""

from __future__ import annotations

import json
from pathlib import Path
import random
import subprocess
import pytest

from evidence_verifier.schema_validator import validate_against_schema
from evidence_verifier.strict_json import (
    MAX_SAFE_INT,
    StrictJsonError,
    canonicalize_jcs,
    compute_artifact_sha256,
    parse_strict_json_bytes,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
TS_DIST = REPO_ROOT / "packages" / "evidence-verifier" / "ts" / "dist" / "index.js"
FIXTURES = REPO_ROOT / "verification" / "fixtures"


@pytest.mark.parametrize(
    ("raw_text", "expected_code"),
    [
        ('{"a":1,"a":2}', "FAIL_CANON_DUPLICATE_KEY"),
        ('{"status":"fail","\\u0073tatus":"pass"}', "FAIL_CANON_DUPLICATE_KEY"),
        ('{"__proto__":{"x":1}}', "FAIL_CANON_PROTOTYPE_KEY"),
        ('{"nested":{"constructor":1}}', "FAIL_CANON_PROTOTYPE_KEY"),
        ('{"nested":[{"prototype":1}]}', "FAIL_CANON_PROTOTYPE_KEY"),
        ('{"x":NaN}', "FAIL_CANON_NONFINITE_NUMBER"),
        ('{"x":Infinity}', "FAIL_CANON_NONFINITE_NUMBER"),
        ('{"x":-Infinity}', "FAIL_CANON_NONFINITE_NUMBER"),
        ('{"x":1e400}', "FAIL_CANON_NONFINITE_NUMBER"),
        ('{"x":-0.0}', "FAIL_CANON_NEGATIVE_ZERO"),
        ('{"x":-0}', "FAIL_CANON_NEGATIVE_ZERO"),
        (f'{{"x":{MAX_SAFE_INT + 1}}}', "FAIL_CANON_INT_OVERFLOW"),
        ('{"x":"abc\\u0000def"}', "FAIL_CANON_UNICODE_OR_NUL"),
        ('{"x":"bad\\ud800"}', "FAIL_CANON_UNICODE_OR_NUL"),
        ('{"x":1} trailing', "FAIL_PARSE_SYNTAX"),
        ('{"x":01}', "FAIL_PARSE_SYNTAX"),
    ],
)
def test_strict_json_rejects_parser_differentials(raw_text: str, expected_code: str) -> None:
    with pytest.raises(StrictJsonError) as exc_info:
        parse_strict_json_bytes(raw_text.encode("utf-8"))
    assert exc_info.value.reason_code == expected_code


def test_strict_json_rejects_bom_and_excessive_depth() -> None:
    bom_bytes = b"\xef\xbb\xbf" + b'{"a":1}'
    with pytest.raises(StrictJsonError) as exc_info:
        parse_strict_json_bytes(bom_bytes)
    assert exc_info.value.reason_code == "FAIL_PARSE_SYNTAX"

    deep = ("[" * 70) + "1" + ("]" * 70)
    with pytest.raises(StrictJsonError) as exc_info2:
        parse_strict_json_bytes(deep.encode("utf-8"))
    assert exc_info2.value.reason_code == "FAIL_PARSE_SYNTAX"


def test_strict_schema_rejects_float_for_integer() -> None:
    art = json.loads((FIXTURES / "valid_h200_tp1.json").read_text(encoding="utf-8"))
    art["runtime_manifest"]["tp_size"] = 1.0
    errs = validate_against_schema(art, "inference-proof.v1.schema.json")
    assert any(e.reason_code == "FAIL_CANON_FLOAT_INT_MISMATCH" for e in errs)


def test_differential_jcs_python_vs_node_property() -> None:
    """Property test: Python JCS canonicalizer and Node.js JCS produce identical bytes & SHA-256."""
    assert TS_DIST.is_file(), "TS verifier dist must be built"
    rng = random.Random(20261114)
    cases: list[object] = [
        {"z": 1, "a": 2, "b": [0, 1e-7, 1e21, 3.141592653589793, -42.5, True, False, None]},
        {"\U0001f600": "astral", "\uffff": "bmp_max", "a\nb\tc": "ctrl"},
    ]
    for _ in range(25):
        cases.append(
            {
                f"k_{rng.randint(10, 99)}": rng.choice([0, 1, -1, 123456, 0.00000125, 1e-8, 1e22, "val"]),
                "nested": {
                    "b": [rng.randint(-1000, 1000) for _ in range(4)],
                    "a": rng.choice(["hello", "caf\u00e9", "line1\nline2"]),
                },
            }
        )

    py_outputs = [canonicalize_jcs(c) for c in cases]
    script = (
        f"import {{ canonicalizeJcs }} from {json.dumps(str(TS_DIST))};"
        f"const cases = {json.dumps(cases)};"
        "console.log(JSON.stringify(cases.map(c => canonicalizeJcs(c))));"
    )
    node_out = subprocess.check_output(["node", "--input-type=module", "-e", script], text=True)
    ts_outputs = json.loads(node_out)
    assert py_outputs == ts_outputs

    # Also verify artifact_sha256 matches identically on valid_h200_tp8.json
    tp8_raw = (FIXTURES / "valid_h200_tp8.json").read_text(encoding="utf-8")
    tp8_obj = parse_strict_json_bytes(tp8_raw.encode("utf-8"))
    py_sha = compute_artifact_sha256(tp8_obj)
    ts_script = (
        f"import {{ computeArtifactSha256, parseStrictJson }} from {json.dumps(str(TS_DIST))};"
        f"import fs from 'node:fs';"
        f"const raw = fs.readFileSync({json.dumps(str(FIXTURES / 'valid_h200_tp8.json'))}, 'utf8');"
        "const obj = parseStrictJson(raw);"
        "console.log(computeArtifactSha256(obj));"
    )
    ts_sha = subprocess.check_output(["node", "--input-type=module", "-e", ts_script], text=True).strip()
    assert py_sha == ts_sha == tp8_obj["artifact_sha256"]
