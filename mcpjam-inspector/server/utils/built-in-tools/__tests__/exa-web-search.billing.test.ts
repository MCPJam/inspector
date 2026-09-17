/**
 * Ask MCPJam's web search is platform-paid, and the service token is what
 * makes that claim credible to Convex.
 *
 * The case that matters is the one that is easy to get wrong: a deployment
 * that asks for platform billing but has no token. Sending the search anyway
 * would not degrade gracefully — it would go through as an ordinary
 * CUSTOMER-PAID search and bill a signed-in user's organization for a feature
 * the product calls free. So the tool refuses before it reaches Convex.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExaWebSearchTool } from "../exa-web-search";

const BILLING_FEATURE = "mcpjam_agent";

function runSearch(opts: {
  billingFeature?: string;
}): Promise<{ error?: string; results?: unknown[] }> {
  const tool = buildExaWebSearchTool({
    authHeader: "Bearer user-token",
    projectId: "project-1",
    chatSessionId: "session-1",
    ...(opts.billingFeature ? { billingFeature: opts.billingFeature } : {}),
  }) as unknown as {
    execute: (
      input: { query: string },
      ctx: { toolCallId: string; abortSignal?: AbortSignal },
    ) => Promise<{ error?: string; results?: unknown[] }>;
  };
  return tool.execute({ query: "what changed in MCP" }, { toolCallId: "tc_1" });
}

describe("exa web search — platform billing attestation", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
    vi.unstubAllEnvs();
  });

  it("refuses rather than billing the customer when the token is missing", async () => {
    // The whole point of the change: never silently fall back onto the
    // customer's credits for a turn the product says is free.
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    const result = await runSearch({ billingFeature: BILLING_FEATURE });
    expect(result.error).toBe("Web search is temporarily unavailable.");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends the claim with the token when it is configured", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-secret");
    await runSearch({ billingFeature: BILLING_FEATURE });
    const call = (global.fetch as unknown as { mock: { calls: any[][] } }).mock
      .calls[0];
    expect(call?.[1]?.headers["x-inspector-service-token"]).toBe(
      "inspector-secret",
    );
    expect(JSON.parse(call?.[1]?.body as string).billingFeature).toBe(
      BILLING_FEATURE,
    );
  });

  it("leaves an unclaimed search alone, token or no token", async () => {
    // The Playground's search: no claim, so no token and no refusal — it is
    // customer-paid by design and must keep working either way.
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    await runSearch({});
    const call = (global.fetch as unknown as { mock: { calls: any[][] } }).mock
      .calls[0];
    expect(call).toBeDefined();
    const body = JSON.parse(call?.[1]?.body as string);
    expect(body.billingFeature).toBeUndefined();
    expect(call?.[1]?.headers["x-inspector-service-token"]).toBeUndefined();
  });
});
