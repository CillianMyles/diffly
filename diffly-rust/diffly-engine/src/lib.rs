use std::fmt::{Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use diffly_core::{diff_csv_files, DiffError, DiffOptions};
use serde_json::{json, Value};
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
}
