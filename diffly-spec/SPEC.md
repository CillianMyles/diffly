# diffly Spec v0 (Normative)

This document defines the initial conformance target for `diffly`.

## Scope

- Modes: `keyed` and `positional`.
- Input: two CSV files with header rows.
- Output: JSONL event stream.
- Goal: deterministic semantics for fixtures and cross-language conformance.

`bag` mode is out of scope for v0.

## CSV Parsing Rules

- UTF-8 text input.
- First row is the header.
- Empty files are a hard error (`empty_file`).
- If a UTF-8 BOM is present at the start of the first header field, it is stripped.
- Duplicate header names are a hard error (`duplicate_column_name`).
- Header comparison supports two modes:
  - `strict` (default): ordered header list must match exactly.
  - `sorted`: sorted header names must match.
- Header mismatch is a hard error (`header_mismatch`) in both modes.
- Row width must match header width exactly.
- Row width mismatch is a hard error (`row_width_mismatch`).

## Key Rules (`keyed` mode only)

- `key_columns` must be present in both headers.
- Missing key column is a hard error (`missing_key_column`).
- Keys are tuples of raw CSV string values in `key_columns` order.
- Empty string in any key column is a hard error (`missing_key_value`).
- Whitespace-only key values (e.g. `" "`) are valid key values in v0.
- Duplicate keys in either input are a hard error (`duplicate_key`).

## Type and Value Rules

- v0 does not coerce types. All CSV fields are strings.
- Value comparison is strict string equality.
- Empty string (`""`) is distinct from any non-empty value (including literal `"null"`).
- Null-equivalence behavior is out of scope for v0 and can be added later as an option.

## Diff Behavior (`keyed`)

Given unique keyed rows from A and B:

- Key in B not A => `added`
- Key in A not B => `removed`
- Key in both:
  - identical full row => `unchanged` (only if `emit_unchanged=true`)
  - otherwise => `changed`

## Diff Behavior (`positional`)

Given row sequences from A and B:

- Compare data row `i` in A with data row `i` in B (1-based data row index; event `row_index = i + 1` in CSV coordinates).
- Row exists in B but not A => `added`
- Row exists in A but not B => `removed`
- Row exists in both:
  - identical full row => `unchanged` (only if `emit_unchanged=true`)
  - otherwise => `changed`

## Deterministic Ordering

To keep fixtures deterministic:

- `keyed`: emit data events in ascending key tuple order (lexicographic string tuple order).
- `positional`: emit data events in ascending `row_index` order.
- For `changed`, emit the `changed` column list in comparison order:
  - `strict`: A header order
  - `sorted`: sorted column names

Future out-of-core partitioning note:

- Stable key hashing uses FNV-1a (64-bit) over UTF-8 key parts joined by delimiter byte `0x1f`.

## Event Stream

Event stream is JSONL.

- First event: `schema`
- Then data events: `added`/`removed`/`changed` (and optional `unchanged`)
- Final event: `stats`

## Event Shapes

### `schema`

```json
{
  "type": "schema",
  "columns_a": ["id", "name"],
  "columns_b": ["id", "name"]
}
```

### `added`

```json
{
  "type": "added",
  "key": {"id": "2"},
  "row": {"id": "2", "name": "Bob"}
}
```

### `removed`

```json
{
  "type": "removed",
  "key": {"id": "1"},
  "row": {"id": "1", "name": "Alice"}
}
```

### `changed`

```json
{
  "type": "changed",
  "key": {"id": "3"},
  "changed": ["name"],
  "before": {"id": "3", "name": "Carol"},
  "after": {"id": "3", "name": "Caroline"},
  "delta": {"name": {"from": "Carol", "to": "Caroline"}}
}
```

### `changed` (`positional` example)

```json
{
  "type": "changed",
  "row_index": 2,
  "changed": ["name"],
  "before": {"id": "1", "name": "Alice"},
  "after": {"id": "1", "name": "Alicia"},
  "delta": {"name": {"from": "Alice", "to": "Alicia"}}
}
```

### `stats`

```json
{
  "type": "stats",
  "rows_total_compared": 1,
  "rows_added": 1,
  "rows_removed": 1,
  "rows_changed": 1,
  "rows_unchanged": 0
}
```

## Fixture Contract

Each fixture directory contains:

- `config.json`
- `a.csv`
- `b.csv`
- Exactly one expected output file:
  - `expected.jsonl` for success, or
  - `expected_error.json` for hard errors

`expected_error.json` shape:

```json
{
  "code": "duplicate_key",
  "message_contains": "Duplicate key in A"
}
```

`config.json` fields for v0:

```json
{
  "mode": "keyed",
  "key_columns": ["id"],
  "header_mode": "strict",
  "emit_unchanged": false
}
```

`mode` values:

- `keyed`: `key_columns` is required and must be non-empty.
- `positional`: `key_columns` is ignored and should be omitted.
