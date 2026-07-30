import { describe, expect, it } from "vitest";
import { isInspectorScopeStepUpEvent } from "../inspector-event";

const validEvent = {
  kind: "scope_step_up",
  serverId: "auth-bench",
  toolCallId: "call-1",
  requiredScope: "bench:write",
  resourceMetadataUrl:
    "https://bench.example/.well-known/oauth-protected-resource",
  errorDescription: "Additional access required",
};

describe("isInspectorScopeStepUpEvent", () => {
  it("accepts a valid event", () => {
    expect(isInspectorScopeStepUpEvent(validEvent)).toBe(true);
  });

  it.each([
    null,
    undefined,
    {},
    { ...validEvent, serverId: "" },
    { ...validEvent, serverId: " \t " },
  ])("rejects a missing or blank required field", (value) => {
    expect(isInspectorScopeStepUpEvent(value)).toBe(false);
  });

  it.each([
    ["toolCallId", 1],
    ["requiredScope", null],
    ["resourceMetadataUrl", false],
    ["errorDescription", {}],
  ])("rejects a non-string optional field: %s", (key, value) => {
    expect(
      isInspectorScopeStepUpEvent({ ...validEvent, [key]: value }),
    ).toBe(false);
  });
});
