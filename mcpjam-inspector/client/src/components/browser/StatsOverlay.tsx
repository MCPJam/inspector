import { useEffect, useState } from "react";
import {
  paneFrameStats,
  type FrameStatsLive,
} from "@/lib/browser-pane/frame-stats";

/** How often the overlay re-reads the counters. Fast enough to feel live. */
const REFRESH_MS = 500;

/**
 * "Stats for nerds" — what this stream is actually doing, right now.
 *
 * The pane degrades silently by design: a link that cannot carry video falls
 * back to JPEG, a client without `VideoDecoder` never asks for video at all,
 * and a busy relay drops frames rather than queueing them. All three look
 * identical from the outside — a picture that is not as smooth as it should be
 * — so "it's laggy" is a report nobody can act on. This turns it into numbers,
 * and those numbers are what every step of the viewport work is measured
 * against.
 *
 * Deliberately an OVERLAY and not a panel: it has to sit on top of the live
 * picture, because half of what it describes (fps, dropped frames) is only
 * meaningful next to the thing it is describing.
 */
export function StatsOverlay({
  engine,
  inline = false,
}: {
  engine: string;
  /**
   * Render in the flow instead of over the picture.
   *
   * For the NATIVE Electron surface, where there is no picture to sit on: a
   * `WebContentsView` is a sibling of the renderer and paints over the
   * rectangle it was given, so an overlay inside that rectangle is on screen
   * in the DOM and invisible on the glass. In flow it takes its own strip and
   * the view is measured below it — the numbers cost a little height, which is
   * the honest trade when the alternative is a menu item that appears to do
   * nothing.
   */
  inline?: boolean;
}) {
  const [live, setLive] = useState<FrameStatsLive>(() => paneFrameStats.live());

  useEffect(() => {
    paneFrameStats.noteEngine(engine);
  }, [engine]);

  useEffect(() => {
    const timer = setInterval(() => setLive(paneFrameStats.live()), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const relay = live.relay;
  return (
    <div
      data-testid="pane-stats-overlay"
      className={
        inline
          ? "mb-2 w-fit rounded-md bg-black/70 px-2 py-1.5 font-mono text-[10px] leading-4 text-white"
          : "pointer-events-none absolute left-2 top-2 z-10 rounded-md bg-black/70 px-2 py-1.5 font-mono text-[10px] leading-4 text-white"
      }
    >
      <div>
        {live.width || "–"}×{live.height || "–"} @ {live.fps} fps · {live.kbps}{" "}
        kbps
      </div>
      <div>
        rtt {live.rtt ?? "–"} ms · frame→paint {live.captureToPaintP50 ?? "–"}{" "}
        ms
      </div>
      <div>
        input→paint p50 {live.inputToPaintP50 ?? "–"} / p95{" "}
        {live.inputToPaintP95 ?? "–"} ms
      </div>
      <div>
        frames {live.framesPainted}
        {relay ? ` · relay in ${relay.framesIn} drop ${relay.dropped}` : ""}
        {relay?.daemon
          ? ` · daemon drop ${daemonDrops(relay.daemon)}${
              relay.daemon.encoderIdle ? " (idle)" : ""
            }`
          : ""}
      </div>
      <div>
        {live.transport} · {live.tier} · {live.engine || engine}
      </div>
    </div>
  );
}

function daemonDrops(
  daemon: NonNullable<NonNullable<FrameStatsLive["relay"]>["daemon"]>,
): number {
  const dropped = daemon.dropped ?? {};
  return (dropped.dedupe ?? 0) + (dropped.oversize ?? 0) + (dropped.pacer ?? 0);
}
