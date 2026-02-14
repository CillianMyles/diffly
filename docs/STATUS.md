# Status

Last updated: 2026-02-14

## Snapshot

- Phase: Phase 2 started (`diffly-rust` parity)
- Branch: `main`
- Last pushed commit at time of this update: `1767b55`
- CI: GitHub Actions enabled for PRs and pushes to `main`
- Fixture count: 18
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
- Added fixture for whitespace-only key values (`keyed_whitespace_key_is_value`)
- Added `diffly-rust/diffly-engine` as runtime boundary and switched Rust CLI to use it
- Added Rust CLI smoke validation to CI
- Added optional Rust engine progress events and CLI flag (`--emit-progress` / `EMIT_PROGRESS=1`)
- Added deterministic partition key hashing helpers in `diffly-engine` (FNV-1a)
- Added tempdir-backed spill utilities in `diffly-engine` (`TempDirSpill` + keyed record spilling)
- Added CSV partition pass in `diffly-engine` (`partition_inputs_to_spill`) with:
  - strict/sorted header handling parity
  - hard errors for duplicate columns, missing key columns, and missing key values
  - per-partition row counts for both A and B sides
- Added structured spill record support in `diffly-engine`:
  - partition records now encode `key`, `row_index`, and `row`
  - added `read_spill_records` helper for decoding partition files
- Added partition-local diff execution in `diffly-engine`:
  - `diff_partitioned_from_manifest` emits schema/data/stats events from spill partitions
  - duplicate-key errors preserve source row indices from spill records
- Added opt-in partitioned runtime path:
  - `EngineRunConfig.partition_count` toggles partitioned execution
  - Rust CLI supports `--partitions N`
  - `make diff-rust ... PARTITIONS=N` wired for local use

## In Progress

- Keep Rust and Python behavior in lockstep via shared fixtures
- Validate and refine partitioned-event ordering/compatibility before making it default

## Next

1. Add more parser edge-case fixtures beyond current BOM/CRLF/multiline coverage.
2. Build partition-local join execution that consumes spill files and emits diff events.

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
