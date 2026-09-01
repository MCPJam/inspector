/**
 * Glass-to-glass measurement for the viewport stream. DARK BY DEFAULT.
 *
 * "Feels laggy" is not a number, and every change to this pipeline — the
 * transport, the throttle floor, the input batching — trades one cost for
 * another. Two numbers say whether a change helped:
 *
 *   capture→paint      `img.onload` minus the frame's server-stamped `ts`.
 *                      Both clocks are the same machine on loopback, so this
 *                      is a real end-to-end figure rather than a delta of
 *                      deltas. Moves when the transport gets cheaper.
 *   input→visible paint the moment a gesture was sent, to the paint of the
 *                      first frame whose `seq` is newer than the one on
 *                      screen when it went. The repeatable wheel/keystroke
 *                      echo number, and what the rate and batching work moves.
 *
 * Enabled by `localStorage["webmcp:frame-stats"]`, read once. Off, every
 * function here is an immediate return — this sits in the paint path, so it
 * costs a boolean check per frame and nothing else.
 *
 * Report from the console at any time with `window.webmcpFrameStats()`.
 */

const FLAG = "webmcp:frame-stats";
/** Enough for ~30s of interaction at 30fps; oldest fall off. */
const MAX_SAMPLES = 2_000;
/** Inputs that never saw a newer frame — a page that simply did not repaint. */
const INPUT_TIMEOUT_MS = 3_000;

let enabled: boolean | undefined;
const captureToPaint: number[] = [];
const inputToPaint: number[] = [];
/** Gestures still waiting for the first frame that postdates them. */
let awaitingPaint: Array<{ sentAt: number; afterSeq: number }> = [];

export function frameStatsEnabled(): boolean {
  if (enabled === undefined) {
    try {
      enabled = localStorage.getItem(FLAG) !== null;
    } catch {
      // Private mode, or a storage-less embedding.
      enabled = false;
    }
    if (enabled) install();
  }
  return enabled;
}

function push(into: number[], value: number): void {
  into.push(value);
  if (into.length > MAX_SAMPLES) into.splice(0, into.length - MAX_SAMPLES);
}

/** Called when a gesture leaves the client, with the seq currently on screen. */
export function noteInputSent(afterSeq: number): void {
  if (!frameStatsEnabled()) return;
  const now = Date.now();
  awaitingPaint.push({ sentAt: now, afterSeq });
  awaitingPaint = awaitingPaint.filter(
    (entry) => now - entry.sentAt < INPUT_TIMEOUT_MS,
  );
}

/** Called from the pane's `onLoad`, i.e. once the frame is actually painted. */
export function notePainted(frame: { ts: number; seq: number }): void {
  if (!frameStatsEnabled()) return;
  const now = Date.now();
  push(captureToPaint, now - frame.ts);
  // Expired HERE as well as on send. `noteInputSent` is not a reliable expiry
  // point: a gesture followed by silence leaves its entry sitting until the
  // next input, and a frame arriving minutes later would settle it as a
  // multi-second "echo" — poisoning the one percentile this exists to report.
  awaitingPaint = awaitingPaint.filter(
    (entry) => now - entry.sentAt < INPUT_TIMEOUT_MS,
  );
  const settled = awaitingPaint.filter((entry) => frame.seq > entry.afterSeq);
  if (settled.length === 0) return;
  awaitingPaint = awaitingPaint.filter((entry) => frame.seq <= entry.afterSeq);
  for (const entry of settled) push(inputToPaint, now - entry.sentAt);
}

function percentile(samples: number[], p: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index]!);
}

export interface FrameStatsReport {
  captureToPaint: { n: number; p50?: number; p95?: number };
  inputToPaint: { n: number; p50?: number; p95?: number };
}

export function frameStatsReport(): FrameStatsReport {
  return {
    captureToPaint: {
      n: captureToPaint.length,
      p50: percentile(captureToPaint, 50),
      p95: percentile(captureToPaint, 95),
    },
    inputToPaint: {
      n: inputToPaint.length,
      p50: percentile(inputToPaint, 50),
      p95: percentile(inputToPaint, 95),
    },
  };
}

export function resetFrameStats(): void {
  captureToPaint.length = 0;
  inputToPaint.length = 0;
  awaitingPaint = [];
}

/** Test seam: the flag is read once and cached for the tab's lifetime. */
export function resetFrameStatsFlagForTests(): void {
  enabled = undefined;
  resetFrameStats();
}

function install(): void {
  if (typeof window === "undefined") return;
  (
    window as unknown as {
      webmcpFrameStats?: () => FrameStatsReport;
      webmcpFrameStatsReset?: () => void;
    }
  ).webmcpFrameStats = frameStatsReport;
  (
    window as unknown as { webmcpFrameStatsReset?: () => void }
  ).webmcpFrameStatsReset = resetFrameStats;
}
