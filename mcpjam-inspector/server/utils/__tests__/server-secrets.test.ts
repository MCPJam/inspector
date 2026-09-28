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
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: "FORBIDDEN", message: "No access" }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    await expect(
      fetchRuntimeServerSecrets({
        expectedTargetUrl: "https://example.com/mcp",
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-1",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "No access",
    });
  });

  it("requires service authentication for scenario secrets and preserves the viewer bearer", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        success: true,
        headers: { Authorization: "synthetic" },
        // A backend without `boundOrigins` still sends the legacy field; it
        // reduces to the same one-origin binding.
        secretsBoundOrigin: "https://example.com",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const args = {
      expectedTargetUrl: "https://example.com/mcp",
      bearerToken: "tester-token",
      projectId: "project-1",
      serverId: "server-1",
      scenarioId: "scenario-1",
      accessScope: "chat_v2" as const,
    };
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    await expect(fetchRuntimeServerSecrets(args)).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    await expect(fetchRuntimeServerSecrets(args)).resolves.toMatchObject({
      headers: { Authorization: "synthetic" },
    });
    expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({
      Authorization: "Bearer tester-token",
      "x-inspector-service-token": "service-token",
    });

    // The reveal declares where the headers are about to go, and hands the
    // transport the origins the backend bound them to.
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toMatchObject(
      { targetUrl: "https://example.com/mcp" },
    );
    await expect(fetchRuntimeServerSecrets(args)).resolves.toMatchObject({
      boundOrigins: ["https://example.com"],
    });
  });

  it("forwards the backend's refusal for a repointed server", async () => {
    // The origin decision is the backend's; the inspector forwards it with
    // the details the client needs to say why and open the edit form.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            success: false,
            code: "credential_origin_mismatch",
            secretOriginMismatch: true,
            boundOrigin: "https://example.com",
            targetOrigin: "https://other.example",
            error: "Re-enter the credentials for the new address.",
          },
          { status: 403 },
        ),
      ),
    );

    await expect(
      fetchRuntimeServerSecrets({
        expectedTargetUrl: "https://other.example/mcp",
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-1",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      details: {
        secretOriginMismatch: true,
        boundOrigin: "https://example.com",
        targetOrigin: "https://other.example",
        credentialRefusal: "credential_origin_mismatch",
      },
    });
  });

  it("forwards an export-policy refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            success: false,
            code: "export_denied",
            exportDenied: true,
            policy: "credentialExportPolicy",
            error: "Your organization does not allow exporting credentials.",
          },
          { status: 403 },
        ),
      ),
    );

    await expect(
      fetchRuntimeServerSecrets({
        expectedTargetUrl: "https://example.com/mcp",
        bearerToken: "bearer-token",
        projectId: "project-1",
        serverId: "server-1",
      }),
    ).rejects.toMatchObject({
      status: 403,
      details: { exportDenied: true, policy: "credentialExportPolicy" },
    });
  });

  it("requires and unconditionally forwards the service token for DCR", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
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
      }),
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
