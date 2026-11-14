"""
Responsibility: Loads versioned JSON Schemas and enforces strict Draft 2020-12 structural
validation including strict integer-vs-float differentiation.
Trust boundary: Rejects unsupported schema versions with NO VERDICT and malformed structures with FAIL.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, TypeChecker, validators

SUPPORTED_INFERENCE_PROOF_VERSION = "inference-proof.v1"


def _find_schemas_dir() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "schemas" / "verification"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("Could not locate schemas/verification directory.")


def _strict_is_integer(checker: TypeChecker, instance: Any) -> bool:
    # Unlike standard JSON Schema Draft 2020-12, reject 1.0 (float) for integer fields.
    return isinstance(instance, int) and not isinstance(instance, bool)


def _strict_is_number(checker: TypeChecker, instance: Any) -> bool:
    return isinstance(instance, (int, float)) and not isinstance(instance, bool)


STRICT_TYPE_CHECKER = Draft202012Validator.TYPE_CHECKER.redefine_many(
    {
        "integer": _strict_is_integer,
        "number": _strict_is_number,
    }
)
StrictValidator = validators.extend(Draft202012Validator, type_checker=STRICT_TYPE_CHECKER)


@dataclass(frozen=True)
class SchemaValidationFinding:
    json_path: str
    message: str
    reason_code: str


def load_schema(schema_filename: str) -> dict[str, Any]:
    schema_path = _find_schemas_dir() / schema_filename
    return json.loads(schema_path.read_text(encoding="utf-8"))


def validate_against_schema(
    instance: Any,
    schema_filename: str,
) -> list[SchemaValidationFinding]:
    """Validates instance against a named JSON Schema under strict int-vs-float typing."""
    schema = load_schema(schema_filename)
    validator = StrictValidator(schema)
    findings: list[SchemaValidationFinding] = []
    for err in sorted(validator.iter_errors(instance), key=lambda e: (list(e.path), e.message)):
        ptr = "$." + ".".join(str(p) for p in err.path) if err.path else "$"
        if err.validator == "type" and err.validator_value == "integer" and isinstance(err.instance, float):
            code = "FAIL_CANON_FLOAT_INT_MISMATCH"
        else:
            code = "FAIL_SCHEMA_INVALID"
        findings.append(SchemaValidationFinding(json_path=ptr, message=err.message, reason_code=code))
    return findings
