import { describe, expect, it, vi, beforeEach } from "vitest";
import { MCP_APPS_CHECK_IDS } from "@mcpjam/sdk";

/**
 * The hosted apps route takes the checks picked before Run. Only ids the apps
 * suite has get through, so a stale or foreign id is a 400, not a run.
 */

const runAppsConformanceMock = vi.hoisted(() => vi.fn());
const authorizeServerMock = vi.hoisted(() => vi.fn());

vi.mock("../auth.js", async () => {
  const { z } = await import("zod");
  return {
    handleRoute: async (c: any, handler: () => Promise<any>) => {
      try {
        return c.json(await handler(), 200);
      } catch (error: any) {
        return c.json(
          { code: error?.code ?? "INTERNAL_ERROR", message: error?.message },
          error?.status ?? 500,
        );
      }
    },
    projectServerSchema: z.object({}).passthrough(),
    authorizeServer: authorizeServerMock,
    toHttpConfig: (_auth: unknown, timeoutMs: number) => ({
      url: "https://example.test/mcp",
      requestInit: { headers: {} },
      timeout: timeoutMs,
    }),
  };
});

// Path is relative to this test file: the route imports `../shared/conformance`
// from routes/web, which is routes/shared/conformance from routes/web/__tests__.
vi.mock("../../shared/conformance", () => ({
  runTasksConformance: vi.fn(),
  runAppsConformance: runAppsConformanceMock,
  runProtocolConformance: vi.fn(),
  startOAuthConformance: vi.fn(),
  completeOAuthConformance: vi.fn(),
  submitOAuthConformanceCode: vi.fn(),
  UnsupportedTransportError: class extends Error {},
  OAuthConformanceSessionNotFoundError: class extends Error {},
  OAuthConformanceSessionFailedError: class extends Error {},
}));

const post = async (body: Record<string, unknown>) => {
  const { default: conformanceWeb } = await import("../conformance.js");
  return conformanceWeb.request("/apps", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify(body),
  });
};

describe("POST /api/web/conformance/apps — picked checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizeServerMock.mockResolvedValue({
      serverConfig: { url: "https://example.test/mcp" },
    });
    runAppsConformanceMock.mockResolvedValue({
      result: { outcome: "passed", checks: [] },
    });
  });

  it("runs every check when none are picked", async () => {
    const res = await post({ projectId: "p1", serverId: "s1" });

    expect(res.status).toBe(200);
    expect(runAppsConformanceMock.mock.calls[0][0]).not.toHaveProperty(
      "checkIds",
    );
  });

  it("passes the picked checks to the run", async () => {
    const picked = [MCP_APPS_CHECK_IDS[0]];
    const res = await post({
      projectId: "p1",
      serverId: "s1",
      checkIds: picked,
    });

    expect(res.status).toBe(200);
    expect(runAppsConformanceMock.mock.calls[0][0].checkIds).toEqual(picked);
  });

  it("rejects a check id the apps suite does not have", async () => {
    const res = await post({
      projectId: "p1",
      serverId: "s1",
      checkIds: ["no-such-check"],
    });

    expect(res.status).toBe(400);
    expect(runAppsConformanceMock).not.toHaveBeenCalled();
  });

  it("rejects an empty pick", async () => {
    const res = await post({ projectId: "p1", serverId: "s1", checkIds: [] });

    expect(res.status).toBe(400);
    expect(runAppsConformanceMock).not.toHaveBeenCalled();
  });
});
