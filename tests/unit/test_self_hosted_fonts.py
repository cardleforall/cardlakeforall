"""Cardlake's fonts are served from Cardlake's own domain. Loading them from
Google Fonts told Google about every visit to every page; self-hosting keeps
that request on our own domain (see privacy.html)."""
from __future__ import annotations

import re
import unittest

from ._paths import ROOT

PUBLIC = ROOT / "public"
FONTS = PUBLIC / "fonts"
FONTS_CSS = FONTS / "fonts.css"
GOOGLE = re.compile(r"fonts\.(googleapis|gstatic)\.com")
# Pages that set Manrope / Space Grotesk themselves; the vault gets the fonts
# through aurora.css.
PAGES = ["mcp-setup.html", "privacy.html", "setup.html", "signin.html", "support.html", "welcome.html"]


class SelfHostedFontTests(unittest.TestCase):
    def test_nothing_in_public_loads_google_fonts(self):
        offenders = [str(path.relative_to(PUBLIC)) for path in PUBLIC.rglob("*")
                     if path.suffix in {".html", ".css", ".js"} and GOOGLE.search(path.read_text(encoding="utf-8", errors="ignore"))]
        self.assertEqual(offenders, [])

    def test_font_faces_point_at_real_woff2_files_for_both_families(self):
        self.assertTrue(FONTS_CSS.is_file(), "public/fonts/fonts.css is missing")
        css = FONTS_CSS.read_text(encoding="utf-8")
        families = set(re.findall(r"font-family:\s*'([^']+)'", css))
        self.assertEqual(families, {"Manrope", "Space Grotesk"})
        sources = re.findall(r"url\(([^)]+)\)", css)
        self.assertTrue(sources)
        for source in sources:
            path = FONTS / source.strip("'\"").lstrip("./")
            self.assertTrue(path.is_file(), f"{source} has no file")
            self.assertEqual(path.read_bytes()[:4], b"wOF2", f"{source} is not WOFF2")

    def test_every_page_that_uses_the_fonts_links_the_local_stylesheet(self):
        for page in PAGES:
            html = (PUBLIC / page).read_text(encoding="utf-8")
            self.assertIn('href="/fonts/fonts.css"', html, page)
        aurora = (PUBLIC / "vault" / "assets" / "aurora.css").read_text(encoding="utf-8")
        self.assertIn("@import url('/fonts/fonts.css');", aurora)

    def test_the_font_license_ships_with_the_fonts(self):
        for name in ("OFL-Manrope.txt", "OFL-Space-Grotesk.txt"):
            license_text = (FONTS / name).read_text(encoding="utf-8") if (FONTS / name).is_file() else ""
            self.assertIn("SIL Open Font License", license_text, name)


if __name__ == "__main__":
    unittest.main()
