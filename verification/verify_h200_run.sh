#!/usr/bin/env bash
# Responsibility: Bounded post-GPU-GO read-only verification launcher for PJ or Daybreak.
# Verifies an existing local RUN_DIR and emits verification.json + verification.md.
# Trust boundary: Never allocates, starts, stops, restarts, or discovers GPU/cluster resources.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <RUN_DIR> [--trust-root <PATH>] [--require-signature] [--out-dir <PATH>]" >&2
  exit 3
fi

RUN_DIR="$1"
shift

if [[ ! -d "$RUN_DIR" ]]; then
  echo "Error: RUN_DIR does not exist: $RUN_DIR" >&2
  exit 3
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export PYTHONPATH="$REPO_ROOT/packages/evidence-verifier/src${PYTHONPATH:+:$PYTHONPATH}"

exec python3 -m evidence_verifier verify-run "$RUN_DIR" "$@"
