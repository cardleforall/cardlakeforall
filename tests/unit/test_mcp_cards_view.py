"""The MCP Apps card view: how the server offers it (a ui:// resource that
list_feed, search_cards and get_card point at), that it loads nothing from
outside, and -- in mcp_view_scenarios.js -- that it speaks the MCP Apps
protocol (spec 2026-01-26) with a host and treats card text as text."""
from __future__ import annotations

import json
import re
import subprocess
import unittest

from ._paths import ROOT

VIEW_URI = "ui://cardle/cards.html"
MIME = "text/html;profile=mcp-app"
OPENAI_VIEW_URI = "ui://cardle/cards-openai.html"
OPENAI_MIME = "text/html+skybridge"
VIEW_TOOLS = {"list_feed", "search_cards", "get_card"}
SCENARIOS = ROOT / "tests" / "unit" / "mcp_view_scenarios.js"

INSPECT_SCRIPT = r'''
(async () => {
  const { createMcpServer } = require('./api/_lib/mcp-server');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const attempt = async fn => { try { return await fn(); } catch (error) { return { error: String(error.message || error) }; } };
  async function inspect(tenant, scopes) {
    const server = await createMcpServer(tenant, scopes);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cardle-test', version: '0.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const seen = {
      resources: await attempt(async () => (await client.listResources()).resources),
      read: await attempt(() => client.readResource({ uri: 'ui://cardle/cards.html' })),
      readOpenai: await attempt(() => client.readResource({ uri: 'ui://cardle/cards-openai.html' })),
      tools: (await client.listTools()).tools,
    };
    await client.close();
    return seen;
  }
  process.stdout.write(JSON.stringify({
    alice: await inspect('alice@example.com'),
    bob: await inspect('bob@example.com'),
    readOnly: await inspect('alice@example.com', ['cardle.read']),
  }));
})().catch(error => { console.error(error.stack || error); process.exit(1); });
'''


class CardsViewServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(["node", "-e", INSPECT_SCRIPT], cwd=ROOT, capture_output=True, text=True)
        if result.returncode != 0:
            raise AssertionError(result.stderr)
        cls.seen = json.loads(result.stdout)

    def html(self, who="alice"):
        read = self.seen[who]["read"]
        self.assertNotIn("error", read, f"resources/read failed: {read}")
        contents = read["contents"]
        self.assertEqual(len(contents), 1)
        self.assertEqual(contents[0]["uri"], VIEW_URI)
        self.assertEqual(contents[0]["mimeType"], MIME)
        return contents[0]["text"]

    def test_resources_list_offers_the_view_as_an_mcp_app(self):
        resources = self.seen["alice"]["resources"]
        self.assertIsInstance(resources, list, f"resources/list failed: {resources}")
        view = [r for r in resources if r["uri"] == VIEW_URI]
        self.assertEqual(len(view), 1)
        self.assertEqual(view[0]["mimeType"], MIME)

    def test_resources_list_also_offers_the_chatgpt_skybridge_widget(self):
        resources = self.seen["alice"]["resources"]
        view = [r for r in resources if r["uri"] == OPENAI_VIEW_URI]
        self.assertEqual(len(view), 1)
        self.assertEqual(view[0]["mimeType"], OPENAI_MIME)
        self.assertEqual(view[0].get("_meta", {}).get("openai/widgetAccessible"), True)

    def test_the_chatgpt_widget_serves_the_same_html(self):
        read = self.seen["alice"]["readOpenai"]
        self.assertNotIn("error", read, f"resources/read failed: {read}")
        contents = read["contents"]
        self.assertEqual(len(contents), 1)
        self.assertEqual(contents[0]["uri"], OPENAI_VIEW_URI)
        self.assertEqual(contents[0]["mimeType"], OPENAI_MIME)
        self.assertEqual(contents[0]["text"], self.html())

    def test_the_view_is_an_html5_document(self):
        html = self.html()
        self.assertTrue(html.lstrip().lower().startswith("<!doctype html>"))
        self.assertIn("<script>", html)
        self.assertEqual(html, self.html("bob"), "the view is the same for every account")
        self.assertNotIn("alice@example.com", html)

    def test_the_view_loads_nothing_from_outside(self):
        html = self.html()
        self.assertNotRegex(html, r"""(src|href)\s*=\s*["']?\s*(https?:)?//""")
        self.assertNotRegex(html, r"@import|url\(\s*['\"]?(https?:)?//")
        self.assertNotRegex(html, r"\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts")
        # Its CSP is declared and allows no domains: the strictest policy,
        # stated outright so no host (ChatGPT) runs the view with CSP off.
        meta = self.seen["alice"]["read"]["contents"][0].get("_meta") or {}
        self.assertEqual(meta.get("ui", {}).get("csp"), {"connectDomains": [], "resourceDomains": []})

    def test_exactly_the_card_tools_point_at_the_view(self):
        pointing = {tool["name"] for tool in self.seen["alice"]["tools"]
                    if ((tool.get("_meta") or {}).get("ui") or {}).get("resourceUri") == VIEW_URI}
        self.assertEqual(pointing, VIEW_TOOLS)

    def test_the_same_tools_point_openai_at_the_skybridge_widget(self):
        # ChatGPT's Apps SDK reads its own resource type (text/html+skybridge),
        # not the MCP Apps one Claude reads, so openai/outputTemplate points
        # at the second, ChatGPT-specific resource, not the shared one.
        pointing = {tool["name"] for tool in self.seen["alice"]["tools"]
                    if (tool.get("_meta") or {}).get("openai/outputTemplate") == OPENAI_VIEW_URI}
        self.assertEqual(pointing, VIEW_TOOLS)

    def test_the_same_tools_are_marked_widget_accessible_for_chatgpt(self):
        pointing = {tool["name"] for tool in self.seen["alice"]["tools"]
                    if (tool.get("_meta") or {}).get("openai/widgetAccessible") is True}
        self.assertEqual(pointing, VIEW_TOOLS)

    def test_the_same_tools_declare_chatgpt_invocation_status_text(self):
        for tool in self.seen["alice"]["tools"]:
            if tool["name"] not in VIEW_TOOLS:
                continue
            meta = tool.get("_meta") or {}
            self.assertTrue((meta.get("openai/toolInvocation/invoking") or "").strip(), tool["name"])
            self.assertTrue((meta.get("openai/toolInvocation/invoked") or "").strip(), tool["name"])

    def test_read_only_grant_gets_the_view_too(self):
        self.assertEqual(self.html("readOnly"), self.html())
        pointing = {tool["name"] for tool in self.seen["readOnly"]["tools"] if (tool.get("_meta") or {}).get("ui")}
        self.assertEqual(pointing, VIEW_TOOLS)


class CardsViewProtocolTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        result = subprocess.run(["node", str(SCENARIOS), name], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_view_initializes_with_the_host_and_applies_its_theme(self):
        self.run_scenario("view_initializes_with_the_host_and_applies_its_theme")

    def test_view_renders_feed_pages_search_results_and_single_cards(self):
        self.run_scenario("view_renders_feed_pages_search_results_and_single_cards")

    def test_view_labels_talking_point_cards_as_misc(self):
        self.run_scenario("view_labels_talking_point_cards_as_misc")

    def test_view_treats_card_text_as_text(self):
        self.run_scenario("view_treats_card_text_as_text")

    def test_view_opens_only_web_links_through_the_host(self):
        self.run_scenario("view_opens_only_web_links_through_the_host")

    def test_view_ignores_other_senders_and_answers_teardown(self):
        self.run_scenario("view_ignores_other_senders_and_answers_teardown")

    def test_view_offers_pin_and_like_only_when_the_host_can_run_tools(self):
        self.run_scenario("view_offers_pin_and_like_only_when_the_host_can_run_tools")

    def test_view_pins_and_likes_through_the_host(self):
        self.run_scenario("view_pins_and_likes_through_the_host")

    def test_view_offers_remind_later_and_delete_by_card_state(self):
        self.run_scenario("view_offers_remind_later_and_delete_by_card_state")

    def test_view_snoozes_and_brings_back_through_the_host(self):
        self.run_scenario("view_snoozes_and_brings_back_through_the_host")

    def test_view_deletes_only_after_confirming(self):
        self.run_scenario("view_deletes_only_after_confirming")

    def test_view_only_updates_model_context_when_the_host_supports_it(self):
        self.run_scenario("view_only_updates_model_context_when_the_host_supports_it")

    def test_view_shows_why_an_action_failed(self):
        self.run_scenario("view_shows_why_an_action_failed")

    def test_view_shows_a_work_cards_checklist(self):
        self.run_scenario("view_shows_a_work_cards_checklist")


if __name__ == "__main__":
    unittest.main()
