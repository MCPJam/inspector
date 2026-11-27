import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { createConvexClients } from "../evals";
import { resolveHostTools } from "../../../utils/built-in-tools/registry";
import { WEB_SEARCH_TOOL_NAME } from "../../../utils/built-in-tools/exa-web-search";
import { createConvexEvidenceReadTransport } from "../../../utils/harness/harness-evidence-reader";

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
  vi.stubEnv("CONVEX_HTTP_URL", "https://example.convex.site");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fetch stub that answers 200 and records each request's headers. */
function recordHeaders() {
  const sent: Array<Record<string, string>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sent.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }),
  );
  return sent;
}

describe("a run's Convex client", () => {
  it("authenticates with each renewal of a renewing bearer", () => {
    const setAuth = vi.spyOn(ConvexHttpClient.prototype, "setAuth");
    let renew: (token: string) => void = () => {};
    createConvexClients({
      current: () => "job-token-1",
      last: () => "job-token-1",
      onRenew: (listener) => {
        renew = listener;
      },
    });
    expect(setAuth).toHaveBeenLastCalledWith("job-token-1");
    renew("job-token-2");
    expect(setAuth).toHaveBeenLastCalledWith("job-token-2");
  });

  it("keeps a plain token for good", () => {
    const setAuth = vi.spyOn(ConvexHttpClient.prototype, "setAuth");
    createConvexClients("plain-token");
    expect(setAuth).toHaveBeenCalledExactlyOnceWith("plain-token");
  });
});

describe("a renewing bearer on a run's other requests", () => {
  it("reaches each built-in web search as it is sent", async () => {
    const sent = recordHeaders();
    let token = "job-token-1";
    const tools = resolveHostTools(
      { builtInToolIds: [WEB_SEARCH_TOOL_NAME] },
      { authHeader: () => token, projectId: "project-1" },
    );
    const search = tools![WEB_SEARCH_TOOL_NAME] as unknown as {
      execute: (
        input: { query: string },
        ctx: { toolCallId: string },
      ) => Promise<unknown>;
    };
    await search.execute({ query: "first" }, { toolCallId: "tc_1" });
    token = "job-token-2";
    await search.execute({ query: "second" }, { toolCallId: "tc_2" });
    expect(sent.map((headers) => headers.Authorization)).toEqual([
      "Bearer job-token-1",
      "Bearer job-token-2",
    ]);
  });

  it("reaches each evidence read as it is sent", async () => {
    const sent = recordHeaders();
    let token = "job-token-1";
    const read = createConvexEvidenceReadTransport(
      async () => `Bearer ${token}`,
    );
    const body = {
      iterationId: "iter-1",
      turnId: "turn-1",
      cursor: null,
      pageSize: 10,
    };
    await read(body);
    token = "job-token-2";
    await read(body);
    expect(sent.map((headers) => headers.authorization)).toEqual([
      "Bearer job-token-1",
      "Bearer job-token-2",
    ]);
  });
});
