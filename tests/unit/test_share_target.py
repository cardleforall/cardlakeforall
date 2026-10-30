"""Sharing to Cardlake from another app (Android's share sheet). The manifest
declares a share target, share-target.js keeps the shared link through sign-in,
and the feed opens it as a pre-filled new card. The parsing runs in
share_target.test.js."""
from __future__ import annotations

import json
import subprocess
import unittest

from ._paths import AURORA_FEED_JS, ROOT, VAULT_INDEX, source

MANIFEST = ROOT / "public" / "manifest.webmanifest"


class ShareTargetTests(unittest.TestCase):
    def test_shared_links_become_card_drafts(self):
        result = subprocess.run(["node", "tests/unit/share_target.test.js"], cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_the_installed_app_is_offered_in_the_share_sheet(self):
        manifest = json.loads(source(MANIFEST))
        self.assertEqual(manifest["share_target"], {
            "action": "/vault/index.html",
            "method": "GET",
            "params": {"title": "title", "text": "text", "url": "url"},
        })
        self.assertTrue(manifest["share_target"]["action"].startswith(manifest["scope"]))

    # It must be set aside before vault.js can send a signed-out app to sign in.
    def test_the_share_is_kept_before_anything_can_redirect(self):
        index = source(VAULT_INDEX)
        self.assertLess(index.index('src="/vault/assets/share-target.js"'), index.index('src="/vault/assets/vault.js'))

    # Nothing is saved until the person presses Save, and only when signed in.
    def test_the_feed_opens_the_share_as_a_new_card_and_never_in_the_demo(self):
        feed = source(AURORA_FEED_JS)
        self.assertIn("if (!more) offerSharedLink();", feed)
        self.assertIn("const share = !SANDBOX && !shareOpen && window.CardleShare?.pending();", feed)
        self.assertIn("if (!(await V.checkAuth())) { shareOpen = false; return; }", feed)
        self.assertIn("capture(draft.type, draft.values, () => { shareOpen = false; window.CardleShare.clear(); });", feed)
        self.assertIn("const typed = { ...prefill };", feed)

    def test_a_bookmark_keeps_the_text_that_came_with_the_link(self):
        feed = source(AURORA_FEED_JS)
        bookmark = feed.split("${type === 'bookmark' ? `", 1)[1].split("` : ''}", 1)[0]
        self.assertIn('<textarea name="notes"', bookmark)


if __name__ == "__main__":
    unittest.main()
