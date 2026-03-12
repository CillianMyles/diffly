"use client";

import { DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, GitCompareArrows, Loader2, Upload, XCircle } from "lucide-react";
import type { HeaderMode, ResultMessage, RowData, SampleEvent, WorkerMessage } from "@/lib/protocol";

type CompareState = "idle" | "running" | "done" | "error";
type CompareStrategy = "positional" | "unordered" | "keyed";

const WASM_SMALL_FILE_THRESHOLD_BYTES = 16 * 1024 * 1024;
const MAX_INLINE_DIFF_MATRIX_CELLS = 16_000;
const INLINE_DIFF_MIN_TEXT_LENGTH = 24;

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function FilePicker({
  title,
  file,
  onPick,
  onClear,
}: {
  title: string;
  file: File | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);

  const isCsvFile = (candidate: File) => {
    const lower = candidate.name.toLowerCase();
    return candidate.type === "text/csv" || lower.endsWith(".csv");
  };

  const handleDrag = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "dragenter" || event.type === "dragover") {
      setIsDragging(true);
    } else if (event.type === "dragleave") {
      setIsDragging(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (!dropped) {
      return;
    }
    if (isCsvFile(dropped)) {
      onPick(dropped);
    }
  };

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 14,
        background: "var(--card)",
        padding: 16,
        boxShadow: "0 10px 35px rgba(0,0,0,0.05)",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 10 }}>{title}</div>
      {file ? (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 600 }}>{file.name}</div>
            <div style={{ color: "var(--muted)", fontSize: 13 }}>{formatBytes(file.size)}</div>
          </div>
          <button
            onClick={onClear}
            style={{ border: 0, background: "transparent", color: "var(--danger)", cursor: "pointer" }}
            aria-label="Clear selected file"
          >
            <XCircle size={20} />
          </button>
        </div>
      ) : (
        <label
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          style={{
            border: `1px dashed ${isDragging ? "var(--brand)" : "var(--border)"}`,
            borderRadius: 12,
            minHeight: 104,
            display: "grid",
            placeItems: "center",
            cursor: "pointer",
            color: "var(--muted)",
            padding: 14,
            textAlign: "center",
            background: isDragging ? "var(--brand-soft)" : "transparent",
            transition: "background 120ms linear, border-color 120ms linear",
          }}
        >
          <input
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={(event) => {
              const next = event.currentTarget.files?.[0] ?? null;
              if (next && isCsvFile(next)) {
                onPick(next);
              }
            }}
          />
          <div>
            <Upload size={20} style={{ margin: "0 auto 8px" }} />
            <div style={{ fontWeight: 600, color: "var(--text)" }}>Upload CSV</div>
            <div style={{ fontSize: 12 }}>Drag/drop or click</div>
          </div>
        </label>
      )}
    </div>
  );
}

type DiffSegment = {
  kind: "same" | "removed" | "added";
  value: string;
};

function sampleIdentity(sample: SampleEvent): string {
  if (sample.key) {
    return JSON.stringify(sample.key);
  }
  if (sample.rowIndex !== undefined) {
    return `row_index=${sample.rowIndex}`;
  }
  return "unordered row";
}

function orderedColumns(before?: RowData, after?: RowData): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];

  for (const row of [before, after]) {
    if (!row) {
      continue;
    }
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    }
  }

  return columns;
}

function looksTextLikeForInlineDiff(before: string, after: string): boolean {
  if (!before || !after || before === after) {
    return false;
  }

  if (before.includes("\n") || after.includes("\n")) {
    return true;
  }

  if (/\s/.test(before) || /\s/.test(after)) {
    return true;
  }

  return Math.max(before.length, after.length) >= INLINE_DIFF_MIN_TEXT_LENGTH;
}

function tokenizeForInlineDiff(value: string): string[] {
  const wordTokens = value.match(/\s+|[^\s]+/g);
  if (wordTokens && wordTokens.length > 1) {
    return wordTokens;
  }
  return Array.from(value);
}

function pushSegment(target: DiffSegment[], kind: DiffSegment["kind"], value: string) {
  if (!value) {
    return;
  }
  const prior = target[target.length - 1];
  if (prior && prior.kind === kind) {
    prior.value += value;
    return;
  }
  target.push({ kind, value });
}

function buildBoundarySegments(before: string, after: string): { beforeSegments: DiffSegment[]; afterSegments: DiffSegment[] } {
  const beforeChars = Array.from(before);
  const afterChars = Array.from(after);

  let prefix = 0;
  while (
    prefix < beforeChars.length &&
    prefix < afterChars.length &&
    beforeChars[prefix] === afterChars[prefix]
  ) {
    prefix += 1;
  }

  let beforeSuffix = beforeChars.length - 1;
  let afterSuffix = afterChars.length - 1;
  while (beforeSuffix >= prefix && afterSuffix >= prefix && beforeChars[beforeSuffix] === afterChars[afterSuffix]) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  const beforeSegments: DiffSegment[] = [];
  const afterSegments: DiffSegment[] = [];
  pushSegment(beforeSegments, "same", beforeChars.slice(0, prefix).join(""));
  pushSegment(afterSegments, "same", afterChars.slice(0, prefix).join(""));
  pushSegment(beforeSegments, "removed", beforeChars.slice(prefix, beforeSuffix + 1).join(""));
  pushSegment(afterSegments, "added", afterChars.slice(prefix, afterSuffix + 1).join(""));
  pushSegment(beforeSegments, "same", beforeChars.slice(beforeSuffix + 1).join(""));
  pushSegment(afterSegments, "same", afterChars.slice(afterSuffix + 1).join(""));
  return { beforeSegments, afterSegments };
}

function buildInlineDiff(before: string, after: string): { beforeSegments: DiffSegment[]; afterSegments: DiffSegment[] } {
  if (!looksTextLikeForInlineDiff(before, after)) {
    return {
      beforeSegments: [{ kind: "same", value: before }],
      afterSegments: [{ kind: "same", value: after }],
    };
  }

  const beforeTokens = tokenizeForInlineDiff(before);
  const afterTokens = tokenizeForInlineDiff(after);

  if (beforeTokens.length === 0 && afterTokens.length === 0) {
    return { beforeSegments: [], afterSegments: [] };
  }

  if (beforeTokens.length * afterTokens.length > MAX_INLINE_DIFF_MATRIX_CELLS) {
    return buildBoundarySegments(before, after);
  }

  const dp = Array.from({ length: beforeTokens.length + 1 }, () => new Uint16Array(afterTokens.length + 1));
  for (let i = 1; i <= beforeTokens.length; i += 1) {
    for (let j = 1; j <= afterTokens.length; j += 1) {
      if (beforeTokens[i - 1] === afterTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const ops: DiffSegment[] = [];
  let i = beforeTokens.length;
  let j = afterTokens.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeTokens[i - 1] === afterTokens[j - 1]) {
      ops.push({ kind: "same", value: beforeTokens[i - 1] });
      i -= 1;
      j -= 1;
      continue;
    }
    if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ kind: "added", value: afterTokens[j - 1] });
      j -= 1;
      continue;
    }
    ops.push({ kind: "removed", value: beforeTokens[i - 1] });
    i -= 1;
  }
  ops.reverse();

  const beforeSegments: DiffSegment[] = [];
  const afterSegments: DiffSegment[] = [];
  for (const op of ops) {
    if (op.kind === "same") {
      pushSegment(beforeSegments, "same", op.value);
      pushSegment(afterSegments, "same", op.value);
      continue;
    }
    if (op.kind === "removed") {
      pushSegment(beforeSegments, "removed", op.value);
      continue;
    }
    pushSegment(afterSegments, "added", op.value);
  }

  return { beforeSegments, afterSegments };
}

function tone(accent: "added" | "removed") {
  if (accent === "added") {
    return {
      badgeBg: "rgba(15, 118, 110, 0.12)",
      badgeText: "var(--ok)",
      panelBg: "var(--diff-added-bg)",
      panelBorder: "var(--diff-added-border)",
      changedFieldBg: "rgba(15, 118, 110, 0.16)",
      inlineBg: "rgba(15, 118, 110, 0.28)",
    };
  }

  return {
    badgeBg: "rgba(180, 35, 24, 0.10)",
    badgeText: "var(--danger)",
    panelBg: "var(--diff-removed-bg)",
    panelBorder: "var(--diff-removed-border)",
    changedFieldBg: "rgba(180, 35, 24, 0.14)",
    inlineBg: "rgba(180, 35, 24, 0.24)",
  };
}

function InlineValue({
  value,
  segments,
  accent,
}: {
  value: string;
  segments?: DiffSegment[];
  accent?: "added" | "removed";
}) {
  if (value === "") {
    return <span style={{ opacity: 0.55, fontStyle: "italic" }}>empty</span>;
  }

  const inlineBg = accent ? tone(accent).inlineBg : undefined;
  const renderedSegments = segments && segments.length > 0 ? segments : [{ kind: "same" as const, value }];
  return (
    <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {renderedSegments.map((segment, idx) => (
        <span
          key={idx}
          style={
            segment.kind === "same" || !accent
              ? undefined
              : {
                  background: inlineBg,
                  borderRadius: 4,
                  padding: "0 1px",
                }
          }
        >
          {segment.value}
        </span>
      ))}
    </span>
  );
}

function FieldList({
  title,
  accent,
  row,
  changedColumns,
  inlineSegments,
}: {
  title: string;
  accent: "added" | "removed";
  row?: RowData;
  changedColumns: Set<string>;
  inlineSegments?: Record<string, DiffSegment[]>;
}) {
  if (!row) {
    return null;
  }

  const colors = tone(accent);
  return (
    <div
      style={{
        border: `1px solid ${colors.panelBorder}`,
        borderRadius: 12,
        background: colors.panelBg,
        padding: 12,
        display: "grid",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          width: "fit-content",
          borderRadius: 999,
          background: colors.badgeBg,
          color: colors.badgeText,
          padding: "4px 10px",
          fontSize: 12,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        {title}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {orderedColumns(row).map((column) => {
          const isChanged = changedColumns.has(column);
          return (
            <div
              key={column}
              style={{
                borderRadius: 10,
                background: isChanged ? colors.changedFieldBg : "rgba(255,255,255,0.58)",
                padding: "10px 12px",
                display: "grid",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--muted)" }}>
                {column}
              </div>
              <div
                style={{
                  fontSize: 13,
                  lineHeight: 1.45,
                  fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
                }}
              >
                <InlineValue value={row[column] ?? ""} segments={inlineSegments?.[column]} accent={isChanged ? accent : undefined} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SampleRow({ sample }: { sample: SampleEvent }) {
  const identity = sampleIdentity(sample);
  const changedColumns = new Set(
    sample.type === "changed"
      ? sample.changed ?? Object.keys(sample.delta ?? {})
      : orderedColumns(sample.before, sample.after),
  );

  const beforeInlineSegments: Record<string, DiffSegment[]> = {};
  const afterInlineSegments: Record<string, DiffSegment[]> = {};
  if (sample.type === "changed") {
    for (const column of changedColumns) {
      const delta = sample.delta?.[column];
      const before = delta?.from ?? sample.before?.[column] ?? "";
      const after = delta?.to ?? sample.after?.[column] ?? "";
      const inline = buildInlineDiff(before, after);
      beforeInlineSegments[column] = inline.beforeSegments;
      afterInlineSegments[column] = inline.afterSegments;
    }
  }

  const badgeColors =
    sample.type === "added"
      ? tone("added")
      : sample.type === "removed"
        ? tone("removed")
        : undefined;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: 14,
        background: "#fff",
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong
          style={{
            textTransform: "uppercase",
            fontSize: 12,
            letterSpacing: 0.6,
            padding: "4px 10px",
            borderRadius: 999,
            background: badgeColors?.badgeBg ?? "rgba(180, 132, 28, 0.12)",
            color: badgeColors?.badgeText ?? "var(--brand)",
          }}
        >
          {sample.type}
        </strong>
        <code style={{ fontSize: 12 }}>{identity}</code>
      </div>

      {sample.type === "changed" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
          <FieldList
            title="Before"
            accent="removed"
            row={sample.before}
            changedColumns={changedColumns}
            inlineSegments={beforeInlineSegments}
          />
          <FieldList
            title="After"
            accent="added"
            row={sample.after}
            changedColumns={changedColumns}
            inlineSegments={afterInlineSegments}
          />
        </div>
      ) : (
        <FieldList
          title={sample.type === "added" ? "Added row" : "Removed row"}
          accent={sample.type === "added" ? "added" : "removed"}
          row={sample.after ?? sample.before}
          changedColumns={changedColumns}
        />
      )}
    </div>
  );
}

export function DiffWorkbench() {
  const workerRef = useRef<Worker | null>(null);
  const currentRequestIdRef = useRef<string | null>(null);

  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [compareStrategy, setCompareStrategy] = useState<CompareStrategy>("positional");
  const [keyColumnsInput, setKeyColumnsInput] = useState("id");
  const [ignoreColumnOrder, setIgnoreColumnOrder] = useState(false);
  const [preferWasm, setPreferWasm] = useState(true);

  const [state, setState] = useState<CompareState>("idle");
  const [progress, setProgress] = useState({ phase: "prepare", done: 0, total: 1, message: "" });
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [engineUsed, setEngineUsed] = useState<string | null>(null);
  const [summary, setSummary] = useState<ResultMessage["summary"] | null>(null);
  const [samples, setSamples] = useState<SampleEvent[]>([]);

  useEffect(() => {
    const worker = new Worker(new URL("../workers/diff.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (!currentRequestIdRef.current || message.requestId !== currentRequestIdRef.current) {
        return;
      }

      if (message.type === "progress") {
        setProgress({
          phase: message.phase,
          done: message.done,
          total: message.total,
          message: message.message ?? "",
        });
        return;
      }

      if (message.type === "error") {
        setState("error");
        setError(message.message);
        return;
      }

      setState("done");
      setError(null);
      setWarning(message.warning ?? null);
      setEngineUsed(message.engine);
      setSummary(message.summary);
      setSamples(message.samples);
    };

    worker.onerror = (event) => {
      setState("error");
      setError(`Worker crashed: ${event.message}`);
    };

    worker.onmessageerror = () => {
      setState("error");
      setError("Worker message deserialization failed.");
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const keyColumns = useMemo(
    () =>
      keyColumnsInput
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    [keyColumnsInput],
  );

  const progressRatio = useMemo(() => {
    if (progress.total <= 0) {
      return 0;
    }
    return Math.min(1, progress.done / progress.total);
  }, [progress]);

  const compare = () => {
    if (!workerRef.current || !fileA || !fileB) {
      return;
    }
    if (compareStrategy === "keyed" && keyColumns.length === 0) {
      setState("error");
      setError("At least one key column is required.");
      return;
    }

    const requestId = crypto.randomUUID();
    currentRequestIdRef.current = requestId;
    setState("running");
    setError(null);
    setWarning(null);
    setSummary(null);
    setSamples([]);
    setEngineUsed(null);

    workerRef.current.postMessage({
      type: "compare",
      requestId,
      aFile: fileA,
      bFile: fileB,
      keyColumns: compareStrategy === "keyed" ? keyColumns : [],
      ignoreRowOrder: compareStrategy === "unordered",
      headerMode: (ignoreColumnOrder ? "sorted" : "strict") as HeaderMode,
      emitUnchanged: false,
      maxSampleEvents: 30,
      preferWasm,
      smallFileThresholdBytes: WASM_SMALL_FILE_THRESHOLD_BYTES,
    });
  };

  const cancel = () => {
    const requestId = currentRequestIdRef.current;
    if (!workerRef.current || !requestId) {
      return;
    }
    workerRef.current.postMessage({ type: "cancel", requestId });
  };

  return (
    <section style={{ display: "grid", gap: 20 }}>
      <div style={{ display: "grid", gap: 14 }}>
        <h1 style={{ margin: 0, fontSize: 36, letterSpacing: -0.8 }}>Comapre CSV Files</h1>
        <p style={{ margin: 0, color: "var(--muted)", maxWidth: 760 }}>
          Performant local CSV diffing, in your browser, powered by Rust WASM and web workers.
          No server required. No data leaves your machine. It will not crash your tab, browser, or machine.
          It just works.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
        <FilePicker title="File A" file={fileA} onPick={setFileA} onClear={() => setFileA(null)} />
        <FilePicker title="File B" file={fileB} onPick={setFileB} onClear={() => setFileB(null)} />
      </div>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 14,
          background: "var(--card)",
          padding: 16,
          display: "grid",
          gap: 12,
        }}
      >
        <label style={{ display: "grid", gap: 8 }}>
          <span style={{ fontWeight: 600 }}>Compare strategy</span>
          <select
            value={compareStrategy}
            onChange={(event) => setCompareStrategy(event.currentTarget.value as CompareStrategy)}
            style={{ borderRadius: 8, border: "1px solid var(--border)", padding: "8px 10px", font: "inherit" }}
          >
            <option value="positional">Rows must be in the same order</option>
            <option value="unordered">Rows can be in any order</option>
            <option value="keyed">Compare rows that have the same key</option>
          </select>
        </label>

        {compareStrategy === "keyed" ? (
          <div style={{ display: "grid", gap: 8 }}>
            <label htmlFor="keys" style={{ fontWeight: 600 }}>
              Key columns (comma-separated)
            </label>
            <input
              id="keys"
              value={keyColumnsInput}
              onChange={(event) => setKeyColumnsInput(event.currentTarget.value)}
              placeholder="id,region"
              style={{
                width: "100%",
                borderRadius: 10,
                border: "1px solid var(--border)",
                padding: "10px 12px",
                font: "inherit",
              }}
            />
          </div>
        ) : null}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={ignoreColumnOrder}
              onChange={(event) => setIgnoreColumnOrder(event.currentTarget.checked)}
            />
            Ignore column order
          </label>

          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={preferWasm} onChange={(event) => setPreferWasm(event.currentTarget.checked)} />
            Prefer WASM for small files ({"<="} {formatBytes(WASM_SMALL_FILE_THRESHOLD_BYTES)})
          </label>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <button
            onClick={compare}
            disabled={!fileA || !fileB || state === "running"}
            style={{
              border: 0,
              borderRadius: 10,
              background: "var(--brand)",
              color: "white",
              padding: "10px 16px",
              fontWeight: 700,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {state === "running" ? <Loader2 size={16} className="spin" /> : <GitCompareArrows size={16} />}
            {state === "running" ? "Comparing..." : "Compare"}
          </button>

          {state === "running" ? (
            <button
              onClick={cancel}
              style={{
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "white",
                color: "var(--text)",
                padding: "10px 16px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      {state === "running" || state === "done" ? (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 14,
            background: "var(--card)",
            padding: 16,
            display: "grid",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14 }}>
            <strong>Phase: {progress.phase}</strong>
            <span>
              {progress.done} / {progress.total}
            </span>
          </div>
          <div style={{ width: "100%", background: "var(--brand-soft)", borderRadius: 999, height: 10 }}>
            <div
              style={{
                width: `${Math.max(3, Math.round(progressRatio * 100))}%`,
                background: "var(--brand)",
                borderRadius: 999,
                height: "100%",
                transition: "width 120ms linear",
              }}
            />
          </div>
          {engineUsed ? <div style={{ color: "var(--muted)", fontSize: 13 }}>Engine: {engineUsed}</div> : null}
          {warning ? (
            <div style={{ color: "#9a3412", fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
              <AlertTriangle size={14} />
              {warning}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div
          style={{
            border: "1px solid #fecaca",
            borderRadius: 12,
            background: "#fff1f2",
            color: "#9f1239",
            padding: 12,
          }}
        >
          {error}
        </div>
      ) : null}

      {summary ? (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 14,
            background: "var(--card)",
            padding: 16,
            display: "grid",
            gap: 12,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 20 }}>Summary</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            <Stat label="Compared" value={summary.rows_total_compared} />
            <Stat label="Added" value={summary.rows_added} tone="ok" />
            <Stat label="Removed" value={summary.rows_removed} tone="danger" />
            <Stat label="Changed" value={summary.rows_changed} tone="brand" />
            <Stat label="Unchanged" value={summary.rows_unchanged} />
          </div>
        </div>
      ) : null}

      {samples.length > 0 ? (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 14,
            background: "var(--card)",
            padding: 16,
            display: "grid",
            gap: 10,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 20 }}>Sample events ({samples.length})</h2>
          <div style={{ display: "grid", gap: 8 }}>{samples.map((sample, idx) => <SampleRow key={idx} sample={sample} />)}</div>
        </div>
      ) : null}

      <style jsx>{`
        .spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </section>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "ok" | "danger" | "brand";
}) {
  let color = "var(--text)";
  if (tone === "ok") {
    color = "var(--ok)";
  } else if (tone === "danger") {
    color = "var(--danger)";
  } else if (tone === "brand") {
    color = "var(--brand)";
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "white",
        padding: 10,
      }}
    >
      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 800, fontSize: 22, color }}>{value.toLocaleString()}</div>
    </div>
  );
}
