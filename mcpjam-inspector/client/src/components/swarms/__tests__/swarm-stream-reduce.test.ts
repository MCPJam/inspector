import { describe, expect, it } from "vitest";
import {
  reduceSwarmStreamEvent,
  swarmCellKey,
  type JourneyRunStreamState,
} from "../use-journey-run-stream";
import { resolveSwarmCellOutcome } from "../journey-run-results";
import type { SwarmStreamEvent } from "@/shared/swarm-stream-events";
import { swarmEventToEvalPayload } from "@/shared/swarm-stream-events";

function empty(): JourneyRunStreamState {
  return {
    sessions: {},
    cellStatus: {},
    runComplete: false,
    connected: false,
    error: null,
  };
}

function evt(
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

describe("swarmEventToEvalPayload", () => {
  it("strips envelope for turn events", () => {
    const payload = swarmEventToEvalPayload(
      evt({ type: "text_delta", content: "hello" }),
    );
    expect(payload).toEqual({ type: "text_delta", content: "hello" });
  });

  it("returns null for lifecycle events", () => {
    expect(swarmEventToEvalPayload(evt({ type: "session_start" }))).toBeNull();
    expect(
      swarmEventToEvalPayload(evt({ type: "run_complete" })),
    ).toBeNull();
  });
});

describe("reduceSwarmStreamEvent", () => {
  it("tracks attempt_status on the matrix cell key", () => {
    let state = empty();
    state = reduceSwarmStreamEvent(
      state,
      evt({ type: "attempt_status", status: "running" }),
    );
    expect(state.cellStatus[swarmCellKey("host_a", 0)]).toBe("running");
    expect(state.sessions["synth_run_1_host_a_0"]?.attemptStatus).toBe(
      "running",
    );
  });

  it("folds text_delta into the session stream drafts", () => {
    let state = empty();
    state = reduceSwarmStreamEvent(
      state,
      evt({ type: "turn_start", turnIndex: 0, prompt: "draw a dog" }),
    );
    state = reduceSwarmStreamEvent(
      state,
      evt({ type: "text_delta", content: "Sure" }),
    );
    const drafts =
      state.sessions["synth_run_1_host_a_0"]?.stream.draftMessages ?? [];
    expect(drafts[0]).toMatchObject({ role: "user", content: "draw a dog" });
    expect(drafts[1]).toMatchObject({ role: "assistant", content: "Sure" });
  });

  it("marks runComplete on run_complete", () => {
    const state = reduceSwarmStreamEvent(
      empty(),
      evt({
        type: "run_complete",
        hostId: "",
        chatSessionId: "",
        sessionIndex: -1,
      }),
    );
    expect(state.runComplete).toBe(true);
  });
});

describe("resolveSwarmCellOutcome", () => {
  it("prefers live running status", () => {
    expect(
      resolveSwarmCellOutcome({
        liveStatus: "running",
        session: null,
        runStatus: "running",
      }),
    ).toBe("running");
  });

  it("uses Convex failed when no live status", () => {
    expect(
      resolveSwarmCellOutcome({
        session: {
          id: "x",
          chatSessionId: "c",
          projectId: "p",
          hostId: "h",
          startedAt: 0,
          status: "failed",
        },
        runStatus: "completed",
      }),
    ).toBe("failed");
  });

  it("maps completed Convex session to succeeded", () => {
    expect(
      resolveSwarmCellOutcome({
        session: {
          id: "x",
          chatSessionId: "c",
          projectId: "p",
          hostId: "h",
          startedAt: 0,
          status: "completed",
        },
        runStatus: "completed",
      }),
    ).toBe("succeeded");
  });

  it("maps sticky active chat-session to succeeded when the run finished", () => {
    expect(
      resolveSwarmCellOutcome({
        session: {
          id: "x",
          chatSessionId: "c",
          projectId: "p",
          hostId: "h",
          startedAt: 0,
          status: "active",
        },
        runStatus: "completed",
      }),
    ).toBe("succeeded");
  });
});
