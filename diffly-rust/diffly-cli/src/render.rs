use serde_json::Value;

const ANSI_RESET: &str = "\x1b[0m";
const ANSI_RED: &str = "\x1b[31m";
const ANSI_GREEN: &str = "\x1b[32m";
const ANSI_RED_HEADER: &str = "\x1b[41;97;1m";
const ANSI_GREEN_HEADER: &str = "\x1b[42;30;1m";
const ANSI_RED_EMPHASIS: &str = "\x1b[31;1;4m";
const ANSI_GREEN_EMPHASIS: &str = "\x1b[32;1;4m";

#[derive(Clone, Copy)]
enum DiffSide {
    A,
    B,
}

pub fn build_diff_report(events: &[Value], use_color: bool) -> String {
    let mut changed_events: Vec<&Value> = Vec::new();
    let mut added_events: Vec<&Value> = Vec::new();
    let mut removed_events: Vec<&Value> = Vec::new();

    for event in events {
        match event.get("type").and_then(Value::as_str) {
            Some("changed") => changed_events.push(event),
            Some("added") => added_events.push(event),
            Some("removed") => removed_events.push(event),
            _ => {}
        }
    }

    let columns_a = schema_columns(events, "columns_a");
    let columns_b = schema_columns(events, "columns_b");
    let stats = stats_from_events(events);

    let rows_total_compared = stat_value(stats, "rows_total_compared");
    let rows_added = stat_value(stats, "rows_added");
    let rows_removed = stat_value(stats, "rows_removed");
    let rows_changed = stat_value(stats, "rows_changed");
    let rows_unchanged = stat_value(stats, "rows_unchanged");

    let mut lines = vec![
        "diffly diff".to_string(),
        "-----------".to_string(),
        format!(
            "columns_a: {}",
            join_or_unknown(&columns_a.iter().map(String::as_str).collect::<Vec<_>>())
        ),
        format!(
            "columns_b: {}",
            join_or_unknown(&columns_b.iter().map(String::as_str).collect::<Vec<_>>())
        ),
        String::new(),
        format!("rows_total_compared: {rows_total_compared}"),
        format!("rows_added:          {rows_added}"),
        format!("rows_removed:        {rows_removed}"),
        format!("rows_changed:        {rows_changed}"),
        format!("rows_unchanged:      {rows_unchanged}"),
    ];

    if changed_events.is_empty() && added_events.is_empty() && removed_events.is_empty() {
        lines.push(String::new());
        lines.push("No row-level differences.".to_string());
        return lines.join("\n");
    }

    if !changed_events.is_empty() {
        lines.push(String::new());
        lines.push(format!("Changed Rows ({})", changed_events.len()));
        lines.push("----------------".to_string());
        for event in changed_events {
            lines.extend(render_changed_event(event, use_color));
            lines.push(String::new());
        }
        lines.pop();
    }

    if !added_events.is_empty() {
        lines.push(String::new());
        lines.push(format!("Added Rows ({})", added_events.len()));
        lines.push("--------------".to_string());
        for event in added_events {
            lines.extend(render_row_block(
                event,
                "ADDED",
                &columns_b,
                '+',
                ANSI_GREEN_HEADER,
                ANSI_GREEN,
                use_color,
            ));
            lines.push(String::new());
        }
        lines.pop();
    }

    if !removed_events.is_empty() {
        lines.push(String::new());
        lines.push(format!("Removed Rows ({})", removed_events.len()));
        lines.push("----------------".to_string());
        for event in removed_events {
            lines.extend(render_row_block(
                event,
                "REMOVED",
                &columns_a,
                '-',
                ANSI_RED_HEADER,
                ANSI_RED,
                use_color,
            ));
            lines.push(String::new());
        }
        lines.pop();
    }

    if rows_unchanged > 0 {
        lines.push(String::new());
        lines.push(format!(
            "Unchanged rows omitted from detailed output: {rows_unchanged}"
        ));
    }

    lines.join("\n")
}

fn schema_columns(events: &[Value], key: &str) -> Vec<String> {
    let Some(schema) = events
        .iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("schema"))
    else {
        return Vec::new();
    };

    schema
        .get(key)
        .and_then(Value::as_array)
        .map(|columns| {
            columns
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn stats_from_events(events: &[Value]) -> Option<&Value> {
    events
        .iter()
        .rev()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("stats"))
}

fn stat_value(stats: Option<&Value>, key: &str) -> u64 {
    stats
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn join_or_unknown(values: &[&str]) -> String {
    if values.is_empty() {
        "<unknown>".to_string()
    } else {
        values.join(",")
    }
}

fn render_changed_event(event: &Value, use_color: bool) -> Vec<String> {
    let identity = render_identity(event);
    let changed_columns = changed_columns(event);
    let before = event.get("before");
    let after = event.get("after");
    let changed_label = if changed_columns.is_empty() {
        "changed: <unknown>".to_string()
    } else {
        format!("changed: {}", changed_columns.join(", "))
    };
    let heading = match identity.as_deref() {
        Some(identity) => format!("@@ {identity} | {changed_label}"),
        None => format!("@@ {changed_label}"),
    };

    let mut lines = vec![heading];
    lines.push(panel_title(
        "CHANGED",
        identity.as_deref(),
        Some(&changed_label),
        ANSI_GREEN_HEADER,
        use_color,
    ));

    for column in &changed_columns {
        let before_value = before.map(|row| row_value(row, column)).unwrap_or_default();
        let after_value = after.map(|row| row_value(row, column)).unwrap_or_default();
        lines.push(render_changed_column_heading(column, use_color));
        lines.push(render_changed_value_line(
            "A",
            &before_value,
            &after_value,
            DiffSide::A,
            use_color,
        ));
        lines.push(render_changed_value_line(
            "B",
            &before_value,
            &after_value,
            DiffSide::B,
            use_color,
        ));
    }

    lines
}

fn render_row_block(
    event: &Value,
    label: &str,
    columns: &[String],
    sign: char,
    header_style: &str,
    line_style: &str,
    use_color: bool,
) -> Vec<String> {
    let identity = render_identity(event);
    let mut lines = vec![panel_title(
        label,
        identity.as_deref(),
        None,
        header_style,
        use_color,
    )];
    let Some(row) = event.get("row") else {
        return lines;
    };

    let ordered_columns = row_columns(row, columns);
    for column in ordered_columns {
        let value = render_plain_value(&row_value(row, &column));
        lines.push(render_plain_field_line(
            sign, &column, &value, line_style, use_color,
        ));
    }

    lines
}

fn row_columns(row: &Value, preferred_order: &[String]) -> Vec<String> {
    if preferred_order.is_empty() {
        let Some(object) = row.as_object() else {
            return Vec::new();
        };
        return object.keys().cloned().collect();
    }

    preferred_order
        .iter()
        .filter(|column| row.get(column.as_str()).is_some())
        .cloned()
        .collect()
}

fn changed_columns(event: &Value) -> Vec<String> {
    if let Some(columns) = event.get("changed").and_then(Value::as_array) {
        return columns
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect();
    }

    let Some(delta) = event.get("delta").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut columns: Vec<String> = delta.keys().cloned().collect();
    columns.sort();
    columns
}

fn render_identity(event: &Value) -> Option<String> {
    if let Some(key) = event.get("key").and_then(Value::as_object) {
        let parts: Vec<String> = key
            .iter()
            .map(|(column, value)| format!("{column}={}", json_scalar(value)))
            .collect();
        return Some(format!("key: {}", parts.join(", ")));
    }

    event
        .get("row_index")
        .and_then(Value::as_u64)
        .map(|row_index| format!("row: {row_index}"))
}

fn panel_title(
    label: &str,
    identity: Option<&str>,
    extra: Option<&str>,
    style: &str,
    use_color: bool,
) -> String {
    let mut text = label.to_string();
    if let Some(identity) = identity {
        text.push(' ');
        text.push_str(identity);
    }
    if let Some(extra) = extra {
        text.push_str(" | ");
        text.push_str(extra);
    }

    if use_color {
        format!("{style} {text} {ANSI_RESET}")
    } else {
        format!("[{text}]")
    }
}

fn render_plain_field_line(
    sign: char,
    column: &str,
    value: &str,
    style: &str,
    use_color: bool,
) -> String {
    let prefix = format!("{sign} {column}: ");
    if use_color {
        format!(
            "{}{}",
            style_text(&prefix, style, use_color),
            style_text(value, style, use_color)
        )
    } else {
        format!("{prefix}{value}")
    }
}

fn render_changed_column_heading(column: &str, use_color: bool) -> String {
    if use_color {
        format!("  {column}")
    } else {
        format!("{column}:")
    }
}

fn render_changed_value_line(
    label: &str,
    before_value: &str,
    after_value: &str,
    side: DiffSide,
    use_color: bool,
) -> String {
    let prefix = format!("  {label}: ");
    let value = render_changed_value(before_value, after_value, side, use_color);

    if use_color {
        let prefix_style = match side {
            DiffSide::A => ANSI_RED,
            DiffSide::B => ANSI_GREEN,
        };
        format!(
            "{}{}{}",
            style_text(&prefix, prefix_style, use_color),
            value,
            ANSI_RESET
        )
    } else {
        format!("{prefix}{value}")
    }
}

fn render_changed_value(
    before_value: &str,
    after_value: &str,
    side: DiffSide,
    use_color: bool,
) -> String {
    let before_rendered = render_plain_value(before_value);
    let after_rendered = render_plain_value(after_value);
    let (before_prefix, before_mid, before_suffix, after_prefix, after_mid, after_suffix) =
        split_common_segments(&before_rendered, &after_rendered);

    let (prefix, middle, suffix, base_style, emphasis_style, marker) = match side {
        DiffSide::A => (
            before_prefix,
            before_mid,
            before_suffix,
            ANSI_RED,
            ANSI_RED_EMPHASIS,
            ("[-", "-]"),
        ),
        DiffSide::B => (
            after_prefix,
            after_mid,
            after_suffix,
            ANSI_GREEN,
            ANSI_GREEN_EMPHASIS,
            ("[+", "+]"),
        ),
    };

    if use_color {
        format!(
            "{}{}{}",
            style_text(&prefix, base_style, use_color),
            style_text(&middle, emphasis_style, use_color),
            style_text(&suffix, base_style, use_color),
        )
    } else if middle.is_empty() {
        format!("{prefix}{suffix}")
    } else {
        format!("{prefix}{}{middle}{}{suffix}", marker.0, marker.1)
    }
}

fn split_common_segments(
    before_value: &str,
    after_value: &str,
) -> (String, String, String, String, String, String) {
    let before_chars: Vec<char> = before_value.chars().collect();
    let after_chars: Vec<char> = after_value.chars().collect();

    let mut prefix_len = 0usize;
    while prefix_len < before_chars.len()
        && prefix_len < after_chars.len()
        && before_chars[prefix_len] == after_chars[prefix_len]
    {
        prefix_len += 1;
    }

    let mut suffix_len = 0usize;
    while suffix_len < (before_chars.len() - prefix_len)
        && suffix_len < (after_chars.len() - prefix_len)
        && before_chars[before_chars.len() - 1 - suffix_len]
            == after_chars[after_chars.len() - 1 - suffix_len]
    {
        suffix_len += 1;
    }

    let before_prefix: String = before_chars[..prefix_len].iter().collect();
    let before_middle: String = before_chars[prefix_len..before_chars.len() - suffix_len]
        .iter()
        .collect();
    let before_suffix: String = before_chars[before_chars.len() - suffix_len..]
        .iter()
        .collect();
    let after_prefix: String = after_chars[..prefix_len].iter().collect();
    let after_middle: String = after_chars[prefix_len..after_chars.len() - suffix_len]
        .iter()
        .collect();
    let after_suffix: String = after_chars[after_chars.len() - suffix_len..]
        .iter()
        .collect();

    (
        before_prefix,
        before_middle,
        before_suffix,
        after_prefix,
        after_middle,
        after_suffix,
    )
}

fn render_plain_value(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn row_value(row: &Value, column: &str) -> String {
    row.get(column)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_default()
}

fn json_scalar(value: &Value) -> String {
    match value {
        Value::String(text) => render_plain_value(text),
        other => other.to_string(),
    }
}

fn style_text(text: &str, style: &str, use_color: bool) -> String {
    if !use_color || text.is_empty() {
        return text.to_string();
    }
    format!("{style}{text}{ANSI_RESET}")
}

#[cfg(test)]
mod tests {
    use super::build_diff_report;
    use diffly_core::{diff_csv_bytes, DiffOptions, HeaderMode};

    #[test]
    fn diff_report_renders_changed_added_and_removed_sections() {
        let events = diff_csv_bytes(
            b"id,name,status\n1,Alice,active\n2,Bob,active\n3,Carol,pending\n",
            b"id,name,status\n1,Alice,active\n3,Caroline,pending\n4,Dan,active\n",
            &DiffOptions {
                key_columns: vec!["id".to_string()],
                header_mode: HeaderMode::Strict,
                emit_unchanged: false,
                ignore_row_order: false,
            },
        )
        .expect("diff should succeed");

        let rendered = build_diff_report(&events, false);

        assert!(rendered.contains("Changed Rows (1)"));
        assert!(rendered.contains("[CHANGED key: id=\"3\" | changed: name]"));
        assert!(rendered.contains("name:"));
        assert!(rendered.contains("  A: \"Carol\""));
        assert!(rendered.contains("  B: \"Carol[+ine+]\""));
        assert!(rendered.contains("Added Rows (1)"));
        assert!(rendered.contains("[ADDED key: id=\"4\"]"));
        assert!(rendered.contains("+ name: \"Dan\""));
        assert!(rendered.contains("Removed Rows (1)"));
        assert!(rendered.contains("[REMOVED key: id=\"2\"]"));
        assert!(rendered.contains("- name: \"Bob\""));
        assert!(rendered.contains("Unchanged rows omitted from detailed output: 1"));
    }

    #[test]
    fn diff_report_mentions_no_differences_when_only_stats_exist() {
        let events = diff_csv_bytes(
            b"id,name\n1,Alice\n",
            b"id,name\n1,Alice\n",
            &DiffOptions {
                key_columns: Vec::new(),
                header_mode: HeaderMode::Strict,
                emit_unchanged: false,
                ignore_row_order: false,
            },
        )
        .expect("diff should succeed");

        let rendered = build_diff_report(&events, false);
        assert!(rendered.contains("No row-level differences."));
        assert!(rendered.contains("rows_changed:        0"));
    }
}
