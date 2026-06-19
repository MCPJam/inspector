import { describe, expect, it } from "vitest";
import {
  buildAvailableModelsFromOrgConfig,
  buildModelMenuGroups,
  getDefaultModel,
  isOrgProviderAvailable,
} from "../model-helpers";

describe("org model helpers", () => {
  it("prefers Mistral Small 4 as the MCPJam default model", () => {
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
    ).toBe("mistralai/mistral-small-2603");
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
