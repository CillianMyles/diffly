# Status

Last updated: 2026-02-14

## Snapshot

- Phase: Phase 1 (`diffly-spec` + Python reference)
- Branch: `main`
- Latest pushed commit: `c7e822d`
- CI: GitHub Actions enabled for PRs and pushes to `main`

## Completed

- Added v0 normative spec: `diffly-spec/SPEC.md`
- Added fixture suite + conformance runner (`make test-spec`)
- Added Python reference CLI (`diffly-python/diffly.py`)
- Added CI checks (`.github/workflows/ci.yml`)
- Added rules requiring commit co-author trailer

## In Progress

- Hardening spec coverage with additional CSV edge-case fixtures

## Next

1. Add more fixtures for CSV edge cases (quotes, multiline, CRLF, BOM, row width mismatches).
2. Add tests for missing key values as hard errors.
3. Improve CLI ergonomics for composite keys and machine-readable errors.
4. Keep CI fast while adding checks incrementally.

## Blockers

- None currently.

## Validation Commands

- `make test-spec`
- `python3 -m compileall diffly-python`
- `python3 diffly-python/diffly.py --a diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv --b diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv --key id`

## Update Protocol

Update this file at task boundaries:

- before starting substantial new work (`In Progress`, `Next`)
- after finishing a logical chunk (`Completed`, latest commit)
- whenever blockers appear or clear
