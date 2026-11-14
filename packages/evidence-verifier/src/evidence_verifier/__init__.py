"""
Responsibility: Package root for Vervain's independent inference-security evidence verifier.
Trust boundary: Treats all producer artifacts, logs, manifests, and UI summaries as untrusted.
"""

from .reason_codes import EXIT_CODE_BY_VERDICT, REASON_CODES, Verdict

__version__ = "0.1.0"
__all__ = ["EXIT_CODE_BY_VERDICT", "REASON_CODES", "Verdict", "__version__"]
