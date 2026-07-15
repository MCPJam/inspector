import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "@/shared/types";
import {
  buildAvailableModels,
  buildAvailableModelsFromOrgConfig,
  buildModelMenuGroups,
  getDefaultModel,
  getProviderDisplayName,
  isMCPJamProvidedModelMenuItem,
  isOrgProviderAvailable,
} from "../model-helpers";

// A hosted model the backend catalog knows about but the static SUPPORTED_MODELS
// list does NOT — the whole reason this PR exists.
const CATALOG_ONLY: ModelDefinition = {
  id: "newvendor/brand-new-model",
  name: "Brand New Model",
  provider: "newvendor",
  hosted: true,
  guestAllowed: false,
};

const NO_KEYS = {
  hasToken: () => false,
  getOpenRouterSelectedModels: () => [],
  isOllamaRunning: false,
  ollamaModels: [] as ModelDefinition[],
  getAzureBaseUrl: () => "",
  customProviders: [],
};

describe("org model helpers", () => {
  it("prefers Claude Haiku 4.5 as the MCPJam default model", () => {
    expect(
      getDefaultModel([
        {
          id: "anthropic/claude-haiku-4.5",
          name: "Claude Haiku 4.5",
          provider: "anthropic",
        },
        {
          id: "mistralai/mistral-small-2603",
          name: "Mistral Small 4",
          provider: "mistral",
        },
      ]).id,
    ).toBe("anthropic/claude-haiku-4.5");
  });

  it("includes enabled custom providers that do not require an API key", () => {
    const orgConfig = {
      providers: [
        {
          providerKey: "custom:local",
          enabled: true,
          baseUrl: "https://models.example/v1",
          modelIds: ["llama-3"],
          displayName: "Local",
          hasSecret: false,
        },
      ],
    };

    expect(isOrgProviderAvailable(orgConfig, "custom:local")).toBe(true);
    expect(buildAvailableModelsFromOrgConfig(orgConfig)).toContainEqual({
      id: "custom:local:llama-3",
      name: "Local / llama-3",
      provider: "custom",
      customProviderName: "local",
    });
  });

  it("includes Amazon Bedrock selected models when configured with a secret", () => {
    const orgConfig = {
      providers: [
        {
          providerKey: "bedrock",
          enabled: true,
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          selectedModels: [
            "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
            "us.amazon.nova-pro-v1:0",
          ],
          hasSecret: true,
        },
      ],
    };

    expect(isOrgProviderAvailable(orgConfig, "bedrock")).toBe(true);
    const models = buildAvailableModelsFromOrgConfig(orgConfig);
    expect(models).toContainEqual({
      id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      name: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      provider: "bedrock",
    });
    expect(models).toContainEqual({
      id: "us.amazon.nova-pro-v1:0",
      name: "us.amazon.nova-pro-v1:0",
      provider: "bedrock",
    });
  });

  it("omits Amazon Bedrock models when no secret is configured", () => {
    const orgConfig = {
      providers: [
        {
          providerKey: "bedrock",
          enabled: true,
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          selectedModels: ["us.amazon.nova-pro-v1:0"],
          hasSecret: false,
        },
      ],
    };

    expect(isOrgProviderAvailable(orgConfig, "bedrock")).toBe(false);
    expect(
      buildAvailableModelsFromOrgConfig(orgConfig).some(
        (m) => m.provider === "bedrock"
      )
    ).toBe(false);
  });

  it("buildAvailableModels uses the injected hosted catalog as the hosted source", () => {
    const models = buildAvailableModels({ ...NO_KEYS, hostedCatalog: [CATALOG_ONLY] });
    // The catalog-only model surfaces even though it's absent from SUPPORTED_MODELS.
    expect(models).toContainEqual(CATALOG_ONLY);
    // With no BYOK keys, the hosted catalog is the whole cloud list.
    expect(models.every((m) => m.hosted === true)).toBe(true);
  });

  it("buildAvailableModels falls back to the static hosted subset when no catalog is given", () => {
    const models = buildAvailableModels(NO_KEYS);
    // Non-empty, and every static hosted entry classifies as MCPJam-provided.
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => isMCPJamProvidedModelMenuItem(m))).toBe(true);
  });

  it("buildAvailableModelsFromOrgConfig uses the injected catalog for the hosted source", () => {
    const models = buildAvailableModelsFromOrgConfig(
      { providers: [] },
      [CATALOG_ONLY]
    );
    expect(models).toContainEqual(CATALOG_ONLY);
  });

  it("isMCPJamProvidedModelMenuItem trusts the hosted flag for catalog-only ids", () => {
    // Not in the static list, not an own-provider source — the flag decides.
    expect(isMCPJamProvidedModelMenuItem(CATALOG_ONLY)).toBe(true);
    // An own-provider (BYOK) model is never MCPJam-provided even if mis-flagged absent.
    expect(
      isMCPJamProvidedModelMenuItem({
        id: "some/model",
        name: "x",
        provider: "openrouter",
      })
    ).toBe(false);
  });

  it("getProviderDisplayName title-cases unknown catalog providers", () => {
    expect(getProviderDisplayName("arcee-ai")).toBe("Arcee Ai");
    expect(getProviderDisplayName("nvidia")).toBe("Nvidia");
    // Known providers keep their curated names.
    expect(getProviderDisplayName("anthropic")).toBe("Anthropic");
  });

  it("keeps OpenRouter models with provider-prefixed ids under configured providers", () => {
    const groups = buildModelMenuGroups([
      {
        id: "openai/gpt-5-mini",
        name: "GPT-5 Mini (Free)",
        provider: "openai",
      },
      {
        id: "openai/gpt-5-mini",
        name: "openai/gpt-5-mini",
        provider: "openrouter",
      },
    ]);

    expect(groups).toEqual([
      expect.objectContaining({
        provider: "openai",
        providerType: "provided",
      }),
      expect.objectContaining({
        provider: "openrouter",
        providerType: "configured",
      }),
    ]);
  });
});
