"""
Tests CLI exit codes (0=PASS, 1=FAIL, 2=NO VERDICT, 3=ERROR/invalid invocation),
JSON stdout discipline, stderr diagnostics, and TypeScript verifier parity.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

REPO_ROOT = Path(__file__).resolve().parents[3]
PKG_SRC = REPO_ROOT / "packages" / "evidence-verifier" / "src"
TS_DIST = REPO_ROOT / "packages" / "evidence-verifier" / "ts" / "dist" / "index.js"
FIXTURES = REPO_ROOT / "verification" / "fixtures"


def _run_cli(args: list[str]) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(PKG_SRC)
    return subprocess.run(
        [sys.executable, "-m", "evidence_verifier", *args],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
    )


def test_cli_exit_codes_distinct() -> None:
    tr = str(FIXTURES / "ephemeral_test_trust_root.json")

    # 0 = PASS
    p_pass = _run_cli(["verify", str(FIXTURES / "valid_h200_tp8.json"), "--trust-root", tr, "--require-signature"])
    assert p_pass.returncode == 0
    out_pass = json.loads(p_pass.stdout)
    assert out_pass["verdict"] == "PASS"
    assert out_pass["exit_code"] == 0

    # 1 = FAIL
    p_fail = _run_cli(["verify", str(FIXTURES / "adversarial" / "mut_wrong_tenant_accepted.json"), "--trust-root", tr])
    assert p_fail.returncode == 1
    out_fail = json.loads(p_fail.stdout)
    assert out_fail["verdict"] == "FAIL"
    assert "FAIL_SCOPE_CROSS_TENANT_ACCEPTED" in out_fail["reason_codes"]

    # 2 = NO VERDICT
    p_nv = _run_cli(["verify", str(FIXTURES / "local_only.json"), "--trust-root", tr])
    assert p_nv.returncode == 2
    out_nv = json.loads(p_nv.stdout)
    assert out_nv["verdict"] == "NO VERDICT"
    assert "NV_STATUS_LOCAL_ONLY" in out_nv["reason_codes"]

    # 3 = Invalid invocation / missing file
    p_err = _run_cli(["verify", str(FIXTURES / "does_not_exist.json")])
    assert p_err.returncode == 3
    assert p_err.stderr.strip() != ""
    out_err = json.loads(p_err.stdout)
    assert out_err["verdict"] == "ERROR"


def test_cli_verify_run_mutate_sanitize_explain(tmp_path: Path) -> None:
    tr = str(FIXTURES / "ephemeral_test_trust_root.json")

    # verify-run
    p_run = _run_cli(
        [
            "verify-run",
            str(FIXTURES / "run_dirs" / "valid_h200_tp8_run"),
            "--trust-root",
            tr,
            "--require-signature",
            "--out-dir",
            str(tmp_path),
        ]
    )
    assert p_run.returncode == 0
    assert json.loads(p_run.stdout)["verdict"] == "PASS"

    # mutate --campaign all
    p_mut = _run_cli(["mutate", str(FIXTURES / "valid_h200_tp8.json"), "--campaign", "all"])
    assert p_mut.returncode == 0
    mut_out = json.loads(p_mut.stdout)
    assert mut_out["all_passed"] is True
    assert mut_out["matched_cases"] == mut_out["total_cases"] >= 31

    # sanitize clean & dirty
    p_san_ok = _run_cli(["sanitize", str(FIXTURES / "valid_h200_tp8.json")])
    assert p_san_ok.returncode == 0
    assert json.loads(p_san_ok.stdout)["verdict"] == "PASS"

    p_san_bad = _run_cli(["sanitize", str(FIXTURES / "adversarial" / "mut_secret_leak.json")])
    assert p_san_bad.returncode == 1
    assert json.loads(p_san_bad.stdout)["verdict"] == "FAIL"

    # explain
    p_exp = _run_cli(["explain", "FAIL_VIOLATION_ENTERED_DISPATCH"])
    assert p_exp.returncode == 0
    assert json.loads(p_exp.stdout)["verdict"] == "FAIL"


def test_ts_verifier_bridge_and_local_checks() -> None:
    script = (
        f"import {{ verifyArtifactDigestAndSummaryLocal, runPythonVerifierCli }} from {json.dumps(str(TS_DIST))};"
        "import fs from 'node:fs';"
        f"const localRaw = fs.readFileSync({json.dumps(str(FIXTURES / 'local_only.json'))}, 'utf8');"
        "const localRes = verifyArtifactDigestAndSummaryLocal(localRaw);"
        f"const uiBadRaw = fs.readFileSync({json.dumps(str(FIXTURES / 'adversarial' / 'mut_one_byte_digest.json'))}, 'utf8');"
        "const uiBadRes = verifyArtifactDigestAndSummaryLocal(uiBadRaw);"
        "const cliRes = runPythonVerifierCli({"
        f"  verifierPackageSrc: {json.dumps(str(PKG_SRC))},"
        f"  artifactPath: {json.dumps(str(FIXTURES / 'valid_h200_tp8.json'))},"
        f"  trustRootPath: {json.dumps(str(FIXTURES / 'ephemeral_test_trust_root.json'))},"
        "  requireSignature: true"
        "});"
        "console.log(JSON.stringify({ localRes, uiBadRes, cliVerdict: cliRes.verdict, cliExit: cliRes.exit_code }));"
    )
    out = subprocess.check_output(["node", "--input-type=module", "-e", script], text=True)
    parsed = json.loads(out)
    assert parsed["localRes"]["verdict"] == "NO VERDICT"
    assert "NV_STATUS_LOCAL_ONLY" in parsed["localRes"]["reasonCodes"]
    assert parsed["uiBadRes"]["verdict"] == "FAIL"
    assert "FAIL_DIGEST_MISMATCH" in parsed["uiBadRes"]["reasonCodes"]
    assert parsed["cliVerdict"] == "PASS"
    assert parsed["cliExit"] == 0
