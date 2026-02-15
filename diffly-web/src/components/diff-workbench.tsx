"use client";

import { DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, GitCompareArrows, Loader2, Upload, XCircle } from "lucide-react";
import type { HeaderMode, ResultMessage, SampleEvent, WorkerMessage } from "@/lib/protocol";

type CompareState = "idle" | "running" | "done" | "error";

const WASM_SMALL_FILE_THRESHOLD_BYTES = 16 * 1024 * 1024;

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

function SampleRow({ sample }: { sample: SampleEvent }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 10,
        background: "#fff",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
        <strong style={{ textTransform: "uppercase", fontSize: 12, letterSpacing: 0.6 }}>{sample.type}</strong>
        <code style={{ fontSize: 12 }}>{JSON.stringify(sample.key)}</code>
      </div>
      {sample.before ? (
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: sample.after ? 8 : 0 }}>
          before: {JSON.stringify(sample.before)}
        </div>
      ) : null}
      {sample.after ? (
        <div style={{ fontSize: 12, color: "var(--muted)" }}>after: {JSON.stringify(sample.after)}</div>
      ) : null}
    </div>
  );
}

export function DiffWorkbench() {
  const workerRef = useRef<Worker | null>(null);
  const currentRequestIdRef = useRef<string | null>(null);

  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [keyColumnsInput, setKeyColumnsInput] = useState("id");
  const [headerMode, setHeaderMode] = useState<HeaderMode>("strict");
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
    if (keyColumns.length === 0) {
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
      keyColumns,
      headerMode,
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
        <h1 style={{ margin: 0, fontSize: 36, letterSpacing: -0.8 }}>Browser CSV diff that survives big files</h1>
        <p style={{ margin: 0, color: "var(--muted)", maxWidth: 760 }}>
          DiffyData-inspired UI, but execution stays off the main thread. For large files this uses streaming worker logic, and
          for smaller files it can use Rust/WASM.
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

        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span>Header mode</span>
            <select
              value={headerMode}
              onChange={(event) => setHeaderMode(event.currentTarget.value as HeaderMode)}
              style={{ borderRadius: 8, border: "1px solid var(--border)", padding: "4px 8px" }}
            >
              <option value="strict">strict</option>
              <option value="sorted">sorted</option>
            </select>
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
