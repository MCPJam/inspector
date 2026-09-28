/**
 * One analytics event per pane, on the way out.
 *
 * The overlay answers "what is this stream doing right now" for one person
 * looking at one browser. This answers the other question — "did the work
 * actually move the numbers, across everybody?" — and the two need opposite
 * shapes: a per-frame event would be tens of thousands of captures an hour and
 * would still not produce a percentile, because a percentile is a property of
 * a session rather than of a frame.
 *
 * Fired on unmount, which is the only moment the session is complete, and only
 * when the stream carried something: a pane that never received a frame has
 * nothing to report and would drag every percentile toward zero.
 *
 * NOT gated on the stats flag. The overlay is a debugging surface somebody
 * opts into; this is the aggregate the wave is judged by, and an aggregate
 * built only from the sessions of people who set a `localStorage` key is a
 * measurement of that group, not of the product.
 */
import { track } from "@/lib/analytics";
import { paneFrameStats } from "./frame-stats";

export function captureBrowserPaneSessionSummary(engine: string): void {
  const report = paneFrameStats.report();
  const live = paneFrameStats.live();
  if (live.framesPainted === 0) return;
  track("browser_pane_session_summary", {
    location: "browser_pane",
    engine,
    transport: live.transport,
    tier: live.tier,
    frames: live.framesPainted,
    fps: live.fps,
    kbps: live.kbps,
    rtt_p50: report.rtt.p50 ?? null,
    capture_to_paint_p50: report.captureToPaint.p50 ?? null,
    capture_to_paint_p95: report.captureToPaint.p95 ?? null,
    input_to_paint_p50: report.inputToPaint.p50 ?? null,
    input_to_paint_p95: report.inputToPaint.p95 ?? null,
    input_to_ack_p50: report.inputToAck.p50 ?? null,
    decode_p50: report.decode.p50 ?? null,
    relay_frames_in: live.relay?.framesIn ?? null,
    relay_dropped: live.relay?.dropped ?? null,
  });
}
