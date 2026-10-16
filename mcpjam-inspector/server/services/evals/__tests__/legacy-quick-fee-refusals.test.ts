import { afterEach, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { Hono } from "hono";
import { LOCAL_EVAL_MODEL } from "../../../test/support/local-eval-model";
import { v1OnError } from "../../../routes/v1/envelope.js";
import { runEvalSuiteWithAiSdk } from "../../evals-runner.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([
  ["platform_fee_refused", 402],
  ["platform_fee_unavailable", 503],
  ["client_upgrade_required", 426],
  ["billing_limit_reached", 403],
] as const)(
  "legacy quick runs stop before model work on %s",
  async (code, status) => {
    const client = new ConvexHttpClient("https://test.convex.cloud");
    vi.spyOn(client, "query").mockResolvedValue({ status: "running" });
    const action = vi.spyOn(client, "action").mockRejectedValue(
      new ConvexError({
        code,
        reason: "insufficient_credits",
        message: "Add credits to run this eval.",
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const manager = {
      getToolsForAiSdk: vi.fn(async () => ({})),
      listTools: vi.fn(async () => ({ tools: [] })),
      getAllToolAnnotations: vi.fn(() => ({})),
      hasCachedToolAnnotations: vi.fn(() => true),
      getConnectionStatus: vi.fn(() => "connected"),
      listServers: vi.fn(() => []),
      getAllToolsMetadata: vi.fn(() => ({})),
      executeTool: vi.fn(),
    };
    const app = new Hono();
    app.onError(v1OnError);
    app.post("/", async () => {
      await runEvalSuiteWithAiSdk({
        suiteId: "suite",
        runId: null,
        config: {
          tests: [
            {
              title: "Case",
              query: "Hello",
              runs: 1,
              ...LOCAL_EVAL_MODEL,
              expectedToolCalls: [],
              testCaseId: "case",
            },
          ],
          environment: { servers: [] },
        },
        modelApiKeys: { openai: "test" },
        convexClient: client,
        convexHttpUrl: "https://test.convex.site",
        convexAuthToken: "token",
        mcpClientManager: manager,
        testCaseId: "case",
      } as Parameters<typeof runEvalSuiteWithAiSdk>[0]);
      return Response.json({ ok: true });
    });
    const response = await app.request("/", { method: "POST" });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ details: { code } });
    expect(action).toHaveBeenCalledWith(
      "testSuites:startQuickRunIteration",
      expect.anything(),
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);
