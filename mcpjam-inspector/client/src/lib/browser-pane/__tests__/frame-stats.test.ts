/**
 * The pane's measurement instance.
 *
 * Dark for the OVERLAY, live for the numbers: the summary event has to
 * describe every viewer, not the subset who set a `localStorage` key, and the
 * two must not be conflated. The percentiles themselves are pinned by the
 * WebMCP inspector's own suite against the same factory; what these hold is
 * what is different here — the relay stamp, the round trip, the ack, and the
 * rates the overlay draws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PANE_STATS_FLAG,
  createFrameStats,
  paneFrameStats,
} from "../frame-stats";

function make(alwaysRecord = true) {
  const stats = createFrameStats({
    flag: "test:frame-stats",
    alwaysRecord,
  });
  stats.resetFlagForTests();
  return stats;
}

describe("pane frame stats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    localStorage.clear();
    paneFrameStats.resetFlagForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    paneFrameStats.resetFlagForTests();
  });

  it("records with the overlay flag unset", () => {
    const stats = make();
    expect(stats.enabled()).toBe(false);
    stats.notePainted({ relayTs: 999_980, seq: 1 });
    expect(stats.report().captureToPaint.n).toBe(1);
    expect(stats.report().captureToPaint.p50).toBe(20);
  });

  it("records nothing without the flag when alwaysRecord is off", () => {
    const stats = make(false);
    stats.notePainted({ relayTs: 999_980, seq: 1 });
    expect(stats.report().captureToPaint.n).toBe(0);
  });

  it("prefers the relay stamp over the sandbox clock", () => {
    const stats = make();
    // The sandbox's `ts` is a minute out; a pane that used it would report a
    // minute of latency on a healthy stream.
    stats.notePainted({ relayTs: 999_990, ts: 940_000, seq: 1 });
    expect(stats.report().captureToPaint.p50).toBe(10);
  });

  it("settles an input on the first paint that postdates it", () => {
    const stats = make();
    stats.noteInputSent(4);
    vi.setSystemTime(1_000_070);
    // Not newer than the seq on screen when the gesture went: still waiting.
    stats.notePainted({ relayTs: 1_000_060, seq: 4 });
    expect(stats.report().inputToPaint.n).toBe(0);
    stats.notePainted({ relayTs: 1_000_060, seq: 5 });
    expect(stats.report().inputToPaint).toMatchObject({ n: 1, p50: 70 });
  });

  it("closes an ack sample by the seq the client stamped", () => {
    const stats = make();
    stats.noteInputSent(1, 42);
    vi.setSystemTime(1_000_015);
    // An ack for a gesture this pane never sent settles nothing.
    stats.noteInputAck(41);
    expect(stats.report().inputToAck.n).toBe(0);
    stats.noteInputAck(42);
    expect(stats.report().inputToAck).toMatchObject({ n: 1, p50: 15 });
    // And it settles exactly once.
    stats.noteInputAck(42);
    expect(stats.report().inputToAck.n).toBe(1);
  });

  it("reports fps and kbps over a window, not since the start", () => {
    const stats = make();
    for (let i = 0; i < 30; i += 1) {
      vi.setSystemTime(1_000_000 + i * 100);
      stats.noteFrameArrived({ bytes: 1_000 });
    }
    // 30 frames in the last 3s.
    expect(stats.live().fps).toBe(10);
    expect(stats.live().kbps).toBe(80);
    // Ten seconds of silence: the window empties rather than averaging the
    // burst down forever.
    vi.setSystemTime(1_010_000);
    expect(stats.live().fps).toBe(0);
    expect(stats.live().kbps).toBe(0);
  });

  it("keeps the relay's own counters for the overlay", () => {
    const stats = make();
    stats.noteRelayStats({
      framesIn: 12,
      bytes: 900,
      dropped: 3,
      subscribers: 1,
      daemon: { encoderIdle: true },
    });
    expect(stats.live().relay).toMatchObject({ framesIn: 12, dropped: 3 });
    expect(stats.live().relay?.daemon?.encoderIdle).toBe(true);
  });

  it("persists the overlay choice under the pane's own flag", () => {
    expect(paneFrameStats.enabled()).toBe(false);
    paneFrameStats.setEnabled(true);
    expect(localStorage.getItem(BROWSER_PANE_STATS_FLAG)).toBe("1");
    expect(paneFrameStats.enabled()).toBe(true);
    paneFrameStats.setEnabled(false);
    expect(localStorage.getItem(BROWSER_PANE_STATS_FLAG)).toBeNull();
    expect(paneFrameStats.enabled()).toBe(false);
  });

  it("splits capture→paint by the transport that carried each frame", () => {
    const stats = make();
    stats.noteTransport("jpeg-json");
    stats.notePainted({ relayTs: 999_990, seq: 1, rung: "jpeg-json" });
    stats.noteTransport("h264");
    stats.notePainted({ relayTs: 999_995, seq: 2, rung: "h264" });
    const report = stats.report();
    expect(report.byTransport["jpeg-json"]).toMatchObject({ n: 1, p50: 10 });
    expect(report.byTransport.h264).toMatchObject({ n: 1, p50: 5 });
  });
});
