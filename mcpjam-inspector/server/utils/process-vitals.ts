/**
 * Heap and retained-buffer gauge for the process the inspector server runs in.
 *
 * INSPECTOR-ELECTRON-W3 crashed the Electron MAIN process after 21 minutes with
 * 2.24 GB live in a 2.27 GB old space — and with zero breadcrumbs for the whole
 * session. Nothing recorded whether the heap ramped steadily or spiked at the
 * end, and that difference is the entire diagnosis: a ramp is retention, a
 * spike is one oversized allocation, and they need different fixes. The
 * distinction had to be inferred from a single crash-time snapshot.
 *
 * This closes that gap for the next one. It also makes the retention fix
 * falsifiable rather than merely plausible: `rpcLogBufferBytes` is the leading
 * suspect for the ramp, so if the suspect is right that number tracks
 * `heapUsedBytes`, and if it is wrong these rows say where to look instead.
 *
 * Aggregated on the `http.socket.client_error` precedent (see
 * socket-diagnostics.ts): a fixed field set, no per-event rows, and a timer
 * that never holds the process open.
 */
import v8 from "node:v8";
import * as Sentry from "@sentry/node";
import { getSystemLogger } from "./request-logger.js";
import { logger } from "./logger.js";
import { rpcLogBus } from "../services/rpc-log-bus.js";
import { getTokenizerPeak } from "./tokenizer-helpers.js";

const SAMPLE_INTERVAL_MS = 60_000;

/**
 * How far the heap has to move since the last emitted row to earn another one.
 *
 * An ABSOLUTE delta, not growth: a 64 MB drop is a full GC doing its job and is
 * exactly as interesting as a 64 MB climb when the question is "did this ramp?"
 */
const HEAP_STEP_BYTES = 64 * 1024 * 1024;

/** A quiet session still checks in this often, so silence stays distinguishable
 *  from a process that died or never started sampling. */
const HEARTBEAT_MS = 10 * 60_000;

/**
 * Samples kept for the Sentry context. Ten minutes of heap at one sample a
 * minute — enough to read a ramp off a SINGLE crash report, which is the thing
 * W3 could not offer. Fixed size: the gauge must not become the leak.
 */
const HEAP_TREND_SAMPLES = 10;

const vitalsLogger = getSystemLogger("process.vitals");

export type ProcessVitals = {
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
};

let peakHeapUsedBytes = 0;
let peakRpcLogBufferBytes = 0;
let lastEmittedHeapBytes: number | null = null;
let lastEmittedAtMs = 0;
const heapTrendMb: number[] = [];
let sampler: ReturnType<typeof setInterval> | null = null;

function oldSpace(): { used: number; size: number } {
  for (const space of v8.getHeapSpaceStatistics()) {
    if (space.space_name === "old_space") {
      return { used: space.space_used_size, size: space.space_size };
    }
  }
  return { used: 0, size: 0 };
}

export function collectProcessVitals(): ProcessVitals {
  const heap = v8.getHeapStatistics();
  const memory = process.memoryUsage();
  const bus = rpcLogBus.stats();
  const tokenizer = getTokenizerPeak();
  const old = oldSpace();

  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, heap.used_heap_size);
  peakRpcLogBufferBytes = Math.max(peakRpcLogBufferBytes, bus.bytes);

  return {
    uptimeSeconds: Math.round(process.uptime()),
    heapUsedBytes: heap.used_heap_size,
    heapTotalBytes: heap.total_heap_size,
    heapLimitBytes: heap.heap_size_limit,
    oldSpaceUsedBytes: old.used,
    oldSpaceSizeBytes: old.size,
    externalBytes: heap.external_memory ?? memory.external,
    rssBytes: memory.rss,
    peakHeapUsedBytes,
    rpcLogBufferBytes: bus.bytes,
    rpcLogBufferEvents: bus.events,
    rpcLogBufferServers: bus.servers,
    rpcLogTruncatedFrames: bus.truncatedFrames,
    peakRpcLogBufferBytes,
    tokenizerPeakChars: tokenizer.chars,
    tokenizerOversizeSkips: tokenizer.oversizeSkips,
  };
}

function emitReason(
  vitals: ProcessVitals,
  nowMs: number,
): "startup" | "heap_step" | "heartbeat" | null {
  if (lastEmittedHeapBytes === null) return "startup";
  if (
    Math.abs(vitals.heapUsedBytes - lastEmittedHeapBytes) >= HEAP_STEP_BYTES
  ) {
    return "heap_step";
  }
  if (nowMs - lastEmittedAtMs >= HEARTBEAT_MS) return "heartbeat";
  return null;
}

/**
 * Take one sample.
 *
 * The Sentry context is refreshed on EVERY sample, not only on the ones worth
 * an Axiom row: a crash report needs the newest numbers, and it is the only
 * channel that survives a process that dies without flushing. `@sentry/electron`
 * persists the scope, so this lands on the minidump the next launch uploads —
 * the same path that carried `app_start_time` out of the W3 session.
 */
export function flushProcessVitals(nowMs: number = Date.now()): void {
  try {
    const vitals = collectProcessVitals();

    heapTrendMb.push(Math.round(vitals.heapUsedBytes / (1024 * 1024)));
    if (heapTrendMb.length > HEAP_TREND_SAMPLES) heapTrendMb.shift();

    Sentry.setContext("process_vitals", {
      ...vitals,
      // Oldest first. On a crash report this is the shape of the session, which
      // is what tells a ramp from a spike without a heap snapshot.
      heapUsedTrendMb: [...heapTrendMb],
      sampleIntervalSeconds: SAMPLE_INTERVAL_MS / 1000,
    });

    const reason = emitReason(vitals, nowMs);
    if (!reason) return;

    lastEmittedHeapBytes = vitals.heapUsedBytes;
    lastEmittedAtMs = nowMs;
    vitalsLogger.event("process.vitals", { reason, ...vitals });
  } catch (error) {
    // A telemetry timer must never be what takes the process down — the same
    // rule the socket `clientError` handler next door follows. Logged, not
    // swallowed, so a broken sampler is visible rather than merely silent.
    logger.debug("[process-vitals] sample failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Begin sampling. Idempotent.
 *
 * An explicit call rather than socket-diagnostics' module-level interval:
 * there is no natural attach point to hang this off, and a bare side-effect
 * import is the kind of line a future reader deletes as unused.
 */
export function startProcessVitalsSampler(): void {
  if (sampler) return;
  flushProcessVitals();
  sampler = setInterval(flushProcessVitals, SAMPLE_INTERVAL_MS);
  // Never hold the process open for a gauge.
  sampler.unref();
}
