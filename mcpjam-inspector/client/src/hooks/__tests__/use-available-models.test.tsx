import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// The shared hook must surface org-configured providers (Bedrock, custom
// BYOK, …) exactly like the Playground. These tests run the REAL hook and
// the REAL composeAvailableModels / buildAvailableModelsFromOrgConfig chain
// against a stubbed Convex query layer, pinning the project-scoped query
// wiring — the pre-consolidation eval hook queried by organizationId only,
// so projects without a local organizationId mapping silently fell back to
// free models.

const PROJECT_VISIBLE_CONFIG = {
  providers: [
    { providerKey: "anthropic", enabled: true, hasSecret: true },
    {
      providerKey: "bedrock",
      enabled: true,
      hasSecret: true,
      selectedModels: ["amazon.nova-micro-v1:0"],
    },
    {
      providerKey: "custom:acme",
      enabled: true,
      hasSecret: true,
      baseUrl: "https://llm.acme.dev/v1",
      displayName: "Acme",
      modelIds: ["acme-large"],
    },
  ],
};

const queryCalls: Array<{ name: string; args: unknown }> = [];

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: (name: string, args: unknown) => {
    queryCalls.push({ name, args });
    if (args === "skip") return undefined;
    if (name === "organizationModelProviders:getVisibleConfigForProject") {
      return PROJECT_VISIBLE_CONFIG;
    }
    // Org-wide fallback query intentionally returns nothing — the
    // project-scoped result must be sufficient on its own.
    return undefined;
  },
}));

const sharedAppState = {
  activeProjectId: "p1",
  projects: {
    p1: {
      id: "p1",
      sharedProjectId: "convex-project-1",
      // No organizationId on purpose: the org-id-only regression case.
      organizationId: undefined as string | undefined,
    },
    p2: {
      id: "p2",
      sharedProjectId: "convex-project-2",
      organizationId: undefined as string | undefined,
    },
  },
};

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => sharedAppState,
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    hasToken: () => false,
    getOpenRouterSelectedModels: () => [],
    getOllamaBaseUrl: () => "http://localhost:11434",
    getAzureBaseUrl: () => "",
  }),
}));

vi.mock("@/hooks/use-custom-providers", () => ({
  useCustomProviders: () => ({ customProviders: [] }),
}));

const { mockDetectOllamaModels, mockDetectOllamaToolCapableModels } =
  vi.hoisted(() => ({
    mockDetectOllamaModels: vi.fn(),
    mockDetectOllamaToolCapableModels: vi.fn(),
  }));

vi.mock("@/lib/ollama-utils", () => ({
  detectOllamaModels: (...args: unknown[]) => mockDetectOllamaModels(...args),
  detectOllamaToolCapableModels: (...args: unknown[]) =>
    mockDetectOllamaToolCapableModels(...args),
}));

import { useAvailableModels } from "../use-available-models";

describe("useAvailableModels", () => {
  beforeEach(() => {
    queryCalls.length = 0;
    mockDetectOllamaModels.mockResolvedValue({
      isRunning: false,
      availableModels: [],
    });
    mockDetectOllamaToolCapableModels.mockResolvedValue([]);
  });

  it("surfaces org Bedrock + custom BYOK models via the project-scoped config, even without a local organizationId", () => {
    const { result } = renderHook(() => useAvailableModels());
    const ids = result.current.availableModels.map((m) => String(m.id));

    expect(ids).toContain("amazon.nova-micro-v1:0");
    expect(ids).toContain("custom:acme:acme-large");
    // Org-enabled built-in provider models come from the static catalog.
    expect(
      result.current.availableModels.some((m) => m.provider === "anthropic")
    ).toBe(true);
  });

  it("queries the org config by projectId like the Playground does", () => {
    renderHook(() => useAvailableModels());
    const projectQuery = queryCalls.find(
      (c) =>
        c.name === "organizationModelProviders:getVisibleConfigForProject" &&
        c.args !== "skip"
    );
    expect(projectQuery?.args).toEqual({ projectId: "convex-project-1" });
  });

  it("scopes the org config to an explicitly passed project instead of the active one", () => {
    renderHook(() => useAvailableModels({ projectId: "p2" }));
    const projectQuery = queryCalls.find(
      (c) =>
        c.name === "organizationModelProviders:getVisibleConfigForProject" &&
        c.args !== "skip"
    );
    expect(projectQuery?.args).toEqual({ projectId: "convex-project-2" });
  });

  it("accepts a Convex/shared project id as the scope (eval surfaces pass convexProjectId)", () => {
    // EvalsTab/CiEvalsTab/run rows carry the Convex id, not the local
    // appState key — the hook must resolve it via sharedProjectId instead
    // of silently missing the project and skipping the org config.
    renderHook(() => useAvailableModels({ projectId: "convex-project-2" }));
    const projectQuery = queryCalls.find(
      (c) =>
        c.name === "organizationModelProviders:getVisibleConfigForProject" &&
        c.args !== "skip"
    );
    expect(projectQuery?.args).toEqual({ projectId: "convex-project-2" });
  });

  it("keeps an explicit Convex/shared project id even before appState has the project row", () => {
    // Run rows can arrive with a Convex project id before that project is
    // present in appState.projects. The hook should still issue the
    // project-scoped org config query with the id it was given.
    renderHook(() =>
      useAvailableModels({ projectId: "convex-project-not-loaded" }),
    );
    const projectQuery = queryCalls.find(
      (c) =>
        c.name === "organizationModelProviders:getVisibleConfigForProject" &&
        c.args !== "skip",
    );
    expect(projectQuery?.args).toEqual({
      projectId: "convex-project-not-loaded",
    });
  });

  it("appends locally-detected tool-capable Ollama models to the org list", async () => {
    mockDetectOllamaModels.mockResolvedValue({
      isRunning: true,
      availableModels: ["llama3.2"],
    });
    mockDetectOllamaToolCapableModels.mockResolvedValue(["llama3.2"]);

    const { result } = renderHook(() => useAvailableModels());

    await waitFor(() => {
      const ollama = result.current.availableModels.find(
        (m) => String(m.id) === "llama3.2"
      );
      expect(ollama).toBeDefined();
      expect(ollama?.provider).toBe("ollama");
      expect(ollama?.disabled).toBe(false);
    });
    // Org models are still present alongside the local append.
    expect(
      result.current.availableModels.map((m) => String(m.id))
    ).toContain("amazon.nova-micro-v1:0");
  });
});
