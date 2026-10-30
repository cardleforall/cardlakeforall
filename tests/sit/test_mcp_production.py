"""System integration tests for the deployed MCP server (/api/mcp): what an
AI client actually gets from production, over HTTPS, against the real
database. The unit tests (tests/unit/mcp_scenarios.js) run the same code
in-process against PGlite; these catch what only the deployment can get
wrong -- Vercel's request shaping, real Postgres types in structured
results, an icon URL that isn't served.

Setup mints a personal access token for the shared 'default' tenant with
SYNC_TOKEN (the same account test_production.py writes to), and cleanup
revokes it. The one card created has an invocation-unique title and is
soft-deleted. Skipped, like the rest of the tier, when SYNC_TOKEN is unset.
"""
from __future__ import annotations

import json
import os
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

# No default: these tests write to whatever deployment they are pointed at,
# so the target is always chosen explicitly.
BASE_URL = os.environ.get("CARDLE_URL", "").rstrip("/")
SYNC_TOKEN = os.environ.get("SYNC_TOKEN")

READ_TOOLS = {"list_feed", "search_cards", "get_card", "get_dashboard_stats", "get_account", "list_integrations"}
FEED_ACTIONS = {"snooze_card", "unsnooze_card", "pin_card", "unpin_card", "like_card", "unlike_card"}


def http(path, method="GET", body=None, headers=None):
    headers = {"Accept": "application/json", **(headers or {})}
    data = None if body is None else json.dumps(body).encode("utf-8")
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = Request(BASE_URL + path, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8") or "null")
    except HTTPError as error:
        payload = error.read().decode("utf-8")
        try:
            return error.code, json.loads(payload)
        except json.JSONDecodeError:
            return error.code, {"raw": payload}


def mint_token(label):
    status, body = http("/api/auth/tokens", "POST", {"label": label}, {"x-sync-token": SYNC_TOKEN})
    if status != 201:
        raise AssertionError(f"could not mint an MCP token: {status} {body}")
    return body["token"]


def revoke_token(token_id):
    status, body = http(f"/api/auth/tokens?id={token_id}", "DELETE", headers={"x-sync-token": SYNC_TOKEN})
    if status not in (200, 404):
        raise AssertionError(f"could not revoke MCP token {token_id}: {status} {body}")


def mcp(method, params=None, token=None, protocol_version=None):
    """One JSON-RPC call to /api/mcp. The endpoint is stateless and answers
    in plain JSON (enableJsonResponse), so each call stands alone."""
    headers = {"Accept": "application/json, text/event-stream"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if protocol_version:
        headers["MCP-Protocol-Version"] = protocol_version
    return http("/api/mcp", "POST", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}, headers)


# Just enough JSON Schema to check what the SDK emits for Cardlake's output
# schemas (type, anyOf, enum, properties, required, items,
# additionalProperties: false), with no new dependency for the tier.
def _has_type(value, name):
    return {
        "string": isinstance(value, str),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "null": value is None,
    }.get(name, True)


def schema_errors(value, schema, path="$"):
    if "anyOf" in schema:
        if all(schema_errors(value, branch, path) for branch in schema["anyOf"]):
            return [f"{path}: matches none of {schema['anyOf']}"]
        return []
    expected = schema.get("type")
    if expected is not None:
        names = expected if isinstance(expected, list) else [expected]
        if not any(_has_type(value, name) for name in names):
            return [f"{path}: expected {expected}, got {type(value).__name__}"]
    errors = []
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: {value!r} not in {schema['enum']}")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        errors += [f"{path}: missing {key}" for key in schema.get("required", []) if key not in value]
        for key, sub in properties.items():
            if key in value:
                errors += schema_errors(value[key], sub, f"{path}.{key}")
        if schema.get("additionalProperties") is False:
            errors += [f"{path}: unexpected {key}" for key in value if key not in properties]
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for index, item in enumerate(value):
            errors += schema_errors(item, schema["items"], f"{path}[{index}]")
    return errors


class SchemaCheckTests(unittest.TestCase):
    """The checker above must reject a wrong shape, or the production tests
    that rely on it would pass vacuously. Runs without SYNC_TOKEN."""

    SCHEMA = {"type": "object", "required": ["id", "when"], "additionalProperties": False, "properties": {
        "id": {"type": "string"}, "when": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "tags": {"type": "array", "items": {"type": "string", "enum": ["a", "b"]}}}}

    def test_accepts_a_matching_value(self):
        self.assertEqual(schema_errors({"id": "x", "when": None, "tags": ["a"]}, self.SCHEMA), [])

    def test_rejects_wrong_types_missing_and_extra_fields(self):
        self.assertTrue(schema_errors({"id": 1, "when": None}, self.SCHEMA))
        self.assertTrue(schema_errors({"id": "x"}, self.SCHEMA))
        self.assertTrue(schema_errors({"id": "x", "when": 3}, self.SCHEMA))
        self.assertTrue(schema_errors({"id": "x", "when": None, "extra": 1}, self.SCHEMA))
        self.assertTrue(schema_errors({"id": "x", "when": None, "tags": ["c"]}, self.SCHEMA))


@unittest.skipUnless(BASE_URL and SYNC_TOKEN, "Set CARDLE_URL and SYNC_TOKEN to run the system tests")
class ProductionMcpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        minted = mint_token(f"sit-mcp-{uuid4().hex}")
        cls.token = minted["token"]
        cls.addClassCleanup(revoke_token, minted["id"])
        status, body = mcp("initialize", {
            "protocolVersion": "2025-11-25",
            "capabilities": {},
            "clientInfo": {"name": "cardle-sit", "version": "0.0.0"},
        }, cls.token)
        if status != 200 or "result" not in body:
            raise AssertionError(f"initialize failed: {status} {body}")
        cls.init = body["result"]
        cls.protocol = cls.init["protocolVersion"]
        status, body = mcp("tools/list", token=cls.token, protocol_version=cls.protocol)
        if status != 200 or "result" not in body:
            raise AssertionError(f"tools/list failed: {status} {body}")
        cls.tools = {tool["name"]: tool for tool in body["result"]["tools"]}

    def call(self, name, arguments=None):
        status, body = mcp("tools/call", {"name": name, "arguments": arguments or {}}, self.token, self.protocol)
        self.assertEqual(status, 200, body)
        self.assertIn("result", body, body)
        return body["result"]

    def structured(self, name, arguments=None, result=None):
        """Calls a tool that must succeed (or takes its result), and checks
        the structured result against the text and the output schema."""
        result = result or self.call(name, arguments)
        self.assertFalse(result.get("isError"), (name, result))
        data = result.get("structuredContent")
        self.assertIsInstance(data, dict, f"{name} returned no structuredContent")
        self.assertEqual(data, json.loads(result["content"][0]["text"]), f"{name}: structured and text differ")
        schema = self.tools[name].get("outputSchema")
        if schema:
            self.assertEqual(schema_errors(data, schema), [], f"{name} doesn't match its outputSchema")
        return data

    def test_initialize_identifies_cardle_with_icons_and_instructions(self):
        info = self.init["serverInfo"]
        self.assertEqual(info["name"], "cardle")
        self.assertEqual(info.get("title"), "Cardlake")
        self.assertTrue(info.get("websiteUrl", "").startswith("http"), info.get("websiteUrl"))
        self.assertTrue(info.get("icons"))
        self.assertIn("list_feed", self.init.get("instructions", ""))
        self.assertIn("tools", self.init.get("capabilities", {}))

    def test_declared_icons_are_served_with_their_type(self):
        for icon in self.init["serverInfo"]["icons"]:
            self.assertTrue(icon["src"].startswith(self.init["serverInfo"]["websiteUrl"] + "/"), icon["src"])
            with urlopen(Request(icon["src"], method="GET"), timeout=30) as response:
                self.assertEqual(response.status, 200, icon["src"])
                self.assertEqual(response.headers.get_content_type(), icon["mimeType"], icon["src"])

    def test_every_tool_has_safety_hints_and_the_expected_output_schemas(self):
        for name, tool in self.tools.items():
            self.assertIn("readOnlyHint", tool.get("annotations") or {}, name)
        for name in READ_TOOLS:
            self.assertIs(self.tools[name]["annotations"]["readOnlyHint"], True, name)
        deletes = {name for name in self.tools if name.startswith("delete_")}
        self.assertTrue(deletes)
        for name in deletes:
            self.assertIs(self.tools[name]["annotations"]["destructiveHint"], True, name)
        declared = {name for name, tool in self.tools.items() if tool.get("outputSchema")}
        self.assertEqual(declared, READ_TOOLS | FEED_ACTIONS | {"sync_github_issues"} | deletes)

    def test_read_tools_return_structured_results_matching_their_schemas(self):
        feed = self.structured("list_feed")
        self.assertIsInstance(feed["cards"], list)
        page = self.structured("list_feed", {"limit": 2})
        self.assertLessEqual(len(page["cards"]), 2)
        self.structured("list_feed", {"view": "snoozed"})
        self.structured("get_dashboard_stats")
        self.structured("list_integrations")
        account = self.structured("get_account")
        self.assertEqual(account, {"account_id": "default", "email": None, "display_name": None})

    def test_a_card_round_trips_through_mcp_and_is_deleted(self):
        title = "integration-test-mcp-" + uuid4().hex
        card_id = None
        try:
            # Take the id from the text before any check can fail, so cleanup
            # always knows what to delete.
            result = self.call("create_reminder", {"title": title, "due_date": "2030-01-01"})
            if not result.get("isError"):
                card_id = json.loads(result["content"][0]["text"])["id"]
            created = self.structured("create_reminder", result=result)
            self.assertEqual(created["title"], title)
            self.assertNotIn("user_email", created)
            card = {"card_type": "reminder", "card_id": card_id}
            # like and snooze rather than pin: the shared account may already
            # hold the 3 pins allowed.
            self.assertTrue(self.structured("like_card", card)["liked_at"])
            self.assertTrue(self.structured("snooze_card", {**card, "days": 2})["snoozed_until"])
            self.assertIsNone(self.structured("unsnooze_card", card)["snoozed_until"])
            self.assertIsNone(self.structured("unlike_card", card)["liked_at"])
            updated = self.structured("update_reminder", {"id": card_id, "completed": True})
            self.assertIs(updated["completed"], True)
            # A finished card has left the feed, so there is nothing to snooze.
            refused = self.call("snooze_card", card)
            self.assertTrue(refused.get("isError"), refused)
            # Findable by its (unique) title, and readable in full.
            found = self.structured("search_cards", {"query": title})
            self.assertEqual([(c["type"], c["id"]) for c in found["cards"]], [("reminder", card_id)])
            self.assertEqual(found["total"], 1)
            self.assertEqual(self.structured("get_card", card)["card"]["title"], title)
            self.assertEqual(self.structured("delete_reminder", {"id": card_id}), {"deleted": True})
            # Gone: acting on it again is an error, not a silent success, and
            # neither search nor get_card finds it.
            again = self.call("delete_reminder", {"id": card_id})
            self.assertTrue(again.get("isError"), again)
            self.assertEqual(self.structured("search_cards", {"query": title})["total"], 0)
            self.assertTrue(self.call("get_card", card).get("isError"))
            card_id = None
        finally:
            if card_id:
                self.call("delete_reminder", {"id": card_id})

    def test_ready_made_prompts_are_listed_and_served(self):
        status, body = mcp("prompts/list", token=self.token, protocol_version=self.protocol)
        self.assertEqual(status, 200, body)
        self.assertEqual({p["name"] for p in body["result"]["prompts"]}, {"daily_review", "weekly_recap", "find_card"})
        status, body = mcp("prompts/get", {"name": "find_card", "arguments": {"about": "dentist"}}, self.token, self.protocol)
        self.assertEqual(status, 200, body)
        text = body["result"]["messages"][0]["content"]["text"]
        self.assertIn("dentist", text)
        self.assertIn("search_cards", text)

    def test_card_view_is_offered_and_served(self):
        uri = "ui://cardle/cards.html"
        openai_uri = "ui://cardle/cards-openai.html"
        status, body = mcp("resources/list", token=self.token, protocol_version=self.protocol)
        self.assertEqual(status, 200, body)
        resources = {r["uri"]: r for r in body["result"]["resources"]}
        self.assertIn(uri, resources)
        self.assertIn(openai_uri, resources)
        self.assertEqual(resources[openai_uri]["mimeType"], "text/html+skybridge")
        self.assertIs(resources[openai_uri].get("_meta", {}).get("openai/widgetAccessible"), True)
        status, body = mcp("resources/read", {"uri": uri}, self.token, self.protocol)
        self.assertEqual(status, 200, body)
        content = body["result"]["contents"][0]
        self.assertEqual(content["mimeType"], "text/html;profile=mcp-app")
        self.assertTrue(content["text"].lstrip().lower().startswith("<!doctype html>"))
        status, body = mcp("resources/read", {"uri": openai_uri}, self.token, self.protocol)
        self.assertEqual(status, 200, body)
        openai_content = body["result"]["contents"][0]
        self.assertEqual(openai_content["mimeType"], "text/html+skybridge")
        self.assertEqual(openai_content["text"], content["text"])
        for name in ("list_feed", "search_cards", "get_card"):
            meta = self.tools[name].get("_meta") or {}
            self.assertEqual((meta.get("ui") or {}).get("resourceUri"), uri, name)
            self.assertEqual(meta.get("openai/outputTemplate"), openai_uri, name)
            self.assertIs(meta.get("openai/widgetAccessible"), True, name)

    def test_tool_errors_are_text_only(self):
        result = self.call("snooze_card", {"card_type": "reminder", "card_id": str(uuid4())})
        self.assertIs(result.get("isError"), True, result)
        self.assertNotIn("structuredContent", result)
        self.assertTrue(result["content"][0]["text"].startswith("Error: "), result)

    def test_calls_without_a_valid_token_are_rejected(self):
        self.assertEqual(mcp("tools/list")[0], 401)
        self.assertEqual(mcp("tools/list", token="not-a-real-token")[0], 401)
        minted = mint_token(f"sit-mcp-revoked-{uuid4().hex}")
        revoke_token(minted["id"])
        self.assertEqual(mcp("tools/list", token=minted["token"])[0], 401)


if __name__ == "__main__":
    unittest.main()
