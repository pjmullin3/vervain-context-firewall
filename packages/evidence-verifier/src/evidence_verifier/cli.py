"""
Responsibility: Deterministic machine-readable CLI entrypoint (`evidence-verifier`).
Supports `verify`, `verify-run`, `mutate`, `sanitize`, and `explain` with exit codes 0/1/2/3.
Trust boundary: Writes canonical JSON to stdout and diagnostics to stderr; never echoes secrets.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict
from pathlib import Path
import sys
import tempfile
from typing import Sequence

from .crypto import TrustRootError, load_trust_root
from .invariants import verify_artifact_data
from .mutator import run_mutation_campaign
from .reason_codes import EXIT_CODE_BY_VERDICT, REASON_CODES, Verdict, explain_reason_code
from .renderer import render_verification_markdown, render_verifier_result_dict
from .run_dir import verify_run_directory
from .sanitizer import sanitize_structure, sanitize_text
from .strict_json import StrictJsonError, canonicalize_jcs, parse_strict_json_bytes


def _load_forbidden_strings(path: Path | None) -> list[str]:
    if path is None:
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith("#")]


def _emit_json(obj: object) -> None:
    sys.stdout.write(canonicalize_jcs(obj) + "\n")


def _emit_error(code: str, message: str) -> int:
    sys.stderr.write(f"[evidence-verifier] {code}: {message}\n")
    _emit_json({"verdict": Verdict.ERROR.value, "exit_code": 3, "reason_code": code, "message": message})
    return 3


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="evidence-verifier",
        description="Independent, deterministic verifier for Vervain inference-security artifacts.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_ver = sub.add_parser("verify", help="Verify an inference-proof.v1 artifact JSON file.")
    p_ver.add_argument("artifact", type=Path)
    p_ver.add_argument("--trust-root", type=Path, default=None)
    p_ver.add_argument("--require-signature", action="store_true")
    p_ver.add_argument("--seen-run-ids", type=Path, default=None)
    p_ver.add_argument("--forbidden-strings-file", type=Path, default=None)
    p_ver.add_argument("--format", choices=("json", "markdown"), default="json")

    p_run = sub.add_parser("verify-run", help="Independently verify a RUN_DIR and emit verification.json/md.")
    p_run.add_argument("run_dir", type=Path)
    p_run.add_argument("--trust-root", type=Path, default=None)
    p_run.add_argument("--require-signature", action="store_true")
    p_run.add_argument("--seen-run-ids", type=Path, default=None)
    p_run.add_argument("--forbidden-strings-file", type=Path, default=None)
    p_run.add_argument("--out-dir", type=Path, default=None)
    p_run.add_argument("--no-write", action="store_true")

    p_mut = sub.add_parser("mutate", help="Run adversarial mutation campaign against a baseline artifact.")
    p_mut.add_argument("artifact", type=Path)
    p_mut.add_argument("--campaign", default="all")
    p_mut.add_argument("--trust-root", type=Path, default=None)

    p_san = sub.add_parser("sanitize", help="Scan an artifact for secrets, planted values, or protected content.")
    p_san.add_argument("artifact", type=Path)
    p_san.add_argument("--forbidden-strings-file", type=Path, default=None)

    p_exp = sub.add_parser("explain", help="Explain a machine-readable verifier reason code.")
    p_exp.add_argument("reason_code", type=str)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(list(argv) if argv is not None else None)
    except SystemExit as exc:
        code = int(exc.code) if isinstance(exc.code, int) else 3
        return 3 if code != 0 else 0

    try:
        if args.command == "explain":
            if args.reason_code == "ALL":
                _emit_json({"codes": {k: asdict(v) for k, v in sorted(REASON_CODES.items())}})
                return 0
            spec = explain_reason_code(args.reason_code)
            if spec is None:
                return _emit_error("VERIFIER_ERROR_CLI_ARGS", f"Unknown reason code: {args.reason_code!r}")
            _emit_json(
                {
                    "code": spec.code,
                    "verdict": spec.verdict.value,
                    "severity": spec.severity,
                    "category": spec.category,
                    "invariant": spec.invariant,
                    "distinction_rule": spec.distinction_rule,
                    "remediation": spec.remediation,
                }
            )
            return 0

        if args.command == "sanitize":
            if not args.artifact.is_file():
                return _emit_error("VERIFIER_ERROR_IO", f"Artifact file not found: {args.artifact}")
            forbidden = _load_forbidden_strings(args.forbidden_strings_file)
            raw_bytes = args.artifact.read_bytes()
            text = raw_bytes.decode("utf-8", errors="replace")
            try:
                parsed = parse_strict_json_bytes(raw_bytes)
                struct_res = sanitize_structure(parsed, forbidden_strings=forbidden)
                findings = list(struct_res.findings)
                rules_checked = struct_res.rules_checked
            except StrictJsonError:
                text_res = sanitize_text(text, source_name=args.artifact.name, forbidden_strings=forbidden)
                findings = list(text_res.findings)
                rules_checked = text_res.rules_checked
            dedup = sorted(
                {(f.rule_id, f.json_pointer, f.reason_code, f.redacted_preview) for f in findings},
                key=lambda x: (x[2], x[1], x[0]),
            )
            passed = len(dedup) == 0
            verdict = Verdict.PASS if passed else Verdict.FAIL
            _emit_json(
                {
                    "schema_version": "sanitizer-result.v1",
                    "verdict": verdict.value,
                    "exit_code": EXIT_CODE_BY_VERDICT[verdict],
                    "reason_code": "PASS_SANITIZE_CLEAN" if passed else dedup[0][2],
                    "passed": passed,
                    "rules_checked": rules_checked,
                    "finding_count": len(dedup),
                    "findings": [
                        {
                            "rule_id": r,
                            "json_pointer": ptr,
                            "reason_code": rc,
                            "redacted_preview": prev,
                        }
                        for r, ptr, rc, prev in dedup
                    ],
                }
            )
            return EXIT_CODE_BY_VERDICT[verdict]

        trust_root = None
        if getattr(args, "trust_root", None) is not None:
            trust_root = load_trust_root(args.trust_root)

        if args.command == "verify":
            if not args.artifact.is_file():
                return _emit_error("VERIFIER_ERROR_IO", f"Artifact file not found: {args.artifact}")
            forbidden = _load_forbidden_strings(args.forbidden_strings_file)
            raw_bytes = args.artifact.read_bytes()
            try:
                parsed = parse_strict_json_bytes(raw_bytes)
            except StrictJsonError as exc:
                # Even on syntax failure, run text sanitizer so secret leaks are flagged safely.
                text_san = sanitize_text(
                    raw_bytes.decode("utf-8", errors="replace"),
                    source_name=args.artifact.name,
                    forbidden_strings=forbidden,
                )
                codes = [exc.reason_code] + [f.reason_code for f in text_san.findings]
                _emit_json(
                    {
                        "schema_version": "verifier-result.v1",
                        "verdict": Verdict.FAIL.value,
                        "exit_code": 1,
                        "primary_reason_code": exc.reason_code,
                        "reason_codes": sorted(set(codes)),
                        "target_type": "artifact",
                        "target_path": str(args.artifact),
                        "detail": exc.message,
                    }
                )
                return 1

            report = verify_artifact_data(
                parsed,
                trust_root=trust_root,
                require_signature=args.require_signature,
                seen_run_ids_path=args.seen_run_ids,
                forbidden_strings=forbidden,
            )
            res_dict = render_verifier_result_dict(
                report,
                target_type="artifact",
                target_path=str(args.artifact),
                forbidden_strings=forbidden,
            )
            if args.format == "markdown":
                sys.stdout.write(render_verification_markdown(res_dict, forbidden_strings=forbidden))
            else:
                _emit_json(res_dict)
            return EXIT_CODE_BY_VERDICT[report.verdict]

        if args.command == "verify-run":
            if not args.run_dir.is_dir():
                return _emit_error("VERIFIER_ERROR_IO", f"RUN_DIR not found: {args.run_dir}")
            forbidden = _load_forbidden_strings(args.forbidden_strings_file)
            out = verify_run_directory(
                args.run_dir,
                trust_root=trust_root,
                require_signature=args.require_signature,
                seen_run_ids_path=args.seen_run_ids,
                forbidden_strings=forbidden,
                out_dir=args.out_dir,
                write_outputs=not args.no_write,
            )
            _emit_json(out.result_dict)
            return EXIT_CODE_BY_VERDICT[out.verdict]

        if args.command == "mutate":
            if not args.artifact.is_file():
                return _emit_error("VERIFIER_ERROR_IO", f"Baseline artifact not found: {args.artifact}")
            parsed = parse_strict_json_bytes(args.artifact.read_bytes())
            if not isinstance(parsed, dict):
                return _emit_error("VERIFIER_ERROR_CLI_ARGS", "Baseline artifact must be a JSON object.")
            with tempfile.TemporaryDirectory() as tmp:
                campaign_res = run_mutation_campaign(
                    parsed,
                    campaign=args.campaign,
                    trust_root=trust_root,
                    tmp_dir=Path(tmp),
                )
            _emit_json(campaign_res)
            return 0 if campaign_res["all_passed"] else 1

        return _emit_error("VERIFIER_ERROR_CLI_ARGS", f"Unknown command: {args.command}")
    except TrustRootError as exc:
        return _emit_error(exc.reason_code, exc.message)
    except OSError as exc:
        return _emit_error("VERIFIER_ERROR_IO", str(exc))
    except Exception as exc:
        return _emit_error("VERIFIER_ERROR_INTERNAL", f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
