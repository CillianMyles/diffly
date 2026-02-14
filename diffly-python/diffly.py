#!/usr/bin/env python3
import argparse
import json
import sys

from diffly_python.reference import DiffError, diff_csv_files


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Diff two CSV files in keyed mode and emit JSONL events.")
    parser.add_argument("--a", required=True, help="Path to CSV A")
    parser.add_argument("--b", required=True, help="Path to CSV B")
    parser.add_argument(
        "--key",
        action="append",
        required=True,
        dest="key_columns",
        help="Key column (repeat for composite keys, e.g. --key id --key region)",
    )
    parser.add_argument(
        "--emit-unchanged",
        action="store_true",
        help="Emit unchanged row events (off by default)",
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

    try:
        events = diff_csv_files(
            a_path=args.a,
            b_path=args.b,
            key_columns=args.key_columns,
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
