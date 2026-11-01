"""Every rewrite in vercel.json reaches something that answers it. Most API
routes are rewrites onto a few consolidated functions (the 12-function
limit), and the unit tests call those handlers directly with a hand-built
query, so a rewrite that points at an excluded file, a missing page, or an
action the function doesn't handle would only show up in production."""
from __future__ import annotations

import json
import re
import unittest
from fnmatch import fnmatchcase
from urllib.parse import parse_qsl, urlsplit

from ._paths import API, ROOT

PUBLIC = ROOT / "public"


def rewrites() -> list[dict]:
    return json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))["rewrites"]


def deployed_functions() -> dict[str, "Path"]:
    """api/*.js files Vercel deploys: everything .vercelignore doesn't exclude."""
    ignored = [line.strip() for line in (ROOT / ".vercelignore").read_text(encoding="utf-8").splitlines()
               if line.strip() and not line.startswith("#")]
    found = {}
    for path in API.rglob("*.js"):
        rel = path.relative_to(ROOT).as_posix()
        if "/_lib/" in rel or any(fnmatchcase(rel, pattern) for pattern in ignored):
            continue
        found["/" + rel.removesuffix(".js")] = path
    return found


def handled_names(function) -> str:
    """The function's source plus the api/_lib modules it requires: where the
    values it dispatches on are spelled out."""
    text = function.read_text(encoding="utf-8")
    for module in re.findall(r"require\('\./_lib/([\w-]+)'\)", text):
        lib = API / "_lib" / f"{module}.js"
        if lib.is_file():
            text += lib.read_text(encoding="utf-8")
    return text


def param_choices(source: str) -> dict[str, list[str]]:
    """'/api/:resource(a|b)/:id' -> {'resource': ['a', 'b'], 'id': []}."""
    return {name: choices.split("|") if choices else []
            for name, choices in re.findall(r":(\w+)(?:\(([^)]*)\))?", source)}


class RewriteTests(unittest.TestCase):
    def test_every_rewrite_reaches_a_deployed_function_or_a_page(self):
        functions = deployed_functions()
        for rule in rewrites():
            path = urlsplit(rule["destination"]).path
            with self.subTest(source=rule["source"]):
                page = PUBLIC / path.lstrip("/")
                self.assertTrue(path in functions or page.is_file(),
                                f"{rule['destination']} is neither a deployed function nor a file in public/")

    def test_every_rewrite_names_something_its_function_handles(self):
        functions = deployed_functions()
        for rule in rewrites():
            destination = urlsplit(rule["destination"])
            if destination.path not in functions:
                continue
            source = handled_names(functions[destination.path])
            choices = param_choices(rule["source"])
            for key, value in parse_qsl(destination.query):
                values = choices.get(value[1:], []) if value.startswith(":") else [value]
                for name in values:
                    with self.subTest(source=rule["source"], **{key: name}):
                        mentioned = re.search(rf"['\"]{re.escape(name)}['\"]|\b{re.escape(name)}\s*:", source)
                        self.assertTrue(mentioned, f"{destination.path} never mentions {key}={name}")

    def test_the_checks_see_the_routing_as_vercel_does(self):
        functions = deployed_functions()
        self.assertIn("/api/auth", functions)
        self.assertNotIn("/api/auth/login", functions, "api/auth/** is local-dev only")
        self.assertEqual(param_choices("/api/:resource(work|family)/:id"), {"resource": ["work", "family"], "id": []})


if __name__ == "__main__":
    unittest.main()
