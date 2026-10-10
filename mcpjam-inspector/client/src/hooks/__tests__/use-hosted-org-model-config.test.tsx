import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadedOrgModelConfig,
  PENDING_ORG_MODEL_CONFIG,
  useHostedOrgModelConfig,
} from "../use-hosted-org-model-config";

const mockState = vi.hoisted(() => ({
  isAuthenticated: true,
  isUserReady: true,
  queryResults: new Map<string, unknown>(),
  queryCalls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: mockState.isAuthenticated,
    isLoading: false,
  }),
  useQuery: (name: string, args: unknown) => {
    mockState.queryCalls.push({ name, args });
    if (args === "skip") return undefined;
    return mockState.queryResults.get(name);
  },
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mockState.isUserReady,
}));

describe("useHostedOrgModelConfig", () => {
  beforeEach(() => {
    mockState.isAuthenticated = true;
    mockState.isUserReady = true;
    mockState.queryResults.clear();
    mockState.queryCalls = [];
  });

  it("uses project-scoped config when the project has providers", () => {
    const projectConfig = {
      providers: [{ providerKey: "anthropic", enabled: true, hasSecret: true }],
    };
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfigForProject",
      projectConfig
    );
    mockState.queryResults.set("organizationModelProviders:getVisibleConfig", {
      providers: [{ providerKey: "openai", enabled: true, hasSecret: true }],
    });

    const { result } = renderHook(() =>
      useHostedOrgModelConfig({
        projectId: "project-1",
        organizationId: "org-1",
      })
    );

    expect(result.current).toBe(projectConfig);
  });

  it("falls back to org config when project config is empty", () => {
    const organizationConfig = {
      providers: [{ providerKey: "openai", enabled: true, hasSecret: true }],
    };
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfigForProject",
      { providers: [] }
    );
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfig",
      organizationConfig
    );

    const { result } = renderHook(() =>
      useHostedOrgModelConfig({
        projectId: "project-1",
        organizationId: "org-1",
      })
    );

    expect(result.current).toBe(organizationConfig);
  });

  it("skips hosted config queries while unauthenticated", () => {
    mockState.isAuthenticated = false;

    const { result } = renderHook(() =>
      useHostedOrgModelConfig({
        projectId: "project-1",
        organizationId: "org-1",
      })
    );

    expect(result.current).toBeUndefined();
    expect(mockState.queryCalls).toContainEqual({
      name: "organizationModelProviders:getVisibleConfigForProject",
      args: "skip",
    });
    expect(mockState.queryCalls).toContainEqual({
      name: "organizationModelProviders:getVisibleConfig",
      args: "skip",
    });
  });

  it("skips hosted config queries while the user row is still bootstrapping", () => {
    mockState.isUserReady = false;

    const { result } = renderHook(() =>
      useHostedOrgModelConfig({
        projectId: "project-1",
        organizationId: "org-1",
      })
    );

    expect(result.current).toBeUndefined();
    expect(mockState.queryCalls).toContainEqual({
      name: "organizationModelProviders:getVisibleConfigForProject",
      args: "skip",
    });
    expect(mockState.queryCalls).toContainEqual({
      name: "organizationModelProviders:getVisibleConfig",
      args: "skip",
    });
  });

  it("skips both queries when disabled, even while authenticated with ids", () => {
    // Scenario share-link guests are authenticated (anonymous) but not project
    // members; firing getVisibleConfigForProject would throw and crash the page.
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfigForProject",
      { providers: [{ providerKey: "anthropic", enabled: true }] }
    );

    const { result } = renderHook(() =>
      useHostedOrgModelConfig({
        projectId: "project-1",
        organizationId: "org-1",
        disabled: true,
      })
    );

    expect(result.current).toBeUndefined();
    expect(mockState.queryCalls).toContainEqual({
      name: "organizationModelProviders:getVisibleConfigForProject",
      args: "skip",
    });
    expect(mockState.queryCalls).toContainEqual({
      name: "organizationModelProviders:getVisibleConfig",
      args: "skip",
    });
  });
});

describe("useHostedOrgModelConfig — organization AI key policy", () => {
  const readiness = {
    requireOrgKeys: true,
    features: [],
    operations: [],
    eligibleConnectionIds: [],
  };

  beforeEach(() => {
    mockState.isAuthenticated = true;
    mockState.isUserReady = true;
    mockState.queryResults.clear();
    mockState.queryCalls = [];
  });

  function render() {
    return renderHook(() =>
      useHostedOrgModelConfig({
        projectId: "project-1",
        organizationId: "org-1",
      }),
    ).result.current;
  }

  it("keeps the project's policy and readiness when it lists no providers", () => {
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfigForProject",
      {
        providers: [],
        aiKeyPolicy: { requireOrgKeys: true, revision: 3 },
        aiReadiness: readiness,
      },
    );
    mockState.queryResults.set("organizationModelProviders:getVisibleConfig", {
      providers: [{ providerKey: "openai", enabled: true, hasSecret: true }],
      aiKeyPolicy: { requireOrgKeys: false, revision: 2 },
    });

    const result = render();
    expect(result?.aiKeyPolicy).toEqual({ requireOrgKeys: true, revision: 3 });
    expect(result?.aiReadiness).toBe(readiness);
    expect(result?.providers).toHaveLength(1);
  });

  it("keeps an unresolved project unresolved instead of borrowing org providers", () => {
    const unresolved = { providers: [], unresolved: true };
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfigForProject",
      unresolved,
    );
    mockState.queryResults.set("organizationModelProviders:getVisibleConfig", {
      providers: [{ providerKey: "openai", enabled: true, hasSecret: true }],
    });

    expect(render()).toBe(unresolved);
  });

  it("is pending (never undefined) while both queries are in flight", () => {
    const result = render();
    expect(result).toBe(PENDING_ORG_MODEL_CONFIG);
    expect(result?.pending).toBe(true);
    expect(loadedOrgModelConfig(result)).toBeUndefined();
  });

  it("uses an org answer that requires its keys without waiting for the project", () => {
    const required = {
      providers: [],
      aiKeyPolicy: { requireOrgKeys: true, revision: 1 },
    };
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfig",
      required,
    );

    const result = render();
    expect(result?.pending).toBeUndefined();
    expect(result?.aiKeyPolicy?.requireOrgKeys).toBe(true);
  });

  it("keeps a requiring policy even when the other answer lists providers without one", () => {
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfigForProject",
      { providers: [{ providerKey: "openai", enabled: true, hasSecret: true }] },
    );
    mockState.queryResults.set("organizationModelProviders:getVisibleConfig", {
      providers: [],
      aiKeyPolicy: { requireOrgKeys: true, revision: 4 },
    });

    const result = render();
    expect(result?.providers).toHaveLength(1);
    expect(result?.aiKeyPolicy).toEqual({ requireOrgKeys: true, revision: 4 });
  });

  it("stands in the org answer for a pending project once it carries a policy", () => {
    const organizationConfig = {
      providers: [],
      aiKeyPolicy: { requireOrgKeys: false, revision: 1 },
    };
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfig",
      organizationConfig,
    );

    expect(render()).toBe(organizationConfig);
  });

  it("waits for the org answer when an older project answer is empty", () => {
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfigForProject",
      { providers: [] },
    );

    expect(render()?.pending).toBe(true);
  });

  it("reports a loaded config as itself", () => {
    const config = { providers: [] };
    expect(loadedOrgModelConfig(config)).toBe(config);
    expect(loadedOrgModelConfig(undefined)).toBeUndefined();
  });
});
