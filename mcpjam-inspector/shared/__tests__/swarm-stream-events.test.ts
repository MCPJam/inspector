import { describe, expect, it } from "vitest";
import {
  swarmEventToEvalPayload,
  type SwarmStreamEvent,
} from "../swarm-stream-events";

describe("swarm-stream-events", () => {
  it("maps tool_call payloads without the envelope", () => {
    const event: SwarmStreamEvent = {
      type: "tool_call",
      runId: "r",
      hostId: "h",
      chatSessionId: "c",
      sessionIndex: 0,
      toolName: "search",
      toolCallId: "tc1",
      args: { q: "dog" },
    };
    expect(swarmEventToEvalPayload(event)).toEqual({
      type: "tool_call",
      toolName: "search",
      toolCallId: "tc1",
      args: { q: "dog" },
    });
  });
});
