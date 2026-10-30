"""The owner-facing help: the support page and the setup guide say what
Cardlake is and how to use it, and what they promise about uploads and
Android sharing matches what the code does."""
from __future__ import annotations

import json
import re
import unittest

from ._paths import API, ROOT, source

SUPPORT = ROOT / "public" / "support.html"
MCP_SETUP = ROOT / "public" / "mcp-setup.html"
FUNCTIONAL = ROOT / "docs" / "functional.md"


def upload_extensions() -> set[str]:
    formats = re.search(r"const FORMATS = Object\.freeze\(\{(.*?)\}\);", source(API / "_lib" / "upload-validation.js"), re.S).group(1)
    return {ext.lstrip(".") for ext in re.findall(r"'(\.[a-z]+)'", formats)}


class AndroidSharingTests(unittest.TestCase):
    def test_the_app_really_receives_shared_text_and_links(self):
        target = json.loads(source(ROOT / "public" / "manifest.webmanifest"))["share_target"]
        self.assertEqual(set(target["params"]), {"title", "text", "url"})
        self.assertNotIn("files", target["params"], "the docs say files can't be shared in")

    def test_support_page_explains_sharing_from_android(self):
        page = source(SUPPORT)
        section = page.split('id="android-sharing"', 1)[1].split("</section>", 1)[0]
        self.assertIn("Install app", section)
        self.assertIn("Save card", section)
        self.assertIn("New card → File", section)
        self.assertIn("4 MB", section)
        # It's this owner's Cardlake, not a hosted one.
        self.assertNotRegex(section, r"https?://")

    def test_functional_spec_lists_exactly_the_formats_uploads_accept(self):
        spec = source(FUNCTIONAL)
        self.assertIn("**Sharing from Android:**", spec)
        allowed = spec.split("**Attachments and files:**", 1)[1].split("\n\n", 1)[0].lower()
        # Every format the upload checks accept is named (JPG as JPEG).
        for ext in upload_extensions() - {"jpg"}:
            self.assertRegex(allowed, rf"\b{ext}\b", ext)
        self.assertIn("generic binary uploads are not supported", allowed)
        support = source(SUPPORT).split('id="android-sharing"', 1)[1].split("</section>", 1)[0]
        for kind in ("images", "pdfs", "text", "word", "excel"):
            self.assertIn(kind, support.lower(), kind)


class SupportPageTests(unittest.TestCase):
    def test_support_page_says_what_cardlake_is_and_answers_the_common_snags(self):
        page = source(SUPPORT)
        self.assertIn("Cardlake is a personal knowledge and reminder app", page)
        snags = re.findall(r'<p class="snag"><em>"([^"]+)"</em>', page)
        self.assertGreaterEqual(len(snags), 5, snags)
        self.assertIn("I forgot my password.", snags)

    def test_support_page_has_nobody_to_write_to(self):
        # Run by its owner for themselves: no company address, form or waitlist.
        page = source(SUPPORT)
        for gone in ("mailto:", "feedback.html", "waitlist", "Google"):
            self.assertNotIn(gone, page, gone)


class SetupGuideTests(unittest.TestCase):
    def test_setup_guide_opens_by_saying_what_cardlake_is(self):
        intro = source(MCP_SETUP).split("<h1", 1)[1].split("</p>", 1)[0]
        self.assertIn("Cardlake is a personal knowledge and reminder app", intro)
        self.assertLess(intro.index("personal knowledge"), intro.index("MCP"))


if __name__ == "__main__":
    unittest.main()
