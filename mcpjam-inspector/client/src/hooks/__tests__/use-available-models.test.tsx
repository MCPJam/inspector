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
const authState = vi.hoisted(() => ({
  user: null as { id: string } | null,
  isAuthenticated: true,
  isLoading: false,
  currentUser: { isAnonymous: true } as
    | { isAnonymous: boolean }
    | null
    | undefined,
}));
const projectConfigState: { current: unknown } = {
  current: PROJECT_VISIBLE_CONFIG,
};

// Soft reads (billing, credits, quota, notifications) go through useQueries;
// withUseQueries answers them from this mock's useQuery.
vi.mock("convex/react", async () =>
  (await import("@/test/mocks/convex-use-queries")).withUseQueries({
  useConvexAuth: () => ({
    isAuthenticated: authState.isAuthenticated,
    isLoading: authState.isLoading,
  }),
  useQuery: (name: string, args: unknown) => {
    queryCalls.push({ name, args });
    if (args === "skip") return undefined;
    if (name === "users:getCurrentUser") return authState.currentUser;
    if (name === "organizationModelProviders:getVisibleConfigForProject") {
      return projectConfigState.current;
    }
    // Org-wide fallback query intentionally returns nothing — the
    // project-scoped result must be sufficient on its own.
    return undefined;
  },
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
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

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: authState.user, isLoading: false }),
}));

vi.mock("@/hooks/use-hosted-model-catalog", () => ({
  useHostedModelCatalog: () => ({
    hostedCatalog: [
      {
        id: "amazon/nova-pro",
        name: "Amazon Nova Pro",
        provider: "bedrock",
        hosted: true,
        guestAllowed: false,
      },
      {
        id: "amazon/nova-micro-v1",
        name: "Amazon Nova Micro",
        provider: "bedrock",
        hosted: true,
        guestAllowed: true,
      },
    ],
    status: "live",
  }),
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

// The viewer may manage the organization's providers (an admin).
const manageOrgProviders = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-org-models-handoff", () => ({
  useOrgModelsHandoff: () => manageOrgProviders,
}));

import { useAvailableModels } from "../use-available-models";

describe("useAvailableModels", () => {
  beforeEach(() => {
    queryCalls.length = 0;
    authState.user = null;
    authState.isAuthenticated = true;
    authState.isLoading = false;
    authState.currentUser = { isAnonymous: true };
    projectConfigState.current = PROJECT_VISIBLE_CONFIG;
    mockDetectOllamaModels.mockResolvedValue({
      isRunning: false,
      availableModels: [],
    });
    mockDetectOllamaToolCapableModels.mockResolvedValue([]);
  });

  it("locks frontier models for a Convex-authenticated guest without locking standard or BYOK models", () => {
    const { result } = renderHook(() => useAvailableModels());
    const model = (id: string) =>
      result.current.availableModels.find((row) => String(row.id) === id);

    expect(model("amazon/nova-pro")).toMatchObject({
      disabled: true,
      disabledReason: "Sign in to use this frontier model",
    });
    expect(model("amazon/nova-micro-v1")).toBeDefined();
    expect(model("amazon/nova-micro-v1")?.disabled).not.toBe(true);
    expect(model("custom:acme:acme-large")?.disabled).not.toBe(true);
  });

  it("updates frontier locks only when the Convex actor becomes a member", () => {
    const { result, rerender } = renderHook(() => useAvailableModels());
    const novaPro = () =>
      result.current.availableModels.find((row) => row.id === "amazon/nova-pro");

    expect(novaPro()?.disabled).toBe(true);
    authState.user = { id: "workos-user-1" };
    rerender();
    expect(novaPro()?.disabled).toBe(true);

    authState.currentUser = undefined;
    rerender();
    expect(novaPro()?.disabled).toBe(true);

    authState.currentUser = { isAnonymous: false };
    rerender();
    expect(novaPro()?.disabled).not.toBe(true);

    authState.user = null;
    authState.currentUser = { isAnonymous: true };
    rerender();
    expect(novaPro()?.disabled).toBe(true);
  });

  it.each([
    ["guest", { isAnonymous: true }],
    ["unresolved", undefined],
    ["without a readable user row", null],
  ] as const)(
    "keeps frontier locked with a WorkOS user and a %s Convex actor",
    (_name, currentUser) => {
      authState.user = { id: "workos-user-1" };
      authState.currentUser = currentUser;
      const { result } = renderHook(() => useAvailableModels());
      const model = (id: string) =>
        result.current.availableModels.find((row) => String(row.id) === id);

      expect(model("amazon/nova-pro")).toMatchObject({
        disabled: true,
        disabledReason: "Sign in to use this frontier model",
      });
      expect(model("amazon/nova-micro-v1")?.disabled).not.toBe(true);
      expect(model("custom:acme:acme-large")?.disabled).not.toBe(true);
    },
  );

  it("keeps frontier locked while Convex authentication is loading for a WorkOS user", () => {
    authState.user = { id: "workos-user-1" };
    authState.isAuthenticated = false;
    authState.isLoading = true;
    const { result } = renderHook(() => useAvailableModels());
    expect(
      result.current.availableModels.find((row) => row.id === "amazon/nova-pro"),
    ).toMatchObject({ guestAllowed: false });
    expect(
      result.current.availableModels.find((row) => row.id === "amazon/nova-pro")
        ?.disabled,
    ).toBe(true);
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

  it("offers only eligible org models while the organization requires its own keys", () => {
    projectConfigState.current = {
      providers: [
        // The backend's verdict on each connection; the picker only reads it.
        {
          id: "conn_anthropic",
          providerKey: "anthropic",
          enabled: true,
          hasSecret: true,
          policyEligibility: { eligible: true },
        },
        {
          id: "conn_router",
          providerKey: "openrouter",
          enabled: true,
          hasSecret: true,
          selectedModels: ["openai/gpt-4o"],
          policyEligibility: { eligible: false, code: "org_keys_required" },
        },
      ],
      aiKeyPolicy: { requireOrgKeys: true, revision: 1 },
      aiReadiness: {
        requireOrgKeys: true,
        features: [],
        operations: [],
        eligibleConnectionIds: ["conn_anthropic"],
      },
    };

    const { result } = renderHook(() =>
      useAvailableModels({ savedModelIds: ["anthropic/claude-haiku-4.5"] }),
    );

    expect(result.current.requireOrgKeys).toBe(true);
    // An admin's pickers can offer "Add a provider".
    expect(result.current.onManageOrgProviders).toBe(manageOrgProviders);
    const offered = result.current.availableModels.filter((m) => !m.disabled);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((m) => m.orgProvider?.id === "conn_anthropic")).toBe(
      true,
    );
    expect(
      result.current.availableModels.find(
        (m) => String(m.id) === "anthropic/claude-haiku-4.5",
      ),
    ).toMatchObject({
      disabled: true,
      disabledReason: "Choose a model from an organization provider.",
    });
  });

  it("reports no policy for an organization that has not turned it on", () => {
    const { result } = renderHook(() => useAvailableModels());
    expect(result.current.requireOrgKeys).toBe(false);
    // Off the policy the pickers look as they always have: no handoff.
    expect(result.current.onManageOrgProviders).toBeUndefined();
  });
});
