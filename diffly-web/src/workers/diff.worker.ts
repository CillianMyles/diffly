/// <reference lib="webworker" />

import Papa from "papaparse";
import type {
  CompareRequest,
  DiffSummary,
  HeaderMode,
  SampleEvent,
  WorkerMessage,
  WorkerRequest,
} from "@/lib/protocol";

type CsvRow = string[];

type RowEntry = {
  rowIndexA: number;
  matched: boolean;
  matchedRowIndexB?: number;
  fingerprint: bigint;
  rowSample?: Record<string, string>;
};

type StreamOptions = {
  file: File;
  side: "A" | "B";
  onHeader: (header: string[]) => void;
  onRow: (rowIndex: number, row: CsvRow) => void;
  onProgress: (cursor: number) => void;
  isCancelled: () => boolean;
};

type CsvError = {
  code: string;
  message: string;
};

const KEY_DELIMITER = "\u001f";
const ROW_DELIMITER = "\u001e";
const SAMPLE_ROW_STORE_LIMIT = 3000;

let activeRequestId: string | null = null;
let cancelledRequestIds = new Set<string>();

function toError(code: string, message: string): CsvError {
  return { code, message };
}

function post(message: WorkerMessage) {
  self.postMessage(message);
}

function normalizeHeader(header: string[]) {
  if (header.length > 0 && header[0].startsWith("\uFEFF")) {
    header[0] = header[0].replace(/^\uFEFF/, "");
  }
}

function validateHeader(header: string[], side: "A" | "B") {
  const seen = new Set<string>();
  for (const column of header) {
    if (seen.has(column)) {
      throw toError("duplicate_column_name", `Duplicate column name in ${side}: ${column}`);
    }
    seen.add(column);
  }
}

function ensureComparableHeaders(aHeader: string[], bHeader: string[], headerMode: HeaderMode) {
  if (headerMode === "strict") {
    if (aHeader.length !== bHeader.length || aHeader.some((v, i) => v !== bHeader[i])) {
      throw toError("header_mismatch", `Header mismatch: A=${JSON.stringify(aHeader)} B=${JSON.stringify(bHeader)}`);
    }
    return;
  }

  const sortedA = [...aHeader].sort();
  const sortedB = [...bHeader].sort();
  if (sortedA.length !== sortedB.length || sortedA.some((v, i) => v !== sortedB[i])) {
    throw toError(
      "header_mismatch",
      `Header mismatch (sorted mode): A=${JSON.stringify(aHeader)} B=${JSON.stringify(bHeader)}`,
    );
  }
}

function keyIndexes(header: string[], keyColumns: string[]): number[] {
  return keyColumns.map((key) => {
    const idx = header.indexOf(key);
    if (idx < 0) {
      throw toError("missing_key_column", `Missing key column: ${key}`);
    }
    return idx;
  });
}

function rowToObject(header: string[], row: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < header.length; i += 1) {
    out[header[i]] = row[i] ?? "";
  }
  return out;
}

function keyValuesFromRow(
  row: string[],
  rowIndex: number,
  keyColumns: string[],
  indexes: number[],
  side: "A" | "B",
): string[] {
  return indexes.map((idx, keyIdx) => {
    const value = row[idx] ?? "";
    if (value === "") {
      throw toError(
        "missing_key_value",
        `Missing key value in ${side} at CSV row ${rowIndex} for key column '${keyColumns[keyIdx]}'`,
      );
    }
    return value;
  });
}

function keyString(keyValues: string[]): string {
  return keyValues.join(KEY_DELIMITER);
}

function fnv1a64(input: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}

function rowFingerprint(row: string[]): bigint {
  return fnv1a64(row.join(ROW_DELIMITER));
}

async function parseCsvStreaming(options: StreamOptions): Promise<void> {
  const { file, onHeader, onRow, onProgress, isCancelled, side } = options;

  let rowNumber = 0;
  let headerSeen = false;
  let lastProgressTs = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const fail = (error: CsvError, parser?: Papa.Parser) => {
      if (settled) {
        return;
      }
      settled = true;
      if (parser) {
        parser.abort();
      }
      reject(error);
    };

    Papa.parse<string[]>(file, {
      header: false,
      skipEmptyLines: false,
      dynamicTyping: false,
      worker: false,
      step: (result, parser) => {
        if (settled) {
          return;
        }

        if (isCancelled()) {
          fail(toError("cancelled", "Operation cancelled"), parser);
          return;
        }

        try {
          if (result.errors && result.errors.length > 0) {
            const first = result.errors[0];
            fail(
              toError(
                "csv_parse_error",
                `Failed to parse ${side} at CSV row ${first.row ?? "?"}: ${first.message}`,
              ),
              parser,
            );
            return;
          }

          rowNumber += 1;
          const row = result.data;
          if (!Array.isArray(row)) {
            fail(toError("csv_parse_error", `Failed to parse ${side}: invalid row shape`), parser);
            return;
          }

          if (!headerSeen) {
            const header = [...row.map((cell) => cell ?? "")];
            onHeader(header);
            headerSeen = true;
          } else {
            onRow(rowNumber, row.map((cell) => cell ?? ""));
          }

          const cursor = typeof result.meta.cursor === "number" ? result.meta.cursor : 0;
          const now = Date.now();
          if (now - lastProgressTs >= 120) {
            onProgress(cursor);
            lastProgressTs = now;
          }
        } catch (error) {
          const typed = error as Partial<CsvError>;
          fail(
            toError(
              typeof typed.code === "string" ? typed.code : "csv_parse_error",
              typeof typed.message === "string"
                ? typed.message
                : `Failed to parse ${side}: unexpected error`,
            ),
            parser,
          );
        }
      },
      complete: () => {
        if (settled) {
          return;
        }
        if (!headerSeen) {
          fail(toError("empty_file", `${side} file is empty: ${file.name}`));
          return;
        }
        settled = true;
        try {
          onProgress(file.size);
        } catch {}
        resolve();
      },
      error: (error) => {
        fail(toError("csv_parse_error", `Failed to parse ${side}: ${error.message}`));
      },
    });
  });
}

function extractSummaryAndSamples(
  events: Array<Record<string, unknown>>,
  maxSampleEvents: number,
): { summary: DiffSummary; samples: SampleEvent[] } {
  const summary: DiffSummary = {
    rows_total_compared: 0,
    rows_added: 0,
    rows_removed: 0,
    rows_changed: 0,
    rows_unchanged: 0,
  };
  const samples: SampleEvent[] = [];

  for (const event of events) {
    const type = event.type;
    if (type === "stats") {
      summary.rows_total_compared = Number(event.rows_total_compared ?? 0);
      summary.rows_added = Number(event.rows_added ?? 0);
      summary.rows_removed = Number(event.rows_removed ?? 0);
      summary.rows_changed = Number(event.rows_changed ?? 0);
      summary.rows_unchanged = Number(event.rows_unchanged ?? 0);
      continue;
    }

    if ((type === "added" || type === "removed" || type === "changed") && samples.length < maxSampleEvents) {
      samples.push({
        type,
        key: (event.key as Record<string, string>) ?? {},
        before: event.before as Record<string, string> | undefined,
        after: event.after as Record<string, string> | undefined,
      });
    }
  }

  return { summary, samples };
}

async function tryWasmCompare(request: CompareRequest): Promise<{ summary: DiffSummary; samples: SampleEvent[] }> {
  const wasm = await import("@/wasm/pkg/diffly_wasm.js");
  if (typeof wasm.default === "function") {
    await wasm.default();
  }

  if (typeof wasm.diff_csv_bytes_json !== "function") {
    throw new Error("WASM package does not expose diff_csv_bytes_json");
  }

  const aBytes = new Uint8Array(await request.aFile.arrayBuffer());
  const bBytes = new Uint8Array(await request.bFile.arrayBuffer());
  const resultJson = wasm.diff_csv_bytes_json(
    aBytes,
    bBytes,
    request.keyColumns.join(","),
    request.headerMode,
    request.emitUnchanged,
  ) as string;
  const events = JSON.parse(resultJson) as Array<Record<string, unknown>>;
  return extractSummaryAndSamples(events, request.maxSampleEvents);
}

async function runStreamingCompare(request: CompareRequest): Promise<{ summary: DiffSummary; samples: SampleEvent[] }> {
  const summary: DiffSummary = {
    rows_total_compared: 0,
    rows_added: 0,
    rows_removed: 0,
    rows_changed: 0,
    rows_unchanged: 0,
  };
  const samples: SampleEvent[] = [];

  const keyColumns = request.keyColumns;
  if (keyColumns.length === 0) {
    throw toError("missing_key_column", "At least one key column is required");
  }

  let headerA: string[] = [];
  let headerB: string[] = [];
  let keyIndexesA: number[] = [];
  let keyIndexesB: number[] = [];
  let storedSampleRows = 0;

  const rowsA = new Map<string, RowEntry>();
  const rowsBOnlyFirstSeen = new Map<string, number>();

  const isCancelled = () => cancelledRequestIds.has(request.requestId);

  post({
    type: "progress",
    requestId: request.requestId,
    phase: "partitioning",
    done: 0,
    total: request.aFile.size + request.bFile.size,
  });

  await parseCsvStreaming({
    file: request.aFile,
    side: "A",
    isCancelled,
    onHeader: (header) => {
      normalizeHeader(header);
      validateHeader(header, "A");
      headerA = header;
      keyIndexesA = keyIndexes(headerA, keyColumns);
    },
    onRow: (rowIndex, row) => {
      if (row.length !== headerA.length) {
        throw toError(
          "row_width_mismatch",
          `Row width mismatch in A at CSV row ${rowIndex}: expected ${headerA.length}, got ${row.length}`,
        );
      }

      const key = keyValuesFromRow(row, rowIndex, keyColumns, keyIndexesA, "A");
      const keyStr = keyString(key);
      const prior = rowsA.get(keyStr);
      if (prior) {
        throw toError(
          "duplicate_key",
          `Duplicate key in A: ${JSON.stringify(keyObject(keyColumns, key))} (rows ${prior.rowIndexA} and ${rowIndex})`,
        );
      }

      const storeSample = storedSampleRows < SAMPLE_ROW_STORE_LIMIT;
      if (storeSample) {
        storedSampleRows += 1;
      }

      rowsA.set(keyStr, {
        rowIndexA: rowIndex,
        matched: false,
        fingerprint: rowFingerprint(row),
        rowSample: storeSample ? rowToObject(headerA, row) : undefined,
      });
    },
    onProgress: (cursor) => {
      post({
        type: "progress",
        requestId: request.requestId,
        phase: "partitioning",
        done: Math.min(cursor, request.aFile.size),
        total: request.aFile.size + request.bFile.size,
      });
    },
  });

  await parseCsvStreaming({
    file: request.bFile,
    side: "B",
    isCancelled,
    onHeader: (header) => {
      normalizeHeader(header);
      validateHeader(header, "B");
      headerB = header;
      ensureComparableHeaders(headerA, headerB, request.headerMode);
      keyIndexesB = keyIndexes(headerB, keyColumns);
    },
    onRow: (rowIndex, row) => {
      if (row.length !== headerB.length) {
        throw toError(
          "row_width_mismatch",
          `Row width mismatch in B at CSV row ${rowIndex}: expected ${headerB.length}, got ${row.length}`,
        );
      }

      const key = keyValuesFromRow(row, rowIndex, keyColumns, keyIndexesB, "B");
      const keyStr = keyString(key);
      const entry = rowsA.get(keyStr);
      const keyObj = keyObject(keyColumns, key);

      if (!entry) {
        const priorB = rowsBOnlyFirstSeen.get(keyStr);
        if (priorB) {
          throw toError(
            "duplicate_key",
            `Duplicate key in B: ${JSON.stringify(keyObj)} (rows ${priorB} and ${rowIndex})`,
          );
        }
        rowsBOnlyFirstSeen.set(keyStr, rowIndex);
        summary.rows_added += 1;

        if (samples.length < request.maxSampleEvents) {
          samples.push({
            type: "added",
            key: keyObj,
            after: rowToObject(headerB, row),
          });
        }
        return;
      }

      if (entry.matched) {
        throw toError(
          "duplicate_key",
          `Duplicate key in B: ${JSON.stringify(keyObj)} (rows ${entry.matchedRowIndexB} and ${rowIndex})`,
        );
      }

      entry.matched = true;
      entry.matchedRowIndexB = rowIndex;
      summary.rows_total_compared += 1;

      const fingerprintB = rowFingerprint(row);
      if (fingerprintB === entry.fingerprint) {
        summary.rows_unchanged += 1;
        return;
      }

      summary.rows_changed += 1;
      if (samples.length < request.maxSampleEvents) {
        samples.push({
          type: "changed",
          key: keyObj,
          before: entry.rowSample,
          after: rowToObject(headerB, row),
        });
      }
    },
    onProgress: (cursor) => {
      post({
        type: "progress",
        requestId: request.requestId,
        phase: "diff_partitions",
        done: request.aFile.size + Math.min(cursor, request.bFile.size),
        total: request.aFile.size + request.bFile.size,
      });
    },
  });

  for (const [keyStr, entry] of rowsA.entries()) {
    if (entry.matched) {
      continue;
    }
    summary.rows_removed += 1;

    if (samples.length < request.maxSampleEvents && entry.rowSample) {
      const keyParts = keyStr.split(KEY_DELIMITER);
      samples.push({
        type: "removed",
        key: keyObject(keyColumns, keyParts),
        before: entry.rowSample,
      });
    }
  }

  return { summary, samples };
}

function keyObject(columns: string[], values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < columns.length; i += 1) {
    out[columns[i]] = values[i] ?? "";
  }
  return out;
}

function shouldTryWasm(request: CompareRequest): boolean {
  if (!request.preferWasm) {
    return false;
  }
  const limit = request.smallFileThresholdBytes;
  return request.aFile.size <= limit && request.bFile.size <= limit;
}

async function handleCompare(request: CompareRequest) {
  activeRequestId = request.requestId;
  cancelledRequestIds.delete(request.requestId);

  post({
    type: "progress",
    requestId: request.requestId,
    phase: "prepare",
    done: 0,
    total: 1,
    message: "Preparing comparison",
  });

  try {
    if (cancelledRequestIds.has(request.requestId)) {
      throw toError("cancelled", "Operation cancelled");
    }

    let warning: string | undefined;
    let result: { summary: DiffSummary; samples: SampleEvent[] };
    let engine: "wasm" | "streaming_worker";

    if (shouldTryWasm(request)) {
      try {
        result = await tryWasmCompare(request);
        engine = "wasm";
      } catch (error) {
        warning = `WASM path unavailable, used streaming worker fallback (${String(error)})`;
        result = await runStreamingCompare(request);
        engine = "streaming_worker";
      }
    } else {
      result = await runStreamingCompare(request);
      engine = "streaming_worker";
    }

    post({
      type: "progress",
      requestId: request.requestId,
      phase: "done",
      done: 1,
      total: 1,
    });

    post({
      type: "result",
      requestId: request.requestId,
      engine,
      summary: result.summary,
      samples: result.samples,
      warning,
    });
  } catch (raw) {
    const err = raw as Partial<CsvError>;
    post({
      type: "error",
      requestId: request.requestId,
      code: typeof err.code === "string" ? err.code : "compare_failed",
      message: typeof err.message === "string" ? err.message : "Comparison failed",
    });
  } finally {
    activeRequestId = null;
    cancelledRequestIds.delete(request.requestId);
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelledRequestIds.add(message.requestId);
    return;
  }

  if (activeRequestId && activeRequestId !== message.requestId) {
    cancelledRequestIds.add(activeRequestId);
  }

  void handleCompare(message);
};
