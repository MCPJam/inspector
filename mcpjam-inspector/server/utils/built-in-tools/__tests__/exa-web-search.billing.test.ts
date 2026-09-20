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

/**
 * A Convex answer. `confirm` is the `x-mcpjam-platform-paid` value a backend
 * that honoured the claim stamps; `null` models one that ignored it.
 */
const exaResponse = (confirm: string | null = BILLING_FEATURE) =>
  new Response(JSON.stringify({ results: [{ title: "t", url: "u" }] }), {
    status: 200,
    headers: confirm === null ? {} : { "x-mcpjam-platform-paid": confirm },
  });

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

/** One tool instance, invoked repeatedly — the per-turn scope the latch uses. */
function buildTool(opts: { billingFeature?: string }) {
  const t = buildExaWebSearchTool({
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
  return (n: number) => t.execute({ query: `q${n}` }, { toolCallId: `tc_${n}` });
}

describe("exa web search — platform billing attestation", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    global.fetch = vi.fn().mockResolvedValue(exaResponse());
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

  it("refuses results the backend did not confirm as platform-paid", async () => {
    // Refusing on a missing token covers OUR half only. A backend that
    // predates the claim ignores it, runs the search on the CUSTOMER's
    // allowance and answers an ordinary 200 with results — so without this
    // the model gets its answer and the organization gets the bill.
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-secret");
    global.fetch = vi.fn().mockResolvedValue(exaResponse(null));
    const result = await runSearch({ billingFeature: BILLING_FEATURE });
    expect(result.error).toBe("Web search is temporarily unavailable.");
    expect(result.results).toBeUndefined();
  });

  it("refuses when the backend confirms a DIFFERENT feature", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-secret");
    global.fetch = vi.fn().mockResolvedValue(exaResponse("mcpjam_insights"));
    const result = await runSearch({ billingFeature: BILLING_FEATURE });
    expect(result.error).toBe("Web search is temporarily unavailable.");
  });

  it("returns results when the backend confirms the claim", async () => {
    // The guard must not refuse the searches it exists to allow.
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-secret");
    const result = await runSearch({ billingFeature: BILLING_FEATURE });
    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
  });

  it("returns results for an unclaimed search with no confirmation", async () => {
    // The Playground is customer-paid on purpose and must never be gated on
    // a header it never asked for.
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    global.fetch = vi.fn().mockResolvedValue(exaResponse(null));
    const result = await runSearch({});
    expect(result.error).toBeUndefined();
    expect(result.results).toHaveLength(1);
  });

  it("stops searching for the rest of the turn after a failed attestation", async () => {
    // The header check runs AFTER `fetch`, so without a latch every later
    // search in the same answer is charged to the customer before being
    // refused — one turn can make many. The refusal has to be per-TURN, not
    // per-call, for "we lose at most one search" to be true.
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-secret");
    const fetchMock = vi.fn().mockResolvedValue(exaResponse(null));
    global.fetch = fetchMock;

    const run = buildTool({ billingFeature: BILLING_FEATURE });
    const first = await run(1);
    const second = await run(2);

    expect(first.error).toBe("Web search is temporarily unavailable.");
    expect(second.error).toBe("Web search is temporarily unavailable.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps searching for the whole turn while attestation holds", async () => {
    // The latch must not fire on a healthy turn: every search still goes out.
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-secret");
    const fetchMock = vi.fn().mockImplementation(async () => exaResponse());
    global.fetch = fetchMock;

    const run = buildTool({ billingFeature: BILLING_FEATURE });
    expect((await run(1)).results).toHaveLength(1);
    expect((await run(2)).results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never latches an unclaimed search, even with no confirmation", async () => {
    // The Playground is customer-paid by design; a missing header is not a
    // signal there and must never stop its later searches.
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => exaResponse(null));
    global.fetch = fetchMock;

    const run = buildTool({});
    expect((await run(1)).results).toHaveLength(1);
    expect((await run(2)).results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
