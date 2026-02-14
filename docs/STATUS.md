# Status

Last updated: 2026-02-14

## Snapshot

- Phase: Phase 2 started (`diffly-rust` parity)
- Branch: `main`
- Last pushed commit at time of this update: `19bd57d`
- CI: GitHub Actions enabled for PRs and pushes to `main`
- Fixture count: 15
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

## In Progress

- Keep Rust and Python behavior in lockstep via shared fixtures

## Next

1. Add fixtures for BOM and other parser edge-cases.
2. Improve CLI ergonomics for composite keys in `make` workflow.
3. Add Rust unit tests around core error modes and ordering.
4. Keep CI fast while adding checks incrementally.

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
