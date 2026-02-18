#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from diffly_python.reference import DiffError, diff_csv_files


def _load_jsonl(path: Path):
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def run_case(case_dir: Path):
    config_path = case_dir / "config.json"
    if not config_path.exists():
        return True, "skipped (no config.json)"

    config = json.loads(config_path.read_text(encoding="utf-8"))
    mode = config.get("mode", "keyed")
    if mode not in ("keyed", "positional"):
        return False, f"unsupported mode in fixture: {mode}"

    expected_jsonl = case_dir / "expected.jsonl"
    expected_error = case_dir / "expected_error.json"

    if expected_jsonl.exists() == expected_error.exists():
        return False, "fixture must include exactly one of expected.jsonl or expected_error.json"

    try:
        actual = diff_csv_files(
            str(case_dir / "a.csv"),
            str(case_dir / "b.csv"),
            key_columns=config.get("key_columns", []),
            mode=mode,
            header_mode=str(config.get("header_mode", "strict")),
            emit_unchanged=bool(config.get("emit_unchanged", False)),
            ignore_row_order=bool(config.get("ignore_row_order", False)),
        )
    except DiffError as err:
        if not expected_error.exists():
            return False, f"unexpected DiffError({err.code}): {err.message}"

        expected = json.loads(expected_error.read_text(encoding="utf-8"))
        if err.code != expected.get("code"):
            return False, f"error code mismatch: got {err.code}, expected {expected.get('code')}"

        needle = expected.get("message_contains", "")
        if needle and needle not in err.message:
            return False, f"error message mismatch: expected to contain '{needle}', got '{err.message}'"

        return True, "ok"

    if expected_error.exists():
        return False, "expected error but case succeeded"

    expected = _load_jsonl(expected_jsonl)
    if actual != expected:
        return (
            False,
            "output mismatch\n"
            f"actual:   {json.dumps(actual, indent=2, sort_keys=True)}\n"
            f"expected: {json.dumps(expected, indent=2, sort_keys=True)}",
        )

    return True, "ok"


def main():
    repo_root = Path(__file__).resolve().parent.parent
    fixtures_root = repo_root / "diffly-spec" / "fixtures"

    case_dirs = sorted([p for p in fixtures_root.iterdir() if p.is_dir()], key=lambda p: p.name)

    failed = 0
    for case_dir in case_dirs:
        ok, msg = run_case(case_dir)
        status = "PASS" if ok else "FAIL"
        print(f"[{status}] {case_dir.name}: {msg}")
        if not ok:
            failed += 1

    if failed:
        print(f"\n{failed} fixture(s) failed")
        return 1

    print(f"\nAll fixtures passed ({len(case_dirs)} cases)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
