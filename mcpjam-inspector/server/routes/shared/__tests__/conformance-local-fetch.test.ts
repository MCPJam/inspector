import { afterEach, describe, expect, it, vi } from "vitest";

// CQT-216: local conformance runs stay on HTTP/1.1 through the SDK's
// `http1Fetch`, because on Node 26's HTTP/2 a run that connects and at once
// disconnects crashes the process. Hosted runs keep the pinned transport.
const { http1Fetch, mode } = vi.hoisted(() => ({
  http1Fetch: vi.fn(async () => new Response("ok")),
  mode: { hosted: false },
}));
vi.mock("@mcpjam/sdk/internal/network-proxy", async (original) => ({
  ...(await original<typeof import("@mcpjam/sdk/internal/network-proxy")>()),
  http1Fetch,
}));
vi.mock("../../../config.js", async (original) => ({
  ...(await original<typeof import("../../../config.js")>()),
  get HOSTED_MODE() {
    return mode.hosted;
  },
}));

const { createConformanceFetch } = await import("../conformance.js");

afterEach(() => {
  http1Fetch.mockClear();
  mode.hosted = false;
});

describe("createConformanceFetch", () => {
  it("dials a local run through http1Fetch, with MCPJam's User-Agent", async () => {
    await createConformanceFetch("MCP server")("http://127.0.0.1:1/mcp");

    expect(http1Fetch).toHaveBeenCalledTimes(1);
    const [url, init] = http1Fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1/mcp");
    expect(new Headers(init.headers).get("user-agent")).toBeTruthy();
  });

  it("keeps a hosted run on the pinned transport", async () => {
    mode.hosted = true;

    await expect(
      createConformanceFetch("MCP server")("http://169.254.169.254/mcp"),
    ).rejects.toThrow();
    expect(http1Fetch).not.toHaveBeenCalled();
  });
});
