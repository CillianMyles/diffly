use std::env;
use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

use diffly_core::{DiffOptions, HeaderMode};
use diffly_engine::{
    run_keyed_to_sink_with_config, EngineError, EngineRunConfig, EventSink, NeverCancel,
};
use serde_json::{json, Value};

#[derive(Clone, Copy)]
enum OutputFormat {
    Jsonl,
    Json,
    Summary,
}

impl OutputFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "jsonl" => Ok(Self::Jsonl),
            "json" => Ok(Self::Json),
            "summary" => Ok(Self::Summary),
            _ => Err(format!("Unsupported --format value: {value}")),
        }
    }
}

struct CliArgs {
    a_path: String,
    b_path: String,
    key_columns: Vec<String>,
    header_mode: HeaderMode,
    emit_unchanged: bool,
    emit_progress: bool,
    partition_count: Option<usize>,
    disable_partitions: bool,
    output_format: OutputFormat,
    output_path: Option<String>,
    pretty: bool,
    ignore_column_order: bool,
}

fn parse_key_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn parse_args() -> Result<CliArgs, String> {
    let mut a_path: Option<String> = None;
    let mut b_path: Option<String> = None;
    let mut key_columns: Vec<String> = Vec::new();
    let mut header_mode = HeaderMode::Strict;
    let mut emit_unchanged = false;
    let mut emit_progress = false;
    let mut partition_count: Option<usize> = None;
    let mut disable_partitions = false;
    let mut output_format = OutputFormat::Jsonl;
    let mut output_path: Option<String> = None;
    let mut pretty = false;
    let mut ignore_column_order = false;

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
            "--compare-by-keys" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "--compare-by-keys requires a value".to_string())?;
                key_columns.extend(parse_key_csv(value));
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
            "--partitions" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "--partitions requires a value".to_string())?;
                let parsed = value
                    .parse::<usize>()
                    .map_err(|_| "--partitions must be a positive integer".to_string())?;
                if parsed == 0 {
                    return Err("--partitions must be greater than zero".to_string());
                }
                partition_count = Some(parsed);
            }
            "--no-partitions" => {
                disable_partitions = true;
            }
            "--format" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "--format requires a value".to_string())?;
                output_format = OutputFormat::parse(value)?;
            }
            "--out" => {
                i += 1;
                let value = args
                    .get(i)
                    .ok_or_else(|| "--out requires a value".to_string())?;
                output_path = Some(value.clone());
            }
            "--pretty" => {
                pretty = true;
            }
            "--ignore-column-order" => {
                ignore_column_order = true;
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

    Ok(CliArgs {
        a_path: a_path.ok_or_else(|| format!("--a is required\n\n{}", help_text()))?,
        b_path: b_path.ok_or_else(|| format!("--b is required\n\n{}", help_text()))?,
        key_columns,
        header_mode,
        emit_unchanged,
        emit_progress,
        partition_count,
        disable_partitions,
        output_format,
        output_path,
        pretty,
        ignore_column_order,
    })
}

fn help_text() -> String {
    [
        "Usage:",
        "  diffly-cli --a path/to/a.csv --b path/to/b.csv [--key id --key region]",
        "",
        "Options:",
        "  --a <path>                 Path to CSV A",
        "  --b <path>                 Path to CSV B",
        "  (default compare mode is positional when no keys are provided)",
        "  --key <column>             Key column (repeat for keyed mode)",
        "  --compare-by-keys <list>   Comma-separated key columns (enables keyed mode)",
        "  --header-mode <mode>       strict (default) | sorted",
        "  --ignore-column-order      Alias for --header-mode sorted",
        "  --emit-unchanged           Emit unchanged row events",
        "  --emit-progress            Emit progress events",
        "  --partitions <n>           Override partition count for partitioned engine path",
        "  --no-partitions            Force non-partitioned core path",
        "  --format <mode>            jsonl (default) | json | summary",
        "  --out <path>               Write output to a file instead of stdout",
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

struct JsonlSink {
    writer: Box<dyn Write>,
    pretty: bool,
}

impl EventSink for JsonlSink {
    fn on_event(&mut self, event: &serde_json::Value) -> Result<(), String> {
        writeln!(self.writer, "{}", encode_json(event, self.pretty)).map_err(|err| err.to_string())
    }
}

struct CollectSink {
    events: Vec<Value>,
}

impl EventSink for CollectSink {
    fn on_event(&mut self, event: &Value) -> Result<(), String> {
        self.events.push(event.clone());
        Ok(())
    }
}

fn open_output_writer(path: Option<&str>) -> Result<Box<dyn Write>, String> {
    match path {
        Some(path) => File::create(path)
            .map(|file| Box::new(file) as Box<dyn Write>)
            .map_err(|err| format!("failed to open output file {path}: {err}")),
        None => Ok(Box::new(io::stdout())),
    }
}

fn write_output(path: Option<&str>, content: &str) -> Result<(), String> {
    let mut writer = open_output_writer(path)?;
    writer
        .write_all(content.as_bytes())
        .map_err(|err| format!("failed to write output: {err}"))?;
    writer
        .write_all(b"\n")
        .map_err(|err| format!("failed to finalize output: {err}"))
}

fn stats_from_events(events: &[Value]) -> Option<&Value> {
    events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("stats"))
}

fn columns_from_schema<'a>(events: &'a [Value], key: &str) -> Option<Vec<&'a str>> {
    let schema = events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("schema"))?;
    let columns = schema.get(key)?.as_array()?;
    Some(columns.iter().filter_map(Value::as_str).collect())
}

fn build_summary_report(events: &[Value]) -> String {
    let stats = stats_from_events(events);
    let columns_a = columns_from_schema(events, "columns_a").unwrap_or_default();
    let columns_b = columns_from_schema(events, "columns_b").unwrap_or_default();

    let rows_total_compared = stats
        .and_then(|v| v.get("rows_total_compared"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let rows_added = stats
        .and_then(|v| v.get("rows_added"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let rows_removed = stats
        .and_then(|v| v.get("rows_removed"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let rows_changed = stats
        .and_then(|v| v.get("rows_changed"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let rows_unchanged = stats
        .and_then(|v| v.get("rows_unchanged"))
        .and_then(Value::as_u64)
        .unwrap_or(0);

    [
        "diffly summary".to_string(),
        "-------------".to_string(),
        format!(
            "columns_a: {}",
            if columns_a.is_empty() {
                "<unknown>".to_string()
            } else {
                columns_a.join(",")
            }
        ),
        format!(
            "columns_b: {}",
            if columns_b.is_empty() {
                "<unknown>".to_string()
            } else {
                columns_b.join(",")
            }
        ),
        "".to_string(),
        format!("rows_total_compared: {rows_total_compared}"),
        format!("rows_added:          {rows_added}"),
        format!("rows_removed:        {rows_removed}"),
        format!("rows_changed:        {rows_changed}"),
        format!("rows_unchanged:      {rows_unchanged}"),
    ]
    .join("\n")
}

fn render_error_and_exit(error: EngineError) -> ! {
    match error {
        EngineError::Diff(err) => {
            let error_event = json!({
                "type": "error",
                "code": err.code,
                "message": err.message,
            });
            eprintln!("{}", encode_json(&error_event, false));
            std::process::exit(2);
        }
        EngineError::Cancelled => {
            let error_event = json!({
                "type": "error",
                "code": "cancelled",
                "message": "Operation cancelled",
            });
            eprintln!("{}", encode_json(&error_event, false));
            std::process::exit(2);
        }
        EngineError::Sink(message) => {
            let error_event = json!({
                "type": "error",
                "code": "sink_error",
                "message": message,
            });
            eprintln!("{}", encode_json(&error_event, false));
            std::process::exit(2);
        }
        EngineError::Storage(message) => {
            let error_event = json!({
                "type": "error",
                "code": "storage_error",
                "message": message,
            });
            eprintln!("{}", encode_json(&error_event, false));
            std::process::exit(2);
        }
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
        header_mode: if args.ignore_column_order {
            HeaderMode::Sorted
        } else {
            args.header_mode
        },
        emit_unchanged: args.emit_unchanged,
    };
    let mut run_config = EngineRunConfig::default();
    run_config.emit_progress = args.emit_progress;
    if args.disable_partitions {
        run_config.partition_count = None;
    } else if let Some(partition_count) = args.partition_count {
        run_config.partition_count = Some(partition_count);
    }

    match args.output_format {
        OutputFormat::Jsonl => {
            let writer =
                open_output_writer(args.output_path.as_deref()).unwrap_or_else(|message| {
                    eprintln!("{message}");
                    std::process::exit(2);
                });
            let mut sink = JsonlSink {
                writer,
                pretty: args.pretty,
            };
            if let Err(err) = run_keyed_to_sink_with_config(
                Path::new(&args.a_path),
                Path::new(&args.b_path),
                &options,
                &run_config,
                &NeverCancel,
                &mut sink,
            ) {
                render_error_and_exit(err);
            }
        }
        OutputFormat::Json | OutputFormat::Summary => {
            let mut sink = CollectSink { events: Vec::new() };
            if let Err(err) = run_keyed_to_sink_with_config(
                Path::new(&args.a_path),
                Path::new(&args.b_path),
                &options,
                &run_config,
                &NeverCancel,
                &mut sink,
            ) {
                render_error_and_exit(err);
            }

            let rendered = match args.output_format {
                OutputFormat::Json => encode_json(&Value::Array(sink.events), args.pretty),
                OutputFormat::Summary => build_summary_report(&sink.events),
                OutputFormat::Jsonl => unreachable!(),
            };
            if let Err(message) = write_output(args.output_path.as_deref(), &rendered) {
                eprintln!("{message}");
                std::process::exit(2);
            }
        }
    }
}
