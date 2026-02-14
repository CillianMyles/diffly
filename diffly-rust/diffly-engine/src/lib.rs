use std::fmt::{Display, Formatter};
use std::path::Path;

use diffly_core::{diff_csv_files, DiffError, DiffOptions};
use serde_json::Value;

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
}

impl Display for EngineError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Diff(err) => write!(f, "{}", err.message),
            EngineError::Cancelled => write!(f, "Operation cancelled"),
            EngineError::Sink(msg) => write!(f, "Sink failed: {msg}"),
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

pub fn run_keyed_to_sink(
    a_path: &Path,
    b_path: &Path,
    options: &DiffOptions,
    cancel_check: &dyn CancelCheck,
    sink: &mut dyn EventSink,
) -> Result<(), EngineError> {
    let events = diff_csv_files(a_path, b_path, options).map_err(EngineError::Diff)?;

    for event in events {
        if cancel_check.cancelled() {
            return Err(EngineError::Cancelled);
        }
        sink.on_event(&event).map_err(EngineError::Sink)?;
    }

    Ok(())
}
