import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOrgModelConfig } from "../org-model-config";

const ORIGINAL_ENV = {
  CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  INSPECTOR_SERVICE_TOKEN: process.env.INSPECTOR_SERVICE_TOKEN,
};

describe("resolveOrgModelConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_ENV.CONVEX_HTTP_URL === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = ORIGINAL_ENV.CONVEX_HTTP_URL;
    }
    if (ORIGINAL_ENV.INSPECTOR_SERVICE_TOKEN === undefined) {
      delete process.env.INSPECTOR_SERVICE_TOKEN;
    } else {
      process.env.INSPECTOR_SERVICE_TOKEN =
        ORIGINAL_ENV.INSPECTOR_SERVICE_TOKEN;
    }
  });

  it("forwards caller auth and scopes the cache by auth context", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example/";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        const auth = new Headers(init?.headers).get("authorization");
        return Response.json({
          ok: true,
          providers: [
            {
              providerKey: "anthropic",
              enabled: true,
              hasSecret: true,
              secret: `secret:${auth}`,
            },
          ],
        });
      });

    await resolveOrgModelConfig(
      { workspaceId: "ws_org_config_auth_scope" },
      {
        bearerToken: "user-a",
        shareToken: " share-1 ",
        serverIds: ["srv-b", "srv-a", "srv-a"],
      },
    );
    await resolveOrgModelConfig(
      { workspaceId: "ws_org_config_auth_scope" },
      {
        bearerToken: "user-a",
        shareToken: "share-1",
        serverIds: ["srv-a", "srv-b"],
      },
    );
    await resolveOrgModelConfig(
      { workspaceId: "ws_org_config_auth_scope" },
      {
        bearerToken: "user-b",
        shareToken: "share-1",
        serverIds: ["srv-a", "srv-b"],
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://convex.example/internal/v1/org-model-config/resolve",
    );
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer user-a");
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
        "X-Inspector-Service-Token",
      ),
    ).toBe("service-token");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      workspaceId: "ws_org_config_auth_scope",
      shareToken: "share-1",
      serverIds: ["srv-a", "srv-b"],
    });
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer user-b");
  });
});
