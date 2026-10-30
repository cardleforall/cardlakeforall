#!/usr/bin/env python3
"""Optional local Vercel deploy helper; GitHub-to-Vercel is the normal deploy path."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(os.environ.get('PROJECT_ROOT', PROJECT_ROOT)),
                        help='Project root (or PROJECT_ROOT)')
    parser.add_argument('--token', default=os.environ.get('VERCEL_TOKEN'),
                        help='Vercel token (or VERCEL_TOKEN); never store it in this repo')
    parser.add_argument('--scope', default=os.environ.get('VERCEL_SCOPE'),
                        help='Optional Vercel team scope (or VERCEL_SCOPE)')
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.expanduser().resolve()
    if not args.token:
        print('Missing Vercel token: pass --token or set VERCEL_TOKEN', file=sys.stderr)
        return 1
    env = os.environ.copy()
    env['VERCEL_TOKEN'] = args.token
    subprocess.run([sys.executable, str(root / 'scripts' / 'build_vault_public.py')], check=True, cwd=root, env=env)
    command = ['npx', 'vercel', 'deploy', '--prod', '--token', args.token]
    if args.scope:
        command.extend(['--scope', args.scope])
    subprocess.run(command, check=True, cwd=root, env=env)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
