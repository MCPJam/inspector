// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const config = vi.hoisted(() => ({ HOSTED_MODE: true }));
vi.mock("../../../config.js", () => config);
vi.mock("../../../utils/logger", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../../utils/route-error-report.js", () => ({
  readRequestJson: (c: { req: { json(): Promise<unknown> } }) => c.req.json(),
  reportRouteFailure: vi.fn(),
}));
import tokenizer from "../tokenizer.js";

const TOKEN = "tokenizer-route-canary";
const tools = [{ name: "search", description: "Search documents" }];
const fetchMock = vi.fn();
const app = new Hono();
app.use("*", async (c, next) => {
  Object.assign(c, {
    mcpClientManager: { getToolsForAiSdk: async () => tools },
  });
  await next();
});
app.route("/tokenizer", tokenizer);

function post(route: string, data: Record<string, unknown>) {
  return app.request(`/tokenizer/${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-inspector-service-token": "forged",
      "x-forwarded-host": "attacker.example",
    },
    body: JSON.stringify({ modelId: "gpt-4o", ...data }),
  });
}

beforeEach(() => {
  config.HOSTED_MODE = true;
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", TOKEN);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ ok: true, tokenCount: 17 }),
    );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("tokenizer route backend calls", () => {
  it.each(["count-text", "count-tools"])(
    "authenticates hosted %s and ignores incoming destination/auth",
    async (route) => {
      const response = await post(route, {
        text: "hello",
        selectedServers: ["server"],
        url: "https://attacker.example",
      });
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://backend.example/tokenizer/count");
      expect(new Headers(init.headers).get("x-inspector-service-token")).toBe(
        TOKEN,
      );
      expect(init.redirect).toBe("error");
      expect(JSON.stringify(await response.json())).not.toContain(TOKEN);
    },
  );

  it.each(["count-text", "count-tools"])(
    "keeps tokenless %s functional",
    async (route) => {
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
      const response = await post(route, {
        text: "hello",
        selectedServers: ["server"],
      });
      expect(response.status).toBe(200);
      expect(
        new Headers(fetchMock.mock.calls[0][1].headers).has(
          "x-inspector-service-token",
        ),
      ).toBe(false);
    },
  );

  it.each([429, 503, "network"])(
    "preserves text and multi-server estimates without retry storms on %s",
    async (failure) => {
      if (failure === "network")
        fetchMock.mockRejectedValue(new TypeError("fetch failed"));
      else
        fetchMock.mockImplementation(
          async () => new Response(null, { status: failure as number }),
        );
      const text = "Sample text for estimation";
      const textResponse = await post("count-text", { text });
      expect(await textResponse.json()).toEqual({
        ok: true,
        tokenCount: Math.ceil(text.length / 4),
      });
      const toolsResponse = await post("count-tools", {
        selectedServers: ["first", "second", "third"],
      });
      const estimate = Math.ceil(JSON.stringify(tools).length / 4);
      expect(await toolsResponse.json()).toEqual({
        ok: true,
        tokenCounts: { first: estimate, second: estimate, third: estimate },
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    },
  );
});
