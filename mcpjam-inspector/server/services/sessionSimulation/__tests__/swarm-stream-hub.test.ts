import { describe, expect, it, vi } from "vitest";
import { JourneyRunStreamHub } from "../swarm-stream-hub.js";
import type { SwarmStreamEvent } from "../../../../shared/swarm-stream-events.js";

function event(
  partial: Partial<SwarmStreamEvent> & Pick<SwarmStreamEvent, "type">,
): SwarmStreamEvent {
  return {
    runId: "run_1",
    hostId: "host_a",
    chatSessionId: "synth_run_1_host_a_0",
    sessionIndex: 0,
    ...partial,
  } as SwarmStreamEvent;
}

describe("JourneyRunStreamHub", () => {
  it("fans out live events to subscribers", () => {
    const hub = new JourneyRunStreamHub();
    const seen: string[] = [];
    hub.subscribe((e) => seen.push(e.type));
    hub.emit(event({ type: "session_start" }));
    hub.emit(event({ type: "text_delta", content: "hi" }));
    expect(seen).toEqual(["session_start", "text_delta"]);
  });

  it("replays the ring buffer for late joiners", () => {
    const hub = new JourneyRunStreamHub();
    hub.emit(event({ type: "attempt_status", status: "running" }));
    hub.emit(event({ type: "text_delta", content: "a" }));
    const late: string[] = [];
    hub.subscribe((e) => late.push(e.type));
    expect(late).toEqual(["attempt_status", "text_delta"]);
    hub.emit(event({ type: "turn_finish", turnIndex: 0 }));
    expect(late).toEqual(["attempt_status", "text_delta", "turn_finish"]);
  });

  it("caps the ring buffer at 200 events", () => {
    const hub = new JourneyRunStreamHub();
    for (let i = 0; i < 250; i++) {
      hub.emit(event({ type: "text_delta", content: String(i) }));
    }
    expect(hub.getBuffer()).toHaveLength(200);
    const first = hub.getBuffer()[0] as { type: "text_delta"; content: string };
    expect(first.content).toBe("50");
  });

  it("unsubscribe stops further delivery", () => {
    const hub = new JourneyRunStreamHub();
    const listener = vi.fn();
    const unsub = hub.subscribe(listener);
    hub.emit(event({ type: "session_start" }));
    unsub();
    hub.emit(event({ type: "session_complete", status: "succeeded" }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps live frames out of the ring buffer, coalesced per session", () => {
    const hub = new JourneyRunStreamHub();
    const frame = (sequence: number, chatSessionId = "synth_run_1_host_a_0") =>
      event({
        type: "browser_frame",
        chatSessionId,
        frame: {
          sequence,
          promptIndex: 0,
          toolCallId: "tc-1",
          stepIndex: sequence,
          action: "left_click",
          ts: 1_000 + sequence,
        },
      });

    hub.emit(event({ type: "attempt_status", status: "running" }));
    for (let i = 1; i <= 500; i++) hub.emit(frame(i));
    hub.emit(frame(1, "synth_run_1_host_a_1"));

    // A click-happy agent must not be able to flush lifecycle events out of the
    // ring — that's the whole reason frames get their own channel.
    expect(hub.getBuffer()).toHaveLength(1);
    expect(hub.getBuffer()[0]!.type).toBe("attempt_status");
    // One retained frame per session: the current one. No history.
    expect(hub.getLatestFrames().size).toBe(2);
    const latest = hub.getLatestFrames().get("synth_run_1_host_a_0") as any;
    expect(latest.frame.sequence).toBe(500);
  });

  it("replays the current frame BEFORE the ring, so a post-run joiner sees it", () => {
    const hub = new JourneyRunStreamHub();
    hub.emit(event({ type: "attempt_status", status: "running" }));
    hub.emit(
      event({
        type: "browser_frame",
        frame: {
          sequence: 7,
          promptIndex: 0,
          toolCallId: "tc-1",
          stepIndex: 6,
          action: "type",
          ts: 2_000,
        },
      }),
    );

    const late: string[] = [];
    hub.subscribe((e) => late.push(e.type));
    // Frames FIRST: the SSE route closes the stream on a replayed `run_complete`,
    // so anything after the ring is dropped for a joiner arriving after the run
    // ended — exactly when the retained frame is the only picture there is.
    expect(late).toEqual(["browser_frame", "attempt_status"]);
  });

  it("delivers the retained frame even when run_complete is already buffered", () => {
    const hub = new JourneyRunStreamHub();
    hub.emit(
      event({
        type: "browser_frame",
        frame: {
          sequence: 1,
          promptIndex: 0,
          toolCallId: "tc-1",
          stepIndex: 0,
          action: "left_click",
          ts: 1,
        },
      }),
    );
    hub.emit(event({ type: "run_complete" }));

    // A subscriber that stops listening at `run_complete` — what the route does.
    const seen: string[] = [];
    let closed = false;
    hub.subscribe((e) => {
      if (closed) return;
      seen.push(e.type);
      if (e.type === "run_complete") closed = true;
    });
    expect(seen).toEqual(["browser_frame", "run_complete"]);
  });

  it("still fans out frames live to existing subscribers", () => {
    const hub = new JourneyRunStreamHub();
    const seen: number[] = [];
    hub.subscribe((e) => {
      if (e.type === "browser_frame") seen.push(e.frame.sequence);
    });
    hub.emit(
      event({
        type: "browser_frame",
        frame: {
          sequence: 1,
          promptIndex: 0,
          toolCallId: "tc-1",
          stepIndex: 0,
          action: "left_click",
          ts: 1,
        },
      }),
    );
    expect(seen).toEqual([1]);
  });

  it("bounds retained frames and evicts the least recently updated session", () => {
    // Retention is per session and outlives each session's completion (that is
    // what gives a post-run joiner a picture), so the map grows with a run's
    // session COUNT. Bound it, and evict by recency rather than by which session
    // happened to start first.
    const hub = new JourneyRunStreamHub();
    const frameFor = (session: string, sequence: number) =>
      event({
        type: "browser_frame",
        chatSessionId: session,
        frame: {
          sequence,
          promptIndex: 0,
          toolCallId: `tc-${session}`,
          stepIndex: 0,
          action: "left_click",
          ts: sequence,
        },
      } as Partial<SwarmStreamEvent> & Pick<SwarmStreamEvent, "type">);

    // 64 sessions fill the cap exactly.
    for (let i = 0; i < 64; i++) hub.emit(frameFor(`s-${i}`, 1));
    // Touch the oldest so recency, not insertion order, decides who is dropped.
    hub.emit(frameFor("s-0", 2));
    // One more session pushes past the cap.
    hub.emit(frameFor("s-64", 1));

    const replayed: string[] = [];
    hub.subscribe((e) => {
      if (e.type === "browser_frame") replayed.push(e.chatSessionId);
    });

    expect(replayed).toHaveLength(64);
    // s-1 was the least recently updated, so it went; the re-touched s-0 stayed.
    expect(replayed).not.toContain("s-1");
    expect(replayed).toContain("s-0");
    expect(replayed).toContain("s-64");
  });

  it("subscriber errors do not break emit", () => {
    const hub = new JourneyRunStreamHub();
    hub.subscribe(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    hub.subscribe(ok);
    expect(() => hub.emit(event({ type: "session_start" }))).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
