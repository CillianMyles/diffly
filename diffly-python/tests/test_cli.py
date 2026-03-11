import json
import subprocess
import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
CLI_PATH = REPO_ROOT / "diffly-python" / "diffly.py"


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CLI_PATH), *args],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class DifflyCliTests(unittest.TestCase):
    def test_help_includes_common_modes_and_examples(self) -> None:
        result = run_cli("--help")

        self.assertEqual(result.returncode, 0)
        self.assertIn("positional by default", result.stdout)
        self.assertIn("--compare-by-keys", result.stdout)
        self.assertIn("Examples:", result.stdout)

    def test_compare_by_keys_shorthand_supports_composite_keys(self) -> None:
        fixture_dir = REPO_ROOT / "diffly-spec" / "fixtures" / "keyed_multi_column_key"
        result = run_cli(
            "--a",
            str(fixture_dir / "a.csv"),
            "--b",
            str(fixture_dir / "b.csv"),
            "--compare-by-keys",
            "id,region",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        self.assertEqual(events[0]["type"], "schema")
        self.assertEqual(events[-1]["type"], "stats")
        self.assertEqual(events[-1]["rows_changed"], 1)

    def test_ignore_column_order_alias_matches_sorted_header_mode(self) -> None:
        fixture_dir = REPO_ROOT / "diffly-spec" / "fixtures" / "keyed_header_sorted_mode_add"
        result = run_cli(
            "--a",
            str(fixture_dir / "a.csv"),
            "--b",
            str(fixture_dir / "b.csv"),
            "--key",
            "id",
            "--ignore-column-order",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        self.assertEqual(events[0]["type"], "schema")
        self.assertEqual(events[-1]["type"], "stats")
        self.assertEqual(events[-1]["rows_added"], 1)


if __name__ == "__main__":
    unittest.main()
