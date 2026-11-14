"""Module entrypoint for `python3 -m evidence_verifier`."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
