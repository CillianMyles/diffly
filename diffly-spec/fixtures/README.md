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
