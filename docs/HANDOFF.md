# Handoff

Use this file to transfer context between sessions/agents with minimal loss.

## Current State

- Active phase: Phase 4 MVP complete
- Fixture suite: 19 conformance cases
- Truth sources:
  - vision/roadmap: `README.md`
  - semantics: `diffly-spec/SPEC.md`
  - current progress: `docs/STATUS.md`
  - decisions/constraints: `docs/DECISIONS.md`
- Implemented semantics highlights:
  - compare mode default: positional (row-by-row)
  - keyed mode: enabled only when key columns are provided
  - positional `ignore_row_order` support: multiset semantics
  - positional row events emit `row_index`
  - `header_mode`: `strict` (default) and `sorted`
  - duplicate column names: hard error
  - missing key values (`""`): hard error
- Rust implementation:
  - `diffly-rust/diffly-core`: semantics engine
  - `diffly-rust/diffly-engine`: runtime boundary (sink/cancel)
  - `diffly-rust/diffly-cli`: native CLI entrypoint
  - `diffly-rust/diffly-conformance`: fixture parity runner
  - partition input pass implemented (`partition_inputs_to_spill`) using tempdir JSONL spill files
  - spill records include `key`, `row_index`, and raw `row` payload (`read_spill_records` helper added)
  - partition-local diff execution available via `diff_partitioned_from_manifest`
  - runtime defaults to partitioned path (`EngineRunConfig.partition_count=Some(64)`) with CLI override via `--partitions`
  - CLI supports `--no-partitions` to force core path for debugging/comparison
  - CI includes partitioned CLI smoke coverage
  - conformance runner can execute engine path via `DIFFLY_ENGINE_PARTITIONS` (`make test-spec-rust-engine`)
  - partitioned engine now emits globally key-sorted events and passes fixtures at `PARTITIONS=4`
  - cancellation checks are active during partitioning + partition diff traversal
  - progress events include coarse partition phases: `partitioning`, `diff_partitions`, `emit_events`
- Web implementation (`diffly-web`):
  - Next.js app seeded from DiffyData-style UX
  - worker-first compare architecture (main thread stays responsive)
  - small-file Rust/WASM path (`diffly-rust/diffly-wasm`)
  - large-file partitioned IndexedDB spill path with in-memory fallback when unavailable
  - wasm package generated into `diffly-web/src/wasm/pkg` via `make wasm-build-web`
  - fixed streaming worker hang and blank-line parse mismatch for non-WASM mode
  - sorted-header comparison now uses canonical column signatures in web worker path
  - compare settings now use strategy selector (`positional` / `ignore row order` / `compare by key`) plus `ignore column order` + WASM preference toggles
- CLI implementation:
  - supports `jsonl` (default), `json`, and `summary` output modes
  - supports `--out <path>` for file output

## Quick Resume Checklist

1. `git pull origin main`
2. Read `docs/STATUS.md` and `docs/DECISIONS.md`
3. Run `make test-spec`
4. Run `make test-spec-rust`
5. Run `make web-typecheck`
6. Run `npm --prefix diffly-web run build`
7. If touching rules/instructions:
   - edit `.rulesync/rules/general.md`
   - run `make rules-generate`
8. After any change, run relevant validation commands and update `docs/STATUS.md`

## Delivery Rules

- Keep changes small and logical.
- Use Conventional Commits.
- Include commit trailer:
  - `Co-authored-by: Cillian Myles <myles.cillian@gmail.com>`
- Push to `main` (current policy until changed).
- In autonomous mode, continue chunk-by-chunk without waiting for approval between chunks.
- Stop only for hard blockers, uncovered product decisions, or explicit user stop.

## Minimum Validation Before Commit

- `make test-spec`
- `cargo test --manifest-path diffly-rust/Cargo.toml` (when Rust code changes)
- Any targeted command related to changed files (example: CLI smoke run)

## If Blocked

Record in `docs/STATUS.md`:

- what was attempted
- exact blocker/error
- one or two concrete next options
