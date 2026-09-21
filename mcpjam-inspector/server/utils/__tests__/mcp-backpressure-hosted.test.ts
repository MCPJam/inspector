import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../config.js", () => ({ HOSTED_MODE: true }));
vi.mock("../logger.js", () => ({ logger: { info: vi.fn() } }));
import { hostedMcpBackpressureFetch } from "../mcp-backpressure.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("hosted MCP admission adapter", () => {
  it("sends only service credentials and authorized scope to Convex", async () => {
    vi.stubEnv("MCPJAM_MCP_BACKPRESSURE_SERVER_IDS", "server-1");
    vi.stubEnv("CONVEX_HTTP_URL", "https://fixture.convex.site");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "fixture-service-token");
    const control = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ allowed: true, retryAfterMs: 0, reason: "ready" }),
      )
      .mockResolvedValueOnce(Response.json({ recorded: true }));
    vi.stubGlobal("fetch", control);
    const upstream = vi.fn(
      async () =>
        new Response("busy", { status: 429, headers: { "Retry-After": "2" } }),
    );
    const wrapped = hostedMcpBackpressureFetch({
      fetch: upstream,
      projectId: "project-1",
      serverId: "server-1",
      userId: "user-1",
    });
    const init = {
      method: "POST",
      headers: { Authorization: "Bearer upstream-fixture" },
      body: JSON.stringify({ method: "tools/call" }),
    };
    expect((await wrapped("https://upstream.example/mcp", init)).status).toBe(
      429,
    );
    expect(upstream).toHaveBeenCalledExactlyOnceWith(
      "https://upstream.example/mcp",
      init,
    );
    expect(control).toHaveBeenCalledTimes(2);
    const [url, request] = control.mock.calls[0];
    expect(url).toBe(
      "https://fixture.convex.site/internal/mcp-backpressure/admit",
    );
    expect(request.headers).toEqual({
      "Content-Type": "application/json",
      "x-inspector-service-token": "fixture-service-token",
    });
    expect(JSON.parse(request.body)).toEqual({
      projectId: "project-1",
      serverId: "server-1",
      userId: "user-1",
    });
    expect(JSON.parse(control.mock.calls[1][1].body)).toMatchObject({
      status: 429,
      retryAfterMs: 2000,
    });
  });
  it("does not install a coordinator for unenrolled connections", () => {
    vi.stubEnv("MCPJAM_MCP_BACKPRESSURE_SERVER_IDS", "other");
    const upstream = vi.fn();
    expect(
      hostedMcpBackpressureFetch({
        fetch: upstream,
        projectId: "p",
        serverId: "s",
      }),
    ).toBe(upstream);
  });
  it("fails closed when enrolled identity is absent", () => {
    vi.stubEnv("MCPJAM_MCP_BACKPRESSURE_SERVER_IDS", "s");
    expect(() =>
      hostedMcpBackpressureFetch({
        fetch: vi.fn(),
        projectId: "p",
        serverId: "s",
      }),
    ).toThrow("mcp_admission_unavailable");
  });
});
