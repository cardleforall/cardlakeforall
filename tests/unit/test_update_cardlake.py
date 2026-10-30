"""The "Update Cardlake" button (.github/workflows/update-cardlake.yml and
scripts/update_from_upstream.sh): an owner's copy, made with the Deploy
button and sharing no history with Cardlake, takes a newer Cardlake's files
unless the owner changed the code, and keeps its own workflows."""
from __future__ import annotations

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts' / 'update_from_upstream.sh'
WORKFLOW = ROOT / '.github' / 'workflows' / 'update-cardlake.yml'
BASH = shutil.which('bash')
GIT_ENV = {
    'GIT_AUTHOR_NAME': 'Test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
    'GIT_COMMITTER_NAME': 'Test', 'GIT_COMMITTER_EMAIL': 'test@example.com',
    'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1',
}

V1 = {'app.js': 'one\n', 'gone.txt': 'old\n', '.github/workflows/ci.yml': 'ci: one\n'}
V2 = {'app.js': 'two\n', 'new.txt': 'new\n', '.github/workflows/ci.yml': 'ci: two\n'}


@unittest.skipUnless(BASH, 'needs bash')
class UpdateCardlakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.temp, ignore_errors=True)
        self.cardlake = self.temp / 'cardlake'
        self.copy = self.temp / 'copy'
        self.init(self.cardlake)
        self.commit(self.cardlake, V1, 'v1')
        self.commit(self.cardlake, V2, 'v2')
        self.v2 = self.git(self.cardlake, 'rev-parse', 'HEAD')

    def git(self, repo, *args):
        result = subprocess.run(['git', *args], cwd=repo, capture_output=True, text=True,
                                env={**os.environ, **GIT_ENV}, check=True)
        return result.stdout.strip()

    def init(self, repo):
        repo.mkdir()
        self.git(repo, 'init', '-q', '-b', 'main')
        self.git(repo, 'config', 'core.autocrlf', 'false')

    def commit(self, repo, files, message):
        for name in self.git(repo, 'ls-files').splitlines():
            (repo / name).unlink()
        for name, text in files.items():
            (repo / name).parent.mkdir(parents=True, exist_ok=True)
            (repo / name).write_bytes(text.encode())
        self.git(repo, 'add', '-A')
        self.git(repo, 'commit', '-q', '-m', message)

    def make_copy(self, files):
        # The Deploy button's copy: the same files in a history of its own.
        self.init(self.copy)
        self.commit(self.copy, files, 'Initial commit')
        self.git(self.copy, 'fetch', '-q', str(self.cardlake), 'main')

    def update(self, *flags):
        return subprocess.run([BASH, SCRIPT.as_posix(), self.v2, *flags], cwd=self.copy,
                              capture_output=True, text=True, env={**os.environ, **GIT_ENV})

    def files(self):
        return {name: (self.copy / name).read_text() for name in self.git(self.copy, 'ls-files').splitlines()}

    def test_an_unchanged_copy_takes_the_new_version_and_keeps_its_workflows(self):
        self.make_copy(V1)
        result = self.update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files(), {'app.js': 'two\n', 'new.txt': 'new\n', '.github/workflows/ci.yml': 'ci: one\n'})
        self.assertIn("workflows", result.stdout)
        self.assertEqual(self.git(self.copy, 'status', '--porcelain'), '')

        again = self.update()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn('already up to date', again.stdout)

    def test_a_changed_copy_is_refused_and_left_alone(self):
        self.make_copy({**V1, 'app.js': 'my own change\n'})
        before = self.git(self.copy, 'rev-parse', 'HEAD')
        result = self.update()
        self.assertEqual(result.returncode, 3)
        self.assertIn('Nothing was updated', result.stdout)
        self.assertEqual(self.git(self.copy, 'rev-parse', 'HEAD'), before)
        self.assertEqual(self.files()['app.js'], 'my own change\n')

    def test_overwrite_updates_a_changed_copy(self):
        self.make_copy({**V1, 'app.js': 'my own change\n'})
        result = self.update('--overwrite')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.files()['app.js'], 'two\n')

    def test_the_workflow_only_runs_by_hand_and_never_in_cardlakes_own_repository(self):
        workflow = WORKFLOW.read_text(encoding='utf-8')
        self.assertIn('workflow_dispatch:', workflow)
        self.assertNotIn('schedule:', workflow)
        self.assertIn("if: github.repository != 'cardleforall/cardlakeforall'", workflow)
        self.assertIn('scripts/update_from_upstream.sh', workflow)


if __name__ == '__main__':
    unittest.main()
