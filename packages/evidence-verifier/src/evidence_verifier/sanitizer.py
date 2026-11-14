"""
Responsibility: Zero-echo sanitizer detecting forbidden keys, raw prompts/outputs/KV tensors,
planted values (raw/case-folded/hex/base64), API keys/tokens/PEM keys, PII, and high-entropy secrets.
Trust boundary: Runs on untrusted artifacts, RUN_DIR files, and verifier-rendered outputs before emission.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
import math
import re
from typing import Any

# Normalized (lowercase alphanumeric only) forbidden keys.
FORBIDDEN_NORMALIZED_KEYS: dict[str, str] = {
    # Raw prompts / responses / context / planted values
    "rawprompt": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "prompt": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "prompttext": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "systemprompt": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "messages": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "rawresponse": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "responsetext": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "completion": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "outputtext": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "rawoutput": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "chunktext": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "documenttext": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "sourcetext": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "contexttext": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "rawcontext": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "groundtruth": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "plantedvalue": "FAIL_PROTECTED_CONTENT_PLANTED_VALUE",
    "rawplantedvalue": "FAIL_PROTECTED_CONTENT_PLANTED_VALUE",
    "plantedsecret": "FAIL_PROTECTED_CONTENT_PLANTED_VALUE",
    "canary": "FAIL_PROTECTED_CONTENT_PLANTED_VALUE",
    "canaryvalue": "FAIL_PROTECTED_CONTENT_PLANTED_VALUE",
    "canarytext": "FAIL_PROTECTED_CONTENT_PLANTED_VALUE",
    # KV & tensor dumps
    "kvtensor": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "kvtensors": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "kvcache": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "keytensor": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "valuetensor": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "kcache": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "vcache": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "tensorbytes": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "rawweights": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "rawlogits": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    "embeddingvector": "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV",
    # Credentials / secrets
    "secret": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "clientsecret": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "sessionsecret": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "hmacsecret": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "apikey": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "geminiapikey": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "openaiapikey": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "anthropicapikey": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "hftoken": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "accesstoken": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "refreshtoken": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "idtoken": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "bearertoken": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "authtoken": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "token": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "cookie": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "setcookie": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "sessioncookie": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "password": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "passwd": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "passphrase": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "credential": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "credentials": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "privatekey": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "signingkey": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "pem": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "sshkey": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "awssecretaccesskey": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "serviceaccountkey": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "authorization": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "scopeenvelope": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    "signedscopeenvelope": "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
    # PII / customer / network addresses
    "email": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "emailaddress": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "phone": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "phonenumber": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "ssn": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "socialsecuritynumber": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "address": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "ipaddress": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "hostip": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "streetaddress": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "homeaddress": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "customerdata": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "customername": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "fullname": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "dateofbirth": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "creditcard": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "bankaccount": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
    "iban": "FAIL_PII_OR_NETWORK_ADDRESS_LEAK",
}

SECRET_REGEX_RULES: tuple[tuple[str, str, re.Pattern[str]], ...] = (
    ("SEC_GOOGLE_API_KEY", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"AIza[0-9A-Za-z\-_]{20,}")),
    ("SEC_OPENAI_KEY", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{20,}")),
    ("SEC_ANTHROPIC_KEY", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"sk-ant-(?:api\d{2}-)?[A-Za-z0-9_\-]{20,}")),
    ("SEC_HF_TOKEN", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"hf_[A-Za-z0-9]{20,}")),
    ("SEC_GITHUB_TOKEN", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}")),
    ("SEC_AWS_ACCESS_KEY", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}")),
    ("SEC_AWS_SECRET_KEY", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"(?i)aws_secret_access_key\s*[:=]\s*['\"]?[A-Za-z0-9/+=]{40}")),
    ("SEC_GCP_SA_JSON", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r'"type"\s*:\s*"service_account"|"private_key_id"\s*:')),
    ("SEC_BEARER_TOKEN", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}")),
    ("SEC_BASIC_AUTH", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"(?i)\bBasic\s+[A-Za-z0-9+/=]{12,}")),
    ("SEC_JWT_TOKEN", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("SEC_PEM_PRIVATE_KEY", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----")),
    ("SEC_SESSION_COOKIE", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"(?i)(?:vervain_cf_sid|__Host-vervain_cf_sid|JSESSIONID|connect\.sid|sessionid)=[^;\s]+")),
    ("SEC_CREDENTIALED_URI", "FAIL_SECRET_LEAK_KEY_OR_TOKEN", re.compile(r"(?i)(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|https?|ssh)://[^:\s/@]+:[^@\s/]+@[^\s/]+")),
)

PII_AND_ADDRESS_RULES: tuple[tuple[str, str, re.Pattern[str]], ...] = (
    ("PII_EMAIL", "FAIL_PII_OR_NETWORK_ADDRESS_LEAK", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("PII_SSN", "FAIL_PII_OR_NETWORK_ADDRESS_LEAK", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("PII_US_STREET_ADDRESS", "FAIL_PII_OR_NETWORK_ADDRESS_LEAK", re.compile(r"\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,4}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b")),
    ("PII_IPV4_ADDRESS", "FAIL_PII_OR_NETWORK_ADDRESS_LEAK", re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b")),
    ("PII_PAYMENT_CARD", "FAIL_PII_OR_NETWORK_ADDRESS_LEAK", re.compile(r"\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13})\b")),
)

RAW_CONTENT_MARKER_RULES: tuple[tuple[str, str, re.Pattern[str]], ...] = (
    ("CONTENT_RAW_PROMPT_MARKER", "FAIL_PROTECTED_CONTENT_PROMPT_OR_KV", re.compile(r"(?i)\b(?:BEGIN\s+RAW\s+PROMPT|SYSTEM\s+PROMPT\s*:|KV_TENSOR_DUMP)\b")),
    ("CONTENT_SYNTHETIC_PLANTED_DEFAULT", "FAIL_PROTECTED_CONTENT_PLANTED_VALUE", re.compile(r"(?i)VERVAIN_PLANTED_[A-Z0-9_]{4,}|ALDER_CANARY_[A-Z0-9_]{4,}")),
)

# Strings exempted from the high-entropy detector (known safe fixed-format identifiers).
_SAFE_HIGH_ENTROPY_RE = re.compile(
    r"^(?:"
    r"[0-9a-f]{64}"
    r"|[0-9a-f]{40}"
    r"|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    r"|0x[0-9a-f]{8,16}"
    r"|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z"
    r"|https://vervain\.security/schemas/[A-Za-z0-9._/-]+"
    r"|/?(?:[A-Za-z0-9_.-]{1,64}/)+[A-Za-z0-9_.-]{1,96}"
    r"|[a-z0-9]+(?:[-_][a-z0-9]+){2,}"
    r"|[A-Z0-9]+(?:[-_][A-Z0-9]+){2,}"
    r")$"
)

# Fields allowed to hold cryptographic public-key / signature material (still scanned for private keys/secrets).
_CRYPTO_PUBLIC_FIELD_PATHS = frozenset({
    "$.signature.signature_value",
    "$.keys",
})


@dataclass(frozen=True)
class SanitizerFinding:
    rule_id: str
    json_pointer: str
    reason_code: str
    redacted_preview: str


@dataclass(frozen=True)
class SanitizerResult:
    passed: bool
    rules_checked: int
    finding_count: int
    findings: tuple[SanitizerFinding, ...]


def _normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def _shannon_entropy(token: str) -> float:
    if not token:
        return 0.0
    counts: dict[str, int] = {}
    for ch in token:
        counts[ch] = counts.get(ch, 0) + 1
    total = len(token)
    entropy = 0.0
    for cnt in counts.values():
        p = cnt / total
        entropy -= p * math.log2(p)
    return entropy


def _build_planted_variants(forbidden_strings: list[str]) -> list[tuple[str, str]]:
    variants: list[tuple[str, str]] = []
    for item in forbidden_strings:
        cleaned = item.strip()
        if len(cleaned) < 6:
            continue
        raw_bytes = cleaned.encode("utf-8")
        variants.append((cleaned.lower(), "raw"))
        variants.append((raw_bytes.hex().lower(), "hex"))
        variants.append((base64.b64encode(raw_bytes).decode("ascii").lower(), "b64"))
        variants.append((base64.urlsafe_b64encode(raw_bytes).decode("ascii").lower(), "b64url"))
    return variants


def _scan_string(
    val: str,
    pointer: str,
    planted_variants: list[tuple[str, str]],
    findings: list[SanitizerFinding],
) -> None:
    preview = f"[REDACTED_LEN_{len(val)}]"
    for rule_id, reason_code, pattern in SECRET_REGEX_RULES:
        if pattern.search(val):
            findings.append(SanitizerFinding(rule_id, pointer, reason_code, preview))
    for rule_id, reason_code, pattern in PII_AND_ADDRESS_RULES:
        if pattern.search(val):
            findings.append(SanitizerFinding(rule_id, pointer, reason_code, preview))
    for rule_id, reason_code, pattern in RAW_CONTENT_MARKER_RULES:
        if pattern.search(val):
            findings.append(SanitizerFinding(rule_id, pointer, reason_code, preview))

    val_lower = val.lower()
    for variant, encoding_tag in planted_variants:
        if variant in val_lower:
            findings.append(
                SanitizerFinding(
                    f"PLANTED_VALUE_{encoding_tag.upper()}",
                    pointer,
                    "FAIL_PROTECTED_CONTENT_PLANTED_VALUE",
                    preview,
                )
            )

    # High-entropy check on standalone tokens excluding signature/public-key values and safe formats.
    is_crypto_pub = pointer == "$.signature.signature_value" or pointer.endswith(".public_key_b64")
    if not is_crypto_pub:
        for raw_tok in re.split(r"[\s\"'`()\[\]{}<>,;]+", val):
            tok = raw_tok.strip(":")
            if len(tok) < 24 or _SAFE_HIGH_ENTROPY_RE.match(tok):
                continue
            if "=" in tok and tok.count("=") == 1:
                _, rhs = tok.split("=", 1)
                tok = rhs.strip(":")
                if len(tok) < 24 or _SAFE_HIGH_ENTROPY_RE.match(tok):
                    continue
            entropy = _shannon_entropy(tok)
            if (len(tok) >= 24 and entropy >= 4.5) or (len(tok) >= 32 and entropy >= 4.2):
                findings.append(
                    SanitizerFinding(
                        "SEC_HIGH_ENTROPY_TOKEN",
                        pointer,
                        "FAIL_SECRET_LEAK_KEY_OR_TOKEN",
                        f"[REDACTED_LEN_{len(tok)}]",
                    )
                )


def sanitize_structure(
    data: Any,
    *,
    forbidden_strings: list[str] | None = None,
) -> SanitizerResult:
    """Recursively scans parsed JSON data for forbidden keys, secrets, PII, and planted values."""
    planted_variants = _build_planted_variants(forbidden_strings or [])
    findings: list[SanitizerFinding] = []

    def walk(node: Any, pointer: str) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                child_ptr = f"{pointer}.{k}"
                norm = _normalize_key(k)
                if norm in FORBIDDEN_NORMALIZED_KEYS:
                    findings.append(
                        SanitizerFinding(
                            f"KEY_{norm.upper()}",
                            child_ptr,
                            FORBIDDEN_NORMALIZED_KEYS[norm],
                            "[REDACTED_KEY_VALUE]",
                        )
                    )
                _scan_string(k, f"{child_ptr}#key", planted_variants, findings)
                walk(v, child_ptr)
        elif isinstance(node, list):
            for idx, item in enumerate(node):
                walk(item, f"{pointer}[{idx}]")
        elif isinstance(node, str):
            _scan_string(node, pointer, planted_variants, findings)

    walk(data, "$")
    # Deduplicate deterministically without leaking any value.
    seen: set[tuple[str, str, str]] = set()
    unique_findings: list[SanitizerFinding] = []
    for f in sorted(findings, key=lambda x: (x.reason_code, x.json_pointer, x.rule_id)):
        key = (f.rule_id, f.json_pointer, f.reason_code)
        if key not in seen:
            seen.add(key)
            unique_findings.append(f)

    rules_checked = (
        len(FORBIDDEN_NORMALIZED_KEYS)
        + len(SECRET_REGEX_RULES)
        + len(PII_AND_ADDRESS_RULES)
        + len(RAW_CONTENT_MARKER_RULES)
        + 2  # planted variants + entropy
    )
    return SanitizerResult(
        passed=len(unique_findings) == 0,
        rules_checked=rules_checked,
        finding_count=len(unique_findings),
        findings=tuple(unique_findings),
    )


def sanitize_text(
    raw_text: str,
    *,
    source_name: str = "text",
    forbidden_strings: list[str] | None = None,
) -> SanitizerResult:
    """Scans raw text (logs, markdown, raw JSON) line-by-line with zero-echo reporting."""
    planted_variants = _build_planted_variants(forbidden_strings or [])
    findings: list[SanitizerFinding] = []
    for line_no, line in enumerate(raw_text.splitlines(), start=1):
        _scan_string(line, f"{source_name}:line_{line_no}", planted_variants, findings)

    seen: set[tuple[str, str, str]] = set()
    unique_findings: list[SanitizerFinding] = []
    for f in sorted(findings, key=lambda x: (x.reason_code, x.json_pointer, x.rule_id)):
        key = (f.rule_id, f.json_pointer, f.reason_code)
        if key not in seen:
            seen.add(key)
            unique_findings.append(f)

    rules_checked = (
        len(SECRET_REGEX_RULES) + len(PII_AND_ADDRESS_RULES) + len(RAW_CONTENT_MARKER_RULES) + 2
    )
    return SanitizerResult(
        passed=len(unique_findings) == 0,
        rules_checked=rules_checked,
        finding_count=len(unique_findings),
        findings=tuple(unique_findings),
    )
