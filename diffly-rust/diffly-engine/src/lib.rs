use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::{Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use csv::{Reader, ReaderBuilder};
use diffly_core::{diff_csv_files, DiffError, DiffOptions, HeaderMode};
use serde_json::{json, Map, Value};
use tempfile::TempDir;

pub trait EventSink {
    fn on_event(&mut self, event: &Value) -> Result<(), String>;
}

pub trait CancelCheck {
    fn cancelled(&self) -> bool;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    Diff(DiffError),
    Cancelled,
    Sink(String),
    Storage(String),
}

impl Display for EngineError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Diff(err) => write!(f, "{}", err.message),
            EngineError::Cancelled => write!(f, "Operation cancelled"),
            EngineError::Sink(msg) => write!(f, "Sink failed: {msg}"),
            EngineError::Storage(msg) => write!(f, "Storage failed: {msg}"),
        }
    }
}

impl std::error::Error for EngineError {}

pub struct NeverCancel;

impl CancelCheck for NeverCancel {
    fn cancelled(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone)]
pub struct EngineRunConfig {
    pub emit_progress: bool,
    pub progress_interval_events: usize,
}

impl Default for EngineRunConfig {
    fn default() -> Self {
        Self {
            emit_progress: false,
            progress_interval_events: 1000,
        }
    }
}

pub fn stable_key_hash(key_parts: &[String]) -> u64 {
    const FNV_OFFSET_BASIS: u64 = 14_695_981_039_346_656_037;
    const FNV_PRIME: u64 = 1_099_511_628_211;
    const KEY_DELIMITER: u8 = 0x1f;

    let mut hash = FNV_OFFSET_BASIS;
    for (idx, part) in key_parts.iter().enumerate() {
        for byte in part.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        if idx + 1 < key_parts.len() {
            hash ^= u64::from(KEY_DELIMITER);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    hash
}

pub fn partition_for_key(key_parts: &[String], partitions: usize) -> usize {
    let total_partitions = partitions.max(1);
    (stable_key_hash(key_parts) % total_partitions as u64) as usize
}

#[derive(Debug)]
pub struct TempDirSpill {
    root: TempDir,
    partitions: usize,
}

impl TempDirSpill {
    pub fn new(partitions: usize) -> Result<Self, EngineError> {
        if partitions == 0 {
            return Err(EngineError::Storage(
                "partitions must be greater than zero".to_string(),
            ));
        }
        let root = tempfile::tempdir().map_err(|err| EngineError::Storage(err.to_string()))?;
        Ok(Self { root, partitions })
    }

    pub fn partitions(&self) -> usize {
        self.partitions
    }

    pub fn root_path(&self) -> &Path {
        self.root.path()
    }

    fn validate(&self, side: &str, partition_id: usize) -> Result<(), EngineError> {
        if side != "a" && side != "b" {
            return Err(EngineError::Storage(format!("invalid side: {side}")));
        }
        if partition_id >= self.partitions {
            return Err(EngineError::Storage(format!(
                "partition out of range: {partition_id} (total {})",
                self.partitions
            )));
        }
        Ok(())
    }

    pub fn partition_path(
        &self,
        side: &str,
        partition_id: usize,
    ) -> Result<std::path::PathBuf, EngineError> {
        self.validate(side, partition_id)?;
        Ok(self
            .root
            .path()
            .join(format!("{side}_{partition_id}.jsonl")))
    }

    pub fn append_line(
        &self,
        side: &str,
        partition_id: usize,
        line: &str,
    ) -> Result<(), EngineError> {
        let path = self.partition_path(side, partition_id)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|err| {
                EngineError::Storage(format!("failed to open {}: {err}", path.display()))
            })?;
        writeln!(file, "{line}").map_err(|err| {
            EngineError::Storage(format!("failed to write {}: {err}", path.display()))
        })?;
        Ok(())
    }

    pub fn read_partition(&self, side: &str, partition_id: usize) -> Result<String, EngineError> {
        let path = self.partition_path(side, partition_id)?;
        fs::read_to_string(&path).map_err(|err| {
            EngineError::Storage(format!("failed to read {}: {err}", path.display()))
        })
    }
}

pub fn spill_json_record(
    spill: &TempDirSpill,
    side: &str,
    key_parts: &[String],
    row: &Value,
) -> Result<usize, EngineError> {
    let partition_id = partition_for_key(key_parts, spill.partitions());
    let encoded =
        serde_json::to_string(row).map_err(|err| EngineError::Storage(err.to_string()))?;
    spill.append_line(side, partition_id, &encoded)?;
    Ok(partition_id)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpillRecord {
    pub key: Vec<String>,
    pub row_index: usize,
    pub row: BTreeMap<String, String>,
}

pub fn read_spill_records(
    spill: &TempDirSpill,
    side: &str,
    partition_id: usize,
) -> Result<Vec<SpillRecord>, EngineError> {
    let path = spill.partition_path(side, partition_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = spill.read_partition(side, partition_id)?;
    let mut records: Vec<SpillRecord> = Vec::new();
    for (line_idx, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line).map_err(|err| {
            EngineError::Storage(format!(
                "failed to parse {} line {}: {err}",
                path.display(),
                line_idx + 1
            ))
        })?;
        let object = value.as_object().ok_or_else(|| {
            EngineError::Storage(format!(
                "invalid spill record in {} line {}: expected object",
                path.display(),
                line_idx + 1
            ))
        })?;

        let key = object
            .get("key")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                EngineError::Storage(format!(
                    "invalid spill record in {} line {}: missing key",
                    path.display(),
                    line_idx + 1
                ))
            })?
            .iter()
            .map(|item| {
                item.as_str().map(ToString::to_string).ok_or_else(|| {
                    EngineError::Storage(format!(
                        "invalid spill record in {} line {}: key entries must be strings",
                        path.display(),
                        line_idx + 1
                    ))
                })
            })
            .collect::<Result<Vec<String>, EngineError>>()?;

        let row_index = object
            .get("row_index")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                EngineError::Storage(format!(
                    "invalid spill record in {} line {}: missing row_index",
                    path.display(),
                    line_idx + 1
                ))
            })? as usize;

        let row_object = object
            .get("row")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                EngineError::Storage(format!(
                    "invalid spill record in {} line {}: missing row object",
                    path.display(),
                    line_idx + 1
                ))
            })?;

        let mut row = BTreeMap::new();
        for (column, value) in row_object {
            let string_value = value.as_str().ok_or_else(|| {
                EngineError::Storage(format!(
                    "invalid spill record in {} line {}: row values must be strings",
                    path.display(),
                    line_idx + 1
                ))
            })?;
            row.insert(column.clone(), string_value.to_string());
        }

        records.push(SpillRecord {
            key,
            row_index,
            row,
        });
    }

    Ok(records)
}

#[derive(Debug)]
pub struct PartitionManifest {
    pub spill: TempDirSpill,
    pub columns_a: Vec<String>,
    pub columns_b: Vec<String>,
    pub compare_columns: Vec<String>,
    pub row_count_a: usize,
    pub row_count_b: usize,
    pub partition_rows_a: Vec<usize>,
    pub partition_rows_b: Vec<usize>,
}

fn diff_error(code: &'static str, message: impl Into<String>) -> EngineError {
    EngineError::Diff(DiffError::new(code, message))
}

fn normalize_header(header: &mut [String]) {
    if let Some(first) = header.first_mut() {
        if let Some(stripped) = first.strip_prefix('\u{feff}') {
            *first = stripped.to_string();
        }
    }
}

fn validate_header(header: &[String], side: &str) -> Result<(), EngineError> {
    let mut seen = std::collections::HashSet::new();
    for name in header {
        if !seen.insert(name) {
            return Err(diff_error(
                "duplicate_column_name",
                format!("Duplicate column name in {side}: {name}"),
            ));
        }
    }
    Ok(())
}

fn open_csv_reader(path: &Path, side: &str) -> Result<Reader<std::fs::File>, EngineError> {
    ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_path(path)
        .map_err(|err| diff_error("csv_open_error", format!("Failed to open {side}: {err}")))
}

fn read_header(
    reader: &mut Reader<std::fs::File>,
    path: &Path,
    side: &str,
) -> Result<Vec<String>, EngineError> {
    let mut records = reader.records();
    let header_record = match records.next() {
        None => {
            return Err(diff_error(
                "empty_file",
                format!("{side} file is empty: {}", path.display()),
            ))
        }
        Some(result) => result.map_err(|err| {
            diff_error("csv_parse_error", format!("Failed to parse {side}: {err}"))
        })?,
    };

    let mut header: Vec<String> = header_record.iter().map(ToString::to_string).collect();
    normalize_header(&mut header);
    validate_header(&header, side)?;
    Ok(header)
}

fn comparison_columns(
    a_header: &[String],
    b_header: &[String],
    header_mode: HeaderMode,
) -> Result<Vec<String>, EngineError> {
    match header_mode {
        HeaderMode::Strict => {
            if a_header != b_header {
                return Err(diff_error(
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
                return Err(diff_error(
                    "header_mismatch",
                    format!("Header mismatch (sorted mode): A={a_header:?} B={b_header:?}"),
                ));
            }
            Ok(a_sorted)
        }
    }
}

fn key_indices(header: &[String], key_columns: &[String]) -> Result<Vec<usize>, EngineError> {
    key_columns
        .iter()
        .map(|key_column| {
            header
                .iter()
                .position(|col| col == key_column)
                .ok_or_else(|| {
                    diff_error(
                        "missing_key_column",
                        format!("Missing key column: {key_column}"),
                    )
                })
        })
        .collect()
}

fn record_to_json_object(header: &[String], record: &csv::StringRecord) -> Value {
    let mut map = Map::new();
    for (col, value) in header.iter().zip(record.iter()) {
        map.insert(col.clone(), Value::String(value.to_string()));
    }
    Value::Object(map)
}

fn partition_one_side(
    side_path: &Path,
    side_tag: &str,
    side_label: &str,
    header: &[String],
    key_columns: &[String],
    key_indexes: &[usize],
    spill: &TempDirSpill,
    partition_counts: &mut [usize],
) -> Result<usize, EngineError> {
    let width = header.len();
    let mut reader = open_csv_reader(side_path, side_label)?;
    let mut records = reader.records();

    // Header already validated in the preflight pass; consume it before streaming rows.
    let _ = records
        .next()
        .ok_or_else(|| {
            diff_error(
                "empty_file",
                format!("{side_label} file is empty: {}", side_path.display()),
            )
        })?
        .map_err(|err| {
            diff_error(
                "csv_parse_error",
                format!("Failed to parse {side_label}: {err}"),
            )
        })?;

    let mut row_count = 0usize;
    for (idx, result) in records.enumerate() {
        let row_index = idx + 2;
        let record = result.map_err(|err| {
            diff_error(
                "csv_parse_error",
                format!("Failed to parse {side_label} at CSV row {row_index}: {err}"),
            )
        })?;

        if record.len() != width {
            return Err(diff_error(
                "row_width_mismatch",
                format!(
                    "Row width mismatch in {side_label} at CSV row {row_index}: expected {width}, got {}",
                    record.len()
                ),
            ));
        }

        let mut key_parts: Vec<String> = Vec::with_capacity(key_indexes.len());
        for (key_idx, key_column) in key_indexes.iter().zip(key_columns.iter()) {
            let value = record.get(*key_idx).unwrap_or_default().to_string();
            if value.is_empty() {
                return Err(diff_error(
                    "missing_key_value",
                    format!(
                        "Missing key value in {side_label} at CSV row {row_index} for key column '{key_column}'"
                    ),
                ));
            }
            key_parts.push(value);
        }

        let row_value = record_to_json_object(header, &record);
        let envelope = json!({
            "key": key_parts.clone(),
            "row_index": row_index,
            "row": row_value
        });
        let partition_id = spill_json_record(spill, side_tag, &key_parts, &envelope)?;
        partition_counts[partition_id] += 1;
        row_count += 1;
    }

    Ok(row_count)
}

pub fn partition_inputs_to_spill(
    a_path: &Path,
    b_path: &Path,
    options: &DiffOptions,
    partitions: usize,
) -> Result<PartitionManifest, EngineError> {
    let mut a_reader = open_csv_reader(a_path, "A")?;
    let mut b_reader = open_csv_reader(b_path, "B")?;
    let columns_a = read_header(&mut a_reader, a_path, "A")?;
    let columns_b = read_header(&mut b_reader, b_path, "B")?;
    let compare_columns = comparison_columns(&columns_a, &columns_b, options.header_mode)?;

    let key_indices_a = key_indices(&columns_a, &options.key_columns)?;
    let key_indices_b = key_indices(&columns_b, &options.key_columns)?;

    let spill = TempDirSpill::new(partitions)?;
    let mut partition_rows_a = vec![0usize; spill.partitions()];
    let mut partition_rows_b = vec![0usize; spill.partitions()];

    let row_count_a = partition_one_side(
        a_path,
        "a",
        "A",
        &columns_a,
        &options.key_columns,
        &key_indices_a,
        &spill,
        &mut partition_rows_a,
    )?;
    let row_count_b = partition_one_side(
        b_path,
        "b",
        "B",
        &columns_b,
        &options.key_columns,
        &key_indices_b,
        &spill,
        &mut partition_rows_b,
    )?;

    Ok(PartitionManifest {
        spill,
        columns_a,
        columns_b,
        compare_columns,
        row_count_a,
        row_count_b,
        partition_rows_a,
        partition_rows_b,
    })
}

fn key_object(key_columns: &[String], key_values: &[String]) -> Value {
    let mut key = Map::new();
    for (idx, column) in key_columns.iter().enumerate() {
        key.insert(column.clone(), json!(key_values[idx]));
    }
    Value::Object(key)
}

fn row_to_value(row: &BTreeMap<String, String>) -> Value {
    let mut value = Map::new();
    for (key, val) in row {
        value.insert(key.clone(), Value::String(val.clone()));
    }
    Value::Object(value)
}

fn index_spill_records(
    records: Vec<SpillRecord>,
    key_columns: &[String],
    side: &str,
) -> Result<HashMap<Vec<String>, SpillRecord>, EngineError> {
    let mut indexed: HashMap<Vec<String>, SpillRecord> = HashMap::new();
    for record in records {
        if let Some(prior) = indexed.get(&record.key) {
            return Err(diff_error(
                "duplicate_key",
                format!(
                    "Duplicate key in {side}: {} (rows {} and {})",
                    key_object(key_columns, &record.key),
                    prior.row_index,
                    record.row_index
                ),
            ));
        }
        indexed.insert(record.key.clone(), record);
    }
    Ok(indexed)
}

pub fn diff_partitioned_from_manifest(
    manifest: &PartitionManifest,
    options: &DiffOptions,
) -> Result<Vec<Value>, EngineError> {
    let mut events: Vec<Value> = Vec::new();
    events.push(json!({
        "type": "schema",
        "columns_a": &manifest.columns_a,
        "columns_b": &manifest.columns_b
    }));

    let mut rows_total_compared = 0u64;
    let mut rows_added = 0u64;
    let mut rows_removed = 0u64;
    let mut rows_changed = 0u64;
    let mut rows_unchanged = 0u64;

    for partition_id in 0..manifest.spill.partitions() {
        let indexed_a = index_spill_records(
            read_spill_records(&manifest.spill, "a", partition_id)?,
            &options.key_columns,
            "A",
        )?;
        let indexed_b = index_spill_records(
            read_spill_records(&manifest.spill, "b", partition_id)?,
            &options.key_columns,
            "B",
        )?;

        let mut all_keys: Vec<Vec<String>> = indexed_a
            .keys()
            .chain(indexed_b.keys())
            .cloned()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        all_keys.sort();

        for key in all_keys {
            let key_obj = key_object(&options.key_columns, &key);
            let in_a = indexed_a.get(&key);
            let in_b = indexed_b.get(&key);

            match (in_a, in_b) {
                (None, Some(record_b)) => {
                    rows_added += 1;
                    events.push(json!({
                        "type": "added",
                        "key": key_obj,
                        "row": row_to_value(&record_b.row)
                    }));
                }
                (Some(record_a), None) => {
                    rows_removed += 1;
                    events.push(json!({
                        "type": "removed",
                        "key": key_obj,
                        "row": row_to_value(&record_a.row)
                    }));
                }
                (Some(record_a), Some(record_b)) => {
                    rows_total_compared += 1;
                    let changed_columns: Vec<String> = manifest
                        .compare_columns
                        .iter()
                        .filter(|column| record_a.row.get(*column) != record_b.row.get(*column))
                        .cloned()
                        .collect();

                    if changed_columns.is_empty() {
                        rows_unchanged += 1;
                        if options.emit_unchanged {
                            events.push(json!({
                                "type": "unchanged",
                                "key": key_obj,
                                "row": row_to_value(&record_a.row)
                            }));
                        }
                    } else {
                        rows_changed += 1;
                        let mut delta = Map::new();
                        for column in &changed_columns {
                            delta.insert(
                                column.clone(),
                                json!({
                                    "from": record_a.row.get(column).cloned().unwrap_or_default(),
                                    "to": record_b.row.get(column).cloned().unwrap_or_default()
                                }),
                            );
                        }

                        events.push(json!({
                            "type": "changed",
                            "key": key_obj,
                            "changed": changed_columns,
                            "before": row_to_value(&record_a.row),
                            "after": row_to_value(&record_b.row),
                            "delta": Value::Object(delta)
                        }));
                    }
                }
                (None, None) => {}
            }
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

fn emit_progress(
    sink: &mut dyn EventSink,
    events_done: usize,
    events_total: usize,
) -> Result<(), EngineError> {
    let progress = json!({
        "type": "progress",
        "phase": "emit_events",
        "events_done": events_done,
        "events_total": events_total
    });
    sink.on_event(&progress).map_err(EngineError::Sink)
}

pub fn run_keyed_to_sink(
    a_path: &Path,
    b_path: &Path,
    options: &DiffOptions,
    cancel_check: &dyn CancelCheck,
    sink: &mut dyn EventSink,
) -> Result<(), EngineError> {
    run_keyed_to_sink_with_config(
        a_path,
        b_path,
        options,
        &EngineRunConfig::default(),
        cancel_check,
        sink,
    )
}

pub fn run_keyed_to_sink_with_config(
    a_path: &Path,
    b_path: &Path,
    options: &DiffOptions,
    run_config: &EngineRunConfig,
    cancel_check: &dyn CancelCheck,
    sink: &mut dyn EventSink,
) -> Result<(), EngineError> {
    let events = diff_csv_files(a_path, b_path, options).map_err(EngineError::Diff)?;
    let total_events = events.len();
    let interval = run_config.progress_interval_events.max(1);

    if run_config.emit_progress {
        emit_progress(sink, 0, total_events)?;
    }

    for (idx, event) in events.into_iter().enumerate() {
        if cancel_check.cancelled() {
            return Err(EngineError::Cancelled);
        }
        sink.on_event(&event).map_err(EngineError::Sink)?;

        if run_config.emit_progress {
            let done = idx + 1;
            if done == total_events || done % interval == 0 {
                emit_progress(sink, done, total_events)?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct CollectSink {
        events: Vec<Value>,
    }

    impl EventSink for CollectSink {
        fn on_event(&mut self, event: &Value) -> Result<(), String> {
            self.events.push(event.clone());
            Ok(())
        }
    }

    fn temp_csv_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "diffly-engine-{name}-{}-{nanos}.csv",
            std::process::id()
        ))
    }

    fn write_csv(name: &str, content: &str) -> PathBuf {
        let path = temp_csv_path(name);
        fs::write(&path, content).expect("failed to write csv fixture");
        path
    }

    fn default_options() -> DiffOptions {
        DiffOptions {
            key_columns: vec!["id".to_string()],
            ..DiffOptions::default()
        }
    }

    #[test]
    fn emits_progress_frames_when_enabled() {
        let a = write_csv("progress-a", "id,name\n1,Alice\n");
        let b = write_csv("progress-b", "id,name\n1,Alicia\n2,Bob\n");

        let mut sink = CollectSink { events: Vec::new() };
        let run_config = EngineRunConfig {
            emit_progress: true,
            progress_interval_events: 1,
        };

        run_keyed_to_sink_with_config(
            &a,
            &b,
            &default_options(),
            &run_config,
            &NeverCancel,
            &mut sink,
        )
        .expect("engine run should succeed");

        let progress_events = sink
            .events
            .iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some("progress"))
            .count();
        assert!(
            progress_events >= 2,
            "expected at least start/end progress events"
        );
        assert_eq!(
            sink.events
                .first()
                .and_then(|event| event.get("type"))
                .and_then(Value::as_str),
            Some("progress")
        );

        let _ = fs::remove_file(a);
        let _ = fs::remove_file(b);
    }

    #[test]
    fn stable_key_hash_is_deterministic() {
        let key = vec!["123".to_string(), "eu".to_string()];
        assert_eq!(stable_key_hash(&key), 9_476_362_503_708_207_610);
        assert_eq!(partition_for_key(&key, 256), 250);
    }

    #[test]
    fn spills_records_into_partition_files() {
        let spill = TempDirSpill::new(8).expect("spill should initialize");
        let key = vec!["123".to_string(), "eu".to_string()];
        let partition = spill_json_record(
            &spill,
            "a",
            &key,
            &serde_json::json!({"id":"123","region":"eu"}),
        )
        .expect("spill should write row");

        let contents = spill
            .read_partition("a", partition)
            .expect("partition should be readable");
        assert!(contents.contains("\"id\":\"123\""));
        assert!(spill.root_path().exists());
    }

    #[test]
    fn partitions_inputs_to_spill_with_counts() {
        let a = write_csv("partition-a", "id,name\n1,Alice\n2,Bob\n");
        let b = write_csv("partition-b", "id,name\n1,Alicia\n3,Cara\n");

        let manifest = partition_inputs_to_spill(&a, &b, &default_options(), 4)
            .expect("partitioning should succeed");

        assert_eq!(
            manifest.columns_a,
            vec!["id".to_string(), "name".to_string()]
        );
        assert_eq!(
            manifest.columns_b,
            vec!["id".to_string(), "name".to_string()]
        );
        assert_eq!(
            manifest.compare_columns,
            vec!["id".to_string(), "name".to_string()]
        );
        assert_eq!(manifest.row_count_a, 2);
        assert_eq!(manifest.row_count_b, 2);
        assert_eq!(manifest.partition_rows_a.iter().sum::<usize>(), 2);
        assert_eq!(manifest.partition_rows_b.iter().sum::<usize>(), 2);

        let mut observed_records = 0usize;
        for partition_id in 0..manifest.spill.partitions() {
            if manifest.partition_rows_a[partition_id] > 0 {
                let records = read_spill_records(&manifest.spill, "a", partition_id)
                    .expect("partition A should be decodable");
                observed_records += records.len();
                for record in records {
                    assert!(!record.key.is_empty());
                    assert!(record.row_index >= 2);
                    assert!(record.row.contains_key("id"));
                }
            }
        }
        assert_eq!(observed_records, 2);

        let _ = fs::remove_file(a);
        let _ = fs::remove_file(b);
    }

    #[test]
    fn read_spill_records_missing_partition_returns_empty() {
        let spill = TempDirSpill::new(2).expect("spill should initialize");
        let records = read_spill_records(&spill, "a", 1).expect("read should succeed");
        assert!(records.is_empty());
    }

    #[test]
    fn partitioned_diff_emits_data_and_stats() {
        let a = write_csv("partitioned-diff-a", "id,name\n1,Alice\n2,Bob\n");
        let b = write_csv("partitioned-diff-b", "id,name\n1,Alicia\n3,Cara\n");

        let manifest = partition_inputs_to_spill(&a, &b, &default_options(), 4)
            .expect("partitioning should succeed");
        let events =
            diff_partitioned_from_manifest(&manifest, &default_options()).expect("diff succeeds");

        let types: Vec<&str> = events
            .iter()
            .filter_map(|event| event.get("type").and_then(Value::as_str))
            .collect();
        assert!(types.contains(&"schema"));
        assert!(types.contains(&"changed"));
        assert!(types.contains(&"added"));
        assert!(types.contains(&"removed"));
        assert_eq!(types.last(), Some(&"stats"));

        let stats = events.last().expect("stats should be present");
        assert_eq!(
            stats.get("rows_total_compared").and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(stats.get("rows_added").and_then(Value::as_u64), Some(1));
        assert_eq!(stats.get("rows_removed").and_then(Value::as_u64), Some(1));
        assert_eq!(stats.get("rows_changed").and_then(Value::as_u64), Some(1));

        let _ = fs::remove_file(a);
        let _ = fs::remove_file(b);
    }

    #[test]
    fn partitioned_diff_duplicate_key_preserves_row_indices() {
        let a = write_csv("partitioned-dup-a", "id,name\n1,Alice\n1,Alicia\n");
        let b = write_csv("partitioned-dup-b", "id,name\n1,Alice\n");

        let manifest = partition_inputs_to_spill(&a, &b, &default_options(), 4)
            .expect("partitioning should succeed");
        let err = diff_partitioned_from_manifest(&manifest, &default_options())
            .expect_err("duplicate key should fail");

        match err {
            EngineError::Diff(diff_err) => {
                assert_eq!(diff_err.code, "duplicate_key");
                assert!(diff_err.message.contains("rows 2 and 3"));
            }
            other => panic!("expected Diff error, got {other:?}"),
        }

        let _ = fs::remove_file(a);
        let _ = fs::remove_file(b);
    }

    #[test]
    fn partitioning_missing_key_value_is_hard_error() {
        let a = write_csv("partition-missing-key-a", "id,name\n,Blank\n");
        let b = write_csv("partition-missing-key-b", "id,name\n1,Alice\n");

        let err = partition_inputs_to_spill(&a, &b, &default_options(), 4)
            .expect_err("expected missing_key_value");

        match err {
            EngineError::Diff(diff_err) => assert_eq!(diff_err.code, "missing_key_value"),
            other => panic!("expected Diff error, got {other:?}"),
        }

        let _ = fs::remove_file(a);
        let _ = fs::remove_file(b);
    }
}
