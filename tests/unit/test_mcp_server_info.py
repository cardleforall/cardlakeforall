"""What an MCP client sees when it connects to Cardlake: server identity and
icons, instructions for the model, and per-tool safety hints. Drives a real
SDK client against the server over an in-memory transport -- no auth, no
database, no network."""
from __future__ import annotations

import json
import os
import re
import struct
import subprocess
import unittest
from urllib.parse import urlparse

from ._paths import ROOT

PUBLIC = ROOT / "public"

# Connects one client per scenario and prints what it saw on connect.
INSPECT_SCRIPT = r'''
(async () => {
  const { createMcpServer } = require('./api/_lib/mcp-server');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  async function inspect(tenant, scopes) {
    const server = await createMcpServer(tenant, scopes);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cardle-test', version: '0.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const seen = {
      serverInfo: client.getServerVersion(),
      instructions: client.getInstructions() ?? null,
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

READ_TOOLS = {"list_feed", "search_cards", "get_card", "get_dashboard_stats", "get_account", "list_integrations"}
REPEATABLE_FEED_ACTIONS = {"pin_card", "unpin_card", "like_card", "unlike_card", "snooze_card", "unsnooze_card"}


def png_size(path):
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise AssertionError(f"{path.name} is not a PNG")
    width, height = struct.unpack(">II", data[16:24])
    return f"{width}x{height}"


ORIGIN = "https://cardlake.example"


class PublicOriginTests(unittest.TestCase):
    # A self-hosted copy must never point people or AI assistants at someone
    # else's deployment, so there is no hosted fallback.
    def origin(self, env):
        script = f"console.log(require('./api/_lib/public-origin').publicOrigin({json.dumps(env)}))"
        return subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()

    def test_configured_origin_wins(self):
        self.assertEqual(self.origin({"CARDLE_PUBLIC_ORIGIN": "https://notes.example/", "VERCEL_PROJECT_PRODUCTION_URL": "x.vercel.app"}), "https://notes.example")

    def test_falls_back_to_this_vercel_project_then_localhost(self):
        self.assertEqual(self.origin({"VERCEL_PROJECT_PRODUCTION_URL": "my-cardlake.vercel.app"}), "https://my-cardlake.vercel.app")
        self.assertEqual(self.origin({}), "http://localhost:3000")


class McpServerInfoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = {**os.environ, "CARDLE_PUBLIC_ORIGIN": ORIGIN}
        result = subprocess.run(["node", "-e", INSPECT_SCRIPT], cwd=ROOT, capture_output=True, text=True, env=env)
        if result.returncode != 0:
            raise AssertionError(result.stderr)
        cls.seen = json.loads(result.stdout)
        cls.tools = {tool["name"]: tool for tool in cls.seen["alice"]["tools"]}

    def test_server_identifies_itself_with_icons_hosted_on_its_own_deployment(self):
        info = self.seen["alice"]["serverInfo"]
        self.assertEqual(info["name"], "cardle")
        self.assertEqual(info.get("title"), "Cardlake")
        self.assertTrue(info.get("description", "").strip())
        self.assertEqual(info.get("websiteUrl"), ORIGIN)
        icons = info.get("icons") or []
        self.assertTrue(icons, "serverInfo must declare icons")
        for icon in icons:
            # A third-party host would see every client that renders the icon.
            self.assertTrue(icon["src"].startswith(ORIGIN + "/"), icon["src"])

    def test_every_declared_icon_is_a_real_public_file_of_its_declared_size(self):
        icons = self.seen["alice"]["serverInfo"].get("icons") or []
        self.assertTrue(icons, "serverInfo must declare icons")
        for icon in icons:
            path = PUBLIC / urlparse(icon["src"]).path.lstrip("/")
            self.assertTrue(path.is_file(), f"{icon['src']} has no file at {path}")
            if icon.get("mimeType") == "image/png":
                self.assertEqual(icon.get("sizes"), [png_size(path)], icon["src"])
            if icon.get("mimeType") == "image/svg+xml":
                self.assertIn("<svg", path.read_text(encoding="utf-8"))

    def test_instructions_point_the_model_at_list_feed_and_carry_no_account_data(self):
        instructions = self.seen["alice"]["instructions"]
        self.assertTrue(instructions and instructions.strip(), "server must send instructions")
        self.assertIn("list_feed", instructions)
        self.assertNotIn("alice@example.com", instructions)
        self.assertEqual(instructions, self.seen["bob"]["instructions"])

    def test_instructions_describe_how_results_render_without_forbidding_other_tools(self):
        # The instructions describe the server and never restrict other
        # connected tools, even when a model might otherwise reach for an
        # unrelated one.
        instructions = self.seen["alice"]["instructions"]
        self.assertIn("MCP Apps", instructions)
        for name in ("list_feed", "search_cards", "get_card"):
            self.assertIn(name, instructions)
        self.assertIn("other clients show the same data as plain text", instructions)
        for directive in ("never call", "no other tool", "don't use", "do not use"):
            self.assertNotIn(directive, instructions.lower())

    def test_create_work_item_description_is_a_full_sentence_about_the_checklist(self):
        description = self.tools["create_work_item"]["description"]
        self.assertIn("optionally with a checklist of sub-items", description)

    def test_talking_point_tools_are_called_misc_and_keep_their_names(self):
        # People call this card type "Misc"; its tool names and card type stay
        # talking_point so connected assistants keep working.
        for action in ("create", "update", "delete"):
            tool = self.tools[f"{action}_talking_point"]
            self.assertIn("Misc", tool["title"])
            self.assertNotIn("Talking", tool["title"])
        for name in ("create_talking_point", "update_talking_point", "list_feed"):
            self.assertIn("Misc", self.tools[name]["description"], name)
        self.assertIn("talking_point", self.tools["create_talking_point"]["description"])
        instructions = self.seen["alice"]["instructions"]
        self.assertIn("Misc", instructions)
        self.assertIn("talking_point", instructions)

    def test_nothing_an_assistant_reads_says_talking_points(self):
        texts = [self.seen["alice"]["instructions"]]
        for tool in self.tools.values():
            texts += [tool.get("title") or "", tool.get("description") or "", json.dumps(tool.get("inputSchema") or {})]
        stale = [text[:80] for text in texts if re.search(r"talking points?\b", text, re.I)]
        self.assertEqual(stale, [])

    def test_every_tool_says_whether_it_only_reads(self):
        for name, tool in self.tools.items():
            self.assertIn("readOnlyHint", tool.get("annotations") or {}, name)

    def test_every_tool_repeats_its_title_in_its_annotations(self):
        for name, tool in self.tools.items():
            self.assertTrue(tool.get("title"), name)
            self.assertEqual((tool.get("annotations") or {}).get("title"), tool["title"], name)

    def test_read_tools_are_marked_read_only(self):
        for name in READ_TOOLS:
            self.assertIs((self.tools[name].get("annotations") or {}).get("readOnlyHint"), True, name)

    def test_delete_tools_are_marked_destructive(self):
        deletes = [name for name in self.tools if name.startswith("delete_")]
        self.assertTrue(deletes)
        for name in deletes:
            annotations = self.tools[name].get("annotations") or {}
            self.assertIs(annotations.get("readOnlyHint"), False, name)
            self.assertIs(annotations.get("destructiveHint"), True, name)

    def test_feed_actions_are_marked_safe_to_repeat(self):
        for name in REPEATABLE_FEED_ACTIONS:
            annotations = self.tools[name].get("annotations") or {}
            self.assertIs(annotations.get("readOnlyHint"), False, name)
            self.assertIs(annotations.get("destructiveHint"), False, name)
            self.assertIs(annotations.get("idempotentHint"), True, name)

    def test_create_tools_write_but_are_not_destructive(self):
        creates = [name for name in self.tools if name.startswith("create_")]
        self.assertTrue(creates)
        for name in creates:
            annotations = self.tools[name].get("annotations") or {}
            self.assertIs(annotations.get("readOnlyHint"), False, name)
            self.assertIs(annotations.get("destructiveHint"), False, name)

    def test_update_tools_are_marked_destructive_because_they_overwrite(self):
        # OpenAI's tool scan flags an update marked non-destructive: it replaces
        # what a card held and can clear a field.
        updates = [name for name in self.tools if name.startswith("update_")]
        self.assertTrue(updates)
        for name in updates:
            annotations = self.tools[name].get("annotations") or {}
            self.assertIs(annotations.get("readOnlyHint"), False, name)
            self.assertIs(annotations.get("destructiveHint"), True, name)
            self.assertIs(annotations.get("idempotentHint"), True, name)

    def test_github_sync_is_marked_as_reaching_an_outside_service(self):
        annotations = self.tools["sync_github_issues"].get("annotations") or {}
        self.assertIs(annotations.get("openWorldHint"), True)

    def test_read_only_grant_lists_only_read_tools_with_their_hints(self):
        tools = {tool["name"]: tool for tool in self.seen["readOnly"]["tools"]}
        self.assertEqual(set(tools), READ_TOOLS)
        for name, tool in tools.items():
            self.assertIs((tool.get("annotations") or {}).get("readOnlyHint"), True, name)

    def test_delete_descriptions_match_what_delete_does(self):
        for name, tool in self.tools.items():
            if not name.startswith("delete_"):
                continue
            description = tool["description"]
            # Deletes set deleted_at; the row is kept, so "permanently" overstates it.
            self.assertNotIn("ermanently", description, name)
            for removed in ("pins", "likes", "attachments"):
                self.assertIn(removed, description, name)

    def test_reads_sync_feed_actions_and_deletes_declare_their_output_shape(self):
        expected = READ_TOOLS | REPEATABLE_FEED_ACTIONS | {"sync_github_issues"} | {
            name for name in self.tools if name.startswith("delete_")}
        declared = {name for name, tool in self.tools.items() if tool.get("outputSchema")}
        self.assertEqual(declared, expected)
        for name in declared:
            self.assertEqual(self.tools[name]["outputSchema"].get("type"), "object", name)
        # Their results differ per card type, so they stay undeclared for now.
        for name in self.tools:
            if name.startswith(("create_", "update_")):
                self.assertNotIn("outputSchema", self.tools[name], name)

    def test_list_feed_schema_describes_cards_and_paging(self):
        schema = self.tools["list_feed"].get("outputSchema") or {}
        properties = schema.get("properties") or {}
        for field in ("cards", "next_cursor", "stats"):
            self.assertIn(field, properties)
        card = properties["cards"].get("items") or {}
        for field in ("id", "type", "title"):
            self.assertIn(field, card.get("properties") or {})

    def test_read_only_grant_keeps_output_schemas_on_its_read_tools(self):
        tools = {tool["name"]: tool for tool in self.seen["readOnly"]["tools"]}
        self.assertEqual(set(tools), READ_TOOLS)
        for name, tool in tools.items():
            self.assertTrue(tool.get("outputSchema"), name)

    def test_site_root_serves_a_favicon_ico(self):
        favicon = PUBLIC / "favicon.ico"
        self.assertTrue(favicon.is_file(), "public/favicon.ico is missing")
        self.assertEqual(favicon.read_bytes()[:4], b"\x00\x00\x01\x00", "favicon.ico is not an ICO file")


if __name__ == "__main__":
    unittest.main()
