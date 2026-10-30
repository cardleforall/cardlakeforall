"""/signin sends the owner on to ?next= after signing in, and only ever to a
page on this site. Runs the page's own script in Node with a stand-in
browser, signs in, and records where it redirects."""
from __future__ import annotations

import json
import re
import subprocess
import unittest

from ._paths import ROOT, source

PAGE = ROOT / "public" / "signin.html"

HARNESS = r"""
const script = process.argv[1];
const cases = JSON.parse(process.argv[2]);
const results = {};
(async () => {
  for (const next of cases) {
    const landed = [];
    let submit;
    const form = { addEventListener: (type, fn) => { if (type === 'submit') submit = fn; }, querySelector: () => ({ disabled: false }) };
    const sandbox = {
      location: { search: '?next=' + encodeURIComponent(next), origin: 'https://mine.example', replace: url => landed.push(url) },
      document: { getElementById: id => (id === 'signin-form' ? form : { textContent: '' }) },
      URLSearchParams, URL,
      FormData: class { get(name) { return name === 'email' ? 'owner@example.test' : 'a password!'; } },
      fetch: async path => ({ ok: true, json: async () => (path.endsWith('/config') ? { setupNeeded: false } : { authenticated: true }) }),
    };
    new Function(...Object.keys(sandbox), script)(...Object.values(sandbox));
    await submit({ preventDefault() {}, target: form });
    await new Promise(resolve => setTimeout(resolve, 0));
    // Where a browser would really end up: it resolves the URL the same way.
    results[next] = new URL(landed.at(-1), 'https://mine.example').href;
  }
  console.log(JSON.stringify(results));
})().catch(error => { console.error(error); process.exit(1); });
"""


def page_script() -> str:
    return re.search(r"<script>\s*(\(function \(\) \{.*?\}\)\(\);)\s*</script>", source(PAGE), re.S).group(1)


def landings(cases: list[str]) -> dict[str, str]:
    result = subprocess.run(["node", "-e", HARNESS, page_script(), json.dumps(cases)], cwd=ROOT,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr or result.stdout
    return json.loads(result.stdout)


class SignInRedirectTests(unittest.TestCase):
    def test_signing_in_returns_to_the_page_that_asked(self):
        seen = landings(["/vault/index.html#about", "/welcome.html", "/vault/index.html?capture=reminder"])
        self.assertEqual(seen["/vault/index.html#about"], "https://mine.example/vault/index.html#about")
        self.assertEqual(seen["/welcome.html"], "https://mine.example/welcome.html")
        self.assertEqual(seen["/vault/index.html?capture=reminder"], "https://mine.example/vault/index.html?capture=reminder")

    def test_signing_in_never_sends_the_owner_to_another_site(self):
        # Browsers drop tabs and newlines from URLs, so "/<tab>/evil.example"
        # is "//evil.example": another site, right after the owner typed
        # their password.
        attacks = ["https://evil.example/", "//evil.example", "/\\evil.example", "/\t/evil.example",
                   "/\n/evil.example", "/\r\\evil.example", " //evil.example", "javascript:alert(1)",
                   "\\\\evil.example", "/%2F%2Fevil.example", ""]
        for attack, landed in landings(attacks).items():
            with self.subTest(next=attack):
                self.assertTrue(landed.startswith("https://mine.example/"), landed)


if __name__ == "__main__":
    unittest.main()
