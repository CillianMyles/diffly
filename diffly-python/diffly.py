#!/usr/bin/env python3
import argparse
import json
import sys

from diffly_python.reference import DiffError, diff_csv_files


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Diff two CSV files and emit JSONL events (positional by default; keyed when keys are provided)."
    )
    parser.add_argument("--a", required=True, help="Path to CSV A")
    parser.add_argument("--b", required=True, help="Path to CSV B")
    parser.add_argument(
        "--key",
        action="append",
        dest="key_columns",
        default=[],
        help="Key column (repeat for composite keys, e.g. --key id --key region). Enables keyed comparison.",
    )
    parser.add_argument(
        "--compare-by-keys",
        dest="compare_by_keys",
        default="",
        help="Comma-separated key columns. Shorthand that enables keyed comparison.",
    )
    parser.add_argument(
        "--emit-unchanged",
        action="store_true",
        help="Emit unchanged row events (off by default)",
    )
    parser.add_argument(
        "--header-mode",
        choices=("strict", "sorted"),
        default="strict",
        help="Header comparison mode: strict order match (default) or sorted-name match",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output instead of compact JSONL",
    )
    return parser


def _encode_event(event: dict, pretty: bool) -> str:
    if pretty:
        return json.dumps(event, ensure_ascii=False, indent=2, sort_keys=True)
    return json.dumps(event, ensure_ascii=False, separators=(",", ":"))


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    key_columns = list(args.key_columns)
    if args.compare_by_keys:
        key_columns.extend([value.strip() for value in args.compare_by_keys.split(",") if value.strip()])
    mode = "keyed" if key_columns else "positional"

    try:
        events = diff_csv_files(
            a_path=args.a,
            b_path=args.b,
            key_columns=key_columns,
            mode=mode,
            header_mode=args.header_mode,
            emit_unchanged=args.emit_unchanged,
        )
    except DiffError as err:
        error_event = {"type": "error", "code": err.code, "message": err.message}
        print(_encode_event(error_event, pretty=False), file=sys.stderr)
        return 2

    for event in events:
        print(_encode_event(event, pretty=args.pretty))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
