use std::fs;
use std::path::{Path, PathBuf};

use diffly_core::{diff_csv_files, DiffError, DiffOptions, HeaderMode};
use serde_json::Value;

fn load_jsonl(path: &Path) -> Result<Vec<Value>, String> {
    let content = fs::read_to_string(path)
        .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
    let mut rows = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(trimmed)
            .map_err(|err| format!("failed to parse jsonl {}: {err}", path.display()))?;
        rows.push(value);
    }
    Ok(rows)
}

fn parse_options(config: &Value) -> Result<DiffOptions, DiffError> {
    let key_columns = config
        .get("key_columns")
        .and_then(Value::as_array)
        .ok_or_else(|| DiffError::new("invalid_config", "Fixture config missing key_columns"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(ToString::to_string)
                .ok_or_else(|| DiffError::new("invalid_config", "key_columns must be strings"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let header_mode = config
        .get("header_mode")
        .and_then(Value::as_str)
        .unwrap_or("strict");

    let emit_unchanged = config
        .get("emit_unchanged")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    Ok(DiffOptions {
        key_columns,
        header_mode: HeaderMode::parse(header_mode)?,
        emit_unchanged,
    })
}

fn run_case(case_dir: &Path) -> (bool, String) {
    let config_path = case_dir.join("config.json");
    if !config_path.exists() {
        return (true, "skipped (no config.json)".to_string());
    }

    let config_content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(err) => return (false, format!("failed to read config: {err}")),
    };

    let config: Value = match serde_json::from_str(&config_content) {
        Ok(value) => value,
        Err(err) => return (false, format!("failed to parse config: {err}")),
    };

    let mode = config.get("mode").and_then(Value::as_str).unwrap_or("");
    if mode != "keyed" {
        return (false, format!("unsupported mode in fixture: {mode}"));
    }

    let expected_jsonl = case_dir.join("expected.jsonl");
    let expected_error = case_dir.join("expected_error.json");

    if expected_jsonl.exists() == expected_error.exists() {
        return (
            false,
            "fixture must include exactly one of expected.jsonl or expected_error.json".to_string(),
        );
    }

    let actual = match parse_options(&config) {
        Ok(options) => diff_csv_files(&case_dir.join("a.csv"), &case_dir.join("b.csv"), &options),
        Err(err) => Err(err),
    };

    match actual {
        Err(err) => {
            if !expected_error.exists() {
                return (
                    false,
                    format!("unexpected DiffError({}): {}", err.code, err.message),
                );
            }

            let expected_content = match fs::read_to_string(&expected_error) {
                Ok(content) => content,
                Err(read_err) => {
                    return (
                        false,
                        format!("failed to read {}: {read_err}", expected_error.display()),
                    )
                }
            };

            let expected: Value = match serde_json::from_str(&expected_content) {
                Ok(value) => value,
                Err(parse_err) => {
                    return (
                        false,
                        format!("failed to parse {}: {parse_err}", expected_error.display()),
                    )
                }
            };

            let expected_code = expected.get("code").and_then(Value::as_str).unwrap_or("");
            if err.code != expected_code {
                return (
                    false,
                    format!(
                        "error code mismatch: got {}, expected {}",
                        err.code, expected_code
                    ),
                );
            }

            let needle = expected
                .get("message_contains")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !needle.is_empty() && !err.message.contains(needle) {
                return (
                    false,
                    format!(
                        "error message mismatch: expected to contain '{needle}', got '{}'",
                        err.message
                    ),
                );
            }

            (true, "ok".to_string())
        }
        Ok(events) => {
            if expected_error.exists() {
                return (false, "expected error but case succeeded".to_string());
            }

            let expected = match load_jsonl(&expected_jsonl) {
                Ok(rows) => rows,
                Err(err) => return (false, err),
            };

            if events != expected {
                return (
                    false,
                    format!(
                        "output mismatch\nactual:   {}\nexpected: {}",
                        serde_json::to_string_pretty(&events)
                            .unwrap_or_else(|_| "<serialize failed>".to_string()),
                        serde_json::to_string_pretty(&expected)
                            .unwrap_or_else(|_| "<serialize failed>".to_string())
                    ),
                );
            }

            (true, "ok".to_string())
        }
    }
}

fn repo_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .expect("failed to resolve repository root")
}

fn main() {
    let root = repo_root();
    let fixtures_root = root.join("diffly-spec").join("fixtures");

    let mut case_dirs: Vec<PathBuf> = fs::read_dir(&fixtures_root)
        .expect("failed to read fixtures directory")
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.is_dir())
        .collect();
    case_dirs.sort();
    let case_count = case_dirs.len();

    let mut failed = 0usize;
    for case_dir in case_dirs {
        let (ok, msg) = run_case(&case_dir);
        let status = if ok { "PASS" } else { "FAIL" };
        let name = case_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("<unknown>");
        println!("[{status}] {name}: {msg}");
        if !ok {
            failed += 1;
        }
    }

    if failed > 0 {
        eprintln!("\n{failed} fixture(s) failed");
        std::process::exit(1);
    }

    println!("\nAll fixtures passed ({case_count} cases)");
}
