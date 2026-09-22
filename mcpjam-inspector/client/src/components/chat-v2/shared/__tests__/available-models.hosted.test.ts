import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

import { composeAvailableModels } from "../available-models";

describe("composeAvailableModels — hosted mode", () => {
  it("applies the hosted floor after filtering local-only models", () => {
    const models = composeAvailableModels({
      orgConfig: undefined,
      isAuthenticated: true,
      isOllamaRunning: true,
      ollamaModels: [{ id: "llama", name: "llama", provider: "ollama" }],
      hasToken: () => false,
      getOpenRouterSelectedModels: () => [],
      getAzureBaseUrl: () => "",
      customProviders: [],
      hostedCatalog: [],
    });

    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.hosted)).toBe(true);
  });
});
