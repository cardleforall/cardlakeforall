"""secret-box.js and rate-limit.js tested directly -- encryption key rotation
and tampering, and rate-limit windows. Each case lives in
security_scenarios.js and runs in its own Node process, so a failure names
the case."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import ROOT

SCRIPT = ROOT / "tests" / "unit" / "security_scenarios.js"


class SecurityHelperTests(unittest.TestCase):
    def run_case(self, name: str) -> None:
        result = subprocess.run(["node", str(SCRIPT), name], cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    # secret-box.js
    def test_a_dedicated_key_seals_v2_and_opens_it(self):
        self.run_case("a_dedicated_key_seals_v2_and_opens_it")

    def test_every_seal_uses_a_fresh_iv(self):
        self.run_case("every_seal_uses_a_fresh_iv")

    def test_without_a_dedicated_key_it_falls_back_to_v1_from_the_session_secret(self):
        self.run_case("without_a_dedicated_key_it_falls_back_to_v1_from_the_session_secret")

    def test_v1_values_still_open_after_a_dedicated_key_is_added_and_ask_to_be_resealed(self):
        self.run_case("v1_values_still_open_after_a_dedicated_key_is_added_and_ask_to_be_resealed")

    def test_a_rotated_key_still_opens_old_values_and_flags_them_for_reseal(self):
        self.run_case("a_rotated_key_still_opens_old_values_and_flags_them_for_reseal")

    def test_a_value_no_configured_key_opens_is_null_not_an_error(self):
        self.run_case("a_value_no_configured_key_opens_is_null_not_an_error")

    def test_tampered_ciphertext_fails_authentication(self):
        self.run_case("tampered_ciphertext_fails_authentication")

    def test_unsealed_or_malformed_values_open_to_null(self):
        self.run_case("unsealed_or_malformed_values_open_to_null")

    def test_a_key_that_is_not_32_bytes_is_a_config_error(self):
        self.run_case("a_key_that_is_not_32_bytes_is_a_config_error")

    def test_v1_needs_a_session_secret(self):
        self.run_case("v1_needs_a_session_secret")

    # rate-limit.js
    def test_the_limit_allows_max_requests_then_refuses_with_retry_after(self):
        self.run_case("the_limit_allows_max_requests_then_refuses_with_retry_after")

    def test_the_window_resets(self):
        self.run_case("the_window_resets")

    def test_buckets_and_addresses_are_counted_separately(self):
        self.run_case("buckets_and_addresses_are_counted_separately")

    def test_the_client_address_is_the_first_forwarded_hop(self):
        self.run_case("the_client_address_is_the_first_forwarded_hop")


if __name__ == "__main__":
    unittest.main()
