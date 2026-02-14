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

## Update Protocol

When a new decision is made:

1. Add a new decision entry with date, status, rationale.
2. Update spec/docs/code to match.
3. If it changes instructions, update `.rulesync/rules/general.md` and run `make rules-generate`.
