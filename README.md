# diffly

**Diff CSVs at any size, locally, with progress — no server required.**

`diffly` is a CSV comparison toolkit designed around a single principle:

> **It should handle very large files without crashing, freezing the UI, or running out of memory — and it should always show progress.**

The end-state is:
- a **fast CLI** for local use,
- a **web app that runs entirely in the browser** (no backend),
- optional **desktop/mobile apps** using the same engine.

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

A suggested approach is JSON Lines (JSONL):

Each line is an event like:

- `added`
- `removed`
- `changed`
- `unchanged` (optional)

Example:

```json
{"type":"changed","key":{"id":"123"},"before":{"id":"123","name":"Alice"},"after":{"id":"123","name":"Alicia"},"diff":{"name":{"from":"Alice","to":"Alicia"}}}
```

The exact schema will be finalized in `diffly-spec`.

---

## Monorepo layout (proposed)

```
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

This repo is new and under active design.

Next steps:
1. Create `diffly-spec` with fixtures + golden outputs.
2. Implement `diffly-python` reference and validate behavior.
3. Mirror semantics in `diffly-rust` and keep all spec tests passing.
4. Add CLI wrapper and stabilize output formats.
5. Build WASM worker + web UI.

---

## License

TBD.
