import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportServerApi } from "../mcp-export-api";

const mocks = vi.hoisted(() => ({
  hosted: false,
  authFetch: vi.fn(),
  webPost: vi.fn(),
}));

vi.mock("@/lib/session-token", () => ({ authFetch: mocks.authFetch }));
vi.mock("@/lib/apis/web/base", () => ({ webPost: mocks.webPost }));
vi.mock("@/lib/apis/web/context", () => ({
  buildServerRequest: (serverId: string) => ({ serverId }),
}));
vi.mock("@/lib/apis/mode-client", () => ({
  runByMode: (handlers: {
    hosted: () => Promise<unknown>;
    local: () => Promise<unknown>;
  }) => (mocks.hosted ? handlers.hosted() : handlers.local()),
}));

describe("capability export cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hosted = false;
    mocks.authFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    mocks.webPost.mockResolvedValue({});
  });

  it("forwards the abort signal to the local request", async () => {
    const controller = new AbortController();
    await exportServerApi("weather", { signal: controller.signal });
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/mcp/export/server", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: "weather" }),
      signal: controller.signal,
    });
  });

  it("forwards the abort signal through the hosted adapter", async () => {
    mocks.hosted = true;
    const controller = new AbortController();
    await exportServerApi("weather", { signal: controller.signal });
    expect(mocks.webPost).toHaveBeenCalledWith(
      "/api/web/export/server",
      { serverId: "weather" },
      { signal: controller.signal },
    );
  });
});
