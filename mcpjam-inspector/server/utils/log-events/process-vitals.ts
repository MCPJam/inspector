/**
 * The `process.vitals` log event: the heap and retained-buffer gauge, one line
 * per sample that says something (see `utils/process-vitals.ts`). Emitted on
 * startup, on a heap step, and on a slow heartbeat — never once per interval
 * unconditionally, so a quiet session costs almost nothing.
 *
 * Exists because INSPECTOR-ELECTRON-W3 crashed after 21 minutes with ZERO
 * breadcrumbs for the whole session: nothing recorded whether the heap ramped
 * or spiked, and the difference is the entire diagnosis. Every field is a
 * number (or `null` for "not measured"), a three-valued reason, or an errno
 * code, so cardinality is fixed. The telemetry catalog reads payloads in this
 * folder as it reads `log-events.ts`, so these fields reach the log row.
 */
export type ProcessVitalsEvent = {
  reason: "startup" | "heap_step" | "heartbeat";
  uptimeSeconds: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapLimitBytes: number;
  oldSpaceUsedBytes: number;
  oldSpaceSizeBytes: number;
  externalBytes: number;
  rssBytes: number;
  peakHeapUsedBytes: number;
  rpcLogBufferBytes: number;
  rpcLogBufferEvents: number;
  rpcLogBufferServers: number;
  rpcLogTruncatedFrames: number;
  peakRpcLogBufferBytes: number;
  tokenizerPeakChars: number;
  tokenizerOversizeSkips: number;
  openFdCount: number | null;
  openFdError:
    "ENOENT" | "EMFILE" | "ENFILE" | "EACCES" | "EPERM" | "unknown" | null;
};
