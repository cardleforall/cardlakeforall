"""File format policy and multipart upload regression tests (offline)."""
import subprocess
import unittest

from ._paths import ROOT


class UploadValidationTests(unittest.TestCase):
    def test_upload_formats_and_storage_boundary(self):
        result = subprocess.run(
            ['node', '--test', 'tests/unit/upload_validation.test.js'],
            cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=90,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
