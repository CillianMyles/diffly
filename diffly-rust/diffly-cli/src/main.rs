use std::env;
use std::io::{self, Write};
use std::path::Path;

use diffly_core::{DiffOptions, HeaderMode};
use diffly_engine::{
    run_keyed_to_sink_with_config, EngineError, EngineRunConfig, EventSink, NeverCancel,
};
use serde_json::json;

struct CliArgs {
    a_path: String,
    b_path: String,
    key_columns: Vec<String>,
    header_mode: HeaderMode,
    emit_unchanged: bool,
    emit_progress: bool,
    pretty: bool,
}

fn parse_args() -> Result<CliArgs, String> {
    let mut a_path: Option<String> = None;
    let mut b_path: Option<String> = None;
    let mut key_columns: Vec<String> = Vec::new();
    let mut header_mode = HeaderMode::Strict;
    let mut emit_unchanged = false;
    let mut emit_progress = false;
    let mut pretty = false;

    let args: Vec<String> = env::args().skip(1).collect();
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--a" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "--a requires a value".to_string())?;
                a_path = Some(value.clone());
            }
            "--b" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "--b requires a value".to_string())?;
                b_path = Some(value.clone());
            }
            "--key" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "--key requires a value".to_string())?;
                key_columns.push(value.clone());
            }
            "--header-mode" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "--header-mode requires a value".to_string())?;
                header_mode = HeaderMode::parse(value).map_err(|e| e.message)?;
            }
            "--emit-unchanged" => {
                emit_unchanged = true;
            }
            "--emit-progress" => {
                emit_progress = true;
            }
            "--pretty" => {
                pretty = true;
            }
            "-h" | "--help" => {
                return Err(help_text());
            }
            unknown => {
                return Err(format!("Unknown argument: {unknown}\n\n{}", help_text()));
            }
        }
        i += 1;
    }

    if key_columns.is_empty() {
        return Err(format!("At least one --key is required\n\n{}", help_text()));
    }

    Ok(CliArgs {
        a_path: a_path.ok_or_else(|| format!("--a is required\n\n{}", help_text()))?,
        b_path: b_path.ok_or_else(|| format!("--b is required\n\n{}", help_text()))?,
        key_columns,
        header_mode,
        emit_unchanged,
        emit_progress,
        pretty,
    })
}

fn help_text() -> String {
    [
        "Usage:",
        "  diffly-cli --a path/to/a.csv --b path/to/b.csv --key id [--key region]",
        "",
        "Options:",
        "  --a <path>                 Path to CSV A",
        "  --b <path>                 Path to CSV B",
        "  --key <column>             Key column (repeat for composite keys)",
        "  --header-mode <mode>       strict (default) | sorted",
        "  --emit-unchanged           Emit unchanged row events",
        "  --emit-progress            Emit progress events",
        "  --pretty                   Pretty-print JSON",
    ]
    .join("\n")
}

fn encode_json(value: &serde_json::Value, pretty: bool) -> String {
    if pretty {
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string())
    } else {
        serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
    }
}

struct StdoutSink {
    pretty: bool,
}

impl EventSink for StdoutSink {
    fn on_event(&mut self, event: &serde_json::Value) -> Result<(), String> {
        let mut out = io::stdout().lock();
        writeln!(out, "{}", encode_json(event, self.pretty)).map_err(|err| err.to_string())
    }
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };

    let options = DiffOptions {
        key_columns: args.key_columns,
        header_mode: args.header_mode,
        emit_unchanged: args.emit_unchanged,
    };
    let run_config = EngineRunConfig {
        emit_progress: args.emit_progress,
        ..EngineRunConfig::default()
    };

    let mut sink = StdoutSink {
        pretty: args.pretty,
    };

    match run_keyed_to_sink_with_config(
        Path::new(&args.a_path),
        Path::new(&args.b_path),
        &options,
        &run_config,
        &NeverCancel,
        &mut sink,
    ) {
        Ok(()) => {}
        Err(EngineError::Diff(err)) => {
            let error_event = json!({
                "type": "error",
                "code": err.code,
                "message": err.message,
            });
            eprintln!("{}", encode_json(&error_event, false));
            std::process::exit(2);
        }
        Err(EngineError::Cancelled) => {
            let error_event = json!({
                "type": "error",
                "code": "cancelled",
                "message": "Operation cancelled",
            });
            eprintln!("{}", encode_json(&error_event, false));
            std::process::exit(2);
        }
        Err(EngineError::Sink(message)) => {
            let error_event = json!({
                "type": "error",
                "code": "sink_error",
                "message": message,
            });
            eprintln!("{}", encode_json(&error_event, false));
            std::process::exit(2);
        }
    }
}
