import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isLocalRuntimeEligible,
  isUnsafeHostedOutboundUrl,
  resolveOrgModelConfig,
} from "../org-model-config";

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
      { projectId: "project_org_config_auth_scope" },
      {
        bearerToken: "user-a",
        shareToken: " share-1 ",
        serverIds: ["srv-b", "srv-a", "srv-a"],
      },
    );
    await resolveOrgModelConfig(
      { projectId: "project_org_config_auth_scope" },
      {
        bearerToken: "user-a",
        shareToken: "share-1",
        serverIds: ["srv-a", "srv-b"],
      },
    );
    await resolveOrgModelConfig(
      { projectId: "project_org_config_auth_scope" },
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
      projectId: "project_org_config_auth_scope",
      shareToken: "share-1",
      serverIds: ["srv-a", "srv-b"],
    });
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer user-b");
  });
});

describe("isUnsafeHostedOutboundUrl", () => {
  it.each([
    "http://127.0.0.1:11434",
    "http://127.5.6.7",
    "http://localhost",
    "https://localhost:443",
    "http://foo.localhost",
    "http://10.0.0.1",
    "http://10.255.255.255",
    "http://172.16.0.1",
    "http://172.31.255.255",
    "http://192.168.1.1",
    "http://169.254.169.254",
    "http://100.64.0.1",
    "http://0.0.0.0",
    "http://224.0.0.1",
    "http://[::1]",
    "http://[::]",
    "http://[fe80::1]",
    "http://[fc00::1]",
    "http://[fd12:3456::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:10.0.0.1]",
    "http://metadata",
    "http://metadata.google.internal",
    "ftp://example.com/",
    "file:///etc/passwd",
  ])("rejects %s", (url) => {
    expect(isUnsafeHostedOutboundUrl(url)).toBe(true);
  });

  it.each([
    "https://api.openai.com/v1",
    "https://api.anthropic.com",
    "http://my-provider.example.com:8080/v1",
    "https://8.8.8.8",
    "https://[2001:db8::1]",
  ])("allows %s", (url) => {
    expect(isUnsafeHostedOutboundUrl(url)).toBe(false);
  });

  it("treats malformed URLs as unsafe (fail closed)", () => {
    expect(isUnsafeHostedOutboundUrl("not a url")).toBe(true);
    expect(isUnsafeHostedOutboundUrl("")).toBe(true);
  });
});

describe("isLocalRuntimeEligible", () => {
  it("returns true only for ollama", () => {
    expect(isLocalRuntimeEligible("ollama")).toBe(true);
  });

  it("returns false for cloud-only providers (so chat-v2 skips the resolve round-trip)", () => {
    expect(isLocalRuntimeEligible("openai")).toBe(false);
    expect(isLocalRuntimeEligible("anthropic")).toBe(false);
    expect(isLocalRuntimeEligible("azure")).toBe(false);
    expect(isLocalRuntimeEligible("google")).toBe(false);
    expect(isLocalRuntimeEligible("openrouter")).toBe(false);
    expect(isLocalRuntimeEligible("custom:my-llm")).toBe(false);
  });
});
