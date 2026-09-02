import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSyntheticModelDefinition,
  deriveOrgProviderKey,
  isLocalRuntimeEligible,
  isUnsafeHostedOutboundUrl,
  resolveHostModelDefinition,
  resolveOrgModelConfig,
  resolveSyntheticModelSource,
} from "../org-model-config";
import type { ModelDefinition } from "@/shared/types";

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
        scenarioId: " cbx_1 ",
        accessVersion: 2,
        serverIds: ["srv-b", "srv-a", "srv-a"],
      },
    );
    await resolveOrgModelConfig(
      { projectId: "project_org_config_auth_scope" },
      {
        bearerToken: "user-a",
        scenarioId: "cbx_1",
        accessVersion: 2,
        serverIds: ["srv-a", "srv-b"],
      },
    );
    await resolveOrgModelConfig(
      { projectId: "project_org_config_auth_scope" },
      {
        bearerToken: "user-b",
        scenarioId: "cbx_1",
        accessVersion: 2,
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
      scenarioId: "cbx_1",
      accessVersion: 2,
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
  });

  it("returns true for custom providers because they can run locally", () => {
    expect(isLocalRuntimeEligible("custom:my-llm")).toBe(true);
  });
});

/**
 * The Cursor CLI host template seeds `cursor/auto` — a neutral sentinel, not a
 * provider model. `cursor` is a registered `ModelProvider` so the id classifies
 * honestly instead of falling through the bare-id rule to `ollama`, and that
 * registration is exactly what made every provider-resolution path treat it as
 * a BYOK provider needing a configured org key. On prod, a turn sent with
 * `model: "cursor/auto"` came back
 * `provider_not_configured: cursor is not enabled for this project/workspace
 * organization` — a setup error for a key that cannot exist.
 */
const CURSOR_SENTINEL_MODEL: ModelDefinition = {
  id: "cursor/auto",
  name: "Cursor Auto",
  provider: "cursor",
};

describe("runtime-chosen sentinel (cursor/auto) vs org provider resolution", () => {
  it("refuses to derive an org provider key for the sentinel", () => {
    const result = deriveOrgProviderKey(CURSOR_SENTINEL_MODEL);

    // The load-bearing assertion is `ok: false`. `{ ok: true, key: "cursor" }`
    // is what sent the turn to `/stream/org` and produced
    // `provider_not_configured: cursor`.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("cursor/auto");
    expect(result.error).toContain("Cursor Auto");
  });

  it("still derives keys for real providers and custom org providers", () => {
    expect(
      deriveOrgProviderKey({
        id: "claude-3-5-sonnet-latest",
        name: "Claude",
        provider: "anthropic",
      }),
    ).toEqual({ ok: true, key: "anthropic" });
    expect(
      deriveOrgProviderKey({
        id: "custom:my-llm:m1",
        name: "m1",
        provider: "custom",
        customProviderName: "my-llm",
      }),
    ).toEqual({ ok: true, key: "custom:my-llm" });
  });

  it("classifies the sentinel as external-account without resolving any org provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const resolution = await resolveSyntheticModelSource({
      modelDefinition: CURSOR_SENTINEL_MODEL,
      projectId: "proj_1",
      authHeader: "Bearer t",
    });

    expect(resolution.source).toBe("external-account");
    // No org runtime to reuse, and — the point of the fix — no round-trip that
    // could answer `provider_not_configured`.
    expect(resolution.orgRuntime).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gives the sentinel its display name without rewriting the id", () => {
    const definition = buildSyntheticModelDefinition("cursor/auto");

    // The id is what traces and eval metadata record; only the label changes.
    expect(definition.id).toBe("cursor/auto");
    expect(definition.name).toBe("Cursor Auto");
    expect(definition.provider).toBe("cursor");
  });

  it("lifts the host's sentinel WITHOUT the org-model-config round-trip", async () => {
    // `resolveHostModelDefinition` sits between the request and the first token
    // of a live turn, and its org lookup carries a 15 s timeout. Only an
    // enabled org provider that LISTS the id can win there, and none can list
    // `cursor/auto` — so on an external-account harness turn the call was pure
    // latency plus a failure mode, on a turn that needs nothing from the org's
    // model config.
    process.env.CONVEX_HTTP_URL = "https://convex.example/";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const definition = await resolveHostModelDefinition({
      modelId: "cursor/auto",
      // A project id is what ARMS the lookup — without one it is skipped for
      // every id, so the assertion below would prove nothing.
      projectId: "proj_1",
      auth: { bearerToken: "user-a" },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(definition).toMatchObject({
      id: "cursor/auto",
      name: "Cursor Auto",
      provider: "cursor",
    });
  });

  it("still asks the org config for an ordinary host model id", async () => {
    // The bypass is the sentinel's, not every harness host's: a vendor-prefixed
    // id really can belong to an org's OpenRouter selection, and that is the
    // ambiguity the lookup exists to settle.
    process.env.CONVEX_HTTP_URL = "https://convex.example/";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ok: true,
        providers: [
          {
            providerKey: "openrouter",
            enabled: true,
            hasSecret: true,
            secret: "sk-or",
            selectedModels: ["anthropic/claude-sonnet-4.5"],
          },
        ],
      }),
    );

    const definition = await resolveHostModelDefinition({
      modelId: "anthropic/claude-sonnet-4.5",
      projectId: "proj_sentinel_bypass_control",
      auth: { bearerToken: "user-a" },
    });

    expect(fetchSpy).toHaveBeenCalled();
    expect(definition.provider).toBe("openrouter");
  });
});
