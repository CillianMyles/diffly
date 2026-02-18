# Decisions

This file records active product/engineering decisions that affect implementation semantics.

## 2026-02-14

### D-001 Duplicate column names

- Decision: treat duplicate header/column names as a hard error for now.
- Status: active.
- Rationale: avoids ambiguous field addressing and cross-language divergence.

### D-002 Header comparison behavior

- Decision: support strict existing header order by default, with optional sorted-header comparison mode.
- Status: active (implemented in Python reference).
- Rationale: strict mode is deterministic and simple; sorted mode may be useful later.

### D-003 Missing key values

- Decision: treat missing key values as a hard error for now.
- Status: active.
- Rationale: keyed identity must be explicit and stable.
- Current definition: an empty string (`""`) in any key column is considered missing.

### D-004 `unchanged` event emission

- Decision: omit `unchanged` row events by default.
- Status: active.
- Notes: keep unchanged counts in `stats`; row-level unchanged events can be enabled later if needed for rendering/progress UX.

### D-005 Compatibility policy

- Decision: breaking output/shape changes are allowed during early iteration before public stabilization.
- Status: active.
- Rationale: optimize for learning and fast iteration pre-v1.

### D-006 Git workflow policy (current)

- Decision: push directly to `main` for now using small logical conventional commits.
- Status: active (temporary).
- Rationale: fastest iteration in early-stage repository.

### D-007 Commit co-author trailer

- Decision: include this trailer in every commit message:
  - `Co-authored-by: Cillian Myles <myles.cillian@gmail.com>`
- Status: active.
- Source: project rules (`.rulesync/rules/general.md` and generated outputs).

### D-008 Python/Rust integration strategy (current)

- Decision: do not call Rust from Python via `pyo3` during Phase 2 startup.
- Status: active.
- Rationale: keep Python as independent semantic reference and validate Rust via shared fixtures/parity checks.

### D-009 UTF-8 BOM handling

- Decision: if a UTF-8 BOM is present at the start of the first header field, strip it before schema/key processing.
- Status: active (implemented in Python and Rust).
- Rationale: avoid false missing-key/header mismatches from BOM-prefixed header text.

### D-010 Malformed CSV parse strictness

- Decision: do not yet lock malformed CSV quoting behavior as a cross-runtime conformance requirement.
- Status: active (temporary).
- Rationale: Python and Rust parsers differ in strictness defaults; parity currently focuses on deterministic semantic outputs and explicit error codes already covered by fixtures.

### D-011 Rust layering direction

- Decision: introduce `diffly-engine` as a boundary above `diffly-core` and route runtime surfaces (CLI) through it.
- Status: active.
- Rationale: allows adding cancellation/progress/storage concerns without polluting pure semantic core logic.

### D-012 Progress event rollout

- Decision: engine-level progress events are opt-in for now (`--emit-progress` in Rust CLI).
- Status: active.
- Rationale: enables UX/progress work without breaking existing fixture expectations for default event streams.

### D-013 Partition hash stability

- Decision: use stable FNV-1a (64-bit) hashing of UTF-8 key parts with delimiter byte `0x1f` for partition assignment.
- Status: active.
- Rationale: deterministic partition mapping across runs/platforms is required before out-of-core partitioned execution.

### D-014 Spill backend bootstrap

- Decision: start with a tempdir-backed spill implementation in `diffly-engine` for partition file writing/reading.
- Status: active.
- Rationale: enables incremental out-of-core workflow development without locking in final storage backend APIs yet.

### D-015 Partition pass error parity

- Decision: `diffly-engine` partitioning preflight and streaming must preserve existing semantic error behavior (`header_mismatch`, `missing_key_column`, `missing_key_value`, duplicate columns, row width mismatch).
- Status: active.
- Rationale: out-of-core runtime work must not drift from phase-1 semantics while internals evolve.

### D-016 Spill record envelope

- Decision: partition spill files store structured JSON records with `{key, row_index, row}` instead of raw row objects.
- Status: active.
- Rationale: preserves source row references needed for duplicate-key diagnostics and partition-local join semantics.

### D-017 Partitioned event ordering

- Decision: partitioned execution emits row events in global key-sorted order (not partition bucket order).
- Status: active.
- Rationale: preserves fixture/conformance ordering parity while partition internals remain implementation detail.

### D-018 Partitioned runtime rollout mode

- Decision: partitioned execution is the default engine runtime path with `partition_count=64`, overridable via `--partitions`, with explicit fallback to core path via `--no-partitions`.
- Status: active.
- Rationale: conformance parity now holds in multi-partition mode, so defaulting to the engine path accelerates Phase 2 stabilization.

### D-019 Engine conformance gating

- Decision: add conformance coverage for the engine path using multi-partition mode (`DIFFLY_ENGINE_PARTITIONS=4`) while default conformance still targets `diffly-core`.
- Status: active.
- Rationale: validates engine wiring/behavior against fixtures across real partitioning paths before broader rollout.

### D-020 Cancellation semantics in partitioned path

- Decision: partitioned execution must check cancellation during both partition input pass and partition-local diff traversal, not only during final event emission.
- Status: active.
- Rationale: long-running out-of-core jobs need prompt cancel behavior across all phases for UX correctness.

### D-021 Progress phase framing

- Decision: in partitioned runtime mode, emit coarse progress phases in sequence: `partitioning`, `diff_partitions`, then `emit_events`.
- Status: active.
- Rationale: gives UIs/basic callers phase visibility now, while finer-grained byte/ETA progress can be added later.

## 2026-02-15

### D-022 Browser execution strategy (initial)

- Decision: web app runs compare logic in a dedicated worker and uses a dual-path runtime:
  - Rust/WASM path for smaller files
  - streaming worker fallback for larger files.
- Status: active.
- Rationale: preserves UI responsiveness and prevents `File.text()`-style whole-file buffering on large browser inputs.

### D-023 Browser result-shape bounds

- Decision: web UI renders bounded sample events + summary stats, not full-table materialization for entire inputs.
- Status: active.
- Rationale: avoids DOM/memory blowups on very large CSV comparisons while still surfacing useful inspection data.

### D-024 Rust CLI output modes

- Decision: Rust CLI supports three output modes:
  - `jsonl` (default, event stream)
  - `json` (single array)
  - `summary` (human-readable stats table)
- Status: active.
- Rationale: phase-3 CLI needs both machine-consumable and quick-human inspection workflows.

### D-025 Browser large-file spill strategy

- Decision: for large browser input sizes, prefer a partitioned IndexedDB spill path in the worker, with in-memory streaming fallback only when IndexedDB is unavailable.
- Status: active.
- Rationale: reduces peak memory pressure for large CSV comparisons and improves page survivability.

## 2026-02-18

### D-026 Compare mode selection UX

- Decision: default compare behavior is `positional`; keyed mode is enabled only when key columns are explicitly provided.
- Status: active.
- Rationale: makes zero-config CLI/web usage useful immediately, while preserving explicit keyed semantics via `--key`/`--compare-by-keys` (or equivalent UI input).

### D-027 Positional event identity

- Decision: positional row events use `row_index` for identity and do not emit `key`.
- Status: active.
- Rationale: positional comparisons have no stable key tuple; row index is the deterministic identity for adds/removes/changes.

### D-028 Ignore-row-order semantics

- Decision: `ignore_row_order` applies only to positional comparisons and uses multiset semantics.
- Status: active.
- Rationale: it cleanly represents unordered row comparison while keeping keyed and positional semantics explicit.
- Notes:
  - in this mode, `rows_changed` is always `0`
  - output row events are `added`/`removed` (plus optional `unchanged`), without `key` or `row_index`
  - combining keyed compare with `ignore_row_order` is an invalid option combination

## Update Protocol

When a new decision is made:

1. Add a new decision entry with date, status, rationale.
2. Update spec/docs/code to match.
3. If it changes instructions, update `.rulesync/rules/general.md` and run `make rules-generate`.
