import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebTestApp, expectJson, postJson } from "./helpers/test-app.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;

describe("web routes — shared server bootstrap", () => {
  const { app, token } = createWebTestApp();

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://test-deployment.convex.site";
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
  });

  it("surfaces a deployment mismatch when the upstream shared-server route is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("No matching routes found", {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        })
      )
    );

    const response = await postJson(
      app,
      "/api/web/server-shares/bootstrap",
      { token: "shared-link-token" },
      token
    );
    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(response);

    expect(status).toBe(404);
    expect(data.code).toBe("NOT_FOUND");
    expect(data.message).toContain("does not expose /server-share/bootstrap");
  });

  it("returns a timeout error when shared-server bootstrap aborts", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await postJson(
      app,
      "/api/web/server-shares/bootstrap",
      { token: "shared-link-token" },
      token
    );
    const { status, data } = await expectJson<{
      code: string;
      message: string;
    }>(response);

    expect(status).toBe(504);
    expect(data).toEqual({
      code: "SERVER_UNREACHABLE",
      message: "Shared server bootstrap service timed out",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://test-deployment.convex.site/server-share/bootstrap",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("returns the shared-server bootstrap payload on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            payload: {
              workspaceId: "ws_1",
              serverId: "srv_1",
              serverName: "Tunnel Server",
              mode: "any_signed_in_with_link",
              viewerIsWorkspaceMember: false,
              useOAuth: false,
              serverUrl: "https://example.ngrok.app/api/mcp/adapter-http/srv_1",
              clientId: null,
              oauthScopes: null,
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      )
    );

    const response = await postJson(
      app,
      "/api/web/server-shares/bootstrap",
      { token: "shared-link-token" },
      token
    );
    const { status, data } = await expectJson<{
      workspaceId: string;
      serverId: string;
      serverName: string;
      mode: string;
      serverUrl: string | null;
    }>(response);

    expect(status).toBe(200);
    expect(data).toMatchObject({
      workspaceId: "ws_1",
      serverId: "srv_1",
      serverName: "Tunnel Server",
      mode: "any_signed_in_with_link",
      serverUrl: "https://example.ngrok.app/api/mcp/adapter-http/srv_1",
    });
  });
});
