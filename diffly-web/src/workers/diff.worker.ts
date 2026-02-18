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
  signature: string;
  rowSample?: Record<string, string>;
};

type SpillRecord = {
  partition: number;
  key: string;
  keyParts: string[];
  rowIndex: number;
  row: string[];
};

type IndexedRowEntry = {
  record: SpillRecord;
  matched: boolean;
  matchedRowIndexB?: number;
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
const LARGE_FILE_IDB_SPILL_THRESHOLD_BYTES = 64 * 1024 * 1024;
const DEFAULT_IDB_PARTITIONS = 128;
const BATCH_WRITE_SIZE = 500;

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

function comparisonColumns(aHeader: string[], bHeader: string[], headerMode: HeaderMode): string[] {
  ensureComparableHeaders(aHeader, bHeader, headerMode);
  if (headerMode === "strict") {
    return [...aHeader];
  }
  return [...aHeader].sort();
}

function columnIndexes(header: string[], columns: string[]): number[] {
  return columns.map((column) => {
    const idx = header.indexOf(column);
    if (idx < 0) {
      throw toError("missing_key_column", `Missing key column: ${column}`);
    }
    return idx;
  });
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

function rowSignature(row: string[], compareIndexes: number[]): string {
  return compareIndexes.map((idx) => row[idx] ?? "").join(ROW_DELIMITER);
}

function stableKeyHash(keyParts: string[]): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < keyParts.length; i += 1) {
    const part = keyParts[i];
    for (let j = 0; j < part.length; j += 1) {
      hash ^= BigInt(part.charCodeAt(j));
      hash = (hash * prime) & 0xffffffffffffffffn;
    }
    if (i + 1 < keyParts.length) {
      hash ^= 0x1fn;
      hash = (hash * prime) & 0xffffffffffffffffn;
    }
  }
  return hash;
}

function partitionForKey(keyParts: string[], partitions: number): number {
  const count = Math.max(1, partitions);
  return Number(stableKeyHash(keyParts) % BigInt(count));
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

          // Align with rust-core behavior for common CSV exports that contain blank spacer lines.
          if (row.length === 1 && (row[0] ?? "").trim() === "") {
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

function openSpillDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const aStore = db.createObjectStore("a", { autoIncrement: true });
      aStore.createIndex("partition", "partition", { unique: false });
      const bStore = db.createObjectStore("b", { autoIncrement: true });
      bStore.createIndex("partition", "partition", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toError("storage_error", `Failed to open IndexedDB spill: ${request.error}`));
  });
}

function closeAndDeleteSpillDb(db: IDBDatabase): Promise<void> {
  const dbName = db.name;
  db.close();
  return new Promise((resolve) => {
    const deleteRequest = indexedDB.deleteDatabase(dbName);
    deleteRequest.onsuccess = () => resolve();
    deleteRequest.onerror = () => resolve();
    deleteRequest.onblocked = () => resolve();
  });
}

function writeSpillBatch(db: IDBDatabase, storeName: "a" | "b", batch: SpillRecord[]): Promise<void> {
  if (batch.length === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const record of batch) {
      store.add(record);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(toError("storage_error", `Failed to write spill records to store '${storeName}'`));
    tx.onabort = () =>
      reject(toError("storage_error", `Spill transaction aborted for store '${storeName}'`));
  });
}

function readSpillPartition(db: IDBDatabase, storeName: "a" | "b", partition: number): Promise<SpillRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const index = store.index("partition");
    const request = index.openCursor(IDBKeyRange.only(partition));
    const out: SpillRecord[] = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.push(cursor.value as SpillRecord);
      cursor.continue();
    };
    request.onerror = () =>
      reject(toError("storage_error", `Failed to read spill partition ${partition} from '${storeName}'`));
  });
}

async function parseCsvToSpill(
  request: CompareRequest,
  db: IDBDatabase,
  storeName: "a" | "b",
  file: File,
  side: "A" | "B",
  keyColumns: string[],
  partitions: number,
  onHeaderReady: (header: string[]) => void,
  isCancelled: () => boolean,
): Promise<{ header: string[]; keyIndexes: number[]; rowCount: number }> {
  let header: string[] = [];
  let keyIdx: number[] = [];
  let rowCount = 0;
  let batch: SpillRecord[] = [];
  let headerSeen = false;
  let rowNumber = 0;
  let lastProgressTs = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let flushing = Promise.resolve();

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

    const flushBatch = (parser: Papa.Parser) => {
      if (batch.length === 0) {
        return;
      }
      const toFlush = batch;
      batch = [];
      parser.pause();
      flushing = flushing
        .then(() => writeSpillBatch(db, storeName, toFlush))
        .then(() => parser.resume())
        .catch((error) => {
          fail(error as CsvError, parser);
        });
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
          if (row.length === 1 && (row[0] ?? "").trim() === "") {
            return;
          }

          if (!headerSeen) {
            const nextHeader = row.map((cell) => cell ?? "");
            normalizeHeader(nextHeader);
            validateHeader(nextHeader, side);
            header = nextHeader;
            keyIdx = keyIndexes(header, keyColumns);
            onHeaderReady(header);
            headerSeen = true;
          } else {
            if (row.length !== header.length) {
              fail(
                toError(
                  "row_width_mismatch",
                  `Row width mismatch in ${side} at CSV row ${rowNumber}: expected ${header.length}, got ${row.length}`,
                ),
                parser,
              );
              return;
            }

            const rowNorm = row.map((cell) => cell ?? "");
            const keyParts = keyValuesFromRow(rowNorm, rowNumber, keyColumns, keyIdx, side);
            batch.push({
              partition: partitionForKey(keyParts, partitions),
              key: keyString(keyParts),
              keyParts,
              rowIndex: rowNumber,
              row: rowNorm,
            });
            rowCount += 1;

            if (batch.length >= BATCH_WRITE_SIZE) {
              flushBatch(parser);
            }
          }

          const cursor = typeof result.meta.cursor === "number" ? result.meta.cursor : 0;
          const now = Date.now();
          if (now - lastProgressTs >= 120) {
            const done = side === "A" ? Math.min(cursor, request.aFile.size) : request.aFile.size + Math.min(cursor, request.bFile.size);
            post({
              type: "progress",
              requestId: request.requestId,
              phase: "partitioning",
              done,
              total: request.aFile.size + request.bFile.size,
            });
            lastProgressTs = now;
          }
        } catch (raw) {
          const err = raw as Partial<CsvError>;
          fail(
            toError(
              typeof err.code === "string" ? err.code : "csv_parse_error",
              typeof err.message === "string" ? err.message : `Failed to parse ${side}`,
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
        flushing
          .then(() => writeSpillBatch(db, storeName, batch))
          .then(() => {
            const done = side === "A" ? request.aFile.size : request.aFile.size + request.bFile.size;
            post({
              type: "progress",
              requestId: request.requestId,
              phase: "partitioning",
              done,
              total: request.aFile.size + request.bFile.size,
            });
            settled = true;
            resolve();
          })
          .catch((error) => fail(error as CsvError));
      },
      error: (error) => {
        fail(toError("csv_parse_error", `Failed to parse ${side}: ${error.message}`));
      },
    });
  });

  return { header, keyIndexes: keyIdx, rowCount };
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
      const keyCandidate = event.key;
      const key =
        keyCandidate && typeof keyCandidate === "object" && !Array.isArray(keyCandidate)
          ? (keyCandidate as Record<string, string>)
          : undefined;
      const rowIndex = typeof event.row_index === "number" ? event.row_index : undefined;
      const row = event.row as Record<string, string> | undefined;
      samples.push({
        type,
        key,
        rowIndex,
        before: (event.before as Record<string, string> | undefined) ?? (type === "removed" ? row : undefined),
        after: (event.after as Record<string, string> | undefined) ?? (type === "added" ? row : undefined),
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
    request.ignoreRowOrder,
  ) as string;
  const events = JSON.parse(resultJson) as Array<Record<string, unknown>>;
  return extractSummaryAndSamples(events, request.maxSampleEvents);
}

async function runStreamingCompareKeyed(
  request: CompareRequest,
): Promise<{ summary: DiffSummary; samples: SampleEvent[] }> {
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
  let compareIndexesA: number[] = [];
  let compareIndexesB: number[] = [];
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
      const compareColsA = request.headerMode === "strict" ? [...headerA] : [...headerA].sort();
      compareIndexesA = columnIndexes(headerA, compareColsA);
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
        signature: rowSignature(row, compareIndexesA),
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
      const compareCols = comparisonColumns(headerA, headerB, request.headerMode);
      compareIndexesA = columnIndexes(headerA, compareCols);
      compareIndexesB = columnIndexes(headerB, compareCols);
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

      const signatureB = rowSignature(row, compareIndexesB);
      if (signatureB === entry.signature) {
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

async function runStreamingComparePositional(
  request: CompareRequest,
): Promise<{ summary: DiffSummary; samples: SampleEvent[] }> {
  const summary: DiffSummary = {
    rows_total_compared: 0,
    rows_added: 0,
    rows_removed: 0,
    rows_changed: 0,
    rows_unchanged: 0,
  };
  const samples: SampleEvent[] = [];

  let headerA: string[] = [];
  let headerB: string[] = [];
  let compareIndexesA: number[] = [];
  let compareIndexesB: number[] = [];
  const rowsA: Array<{ rowIndex: number; row: string[] }> = [];

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
    },
    onRow: (rowIndex, row) => {
      if (row.length !== headerA.length) {
        throw toError(
          "row_width_mismatch",
          `Row width mismatch in A at CSV row ${rowIndex}: expected ${headerA.length}, got ${row.length}`,
        );
      }
      rowsA.push({ rowIndex, row });
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

  let seenBRows = 0;
  await parseCsvStreaming({
    file: request.bFile,
    side: "B",
    isCancelled,
    onHeader: (header) => {
      normalizeHeader(header);
      validateHeader(header, "B");
      headerB = header;
      const compareCols = comparisonColumns(headerA, headerB, request.headerMode);
      compareIndexesA = columnIndexes(headerA, compareCols);
      compareIndexesB = columnIndexes(headerB, compareCols);
    },
    onRow: (rowIndexB, rowB) => {
      if (rowB.length !== headerB.length) {
        throw toError(
          "row_width_mismatch",
          `Row width mismatch in B at CSV row ${rowIndexB}: expected ${headerB.length}, got ${rowB.length}`,
        );
      }

      const idx = seenBRows;
      seenBRows += 1;
      const rowIndex = idx + 2;
      const entryA = rowsA[idx];
      if (!entryA) {
        summary.rows_added += 1;
        if (samples.length < request.maxSampleEvents) {
          samples.push({
            type: "added",
            rowIndex,
            after: rowToObject(headerB, rowB),
          });
        }
        return;
      }

      summary.rows_total_compared += 1;
      const sigA = rowSignature(entryA.row, compareIndexesA);
      const sigB = rowSignature(rowB, compareIndexesB);
      if (sigA === sigB) {
        summary.rows_unchanged += 1;
        return;
      }

      summary.rows_changed += 1;
      if (samples.length < request.maxSampleEvents) {
        samples.push({
          type: "changed",
          rowIndex,
          before: rowToObject(headerA, entryA.row),
          after: rowToObject(headerB, rowB),
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

  for (let idx = seenBRows; idx < rowsA.length; idx += 1) {
    const rowIndex = idx + 2;
    summary.rows_removed += 1;
    if (samples.length < request.maxSampleEvents) {
      samples.push({
        type: "removed",
        rowIndex,
        before: rowToObject(headerA, rowsA[idx].row),
      });
    }
  }

  return { summary, samples };
}

async function runStreamingCompareMultiset(
  request: CompareRequest,
): Promise<{ summary: DiffSummary; samples: SampleEvent[] }> {
  const summary: DiffSummary = {
    rows_total_compared: 0,
    rows_added: 0,
    rows_removed: 0,
    rows_changed: 0,
    rows_unchanged: 0,
  };
  const samples: SampleEvent[] = [];

  let headerA: string[] = [];
  let headerB: string[] = [];
  const rowsA: string[][] = [];
  const rowsB: string[][] = [];
  let compareIndexesA: number[] = [];
  let compareIndexesB: number[] = [];

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
    },
    onRow: (rowIndex, row) => {
      if (row.length !== headerA.length) {
        throw toError(
          "row_width_mismatch",
          `Row width mismatch in A at CSV row ${rowIndex}: expected ${headerA.length}, got ${row.length}`,
        );
      }
      rowsA.push(row);
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
      const compareCols = comparisonColumns(headerA, headerB, request.headerMode);
      compareIndexesA = columnIndexes(headerA, compareCols);
      compareIndexesB = columnIndexes(headerB, compareCols);
    },
    onRow: (rowIndex, row) => {
      if (row.length !== headerB.length) {
        throw toError(
          "row_width_mismatch",
          `Row width mismatch in B at CSV row ${rowIndex}: expected ${headerB.length}, got ${row.length}`,
        );
      }
      rowsB.push(row);
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

  const groupedA = new Map<string, string[][]>();
  const groupedB = new Map<string, string[][]>();
  for (const row of rowsA) {
    const sig = rowSignature(row, compareIndexesA);
    const bucket = groupedA.get(sig);
    if (bucket) {
      bucket.push(row);
    } else {
      groupedA.set(sig, [row]);
    }
  }
  for (const row of rowsB) {
    const sig = rowSignature(row, compareIndexesB);
    const bucket = groupedB.get(sig);
    if (bucket) {
      bucket.push(row);
    } else {
      groupedB.set(sig, [row]);
    }
  }

  const signatures = [...new Set([...groupedA.keys(), ...groupedB.keys()])].sort();
  for (const sig of signatures) {
    if (isCancelled()) {
      throw toError("cancelled", "Operation cancelled");
    }

    const rowsForA = groupedA.get(sig) ?? [];
    const rowsForB = groupedB.get(sig) ?? [];
    const matched = Math.min(rowsForA.length, rowsForB.length);
    summary.rows_total_compared += matched;
    summary.rows_unchanged += matched;

    if (rowsForA.length > rowsForB.length) {
      for (let i = matched; i < rowsForA.length; i += 1) {
        summary.rows_removed += 1;
        if (samples.length < request.maxSampleEvents) {
          samples.push({
            type: "removed",
            before: rowToObject(headerA, rowsForA[i]),
          });
        }
      }
    }

    if (rowsForB.length > rowsForA.length) {
      for (let i = matched; i < rowsForB.length; i += 1) {
        summary.rows_added += 1;
        if (samples.length < request.maxSampleEvents) {
          samples.push({
            type: "added",
            after: rowToObject(headerB, rowsForB[i]),
          });
        }
      }
    }
  }

  return { summary, samples };
}

async function runStreamingCompare(request: CompareRequest): Promise<{ summary: DiffSummary; samples: SampleEvent[] }> {
  if (request.keyColumns.length === 0) {
    if (request.ignoreRowOrder) {
      return runStreamingCompareMultiset(request);
    }
    return runStreamingComparePositional(request);
  }
  if (request.ignoreRowOrder) {
    throw toError("invalid_option_combination", "ignore_row_order cannot be combined with keyed comparison");
  }
  return runStreamingCompareKeyed(request);
}

async function runIndexedDbPartitionedCompare(
  request: CompareRequest,
  partitions = DEFAULT_IDB_PARTITIONS,
): Promise<{ summary: DiffSummary; samples: SampleEvent[] }> {
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

  const isCancelled = () => cancelledRequestIds.has(request.requestId);
  const dbName = `diffly-spill-${request.requestId}`;
  const db = await openSpillDb(dbName);

  try {
    let headerA: string[] = [];
    let headerB: string[] = [];

    await parseCsvToSpill(
      request,
      db,
      "a",
      request.aFile,
      "A",
      keyColumns,
      partitions,
      (header) => {
        headerA = header;
      },
      isCancelled,
    );
    if (isCancelled()) {
      throw toError("cancelled", "Operation cancelled");
    }

    await parseCsvToSpill(
      request,
      db,
      "b",
      request.bFile,
      "B",
      keyColumns,
      partitions,
      (header) => {
        headerB = header;
      },
      isCancelled,
    );
    if (isCancelled()) {
      throw toError("cancelled", "Operation cancelled");
    }

    const compareCols = comparisonColumns(headerA, headerB, request.headerMode);
    const compareIndexesA = columnIndexes(headerA, compareCols);
    const compareIndexesB = columnIndexes(headerB, compareCols);

    for (let partition = 0; partition < partitions; partition += 1) {
      if (isCancelled()) {
        throw toError("cancelled", "Operation cancelled");
      }

      post({
        type: "progress",
        requestId: request.requestId,
        phase: "diff_partitions",
        done: partition,
        total: partitions,
      });

      const aRecords = await readSpillPartition(db, "a", partition);
      const bRecords = await readSpillPartition(db, "b", partition);

      const indexedA = new Map<string, IndexedRowEntry>();
      for (const record of aRecords) {
        const prior = indexedA.get(record.key);
        if (prior) {
          throw toError(
            "duplicate_key",
            `Duplicate key in A: ${JSON.stringify(keyObject(keyColumns, record.keyParts))} (rows ${prior.record.rowIndex} and ${record.rowIndex})`,
          );
        }
        indexedA.set(record.key, { record, matched: false });
      }

      const bOnlySeen = new Map<string, number>();
      for (const recordB of bRecords) {
        if (isCancelled()) {
          throw toError("cancelled", "Operation cancelled");
        }

        const entryA = indexedA.get(recordB.key);
        const keyObj = keyObject(keyColumns, recordB.keyParts);

        if (!entryA) {
          const priorB = bOnlySeen.get(recordB.key);
          if (priorB) {
            throw toError(
              "duplicate_key",
              `Duplicate key in B: ${JSON.stringify(keyObj)} (rows ${priorB} and ${recordB.rowIndex})`,
            );
          }
          bOnlySeen.set(recordB.key, recordB.rowIndex);
          summary.rows_added += 1;
          if (samples.length < request.maxSampleEvents) {
            samples.push({
              type: "added",
              key: keyObj,
              after: rowToObject(headerB, recordB.row),
            });
          }
          continue;
        }

        if (entryA.matched) {
          throw toError(
            "duplicate_key",
            `Duplicate key in B: ${JSON.stringify(keyObj)} (rows ${entryA.matchedRowIndexB} and ${recordB.rowIndex})`,
          );
        }

        entryA.matched = true;
        entryA.matchedRowIndexB = recordB.rowIndex;
        summary.rows_total_compared += 1;

        const sigA = rowSignature(entryA.record.row, compareIndexesA);
        const sigB = rowSignature(recordB.row, compareIndexesB);
        if (sigA === sigB) {
          summary.rows_unchanged += 1;
          continue;
        }

        summary.rows_changed += 1;
        if (samples.length < request.maxSampleEvents) {
          samples.push({
            type: "changed",
            key: keyObj,
            before: rowToObject(headerA, entryA.record.row),
            after: rowToObject(headerB, recordB.row),
          });
        }
      }

      for (const entry of indexedA.values()) {
        if (entry.matched) {
          continue;
        }
        summary.rows_removed += 1;
        if (samples.length < request.maxSampleEvents) {
          samples.push({
            type: "removed",
            key: keyObject(keyColumns, entry.record.keyParts),
            before: rowToObject(headerA, entry.record.row),
          });
        }
      }
    }

    post({
      type: "progress",
      requestId: request.requestId,
      phase: "diff_partitions",
      done: partitions,
      total: partitions,
    });

    return { summary, samples };
  } finally {
    await closeAndDeleteSpillDb(db);
  }
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

function shouldUseIndexedDbSpill(request: CompareRequest): boolean {
  if (request.keyColumns.length === 0) {
    return false;
  }
  const total = request.aFile.size + request.bFile.size;
  return total >= LARGE_FILE_IDB_SPILL_THRESHOLD_BYTES && typeof indexedDB !== "undefined";
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
    if (request.keyColumns.length > 0 && request.ignoreRowOrder) {
      throw toError("invalid_option_combination", "ignore_row_order cannot be combined with keyed comparison");
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
    } else if (shouldUseIndexedDbSpill(request)) {
      try {
        result = await runIndexedDbPartitionedCompare(request);
        engine = "streaming_worker";
      } catch (error) {
        const typed = error as Partial<CsvError>;
        if (typed.code === "cancelled") {
          throw error;
        }
        if (typed.code && typed.code !== "storage_error") {
          throw error;
        }
        warning = `IndexedDB spill path unavailable, used in-memory streaming fallback (${String(error)})`;
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
