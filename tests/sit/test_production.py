"""System integration tests: exercise the real, deployed Cardlake API end to
end (HTTP over the network, against a real Postgres). This is the only place
in the suite that can catch bugs invisible to source-text/subprocess unit
tests -- e.g. a query that only fails against real Postgres types, or a
handler that throws before the response is ever inspected offline. See
tests/README.md for when to run this tier.

Every created row has an invocation-unique title and is soft-deleted in
cleanup, making repeat runs safe. Run only through
``npm run test:full``, with SYNC_TOKEN set in the
environment -- there is no bundled fallback token, so the whole class is
skipped (not silently unauthenticated) when it is unset.

(Formerly tests/test_integration_production.py.)
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
RESOURCES = {
    "learnings": ("entries", "entry", {"title": "integration learning", "url": "https://example.test/learning", "notes": "integration notes", "status": "saved", "category": "ai"}),
    "kanban": ("items", "item", {"title": "integration item", "status": "backlog", "description": ""}),
    "work": ("work", "item", {"title": "integration work item", "items": []}),
    "family": ("updates", "update", {"person": "Integration", "content": "integration update"}),
    "bookmarks": ("bookmarks", "bookmark", {"title": "integration bookmark", "url": "https://example.test/integration"}),
    "talking-points": ("talking_points", "talking_point", {"section_title": "integration section", "content": "integration content"}),
}
# Kanban cards come only from GitHub Issues, so the API refuses to create them
# by hand; every other resource is created, updated and deleted by these tests.
CREATABLE = {resource: spec for resource, spec in RESOURCES.items() if resource != "kanban"}


def request(path, method="GET", body=None, authenticated=False):
    headers = {"Accept": "application/json"}
    if authenticated:
        headers["x-sync-token"] = SYNC_TOKEN
    data = None if body is None else json.dumps(body).encode("utf-8")
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = Request(BASE_URL + path, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        payload = error.read().decode("utf-8")
        try:
            return error.code, json.loads(payload)
        except json.JSONDecodeError:
            return error.code, {"raw": payload}


@unittest.skipUnless(BASE_URL and SYNC_TOKEN, "Set CARDLE_URL and SYNC_TOKEN to run the system tests")
class ProductionApiTests(unittest.TestCase):
    def unique_payload(self, resource):
        _, _, payload = RESOURCES[resource]
        payload = dict(payload)
        marker = "integration-test-" + uuid4().hex
        if "title" in payload:
            payload["title"] = marker
        elif "section_title" in payload:
            payload["section_title"] = marker
        else:
            payload["content"] = marker
        return payload

    def create(self, resource):
        plural, singular, _ = RESOURCES[resource]
        status, response = request("/api/" + resource, "POST", self.unique_payload(resource), True)
        self.assertEqual(status, 201, response)
        self.assertIn(singular, response)
        return response[singular]

    def delete(self, resource, item_id):
        status, response = request(f"/api/{resource}/{item_id}", "DELETE", authenticated=True)
        self.assertIn(status, (200, 404), response)
        return status, response

    def assert_cycle(self, resource, update, expected=None):
        plural, singular, _ = RESOURCES[resource]
        item = self.create(resource)
        item_id = item["id"]
        try:
            status, listing = request("/api/" + resource)
            self.assertEqual(status, 200, listing)
            self.assertIn(item_id, {row["id"] for row in listing[plural]})
            status, patched = request(f"/api/{resource}/{item_id}", "PATCH", update, True)
            self.assertEqual(status, 200, patched)
            self.assertEqual(patched[singular][next(iter(update))], next(iter(update.values())) if expected is None else expected)
            self.delete(resource, item_id)
            status, listing = request("/api/" + resource)
            self.assertNotIn(item_id, {row["id"] for row in listing[plural]})
        finally:
            self.delete(resource, item_id)

    def test_public_get_endpoints_work_without_auth(self):
        for resource, (plural, _, _) in RESOURCES.items():
            status, response = request("/api/" + resource)
            self.assertEqual(status, 200, (resource, response))
            self.assertIsInstance(response.get(plural), list)

    def test_dashboard_stats_match(self):
        status, dashboard = request("/api/dashboard/stats")
        self.assertEqual(status, 200, dashboard)
        stats = dashboard["stats"]
        mapping = {"kanban": "kanban_items", "work": "work_items", "family": "family_updates", "bookmarks": "bookmarks", "talking-points": "talking_points"}
        for resource, stat_key in mapping.items():
            plural = RESOURCES[resource][0]
            status, response = request("/api/" + resource)
            self.assertEqual(status, 200, response)
            self.assertEqual(stats[stat_key], len(response[plural]), stat_key)
        self.assertIsInstance(stats["learning_entries"], int)
        self.assertIsInstance(stats["reminders"], int)

    def test_feed_endpoint_is_paginated_and_writes_are_authenticated(self):
        status, response = request("/api/feed?limit=5")
        self.assertEqual(status, 200, response)
        self.assertIsInstance(response.get("cards"), list)
        self.assertLessEqual(len(response["cards"]), 5)
        if response["cards"]:
            card = response["cards"][0]
            self.assertIn(card["type"], {"learning", "kanban", "work", "family", "bookmark", "talking_point", "reminder"})
            self.assertIn("metadata", card)
        fake = {"action": "dismiss", "item_type": "reminder", "item_id": "00000000-0000-4000-8000-000000000000"}
        status, _ = request("/api/feed", "POST", fake)
        self.assertEqual(status, 401)

    def test_feed_actions_reject_unknown_cards_without_creating_state(self):
        """Every feed action must reject an unknown UUID, rather than storing
        invisible orphan state (which could consume the pin quota)."""
        missing_id = str(uuid4())
        actions = ("like", "unlike", "remind_later", "unremind_later", "pin", "unpin")
        types = ("learning", "kanban", "work", "family", "bookmark", "talking_point", "reminder", "file")
        for item_type in types:
            for action in actions:
                with self.subTest(item_type=item_type, action=action):
                    status, response = request("/api/feed", "POST", {
                        "action": action,
                        "item_type": item_type,
                        "item_id": missing_id,
                    }, True)
                    self.assertEqual(status, 404, response)
                    self.assertEqual(response.get("error"), "Item not found")

    def test_kanban_cards_are_not_created_by_hand(self):
        status, response = request("/api/kanban", "POST", RESOURCES["kanban"][2], True)
        self.assertEqual(status, 409, response)
        self.assertEqual(response.get("code"), "KANBAN_COMES_FROM_GITHUB")

    def test_integrations_are_listed_publicly_without_credentials(self):
        status, response = request("/api/integrations")
        self.assertEqual(status, 200, response)
        github = next(i for i in response["integrations"] if i["id"] == "github_issues")
        self.assertIn(github["status"], {"not_started", "onboarding", "connected", "error", "disconnected"})
        self.assertNotIn("token", github)
        # Onboarding writes need a signed-in writer.
        for action in ("onboarding", "acknowledge"):
            status, _ = request(f"/api/integrations/github_issues/{action}", "POST", {"step": "intro"})
            self.assertEqual(status, 401, action)

    def test_work_create_cycle(self):
        # The Work tab sends checklist lines as plain text; they are saved as
        # { text, completed } entries, the shape MCP and the feed use.
        self.assert_cycle("work", {"items": ["updated"]}, expected=[{"text": "updated", "completed": False}])

    def test_family_create_cycle(self):
        self.assert_cycle("family", {"content": "updated by production integration test"})

    def test_bookmarks_create_cycle(self):
        self.assert_cycle("bookmarks", {"notes": "updated by production integration test"})

    def test_talking_points_create_cycle(self):
        self.assert_cycle("talking-points", {"content": "updated by production integration test"})

    def test_all_tabs_delete_cycle(self):
        """Every Cardlake tab can delete an authenticated card and hides it from GET."""
        for resource in CREATABLE:
            with self.subTest(resource=resource):
                plural, _, _ = CREATABLE[resource]
                item = self.create(resource)
                item_id = item["id"]
                try:
                    status, listing = request("/api/" + resource)
                    self.assertEqual(status, 200, listing)
                    self.assertIn(item_id, {row["id"] for row in listing[plural]})
                    status, response = self.delete(resource, item_id)
                    self.assertEqual(status, 200, response)
                    status, listing = request("/api/" + resource)
                    self.assertEqual(status, 200, listing)
                    self.assertNotIn(item_id, {row["id"] for row in listing[plural]})
                finally:
                    self.delete(resource, item_id)

    def test_delete_is_soft_delete(self):
        """DELETE returns the updated database row, including its soft-delete timestamp."""
        item = self.create("learnings")
        try:
            status, response = self.delete("learnings", item["id"])
            self.assertEqual(status, 200, response)
            self.assertEqual(response["entry"]["id"], item["id"])
            self.assertIsNotNone(response["entry"]["deleted_at"])
        finally:
            self.delete("learnings", item["id"])

    def test_endpoints_reject_unauthenticated_writes(self):
        fake_id = "00000000-0000-0000-0000-000000000000"
        for resource, (_, _, payload) in RESOURCES.items():
            status, _ = request("/api/" + resource, "POST", payload)
            self.assertEqual(status, 401, resource + " POST")
            for method in ("PATCH", "DELETE"):
                status, _ = request(f"/api/{resource}/{fake_id}", method, {} if method == "PATCH" else None)
                self.assertEqual(status, 401, resource + " " + method)

    def test_migrate_idempotent(self):
        # Only (re)applies the schema; it has no seed and writes no rows.
        status, first = request("/api/migrate", "POST", {}, True)
        self.assertEqual(status, 200, first)
        status, second = request("/api/migrate", "POST", {}, True)
        self.assertEqual(status, 200, second)
        for response in (first, second):
            self.assertTrue(response["ok"], response)
            self.assertNotIn("inserted", response)

    def test_retired_kanban_board_endpoints_are_gone(self):
        # Reorder and restore served the old Kanban board; GitHub owns issue
        # order and lifecycle now. Neither may succeed any more.
        status, _ = request("/api/kanban/reorder", "POST", {"ids": []}, True)
        self.assertNotEqual(status, 200)
        status, _ = request("/api/kanban/00000000-0000-4000-8000-000000000000/restore", "POST", {}, True)
        self.assertNotEqual(status, 200)

    def test_completing_a_recurring_reminder_rolls_it_forward(self):
        # Needs the recurrence migration: this is the check that it ran.
        body = {"title": "integration-test-" + uuid4().hex, "due_date": "2099-01-31", "recurrence": "monthly"}
        status, created = request("/api/reminders", "POST", body, True)
        self.assertEqual(status, 201, created)
        reminder_id = created["reminder"]["id"]
        try:
            self.assertEqual(created["reminder"]["recurrence"], "monthly")
            status, done = request(f"/api/reminders/{reminder_id}", "PATCH", {"completed": True}, True)
            self.assertEqual(status, 200, done)
            self.assertFalse(done["reminder"]["completed"])
            self.assertTrue(done["reminder"]["due_date"].startswith("2099-02-28"), done)
        finally:
            request(f"/api/reminders/{reminder_id}", "DELETE", authenticated=True)

    def test_talking_points_have_subsection_of_references(self):
        status, response = request("/api/talking-points")
        self.assertEqual(status, 200, response)
        # A fresh Cardlake seeds no sample data, so there may be nothing to
        # check yet.
        if not response["talking_points"]:
            self.skipTest("no talking points on this deployment")
        self.assertTrue(any(item.get("subsection_of") for item in response["talking_points"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
