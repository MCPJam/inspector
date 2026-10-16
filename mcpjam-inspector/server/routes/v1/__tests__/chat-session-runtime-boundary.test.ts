import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import runtimeResponse from "./fixtures/host-runtime-config.json";
import { __testing } from "../chat-session-turn";

// Captured from internalGetHostRuntimeConfig in the backend's Convex test.
// Keep the HTTP reader real: mocking its selectedServerIds hid a missing field.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("client-only runtime target boundary", () => {
  it("resolves the server union from the backend HTTP response", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example.com");
    const fetchMock = vi.fn().mockResolvedValue(Response.json(runtimeResponse));
    vi.stubGlobal("fetch", fetchMock);
    const config = runtimeResponse.config;
    const target = await __testing.resolveTarget(
      new ConvexHttpClient("https://backend.convex.cloud"),
      config.executionScope.projectId,
      { hostId: config.hostId },
      { authHeader: "Bearer test-token" },
    );
    expect(target.serverIds).toEqual(config.selectedServerIds);
    expect(target.serverIds).toHaveLength(2);
    expect(target.host?.runtimeConfig.harness).toBe("claude-code");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://backend.example.com/web/host/runtime-config",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ hostId: config.hostId }),
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
        }),
      }),
    );
  });

  it("refuses a backend response with an empty server selection", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ...runtimeResponse,
          config: { ...runtimeResponse.config, selectedServerIds: [] },
        }),
      ),
    );
    await expect(
      __testing.resolveTarget(
        new ConvexHttpClient("https://backend.convex.cloud"),
        runtimeResponse.config.executionScope.projectId,
        { hostId: runtimeResponse.config.hostId },
        { authHeader: "Bearer test-token" },
      ),
    ).rejects.toMatchObject({ status: 422, code: "FEATURE_NOT_SUPPORTED" });
  });
});
