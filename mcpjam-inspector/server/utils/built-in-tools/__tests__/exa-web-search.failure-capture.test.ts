/**
 * An Ask MCPJam web search that fails is reported like the turn's own
 * failures; the Playground's search reports nothing new.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../route-error-report.js", () => ({
  reportRouteFailure: vi.fn(() => ({
    normalized: { slug: "internal/unknown" },
    origin: "ambiguous",
    captured: true,
  })),
}));

import { reportRouteFailure } from "../../route-error-report.js";
import { buildExaWebSearchTool } from "../exa-web-search";
import { MCPJAM_AGENT_FAILURE_CAPTURE } from "../../agent-failure-capture";

const report = vi.mocked(reportRouteFailure);

function search(opts: { agent: boolean }) {
  const tool = buildExaWebSearchTool({
    authHeader: "Bearer user-token",
    projectId: "project-1",
    ...(opts.agent
      ? {
          billingFeature: "mcpjam_agent",
          failureCapture: MCPJAM_AGENT_FAILURE_CAPTURE,
        }
      : {}),
  }) as unknown as {
    execute: (
      input: { query: string },
      ctx: { toolCallId: string },
    ) => Promise<{ error?: string; results?: unknown[] }>;
  };
  return tool.execute({ query: "q" }, { toolCallId: "tc_1" });
}

describe("agent web search failure capture", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    report.mockClear();
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("reports a refused search with its refusal, classified", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          code: "platform_capacity",
          scope: "user",
          error: "Budget used up.",
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await search({ agent: true });

    // The model still gets the same answer.
    expect(result.error).toBe("Web search failed (429).");
    expect(report).toHaveBeenCalledTimes(1);
    const [, , options] = report.mock.calls[0]!;
    expect(options).toMatchObject({
      source: "agent.web-search",
      hop: "mcpjam_internal",
      context: { httpStatus: 429, code: "platform_capacity", scope: "user" },
      capture: {
        always: true,
        tags: { surface: "mcpjam_agent", page_class: "routine" },
      },
    });
  });

  it("reports a search that throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const result = await search({ agent: true });
    expect(result.error).toBe("Web search failed. Please try again.");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![2].capture?.tags?.page_class).toBe("incident");
  });

  it("reports a search the backend did not confirm as MCPJam-paid", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
    await search({ agent: true });
    expect(report.mock.calls[0]![2].context).toMatchObject({
      code: "platform_paid_unconfirmed",
    });
  });

  it("reports nothing for the Playground's search", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 500 }));
    const result = await search({ agent: false });
    expect(result.error).toBe("Web search failed (500).");
    expect(report).not.toHaveBeenCalled();
  });
});
