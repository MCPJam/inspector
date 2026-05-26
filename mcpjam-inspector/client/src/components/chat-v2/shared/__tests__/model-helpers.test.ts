import { describe, expect, it } from "vitest";
import {
  buildAvailableModelsFromOrgConfig,
  isOrgProviderAvailable,
} from "../model-helpers";

describe("org model helpers", () => {
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
});
