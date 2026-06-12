/**
 * Contract tests for `resolveSyntheticModelSource` — the synthetic
 * runner's single source of truth for the three-way MCPJam vs cloud-BYOK
 * vs local-BYOK decision.
 *
 * Both `drainAssistantTurn` (turn dispatch) and the synthetic empty-session
 * persist fallback call this helper. Locking the shape here so the two
 * call sites can't drift.
 *
 * Scope: branches that DON'T require the Convex runtime resolver.
 * The local-runtime path (`resolveOrgProviderRuntime` Convex call) lives
 * in the same module as `resolveSyntheticModelSource`, so vitest's module
 * mock can't intercept the internal call (same-module calls bypass the
 * mock). That path is covered transitively by
 * `runner.dispatch.test.ts`, which mocks `resolveSyntheticModelSource`
 * itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelDefinition } from "@/shared/types";
import {
  buildSyntheticModelDefinition,
  matchOrgProviderForModelId,
  resolveHostModelDefinition,
  resolveSyntheticModelSource,
} from "../org-model-config";

describe("resolveSyntheticModelSource", () => {
  it("returns `mcpjam` source with no orgRuntime for MCPJam-catalog models", async () => {
    const result = await resolveSyntheticModelSource({
      modelDefinition: {
        id: "openai/gpt-oss-120b",
        name: "JAM model",
        provider: "openai",
      } as ModelDefinition,
      projectId: "proj-1",
    });

    expect(result).toEqual({ source: "mcpjam" });
  });

  it("returns `byok` + cloud orgRuntime for non-MCPJam providers that aren't local-runtime-eligible (no Convex round-trip)", async () => {
    // anthropic isn't in LOCAL_RUNTIME_ELIGIBLE_PROVIDERS and doesn't start
    // with `custom:`, so the resolver short-circuits to cloud without
    // hitting Convex. The test runs without CONVEX_HTTP_URL set on purpose
    // — if the short-circuit ever regresses, the test will fail with
    // "CONVEX_HTTP_URL is not set" rather than a silent behavior change.
    const result = await resolveSyntheticModelSource({
      modelDefinition: {
        id: "claude-3-5-sonnet-latest",
        name: "Claude",
        provider: "anthropic",
      } as ModelDefinition,
      projectId: "proj-1",
    });

    expect(result.source).toBe("byok");
    expect(result.orgRuntime).toEqual({
      runtimeLocation: "cloud",
      providerKey: "anthropic",
    });
  });

  it("throws on deriveOrgProviderKey failure (e.g. custom provider missing customProviderName)", async () => {
    await expect(
      resolveSyntheticModelSource({
        modelDefinition: {
          id: "custom-thing",
          name: "Custom",
          provider: "custom",
          // intentionally no customProviderName
        } as ModelDefinition,
        projectId: "proj-1",
      }),
    ).rejects.toThrow(/derive org provider key/i);
  });
});

describe("buildSyntheticModelDefinition", () => {
  it("returns the catalog definition unchanged for a SUPPORTED_MODELS id", () => {
    const result = buildSyntheticModelDefinition("openai/gpt-oss-120b");
    expect(result.id).toBe("openai/gpt-oss-120b");
    expect(result.provider).toBe("openai");
    // Catalog hits carry contextLength and other fields the BYOK fallbacks
    // can't derive — locking that round-trip stays intact.
    expect(result.contextLength).toBeDefined();
  });

  it("parses custom:NAME/... into provider='custom' + customProviderName", () => {
    const result = buildSyntheticModelDefinition(
      "custom:my-provider/some-model",
    );
    expect(result).toEqual({
      id: "custom:my-provider/some-model",
      name: "custom:my-provider/some-model",
      provider: "custom",
      customProviderName: "my-provider",
    });
  });

  it("parses picker-minted custom:NAME:MODEL ids — slug stops at the first colon", () => {
    // Both model builders mint `custom:<slug>:<modelId>` (see
    // buildAvailableModels / buildAvailableModelsFromOrgConfig in
    // model-helpers); deriveOrgProviderKey must get back `custom:<slug>`,
    // not `custom:<slug>:<modelId>`.
    const result = buildSyntheticModelDefinition("custom:acme:acme-large");
    expect(result).toEqual({
      id: "custom:acme:acme-large",
      name: "custom:acme:acme-large",
      provider: "custom",
      customProviderName: "acme",
    });
    // Model segment may itself contain a slash.
    expect(
      buildSyntheticModelDefinition("custom:acme:meta/llama-3.1")
        .customProviderName,
    ).toBe("acme");
  });

  it("derives provider from prefix for non-catalog known prefixes", () => {
    expect(
      buildSyntheticModelDefinition("anthropic/claude-3.5-sonnet").provider,
    ).toBe("anthropic");
    expect(
      buildSyntheticModelDefinition("meta-llama/llama-3.1-405b").provider,
    ).toBe("meta");
    expect(
      buildSyntheticModelDefinition("x-ai/grok-4").provider,
    ).toBe("xai");
    expect(
      buildSyntheticModelDefinition("ollama/llama-3:8b").provider,
    ).toBe("ollama");
  });

  it("derives provider='bedrock' for bare Bedrock-shaped ids", () => {
    // Org Bedrock models surface bare inference-profile ids in the picker,
    // so chatbox runtime configs store them without a "bedrock/" prefix.
    expect(
      buildSyntheticModelDefinition(
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      ),
    ).toEqual({
      id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      name: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      provider: "bedrock",
    });
    // No geo prefix
    expect(
      buildSyntheticModelDefinition("amazon.nova-pro-v1:0").provider,
    ).toBe("bedrock");
    // Hyphenated geo prefix
    expect(
      buildSyntheticModelDefinition(
        "us-gov.anthropic.claude-3-5-haiku-20241022-v1:0",
      ).provider,
    ).toBe("bedrock");
    // Legacy ids without a ":N" revision suffix
    expect(buildSyntheticModelDefinition("anthropic.claude-v2").provider).toBe(
      "bedrock",
    );
    expect(
      buildSyntheticModelDefinition("amazon.titan-tg1-large").provider,
    ).toBe("bedrock");
    // Bedrock ARNs (inference profiles, imported models) — any AWS partition
    expect(
      buildSyntheticModelDefinition(
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-pro-v1:0",
      ).provider,
    ).toBe("bedrock");
    expect(
      buildSyntheticModelDefinition(
        "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:inference-profile/us-gov.anthropic.claude-3-5-haiku-20241022-v1:0",
      ).provider,
    ).toBe("bedrock");
  });

  it("falls back to provider='ollama' for bare ids (no slash, no recognized prefix)", () => {
    // Catalog never carries bare ids today, so the realistic BYOK case is
    // an Ollama-style local model stored on a chatbox runtime config.
    const result = buildSyntheticModelDefinition("llama-3:8b");
    expect(result).toEqual({
      id: "llama-3:8b",
      name: "llama-3:8b",
      provider: "ollama",
    });
    // Ollama ids with dots/tags must not be mistaken for Bedrock ids.
    expect(buildSyntheticModelDefinition("llama3.1:8b").provider).toBe(
      "ollama",
    );
    expect(buildSyntheticModelDefinition("qwen2.5:7b-instruct").provider).toBe(
      "ollama",
    );
    expect(buildSyntheticModelDefinition("mistral:latest").provider).toBe(
      "ollama",
    );
  });

  it("falls back to provider='ollama' when the prefix isn't in the catalog map", () => {
    // Unknown-prefix BYOK ids are vanishingly rare in practice but still
    // get a sensible default that deriveOrgProviderKey can act on.
    const result = buildSyntheticModelDefinition(
      "experimentalprovider/some-model",
    );
    expect(result.provider).toBe("ollama");
  });
});

describe("matchOrgProviderForModelId", () => {
  const ORG_CONFIG = {
    providers: [
      { providerKey: "anthropic", apiKey: "sk-x" },
      {
        providerKey: "openrouter",
        apiKey: "sk-or",
        selectedModels: ["anthropic/claude-3.5-sonnet", "qwen/qwen-2.5-72b"],
      },
      {
        providerKey: "bedrock",
        apiKey: "aws",
        selectedModels: ["amazon.nova-micro-v1:0"],
      },
      {
        providerKey: "ollama",
        baseUrl: "http://10.0.0.5:11434",
        modelIds: ["llama3.2"],
      },
      {
        providerKey: "custom:acme",
        baseUrl: "https://llm.acme.dev/v1",
        modelIds: ["acme-large"],
      },
    ],
  };

  it("resolves vendor-prefixed OpenRouter selections to provider='openrouter', not the native vendor", () => {
    // The whole point: `anthropic/claude-3.5-sonnet` as an org OpenRouter
    // selection must NOT route to the org's anthropic key.
    expect(
      matchOrgProviderForModelId(ORG_CONFIG, "anthropic/claude-3.5-sonnet"),
    ).toEqual({
      id: "anthropic/claude-3.5-sonnet",
      name: "anthropic/claude-3.5-sonnet",
      provider: "openrouter",
    });
  });

  it("matches bedrock/ollama list entries to their providers", () => {
    expect(
      matchOrgProviderForModelId(ORG_CONFIG, "amazon.nova-micro-v1:0")
        ?.provider,
    ).toBe("bedrock");
    expect(
      matchOrgProviderForModelId(ORG_CONFIG, "llama3.2")?.provider,
    ).toBe("ollama");
  });

  it("matches custom ids with the custom:<slug>: prefix stripped", () => {
    expect(
      matchOrgProviderForModelId(ORG_CONFIG, "custom:acme:acme-large"),
    ).toEqual({
      id: "custom:acme:acme-large",
      name: "custom:acme:acme-large",
      provider: "custom",
      customProviderName: "acme",
    });
  });

  it("returns null when no provider lists the id", () => {
    expect(
      matchOrgProviderForModelId(ORG_CONFIG, "google/gemini-9000"),
    ).toBeNull();
  });
});

describe("resolveHostModelDefinition", () => {
  const originalConvexHttpUrl = process.env.CONVEX_HTTP_URL;
  const originalInspectorServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;

  afterEach(() => {
    if (originalConvexHttpUrl === undefined) {
      delete process.env.CONVEX_HTTP_URL;
    } else {
      process.env.CONVEX_HTTP_URL = originalConvexHttpUrl;
    }

    if (originalInspectorServiceToken === undefined) {
      delete process.env.INSPECTOR_SERVICE_TOKEN;
    } else {
      process.env.INSPECTOR_SERVICE_TOKEN = originalInspectorServiceToken;
    }

    vi.unstubAllGlobals();
  });

  it("returns the catalog definition without needing a projectId", async () => {
    const result = await resolveHostModelDefinition({
      modelId: "openai/gpt-oss-120b",
    });
    expect(result.provider).toBe("openai");
    expect(result.contextLength).toBeDefined();
  });

  it("resolves custom:-prefixed ids by shape alone (no org fetch)", async () => {
    const result = await resolveHostModelDefinition({
      modelId: "custom:acme:acme-large",
      // No projectId — must still resolve correctly from the id shape.
    });
    expect(result).toEqual({
      id: "custom:acme:acme-large",
      name: "custom:acme:acme-large",
      provider: "custom",
      customProviderName: "acme",
    });
  });

  it("resolves Bedrock-shaped ids by shape alone (no org fetch)", async () => {
    const result = await resolveHostModelDefinition({
      modelId: "amazon.nova-micro-v1:0",
    });
    expect(result.provider).toBe("bedrock");
  });

  it("falls back to shape inference when no projectId is available", async () => {
    const result = await resolveHostModelDefinition({
      modelId: "anthropic/claude-3.5-sonnet",
      projectId: null,
    });
    // Without org config there is no way to know this is an OpenRouter
    // selection — the native-vendor guess is the documented fallback.
    expect(result.provider).toBe("anthropic");
  });

  it("prefers org-config OpenRouter matches over catalog hits for ambiguous ids", async () => {
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    process.env.INSPECTOR_SERVICE_TOKEN = "service-token";

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          providers: [
            {
              providerKey: "openrouter",
              selectedModels: ["anthropic/claude-haiku-4.5"],
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveHostModelDefinition({
      modelId: "anthropic/claude-haiku-4.5",
      projectId: "project-openrouter-catalog-overlap",
      auth: { authHeader: "Bearer user-token" },
    });

    expect(result).toEqual({
      id: "anthropic/claude-haiku-4.5",
      name: "anthropic/claude-haiku-4.5",
      provider: "openrouter",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
