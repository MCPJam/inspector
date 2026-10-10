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
    ["a bare 429 from a rate limiter", { source: "s", httpStatus: 429 }],
    [
      "a server demanding a grant (v1)",
      { source: "s", httpStatus: 401, code: "OAUTH_REQUIRED" },
    ],
    [
      "the v1 agent answering a self-hosted call",
      { source: "s", httpStatus: 422, code: "FEATURE_NOT_SUPPORTED" },
    ],
    [
      "an unknown job id",
      { source: "s", httpStatus: 404, code: "NOT_FOUND" },
    ],
    // The organization's own AI configuration ("Use your keys for all AI
    // features") saying no — Ask MCPJam is unsupported under the policy.
    [
      "an org that requires its own keys",
      { source: "s", httpStatus: 403, code: "org_keys_required" },
    ],
    [
      "a feature with no org-credential adapter",
      { source: "s", httpStatus: 422, code: "org_runtime_unsupported" },
    ],
    [
      "an org with no model for the role",
      { source: "s", httpStatus: 422, code: "org_model_unconfigured" },
    ],
    [
      "the org's provider rejecting its key",
      { source: "s", httpStatus: 422, code: "provider_auth_failed" },
    ],
    [
      "the org's provider throttling",
      { source: "s", httpStatus: 503, code: "provider_unavailable" },
    ],
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
    // A code outranks the status: these are ours even on a 4xx.
    [
      "MCPJam's own provider key being refused (401)",
      { source: "s", httpStatus: 401, code: "mcpjam_api_error" },
    ],
    [
      "a retired pinned model (400)",
      { source: "s", httpStatus: 400, code: "model_retired" },
    ],
    [
      "an unknown pinned model (400)",
      { source: "s", httpStatus: 400, code: "invalid_model" },
    ],
    [
      "Convex rejecting a request our engine built (400)",
      { source: "s", httpStatus: 400, code: "invalid_request" },
    ],
    [
      "an unlisted code on a 401",
      { source: "s", httpStatus: 401, code: "something_new" },
    ],
    [
      "the backend failing closed on the org's AI policy",
      { source: "s", httpStatus: 503, code: "ai_policy_unavailable" },
    ],
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
