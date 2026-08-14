import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import {
  agentAttributionCacheKey,
  agentAttributionHeaders,
  resolveAgentSurface,
  stableAgentAttribution,
  volatileAgentAttribution,
} from "../agent-attribution.js";

/** A Hono context stub carrying only what surface resolution reads. */
function ctx(options: {
  authMethod?: string;
  userAgent?: string;
  apiKeyId?: string;
  requestId?: string;
}): Context {
  const vars: Record<string, unknown> = {
    ...(options.authMethod ? { authMethod: options.authMethod } : {}),
    ...(options.apiKeyId ? { workosApiKeyId: options.apiKeyId } : {}),
    ...(options.requestId
      ? { requestLogContext: { requestId: options.requestId } }
      : {}),
  };
  return {
    get: (key: string) => vars[key],
    req: {
      header: (name: string) =>
        name === "user-agent" ? options.userAgent : undefined,
    },
  } as unknown as Context;
}

describe("resolveAgentSurface", () => {
  it("takes the VERIFIED auth method, whatever the caller typed", () => {
    // A Slack service token IS the Slack bot: the credential that
    // authenticated is not something a caller can choose.
    expect(
      resolveAgentSurface(
        ctx({ authMethod: "slack_service", userAgent: "mcpjam-cli/9.9.9" })
      )
    ).toBe("slack");
    expect(resolveAgentSurface(ctx({ authMethod: "discord_service" }))).toBe(
      "discord"
    );
  });

  it("refuses to believe an EXACT first-party user agent", () => {
    // The attack this guards is impersonation, not appending: `user-agent` is
    // entirely caller-controlled, so any API-key holder can send exactly
    // `mcpjam-cli/1.4.0`. A forgeable label in an audit trail is worse than no
    // label, because it gets believed.
    //
    // The cost is that a GENUINE CLI call also reads `rest` today. That is the
    // honest answer until a server-established channel marker exists.
    expect(resolveAgentSurface(ctx({ userAgent: "mcpjam-cli/1.4.0" }))).toBe(
      "rest"
    );
    expect(
      resolveAgentSurface(ctx({ userAgent: "mcpjam-mcp-worker/0.2.0" }))
    ).toBe("rest");
    expect(
      resolveAgentSurface(ctx({ userAgent: "mcpjam-workspace/1.0" }))
    ).toBe("rest");
  });

  it("falls back to rest, the honest label for a direct API call", () => {
    expect(resolveAgentSurface(ctx({}))).toBe("rest");
    expect(resolveAgentSurface(ctx({ userAgent: "curl/8.4.0" }))).toBe("rest");
  });
});

describe("stableAgentAttribution", () => {
  it("carries the surface and the api key id, and nothing per-request", () => {
    // requestId/agentActionId are absent BY CONSTRUCTION: this attribution is
    // baked into a token cached for ~2h, and a cached request id would label
    // every later write with an earlier request's identity.
    expect(
      stableAgentAttribution(
        ctx({
          authMethod: "slack_service",
          apiKeyId: "key_1",
          requestId: "r1",
        })
      )
    ).toEqual({ surface: "slack", apiKeyId: "key_1" });
  });

  it("omits the key id for a caller that has none", () => {
    expect(stableAgentAttribution(ctx({}))).toEqual({ surface: "rest" });
  });
});

describe("volatileAgentAttribution", () => {
  it("adds the approved action and the executing request", () => {
    expect(
      volatileAgentAttribution(
        ctx({ authMethod: "slack_service", requestId: "req_7" }),
        "act_7"
      )
    ).toEqual({
      surface: "slack",
      agentActionId: "act_7",
      requestId: "req_7",
    });
  });
});

describe("agentAttributionCacheKey", () => {
  it("separates two surfaces sharing one identity", () => {
    // Same user, same org, different surface: they must not share a token, or
    // whichever minted first labels the other's writes.
    expect(
      agentAttributionCacheKey({ surface: "slack", apiKeyId: "key_1" })
    ).not.toBe(
      agentAttributionCacheKey({ surface: "discord", apiKeyId: "key_1" })
    );
  });

  it("separates two api keys on one surface", () => {
    expect(
      agentAttributionCacheKey({ surface: "rest", apiKeyId: "key_1" })
    ).not.toBe(
      agentAttributionCacheKey({ surface: "rest", apiKeyId: "key_2" })
    );
  });
});

describe("agentAttributionHeaders", () => {
  it("emits only the fields that are present", () => {
    expect(agentAttributionHeaders({ surface: "workspace" })).toEqual({
      "x-mcpjam-agent-surface": "workspace",
    });
    expect(
      agentAttributionHeaders({
        surface: "slack",
        apiKeyId: "key_1",
        agentActionId: "act_1",
        requestId: "req_1",
      })
    ).toEqual({
      "x-mcpjam-agent-surface": "slack",
      "x-mcpjam-agent-api-key-id": "key_1",
      "x-mcpjam-agent-action-id": "act_1",
      "x-request-id": "req_1",
    });
  });

  it("emits nothing at all for an absent attribution", () => {
    expect(agentAttributionHeaders(undefined)).toEqual({});
  });
});
