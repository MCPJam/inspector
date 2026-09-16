import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tokenizer from "../tokenizer";
import { hashGuestSpendIp } from "../../../utils/guest-spend-ip";

vi.mock("../../../utils/logger", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
const tools = { echo: { description: "Repeat a message" } };
const app = new Hono();
app.use("*", async (c, next) => {
  c.mcpClientManager = {
    getToolsForAiSdk: vi.fn().mockResolvedValue(tools),
  } as any;
  await next();
});
app.route("/api/mcp/tokenizer", tokenizer);
let client = 0;
let ip: string;
const fetchMock = vi.fn();
function post(
  path = "count-text",
  headers: Record<string, string> = { "cf-connecting-ip": ip },
) {
  return app.request(`/api/mcp/tokenizer/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(
      path === "count-text"
        ? { text: "hello world", modelId: "gpt-4o" }
        : { selectedServers: ["server"], modelId: "gpt-4o" },
    ),
  });
}
beforeEach(() => {
  ip = `198.51.100.${++client}`;
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.invalid");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "server-secret");
  vi.stubEnv("GUEST_SESSION_HASH_PEPPER", "test-pepper");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockReset()
    .mockImplementation(async () => Response.json({ ok: true, tokenCount: 7 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("tokenizer proxy service boundary", () => {
  it.each(["count-text", "count-tools"])(
    "%s sends server-owned credentials and attested IP hash",
    async (path) => {
      expect(
        (
          await post(path, {
            "cf-connecting-ip": ip,
            "x-inspector-service-token": "forged",
            "x-mcpjam-guest-ip-hash": "forged",
          })
        ).status,
      ).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://backend.invalid/tokenizer/count",
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-inspector-service-token": "server-secret",
            "x-mcpjam-guest-ip-hash": await hashGuestSpendIp(ip),
          }),
        }),
      );
    },
  );
  it("sends the service token even without an attested IP", async () => {
    await post("count-text", { "x-forwarded-for": "untrusted" });
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["x-inspector-service-token"]).toBe("server-secret");
    expect(headers["x-mcpjam-guest-ip-hash"]).toBeUndefined();
  });
  it.each(["count-text", "count-tools"])(
    "%s returns a silent estimate without a service token",
    async (path) => {
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
      const data = await (await post(path)).json();
      expect(data).toEqual(
        path === "count-text"
          ? { ok: true, tokenCount: 3 }
          : {
              ok: true,
              tokenCounts: {
                server: Math.ceil(JSON.stringify(tools).length / 4),
              },
            },
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each([401, 413, 429, 500])(
    "preserves estimates on backend %s without retries",
    async (status) => {
      fetchMock.mockImplementation(async () => new Response(null, { status }));
      expect(await (await post()).json()).toEqual({ ok: true, tokenCount: 3 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
  it("shares a 30/minute fixed window across tokenizer paths, isolates IPs, and resets", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 30; i++)
      expect((await post(i % 2 ? "count-text" : "count-tools")).status).toBe(
        200,
      );
    const response = await post();
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(fetchMock).toHaveBeenCalledTimes(30);
    expect(
      (await post("count-text", { "cf-connecting-ip": "203.0.113.1" })).status,
    ).toBe(200);
    vi.advanceTimersByTime(60000);
    expect((await post()).status).toBe(200);
  });
  it("skips the process limiter without an attested IP", async () => {
    for (let i = 0; i < 31; i++)
      expect(
        (await post("count-text", { "x-forwarded-for": "untrusted" })).status,
      ).toBe(200);
  });
});
