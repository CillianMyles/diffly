# Manual Test Plan

Last updated: 2026-02-15

This plan is designed for learning and bug-hunting, not just pass/fail.

## 1) Goals

1. Verify semantic correctness against the fixture contract.
2. Verify phase-2 runtime behavior (partitioned engine path and fallback path).
3. Verify phase-3 CLI usability and output shapes.
4. Verify phase-4 web UX behavior (worker isolation, progress, cancel, engine routing, large-file survivability).
5. Capture regressions with reproducible evidence.

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

## 3) Canonical Fixture Spot Checks (Phase 1/2 semantics)

These checks teach semantics while confirming parity.

### 3.1 Success fixtures with expected summary

Run each command and confirm summary counts exactly.

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

3. Sorted header mode:
```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_header_sorted_mode_add/a.csv \
  B=diffly-spec/fixtures/keyed_header_sorted_mode_add/b.csv \
  KEY=id HEADER_MODE=sorted FORMAT=summary
```
Expected: `Compared=2 Added=1 Removed=0 Changed=0 Unchanged=2`

4. Empty string vs literal `null` are different:
```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_empty_vs_literal_null/a.csv \
  B=diffly-spec/fixtures/keyed_empty_vs_literal_null/b.csv \
  KEY=id FORMAT=summary
```
Expected: `Compared=2 Added=0 Removed=0 Changed=2 Unchanged=0`

### 3.2 Error fixtures (hard-error policy)

Run and confirm non-zero exit plus expected code/message class.

1. Duplicate column name:
```bash
make diff-rust \
  A=diffly-spec/fixtures/error_duplicate_column_name_in_a/a.csv \
  B=diffly-spec/fixtures/error_duplicate_column_name_in_a/b.csv \
  KEY=id
```
Expected error code class: `duplicate_column_name`

2. Missing key value:
```bash
make diff-rust \
  A=diffly-spec/fixtures/error_missing_key_value_in_a/a.csv \
  B=diffly-spec/fixtures/error_missing_key_value_in_a/b.csv \
  KEY=id
```
Expected error code class: `missing_key_value`

3. Row width mismatch:
```bash
make diff-rust \
  A=diffly-spec/fixtures/error_row_width_mismatch_in_b/a.csv \
  B=diffly-spec/fixtures/error_row_width_mismatch_in_b/b.csv \
  KEY=id
```
Expected error code class: `row_width_mismatch`

## 4) Phase 2 Runtime Checks (engine path behavior)

### 4.1 Partitioned vs non-partitioned parity

Use same input, compare outputs.

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
- `diff` shows no differences.

### 4.2 Progress event phases

```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  KEY=id EMIT_PROGRESS=1 FORMAT=jsonl
```

Expected:
- Progress events include `partitioning`, `diff_partitions`, `emit_events`.

## 5) Phase 3 CLI Checks

### 5.1 Output format behavior

1. `jsonl` default:
```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  KEY=id
```
Expected: one JSON object per line.

2. `json` array:
```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  KEY=id FORMAT=json
```
Expected: valid single JSON array output.

3. `summary` mode:
```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  KEY=id FORMAT=summary
```
Expected: readable summary table/lines only.

### 5.2 File output option

```bash
make diff-rust \
  A=diffly-spec/fixtures/keyed_basic_add_remove_change/a.csv \
  B=diffly-spec/fixtures/keyed_basic_add_remove_change/b.csv \
  KEY=id FORMAT=json OUT=/tmp/diff_output.json

ls -lh /tmp/diff_output.json
```

Expected:
- Output file exists and is non-empty.
- No JSON printed to stdout except command logging.

## 6) Phase 4 Web Manual Checks

Start app:
```bash
make web-dev
```
Open: [http://localhost:3000](http://localhost:3000)

### 6.1 Small-file engine routing

1. Load fixture `keyed_basic_add_remove_change` A/B in UI.
2. Keep `Prefer WASM for small files` checked.
3. Compare.

Expected:
- Completes quickly.
- `Engine: wasm` shown.
- Summary: `Compared=2 Added=1 Removed=1 Changed=1 Unchanged=1`.

Repeat with checkbox unchecked.

Expected:
- Completes quickly (no hang).
- `Engine: streaming_worker` shown.
- Same summary as above.

### 6.2 Header mode UX behavior

1. Use `keyed_header_sorted_mode_add` fixture.
2. Run once with `Header mode = strict`.

Expected:
- Error card appears with header mismatch.

3. Run again with `Header mode = sorted`.

Expected:
- Success summary: `Compared=2 Added=1 Removed=0 Changed=0 Unchanged=2`.

### 6.3 Error rendering behavior

Run these through UI and verify red error card text is clear and specific:

1. `error_missing_key_value_in_a`
2. `error_duplicate_column_name_in_a`
3. `error_row_width_mismatch_in_b`

Expected:
- Compare ends in error state.
- Error code class is reflected in message text.
- App remains interactive for next run.

### 6.4 Cancel behavior

1. Use generated large files from section 7.
2. Start compare.
3. Press `Cancel` during `partitioning`.

Expected:
- Run stops promptly.
- Error/terminal state indicates cancellation.
- Next compare can start immediately.

Repeat cancel during `diff_partitions`.

Expected:
- Same outcome.

### 6.5 Repeated-run stability

1. Alternate 10 runs between:
- tiny fixture
- medium fixture
- large generated files
2. Toggle WASM preference between runs.

Expected:
- No worker crash messages.
- No permanently stuck progress bars.
- Summary values remain deterministic for same inputs.

## 7) Large-file and Browser Survivability (Phase 4)

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

Web checks:

1. Compare these files with WASM checkbox enabled.

Expected:
- Engine should still show `streaming_worker` (files exceed small-file WASM threshold).
- Browser stays responsive while progress updates.

2. Compare with WASM checkbox disabled.

Expected:
- Also `streaming_worker`.
- No hang after partitioning.

3. During run, interact with page (scroll, edit key input, switch header mode before next run).

Expected:
- UI interaction remains responsive.

4. If storage pressure causes fallback, warning banner should appear.

Expected:
- Warning text mentions IndexedDB spill fallback.
- Run still completes unless real resource failure occurs.

Optional deeper check in browser devtools:
- Performance panel: no long main-thread blocks caused by compare work.
- Application panel: temporary IndexedDB entries created during run and cleaned afterward.

## 8) Cross-Engine Consistency Drill

Pick one fixture and one generated dataset.

For each dataset:
1. Run Rust CLI (`FORMAT=json`) and save output.
2. Run web compare and capture summary/samples screenshot.
3. Verify summary counts match CLI stats event.

Expected:
- Same high-level counts across engines.
- No semantic drift in add/remove/change categorization.

## 9) Regression List (must pass before merge/release)

1. Unchecked WASM path does not get stuck after `partitioning`.
2. Blank spacer lines do not trigger false `row_width_mismatch`.
3. Header `sorted` mode uses canonical comparison and does not false-fail.
4. Worker failures surface as explicit UI errors (not silent hangs).
5. Cancel works in both partitioning and diff phases.

## 10) Bug Report Template

For each failure, capture:

1. Environment:
- OS + browser version
- commit SHA

2. Inputs:
- file paths
- key columns
- header mode
- WASM preference state

3. Observed:
- exact UI/CLI error text
- screenshot (if UI)
- last visible progress phase

4. Expected:
- what should have happened

5. Repro:
- exact command or click path
- reproducibility frequency (always/intermittent)

## 11) Exit Criteria

Pass when all are true:

1. Preflight checks all pass.
2. Fixture spot checks match expected results exactly.
3. CLI formats and `--out` behavior are correct.
4. Web path passes small/large/cancel/error routing checks.
5. No hangs or worker crashes in repeated-run stability check.
