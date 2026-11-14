"""
Responsibility: Explicit trust-root loading, Ed25519 signature verification with domain-separated
run provenance binding, and run-id replay checking.
Trust boundary: Never trusts self-signed or artifact-embedded public keys; requires explicit --trust-root.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import hmac
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from .strict_json import StrictJsonError, parse_strict_json_bytes

ALLOWED_ASYMMETRIC_ALGS = frozenset({"ed25519"})


@dataclass(frozen=True)
class TrustRootError(Exception):
    reason_code: str
    message: str


@dataclass(frozen=True)
class TrustRootKey:
    key_id: str
    algorithm: str
    public_key: Ed25519PublicKey
    status: str
    purpose: str
    not_before: datetime
    not_after: datetime
    allow_ephemeral_demo: bool


@dataclass(frozen=True)
class TrustRoot:
    trust_root_id: str
    keys_by_id: dict[str, TrustRootKey]


@dataclass(frozen=True)
class SignatureCheckResult:
    checked: bool
    trust_root_required: bool
    verified: bool
    key_id: str | None
    reason_code: str
    detail: str


def parse_utc_iso(ts: str) -> datetime:
    """Parses strict RFC 3339 UTC timestamp ending in Z."""
    if not isinstance(ts, str) or not ts.endswith("Z"):
        raise ValueError("Timestamp must end with Z")
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc)


def build_signature_payload(artifact: dict[str, Any], artifact_sha256: str) -> bytes:
    """Builds domain-separated bytes binding signature to run provenance and canonical digest."""
    schema_version = str(artifact.get("schema_version", ""))
    run_id = str(artifact.get("run_id", ""))
    evidence_status = str(artifact.get("evidence_status", ""))
    source = artifact.get("source") if isinstance(artifact.get("source"), dict) else {}
    git_sha = str(source.get("git_sha", ""))
    vllm_sha = str(source.get("vllm_sha", ""))
    payload = "|".join(
        [
            "vervain.proof.v1",
            schema_version,
            run_id,
            evidence_status,
            git_sha,
            vllm_sha,
            artifact_sha256,
        ]
    )
    return payload.encode("utf-8")


def sign_artifact_dict(
    artifact: dict[str, Any],
    *,
    artifact_sha256: str,
    private_key: Ed25519PrivateKey,
    key_id: str,
    trust_root_id: str,
    signed_at: str,
    ephemeral_demo_only: bool = False,
) -> dict[str, Any]:
    """Signs an artifact dict using Ed25519 over the domain-separated binding payload."""
    payload = build_signature_payload(artifact, artifact_sha256)
    sig_bytes = private_key.sign(payload)
    return {
        "algorithm": "ed25519",
        "key_id": key_id,
        "trust_root_id": trust_root_id,
        "signed_digest_sha256": artifact_sha256,
        "signature_value": base64.b64encode(sig_bytes).decode("ascii"),
        "ephemeral_demo_only": ephemeral_demo_only,
        "signed_at": signed_at,
    }


def load_trust_root(path: Path) -> TrustRoot:
    """Loads and validates an explicit trust-root.v1 JSON bundle."""
    try:
        raw_bytes = path.read_bytes()
    except OSError as exc:
        raise TrustRootError("VERIFIER_ERROR_TRUST_ROOT_INVALID", f"Unable to read trust root: {exc}") from exc

    try:
        data = parse_strict_json_bytes(raw_bytes)
    except StrictJsonError as exc:
        raise TrustRootError("VERIFIER_ERROR_TRUST_ROOT_INVALID", f"Invalid trust-root JSON: {exc.message}") from exc

    if not isinstance(data, dict) or data.get("schema_version") != "trust-root.v1":
        raise TrustRootError("VERIFIER_ERROR_TRUST_ROOT_INVALID", "Trust root schema_version must be trust-root.v1.")

    trust_root_id = data.get("trust_root_id")
    keys_raw = data.get("keys")
    if not isinstance(trust_root_id, str) or not trust_root_id or not isinstance(keys_raw, list) or not keys_raw:
        raise TrustRootError("VERIFIER_ERROR_TRUST_ROOT_INVALID", "Trust root missing trust_root_id or keys.")

    keys_by_id: dict[str, TrustRootKey] = {}
    for entry in keys_raw:
        if not isinstance(entry, dict):
            raise TrustRootError("VERIFIER_ERROR_TRUST_ROOT_INVALID", "Trust root key entry must be an object.")
        key_id = entry.get("key_id")
        alg = entry.get("algorithm")
        pub_b64 = entry.get("public_key_b64")
        status = entry.get("status")
        purpose = entry.get("purpose")
        nb = entry.get("not_before")
        na = entry.get("not_after")
        ephem = entry.get("allow_ephemeral_demo")
        if (
            not isinstance(key_id, str)
            or not key_id
            or key_id in keys_by_id
            or alg != "ed25519"
            or not isinstance(pub_b64, str)
            or status not in ("active", "revoked")
            or purpose != "inference-proof-signing"
            or not isinstance(nb, str)
            or not isinstance(na, str)
            or not isinstance(ephem, bool)
        ):
            raise TrustRootError("VERIFIER_ERROR_TRUST_ROOT_INVALID", "Malformed key entry in trust root.")
        try:
            pub_raw = base64.b64decode(pub_b64, validate=True)
            pub_key = Ed25519PublicKey.from_public_bytes(pub_raw)
            nb_dt = parse_utc_iso(nb)
            na_dt = parse_utc_iso(na)
        except Exception as exc:
            raise TrustRootError(
                "VERIFIER_ERROR_TRUST_ROOT_INVALID", f"Invalid Ed25519 key or timestamp in trust root: {exc}"
            ) from exc
        keys_by_id[key_id] = TrustRootKey(
            key_id=key_id,
            algorithm=alg,
            public_key=pub_key,
            status=status,
            purpose=purpose,
            not_before=nb_dt,
            not_after=na_dt,
            allow_ephemeral_demo=ephem,
        )

    return TrustRoot(trust_root_id=trust_root_id, keys_by_id=keys_by_id)


def verify_artifact_signature(
    artifact: dict[str, Any],
    *,
    computed_sha256: str,
    trust_root: TrustRoot | None,
    require_signature: bool,
    detached_signature: dict[str, Any] | None = None,
) -> SignatureCheckResult:
    """Verifies embedded or detached signature against an explicit trust root."""
    sig_obj = detached_signature if detached_signature is not None else artifact.get("signature")
    trust_root_required = require_signature or (trust_root is not None)

    if sig_obj is None:
        if require_signature:
            return SignatureCheckResult(
                checked=False,
                trust_root_required=True,
                verified=False,
                key_id=None,
                reason_code="NV_SIG_MISSING",
                detail="Signature is required but missing from artifact.",
            )
        return SignatureCheckResult(
            checked=False,
            trust_root_required=trust_root_required,
            verified=False,
            key_id=None,
            reason_code="PASS_VERIFIED",
            detail="Signature absent and not required by policy.",
        )

    if not isinstance(sig_obj, dict):
        return SignatureCheckResult(
            checked=True,
            trust_root_required=trust_root_required,
            verified=False,
            key_id=None,
            reason_code="FAIL_SIG_INVALID",
            detail="Signature block must be a JSON object.",
        )

    alg = sig_obj.get("algorithm")
    key_id = sig_obj.get("key_id")
    tr_id = sig_obj.get("trust_root_id")
    signed_digest = sig_obj.get("signed_digest_sha256")
    sig_val = sig_obj.get("signature_value")
    ephemeral_demo = sig_obj.get("ephemeral_demo_only")
    signed_at_raw = sig_obj.get("signed_at")

    if not isinstance(alg, str) or alg.lower() not in ALLOWED_ASYMMETRIC_ALGS:
        return SignatureCheckResult(
            checked=True,
            trust_root_required=trust_root_required,
            verified=False,
            key_id=key_id if isinstance(key_id, str) else None,
            reason_code="FAIL_SIG_ALG_UNSAFE",
            detail="Signature algorithm is missing, 'none', symmetric, or unapproved.",
        )

    if trust_root is None:
        return SignatureCheckResult(
            checked=False,
            trust_root_required=True,
            verified=False,
            key_id=key_id if isinstance(key_id, str) else None,
            reason_code="NV_TRUST_ROOT_UNPROVIDED",
            detail="Artifact carries a signature but no explicit --trust-root was provided.",
        )

    if not isinstance(key_id, str) or not isinstance(tr_id, str):
        return SignatureCheckResult(
            checked=True,
            trust_root_required=True,
            verified=False,
            key_id=None,
            reason_code="FAIL_SIG_KEY_ID_MISMATCH",
            detail="Signature missing valid key_id or trust_root_id.",
        )

    if tr_id != trust_root.trust_root_id:
        return SignatureCheckResult(
            checked=True,
            trust_root_required=True,
            verified=False,
            key_id=key_id,
            reason_code="FAIL_SIG_KEY_ID_MISMATCH",
            detail="Signature trust_root_id does not match supplied trust root.",
        )

    tr_key = trust_root.keys_by_id.get(key_id)
    if tr_key is None or tr_key.status != "active":
        return SignatureCheckResult(
            checked=True,
            trust_root_required=True,
            verified=False,
            key_id=key_id,
            reason_code="FAIL_SIG_UNTRUSTED_KEY",
            detail="Signing key_id is not active in the supplied trust root.",
        )

    if ephemeral_demo is True and not tr_key.allow_ephemeral_demo:
        return SignatureCheckResult(
            checked=True,
            trust_root_required=True,
            verified=False,
            key_id=key_id,
            reason_code="FAIL_SIG_UNTRUSTED_KEY",
            detail="Ephemeral demo signature is not authorized by this trust root key.",
        )

    if not isinstance(signed_at_raw, str):
        return SignatureCheckResult(
            checked=True,
            trust_root_required=True,
            verified=False,
            key_id=key_id,
            reason_code="FAIL_SIG_INVALID",
            detail="Missing signed_at timestamp.",
        )
    try:
        signed_at_dt = parse_utc_iso(signed_at_raw)
    except ValueError:
        return SignatureCheckResult(
            checked=True,
            trust_root_required=True,
            verified=False,
            key_id=key_id,
            reason_code="FAIL_SIG_INVALID",
            detail="Invalid signed_at timestamp.",
        )

    if signed_at_dt < tr_key.not_before or signed_at_dt > tr_key.not_after:
        return SignatureCheckResult(
            checked=True,
            trust_root_required=True,
            verified=False,
            key_id=key_id,
            reason_code="FAIL_SIG_UNTRUSTED_KEY",
            detail="Signature timestamp falls outside trust-root key validity window.",
        )

    if not isinstance(signed_digest, str) or not hmac.compare_digest(signed_digest, computed_sha256):
        return SignatureCheckResult(
            checked=True,
            trust_root_required=True,
            verified=False,
            key_id=key_id,
            reason_code="FAIL_SIG_REPLAY_OR_COPIED",
            detail="Signature signed_digest_sha256 does not match artifact canonical digest.",
        )

    if not isinstance(sig_val, str):
        return SignatureCheckResult(
            checked=True,
            trust_root_required=True,
            verified=False,
            key_id=key_id,
            reason_code="FAIL_SIG_INVALID",
            detail="Signature value must be base64 string.",
        )

    try:
        sig_bytes = base64.b64decode(sig_val, validate=True)
    except Exception:
        return SignatureCheckResult(
            checked=True,
            trust_root_required=True,
            verified=False,
            key_id=key_id,
            reason_code="FAIL_SIG_INVALID",
            detail="Malformed base64 signature encoding.",
        )

    payload = build_signature_payload(artifact, computed_sha256)
    try:
        tr_key.public_key.verify(sig_bytes, payload)
    except InvalidSignature:
        return SignatureCheckResult(
            checked=True,
            trust_root_required=True,
            verified=False,
            key_id=key_id,
            reason_code="FAIL_SIG_INVALID",
            detail="Ed25519 signature verification failed over canonical digest and provenance binding.",
        )

    return SignatureCheckResult(
        checked=True,
        trust_root_required=trust_root_required,
        verified=True,
        key_id=key_id,
        reason_code="PASS_VERIFIED",
        detail="Ed25519 signature verified against explicit trust root.",
    )


def check_seen_run_ids(
    seen_ledger_path: Path | None,
    *,
    run_id: str,
    artifact_sha256: str,
) -> tuple[bool, str]:
    """Checks whether run_id has already been recorded with a conflicting or replayed entry."""
    if seen_ledger_path is None:
        return True, "No replay ledger supplied."
    if not seen_ledger_path.exists():
        return True, "Replay ledger does not exist yet."
    try:
        data = parse_strict_json_bytes(seen_ledger_path.read_bytes())
    except (OSError, StrictJsonError) as exc:
        raise TrustRootError("VERIFIER_ERROR_IO", f"Unable to parse seen-run-ids ledger: {exc}") from exc
    if not isinstance(data, dict):
        raise TrustRootError("VERIFIER_ERROR_IO", "seen-run-ids ledger must be a JSON object.")

    prior = data.get(run_id)
    if prior is not None:
        return False, f"run_id {run_id!r} already recorded in replay ledger."
    return True, "run_id is fresh relative to seen-run-ids ledger."
