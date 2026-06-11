import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// The hook must surface org-configured providers (Bedrock, custom BYOK, …)
// exactly like the Playground. These tests run the REAL hook and the REAL
// useHostedOrgModelConfig / buildAvailableModelsFromOrgConfig chain against
// a stubbed Convex query layer, pinning the project-scoped query wiring —
// v1 of this hook queried by organizationId only, so projects without a
// local organizationId mapping silently fell back to free models.

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
      // No organizationId on purpose: the v1 regression case.
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

// Pure pass-throughs in this scenario (authenticated, no local Ollama);
// the real implementations live in use-chat-session, whose module graph
// (PostHog, stores) is too heavy to load under jsdom.
vi.mock("@/hooks/use-chat-session", () => ({
  applyGuestModelLocks: (models: unknown[]) => models,
  appendDetectedLocalOllamaModels: (models: unknown[]) => models,
}));

vi.mock("@/lib/ollama-utils", () => ({
  detectOllamaModels: async () => ({
    isRunning: false,
    availableModels: [],
  }),
  detectOllamaToolCapableModels: async () => [],
}));

import { useHostAgentModels } from "../use-host-agent-models";

describe("useHostAgentModels", () => {
  it("surfaces org Bedrock + custom BYOK models via the project-scoped config, even without a local organizationId", () => {
    const { result } = renderHook(() => useHostAgentModels());
    const ids = result.current.availableModels.map((m) => String(m.id));

    expect(ids).toContain("amazon.nova-micro-v1:0");
    expect(ids).toContain("custom:acme:acme-large");
    // Org-enabled built-in provider models come from the static catalog.
    expect(
      result.current.availableModels.some((m) => m.provider === "anthropic")
    ).toBe(true);
  });

  it("queries the org config by projectId like the Playground does", () => {
    renderHook(() => useHostAgentModels());
    const projectQuery = queryCalls.find(
      (c) =>
        c.name === "organizationModelProviders:getVisibleConfigForProject" &&
        c.args !== "skip"
    );
    expect(projectQuery?.args).toEqual({ projectId: "convex-project-1" });
  });
});
