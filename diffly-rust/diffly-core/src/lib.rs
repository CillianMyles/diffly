use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::io::Read;
use std::path::Path;

use csv::ReaderBuilder;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderMode {
    Strict,
    Sorted,
}

impl HeaderMode {
    pub fn parse(value: &str) -> Result<Self, DiffError> {
        match value {
            "strict" => Ok(Self::Strict),
            "sorted" => Ok(Self::Sorted),
            other => Err(DiffError::new(
                "invalid_header_mode",
                format!("Unsupported header_mode: {other}"),
            )),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DiffOptions {
    pub key_columns: Vec<String>,
    pub header_mode: HeaderMode,
    pub emit_unchanged: bool,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            key_columns: Vec::new(),
            header_mode: HeaderMode::Strict,
            emit_unchanged: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffError {
    pub code: &'static str,
    pub message: String,
}

impl DiffError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl Display for DiffError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl Error for DiffError {}

type Row = BTreeMap<String, String>;
type IndexedRow = (usize, Row);

fn validate_header(header: &[String], side: &str) -> Result<(), DiffError> {
    let mut seen = HashSet::new();
    for name in header {
        if !seen.insert(name) {
            return Err(DiffError::new(
                "duplicate_column_name",
                format!("Duplicate column name in {side}: {name}"),
            ));
        }
    }
    Ok(())
}

fn normalize_header(header: &mut [String]) {
    if let Some(first) = header.first_mut() {
        if let Some(stripped) = first.strip_prefix('\u{feff}') {
            *first = stripped.to_string();
        }
    }
}

fn read_csv_reader<R: Read>(
    reader: R,
    side: &str,
    source_label: &str,
) -> Result<(Vec<String>, Vec<IndexedRow>), DiffError> {
    let mut reader = ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(reader);

    let mut records = reader.records();
    let header_record = match records.next() {
        None => {
            return Err(DiffError::new(
                "empty_file",
                format!("{side} file is empty: {source_label}"),
            ))
        }
        Some(result) => result.map_err(|err| {
            DiffError::new("csv_parse_error", format!("Failed to parse {side}: {err}"))
        })?,
    };

    let mut header: Vec<String> = header_record.iter().map(ToString::to_string).collect();
    normalize_header(&mut header);
    validate_header(&header, side)?;

    let width = header.len();
    let mut rows: Vec<IndexedRow> = Vec::new();
    for (idx, result) in records.enumerate() {
        let row_index = idx + 2;
        let record = result.map_err(|err| {
            DiffError::new(
                "csv_parse_error",
                format!("Failed to parse {side} at CSV row {row_index}: {err}"),
            )
        })?;

        if record.len() != width {
            return Err(DiffError::new(
                "row_width_mismatch",
                format!(
                    "Row width mismatch in {side} at CSV row {row_index}: expected {width}, got {}",
                    record.len()
                ),
            ));
        }

        let mut row: Row = BTreeMap::new();
        for (key, value) in header.iter().zip(record.iter()) {
            row.insert(key.clone(), value.to_string());
        }
        rows.push((row_index, row));
    }

    Ok((header, rows))
}

fn read_csv(path: &Path, side: &str) -> Result<(Vec<String>, Vec<IndexedRow>), DiffError> {
    let file = std::fs::File::open(path)
        .map_err(|err| DiffError::new("csv_open_error", format!("Failed to open {side}: {err}")))?;
    read_csv_reader(file, side, &path.display().to_string())
}

fn comparison_columns(
    a_header: &[String],
    b_header: &[String],
    header_mode: HeaderMode,
) -> Result<Vec<String>, DiffError> {
    match header_mode {
        HeaderMode::Strict => {
            if a_header != b_header {
                return Err(DiffError::new(
                    "header_mismatch",
                    format!("Header mismatch: A={a_header:?} B={b_header:?}"),
                ));
            }
            Ok(a_header.to_vec())
        }
        HeaderMode::Sorted => {
            let mut a_sorted = a_header.to_vec();
            let mut b_sorted = b_header.to_vec();
            a_sorted.sort();
            b_sorted.sort();
            if a_sorted != b_sorted {
                return Err(DiffError::new(
                    "header_mismatch",
                    format!("Header mismatch (sorted mode): A={a_header:?} B={b_header:?}"),
                ));
            }
            Ok(a_sorted)
        }
    }
}

fn key_tuple(row: &Row, key_columns: &[String]) -> Vec<String> {
    key_columns
        .iter()
        .map(|column| row.get(column).cloned().unwrap_or_default())
        .collect()
}

fn key_object(key_columns: &[String], key_tuple_value: &[String]) -> Value {
    let mut key = Map::new();
    for (idx, column) in key_columns.iter().enumerate() {
        key.insert(column.clone(), json!(key_tuple_value[idx]));
    }
    Value::Object(key)
}

fn index_rows(
    rows: Vec<IndexedRow>,
    key_columns: &[String],
    side: &str,
) -> Result<HashMap<Vec<String>, IndexedRow>, DiffError> {
    let mut indexed: HashMap<Vec<String>, IndexedRow> = HashMap::new();
    for (row_index, row) in rows {
        for key_column in key_columns {
            let value = row.get(key_column).ok_or_else(|| {
                DiffError::new(
                    "missing_key_column",
                    format!("Missing key column: {key_column}"),
                )
            })?;
            if value.is_empty() {
                return Err(DiffError::new(
                    "missing_key_value",
                    format!(
                        "Missing key value in {side} at CSV row {row_index} for key column '{key_column}'"
                    ),
                ));
            }
        }

        let key = key_tuple(&row, key_columns);
        if let Some((prior_row, _)) = indexed.get(&key) {
            return Err(DiffError::new(
                "duplicate_key",
                format!(
                    "Duplicate key in {side}: {} (rows {} and {})",
                    key_object(key_columns, &key),
                    prior_row,
                    row_index
                ),
            ));
        }
        indexed.insert(key, (row_index, row));
    }
    Ok(indexed)
}

fn row_to_value(row: &Row) -> Value {
    let mut value = Map::new();
    for (key, val) in row {
        value.insert(key.clone(), Value::String(val.clone()));
    }
    Value::Object(value)
}

fn diff_rows_keyed(
    a_header: Vec<String>,
    a_rows: Vec<IndexedRow>,
    b_header: Vec<String>,
    b_rows: Vec<IndexedRow>,
    options: &DiffOptions,
) -> Result<Vec<Value>, DiffError> {
    let compare_columns = comparison_columns(&a_header, &b_header, options.header_mode)?;

    for key_column in &options.key_columns {
        if !a_header.contains(key_column) || !b_header.contains(key_column) {
            return Err(DiffError::new(
                "missing_key_column",
                format!("Missing key column: {key_column}"),
            ));
        }
    }

    let indexed_a = index_rows(a_rows, &options.key_columns, "A")?;
    let indexed_b = index_rows(b_rows, &options.key_columns, "B")?;

    let mut all_keys: Vec<Vec<String>> = indexed_a
        .keys()
        .chain(indexed_b.keys())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    all_keys.sort();

    let mut events: Vec<Value> = Vec::new();
    events.push(json!({
        "type": "schema",
        "columns_a": a_header,
        "columns_b": b_header
    }));

    let mut rows_total_compared = 0u64;
    let mut rows_added = 0u64;
    let mut rows_removed = 0u64;
    let mut rows_changed = 0u64;
    let mut rows_unchanged = 0u64;

    for key in all_keys {
        let key_obj = key_object(&options.key_columns, &key);
        let in_a = indexed_a.get(&key);
        let in_b = indexed_b.get(&key);

        match (in_a, in_b) {
            (None, Some((_, row_b))) => {
                rows_added += 1;
                events.push(json!({
                    "type": "added",
                    "key": key_obj,
                    "row": row_to_value(row_b)
                }));
            }
            (Some((_, row_a)), None) => {
                rows_removed += 1;
                events.push(json!({
                    "type": "removed",
                    "key": key_obj,
                    "row": row_to_value(row_a)
                }));
            }
            (Some((_, row_a)), Some((_, row_b))) => {
                rows_total_compared += 1;

                let changed_columns: Vec<String> = compare_columns
                    .iter()
                    .filter(|column| row_a.get(*column) != row_b.get(*column))
                    .cloned()
                    .collect();

                if changed_columns.is_empty() {
                    rows_unchanged += 1;
                    if options.emit_unchanged {
                        events.push(json!({
                            "type": "unchanged",
                            "key": key_obj,
                            "row": row_to_value(row_a)
                        }));
                    }
                } else {
                    rows_changed += 1;
                    let mut delta = Map::new();
                    for column in &changed_columns {
                        delta.insert(
                            column.clone(),
                            json!({
                                "from": row_a.get(column).cloned().unwrap_or_default(),
                                "to": row_b.get(column).cloned().unwrap_or_default()
                            }),
                        );
                    }

                    events.push(json!({
                        "type": "changed",
                        "key": key_obj,
                        "changed": changed_columns,
                        "before": row_to_value(row_a),
                        "after": row_to_value(row_b),
                        "delta": Value::Object(delta)
                    }));
                }
            }
            (None, None) => {}
        }
    }

    events.push(json!({
        "type": "stats",
        "rows_total_compared": rows_total_compared,
        "rows_added": rows_added,
        "rows_removed": rows_removed,
        "rows_changed": rows_changed,
        "rows_unchanged": rows_unchanged
    }));

    Ok(events)
}

fn diff_rows_positional(
    a_header: Vec<String>,
    a_rows: Vec<IndexedRow>,
    b_header: Vec<String>,
    b_rows: Vec<IndexedRow>,
    options: &DiffOptions,
) -> Result<Vec<Value>, DiffError> {
    let compare_columns = comparison_columns(&a_header, &b_header, options.header_mode)?;

    let mut events: Vec<Value> = Vec::new();
    events.push(json!({
        "type": "schema",
        "columns_a": a_header,
        "columns_b": b_header
    }));

    let mut rows_total_compared = 0u64;
    let mut rows_added = 0u64;
    let mut rows_removed = 0u64;
    let mut rows_changed = 0u64;
    let mut rows_unchanged = 0u64;

    let total_rows = a_rows.len().max(b_rows.len());
    for idx in 0..total_rows {
        let row_index = idx + 2;
        let in_a = a_rows.get(idx);
        let in_b = b_rows.get(idx);

        match (in_a, in_b) {
            (None, Some((_, row_b))) => {
                rows_added += 1;
                events.push(json!({
                    "type": "added",
                    "row_index": row_index,
                    "row": row_to_value(row_b)
                }));
            }
            (Some((_, row_a)), None) => {
                rows_removed += 1;
                events.push(json!({
                    "type": "removed",
                    "row_index": row_index,
                    "row": row_to_value(row_a)
                }));
            }
            (Some((_, row_a)), Some((_, row_b))) => {
                rows_total_compared += 1;
                let changed_columns: Vec<String> = compare_columns
                    .iter()
                    .filter(|column| row_a.get(*column) != row_b.get(*column))
                    .cloned()
                    .collect();

                if changed_columns.is_empty() {
                    rows_unchanged += 1;
                    if options.emit_unchanged {
                        events.push(json!({
                            "type": "unchanged",
                            "row_index": row_index,
                            "row": row_to_value(row_a)
                        }));
                    }
                } else {
                    rows_changed += 1;
                    let mut delta = Map::new();
                    for column in &changed_columns {
                        delta.insert(
                            column.clone(),
                            json!({
                                "from": row_a.get(column).cloned().unwrap_or_default(),
                                "to": row_b.get(column).cloned().unwrap_or_default()
                            }),
                        );
                    }
                    events.push(json!({
                        "type": "changed",
                        "row_index": row_index,
                        "changed": changed_columns,
                        "before": row_to_value(row_a),
                        "after": row_to_value(row_b),
                        "delta": Value::Object(delta)
                    }));
                }
            }
            (None, None) => {}
        }
    }

    events.push(json!({
        "type": "stats",
        "rows_total_compared": rows_total_compared,
        "rows_added": rows_added,
        "rows_removed": rows_removed,
        "rows_changed": rows_changed,
        "rows_unchanged": rows_unchanged
    }));

    Ok(events)
}

pub fn diff_csv_files(
    a_path: &Path,
    b_path: &Path,
    options: &DiffOptions,
) -> Result<Vec<Value>, DiffError> {
    let (a_header, a_rows) = read_csv(a_path, "A")?;
    let (b_header, b_rows) = read_csv(b_path, "B")?;
    if options.key_columns.is_empty() {
        diff_rows_positional(a_header, a_rows, b_header, b_rows, options)
    } else {
        diff_rows_keyed(a_header, a_rows, b_header, b_rows, options)
    }
}

pub fn diff_csv_bytes(
    a_bytes: &[u8],
    b_bytes: &[u8],
    options: &DiffOptions,
) -> Result<Vec<Value>, DiffError> {
    let (a_header, a_rows) = read_csv_reader(std::io::Cursor::new(a_bytes), "A", "<memory:a>")?;
    let (b_header, b_rows) = read_csv_reader(std::io::Cursor::new(b_bytes), "B", "<memory:b>")?;
    if options.key_columns.is_empty() {
        diff_rows_positional(a_header, a_rows, b_header, b_rows, options)
    } else {
        diff_rows_keyed(a_header, a_rows, b_header, b_rows, options)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_csv_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        std::env::temp_dir().join(format!("diffly-{name}-{}-{nanos}.csv", std::process::id()))
    }

    fn write_csv(name: &str, content: &str) -> PathBuf {
        let path = temp_csv_path(name);
        fs::write(&path, content).expect("failed to write csv fixture");
        path
    }

    fn default_options() -> DiffOptions {
        DiffOptions {
            key_columns: vec!["id".to_string()],
            header_mode: HeaderMode::Strict,
            emit_unchanged: false,
        }
    }

    fn positional_options() -> DiffOptions {
        DiffOptions {
            key_columns: Vec::new(),
            header_mode: HeaderMode::Strict,
            emit_unchanged: false,
        }
    }

    #[test]
    fn duplicate_column_name_is_hard_error() {
        let a = write_csv("dup-col-a", "id,id,name\n1,1,Alice\n");
        let b = write_csv("dup-col-b", "id,name\n1,Alice\n");

        let err =
            diff_csv_files(&a, &b, &default_options()).expect_err("expected duplicate_column_name");
        assert_eq!(err.code, "duplicate_column_name");

        let _ = fs::remove_file(a);
        let _ = fs::remove_file(b);
    }

    #[test]
    fn missing_key_value_is_hard_error() {
        let a = write_csv("missing-key-a", "id,name\n,Blank\n");
        let b = write_csv("missing-key-b", "id,name\n1,Alice\n");

        let err =
            diff_csv_files(&a, &b, &default_options()).expect_err("expected missing_key_value");
        assert_eq!(err.code, "missing_key_value");

        let _ = fs::remove_file(a);
        let _ = fs::remove_file(b);
    }

    #[test]
    fn events_are_emitted_in_sorted_key_order() {
        let a = write_csv("order-a", "id,name\n2,Bob\n1,Alice\n");
        let b = write_csv("order-b", "id,name\n1,Alicia\n3,Cara\n");

        let events = diff_csv_files(&a, &b, &default_options()).expect("diff should succeed");
        let types: Vec<String> = events
            .iter()
            .map(|event| {
                event
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("<missing>")
                    .to_string()
            })
            .collect();
        assert_eq!(
            types,
            vec!["schema", "changed", "removed", "added", "stats"]
        );

        let _ = fs::remove_file(a);
        let _ = fs::remove_file(b);
    }

    #[test]
    fn diff_csv_bytes_matches_file_mode() {
        let options = default_options();
        let a = b"id,name\n1,Alice\n2,Bob\n";
        let b = b"id,name\n1,Alicia\n3,Cara\n";

        let events = diff_csv_bytes(a, b, &options).expect("byte-mode diff should succeed");
        let types: Vec<String> = events
            .iter()
            .map(|event| {
                event
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("<missing>")
                    .to_string()
            })
            .collect();
        assert_eq!(
            types,
            vec!["schema", "changed", "removed", "added", "stats"]
        );
    }

    #[test]
    fn positional_mode_emits_row_indexed_events() {
        let a = write_csv("positional-a", "id,name\n1,Alice\n2,Bob\n3,Cara\n");
        let b = write_csv("positional-b", "id,name\n1,Alicia\n2,Bob\n4,Dan\n5,Eve\n");

        let events = diff_csv_files(&a, &b, &positional_options()).expect("diff should succeed");
        let changed = events
            .iter()
            .find(|event| event.get("type").and_then(Value::as_str) == Some("changed"))
            .expect("changed event should be present");
        assert_eq!(changed.get("row_index").and_then(Value::as_u64), Some(2));
        assert!(
            changed.get("key").is_none(),
            "positional events should not emit keys"
        );

        let added = events
            .iter()
            .find(|event| {
                event.get("type").and_then(Value::as_str) == Some("added")
                    && event.get("row_index").and_then(Value::as_u64) == Some(5)
            })
            .expect("added event for trailing row should be present");
        assert!(added.get("row").is_some());

        let _ = fs::remove_file(a);
        let _ = fs::remove_file(b);
    }
}
