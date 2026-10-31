""""Deal me 5": five fresh, mostly educational cards for a thin feed
(api/_lib/surprise.js, api/_lib/surprise-sources.js, aurora-feed.js).
Database behavior runs against real Postgres via PGlite (see pg_harness.js)
with faked feeds; each scenario lives in surprise_scenarios.js and runs in its
own Node process. The rest checks the source list, content and wiring."""
from __future__ import annotations

import json
import re
import subprocess
import unittest
from urllib.parse import urlparse

from ._paths import API, AURORA_FEED_JS, ROOT, SCHEMA, VAULT_INDEX, source
from .test_onboarding import FORBIDDEN

SCENARIOS = ROOT / "tests" / "unit" / "surprise_scenarios.js"
PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"


def catalog():
    script = "const s = require('./api/_lib/surprise-sources'); process.stdout.write(JSON.stringify(s))"
    result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class SurpriseScenarioTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        result = subprocess.run(["node", str(SCENARIOS), name], cwd=ROOT, capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_first_deal_saves_topics_and_deals_four_learnings_and_one_thing_to_try(self):
        self.run_scenario("first_deal_saves_topics_and_deals_four_learnings_and_one_thing_to_try")

    def test_deals_never_repeat_a_card_and_stop_after_three_a_day(self):
        self.run_scenario("deals_never_repeat_a_card_and_stop_after_three_a_day")

    def test_a_new_deal_adds_to_the_last_one_whose_cards_stay_for_their_trial(self):
        self.run_scenario("a_new_deal_adds_to_the_last_one_whose_cards_stay_for_their_trial")

    def test_untouched_dealt_and_starter_cards_expire_after_two_weeks_when_the_feed_opens(self):
        self.run_scenario("untouched_dealt_and_starter_cards_expire_after_two_weeks_when_the_feed_opens")

    def test_a_double_tap_deals_once(self):
        self.run_scenario("a_double_tap_deals_once")

    def test_broken_feeds_fall_back_to_the_evergreen_list(self):
        self.run_scenario("broken_feeds_fall_back_to_the_evergreen_list")

    def test_one_broken_feed_does_not_stop_the_others_and_the_pool_refreshes_at_most_twice_a_day(self):
        self.run_scenario("one_broken_feed_does_not_stop_the_others_and_the_pool_refreshes_at_most_twice_a_day")

    def test_deals_stop_at_the_card_limit(self):
        self.run_scenario("deals_stop_at_the_card_limit")

    def test_bad_requests_are_refused(self):
        self.run_scenario("bad_requests_are_refused")

    def test_when_everything_has_been_dealt_nothing_is_removed(self):
        self.run_scenario("when_everything_has_been_dealt_nothing_is_removed")

    def test_before_the_migration_deal_me_5_switches_itself_off(self):
        self.run_scenario("before_the_migration_deal_me_5_switches_itself_off")


class SourceListTests(unittest.TestCase):
    """The curated sources are the whole of the upkeep, so they must stay
    well-formed: every topic well covered, every link one the feed can open,
    and nothing that reads like someone else's calendar."""

    @classmethod
    def setUpClass(cls):
        cls.catalog = catalog()
        cls.topic_ids = [topic["id"] for topic in cls.catalog["TOPICS"]]

    def test_every_topic_has_sources_evergreen_picks_and_things_to_try(self):
        for topic in self.topic_ids:
            self.assertGreaterEqual(sum(s["topic"] == topic for s in self.catalog["SOURCES"]), 2, topic)
            self.assertGreaterEqual(sum(e["topic"] == topic for e in self.catalog["EVERGREEN"]), 1, topic)
            self.assertGreaterEqual(sum(c["topic"] == topic for c in self.catalog["CHALLENGES"]), 3, topic)

    def test_sources_are_https_feeds_with_unique_ids(self):
        ids = [s["id"] for s in self.catalog["SOURCES"]]
        self.assertEqual(len(ids), len(set(ids)))
        for s in self.catalog["SOURCES"]:
            self.assertIn(s["topic"], self.topic_ids, s["id"])
            self.assertEqual(urlparse(s["feed"]).scheme, "https", s["feed"])
            if s["id"].startswith("yt:"):
                self.assertRegex(s["feed"], r"^https://www\.youtube\.com/feeds/videos\.xml\?channel_id=UC[A-Za-z0-9_-]{22}$")

    def test_evergreen_picks_are_youtube_watch_links(self):
        keys = [e["key"] for e in self.catalog["EVERGREEN"]]
        self.assertEqual(len(keys), len(set(keys)))
        for e in self.catalog["EVERGREEN"]:
            self.assertRegex(e["url"], r"^https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}$")

    def test_things_to_try_have_no_day_date_or_appointment(self):
        keys = [c["key"] for c in self.catalog["CHALLENGES"]]
        self.assertEqual(len(keys), len(set(keys)))
        for c in self.catalog["CHALLENGES"]:
            self.assertTrue(c["title"].startswith("Try: "), c["title"])
            self.assertIsNone(FORBIDDEN.search(c["title"]), c["title"])

    def test_every_persona_suggests_known_topics(self):
        personas = subprocess.run(["node", "-e", "process.stdout.write(JSON.stringify(require('./api/_lib/onboarding-personas').PERSONA_IDS))"],
                                  cwd=ROOT, capture_output=True, text=True, timeout=60)
        for persona in json.loads(personas.stdout):
            self.assertIn(persona, self.catalog["PERSONA_TOPICS"], persona)
            for topic in self.catalog["PERSONA_TOPICS"][persona]:
                self.assertIn(topic, self.topic_ids)


class ParseFeedTests(unittest.TestCase):
    def test_atom_and_rss_entries_are_read_and_shorts_skipped(self):
        script = r"""
const { parseFeed } = require('./api/_lib/surprise');
const yt = { id: 'yt:x', topic: 'ai' }, blog = { id: 'rss:x', topic: 'science' };
const atom = `<feed><entry><yt:videoId>abcdefghijk</yt:videoId><title>A &amp; B</title><link rel="alternate" href="https://www.youtube.com/watch?v=abcdefghijk"/><published>2026-01-02T00:00:00Z</published></entry>
<entry><yt:videoId>shortshort1</yt:videoId><title>Short</title><link rel="alternate" href="https://www.youtube.com/shorts/shortshort1"/><published>2026-01-03T00:00:00Z</published></entry></feed>`;
const rss = `<rss><channel><item><title><![CDATA[Big <em>idea</em>]]></title><link>https://example.test/a</link><pubDate>Fri, 02 Jan 2026 00:00:00 GMT</pubDate></item>
<item><title>No date</title><link>https://example.test/b</link></item><item><title>Not https</title><link>http://example.test/c</link><pubDate>Fri, 02 Jan 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
process.stdout.write(JSON.stringify([parseFeed(atom, yt), parseFeed(rss, blog)]));
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        atom, rss = json.loads(result.stdout)
        self.assertEqual([(i["key"], i["title"], i["url"]) for i in atom], [("yt:x:abcdefghijk", "A & B", "https://www.youtube.com/watch?v=abcdefghijk")])
        self.assertEqual([(i["title"], i["url"], i["topic"]) for i in rss], [("Big idea", "https://example.test/a", "science")])


class SurpriseWiringTests(unittest.TestCase):
    def test_surprise_is_routed_through_the_vault_function(self):
        rewrites = {r["source"]: r["destination"] for r in json.loads(source(ROOT / "vercel.json"))["rewrites"]}
        self.assertEqual(rewrites["/api/surprise"], "/api/vault?resource=surprise")
        self.assertIn("api/surprise/**", source(ROOT / ".vercelignore").splitlines())
        self.assertIn("if (resource === 'surprise') return surpriseHandler(req, res);", source(API / "vault.js"))

    def test_schema_is_additive(self):
        schema = source(SCHEMA)
        for table in ("surprise_sources", "surprise_pool", "surprise_deals"):
            self.assertRegex(schema, rf"create table if not exists {table}\s*\(")
        for column in ("interests jsonb", "last_deal_at timestamptz"):
            self.assertIn(f"alter table users add column if not exists {column};", schema)
        self.assertIn("create unique index if not exists surprise_deals_user_key_idx on surprise_deals (user_email, item_key);", schema)

    def test_opening_the_feed_sweeps_expired_trial_cards(self):
        self.assertIn("if (recordVisit && !req.query?.cursor) await sweepTrials(sql, tenant);", source(API / "feed.js"))

    def test_feed_offers_the_deal_and_labels_cards_on_trial(self):
        feed = source(AURORA_FEED_JS)
        self.assertIn("V.api('/api/surprise', { method: 'POST'", feed)
        self.assertIn("data-deal>Deal me 5 <span class=\"aurora-deal-count\">", feed)
        self.assertIn("<h2>What are you curious about?</h2>", feed)
        self.assertIn('class="aurora-card-trial"', feed)
        # The demo feed never calls the API.
        self.assertIn("const surpriseReady = () => !SANDBOX &&", feed)
        index = source(VAULT_INDEX)
        self.assertIn("/vault/assets/aurora-feed.js?v=46", index)
        self.assertIn("/vault/assets/vault.js?v=17", index)
        self.assertIn("/vault/assets/aurora-feed.css?v=26", index)

    def test_the_feed_header_always_offers_the_deal(self):
        feed = source(AURORA_FEED_JS)
        header_actions = re.search(r"const headerActions = state\.view === 'active'\n\s*\? `(.*)`\n", feed)
        self.assertIsNotNone(header_actions)
        self.assertIn("${headerDealHtml()}", header_actions.group(1))
        body = re.search(r"function headerDealHtml\(\) \{\n(.*?)\n  \}\n", feed, re.S)
        self.assertIsNotNone(body)
        body = body.group(1)
        # Shown whatever the feed's size; hidden in the demo, before the
        # migration (both via surpriseReady) and in the Snoozed view.
        self.assertIn("if (!surpriseReady() || state.view !== 'active') return '';", body)
        self.assertNotIn("THIN_FEED", body)
        self.assertIn("data-deal", body)
        # When it can't deal, it stays visible, disabled, and says why.
        self.assertIn("disabled title=\"${reason}\" aria-label=\"Deal me 5: ${reason}\"", body)
        # Short enough for a phone header: "Deal 5" under 640px.
        self.assertIn("Deal<span class=\"aurora-deal-me\"> me</span> 5", body)
        css = source(ROOT / "public" / "vault" / "assets" / "aurora-feed.css")
        self.assertRegex(css, r"@media\(max-width:640px\)\{[^\n]*\.aurora-deal-me\{display:none\}")

    def test_the_app_only_suggests_keeping_cards_in_ways_it_offers(self):
        # The feed has no edit button, so its copy says "like or pin". Edits
        # through an AI assistant still keep a card (see the privacy page).
        feed = source(AURORA_FEED_JS)
        vault = source(ROOT / "public" / "vault" / "assets" / "vault.js")
        for text in (feed, vault):
            self.assertNotRegex(text, r"(?i)pin or edit")
        self.assertIn('title="Like or pin it to keep it"', feed)
        self.assertIn("Cards you don’t like or pin clear themselves", feed)
        self.assertIn("Like or pin the ones you want to keep;", vault)

    def test_the_new_event_and_expiry_are_documented(self):
        self.assertIn("`surprise.deal`", source(ROOT / "docs" / "USER_EVENTS.md"))
        privacy = source(ROOT / "public" / "privacy.html")
        self.assertIn('"Deal me 5"', privacy)
        self.assertIn("removed after 14 days unless you like, pin or edit them", privacy)
        self.assertIn("const TRIAL_DAYS = 14;", source(API / "_lib" / "surprise.js"))


if __name__ == "__main__":
    unittest.main()
