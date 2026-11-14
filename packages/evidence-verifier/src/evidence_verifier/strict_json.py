"""
Responsibility: Strict RFC 8259 JSON parser (rejecting duplicate keys, NaN/Infinity,
-0.0, integer overflow, lone surrogates, NUL bytes, BOM, prototype keys, excessive nesting)
and independent RFC 8785 (JCS) canonical JSON + SHA-256 computation.
Trust boundary: Untrusted input parser; eliminates producer/consumer parser differentials.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from typing import Any

MAX_SAFE_INT = (1 << 53) - 1  # 9007199254740991 (IEEE-754 exact integer bound)
MIN_SAFE_INT = -MAX_SAFE_INT
DEFAULT_MAX_DEPTH = 64
PROTOTYPE_KEYS = frozenset({"__proto__", "constructor", "prototype"})


@dataclass(frozen=True)
class StrictJsonError(Exception):
    reason_code: str
    message: str
    json_path: str = "$"


def _is_high_surrogate(code: int) -> bool:
    return 0xD800 <= code <= 0xDBFF


def _is_low_surrogate(code: int) -> bool:
    return 0xDC00 <= code <= 0xDFFF


def _scan_raw_json(raw: str, max_depth: int = DEFAULT_MAX_DEPTH) -> None:
    """Performs an independent RFC 8259 token scan to catch parser-differential hazards."""
    if raw.startswith("\ufeff"):
        raise StrictJsonError("FAIL_PARSE_SYNTAX", "UTF-8 BOM is not permitted.")
    if "\x00" in raw:
        raise StrictJsonError("FAIL_CANON_UNICODE_OR_NUL", "Raw NUL byte is not permitted.")

    length = len(raw)
    idx = 0

    def skip_ws() -> None:
        nonlocal idx
        while idx < length and raw[idx] in " \t\n\r":
            idx += 1

    def read_string(path: str) -> str:
        nonlocal idx
        if raw[idx] != '"':
            raise StrictJsonError("FAIL_PARSE_SYNTAX", "Expected opening quote.", path)
        idx += 1
        out: list[str] = []
        while idx < length:
            ch = raw[idx]
            if ch == '"':
                idx += 1
                return "".join(out)
            if ord(ch) < 0x20:
                raise StrictJsonError("FAIL_PARSE_SYNTAX", "Unescaped control character in string.", path)
            if ch == "\\":
                idx += 1
                if idx >= length:
                    raise StrictJsonError("FAIL_PARSE_SYNTAX", "Unterminated escape sequence.", path)
                esc = raw[idx]
                idx += 1
                if esc in ('"', "\\", "/"):
                    out.append(esc)
                elif esc == "b":
                    out.append("\b")
                elif esc == "f":
                    out.append("\f")
                elif esc == "n":
                    out.append("\n")
                elif esc == "r":
                    out.append("\r")
                elif esc == "t":
                    out.append("\t")
                elif esc == "u":
                    if idx + 4 > length:
                        raise StrictJsonError("FAIL_PARSE_SYNTAX", "Incomplete unicode escape.", path)
                    hex_part = raw[idx : idx + 4]
                    try:
                        code = int(hex_part, 16)
                    except ValueError as exc:
                        raise StrictJsonError("FAIL_PARSE_SYNTAX", "Invalid hex in unicode escape.", path) from exc
                    idx += 4
                    if code == 0:
                        raise StrictJsonError("FAIL_CANON_UNICODE_OR_NUL", "NUL escape \\u0000 is forbidden.", path)
                    if _is_high_surrogate(code):
                        if idx + 6 <= length and raw[idx : idx + 2] == "\\u":
                            low_hex = raw[idx + 2 : idx + 6]
                            try:
                                low_code = int(low_hex, 16)
                            except ValueError as exc:
                                raise StrictJsonError(
                                    "FAIL_PARSE_SYNTAX", "Invalid surrogate escape.", path
                                ) from exc
                            if _is_low_surrogate(low_code):
                                idx += 6
                                combined = 0x10000 + ((code - 0xD800) << 10) + (low_code - 0xDC00)
                                out.append(chr(combined))
                                continue
                        raise StrictJsonError("FAIL_CANON_UNICODE_OR_NUL", "Lone high surrogate escape.", path)
                    if _is_low_surrogate(code):
                        raise StrictJsonError("FAIL_CANON_UNICODE_OR_NUL", "Lone low surrogate escape.", path)
                    out.append(chr(code))
                else:
                    raise StrictJsonError("FAIL_PARSE_SYNTAX", "Invalid string escape.", path)
            else:
                code_pt = ord(ch)
                if 0xD800 <= code_pt <= 0xDFFF:
                    raise StrictJsonError("FAIL_CANON_UNICODE_OR_NUL", "Lone surrogate character.", path)
                out.append(ch)
                idx += 1
        raise StrictJsonError("FAIL_PARSE_SYNTAX", "Unterminated JSON string.", path)

    def scan_number(path: str) -> None:
        nonlocal idx
        start = idx
        if raw[idx] == "-":
            idx += 1
        if idx >= length:
            raise StrictJsonError("FAIL_PARSE_SYNTAX", "Invalid number.", path)
        if raw[idx] == "0":
            idx += 1
            if idx < length and raw[idx].isdigit():
                raise StrictJsonError("FAIL_PARSE_SYNTAX", "Leading zero in JSON number.", path)
        elif raw[idx].isdigit():
            while idx < length and raw[idx].isdigit():
                idx += 1
        else:
            raise StrictJsonError("FAIL_PARSE_SYNTAX", "Invalid number syntax.", path)

        is_float = False
        if idx < length and raw[idx] == ".":
            is_float = True
            idx += 1
            if idx >= length or not raw[idx].isdigit():
                raise StrictJsonError("FAIL_PARSE_SYNTAX", "Missing fractional digits.", path)
            while idx < length and raw[idx].isdigit():
                idx += 1

        if idx < length and raw[idx] in ("e", "E"):
            is_float = True
            idx += 1
            if idx < length and raw[idx] in ("+", "-"):
                idx += 1
            if idx >= length or not raw[idx].isdigit():
                raise StrictJsonError("FAIL_PARSE_SYNTAX", "Missing exponent digits.", path)
            while idx < length and raw[idx].isdigit():
                idx += 1

        lexeme = raw[start:idx]
        if is_float:
            try:
                val = float(lexeme)
            except ValueError as exc:
                raise StrictJsonError("FAIL_CANON_NONFINITE_NUMBER", "Invalid float literal.", path) from exc
            if not math.isfinite(val):
                raise StrictJsonError("FAIL_CANON_NONFINITE_NUMBER", "Overflowed non-finite float literal.", path)
            if val == 0.0 and math.copysign(1.0, val) < 0:
                raise StrictJsonError("FAIL_CANON_NEGATIVE_ZERO", "Negative zero (-0.0) is forbidden.", path)
        else:
            if lexeme == "-0":
                raise StrictJsonError("FAIL_CANON_NEGATIVE_ZERO", "Negative zero (-0) is forbidden.", path)
            ival = int(lexeme)
            if ival < MIN_SAFE_INT or ival > MAX_SAFE_INT:
                raise StrictJsonError("FAIL_CANON_INT_OVERFLOW", "Integer exceeds 53-bit IEEE-754 safe bounds.", path)

    def scan_value(depth: int, path: str) -> None:
        nonlocal idx
        if depth > max_depth:
            raise StrictJsonError("FAIL_PARSE_SYNTAX", f"Nesting depth exceeds {max_depth}.", path)
        skip_ws()
        if idx >= length:
            raise StrictJsonError("FAIL_PARSE_SYNTAX", "Unexpected end of JSON input.", path)
        ch = raw[idx]
        if ch == "{":
            idx += 1
            skip_ws()
            if idx < length and raw[idx] == "}":
                idx += 1
                return
            seen_keys: set[str] = set()
            while True:
                skip_ws()
                if idx >= length or raw[idx] != '"':
                    raise StrictJsonError("FAIL_PARSE_SYNTAX", "Expected object key string.", path)
                key = read_string(path)
                key_path = f"{path}.{key}"
                if key in PROTOTYPE_KEYS:
                    raise StrictJsonError("FAIL_CANON_PROTOTYPE_KEY", f"Forbidden prototype key: {key}.", key_path)
                if key in seen_keys:
                    raise StrictJsonError("FAIL_CANON_DUPLICATE_KEY", "Duplicate object key detected.", key_path)
                seen_keys.add(key)
                skip_ws()
                if idx >= length or raw[idx] != ":":
                    raise StrictJsonError("FAIL_PARSE_SYNTAX", "Expected colon after object key.", key_path)
                idx += 1
                scan_value(depth + 1, key_path)
                skip_ws()
                if idx >= length:
                    raise StrictJsonError("FAIL_PARSE_SYNTAX", "Unterminated JSON object.", path)
                if raw[idx] == ",":
                    idx += 1
                    continue
                if raw[idx] == "}":
                    idx += 1
                    return
                raise StrictJsonError("FAIL_PARSE_SYNTAX", "Expected comma or closing brace.", path)
        elif ch == "[":
            idx += 1
            skip_ws()
            if idx < length and raw[idx] == "]":
                idx += 1
                return
            elem_idx = 0
            while True:
                scan_value(depth + 1, f"{path}[{elem_idx}]")
                elem_idx += 1
                skip_ws()
                if idx >= length:
                    raise StrictJsonError("FAIL_PARSE_SYNTAX", "Unterminated JSON array.", path)
                if raw[idx] == ",":
                    idx += 1
                    continue
                if raw[idx] == "]":
                    idx += 1
                    return
                raise StrictJsonError("FAIL_PARSE_SYNTAX", "Expected comma or closing bracket.", path)
        elif ch == '"':
            read_string(path)
        elif raw.startswith("NaN", idx) or raw.startswith("Infinity", idx) or raw.startswith("-Infinity", idx):
            raise StrictJsonError("FAIL_CANON_NONFINITE_NUMBER", "Non-finite numeric literal is forbidden.", path)
        elif ch == "-" or ch.isdigit():
            scan_number(path)
        elif raw.startswith("true", idx):
            idx += 4
        elif raw.startswith("false", idx):
            idx += 5
        elif raw.startswith("null", idx):
            idx += 4
        else:
            raise StrictJsonError("FAIL_PARSE_SYNTAX", "Unexpected token in JSON input.", path)

    scan_value(1, "$")
    skip_ws()
    if idx != length:
        raise StrictJsonError("FAIL_PARSE_SYNTAX", "Trailing characters after JSON root value.", "$")


def _reject_constant(token: str) -> Any:
    raise StrictJsonError("FAIL_CANON_NONFINITE_NUMBER", f"Non-finite constant {token!r} is forbidden.")


def parse_strict_json(raw_text: str, *, max_depth: int = DEFAULT_MAX_DEPTH) -> Any:
    """Strictly parses UTF-8 JSON text rejecting parser-differential constructs."""
    if not isinstance(raw_text, str):
        raise StrictJsonError("FAIL_PARSE_SYNTAX", "Input must be UTF-8 text.")
    _scan_raw_json(raw_text, max_depth=max_depth)
    try:
        return json.loads(raw_text, parse_constant=_reject_constant)
    except StrictJsonError:
        raise
    except Exception as exc:
        raise StrictJsonError("FAIL_PARSE_SYNTAX", f"JSON decode failed: {exc}") from exc


def parse_strict_json_bytes(raw_bytes: bytes, *, max_depth: int = DEFAULT_MAX_DEPTH) -> Any:
    """Decodes UTF-8 strictly (no BOM, no invalid UTF-8) and parses JSON."""
    if raw_bytes.startswith(b"\xef\xbb\xbf"):
        raise StrictJsonError("FAIL_PARSE_SYNTAX", "UTF-8 BOM is not permitted.")
    try:
        text = raw_bytes.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise StrictJsonError("FAIL_PARSE_SYNTAX", f"Invalid UTF-8 bytes: {exc}") from exc
    return parse_strict_json(text, max_depth=max_depth)


def _format_jcs_float(val: float) -> str:
    """Formats an IEEE-754 finite float according to RFC 8785 / ECMAScript Number.toString."""
    if not math.isfinite(val):
        raise StrictJsonError("FAIL_CANON_NONFINITE_NUMBER", "Cannot canonicalize non-finite float.")
    if val == 0.0:
        return "0"

    sign = "-" if val < 0 else ""
    abs_val = abs(val)
    raw = repr(abs_val)

    # Extract significant digits and base-10 exponent from Python's shortest-roundtrip repr.
    if "e" in raw or "E" in raw:
        mantissa_str, exp_str = raw.lower().split("e")
        exp = int(exp_str)
    else:
        mantissa_str = raw
        if "." in mantissa_str:
            int_part, frac_part = mantissa_str.split(".")
            if int_part == "0":
                stripped = frac_part.lstrip("0")
                leading_zeros = len(frac_part) - len(stripped)
                exp = -(leading_zeros + 1)
                mantissa_str = stripped[0] + ("." + stripped[1:] if len(stripped) > 1 else "")
            else:
                exp = len(int_part) - 1
                digits = int_part + frac_part
                mantissa_str = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
        else:
            exp = len(mantissa_str) - 1
            mantissa_str = mantissa_str[0] + ("." + mantissa_str[1:] if len(mantissa_str) > 1 else "")

    digits = mantissa_str.replace(".", "").rstrip("0")
    if not digits:
        return "0"

    k = len(digits)
    n = exp + 1  # number = digits * 10^(n - k)

    if k <= n <= 21:
        return sign + digits + ("0" * (n - k))
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + ("0" * (-n)) + digits
    if k == 1:
        exp_sign = "+" if exp >= 0 else "-"
        return f"{sign}{digits}e{exp_sign}{abs(exp)}"
    exp_sign = "+" if exp >= 0 else "-"
    return f"{sign}{digits[0]}.{digits[1:]}e{exp_sign}{abs(exp)}"


def _escape_jcs_string(value: str) -> str:
    """Escapes a string per RFC 8785 JCS."""
    out: list[str] = ['"']
    for ch in value:
        code = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif code < 0x20:
            out.append(f"\\u{code:04x}")
        else:
            if 0xD800 <= code <= 0xDFFF:
                raise StrictJsonError("FAIL_CANON_UNICODE_OR_NUL", "Lone surrogate in string.")
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonicalize_jcs(value: Any) -> str:
    """Serializes a Python JSON structure to RFC 8785 (JCS) canonical JSON string."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if value < MIN_SAFE_INT or value > MAX_SAFE_INT:
            raise StrictJsonError("FAIL_CANON_INT_OVERFLOW", "Integer exceeds 53-bit safe bounds.")
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise StrictJsonError("FAIL_CANON_NONFINITE_NUMBER", "Non-finite float in canonicalization.")
        if value == 0.0 and math.copysign(1.0, value) < 0:
            raise StrictJsonError("FAIL_CANON_NEGATIVE_ZERO", "Negative zero in canonicalization.")
        return _format_jcs_float(value)
    if isinstance(value, str):
        return _escape_jcs_string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize_jcs(item) for item in value) + "]"
    if isinstance(value, dict):
        # RFC 8785 sorts keys by UTF-16 code units.
        sorted_items = sorted(value.items(), key=lambda kv: kv[0].encode("utf-16-be"))
        parts: list[str] = []
        for k, v in sorted_items:
            if not isinstance(k, str):
                raise StrictJsonError("FAIL_PARSE_SYNTAX", "JSON object keys must be strings.")
            if k in PROTOTYPE_KEYS:
                raise StrictJsonError("FAIL_CANON_PROTOTYPE_KEY", f"Forbidden prototype key: {k}.")
            parts.append(f"{_escape_jcs_string(k)}:{canonicalize_jcs(v)}")
        return "{" + ",".join(parts) + "}"
    raise StrictJsonError("FAIL_PARSE_SYNTAX", f"Unsupported JSON type: {type(value).__name__}")


def compute_canonical_sha256(value: Any, *, exclude_keys: frozenset[str] = frozenset()) -> str:
    """Computes SHA-256 hex digest of RFC 8785 canonical JSON, optionally excluding top-level keys."""
    if isinstance(value, dict) and exclude_keys:
        filtered = {k: v for k, v in value.items() if k not in exclude_keys}
    else:
        filtered = value
    canon = canonicalize_jcs(filtered)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def compute_artifact_sha256(artifact: dict[str, Any]) -> str:
    """Computes independent canonical SHA-256 excluding `artifact_sha256` and `signature`."""
    return compute_canonical_sha256(artifact, exclude_keys=frozenset({"artifact_sha256", "signature"}))


def compute_command_receipt_sha256(receipt: dict[str, Any]) -> str:
    """Computes canonical SHA-256 of a command receipt excluding `receipt_sha256`."""
    return compute_canonical_sha256(receipt, exclude_keys=frozenset({"receipt_sha256"}))
