#!/usr/bin/env python3
"""Validate the committed API-driven Cardlake shell."""
from __future__ import annotations
import argparse
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
REQUIRED_MARKERS = ('id="dashboard-app"', 'id="learnings-app"',
                    'id="work-app"', 'id="family-app"',
                    'id="talking-points-app"', 'id="bookmarks-app"', '/vault/assets/vault.js',
                    '/vault/assets/learnings.js',
                    '/vault/assets/aurora-feed.js', '/vault/assets/aurora-feed.css', '/vault/assets/integrations.js', '/vault/assets/integrations.css', '/vault/assets/work.js',
                    '/vault/assets/family.js', '/vault/assets/bookmarks.js', '/vault/assets/talking-points.js')
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--target', type=Path, default=PROJECT_ROOT / 'public' / 'vault' / 'index.html')
    target = parser.parse_args().target.expanduser()
    if not target.is_file(): print(f'Missing Cardlake build output: {target}'); return 1
    missing = [x for x in REQUIRED_MARKERS if x not in target.read_text(encoding='utf-8')]
    if missing: print('Cardlake build is missing: ' + ', '.join(missing)); return 1
    print(f'Validated {target}'); return 0
if __name__ == '__main__': raise SystemExit(main())
