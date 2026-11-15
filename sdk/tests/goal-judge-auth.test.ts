import { afterEach, expect, it, vi } from "vitest";
import { McpjamModelLeaseScope } from "../src/mcpjam-model-lease.js";
import { judge } from "../src/evaluators/judge.js";

const harness = vi.hoisted(() => ({ proxy: undefined as typeof fetch | undefined }));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (options: { fetch?: typeof fetch }) => {
    harness.proxy = options.fetch;
    return () => ({});
  },
}));
vi.mock("ai", () => ({
  generateObject: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
    if (!harness.proxy) throw new Error("Missing proxy fetch");
    await harness.proxy("https://mcpjam-lease.invalid/responses", {
      method: "POST", signal: abortSignal,
      headers: { authorization: "Bearer placeholder" }, body: "{}",
    });
    return { object: { score: 1, reason: "Observed completion", rubricHits: [] } };
  },
}));
afterEach(() => vi.unstubAllGlobals());

it.each(["success", "error", "abort"])("routes refreshing judge auth and releases the caller scope after %s", async (mode) => {
  let token = "first-token";
  const auth = { getAuth: async () => token };
  const scope = new McpjamModelLeaseScope({ auth });
  const requests: { url: string; headers: Headers }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    if (url.endsWith("/model-leases")) return Response.json({
      ok: true, lease: "lease-token", protocol: "openai",
      proxyBaseUrl: "https://proxy.example/openai", expiresAt: Date.now() + 600000, runId: "run-id",
    });
    if (url.includes("proxy.example")) {
      if (mode === "error") throw new Error("Provider failed");
      if (mode === "abort") throw new DOMException("Cancelled", "AbortError");
    }
    return Response.json({ ok: true });
  });
  const evaluator = judge({
    mode: "goalCompletion", id: "goal", model: "mcpjam/openai/gpt-5.4", apiKey: "",
    mcpjamAuth: auth, mcpjamProject: "billing-project", mcpjamLeaseScope: scope,
    baseUrls: { mcpjam: "https://platform.example" },
    modelLimits: { contextWindowTokens: 128000, outputTokens: 4096, supportedModalities: [] },
  });
  const result = evaluator.evaluate({ version: 1, scenario: { title: "Task" }, transcript: { toolCalls: [] }, trace: { messages: [{ role: "user", content: "Do the task" }] } });
  try {
    if (mode === "success") await expect(result).resolves.toMatchObject({ kind: "scored", score: 0.85 });
    else await expect(result).rejects.toThrow(mode === "error" ? "Provider failed" : "Cancelled");
  } finally {
    token = "rotated-token";
    await scope.release();
  }
  expect(requests[0].url).toBe("https://platform.example/api/v1/projects/billing-project/model-leases");
  expect(requests[0].headers.get("authorization")).toBe("Bearer first-token");
  const proxy = requests.find(request => request.url.includes("proxy.example"));
  expect(proxy?.headers.get("authorization")).toBeNull();
  expect(proxy?.headers.get("x-mcpjam-harness-lease")).toBe("lease-token");
  expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer rotated-token");
});

it("refuses simultaneous fixed and renewable credentials through public judge", () => {
  expect(() => judge({ mode: "goalCompletion", id: "goal", model: "mcpjam/openai/gpt-5.4", apiKey: "sk_key", mcpjamAuth: { getAuth: async () => "token" }, modelLimits: { contextWindowTokens: 128000, outputTokens: 4096, supportedModalities: [] } })).toThrow("exactly one");
});
