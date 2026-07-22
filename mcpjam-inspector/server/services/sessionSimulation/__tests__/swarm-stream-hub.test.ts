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
