import csv
from collections import Counter
from pathlib import Path


class DiffError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _validate_header(header: list[str], side: str):
    duplicates = [name for name, count in Counter(header).items() if count > 1]
    if duplicates:
        raise DiffError(
            "duplicate_column_name",
            f"Duplicate column name in {side}: {duplicates[0]}",
        )


def _read_csv(path: Path, side: str):
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration as exc:
            raise DiffError("empty_file", f"{side} file is empty: {path}") from exc

        _validate_header(header, side)

        rows = []
        width = len(header)
        for row_index, values in enumerate(reader, start=2):
            if len(values) != width:
                raise DiffError(
                    "row_width_mismatch",
                    f"Row width mismatch in {side} at CSV row {row_index}: expected {width}, got {len(values)}",
                )
            rows.append((row_index, dict(zip(header, values))))

    return header, rows


def _key_tuple(row: dict, key_columns: list[str]):
    return tuple(row[column] for column in key_columns)


def _key_object(key_columns: list[str], key_tuple_value: tuple[str, ...]):
    return {column: key_tuple_value[i] for i, column in enumerate(key_columns)}


def _index_rows(rows: list[tuple[int, dict]], key_columns: list[str], side: str):
    indexed = {}
    for row_index, row in rows:
        for key_column in key_columns:
            if row[key_column] == "":
                raise DiffError(
                    "missing_key_value",
                    f"Missing key value in {side} at CSV row {row_index} for key column '{key_column}'",
                )

        key = _key_tuple(row, key_columns)
        if key in indexed:
            prior_row_index = indexed[key][0]
            raise DiffError(
                "duplicate_key",
                f"Duplicate key in {side}: {_key_object(key_columns, key)} (rows {prior_row_index} and {row_index})",
            )
        indexed[key] = (row_index, row)
    return indexed


def _comparison_columns(a_header: list[str], b_header: list[str], header_mode: str):
    if header_mode == "strict":
        if a_header != b_header:
            raise DiffError("header_mismatch", f"Header mismatch: A={a_header} B={b_header}")
        return a_header

    if header_mode == "sorted":
        if sorted(a_header) != sorted(b_header):
            raise DiffError(
                "header_mismatch",
                f"Header mismatch (sorted mode): A={a_header} B={b_header}",
            )
        return sorted(a_header)

    raise DiffError("invalid_header_mode", f"Unsupported header_mode: {header_mode}")


def diff_csv_files(
    a_path: str,
    b_path: str,
    key_columns: list[str],
    header_mode: str = "strict",
    emit_unchanged: bool = False,
):
    a_header, a_rows = _read_csv(Path(a_path), "A")
    b_header, b_rows = _read_csv(Path(b_path), "B")
    compare_columns = _comparison_columns(a_header, b_header, header_mode)

    for key_column in key_columns:
        if key_column not in a_header:
            raise DiffError("missing_key_column", f"Missing key column: {key_column}")

    indexed_a = _index_rows(a_rows, key_columns, "A")
    indexed_b = _index_rows(b_rows, key_columns, "B")

    all_keys = sorted(set(indexed_a.keys()) | set(indexed_b.keys()))

    events = [
        {
            "type": "schema",
            "columns_a": a_header,
            "columns_b": b_header,
        }
    ]

    rows_total_compared = 0
    rows_added = 0
    rows_removed = 0
    rows_changed = 0
    rows_unchanged = 0

    for key in all_keys:
        key_obj = _key_object(key_columns, key)

        if key not in indexed_a:
            rows_added += 1
            events.append({"type": "added", "key": key_obj, "row": indexed_b[key][1]})
            continue

        if key not in indexed_b:
            rows_removed += 1
            events.append({"type": "removed", "key": key_obj, "row": indexed_a[key][1]})
            continue

        rows_total_compared += 1
        row_a = indexed_a[key][1]
        row_b = indexed_b[key][1]

        changed_columns = [column for column in compare_columns if row_a[column] != row_b[column]]
        if not changed_columns:
            rows_unchanged += 1
            if emit_unchanged:
                events.append({"type": "unchanged", "key": key_obj, "row": row_a})
            continue

        rows_changed += 1
        events.append(
            {
                "type": "changed",
                "key": key_obj,
                "changed": changed_columns,
                "before": row_a,
                "after": row_b,
                "delta": {
                    column: {"from": row_a[column], "to": row_b[column]}
                    for column in changed_columns
                },
            }
        )

    events.append(
        {
            "type": "stats",
            "rows_total_compared": rows_total_compared,
            "rows_added": rows_added,
            "rows_removed": rows_removed,
            "rows_changed": rows_changed,
            "rows_unchanged": rows_unchanged,
        }
    )

    return events
