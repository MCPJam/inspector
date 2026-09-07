/**
 * The relay's own accounting.
 *
 * Every number here is one a later step in the viewport wave is judged
 * against, so a counter that is quietly wrong is worse than no counter at all
 * — it makes a regression look like an improvement. What these pin: a frame
 * the socket could not take is COUNTED rather than silently queued, a stats
 * message goes out on a cadence rather than per frame, and the pane's own ping
 * stamp comes back untouched (the one thing that makes rtt measurable across
 * two machines).
 */
import { describe, expect, it, vi } from "vitest";
import {
  createFrameRelayStats,
  pongFor,
} from "../browser-frame-relay-stats";

function build(over: Parameters<typeof createFrameRelayStats>[0] | object = {}) {
  const sent: string[] = [];
  let fire: (() => void) | undefined;
  const stats = createFrameRelayStats({
    send: (payload) => sent.push(payload),
    setTimer: (fn) => {
      fire = fn;
      return 1;
    },
    clearTimer: () => {
      fire = undefined;
    },
    ...over,
  } as Parameters<typeof createFrameRelayStats>[0]);
  return { stats, sent, tick: () => fire?.() };
}

describe("frame relay stats", () => {
  it("counts what it forwarded and what it could not", () => {
    const written: number[] = [];
    const { stats } = build();
    expect(stats.offer(100, () => written.push(1))).toBe(true);
    expect(
      stats.offer(100, () => {
        throw new Error("socket gone");
      }),
    ).toBe(false);
    expect(stats.snapshot()).toMatchObject({
      framesIn: 2,
      framesOut: 1,
      bytes: 100,
      dropped: 1,
    });
    expect(written).toEqual([1]);
  });

  it("drops rather than queues once the socket is behind", () => {
    let buffered = 0;
    const written: number[] = [];
    const { stats } = build({
      bufferedAmount: () => buffered,
      maxBufferedBytes: 1_000,
    });
    stats.offer(10, () => written.push(1));
    buffered = 2_000;
    // A frame nobody can take yet is worth nothing: the NEXT one is the one
    // that shows the current page.
    expect(stats.offer(10, () => written.push(2))).toBe(false);
    buffered = 0;
    expect(stats.offer(10, () => written.push(3))).toBe(true);
    expect(written).toEqual([1, 3]);
    expect(stats.snapshot()).toMatchObject({ framesIn: 3, dropped: 1 });
  });

  it("emits stats on a cadence, not per frame", () => {
    const { stats, sent, tick } = build();
    stats.setSubscribers(2);
    stats.offer(50, () => {});
    stats.offer(50, () => {});
    expect(sent).toEqual([]);
    stats.start();
    tick();
    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: "stats",
      framesIn: 2,
      framesOut: 2,
      bytes: 100,
      dropped: 0,
      subscribers: 2,
    });
  });

  it("merges the daemon's own counters into the same message", () => {
    const { stats, sent, tick } = build();
    stats.mergeDaemon({
      framesIn: 9,
      dropped: { dedupe: 2, oversize: 1, pacer: 0 },
      encoderIdle: true,
    });
    stats.start();
    tick();
    expect(JSON.parse(sent[0]!).daemon).toEqual({
      framesIn: 9,
      dropped: { dedupe: 2, oversize: 1, pacer: 0 },
      encoderIdle: true,
    });
  });

  it("stops emitting once stopped", () => {
    const { stats, sent, tick } = build();
    stats.start();
    stats.stop();
    tick();
    expect(sent).toEqual([]);
  });

  it("survives a send into a socket that has gone away", () => {
    const stats = createFrameRelayStats({
      send: () => {
        throw new Error("gone");
      },
      setTimer: (fn) => {
        fn();
        return 1;
      },
      clearTimer: () => {},
    });
    expect(() => stats.start()).not.toThrow();
  });

  it("echoes the pane's ping stamp and nothing of its own", () => {
    expect(JSON.parse(pongFor({ type: "ping", t: 1234 }))).toEqual({
      type: "pong",
      t: 1234,
    });
    // A pane too old to stamp gets a bare pong rather than a wrong number.
    expect(JSON.parse(pongFor({ type: "ping" }))).toEqual({ type: "pong" });
    expect(JSON.parse(pongFor({ type: "ping", t: "nope" as never }))).toEqual({
      type: "pong",
    });
  });

  it("never reads its own clock into the echo", () => {
    const spy = vi.spyOn(Date, "now");
    pongFor({ type: "ping", t: 5 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
