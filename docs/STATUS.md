# Status

Last updated: 2026-02-17

## Snapshot

- Phase: Phase 4 MVP complete (`diffly-web` worker + wasm)
- Branch: `main`
- Last pushed commit at time of this update: `37f3f47`
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
- Added CI coverage for partitioned Rust CLI mode (`make diff-rust ... PARTITIONS=4` smoke check)
- Added engine-backed conformance mode:
  - `diffly-conformance` supports `DIFFLY_ENGINE_PARTITIONS`
  - `make test-spec-rust-engine PARTITIONS=4` checks fixture parity through engine path
  - CI now runs this engine parity check on each push/PR
- Updated partitioned diff ordering to global key-sorted emission, enabling multi-partition fixture parity.
- Added partition-phase cancellation checks in engine path:
  - cancellation is now respected during partition input pass and partition-local diff traversal
  - added engine unit coverage for cancelled partitioned runs
- Switched engine runtime default to partitioned mode (default partition count: 64), with CLI override via `--partitions`.
- Added explicit core-path fallback switch in Rust CLI (`--no-partitions`; `NO_PARTITIONS=1` in `make diff-rust`).
- Added coarse partitioned-progress phases in engine runtime (`partitioning`, `diff_partitions`, `emit_events`) with unit coverage.
- Added `diffly-core` byte-input entrypoint (`diff_csv_bytes`) for non-filesystem callers.
- Added Rust WASM crate (`diffly-rust/diffly-wasm`) exposing `diff_csv_bytes_json(...)`.
- Added `diffly-web` Next.js app inspired by DiffyData UX, including:
  - dedicated Web Worker compare pipeline
  - Rust/WASM path for small files
  - streaming worker fallback for larger files to avoid main-thread buffering/freezes
  - cancel + progress + bounded sample event rendering
- Added web/wasm make commands:
  - `make web-install`
  - `make web-dev`
  - `make web-typecheck`
  - `make wasm-build-web`
- Added CI web app checks (`npm ci`, typecheck, build).
- Added Rust CLI output modes and file output:
  - `--format jsonl|json|summary`
  - `--out <path>`
  - `make diff-rust ... FORMAT=... OUT=...`
- Added large-file web spill path:
  - worker now uses partitioned IndexedDB spill for large input totals
  - worker falls back to in-memory streaming mode only when IndexedDB is unavailable
  - fixed sorted-header signature comparison in web streaming mode
- Added detailed manual test plan doc:
  - `docs/MANUAL_TEST_PLAN.md`
  - covers semantic fixtures, CLI modes, web worker/WASM paths, large-file survivability, and regression checklist
- Added true file drag/drop support in `diffly-web` upload cards (including external Finder drags).
- Moved web CI job to run after Python + Rust jobs (`needs` ordering) so web checks run last.
- Added JS/Next/web guardrails to project rules and regenerated rule targets.
- Added Firebase Hosting static client deployment setup for `diffly-web`:
  - Next config now exports static output (`diffly-web/out`)
  - root `firebase.json` serves static assets with SPA rewrites
  - deployment steps documented in `diffly-web/README.md`

## In Progress

- Keep Rust/Python fixture parity stable while adding browser runtime behavior.
- Harden web large-file behavior with OPFS/IndexedDB spill and browser-scale regressions.

## Next

1. Move browser large-file path from in-memory maps toward OPFS-backed partition spill.
2. Add browser-level regression tests for 100MB+ inputs (progress/cancel/non-freeze assertions).

## Blockers

- None currently.

## Validation Commands

- `make test-spec`
- `make test-spec-rust`
- `make test-spec-rust-engine PARTITIONS=4`
- `make web-typecheck`
- `npm --prefix diffly-web run build`
- `firebase deploy --only hosting`
- `python3 -m compileall diffly-python`
- `python3 diffly-python/diffly.py --a diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv --b diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv --key id`

## Update Protocol

Update this file at task boundaries:

- before starting substantial new work (`In Progress`, `Next`)
- after finishing a logical chunk (`Completed`, latest commit)
- whenever blockers appear or clear
