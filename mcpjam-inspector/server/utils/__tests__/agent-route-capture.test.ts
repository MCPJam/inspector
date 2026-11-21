/**
 * Ask MCPJam's route capture: the project-membership refusal is routine, and
 * every other FORBIDDEN (our own platform server's scope refusal, the v1
 * agent's lease checks) still pages.
 */
import { describe, expect, it } from "vitest";
import { agentRouteCapture } from "../agent-failure-capture";
import { PROJECT_ACCESS_REFUSED_CODE } from "../../../shared/agent-failure-class";

const capture = agentRouteCapture("web.mcpjam-agent");

describe("agentRouteCapture", () => {
  it("files the project-membership refusal as routine, under its own code", () => {
    const policy = capture({
      status: 403,
      code: "FORBIDDEN",
      details: { code: PROJECT_ACCESS_REFUSED_CODE },
    });

    expect(policy.tags).toMatchObject({ page_class: "routine" });
    expect(policy.level).toBe("warning");
    expect(policy.fingerprint).toEqual([
      "mcpjam_agent",
      "web.mcpjam-agent",
      PROJECT_ACCESS_REFUSED_CODE,
    ]);
  });

  it.each([
    ["no details", undefined],
    ["another details code", { code: "insufficient_scope" }],
  ])("keeps a FORBIDDEN with %s an incident", (_label, details) => {
    const policy = capture({ status: 403, code: "FORBIDDEN", details });

    expect(policy.tags).toMatchObject({ page_class: "incident" });
    expect(policy.level).toBe("error");
  });
});
