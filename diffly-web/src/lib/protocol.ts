export type HeaderMode = "strict" | "sorted";

export type RowData = Record<string, string>;

export type FieldDelta = {
  from: string;
  to: string;
};

export type SampleEvent = {
  type: "added" | "removed" | "changed";
  key?: Record<string, string>;
  rowIndex?: number;
  changed?: string[];
  delta?: Record<string, FieldDelta>;
  before?: RowData;
  after?: RowData;
};

export type DiffSummary = {
  rows_total_compared: number;
  rows_added: number;
  rows_removed: number;
  rows_changed: number;
  rows_unchanged: number;
};

export type CompareRequest = {
  type: "compare";
  requestId: string;
  aFile: File;
  bFile: File;
  keyColumns: string[];
  ignoreRowOrder: boolean;
  headerMode: HeaderMode;
  emitUnchanged: boolean;
  maxSampleEvents: number;
  preferWasm: boolean;
  smallFileThresholdBytes: number;
};

export type CancelRequest = {
  type: "cancel";
  requestId: string;
};

export type WorkerRequest = CompareRequest | CancelRequest;

export type ProgressMessage = {
  type: "progress";
  requestId: string;
  phase: "prepare" | "partitioning" | "diff_partitions" | "emit_events" | "done";
  done: number;
  total: number;
  message?: string;
};

export type ResultMessage = {
  type: "result";
  requestId: string;
  engine: "wasm" | "streaming_worker";
  summary: DiffSummary;
  samples: SampleEvent[];
  warning?: string;
};

export type ErrorMessage = {
  type: "error";
  requestId: string;
  code: string;
  message: string;
};

export type WorkerMessage = ProgressMessage | ResultMessage | ErrorMessage;
