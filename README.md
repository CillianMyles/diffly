# diffly

**Diff CSVs at any size, locally, with progress — no server required.**

`diffly` is a CSV comparison toolkit designed around a single principle:

> **It should handle very large files without crashing, freezing the UI, or running out of memory — and it should always show progress.**

The end-state is:
- a **fast CLI** for local use,
- a **web app that runs entirely in the browser** (no backend),
- optional **desktop/mobile apps** using the same engine.

## Phase status

- Phase 1 (`diffly-python`): complete
- Phase 2 (`diffly-rust` engine): complete
- Phase 3 (`diffly-cli`): complete
- Phase 4 (`diffly-web`): MVP complete (worker + wasm + streaming fallback)

---

## Why diffly exists

Most CSV diff tools fall into one of two traps:

1. They load entire files into memory (fast for small files, but can crash on large ones).
2. They work line-by-line (bounded memory), but don’t support meaningful keyed diffs or rich change reporting.

`diffly` aims for:
- **bounded memory** (works out-of-core),
- **keyed comparisons** (join-like semantics),
- **streaming output** (doesn’t require holding results in RAM),
- **great UX** (progress, ETA, cancellation),
- **one core engine** reused by CLI + web + (optionally) desktop/mobile.

---

## Core idea: streaming + out-of-core diff engine

To support “any file size (eventually)” without killing browser tabs or machines, the diff algorithm is designed to be:

- **streaming**: never load the full CSV into memory
- **partitioned**: split inputs into manageable chunks
- **spilling to disk**: store intermediate partitions outside RAM

### External hash-join (partitioned diff)

When a comparison is keyed (user selects key columns):

#### Pass 1 — Partitioning
- Stream rows from CSV A and CSV B.
- Compute a stable `key` from configured key columns.
- Hash the key to choose a partition: `p = hash(key) % N`
- Write row records into partition files: `A_p` and `B_p`
- Emit progress based on bytes read / total bytes.

#### Pass 2 — Diff partitions one-by-one
For each partition `p`:
- Load `A_p` into a hash map keyed by `key` (bounded because partitions are small).
- Stream `B_p`:
  - if key not in map → **added**
  - if key in map:
    - compare rows → **unchanged** or **changed**
    - remove key from map
- leftover keys in map → **removed**
- Emit progress by partitions completed + bytes processed.

This keeps memory bounded. Performance comes from streaming IO and per-partition in-memory joins.

---

## UX requirements (non-negotiable)

diffly is built to be a good citizen on laptops **and** phones:

- ✅ Never block the UI (runs in workers / background threads)
- ✅ Show progress continuously (bytes processed, phase, partitions)
- ✅ Provide an ETA when possible (moving-average throughput)
- ✅ Support cancel (abort streams + cleanup)
- ✅ Fail gracefully if storage is insufficient (no crashes)

### Browser storage reality
“Any size” in-browser is limited by:
- device storage
- browser quota
- implementation differences (iOS Safari is often most restrictive)

diffly should:
- estimate required spill space,
- detect low space as best it can,
- stop early with a clear message when the device cannot support the job.

---

## Repo roadmap (phased plan)

The project is intended to be built in stages:

### Phase 1 — `diffly-python` (reference semantics + golden tests)
Goal: lock down **diff semantics** quickly.

- A reference implementation written in Python
- A **canonical diff output model**
- A suite of fixtures + golden outputs that define expected behavior:
  - quoting, escapes, newlines
  - header mismatch
  - missing columns
  - duplicate keys
  - type coercion rules (if any)
  - stable ordering rules for deterministic tests

> Important: Phase 1 is for semantics, not performance.  
> The design must still be compatible with streaming + out-of-core execution later.

### Phase 2 — `diffly-rust` (real engine)
Goal: build the production-grade engine with bounded memory.

- Rust crate(s) implementing the partitioned diff
- Storage backends abstracted behind traits:
  - native temp directory
  - browser OPFS / IndexedDB
- Progress reporting + cancel support built in

### Phase 3 — `diffly-cli`
Goal: a great local CLI built on the Rust engine.

- single binary distribution
- outputs:
  - JSON / JSONL for streaming consumption
  - optional human-readable summary tables
  - optional HTML report (later)

### Phase 4 — UI options
We will reuse the Rust engine in different environments.

#### Option (ii) — Rust → WASM + Web app (best fit for “no server”)
Goal: browser-only app for local comparisons.

- compile Rust core to WASM
- run in a Web Worker (never block UI thread)
- storage backend uses OPFS (preferred) or IndexedDB (fallback)
- React/TS/Next for UI (progress, results rendering)

#### Option (i) — Flutter desktop/mobile via Dart FFI
Goal: desktop/mobile apps using Flutter + Rust engine.

- Dart FFI wrapper around Rust native engine
- Flutter UI for desktop/mobile
- web may still use the React/WASM app (same engine, different UI)

---

## Canonical diff model (draft)

All implementations should be able to emit a consistent, streamable diff.

A suggested approach is JSON Lines (JSONL). The output stream may include both **data events** (added/removed/changed rows) and **meta events** (schema/progress/warnings/stats) so UIs can show summaries and progress without materializing the entire diff.

### Output stream event types (proposed)

Data events:
- `added`
- `removed`
- `changed`
- `unchanged` (optional / usually omitted for size)

Meta events:
- `schema`
- `progress`
- `warning`
- `stats` (summary frames; may be emitted periodically and/or at end)

### Row identity vs presentation

Events should distinguish:
- **row identity** (key columns, key values)
- **row location** (optional original row numbers in A and B)
- **row delta** (field-level differences suitable for “inspect” view)

### Example events

Schema event (early):
```json
{
  "type": "schema",
  "columns_a": ["id", "name", "status"],
  "columns_b": ["id", "name", "status"],
  "header_row_a": 1,
  "header_row_b": 1
}
```

Progress event (periodic):
```json
{
  "type": "progress",
  "phase": "partitioning",
  "bytes_read": 52428800,
  "bytes_total": 209715200,
  "partitions_total": 256,
  "partitions_done": 0,
  "throughput_bytes_per_sec": 18432000,
  "eta_seconds": 8.4
}
```

Changed event (row-level delta, optimized for inspection):
```json
{
  "type": "changed",
  "key": { "id": "123" },
  "loc": { "a_row": 1823, "b_row": 1840 },
  "changed": ["name"],
  "before": { "id": "123", "name": "Alice", "status": "active" },
  "after":  { "id": "123", "name": "Alicia", "status": "active" },
  "delta": {
    "name": { "from": "Alice", "to": "Alicia" }
  }
}
```

Added event:
```json
{
  "type": "added",
  "key": { "id": "999" },
  "loc": { "a_row": null, "b_row": 20491 },
  "row": { "id": "999", "name": "Zoe", "status": "active" }
}
```

Removed event:
```json
{
  "type": "removed",
  "key": { "id": "888" },
  "loc": { "a_row": 19910, "b_row": null },
  "row": { "id": "888", "name": "Sam", "status": "inactive" }
}
```

Duplicate key warning (important for keyed semantics):
```json
{
  "type": "warning",
  "code": "duplicate_key",
  "key": { "id": "123" },
  "count_a": 2,
  "count_b": 1,
  "a_rows": [10, 99],
  "b_rows": [12],
  "message": "Duplicate key encountered; diff semantics may be ambiguous for this key."
}
```

Stats frame (periodic or final, ideal for the “summary → map” UX):
```json
{
  "type": "stats",
  "rows_total_compared": 250000,
  "rows_added": 1203,
  "rows_removed": 17,
  "rows_changed": 84,
  "cells_changed": 9412,
  "changed_cells_by_column": {
    "price": 5120,
    "status": 820,
    "updated_at": 3200,
    "name": 272
  },
  "truncated": false
}
```

### Determinism and ordering rules

Because the engine may partition and spill to disk, output ordering must be explicitly defined for deterministic tests.

Suggested rule (v1):
- Emit results in **partition order** (`p = 0..N-1`).
- Within a partition, emit in a stable order (e.g. by key hash then key bytes).
- Include `partition_id` in progress frames (optional) to aid debugging.

---

## Diff modes (semantics)

diffly should explicitly support multiple comparison modes; `diffly-spec` will define expected output for each.

### `keyed` mode (default when key columns are provided)
- external hash-join semantics using key columns
- supports adds/removes/changes per key
- must define behavior for duplicate keys (warn/error/group)

### `positional` mode (no key columns, row order matters)
- compare row i in A to row i in B
- adds/removes reflect differing lengths

### `bag` mode (no key columns, ignore row order)
- treat each row as a value; compare as a multiset
- implementation may hash rows and compare counts
- emits adds/removes/changes at row-hash granularity (spec-defined)

---

## Monorepo layout (proposed)

```text
diffly/
  diffly-spec/        # fixtures + golden outputs + semantics docs
  diffly-python/      # reference implementation + runs spec tests
  diffly-rust/
    diffly-core/      # diff semantics + model types
    diffly-engine/    # partitioning + out-of-core algorithm
    diffly-native/    # native storage backend (tempdir)
    diffly-wasm/      # wasm bindings + OPFS/IDB backend
  diffly-cli/         # CLI wrapper using diffly-native
  diffly-web/         # React/Next UI that runs diffly-wasm in a worker
  diffly-dart/        # optional Dart FFI wrapper for diffly-native
```

---

## Design constraints / principles

- **Library-first**: core engine is reusable, CLI/UI are thin wrappers.
- **Deterministic**: stable ordering rules for outputs and testability.
- **Streaming everywhere**: parsing, partitioning, diffing, output.
- **Storage-pluggable**: same algorithm, different backends.
- **Progress as a first-class API**: every long operation reports state.
- **Cancellation**: must be supported for all long-running operations.

---

## Development status

This repo is early-stage and actively evolving.

### Current CLI (Phase 1 reference)

You can already run a keyed diff locally using the Python reference implementation:

```bash
make diff A=path/to/a.csv B=path/to/b.csv KEY=id
```

Composite keys are also supported via `make`:

```bash
make diff A=a.csv B=b.csv KEYS=id,region
```

For sorted-header comparison mode:

```bash
make diff A=a.csv B=b.csv KEY=id HEADER_MODE=sorted
```

For composite keys, call the script directly:

```bash
python3 diffly-python/diffly.py --a a.csv --b b.csv --key id --key region
```

The command emits JSONL events (`schema`, row events, `stats`) to stdout.
Current semantics are strict string comparison with hard errors for duplicate column names, missing key columns, and missing key values.

### Rust engine (Phase 2 complete)

Rust workspace now lives in `diffly-rust/` with:

- `diffly-core` (CSV diff semantics)
- `diffly-engine` (engine/runtime boundary with sink, cancel, progress, and partitioned spill utilities)
- `diffly-cli` (native CLI surface for keyed diff)
- `diffly-conformance` (runs `diffly-spec` fixtures)

Run Rust parity checks with:

```bash
make test-spec-rust
make test-spec-rust-engine PARTITIONS=4
```

Run the native Rust CLI via:

```bash
make diff-rust A=a.csv B=b.csv KEY=id
```

Progress events can be emitted with:

```bash
make diff-rust A=a.csv B=b.csv KEY=id EMIT_PROGRESS=1
```

In partitioned mode, progress phases currently emit as: `partitioning` -> `diff_partitions` -> `emit_events`.

### Rust CLI (Phase 3 complete)

Rust CLI supports multiple output modes now:

```bash
# default JSONL stream (event-per-line)
make diff-rust A=a.csv B=b.csv KEY=id

# single JSON array output
make diff-rust A=a.csv B=b.csv KEY=id FORMAT=json

# human-readable summary table
make diff-rust A=a.csv B=b.csv KEY=id FORMAT=summary

# write any mode to file
make diff-rust A=a.csv B=b.csv KEY=id FORMAT=json OUT=/tmp/diff.json
```

### Web app (Phase 4 MVP complete)

`diffly-web/` is now seeded from the DiffyData-style UX and wired to `diffly` runtime semantics:

- runs comparison in a dedicated Web Worker (main thread stays responsive)
- uses Rust/WASM path for small files
- uses partitioned IndexedDB spill path for larger files (and falls back to in-memory worker mode if IndexedDB is unavailable)
- supports cancel + phase progress frames in the UI

Install and run:

```bash
make web-install
make web-dev
```

Type-check/build:

```bash
make web-typecheck
npm --prefix diffly-web run build
```

Build/update Rust WASM package for web:

```bash
make wasm-build-web
```

Rust CLI now uses the partitioned engine path by default (64 partitions).
Override partition count with:

```bash
make diff-rust A=a.csv B=b.csv KEY=id PARTITIONS=64
```

Force the legacy non-partitioned core path (for debugging/comparison):

```bash
make diff-rust A=a.csv B=b.csv KEY=id NO_PARTITIONS=1
```

### CI checks

GitHub Actions now runs on pull requests and pushes to `main`:

- `make test-spec`
- `python -m compileall diffly-python`
- a fixture-backed CLI smoke test via `python diffly-python/diffly.py ...`
- Rust fmt check + `cargo test` + Rust fixture conformance (`make test-spec-rust`)
- Rust engine conformance parity mode (`make test-spec-rust-engine PARTITIONS=4`)
- Rust CLI smoke test via `make diff-rust ...`
- Rust partitioned CLI smoke test via `make diff-rust ... PARTITIONS=4`
- Web app typecheck/build (`make web-typecheck` + `npm --prefix diffly-web run build`)

### Project memory

To preserve execution context across sessions/agents:

- `docs/STATUS.md` tracks current progress, blockers, and next steps.
- `docs/DECISIONS.md` tracks active semantic/product decisions.
- `docs/HANDOFF.md` provides a quick resume checklist.

Next steps:
1. Add OPFS/IndexedDB spill backend integration for browser large-file path.
2. Add browser-level large-file regression automation (100MB+ behavior checks).
3. Continue expanding fixture coverage for CSV edge cases.
