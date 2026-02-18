# Fixtures

Each fixture directory represents one conformance case.

Required files:

- `config.json`
- `a.csv`
- `b.csv`
- one of:
  - `expected.jsonl` (success case)
  - `expected_error.json` (hard error case)

Run all fixtures with:

```bash
make test-spec
```

`config.json` supports:

- `mode` (`keyed` or `positional`)
- `key_columns` (required for `keyed`, omitted for `positional`)
- `header_mode` (`strict` default, or `sorted`)
- `emit_unchanged` (`false` default)
- `ignore_row_order` (`false` default; valid only for `mode: positional`)

CSV fixture note:

- UTF-8 BOM in the first header field is treated as metadata and stripped.
