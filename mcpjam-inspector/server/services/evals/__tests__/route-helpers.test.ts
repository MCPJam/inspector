import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mcpjam/sdk", () => ({
  MCPClientManager: class MCPClientManager {},
}));

import { fetchReplayConfig } from "../route-helpers";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;
const ORIGINAL_INSPECTOR_SERVICE_TOKEN = process.env.INSPECTOR_SERVICE_TOKEN;

describe("fetchReplayConfig", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    if (ORIGINAL_INSPECTOR_SERVICE_TOKEN === undefined) {
      delete process.env.INSPECTOR_SERVICE_TOKEN;
    } else {
      process.env.INSPECTOR_SERVICE_TOKEN = ORIGINAL_INSPECTOR_SERVICE_TOKEN;
    }
  });

  it("sends both the user bearer token and inspector service token", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          replayConfig: {
            runId: "run_123",
            suiteId: "suite_123",
            servers: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await fetchReplayConfig("run_123", "user-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://convex.example/internal/v1/evals/runs/replay-config",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer user-token",
          "X-Inspector-Service-Token": "service-token",
        }),
      }),
    );
  });
});
