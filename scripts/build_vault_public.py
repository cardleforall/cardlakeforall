#!/usr/bin/env python3
"""Validate the committed API-driven Cardlake shell for deployment.

The vault is no longer generated from Markdown.  This command deliberately does
not invoke render_vault.py or overwrite public/vault/index.html.
"""
from __future__ import annotations
import argparse
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', type=Path, default=PROJECT_ROOT / 'public' / 'vault' / 'index.html')
    args = parser.parse_args()
    target = args.target.expanduser()
    if not target.is_file():
        raise SystemExit(f'Missing Cardlake shell: {target}')
    print(f'Using API-driven Cardlake shell {target}')

if __name__ == '__main__':
    main()
