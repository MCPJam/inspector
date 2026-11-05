import { describe, expect, it } from "vitest";
import { harnessStartupPart, isHarnessStartupPart, isCurrentHarnessStartup } from "../harness-startup";

const binding = { chatSessionId: "chat-a", requestId: "request-b" };

describe("harness startup stream contract", () => {
  it("marks startup phases transient so they stay out of persisted messages", () => {
    expect(harnessStartupPart("computer", binding)).toEqual({
      type: "data-harness-startup", data: { phase: "computer", ...binding }, transient: true,
    });
    expect(isHarnessStartupPart(harnessStartupPart("ready", binding))).toBe(true);
  });
  it("rejects a late event from a prior request or another chat", () => {
    const event = harnessStartupPart("agent", binding);
    expect(isCurrentHarnessStartup(event, binding)).toBe(true);
    expect(isCurrentHarnessStartup(event, { ...binding, requestId: "request-c" })).toBe(false);
    expect(isCurrentHarnessStartup(event, { ...binding, chatSessionId: "chat-b" })).toBe(false);
    expect(isCurrentHarnessStartup(event, { ...binding, requestId: null })).toBe(false);
  });
  it.each([null, {}, { type: "data-harness-startup", data: null },
    { type: "data-harness-startup", data: { phase: "unknown" } },
    { type: "other", data: { phase: "agent" } },
  ])("refuses malformed and unrelated events %j", value => {
    expect(isHarnessStartupPart(value)).toBe(false);
  });
});
