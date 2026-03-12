# Status

Last updated: 2026-03-11

## Snapshot

- Phase: Phase 4 MVP complete (`diffly-web` worker + wasm)
- Branch: `main`
- Last pushed commit at time of this update: `c92346a`
- CI: GitHub Actions enabled for PRs and pushes to `main`
- Fixture count: 20
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
- Added CI/CD deploy automation for Firebase Hosting:
  - `.github/workflows/ci.yml` now supports `workflow_dispatch`
  - production deploy job runs on `main` after all checks pass
  - deploy requires GitHub secrets `FIREBASE_PROJECT_ID` and `FIREBASE_TOKEN`
- Added positional compare mode across Python/Rust/web with default mode selection:
  - positional is now the default when no keys are provided
  - keyed remains available when key columns are provided
  - positional row events include `row_index` instead of `key`
- Added positional fixture coverage (`positional_basic_add_remove_change`) and enabled conformance runners for both `keyed` and `positional` fixtures.
- Updated CLI surfaces:
  - Python CLI: `--key` is optional, added `--compare-by-keys`
  - Rust CLI: `--key` is optional, added `--compare-by-keys`
  - `make diff` / `make diff-rust` no longer require keys
- Updated web app compare UX:
  - default compare mode is positional
  - compare strategy selector now supports positional, ignore-row-order, and keyed
  - sample rendering supports either keyed identity or positional `row_index`
- Rebuilt Rust WASM package for web after positional support in `diffly-wasm`.
- Updated CI smoke checks to include positional default-mode CLI runs for both Python and Rust.
- Added `--ignore-column-order` CLI alias support (mapped to sorted header comparison) across Python CLI, Rust CLI, and `make diff` / `make diff-rust`.
- Added `--ignore-row-order` support in Python/Rust runtime semantics (positional multiset mode) with:
  - hard error for keyed + ignore-row-order combination
  - spec + fixture coverage (`positional_ignore_row_order_basic_add_remove`)
  - conformance runner config support via `ignore_row_order` fixture flag
  - CLI plumbing (`diffly.py`, `diffly-cli`, `make diff`, `make diff-rust`)
- Updated web compare controls and worker wiring for new strategy model:
  - strategy selector: positional, ignore-row-order, compare-by-key
  - checkbox toggles: ignore-column-order, prefer-wasm-for-small-files
  - worker protocol now includes `ignoreRowOrder`
  - small-file WASM path now receives ignore-row-order flag
- Updated CI smoke checks to cover ignore-row-order and ignore-column-order flows for both Python and Rust CLI paths.
- Updated project documentation to match current semantics/UI:
  - `README.md` now documents `IGNORE_ROW_ORDER` and `IGNORE_COLUMN_ORDER` usage
  - `diffly-web/README.md` now documents strategy-based controls
  - `docs/MANUAL_TEST_PLAN.md` updated to include ignore-row-order and ignore-column-order validation flows
- Upgraded web sample diff rendering to a git-style view:
  - worker/protocol now preserve `changed` columns and per-field `delta` metadata across WASM and streaming paths
  - sample events render red/green before/after panels with stronger inline changed-token highlighting
  - added shared diff color tokens in web globals
- Added contributor onboarding improvements:
  - new `CONTRIBUTING.md` quickstart and workflow guide
  - added `.nvmrc` and `.editorconfig`
  - `README.md` now includes prerequisites and top-level quality-loop commands
- Added top-level developer workflow commands in `Makefile`:
  - `make doctor`
  - `make bootstrap`
  - `make lint`
  - `make test`
  - `make check`
  - `make web-lint`
  - `make web-build`
- Simplified `Makefile` maintenance by centralizing Rust toolchain resolution and adding clearer `KEY`/`KEYS` validation in `make diff` and `make diff-rust`
- Added CLI regression coverage:
  - Python subprocess tests for help text, composite key shorthand, and ignore-column-order alias
  - Rust CLI parser tests for help text, composite key shorthand, and partition argument validation
- Added web ESLint setup and CI coverage (`make web-lint`)
- Added Rust CLI terminal diff inspector mode:
  - `--format diff` / `FORMAT=diff`
  - changed rows render first and stay labeled as changed
  - changed columns render with inline `A | B` comparisons instead of a git-style remove/add pair
  - changed cell values use inline substring emphasis sourced from existing event metadata
  - added/removed rows render as green/red field blocks
- Simplified web inline diff heuristics for changed cells:
  - field-level red/green emphasis is still the default for all changed cells
  - changed values now use whole-value emphasis instead of per-character/token diffing
  - short scalar values avoid noisy character-level diff treatment
- Updated web changed-row labels to use `A` / `B` plus the selected input file names instead of `Before` / `After`

## In Progress

- Keep Rust/Python fixture parity stable while adding browser runtime behavior.
- Harden web large-file behavior with OPFS/IndexedDB spill and browser-scale regressions.
- Continue tightening terminal/web diff inspection UX now that both surfaces preserve field-level delta metadata.

## Next

1. Move browser large-file path from in-memory maps toward OPFS-backed partition spill.
2. Add browser-level regression tests for 100MB+ inputs (progress/cancel/non-freeze assertions).
3. Evaluate whether CLI `diff` mode should eventually stream directly from JSONL events for very large result sets instead of collecting the full run.

## Blockers

- None currently.

## Validation Commands

- `make test-spec`
- `make test-python`
- `make test-spec-rust`
- `make test-spec-rust-engine PARTITIONS=4`
- `make lint`
- `make test`
- `make check`
- `make web-lint`
- `make web-typecheck`
- `npm --prefix diffly-web run build`
- `npm --prefix diffly-web run typecheck`
- `make web-build`
- `firebase deploy --only hosting`
- GitHub Actions: run `CI` workflow (`push main` or `workflow_dispatch`) and confirm deploy job succeeds
- `make doctor`
- `python3 -m compileall diffly-python`
- `python3 diffly-python/diffly.py --a diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv --b diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv --key id`
- `python3 diffly-python/diffly.py --a diffly-spec/fixtures/positional_basic_add_remove_change/a.csv --b diffly-spec/fixtures/positional_basic_add_remove_change/b.csv`
- `python3 diffly-python/diffly.py --a diffly-spec/fixtures/positional_ignore_row_order_basic_add_remove/a.csv --b diffly-spec/fixtures/positional_ignore_row_order_basic_add_remove/b.csv --ignore-row-order`
- `make diff-rust A=diffly-spec/fixtures/positional_basic_add_remove_change/a.csv B=diffly-spec/fixtures/positional_basic_add_remove_change/b.csv`
- `NO_COLOR=1 make diff-rust A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv KEY=id FORMAT=diff`
- `make diff-rust A=diffly-spec/fixtures/keyed_header_sorted_mode_add/a.csv B=diffly-spec/fixtures/keyed_header_sorted_mode_add/b.csv KEY=id IGNORE_COLUMN_ORDER=1`
- `make diff-rust A=diffly-spec/fixtures/positional_ignore_row_order_basic_add_remove/a.csv B=diffly-spec/fixtures/positional_ignore_row_order_basic_add_remove/b.csv IGNORE_ROW_ORDER=1`

## Update Protocol

Update this file at task boundaries:

- before starting substantial new work (`In Progress`, `Next`)
- after finishing a logical chunk (`Completed`, latest commit)
- whenever blockers appear or clear
