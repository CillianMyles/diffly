use diffly_core::{diff_csv_bytes, DiffOptions, HeaderMode};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn diff_csv_bytes_json(
    a_bytes: &[u8],
    b_bytes: &[u8],
    key_columns_csv: &str,
    header_mode: &str,
    emit_unchanged: bool,
) -> Result<String, JsValue> {
    let key_columns: Vec<String> = key_columns_csv
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect();

    let header_mode =
        HeaderMode::parse(header_mode).map_err(|err| JsValue::from_str(&err.message))?;

    let options = DiffOptions {
        key_columns,
        header_mode,
        emit_unchanged,
        ignore_row_order: false,
    };

    let events = diff_csv_bytes(a_bytes, b_bytes, &options)
        .map_err(|err| JsValue::from_str(&format!("{}: {}", err.code, err.message)))?;

    serde_json::to_string(&events)
        .map_err(|err| JsValue::from_str(&format!("serialize_error: {err}")))
}
