"""Repository/project-configuration contracts: .gitignore, package.json
scripts, .env.example shape, CLI script portability, and stale-domain
guards. These aren't about app behavior -- they're about the working tree
staying deployable and portable."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BINARY_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp', '.ico', '.mp4', '.woff2', '.ttf', '.gif'}


class RepoHygieneTests(unittest.TestCase):
    def test_gitignore_excludes_local_and_generated_files(self):
        entries = {
            line.strip()
            for line in (ROOT / '.gitignore').read_text(encoding='utf-8').splitlines()
            if line.strip() and not line.lstrip().startswith('#')
        }
        self.assertTrue({
            '.vercel/', '.env', '.env.*', '!.env.example', 'node_modules/',
            '__pycache__/', '*.pyc', '.DS_Store', '*.log', '.pytest_cache/',
            '.coverage', 'htmlcov/', 'tmp/', 'dist/', 'Vault Dashboard.html',
        }.issubset(entries))

    def test_every_browser_script_parses(self):
        # One syntax error stops a whole page: an unescaped apostrophe in a
        # single-quoted string is enough. Source-text tests can't see that, so
        # every script the browser loads is parsed.
        scripts = sorted((ROOT / 'public').rglob('*.js'))
        self.assertTrue(any(path.name == 'vault.js' for path in scripts))
        for path in scripts:
            result = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, f'{path.relative_to(ROOT)} does not parse:\n{result.stderr}')

    def test_package_scripts_are_ci_safe(self):
        package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
        scripts = package['scripts']
        self.assertEqual(scripts['build'], 'python3 scripts/build_vault_public.py')
        self.assertEqual(scripts['build:vault'], 'python3 scripts/build_vault_public.py --target public/vault/index.html')
        self.assertEqual(scripts['validate:vault'], 'python3 scripts/validate_vault_build.py')
        # There's no shared password, so no helper to hash one.
        self.assertNotIn('hash-password', scripts)
        self.assertFalse((ROOT / 'scripts' / 'generate_password_hash.js').exists())
        self.assertEqual(scripts['test'], 'npm run build:vault && npm run validate:vault')
        self.assertEqual(scripts['test:lite'], "python3 -m unittest discover -t . -s tests/unit -p test_*.py -v")
        self.assertEqual(scripts['test:full'], "python3 -m unittest discover -t . -s tests/unit -p test_*.py -v && python3 -m unittest discover -t . -s tests/sit -p test_*.py -v")
        self.assertNotIn('deploy', scripts)
        self.assertNotIn('/home/', json.dumps(scripts))

    def test_environment_docs_say_local_dev_needs_its_own_database(self):
        # DATABASE_URL is used exactly as configured, so the docs, .env.example
        # and the code comment that explains LOCAL_DEV_PG must all say that
        # local development needs a database of its own.
        env_docs = (ROOT / 'docs' / 'ENVIRONMENT.md').read_text(encoding='utf-8')
        self.assertIn('Use a database of its own for local development', env_docs)
        self.assertIn('Isolating local development from production data', env_docs)

        env_example = (ROOT / '.env.example').read_text(encoding='utf-8')
        self.assertIn('docs/ENVIRONMENT.md', env_example)

        db_js = (ROOT / 'api' / '_lib' / 'db.js').read_text(encoding='utf-8')
        self.assertIn('docs/ENVIRONMENT.md', db_js)
        self.assertIn('never one with real data', db_js)

    def test_env_example_lists_required_names_without_values(self):
        values = {}
        for line in (ROOT / '.env.example').read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#'):
                key, value = line.split('=', 1)
                values[key] = value
        for key in ('DATABASE_URL', 'SESSION_SECRET', 'INTEGRATION_ENCRYPTION_KEY', 'SYNC_TOKEN'):
            self.assertEqual(values.get(key), '')
        self.assertNotIn('APP_PASSWORD_HASH', values)

    def test_scripts_are_portable_and_offer_cli_path_overrides(self):
        expected_options = {
            'build_vault_public.py': ('--target',),
            'deploy_vercel.py': ('--root', '--token'),
        }
        for script, options in expected_options.items():
            script_path = ROOT / 'scripts' / script
            source = script_path.read_text(encoding='utf-8')
            self.assertNotIn('/home/', source, script)
            result = subprocess.run(
                [sys.executable, str(script_path), '--help'],
                cwd=ROOT, capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            for option in options:
                self.assertIn(option, result.stdout)

    def test_personal_notes_and_their_import_tooling_are_gone(self):
        # Personal notes and the scripts that import them into the 'default'
        # tenant don't belong in the repository.
        for retired in ('content/vault', 'scripts/markdown_seed_data.json', 'scripts/import_markdown_data.py',
                        'scripts/render_vault.py', 'scripts/import_from_obsidian.py', 'scripts/sync_learnings_from_vercel.py'):
            self.assertFalse((ROOT / retired).exists(), retired)
        self.assertNotIn('seed', (ROOT / 'api' / 'migrate.js').read_text(encoding='utf-8').lower())

    # The one place this repository may name the hosted Cardlake: a single
    # README line for people who'd rather not run their own.
    HOSTED_SERVICE_LINE = "Don't want to host it yourself? Use Cardlake at [cardlake.app](https://cardlake.app)."

    def tracked_text_files(self):
        listed = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True, check=False)
        if listed.returncode == 0 and listed.stdout:
            paths = [ROOT / name for name in listed.stdout.decode('utf-8').split('\0') if name]
        else:  # not a git checkout (an exported copy): every file instead
            skip_dirs = {'.git', 'node_modules', '__pycache__'}
            paths = [path for path in ROOT.rglob('*') if path.is_file() and not skip_dirs & set(path.relative_to(ROOT).parts)]
        for path in paths:
            if not path.is_file() or path == Path(__file__) or path.suffix in BINARY_SUFFIXES:
                continue
            yield path, path.read_text(encoding='utf-8', errors='ignore')

    # Names of the hosted service's private repository, its account and its
    # Vercel project, as the first 16 hex digits of each name's SHA-256, so
    # this test can refuse them without publishing them.
    PRIVATE_NAME_HASHES = {
        '3b34c54559d1996d', '7c603407629a8781', '30545bd08c5b3135', '7caf677c978ac64a',
    }

    def private_names_in(self, text):
        found = set()
        for word in re.findall(r'[a-z0-9-]+', text.lower()):
            for candidate in {word, *word.split('-')}:
                if hashlib.sha256(candidate.encode()).hexdigest()[:16] in self.PRIVATE_NAME_HASHES:
                    found.add(candidate)
        return sorted(found)

    def test_private_name_check_finds_a_listed_name_in_urls_and_hyphenated_words(self):
        # Guards the hashing itself, with a stand-in name added to the list.
        self.PRIVATE_NAME_HASHES = self.PRIVATE_NAME_HASHES | {hashlib.sha256(b'zebra').hexdigest()[:16]}
        self.assertEqual(self.private_names_in('See github.com/Zebra/app and zebra-projects.'), ['zebra'])
        self.assertEqual(self.private_names_in('Cardlake and cardle-dev are fine.'), [])

    def test_nothing_points_at_the_hosted_service_or_its_people(self):
        # This repository is self-contained: no default, script, test, page or
        # doc may reach the hosted Cardlake (its domains, Vercel project or
        # database), name the private repository it was copied from or the
        # account behind it, or carry anyone's personal mailbox. Values that
        # differ per deployment come from environment variables instead.
        forbidden = re.compile(
            r'cardlake\.app|cardle\.dev'
            # A Neon database host, such as the hosted one's.
            r'|ep-[a-z]+-[a-z]+-[a-z0-9]+(?:-pooler)?\.[a-z0-9-]+\.aws\.neon\.tech'
            # A personal mailbox at a consumer email provider.
            r'|[\w.+-]+@(?:gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail)\.[a-z.]+',
            re.IGNORECASE,
        )
        offenders = []
        for path, text in self.tracked_text_files():
            if path == ROOT / 'README.md':
                self.assertEqual(text.count(self.HOSTED_SERVICE_LINE), 1, 'the README names the hosted service once')
                text = text.replace(self.HOSTED_SERVICE_LINE, '')
            offenders += [f'{path.relative_to(ROOT)}: {match}' for match in forbidden.findall(text)]
            offenders += [f'{path.relative_to(ROOT)}: {name}' for name in self.private_names_in(text)]
        self.assertEqual(offenders, [])

    def test_no_proprietary_or_apache_wording(self):
        # Cardlake is AGPL-3.0 only. The lockfile lists dependencies' own
        # licenses, which are theirs to choose.
        offenders = []
        for path, text in self.tracked_text_files():
            if path.name == 'package-lock.json':
                continue
            offenders += [f'{path.relative_to(ROOT)}: {word}' for word in re.findall(r'proprietary|apache', text, re.IGNORECASE)]
        self.assertEqual(offenders, [])

    def test_nothing_from_the_hosted_service_comes_back(self):
        # A self-hosted Cardlake has one owner and signs in with a password:
        # Google sign-in, administrators, open sign-up and the marketing site
        # stay out.
        forbidden = re.compile(
            r'accounts\.google\.com|google-auth-library|GOOGLE_CLIENT_ID|CARDLE_ADMIN_EMAILS'
            r'|CARDLE_PUBLIC_SIGNUPS|CARDLE_MARKETING_SITE|marketingSite')
        offenders = []
        for path, text in self.tracked_text_files():
            offenders += [f'{path.relative_to(ROOT)}: {match}' for match in forbidden.findall(text)]
        self.assertEqual(offenders, [])

    def test_license_is_agpl_and_consistent_everywhere(self):
        # Cardlake is open source under the AGPL-3.0. LICENSE, package.json
        # and the docs have to agree, or something grants rights (or makes a
        # claim) the project doesn't back up.
        license_text = (ROOT / 'LICENSE').read_text(encoding='utf-8')
        self.assertIn('GNU AFFERO GENERAL PUBLIC LICENSE', license_text)
        self.assertNotIn('All rights reserved', license_text)

        package_json = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
        self.assertEqual(package_json.get('license'), 'AGPL-3.0-only')
        # Never published to npm; the license still applies to the source.
        self.assertTrue(package_json.get('private'))
        lock = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8'))
        self.assertEqual(lock['packages']['']['license'], 'AGPL-3.0-only')

        for doc in ('README.md', 'CONTRIBUTING.md'):
            text = (ROOT / doc).read_text(encoding='utf-8')
            self.assertIn('AGPL-3.0', text, doc)
            self.assertNotIn('Apache', text, doc)
            self.assertNotIn('proprietary', text.lower(), doc)

    def test_docs_say_pull_requests_are_not_accepted(self):
        # The maintainer writes every change, so nothing in this repository
        # is someone else's code. The docs have to say so before anyone
        # spends time on a pull request.
        for doc in ('README.md', 'CONTRIBUTING.md', '.github/PULL_REQUEST_TEMPLATE.md'):
            text = (ROOT / doc).read_text(encoding='utf-8')
            self.assertRegex(text, r"(?i)(pull requests aren't accepted|doesn't accept pull requests)", doc)

    def test_build_vault_accepts_explicit_target(self):
        source_html = (ROOT / 'public' / 'vault' / 'index.html').read_text(encoding='utf-8')
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / 'nested' / 'index.html'
            target.parent.mkdir(parents=True)
            target.write_text(source_html, encoding='utf-8')
            result = subprocess.run(
                [sys.executable, str(ROOT / 'scripts' / 'build_vault_public.py'),
                 '--target', str(target)],
                cwd=ROOT, capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            output = target.read_text(encoding='utf-8')
            self.assertIn('id="learnings-app"', output)
            self.assertIn('/vault/assets/learnings.js', output)


if __name__ == '__main__':
    unittest.main()
