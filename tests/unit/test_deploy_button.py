"""The README's one-click deploy: the Deploy with Vercel button makes a
working Cardlake with nothing typed (a Neon database, a private Blob store,
the build command), and the README tells a non-technical reader what to do
next and how to get back in."""
from __future__ import annotations

import json
import re
import unittest
from urllib.parse import parse_qs, urlparse

from ._paths import ROOT, source

README = ROOT / "README.md"


def deploy_button_params() -> dict:
    match = re.search(r"\(https://vercel\.com/new/clone\?([^)\s]+)\)", source(README))
    assert match, "the README has no Deploy with Vercel button"
    return {key: values[0] for key, values in parse_qs(match.group(1)).items()}


class DeployButtonTests(unittest.TestCase):
    def test_button_clones_this_repository_under_a_suggested_name(self):
        params = deploy_button_params()
        self.assertEqual(params["repository-url"], "https://github.com/cardleforall/cardlakeforall")
        self.assertEqual(params["project-name"], "cardlake-self-hosted")
        self.assertEqual(params["repository-name"], "cardlake-self-hosted")

    def test_button_adds_neon_and_a_private_blob_store(self):
        stores = json.loads(deploy_button_params()["stores"])
        self.assertIn({"type": "integration", "integrationSlug": "neon", "productSlug": "neon"}, stores)
        self.assertIn({"type": "blob", "access": "private"}, stores)

    def test_vercel_builds_the_vault_page(self):
        config = json.loads(source(ROOT / "vercel.json"))
        self.assertEqual(config["buildCommand"], "npm run build")
        self.assertEqual(json.loads(source(ROOT / "package.json"))["scripts"]["build"], "python3 scripts/build_vault_public.py")

    def test_readme_walks_a_newcomer_through_it(self):
        readme = source(README)
        for step in ("github.com/signup", "vercel.com/signup", "Deploy with Vercel", "set your password", "Connect AI"):
            self.assertIn(step, readme)
        # Setup locks after an hour, and this is how to get back in.
        self.assertIn("setup is open for one hour", readme)
        self.assertIn("CARDLE_SETUP_OPEN", readme)
        # The repository is public, so the button is the one documented way
        # to deploy; the workaround for a private repository is gone.
        self.assertNotIn("Without the button", readme)

    def test_the_step_by_step_guide_has_the_same_button_and_its_pictures(self):
        guide_path = ROOT / "docs" / "SETUP_GUIDE.md"
        self.assertIn("(docs/SETUP_GUIDE.md)", source(README))
        guide = source(guide_path)
        button = re.search(r"\(https://vercel\.com/new/clone\?[^)\s]+\)", source(README)).group(0)
        self.assertIn(button, guide, "the guide's Deploy button must match the README's")
        pictures = re.findall(r'src="(media/setup/[^"]+)"', guide)
        self.assertEqual(len(pictures), 3)
        for picture in pictures:
            self.assertTrue((guide_path.parent / picture).is_file(), picture)


if __name__ == "__main__":
    unittest.main()
