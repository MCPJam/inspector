import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchRuntimeServerSecrets,
  postToConvexAuthorized,
} from "../server-secrets.js";

const ORIGINAL_CONVEX_HTTP_URL = process.env.CONVEX_HTTP_URL;
const ORIGINAL_SERVICE_TOKEN = process.env.INSPECTOR_SERVICE_TOKEN;

describe("fetchRuntimeServerSecrets", () => {
  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://example.convex.site";
  });

  afterEach(() => {
    if (ORIGINAL_CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_CONVEX_HTTP_URL;
    }
    if (ORIGINAL_SERVICE_TOKEN === undefined) {
      delete process.env.INSPECTOR_SERVICE_TOKEN;
    } else {
      process.env.INSPECTOR_SERVICE_TOKEN = ORIGINAL_SERVICE_TOKEN;
    }
    vi.unstubAllGlobals();
  });

  it("preserves Convex error codes on failed reveals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ code: "FORBIDDEN", message: "No access" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(
      fetchRuntimeServerSecrets({
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-1",
      })
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "No access",
    });
  });

  it("requires and unconditionally forwards the service token for DCR", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    delete process.env.INSPECTOR_SERVICE_TOKEN;
    await expect(
      postToConvexAuthorized({
        path: "/web/xaa/server/dcr-registration",
        bearerToken: "user-token",
        body: { action: "get" },
        serviceName: "DCR",
        requireInspectorServiceToken: true,
      })
    ).rejects.toThrow(/INSPECTOR_SERVICE_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    await postToConvexAuthorized({
      path: "/web/xaa/server/dcr-registration",
      bearerToken: "user-token",
      body: { action: "get" },
      serviceName: "DCR",
      requireInspectorServiceToken: true,
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer user-token",
      "x-inspector-service-token": "service-token",
    });
  });
});
