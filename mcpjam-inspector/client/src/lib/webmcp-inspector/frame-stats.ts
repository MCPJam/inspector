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

/**
 * Which transport the pane's pixels are arriving on.
 *
 * Recorded so the percentiles can be SPLIT by it. A p95 that mixes socket
 * frames with polled screenshots describes neither, and the number people
 * actually want out of this — "did the transport change help?" — is precisely
 * a comparison between two of them.
 */
export type FrameTransportRung = "ws" | "sse-frames" | "poll" | "none";

interface Sample {
  v: number;
  rung: FrameTransportRung;
}

let enabled: boolean | undefined;
let currentRung: FrameTransportRung = "none";
const captureToPaint: Sample[] = [];
const inputToPaint: Sample[] = [];
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

function push(into: Sample[], value: number, rung = currentRung): void {
  into.push({ v: value, rung });
  if (into.length > MAX_SAMPLES) into.splice(0, into.length - MAX_SAMPLES);
}

/**
 * Called when the store's transport ladder moves.
 *
 * Free when the flag is off, like everything else here — and unconditional
 * when it is on, because a rung recorded late tags the wrong samples.
 */
export function noteFrameTransportRung(rung: FrameTransportRung): void {
  if (!frameStatsEnabled()) return;
  currentRung = rung;
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

/**
 * Called from the pane's `onLoad`, i.e. once the frame is actually painted.
 *
 * The frame carries the transport it ARRIVED on, rather than this reading the
 * current one: a frame decodes for tens of milliseconds, the ladder can move
 * in that window, and filing a socket frame under the transport that replaced
 * it is exactly the kind of quietly-wrong number this file exists to avoid.
 */
export function notePainted(frame: {
  ts: number;
  seq: number;
  rung?: FrameTransportRung;
}): void {
  if (!frameStatsEnabled()) return;
  const now = Date.now();
  push(captureToPaint, now - frame.ts, frame.rung);
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

function percentile(samples: Sample[], p: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = samples.map((sample) => sample.v).sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index]!);
}

export interface FrameStatsBucket {
  n: number;
  p50?: number;
  p95?: number;
}

export interface FrameStatsReport {
  captureToPaint: FrameStatsBucket;
  inputToPaint: FrameStatsBucket;
  /**
   * The same capture→paint samples, split by the transport that carried them.
   *
   * Only rungs with samples appear, so a session that never left the socket
   * reports one bucket rather than four mostly-empty ones — and the top-level
   * figures above are unchanged, because they are what every existing reader
   * of this report already asks for.
   */
  byTransport: Partial<Record<FrameTransportRung, FrameStatsBucket>>;
}

function bucket(samples: Sample[]): FrameStatsBucket {
  return {
    n: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
  };
}

export function frameStatsReport(): FrameStatsReport {
  const byTransport: Partial<Record<FrameTransportRung, FrameStatsBucket>> = {};
  for (const sample of captureToPaint) {
    if (byTransport[sample.rung]) continue;
    byTransport[sample.rung] = bucket(
      captureToPaint.filter((entry) => entry.rung === sample.rung),
    );
  }
  return {
    captureToPaint: bucket(captureToPaint),
    inputToPaint: bucket(inputToPaint),
    byTransport,
  };
}

export function resetFrameStats(): void {
  captureToPaint.length = 0;
  inputToPaint.length = 0;
  awaitingPaint = [];
  // The RUNG is deliberately kept. This is also `window.webmcpFrameStatsReset`,
  // which somebody runs mid-session to start a clean measurement — and a rung
  // cleared here would tag every frame after it as `none` until the transport
  // happened to change. Teardown re-tags it on its own: the store publishes the
  // new transport straight after clearing.
}

/** Everything, including the rung — see `resetFrameStatsFlagForTests`. */
function resetAll(): void {
  resetFrameStats();
  currentRung = "none";
}

/** Test seam: the flag is read once and cached for the tab's lifetime. */
export function resetFrameStatsFlagForTests(): void {
  enabled = undefined;
  // The rung too, which `resetFrameStats` deliberately keeps: a test seam that
  // left it set would carry one case's transport into the next, and a test
  // reading `byTransport` without setting a rung would be describing whatever
  // ran before it.
  resetAll();
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
