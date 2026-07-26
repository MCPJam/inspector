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
  pickOwnProviderModel,
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

// BACK2-628: the reporter's own-provider list, in the order the picker builds
// it — providers sorted alphabetically, then SUPPORTED_MODELS order within
// each. Own-provider rows are never marked `disabled`, because availability is
// inferred from "the user has a key for this provider", not from what that key
// can actually reach.
const ownProviderModels: ModelDefinition[] = [
  { id: "claude-fable-5", name: "Claude Fable 5", provider: "anthropic" },
  { id: "claude-opus-4-1", name: "Claude Opus 4.1", provider: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" },
];

describe("pickOwnProviderModel", () => {
  it("prefers a known-good model over whatever sorts first", () => {
    const picked = pickOwnProviderModel(ownProviderModels);

    expect(picked?.id).toBe("claude-haiku-4-5");
  });

  it("restores the last own-provider model the user chose", () => {
    const picked = pickOwnProviderModel(ownProviderModels, "gpt-5-mini");

    expect(picked?.id).toBe("gpt-5-mini");
  });

  it("ignores a remembered model that is no longer available", () => {
    const picked = pickOwnProviderModel(ownProviderModels, "mistral-large-latest");

    expect(picked?.id).toBe("claude-haiku-4-5");
  });

  it("ignores a remembered model that is locked", () => {
    const picked = pickOwnProviderModel(
      [
        { ...ownProviderModels[3]!, disabled: true, disabledReason: "locked" },
        ownProviderModels[2]!,
      ],
      "gpt-5-mini"
    );

    expect(picked?.id).toBe("claude-haiku-4-5");
  });

  it("falls back to the first selectable row when nothing is recognized", () => {
    const picked = pickOwnProviderModel([
      { id: "custom:acme:big", name: "Big", provider: "custom" },
      { id: "custom:acme:small", name: "Small", provider: "custom" },
    ]);

    expect(picked?.id).toBe("custom:acme:big");
  });

  it("returns undefined when there is nothing selectable", () => {
    expect(pickOwnProviderModel([])).toBeUndefined();
    expect(
      pickOwnProviderModel([{ ...ownProviderModels[0]!, disabled: true }])
    ).toBeUndefined();
  });
});

describe("getDefaultModel", () => {
  it("does not fall through to list order for a BYOK-only anthropic list", () => {
    const picked = getDefaultModel(ownProviderModels.slice(0, 3));

    expect(picked.id).toBe("claude-haiku-4-5");
  });

  it("still prefers hosted models when they are present", () => {
    const picked = getDefaultModel([
      ...ownProviderModels,
      {
        id: "anthropic/claude-haiku-4.5",
        name: "Claude Haiku 4.5",
        provider: "anthropic",
        hosted: true,
      },
    ]);

    expect(picked.id).toBe("anthropic/claude-haiku-4.5");
  });
});
