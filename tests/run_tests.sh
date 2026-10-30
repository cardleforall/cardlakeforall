#!/usr/bin/env bash
# Lite = unit only (offline, every commit/PR/CI). Full = unit + SIT (also
# exercises the real deployed API against a real database). See
# tests/README.md for what belongs in which tier and when to run each.
set -euo pipefail

tier=""
if [[ $# -eq 2 && "$1" == "--tier" ]]; then tier="$2"; fi
if [[ "$tier" != "lite" && "$tier" != "full" ]]; then
  echo "Usage: $0 --tier lite|full" >&2
  exit 2
fi

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 -m unittest discover -t . -s tests/unit -p 'test_*.py' -v
if [[ "$tier" == "full" ]]; then
  python3 -m unittest discover -t . -s tests/sit -p 'test_*.py' -v
fi
