# Status

Last updated: 2026-02-14

## Snapshot

- Phase: Phase 2 started (`diffly-rust` parity)
- Branch: `main`
- Last pushed commit at time of this update: `f1e0b93`
- CI: GitHub Actions enabled for PRs and pushes to `main`
- Fixture count: 17
- Autonomy mode: active (continue until done or hard-blocked)

## Completed

- Added v0 normative spec: `diffly-spec/SPEC.md`
- Added fixture suite + conformance runner (`make test-spec`)
- Added Python reference CLI (`diffly-python/diffly.py`)
- Added CI checks (`.github/workflows/ci.yml`)
- Added rules requiring commit co-author trailer
- Added project memory docs and autonomy gates
- Added semantic hardening:
  - duplicate column names are hard errors
  - missing key values are hard errors
  - optional `header_mode=sorted` support
- Expanded fixtures for quoted fields, multiline fields, CRLF, and additional error paths
- Started Rust workspace:
  - `diffly-rust/diffly-core` implements keyed semantics
  - `diffly-rust/diffly-conformance` runs shared fixture suite
- Added UTF-8 BOM header normalization and fixture coverage (`keyed_utf8_bom_header`)
- Added `empty_file` edge-case fixture coverage (`error_empty_file_in_a`)
- Added Rust unit tests for core error modes and deterministic event ordering
- Added `make diff` composite-key ergonomics via `KEYS=id,region`
- Expanded CI Rust checks with cache + `cargo test`
- Added native Rust CLI surface (`diffly-rust/diffly-cli`) + `make diff-rust`

## In Progress

- Keep Rust and Python behavior in lockstep via shared fixtures

## Next

1. Add more parser edge-case fixtures beyond current BOM/CRLF/multiline coverage.
2. Start separating Rust semantics vs engine concerns for out-of-core implementation.

## Blockers

- None currently.

## Validation Commands

- `make test-spec`
- `make test-spec-rust`
- `python3 -m compileall diffly-python`
- `python3 diffly-python/diffly.py --a diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv --b diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv --key id`

## Update Protocol

Update this file at task boundaries:

- before starting substantial new work (`In Progress`, `Next`)
- after finishing a logical chunk (`Completed`, latest commit)
- whenever blockers appear or clear
