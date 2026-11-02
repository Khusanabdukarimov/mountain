"""Pure-function tests for app.core.subscription (stdlib only).
Run (from the repo root):  python3 -I backend/tests/test_subscription.py
"""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.core import subscription as sub  # noqa: E402

NOW = datetime(2026, 10, 20, 12, 0, 0, tzinfo=timezone.utc)


class BuildStatus(unittest.TestCase):
    def test_no_row_means_no_limit(self):
        s = sub.build_status(None, NOW)
        self.assertFalse(s["enabled"]); self.assertFalse(s["expired"])
        self.assertEqual(s["brand"], "Mountain")

    def test_future_expiry_counts_down(self):
        s = sub.build_status((NOW + timedelta(days=3, seconds=5), None), NOW)
        self.assertTrue(s["enabled"]); self.assertFalse(s["expired"])
        self.assertEqual(s["seconds_left"], 3 * 86400 + 5)
        self.assertEqual(s["support"], "@Jahongir_data365")
        self.assertEqual(s["support_url"], "https://t.me/Jahongir_data365")

    def test_expiry_in_the_past_is_expired(self):
        s = sub.build_status((NOW - timedelta(seconds=1), None), NOW)
        self.assertTrue(s["expired"]); self.assertEqual(s["seconds_left"], 0)

    def test_exact_moment_is_expired(self):
        self.assertTrue(sub.build_status((NOW, None), NOW)["expired"])

    def test_tashkent_midnight_is_five_hours_before_utc_midnight(self):
        tz = timezone(timedelta(hours=5))
        expires = datetime(2026, 10, 30, 0, 0, tzinfo=tz)
        before = datetime(2026, 10, 29, 18, 59, 59, tzinfo=timezone.utc)   # 23:59:59 Tashkent
        after = datetime(2026, 10, 29, 19, 0, 0, tzinfo=timezone.utc)      # 00:00:00 Tashkent
        self.assertFalse(sub.build_status((expires, None), before)["expired"])
        self.assertTrue(sub.build_status((expires, None), after)["expired"])

    def test_naive_datetimes_are_treated_as_utc(self):
        s = sub.build_status((datetime(2026, 10, 21, 12, 0, 0), None), datetime(2026, 10, 20, 12, 0, 0))
        self.assertEqual(s["seconds_left"], 86400)

    def test_custom_support_contact(self):
        s = sub.build_status((NOW + timedelta(days=1), "  @other_person "), NOW)
        self.assertEqual(s["support"], "@other_person"); self.assertEqual(s["support_url"], "https://t.me/other_person")

    def test_blank_support_falls_back_to_default(self):
        self.assertEqual(sub.build_status((NOW + timedelta(days=1), "   "), NOW)["support"], "@Jahongir_data365")

    def test_expired_payload_names_mountain_and_support(self):
        p = sub.expired_payload(sub.build_status((NOW - timedelta(days=1), None), NOW))
        self.assertEqual(p["code"], "subscription_expired")
        self.assertIn("Mountain", p["message"]); self.assertIn("@Jahongir_data365", p["message"])


if __name__ == "__main__":
    unittest.main()
