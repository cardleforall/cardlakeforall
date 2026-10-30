"""The feed's sort orders (api/_lib/feed-ranking.js): the AI ranking's
signals and type mixing, and date added. Each check runs a short Node script
against the module, with a fixed clock."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import ROOT

PRELUDE = r"""
const assert = require('assert/strict');
const { sortCards, resolveSort, scoreCard } = require('./api/_lib/feed-ranking');
const DAY = 86400e3;
const NOW = Date.parse('2026-10-05T09:00:00Z');
const ago = days => new Date(NOW - days * DAY).toISOString();
const card = (id, type, fields = {}) => ({ id, type, metadata: {}, created_at: ago(1), ...fields });
const ids = cards => cards.map(c => c.id);
"""


def run_node(script: str) -> None:
    result = subprocess.run(["node", "-e", PRELUDE + script], cwd=ROOT, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)


class FeedRankingTests(unittest.TestCase):
    def test_unknown_or_missing_sort_falls_back_to_ai(self):
        run_node("""
assert.equal(resolveSort(undefined), 'ai');
assert.equal(resolveSort('random'), 'ai');
assert.equal(resolveSort('newest'), 'newest');
""")

    def test_date_added_lists_newest_first(self):
        run_node("""
const cards = [card('old', 'bookmark', { created_at: ago(9) }), card('new', 'learning', { created_at: ago(0.1) }), card('mid', 'reminder', { created_at: ago(3) })];
assert.deepEqual(ids(sortCards(cards, 'newest', { now: NOW })), ['new', 'mid', 'old']);
""")

    def test_an_overdue_reminder_outranks_a_card_added_just_now(self):
        run_node("""
const cards = [
  card('fresh', 'learning', { created_at: ago(0.01) }),
  card('overdue', 'reminder', { created_at: ago(20), metadata: { due_date: ago(1) } }),
  card('far-off', 'reminder', { created_at: ago(0.01), metadata: { due_date: ago(-30) } }),
];
assert.equal(sortCards(cards, 'ai', { now: NOW })[0].id, 'overdue');
""")

    def test_work_under_way_and_likes_lift_a_card(self):
        run_node("""
const base = card('x', 'kanban', { created_at: ago(10) });
const opts = { now: NOW };
assert.ok(scoreCard({ ...base, metadata: { status: 'in_progress' } }, opts) > scoreCard({ ...base, metadata: { status: 'backlog' } }, opts));
assert.ok(scoreCard({ ...base, liked_at: ago(2) }, opts) > scoreCard(base, opts));
const work = card('w', 'work', { created_at: ago(10) });
assert.ok(scoreCard({ ...work, metadata: { done: 2, total: 4 } }, opts) > scoreCard({ ...work, metadata: { done: 0, total: 4 } }, opts));
const backFromSnooze = { ...base, remind_later_until: ago(0.5) };
assert.ok(scoreCard(backFromSnooze, opts) > scoreCard(base, opts));
""")

    def test_a_long_forgotten_card_resurfaces_above_a_middle_aged_one(self):
        run_node("""
// Freshness fades within days; rediscovery grows over weeks. The daily
// shuffle is weighted off so only those two signals decide.
const weights = { freshness: 1.2, rediscovery: 0.6 };
const opts = { now: NOW, weights };
assert.ok(scoreCard(card('a', 'bookmark', { created_at: ago(120) }), opts) > scoreCard(card('b', 'bookmark', { created_at: ago(12) }), opts));
""")

    def test_types_are_mixed_and_never_three_in_a_row_while_others_remain(self):
        run_node("""
const cards = [
  ...Array.from({ length: 10 }, (_, i) => card(`r${i}`, 'reminder', { metadata: { due_date: ago(1) } })),
  card('l', 'learning'), card('b', 'bookmark'), card('f', 'family'),
];
const types = sortCards(cards, 'ai', { now: NOW }).map(c => c.type);
for (let i = 2; i < 6; i += 1) assert.ok(!(types[i] === types[i - 1] && types[i] === types[i - 2]), types.join());
assert.equal(types.length, cards.length);
""")

    def test_the_ai_order_is_stable_within_a_day_and_changes_between_days(self):
        run_node("""
// Pages are offsets into the order, so it must not move while someone scrolls.
const cards = Array.from({ length: 30 }, (_, i) => card(`c${i}`, ['learning', 'bookmark', 'family'][i % 3], { created_at: ago(40) }));
const first = ids(sortCards(cards, 'ai', { now: NOW }));
assert.deepEqual(ids(sortCards([...cards].reverse(), 'ai', { now: NOW + 3600e3 })), first);
assert.notDeepEqual(ids(sortCards(cards, 'ai', { now: NOW + 2 * DAY })), first);
""")

    def test_weights_can_be_overridden_to_personalise_later(self):
        run_node("""
const cards = [card('liked', 'learning', { created_at: ago(30), liked_at: ago(1) }), card('fresh', 'bookmark', { created_at: ago(0.01) })];
assert.equal(sortCards(cards, 'ai', { now: NOW, weights: { liked: 10 } })[0].id, 'liked');
assert.equal(sortCards(cards, 'ai', { now: NOW, weights: { freshness: 10 } })[0].id, 'fresh');
""")


if __name__ == "__main__":
    unittest.main()
