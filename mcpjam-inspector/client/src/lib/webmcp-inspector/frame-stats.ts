/**
 * Glass-to-glass measurement for the WebMCP inspector's viewport. DARK BY
 * DEFAULT.
 *
 * The MECHANISM moved to `lib/browser-pane/frame-stats.ts` when the browser
 * pane needed the same numbers — one implementation of a percentile that is
 * quietly wrong in two places is one bug, two copies is two — and what stayed
 * here is this surface's own instance: its `localStorage` flag, its console
 * globals, and the exact report shape its diagnostics payload and its tests
 * already read.
 *
 * Socket input acknowledgements split dispatch waiting from the next-frame
 * latency proxy. HTTP fallback has no socket ack samples. Neither metric proves
 * a particular input caused the next frame; use a gesture marker for that.
 *
 * Enabled by `localStorage["webmcp:frame-stats"]`, read once. Off, every
 * function here is an immediate return.
 *
 * Report from the console at any time with `window.webmcpFrameStats()`.
 */
import {
  createFrameStats,
  type FrameStatsBucket,
  type FrameTransportRung,
} from "@/lib/browser-pane/frame-stats";

export type { FrameStatsBucket, FrameTransportRung };

export interface FrameStatsReport {
  captureToPaint: FrameStatsBucket;
  /** Queue-inclusive store-entry to next-frame proxy. */
  inputToPaint: FrameStatsBucket;
  dispatchToPaint: FrameStatsBucket;
  /** Socket acknowledgements measure dispatch completion, not visible effect. */
  inputToAck: FrameStatsBucket;
  byTransport: Partial<Record<FrameTransportRung, FrameStatsBucket>>;
}

const stats = createFrameStats({
  flag: "webmcp:frame-stats",
});

const dispatchedStats = createFrameStats({ flag: "webmcp:frame-stats" });

export function frameStatsEnabled(): boolean {
  const enabled = stats.enabled();
  if (enabled && typeof window !== "undefined") {
    const scope = window as unknown as Record<string, unknown>;
    scope.webmcpFrameStats = frameStatsReport;
    scope.webmcpFrameStatsReset = resetFrameStats;
  }
  return enabled;
}

/**
 * Called when the store's transport ladder moves.
 *
 * Free when the flag is off, like everything else here — and unconditional
 * when it is on, because a rung recorded late tags the wrong samples.
 */
export function noteFrameTransportRung(rung: FrameTransportRung): void {
  frameStatsEnabled();
  stats.noteTransport(rung);
  dispatchedStats.noteTransport(rung);
}

/** Legacy headline: stamp when input enters the store, before its queue. */
export function noteInputSent(afterSeq: number): void {
  frameStatsEnabled();
  stats.noteInputSent(afterSeq);
}

/** Separate post-queue measurement; acknowledgements use this clock. */
export function noteInputDispatched(afterSeq: number, seq?: number): void {
  frameStatsEnabled();
  dispatchedStats.noteInputSent(afterSeq, seq);
}

export function noteInputAck(seq: number): void {
  dispatchedStats.noteInputAck(seq);
}

/**
 * Called from the pane's `onLoad`, i.e. once the frame is actually painted.
 *
 * The frame carries the transport it ARRIVED on, rather than this reading the
 * current one: a frame decodes for tens of milliseconds, the ladder can move
 * in that window, and filing a socket frame under the transport that replaced
 * it is exactly the kind of quietly-wrong number this file exists to avoid.
 *
 * `ts` here is the SERVER's stamp, and this transport is loopback — the same
 * machine, so the subtraction is honest. The browser pane cannot make that
 * assumption and stamps its frames at the relay instead.
 */
export function notePainted(frame: {
  ts: number;
  seq?: number;
  rung?: FrameTransportRung;
}): void {
  frameStatsEnabled();
  stats.notePainted(frame);
  dispatchedStats.notePainted(frame);
}

export function frameStatsReport(): FrameStatsReport {
  const full = stats.report();
  const dispatched = dispatchedStats.report();
  return {
    captureToPaint: full.captureToPaint,
    inputToPaint: full.inputToPaint,
    dispatchToPaint: dispatched.inputToPaint,
    inputToAck: dispatched.inputToAck,
    byTransport: full.byTransport,
  };
}

export function resetFrameStats(): void {
  stats.reset();
  dispatchedStats.reset();
}

/** Test seam: the flag is read once and cached for the tab's lifetime. */
export function resetFrameStatsFlagForTests(): void {
  stats.resetFlagForTests();
  dispatchedStats.resetFlagForTests();
}
