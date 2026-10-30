"""Cardlake's ready-made MCP prompts (daily review, weekly recap, find a card),
as a real SDK client sees them over an in-memory transport -- no auth, no
database, no network."""
from __future__ import annotations

import json
import subprocess
import unittest

from ._paths import ROOT

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
    const listed = await attempt(async () => (await client.listPrompts()).prompts);
    const got = {};
    for (const [name, args] of [['daily_review', {}], ['weekly_recap', {}], ['find_card', { about: 'the dentist appointment' }]]) {
      got[name] = await attempt(() => client.getPrompt({ name, arguments: args }));
    }
    const findWithoutArgs = await attempt(() => client.getPrompt({ name: 'find_card', arguments: {} }));
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    await client.close();
    return { listed, got, findWithoutArgs, tools };
  }
  process.stdout.write(JSON.stringify({
    alice: await inspect('alice@example.com'),
    bob: await inspect('bob@example.com'),
    readOnly: await inspect('alice@example.com', ['cardle.read']),
  }));
})().catch(error => { console.error(error.stack || error); process.exit(1); });
'''

PROMPTS = {"daily_review", "weekly_recap", "find_card"}


def text_of(result):
    return "\n".join(message["content"]["text"] for message in result["messages"])


class McpPromptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(["node", "-e", INSPECT_SCRIPT], cwd=ROOT, capture_output=True, text=True)
        if result.returncode != 0:
            raise AssertionError(result.stderr)
        cls.seen = json.loads(result.stdout)

    def listed(self, who="alice"):
        listed = self.seen[who]["listed"]
        self.assertIsInstance(listed, list, f"prompts/list failed: {listed}")
        return {prompt["name"]: prompt for prompt in listed}

    def got(self, name, who="alice"):
        result = self.seen[who]["got"][name]
        self.assertNotIn("error", result, f"prompts/get {name} failed: {result}")
        return result

    def test_prompts_list_shows_the_three_prompts_with_titles_and_descriptions(self):
        prompts = self.listed()
        self.assertEqual(set(prompts), PROMPTS)
        for name, prompt in prompts.items():
            self.assertTrue(prompt.get("title"), name)
            self.assertTrue(prompt.get("description"), name)
        self.assertEqual([arg["name"] for arg in prompts["find_card"].get("arguments", [])], ["about"])
        self.assertIs(prompts["find_card"]["arguments"][0].get("required"), True)

    def test_each_prompt_is_a_user_message_naming_the_tools_to_call(self):
        expected_tools = {"daily_review": ["list_feed"], "weekly_recap": ["get_dashboard_stats", "list_feed"],
                          "find_card": ["search_cards", "get_card"]}
        real_tools = set(self.seen["alice"]["tools"])
        for name, tools in expected_tools.items():
            result = self.got(name)
            self.assertTrue(result["messages"])
            for message in result["messages"]:
                self.assertEqual(message["role"], "user", name)
                self.assertEqual(message["content"]["type"], "text", name)
            for tool in tools:
                self.assertIn(tool, text_of(result), name)
                self.assertIn(tool, real_tools, f"{name} names {tool}, which doesn't exist")

    def test_find_card_carries_its_argument_and_requires_it(self):
        self.assertIn("the dentist appointment", text_of(self.got("find_card")))
        self.assertIn("error", self.seen["alice"]["findWithoutArgs"])

    def test_prompts_ask_before_changing_cards(self):
        for name in PROMPTS:
            self.assertRegex(text_of(self.got(name)).lower(), r"don't (change|snooze)", name)

    def test_prompts_are_the_same_for_every_account_and_carry_no_account_data(self):
        for name in PROMPTS:
            alice, bob = self.got(name, "alice"), self.got(name, "bob")
            self.assertEqual(alice, bob, name)
            self.assertNotIn("alice@example.com", json.dumps(alice), name)

    def test_read_only_grant_gets_the_prompts(self):
        self.assertEqual(set(self.listed("readOnly")), PROMPTS)


if __name__ == "__main__":
    unittest.main()
