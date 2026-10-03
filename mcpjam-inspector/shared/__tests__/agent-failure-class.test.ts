import { describe, expect, it } from "vitest";
import { agentFingerprint, agentPageClass } from "../agent-failure-class";

/**
 * The rule both halves of Ask MCPJam's capture classify with. `routine` pings
 * only on a spike; everything else pings at once.
 */
describe("agentPageClass", () => {
  it.each([
    ["an expired sign-in (401)", { source: "s", httpStatus: 401 }],
    ["a validation error (400)", { source: "s", httpStatus: 400 }],
    ["a validation code", { source: "s", code: "VALIDATION_ERROR" }],
    [
      "the turn cap",
      { source: "s", code: "agent_turn_limit", gatedBy: "user" },
    ],
    [
      "the user's own lane",
      { source: "s", code: "platform_capacity", scope: "user" },
    ],
    [
      "the org's own lane",
      { source: "s", code: "platform_capacity", scope: "organization" },
    ],
    ["a user's own spend limit", { source: "s", code: "user_rate_limit" }],
  ])("is routine for %s", (_label, facts) => {
    expect(agentPageClass(facts)).toBe("routine");
  });

  it.each([
    [
      "MCPJam's platform lane",
      { source: "s", code: "platform_capacity", scope: "platform" },
    ],
    [
      "a lane refusal that names no scope",
      { source: "s", code: "platform_capacity" },
    ],
    [
      "the guard failing closed",
      { source: "s", httpStatus: 503, code: "platform_generation_unavailable" },
    ],
    [
      "our own client's credential being refused",
      {
        source: "s",
        httpStatus: 403,
        code: "agent_billing_rejected",
        reason: "credential_not_allowed",
      },
    ],
    [
      "a billing refusal even on a 400",
      { source: "s", httpStatus: 400, code: "agent_billing_rejected" },
    ],
    ["a 5xx", { source: "s", httpStatus: 502 }],
    ["a throw", { source: "s" }],
    ["an empty stream", { source: "s", code: "provider_empty_response" }],
  ])("is an incident for %s", (_label, facts) => {
    expect(agentPageClass(facts)).toBe("incident");
  });

  it("lets a site force the class", () => {
    expect(
      agentPageClass({ source: "s", httpStatus: 500, pageClass: "routine" }),
    ).toBe("routine");
  });
});

describe("agentFingerprint", () => {
  it("groups by site, code and refusal detail — not by stack or message", () => {
    expect(
      agentFingerprint({
        source: "mcp.chat-v2.backend-stream",
        httpStatus: 429,
        code: "platform_capacity",
        scope: "platform",
      }),
    ).toEqual([
      "mcpjam_agent",
      "mcp.chat-v2.backend-stream",
      "platform_capacity",
      "scope:platform",
    ]);
  });

  it("falls back to the status, then to `throw`", () => {
    expect(agentFingerprint({ source: "s", httpStatus: 502 })[2]).toBe(
      "http_502",
    );
    expect(agentFingerprint({ source: "s" })[2]).toBe("throw");
  });

  it("separates a failure that names a docs server", () => {
    expect(agentFingerprint({ source: "s", serverId: "mcp-spec" })).toContain(
      "server:mcp-spec",
    );
  });
});
