import { describe, expect, it } from "vitest";
import { retainedAppResourcesEligible } from "../retained-app-eligibility";

const chat = { plane: "web-authorized", delivery: "host-tools" as const,
  chatSessionId: "chat", hostRendersApps: true, localExecution: false };
describe("retained App resource eligibility", () => {
  it("allows a hosted client bridge without native-forwarding qualification", () => {
    expect(retainedAppResourcesEligible(chat)).toBe(true);
  });
  it.each([
    { plane: "local-mcp" }, { delivery: "mcp-endpoint" as const },
    { chatSessionId: undefined }, { hostRendersApps: false },
    { scenarioId: "scenario" }, { evalIterationId: "eval" },
    { journeyRunId: "journey" }, { localExecution: true },
  ])("refuses an ineligible surface: %j", (change) => {
    expect(retainedAppResourcesEligible({ ...chat, ...change })).toBe(false);
  });
});
