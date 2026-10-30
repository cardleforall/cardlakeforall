"""Shared path constants and helpers for the unit test suite.

Every file under tests/unit/ is offline: it reads source files, parses them,
or runs isolated Node/Python snippets against pure functions -- none of it
opens a network connection or talks to a real database. That's what makes
these safe to run on every commit (see tests/README.md for the full
lite/full and unit/SIT split).
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
API = ROOT / "api"
SCHEMA = ROOT / "schema-v2.sql"
VAULT_INDEX = ROOT / "public" / "vault" / "index.html"
VAULT_JS = ROOT / "public" / "vault" / "assets" / "vault.js"
SANDBOX_HTML = ROOT / "public" / "vault" / "sandbox.html"
AURORA_FEED_JS = ROOT / "public" / "vault" / "assets" / "aurora-feed.js"

RESOURCE_ENDPOINTS = {
    "kanban": ("kanban_items", "index.js", "[id].js"),
    "work": ("work_items", "index.js", "[id].js"),
    "family": ("family_updates", "index.js", "[id].js"),
    "bookmarks": ("bookmarks", "index.js", "[id].js"),
    "reminders": ("reminders", "index.js", "[id].js"),
    "talking-points": ("talking_points", "index.js", "[id].js"),
}


def source(path: Path) -> str:
    return path.read_text(encoding="utf-8")

