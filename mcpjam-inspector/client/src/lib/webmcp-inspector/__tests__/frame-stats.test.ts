/**
 * The measurement hook.
 *
 * It is dark by default and it never changes what the pane shows, so nothing
 * about it is user-visible — which is exactly why it needs tests: a percentile
 * that is quietly wrong is worse than no number at all, because it is the
 * number every later change to this pipeline gets judged against.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  frameStatsEnabled,
  frameStatsReport,
  notePainted,
  noteInputSent,
  resetFrameStats,
  resetFrameStatsFlagForTests,
} from "../frame-stats";

const FLAG = "webmcp:frame-stats";

function enable() {
  localStorage.setItem(FLAG, "1");
  resetFrameStatsFlagForTests();
}

describe("frame stats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    localStorage.clear();
    resetFrameStatsFlagForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    resetFrameStatsFlagForTests();
  });

  it("records nothing while the flag is unset", () => {
    expect(frameStatsEnabled()).toBe(false);
    noteInputSent(1);
    notePainted({ ts: 999_000, seq: 2 });
    expect(frameStatsReport()).toEqual({
      captureToPaint: { n: 0, p50: undefined, p95: undefined },
      inputToPaint: { n: 0, p50: undefined, p95: undefined },
    });
  });

  it("treats an empty string as set, since presence is the flag", () => {
    localStorage.setItem(FLAG, "");
    resetFrameStatsFlagForTests();
    // `getItem` returns "" — falsy, but present. Keying on truthiness would
    // make the documented way of turning it on (setting the key) not work.
    expect(frameStatsEnabled()).toBe(true);
  });

  it("stays off, rather than throwing, when localStorage is unavailable", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("access denied");
      });
    try {
      // A private window or a storage-less embedding. This sits in the paint
      // path, so it degrades to off rather than taking the pane with it.
      expect(frameStatsEnabled()).toBe(false);
      expect(() => notePainted({ ts: 1, seq: 1 })).not.toThrow();
    } finally {
      getItem.mockRestore();
    }
  });

  it("records capture→paint from the frame's own timestamp", () => {
    enable();
    notePainted({ ts: 999_988, seq: 1 });
    notePainted({ ts: 999_950, seq: 2 });
    const report = frameStatsReport();
    expect(report.captureToPaint.n).toBe(2);
    expect(report.captureToPaint.p50).toBe(12);
    expect(report.captureToPaint.p95).toBe(50);
  });

  it("settles an input on the first frame NEWER than the one on screen", () => {
    enable();
    noteInputSent(10);
    vi.setSystemTime(1_000_040);
    // Not newer than what was on screen when the gesture went: this frame was
    // already in flight, so it is not the echo.
    notePainted({ ts: 1_000_040, seq: 10 });
    expect(frameStatsReport().inputToPaint.n).toBe(0);

    vi.setSystemTime(1_000_070);
    notePainted({ ts: 1_000_070, seq: 11 });
    const report = frameStatsReport();
    expect(report.inputToPaint.n).toBe(1);
    expect(report.inputToPaint.p50).toBe(70);
  });

  it("settles every gesture still waiting on one qualifying paint", () => {
    enable();
    noteInputSent(5);
    vi.setSystemTime(1_000_020);
    noteInputSent(5);
    vi.setSystemTime(1_000_050);
    notePainted({ ts: 1_000_050, seq: 6 });
    expect(frameStatsReport().inputToPaint.n).toBe(2);
    // …and once settled they are not counted again by a later frame.
    vi.setSystemTime(1_000_060);
    notePainted({ ts: 1_000_060, seq: 7 });
    expect(frameStatsReport().inputToPaint.n).toBe(2);
  });

  it("drops a gesture whose paint never came, rather than recording it late", () => {
    enable();
    noteInputSent(1);
    // A page that simply did not repaint. Counting the eventual unrelated
    // frame as a multi-second "echo" would poison the one percentile this
    // exists to report — and `noteInputSent` cannot expire it, because no
    // further input is coming.
    vi.setSystemTime(1_000_000 + 5_000);
    notePainted({ ts: 1_000_000 + 5_000, seq: 2 });
    expect(frameStatsReport().inputToPaint.n).toBe(0);
    expect(frameStatsReport().captureToPaint.n).toBe(1);
  });

  it("reports p50 and p95 off the collected samples", () => {
    enable();
    for (let i = 1; i <= 100; i += 1) {
      vi.setSystemTime(1_000_000 + i);
      notePainted({ ts: 1_000_000, seq: i });
    }
    const report = frameStatsReport();
    expect(report.captureToPaint.n).toBe(100);
    expect(report.captureToPaint.p50).toBe(50);
    expect(report.captureToPaint.p95).toBe(95);
  });

  it("clears its samples on reset", () => {
    enable();
    notePainted({ ts: 999_990, seq: 1 });
    expect(frameStatsReport().captureToPaint.n).toBe(1);
    resetFrameStats();
    expect(frameStatsReport().captureToPaint.n).toBe(0);
  });

  it("exposes the report on window once enabled", () => {
    enable();
    frameStatsEnabled();
    const hooks = window as unknown as {
      webmcpFrameStats?: () => unknown;
      webmcpFrameStatsReset?: () => void;
    };
    // The only way anyone reads these numbers: a console call on a live pane.
    expect(typeof hooks.webmcpFrameStats).toBe("function");
    expect(typeof hooks.webmcpFrameStatsReset).toBe("function");
  });
});
