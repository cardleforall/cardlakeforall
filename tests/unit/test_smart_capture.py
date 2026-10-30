"""Quick add in the new-card dialog: smart-capture.js guesses a card's type
and fields from one line of text, on fixed rules in the browser. The guessing
runs in smart_capture.test.js."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import AURORA_FEED_JS, ROOT, VAULT_INDEX, source

SMART_CAPTURE_JS = ROOT / "public" / "vault" / "assets" / "smart-capture.js"


class SmartCaptureTests(unittest.TestCase):
    def test_typed_text_becomes_a_card_guess(self):
        result = subprocess.run(["node", "tests/unit/smart_capture.test.js"], cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    # The other checks here read the source as text; this one makes sure it runs.
    def test_the_scripts_parse(self):
        for script in (SMART_CAPTURE_JS, AURORA_FEED_JS):
            result = subprocess.run(["node", "--check", str(script)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)

    # docs/AI_DATA_USE.md: Cardlake calls no model or provider. Quick add must not
    # either, or the policy's launch checklist applies first.
    def test_the_guess_never_leaves_the_browser(self):
        script = source(SMART_CAPTURE_JS)
        for call in ("fetch(", "XMLHttpRequest", "sendBeacon", "V.api", "/api/"):
            self.assertNotIn(call, script)

    # It reuses share-target.js for links, so it has to load after it.
    def test_the_vault_page_loads_it_after_share_target(self):
        index = source(VAULT_INDEX)
        self.assertLess(index.index('src="/vault/assets/share-target.js"'), index.index('src="/vault/assets/smart-capture.js"'))
        self.assertLess(index.index('src="/vault/assets/smart-capture.js"'), index.index('src="/vault/assets/aurora-feed.js'))

    def test_the_dialog_shows_the_guess_and_lets_a_picked_type_win(self):
        feed = source(AURORA_FEED_JS)
        self.assertIn("<textarea data-quick-add", feed)
        self.assertIn('aria-live="polite"', feed.split("data-quick-hint", 1)[1][:40])
        self.assertIn("if (guessedType && !typePicked) type = guessedType;", feed)
        self.assertIn("if (quick?.value.trim()) typePicked = true;", feed)
        # Nothing is saved until the person presses Save (or Ctrl/Cmd+Enter).
        quick_handler = feed.split("quick?.addEventListener('input'", 1)[1].split("});", 1)[0]
        self.assertNotIn("requestSubmit", quick_handler)

    # Only the card types are recorded, never the text typed.
    def test_saving_records_the_guessed_and_saved_types_only(self):
        feed = source(AURORA_FEED_JS)
        self.assertIn("track('capture.quick_add', null, { guessed: guessedType, saved: type });", feed)


if __name__ == "__main__":
    unittest.main()
