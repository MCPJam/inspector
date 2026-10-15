/**
 * While an organization requires its own AI provider keys, Convex refuses a
 * web search with `{ ok: false, code, error, remediation }` before anything
 * is sent to the search provider. The tool keeps the code so the tool card
 * can say why search is off; every other failure reads as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildExaWebSearchTool,
  webSearchRefusalMessage,
} from "../exa-web-search";

type SearchResult = {
  error?: string;
  code?: string;
  remediation?: string;
  results?: unknown[];
};

function runSearch(opts: { billingFeature?: string } = {}) {
  const tool = buildExaWebSearchTool({
    authHeader: "Bearer user-token",
    projectId: "project-1",
    chatSessionId: "session-1",
    ...(opts.billingFeature ? { billingFeature: opts.billingFeature } : {}),
  }) as unknown as {
    execute: (
      input: { query: string },
      ctx: { toolCallId: string; abortSignal?: AbortSignal },
    ) => Promise<SearchResult>;
  };
  return tool.execute({ query: "what changed in MCP" }, { toolCallId: "tc_1" });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("exa web search — organization AI key policy refusals", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("keeps the code when search can't run on the organization's providers", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      json(422, {
        ok: false,
        code: "org_runtime_unsupported",
        error: "This feature can't run on the organization's providers yet.",
        isRetryable: false,
        remediation: "unsupported",
      }),
    );
    expect(await runSearch()).toEqual({
      error: webSearchRefusalMessage("org_runtime_unsupported"),
      code: "org_runtime_unsupported",
      remediation: "unsupported",
    });
  });

  it("refuses Ask MCPJam's platform route the same way", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        json(422, { ok: false, code: "org_runtime_unsupported", error: "x" }),
      );
    const result = await runSearch({ billingFeature: "mcpjam_agent" });
    expect(result.code).toBe("org_runtime_unsupported");
    expect(result.error).toBe(
      webSearchRefusalMessage("org_runtime_unsupported"),
    );
  });

  it("names the backend's reason for any other policy refusal", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      json(503, {
        ok: false,
        code: "ai_key_policy_unavailable",
        error: "MCPJam could not read the organization's AI settings.",
        remediation: "retry_later",
      }),
    );
    expect(await runSearch()).toEqual({
      error:
        "Web search is unavailable for this organization. MCPJam could not read the organization's AI settings.",
      code: "ai_key_policy_unavailable",
      remediation: "retry_later",
    });
  });

  it("reads an unknown code, or a body without ok: false, as a plain failure", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(json(422, { ok: false, code: "something_new" }))
      .mockResolvedValueOnce(json(403, { code: "org_runtime_unsupported" }))
      .mockResolvedValueOnce(new Response("not json", { status: 500 }));
    expect(await runSearch()).toEqual({ error: "Web search failed (422)." });
    expect(await runSearch()).toEqual({ error: "Web search failed (403)." });
    expect(await runSearch()).toEqual({ error: "Web search failed (500)." });
  });

  it("leaves the out-of-credits answer alone", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        json(402, { ok: false, code: "insufficient_credits" }),
      );
    expect(await runSearch()).toEqual({
      error: "Out of MCPJam credits. Top up to use web search.",
    });
  });
});
