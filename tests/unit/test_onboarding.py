"""First-run onboarding: sign in -> pick a starter persona -> the feed, which
then offers to connect an AI assistant (public/welcome.html,
api/_lib/onboarding.js, the connect card in vault.js).
Database behavior runs against real Postgres via PGlite (see pg_harness.js);
each scenario lives in onboarding_scenarios.js and runs in its own Node process
with a fresh in-memory database. The rest checks content and wiring."""
from __future__ import annotations

import json
import re
import subprocess
import unittest
from urllib.parse import urlparse

from ._paths import API, ROOT, SCHEMA, VAULT_INDEX, VAULT_JS, source

SCENARIOS = ROOT / "tests" / "unit" / "onboarding_scenarios.js"
PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"
PUBLIC = ROOT / "public"
WELCOME = PUBLIC / "welcome.html"
WELCOME_JS = PUBLIC / "vault" / "assets" / "welcome.js"
CONNECT_AI_JS = PUBLIC / "vault" / "assets" / "connect-ai.js"
MCP_SETUP = PUBLIC / "mcp-setup.html"


def personas():
    script = "process.stdout.write(JSON.stringify(require('./api/_lib/onboarding-personas').PERSONAS))"
    result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class OnboardingScenarioTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        result = subprocess.run(["node", str(SCENARIOS), name], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_only_a_brand_new_account_is_sent_to_onboarding(self):
        self.run_scenario("only_a_brand_new_account_is_sent_to_onboarding")

    def test_an_account_that_signed_up_from_its_assistant_is_offered_onboarding(self):
        self.run_scenario("an_account_that_signed_up_from_its_assistant_is_offered_onboarding")

    def test_picking_a_persona_seeds_its_cards_into_that_account_only(self):
        self.run_scenario("picking_a_persona_seeds_its_cards_into_that_account_only")

    def test_bad_requests_are_refused(self):
        self.run_scenario("bad_requests_are_refused")

    def test_picking_twice_adds_the_cards_once(self):
        self.run_scenario("picking_twice_adds_the_cards_once")

    def test_starting_empty_finishes_onboarding_without_cards(self):
        self.run_scenario("starting_empty_finishes_onboarding_without_cards")

    def test_seeding_stops_at_the_card_limit(self):
        self.run_scenario("seeding_stops_at_the_card_limit")

    def test_reminders_fall_due_at_the_next_local_time(self):
        self.run_scenario("reminders_fall_due_at_the_next_local_time")

    def test_clearing_samples_keeps_the_cards_someone_made_their_own(self):
        self.run_scenario("clearing_samples_keeps_the_cards_someone_made_their_own")

    def test_connecting_an_assistant_is_detected(self):
        self.run_scenario("connecting_an_assistant_is_detected")

    def test_before_the_migration_onboarding_switches_itself_off(self):
        self.run_scenario("before_the_migration_onboarding_switches_itself_off")


WEEKDAYS = r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun"
MONTHS = r"january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec"
APPOINTMENTS = r"dentist|doctor|appointment|birthday|anniversary|recital|wedding|funeral"
FORBIDDEN = re.compile(rf"\b(?:{WEEKDAYS}|{MONTHS}|{APPOINTMENTS}|today|tomorrow|tonight)\b|\d{{1,2}}/\d{{1,2}}|\b20\d\d\b", re.IGNORECASE)


class PersonaContentTests(unittest.TestCase):
    """Starter cards land in a real person's feed, so they must not read like
    someone else's life (no names, days, dates or appointments), and every
    link must be one the feed can open."""

    @classmethod
    def setUpClass(cls):
        cls.personas = personas()

    def test_four_personas_each_with_a_full_mix_of_card_types(self):
        self.assertEqual(len(self.personas), 4)
        self.assertEqual(len({p["id"] for p in self.personas}), 4)
        for persona in self.personas:
            types = [card["type"] for card in persona["cards"]]
            for required in ("learning", "reminder", "work", "bookmark"):
                self.assertIn(required, types, f"{persona['id']} has no {required} card")
            self.assertGreaterEqual(types.count("reminder"), 3, persona["id"])
            self.assertGreaterEqual(len(persona["prompts"]), 3, persona["id"])

    def test_no_card_names_a_day_date_or_appointment(self):
        for persona in self.personas:
            for card in persona["cards"]:
                text = " ".join(str(card.get(field) or "") for field in ("title", "notes", "content")) + " " + " ".join(card.get("items") or [])
                self.assertIsNone(FORBIDDEN.search(text), f"{persona['id']}: {card['title']!r} reads like someone's calendar")

    def test_every_link_is_https_and_videos_are_youtube_watch_links(self):
        for persona in self.personas:
            for card in persona["cards"]:
                url = card.get("url")
                if card["type"] in ("learning",):
                    self.assertTrue(url, f"{card['title']!r} has no link")
                if not url:
                    continue
                parsed = urlparse(url)
                self.assertEqual(parsed.scheme, "https", url)
                self.assertTrue(parsed.netloc, url)
                if "youtube" in parsed.netloc:
                    self.assertRegex(url, r"^https://www\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}$")

    def test_reminders_are_one_time_at_a_valid_local_time(self):
        for persona in self.personas:
            for card in persona["cards"]:
                if card["type"] != "reminder" or card["time"] is None:
                    continue
                self.assertRegex(card["time"], r"^([01]\d|2[0-3]):[0-5]\d$", card["title"])
                self.assertIn(card["repeat"], ("daily", "weekly"), card["title"])


class ConnectAiContentTests(unittest.TestCase):
    """The Claude/ChatGPT connection steps live in one file; every page that
    shows them renders from it instead of keeping its own copy."""

    def test_setup_guide_and_vault_load_the_shared_steps(self):
        self.assertIn('<script src="/vault/assets/connect-ai.js"></script>', source(MCP_SETUP))
        # Setup no longer shows the steps: the feed offers them instead.
        self.assertNotIn("connect-ai.js", source(WELCOME))
        index = source(VAULT_INDEX)
        self.assertLess(index.index("/vault/assets/connect-ai.js"), index.index("/vault/assets/vault.js"))
        self.assertIn("data-connect-ai-steps=\"claude\"", source(MCP_SETUP))
        self.assertIn("data-connect-ai-steps=\"chatgpt\"", source(MCP_SETUP))
        self.assertIn("window.CardleConnectAI.SERVER_ADDRESS", source(VAULT_JS))

    def test_every_page_gives_this_deployments_own_address(self):
        # Each Cardlake is its own MCP server: no page may send an assistant
        # to another deployment or a directory listing of one.
        js = source(CONNECT_AI_JS)
        self.assertIn("const SERVER_ADDRESS = `${location.origin}/api/mcp`;", js)
        holders = [str(path.relative_to(PUBLIC)) for path in PUBLIC.rglob("*")
                   if path.suffix in {".html", ".js"} and "claude.ai/directory" in path.read_text(encoding="utf-8", errors="ignore")]
        self.assertEqual(holders, [])
        self.assertNotRegex(source(MCP_SETUP), r"https://[^\s<]*/api/mcp")

    def test_connection_steps_are_written_down_only_once(self):
        steps = "Add custom connector"
        holders = [str(path.relative_to(PUBLIC)) for path in PUBLIC.rglob("*")
                   if path.suffix in {".html", ".js"} and steps in path.read_text(encoding="utf-8", errors="ignore")]
        self.assertEqual(holders, [str(CONNECT_AI_JS.relative_to(PUBLIC))])
        self.assertNotRegex(source(VAULT_JS), r"https://[^'\"]*/api/mcp")
        self.assertNotRegex(source(WELCOME_JS), r"https://[^'\"]*/api/mcp")

    def test_chatgpt_users_are_told_to_refresh_tools(self):
        # ChatGPT never refreshes a connector's cached tool list on its own.
        self.assertIn("Refresh tools", source(CONNECT_AI_JS))


class OnboardingWiringTests(unittest.TestCase):
    # Choosing how to start is the last setup step: it lands on the feed,
    # which offers to connect an assistant, rather than on a connect screen.
    def test_choosing_a_start_goes_straight_to_the_feed_and_recovers_from_failure(self):
        js = source(WELCOME_JS)
        functions = js[js.index("  function goToFeed("):js.index("  // ---- step 1")]
        functions += js[js.index("  async function choosePersona("):js.index("  function wireStartButtons(")]
        script = r'''
          const assert = require('node:assert/strict');
          const vm = require('node:vm');
          let fail = false, redirects = [], requests = [];
          const controls = [{ disabled: false }, { disabled: false }];
          const error = { textContent: '' };
          const button = { querySelector: () => null, setAttribute() {}, removeAttribute() {} };
          const context = {
            state: {}, Intl,
            location: { replace: url => redirects.push(url) },
            document: { querySelectorAll: () => controls },
            $: () => error,
            api: async (url, options) => {
              requests.push(JSON.parse(options.body));
              if (fail) throw new Error('Try again');
            },
          };
          vm.createContext(context);
          vm.runInContext(FUNCTIONS, context);
          (async () => {
            await context.choosePersona('ai-builder', null);
            assert.equal(requests.at(-1).persona, 'ai-builder');
            assert.equal(redirects.at(-1), '/vault/index.html?welcome=1');
            fail = true;
            await context.choosePersona('empty', button, true);
            assert.equal(redirects.length, 1);
            assert.ok(controls.every(control => !control.disabled));
            assert.match(error.textContent, /Try again/);
            fail = false;
            await context.choosePersona('empty', button, true);
            assert.equal(requests.at(-1).persona, 'empty');
            assert.equal(redirects.at(-1), '/vault/index.html?welcome=1&capture=reminder');
          })().catch(error => { console.error(error); process.exitCode = 1; });
        '''.replace("FUNCTIONS", json.dumps(functions))
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_first_card_editor_opens_once_and_never_in_the_demo(self):
        js = source(PUBLIC / "vault" / "assets" / "aurora-feed.js")
        function = js[js.index("  function openRequestedCapture()"):js.index("  async function load(more)")]
        script = r'''
          const assert = require('node:assert/strict');
          const vm = require('node:vm');
          for (const [sandbox, query, expected, pendingShare = false] of [
            [false, '?welcome=1&capture=reminder&other=keep#overview', 1],
            [true, '?welcome=1&capture=reminder', 0],
            [false, '?capture=reminder', 0],
            [false, '?welcome=1&capture=unknown', 0],
            [false, '?welcome=1&capture=reminder', 0, true],
          ]) {
            const calls = [], location = { href: 'http://localhost/vault/index.html' + query };
            const savedState = {};
            const context = { SANDBOX: sandbox, URL, location, capture: type => calls.push(type),
              window: { CardleShare: { pending: () => pendingShare } },
              history: { state: savedState, replaceState(state, title, url) {
                assert.equal(state, savedState);
                location.href = 'http://localhost' + url;
              } },
            };
            vm.createContext(context);
            vm.runInContext(FUNCTION, context);
            context.openRequestedCapture();
            context.openRequestedCapture();
            assert.equal(calls.length, expected);
            if (pendingShare) assert.equal(new URL(location.href).searchParams.has('capture'), false);
            if (expected) {
              assert.equal(calls[0], 'reminder');
              assert.equal(location.href, 'http://localhost/vault/index.html?welcome=1&other=keep#overview');
            }
          }
        '''.replace("FUNCTION", json.dumps(function))
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_onboarding_is_routed_through_the_vault_function(self):
        rewrites = {r["source"]: r["destination"] for r in json.loads(source(ROOT / "vercel.json"))["rewrites"]}
        self.assertEqual(rewrites["/api/onboarding"], "/api/vault?resource=onboarding")
        self.assertEqual(rewrites["/api/onboarding/samples"], "/api/vault?resource=onboarding&action=samples")
        self.assertIn("api/onboarding/**", source(ROOT / ".vercelignore").splitlines())
        self.assertIn("if (resource === 'onboarding') return onboardingHandler(req, res);", source(API / "vault.js"))

    def test_schema_adds_onboarding_columns_additively(self):
        schema = source(SCHEMA)
        for column in ("onboarded_at timestamptz", "persona text", "sample_cards jsonb not null default '[]'::jsonb"):
            self.assertIn(f"alter table users add column if not exists {column};", schema)

    def test_the_vault_hands_new_accounts_to_onboarding(self):
        vault = source(VAULT_JS)
        self.assertIn("if (status.needsOnboarding) { location.replace('/welcome.html'); return; }", vault)
        self.assertIn("api('/api/onboarding/samples', { method: 'DELETE' })", vault)

    # The installed app opens on the feed (manifest start_url). Signed out --
    # an iPhone home-screen app has its own session -- it must reach sign-in,
    # not a bare feed. So must a browser tab: there is no public feed.
    def test_signed_out_people_are_sent_to_sign_in(self):
        manifest = json.loads(source(PUBLIC / "manifest.webmanifest"))
        self.assertEqual(manifest["start_url"], "/vault/index.html")
        auth = source(VAULT_JS).split("async function initAuth() {", 1)[1].split("\n  }\n", 1)[0]
        signed_in = auth.index("if (session.authenticated && session.isDefault === false) {")
        redirect = auth.index("location.replace(config.setupNeeded ? '/setup' : signInUrl());")
        self.assertLess(signed_in, redirect)
        # Signing out lands on sign-in too.
        self.assertIn("window.location.href = '/signin';", source(VAULT_JS))
        # Onboarding sends a signed-out visitor to sign in, and back.
        self.assertIn("location.replace(config.setupNeeded ? '/setup' : '/signin?next=%2Fwelcome.html');", source(WELCOME_JS))

    def test_welcome_page_works_on_phones_and_by_keyboard(self):
        html = source(WELCOME)
        self.assertIn('<meta name="viewport" content="width=device-width, initial-scale=1">', html)
        self.assertIn('href="/fonts/fonts.css"', html)
        self.assertNotIn("onclick=", html)
        self.assertIn('aria-current', source(WELCOME_JS))
        # Every image the page shows is committed and described.
        for src, alt in re.findall(r'<img src="([^"]+)"[^>]*alt="([^"]+)"', html):
            self.assertTrue((PUBLIC / src.lstrip("/")).is_file(), src)
            self.assertTrue(alt.strip(), src)
        # The feed screenshot under the starter feeds looked like a menu
        # people could click, and the connect step's picture went with it.
        self.assertEqual(len(re.findall(r"<img ", html)), 0)
        self.assertNotIn('data-step="connect"', html)

    # Someone whose session lapsed lands on the sign-in step too, and must not
    # be shown what looks like first-time setup. The 1-3 steps appear only
    # once the server has said this account needs onboarding.
    def test_setup_steps_show_only_to_new_accounts(self):
        html = source(WELCOME)
        self.assertIn('<ol class="progress" aria-label="Setup progress" hidden data-progress-steps>', html)
        self.assertIn(".progress[hidden] { display: none; }", html)
        js = source(WELCOME_JS)
        self.assertIn("const ONBOARDING_STEPS = ['persona'];", js)
        self.assertIn('<span class="eyebrow">Step 2 of 3</span>', html)
        self.assertEqual(re.findall(r'data-progress="(\w+)"', html), ["signin", "persona", "feed"])
        show = js.split("function show(step) {", 1)[1].split("\n  }", 1)[0]
        self.assertIn("$('[data-progress-steps]').hidden = !ONBOARDING_STEPS.includes(step);", show)

    def test_there_is_no_waitlist_or_google_sign_in_step(self):
        self.assertNotIn('data-step="requested"', source(WELCOME))
        self.assertNotIn('data-step="signin"', source(WELCOME))
        self.assertNotIn("gsi/client", source(WELCOME_JS))


class FeedConnectCardTests(unittest.TestCase):
    """Setup no longer has a connect step: the feed offers "Add to Claude" in
    a card above the cards, until the account connects or says not now."""

    def test_the_card_shows_only_to_accounts_without_an_assistant(self):
        js = source(VAULT_JS)
        functions = js[js.index("  const SAMPLE_BANNER_DISMISSED"):js.index("  function showSampleBanner(")]
        script = r'''
          const assert = require('node:assert/strict');
          const vm = require('node:vm');
          const run = async (status, stored = {}, storageBlocked = false) => {
            const shown = [], redirects = [];
            const context = {
              URLSearchParams, location: { search: '', replace: url => redirects.push(url) },
              localStorage: { getItem: key => { if (storageBlocked) throw new Error('blocked'); return stored[key] ?? null; } },
              api: async () => status,
              showSampleBanner() {}, showConnectCard: prompts => shown.push(prompts),
            };
            vm.createContext(context);
            vm.runInContext(FUNCTIONS, context);
            await context.followOnboarding();
            return { shown, redirects };
          };
          const personas = [{ id: 'ai-builder', prompts: ['Which videos have I saved about evals?'] }];
          (async () => {
            let result = await run({ aiConnected: false, persona: 'ai-builder', personas });
            assert.deepEqual(result.shown, [['Which videos have I saved about evals?']]);
            result = await run({ aiConnected: false, persona: 'empty', personas });
            assert.deepEqual(result.shown, [undefined]);
            assert.deepEqual((await run({ aiConnected: true })).shown, []);
            // An older server that doesn't say: no card rather than a wrong one.
            assert.deepEqual((await run({})).shown, []);
            assert.deepEqual((await run({ aiConnected: false }, { 'cardle-connect-card-dismissed': 'true' })).shown, []);
            assert.equal((await run({ aiConnected: false }, {}, true)).shown.length, 1);
            result = await run({ needsOnboarding: true, aiConnected: false });
            assert.deepEqual(result.redirects, ['/welcome.html']);
            assert.deepEqual(result.shown, []);
          })().catch(error => { console.error(error); process.exitCode = 1; });
        '''.replace("FUNCTIONS", json.dumps(functions))
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_card_has_one_main_button_and_a_way_out(self):
        js = source(VAULT_JS)
        card = js[js.index("  function showConnectCard("):js.index("  // About & help's \"Sign out on all devices\"")]
        self.assertIn("Ask Claude about your feed", card)
        self.assertIn('class="cardle-connect-card-primary"', card)
        self.assertEqual(card.count("cardle-connect-card-primary"), 1)
        # This Cardlake is added to Claude by its own address, so both buttons
        # open the Connect AI panel instead of keeping a second copy of the steps.
        self.assertIn("openApiTokensModal(event.currentTarget, 'claude')", card)
        self.assertIn("openApiTokensModal(event.currentTarget, 'chatgpt')", card)
        self.assertNotIn("Add custom connector", card)
        self.assertNotIn("claude.ai/directory", card)
        self.assertIn("rememberDismissed(CONNECT_CARD_DISMISSED); card.remove();", card)
        # Once connected, the button gives way to questions to try.
        connected = card[card.index("whenAssistantConnects(card, () => {"):]
        self.assertIn("card.querySelector('[data-connect-card-actions]').hidden = true;", connected)
        self.assertIn("card.querySelector('[data-connect-card-prompts]').hidden = false;", connected)
        self.assertIn(".cardle-connect-card{", source(VAULT_INDEX))


if __name__ == "__main__":
    unittest.main()
