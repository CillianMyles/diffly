# Manual Test Plan

Last updated: 2026-02-18

This plan is designed for learning and bug-hunting, not just pass/fail.

## 1) Goals

1. Verify semantic correctness against fixture contracts.
2. Verify runtime behavior for positional default and keyed opt-in.
3. Verify Rust engine partitioned behavior parity for keyed mode.
4. Verify CLI UX/output behavior for both modes.
5. Verify web UX behavior (worker isolation, progress, cancel, engine routing, large-file survivability).
6. Capture regressions with reproducible evidence.

## 2) Preflight (10-15 min)

Run from repo root: `/Users/dexter/git/github.com/CillianMyles/diffly`.

```bash
make test-spec
make test-spec-rust
make test-spec-rust-engine PARTITIONS=4
make web-typecheck
npm --prefix diffly-web run build
```

Expected:
- All commands succeed.
- No fixture failures.

If `cargo` is missing:
```bash
rustup default stable
```

If `wasm-pack` is missing:
```bash
cargo install wasm-pack
make wasm-build-web
```

## 3) Canonical Fixture Spot Checks

These checks confirm current semantics and expected summaries.

### 3.1 Positional default behavior

1. Positional add/change/unchanged:
```bash
make diff-rust \
  A=diffly-spec/fixtures/positional_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/positional_basic_add_remove_change/b.csv \
  FORMAT=summary
```
Expected: `Compared=3 Added=1 Removed=0 Changed=2 Unchanged=1`

2. Verify event identity uses `row_index` (no `key`):
```bash
make diff-rust \
  A=diffly-spec/fixtures/positional_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/positional_basic_add_remove_change/b.csv
```
Expected: `changed`/`added`/`removed` events include `row_index`; positional events do not include `key`.

### 3.2 Keyed behavior

1. Basic add/remove/change:
```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  KEY=id FORMAT=summary
```
Expected: `Compared=2 Added=1 Removed=1 Changed=1 Unchanged=1`

2. Multi-column key:
```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_multi_column_key/a.csv \
  B=diffly-spec/fixtures/keyed_multi_column_key/b.csv \
  KEYS=id,region FORMAT=summary
```
Expected: `Compared=2 Added=1 Removed=1 Changed=1 Unchanged=1`

3. Sorted header behavior:
```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_header_sorted_mode_add/a.csv \
  B=diffly-spec/fixtures/keyed_header_sorted_mode_add/b.csv \
  KEY=id HEADER_MODE=sorted FORMAT=summary
```
Expected: `Compared=2 Added=1 Removed=0 Changed=0 Unchanged=2`

### 3.3 Error fixtures

Run and confirm non-zero exit plus expected code class.

1. Duplicate column name:
```bash
make diff-rust \
  A=diffly-spec/fixtures/error_duplicate_column_name_in_a/a.csv \
  B=diffly-spec/fixtures/error_duplicate_column_name_in_a/b.csv \
  KEY=id
```
Expected code class: `duplicate_column_name`

2. Missing key value (keyed):
```bash
make diff-rust \
  A=diffly-spec/fixtures/error_missing_key_value_in_a/a.csv \
  B=diffly-spec/fixtures/error_missing_key_value_in_a/b.csv \
  KEY=id
```
Expected code class: `missing_key_value`

3. Row width mismatch:
```bash
make diff-rust \
  A=diffly-spec/fixtures/error_row_width_mismatch_in_b/a.csv \
  B=diffly-spec/fixtures/error_row_width_mismatch_in_b/b.csv
```
Expected code class: `row_width_mismatch`

## 4) Rust Runtime Checks (engine path behavior)

### 4.1 Keyed partitioned vs non-partitioned parity

```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  KEY=id FORMAT=json OUT=/tmp/diff_part.json PARTITIONS=8

make diff-rust \
  A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  KEY=id FORMAT=json OUT=/tmp/diff_core.json NO_PARTITIONS=1

diff -u /tmp/diff_part.json /tmp/diff_core.json
```

Expected:
- No diff.

### 4.2 Progress phases (keyed partitioned)

```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  KEY=id EMIT_PROGRESS=1
```

Expected:
- Progress phases include `partitioning`, `diff_partitions`, `emit_events`.

## 5) CLI Checks

### 5.1 Mode selection behavior

1. Positional default:
```bash
make diff-rust \
  A=diffly-spec/fixtures/positional_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/positional_basic_add_remove_change/b.csv
```
Expected: positional events with `row_index`.

2. Keyed via `KEY`:
```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  KEY=id
```
Expected: keyed events with `key`.

3. Keyed via `--compare-by-keys` direct CLI:
```bash
RUSTUP_BIN="$(command -v rustup || echo /opt/homebrew/opt/rustup/bin/rustup)" \
CARGO_BIN="$($RUSTUP_BIN which cargo 2>/dev/null)" \
"$CARGO_BIN" run --manifest-path diffly-rust/Cargo.toml -p diffly-cli -- \
  --a diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  --b diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  --compare-by-keys id
```
Expected: keyed events with `key`.

### 5.2 Output format behavior

1. `jsonl` default:
```bash
make diff-rust \
  A=diffly-spec/fixtures/positional_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/positional_basic_add_remove_change/b.csv
```
Expected: one JSON object per line.

2. `json` array:
```bash
make diff-rust \
  A=diffly-spec/fixtures/positional_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/positional_basic_add_remove_change/b.csv \
  FORMAT=json
```
Expected: valid JSON array.

3. `summary`:
```bash
make diff-rust \
  A=diffly-spec/fixtures/positional_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/positional_basic_add_remove_change/b.csv \
  FORMAT=summary
```
Expected: summary text only.

### 5.3 File output option

```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  KEY=id FORMAT=json OUT=/tmp/diff_output.json

ls -lh /tmp/diff_output.json
```

Expected:
- File exists and is non-empty.

## 6) Web Manual Checks

Start app:
```bash
make web-dev
```
Open: [http://localhost:3000](http://localhost:3000)

Current control surface (before ignore-row/ignore-column toggles):
- Compare by keys (checkbox)
- Key columns input (visible when keyed enabled)
- Header mode (`strict`/`sorted`)
- Prefer WASM for small files

### 6.1 Positional default flow

1. Load `positional_basic_add_remove_change` A/B.
2. Ensure `Compare by keys` is unchecked.
3. Compare.

Expected:
- Success.
- Summary: `Compared=3 Added=1 Removed=0 Changed=2 Unchanged=1`.
- Sample events show positional identity (`row_index=...`).

### 6.2 Keyed flow

1. Load `keyed_basic_add_remove_change` A/B.
2. Check `Compare by keys` and set `id`.
3. Compare.

Expected:
- Success.
- Summary: `Compared=2 Added=1 Removed=1 Changed=1 Unchanged=1`.
- Sample events show keyed identity (`{"id":"..."}`).

### 6.3 Header mode UX behavior

1. Use `keyed_header_sorted_mode_add` fixture with keyed `id`.
2. Run once with `Header mode = strict`.

Expected:
- Header mismatch error.

3. Run with `Header mode = sorted`.

Expected:
- Success summary: `Compared=2 Added=1 Removed=0 Changed=0 Unchanged=2`.

### 6.4 Error rendering behavior

Run these through UI and verify explicit error card text:

1. `error_missing_key_value_in_a` (with keyed enabled)
2. `error_duplicate_column_name_in_a`
3. `error_row_width_mismatch_in_b`

Expected:
- Compare ends in error state.
- App remains interactive for next run.

### 6.5 Cancel behavior

1. Use generated large files from section 7.
2. Start compare.
3. Press `Cancel` during `partitioning`.

Expected:
- Run stops promptly.
- Next compare can start immediately.

Repeat during `diff_partitions`.

Expected:
- Same outcome.

## 7) Large-file and Browser Survivability

Generate two large deterministic files (about 100MB each):

```bash
mkdir -p /tmp/diffly-manual
python3 - <<'PY'
from pathlib import Path

out_dir = Path('/tmp/diffly-manual')
out_dir.mkdir(parents=True, exist_ok=True)

rows = 2_000_000

def write_file(path: Path, mutate: bool):
    with path.open('w', encoding='utf-8', newline='') as f:
        f.write('id,region,name,status,amount,note\n')
        for i in range(rows):
            region = 'us' if i % 2 == 0 else 'eu'
            name = f'user_{i}'
            status = 'active' if i % 3 else 'inactive'
            amount = str((i * 7) % 100000)
            note = f'note_{i % 50}'
            if mutate and i % 200000 == 0:
                status = 'changed'
            if mutate and i % 500000 == 0:
                continue
            f.write(f'{i},{region},{name},{status},{amount},{note}\n')
        if mutate:
            for j in range(rows, rows + 10_000):
                f.write(f'{j},us,user_{j},active,1,note_new\n')

write_file(out_dir / 'a_100mb.csv', mutate=False)
write_file(out_dir / 'b_100mb.csv', mutate=True)
print('Generated:', out_dir / 'a_100mb.csv', out_dir / 'b_100mb.csv')
PY

ls -lh /tmp/diffly-manual/a_100mb.csv /tmp/diffly-manual/b_100mb.csv
```

Checks:

1. Compare with WASM preference enabled.
Expected: `Engine: streaming_worker` (size exceeds WASM threshold), responsive UI.

2. Compare with WASM preference disabled.
Expected: still `streaming_worker`, no hang.

3. Interact with page during run (scroll/type/toggle settings for next run).
Expected: UI remains responsive.

4. If storage fallback happens, warning banner appears.
Expected: warning text explains IndexedDB fallback path.

## 8) Cross-Engine Consistency Drill

Pick one keyed fixture and one positional fixture.

For each dataset:
1. Run Rust CLI (`FORMAT=json`) and save output.
2. Run web compare and capture summary/samples screenshot.
3. Verify summary counts match CLI `stats`.

Expected:
- Same high-level counts across engines.
- No semantic drift.

## 9) Regression List

1. Positional default works without keys in CLI and web.
2. Keyed mode still enforces duplicate/missing-key rules.
3. Unchecked WASM path does not get stuck after `partitioning`.
4. Header `sorted` mode behavior remains deterministic.
5. Worker failures surface as explicit UI errors.
6. Cancel works in partitioning and diff phases.

## 10) Bug Report Template

For each failure, capture:

1. Environment:
- OS + browser version
- commit SHA

2. Inputs:
- file paths
- whether keyed compare was enabled
- key columns (if keyed)
- header mode
- WASM preference

3. Observed:
- exact UI/CLI error text
- screenshot (if UI)
- last visible progress phase

4. Expected:
- what should have happened

5. Repro:
- exact command/click path
- reproducibility frequency

## 11) Exit Criteria

Pass when all are true:

1. Preflight checks pass.
2. Positional and keyed spot checks match expected results.
3. CLI formats and `--out` behavior are correct.
4. Web path passes small/large/cancel/error routing checks.
5. No hangs or worker crashes in repeated-run stability checks.
