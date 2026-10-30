""""Add to Google Calendar" on a reminder: calendar-link.js builds a link to
Google Calendar's new-event page, so Google sends the alert Cardlake doesn't.
The link itself is tested in calendar_link.test.js."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import AURORA_FEED_JS, ROOT, SANDBOX_HTML, VAULT_INDEX, source

CALENDAR_LINK_JS = ROOT / "public" / "vault" / "assets" / "calendar-link.js"
USER_EVENTS_DOC = ROOT / "docs" / "USER_EVENTS.md"


class CalendarLinkTests(unittest.TestCase):
    def test_a_reminder_becomes_a_google_calendar_link(self):
        result = subprocess.run(["node", "tests/unit/calendar_link.test.js"], cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_the_script_parses(self):
        result = subprocess.run(["node", "--check", str(CALENDAR_LINK_JS)], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    # It's a copy, not a sync: Cardlake never calls Google or holds a Google token.
    def test_cardle_itself_never_contacts_google(self):
        script = source(CALENDAR_LINK_JS)
        for call in ("fetch(", "XMLHttpRequest", "sendBeacon", "V.api", "/api/"):
            self.assertNotIn(call, script)

    def test_the_vault_page_loads_it_before_the_feed(self):
        index = source(VAULT_INDEX)
        self.assertLess(index.index('src="/vault/assets/calendar-link.js"'), index.index('src="/vault/assets/aurora-feed.js'))
        # The demo feed has no account to link back to and never offers it.
        self.assertNotIn("calendar-link.js", source(SANDBOX_HTML))

    def test_the_reminder_detail_view_offers_it_in_a_new_tab(self):
        js = source(AURORA_FEED_JS)
        helper = js.split("function calendarLinkHtml(card, { inFeed = false } = {}) {", 1)[1].split("\n  function ", 1)[0]
        self.assertIn("if (SANDBOX) return '';", helper)
        self.assertIn("window.CardleCalendar?.googleCalendarUrl(card, { cardleUrl: `${location.origin}/vault/` })", helper)
        self.assertIn('href="${esc(href)}" target="_blank" rel="noopener noreferrer" data-interactive data-link-kind="add_to_calendar"', helper)
        self.assertIn(">Add to Google Calendar ↗</a>", helper)
        detail = js.split("function detail(card) {", 1)[1].split("\n  const CAPTURE_SINGULAR_KEY", 1)[0]
        self.assertIn("${calendarLinkHtml(card)}", detail)

    # The feed card offers it too, more quietly. data-interactive keeps a tap
    # on it from opening the card or starting a swipe.
    def test_the_feed_card_offers_it_quietly(self):
        js = source(AURORA_FEED_JS)
        card = js.split("function cardHtml(card, index) {", 1)[1].split("\n  function ", 1)[0]
        self.assertIn("${calendarLinkHtml(card, { inFeed: true })}", card)
        self.assertIn("${inFeed ? ' aurora-calendar-feed' : ''}", js)
        self.assertIn("const isSwipeBlockedTarget = target => target.closest('a, button, [data-interactive], [data-like]');", js)
        self.assertIn("!e.target.closest('button,a,[data-interactive]')) detail(card);", js)
        css = source(ROOT / "public" / "vault" / "assets" / "aurora-feed.css")
        self.assertIn(".aurora-calendar-feed .aurora-calendar-link{color:var(--ink-faint);", css)

    # Its use is measured as a link click with kind add_to_calendar, which is
    # what decides whether a full Google Calendar sync is worth building.
    def test_its_clicks_are_counted_by_kind(self):
        js = source(AURORA_FEED_JS)
        self.assertIn("const kind = link.dataset.linkKind ? { kind: link.dataset.linkKind } : {};", js)
        self.assertIn("track('card.link_click', card, { host, in_detail: !cardEl, position: positionOf(card), ...kind });", js)
        self.assertIn("`kind`", source(USER_EVENTS_DOC))


if __name__ == "__main__":
    unittest.main()
