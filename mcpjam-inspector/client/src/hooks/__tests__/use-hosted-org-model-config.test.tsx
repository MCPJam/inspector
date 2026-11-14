import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadedOrgModelConfig,
  PENDING_ORG_MODEL_CONFIG,
  useHostedOrgModelConfig,
} from "../use-hosted-org-model-config";

const mockState = vi.hoisted(() => ({
  isAuthenticated: true,
  isAuthLoading: false,
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
    isLoading: mockState.isAuthLoading,
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
    mockState.isAuthLoading = false;
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
      projectConfig,
    );
    mockState.queryResults.set("organizationModelProviders:getVisibleConfig", {
      providers: [{ providerKey: "openai", enabled: true, hasSecret: true }],
    });

    const { result } = renderHook(() =>
      useHostedOrgModelConfig({
        projectId: "project-1",
        organizationId: "org-1",
      }),
    );

    expect(result.current).toBe(projectConfig);
  });

  it("falls back to org config when project config is empty", () => {
    const organizationConfig = {
      providers: [{ providerKey: "openai", enabled: true, hasSecret: true }],
    };
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfigForProject",
      { providers: [] },
    );
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfig",
      organizationConfig,
    );

    const { result } = renderHook(() =>
      useHostedOrgModelConfig({
        projectId: "project-1",
        organizationId: "org-1",
      }),
    );

    expect(result.current).toBe(organizationConfig);
  });

  it("skips hosted config queries while unauthenticated", () => {
    mockState.isAuthenticated = false;

    const { result } = renderHook(() =>
      useHostedOrgModelConfig({
        projectId: "project-1",
        organizationId: "org-1",
      }),
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

  it("skips hosted config queries, and stays pending, while the user row is still bootstrapping", () => {
    mockState.isUserReady = false;

    const { result } = renderHook(() =>
      useHostedOrgModelConfig({
        projectId: "project-1",
        organizationId: "org-1",
      }),
    );

    // Signed in but the policy can't be read yet: every picker row stays
    // locked rather than offering hosted models before the policy is known.
    expect(result.current).toBe(PENDING_ORG_MODEL_CONFIG);
    expect(mockState.queryCalls).toContainEqual({
      name: "organizationModelProviders:getVisibleConfigForProject",
      args: "skip",
    });
    expect(mockState.queryCalls).toContainEqual({
      name: "organizationModelProviders:getVisibleConfig",
      args: "skip",
    });
  });

  it("is pending while the sign-in is still resolving, with a scope", () => {
    mockState.isAuthenticated = false;
    mockState.isAuthLoading = true;

    const scoped = renderHook(() =>
      useHostedOrgModelConfig({ projectId: "project-1" }),
    ).result.current;
    const unscoped = renderHook(() => useHostedOrgModelConfig({})).result
      .current;

    expect(scoped).toBe(PENDING_ORG_MODEL_CONFIG);
    expect(unscoped).toBeUndefined();
  });

  it("skips both queries when disabled, even while authenticated with ids", () => {
    // Scenario share-link guests are authenticated (anonymous) but not project
    // members; firing getVisibleConfigForProject would throw and crash the page.
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfigForProject",
      { providers: [{ providerKey: "anthropic", enabled: true }] },
    );

    const { result } = renderHook(() =>
      useHostedOrgModelConfig({
        projectId: "project-1",
        organizationId: "org-1",
        disabled: true,
      }),
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

  // PLB-476: a new guest's active project is "none" until its project exists,
  // and the backend rejects any id that is not a Convex project id.
  it.each([
    "none",
    "null",
    "local_abc",
    "123e4567-e89b-12d3-a456-426614174000",
  ])(
    "never sends the placeholder project id %s to the backend",
    (projectId) => {
      mockState.isAuthLoading = true;
      mockState.isAuthenticated = false;
      const whileSigningIn = renderHook(() =>
        useHostedOrgModelConfig({ projectId }),
      ).result.current;
      mockState.isAuthLoading = false;
      mockState.isAuthenticated = true;
      const signedIn = renderHook(() => useHostedOrgModelConfig({ projectId }))
        .result.current;

      expect(mockState.queryCalls).not.toContainEqual({
        name: "organizationModelProviders:getVisibleConfigForProject",
        args: { projectId },
      });
      expect(signedIn).toBeUndefined();
      expect(whileSigningIn).toBeUndefined();
    },
  );

  it("still reads the organization's policy when the project id is a placeholder", () => {
    const organizationConfig = {
      providers: [{ providerKey: "openai", enabled: true, hasSecret: true }],
    };
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfig",
      organizationConfig,
    );
    const scope = { projectId: "local_abc", organizationId: "org-1" };
    mockState.isAuthLoading = true;
    mockState.isAuthenticated = false;
    const whileSigningIn = renderHook(() => useHostedOrgModelConfig(scope))
      .result.current;
    mockState.isAuthLoading = false;
    mockState.isAuthenticated = true;
    const signedIn = renderHook(() => useHostedOrgModelConfig(scope)).result
      .current;

    expect(mockState.queryCalls).not.toContainEqual({
      name: "organizationModelProviders:getVisibleConfigForProject",
      args: { projectId: "local_abc" },
    });
    expect(mockState.queryCalls).toContainEqual({
      name: "organizationModelProviders:getVisibleConfig",
      args: { organizationId: "org-1" },
    });
    expect(whileSigningIn).toBe(PENDING_ORG_MODEL_CONFIG);
    expect(signedIn).toBe(organizationConfig);
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
    mockState.isAuthLoading = false;
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

  it("locks an unresolved project under a strict scoped answer without borrowing providers", () => {
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfigForProject",
      { providers: [], unresolved: true },
    );
    mockState.queryResults.set("organizationModelProviders:getVisibleConfig", {
      providers: [{ providerKey: "openai", enabled: true, hasSecret: true }],
      aiKeyPolicy: { requireOrgKeys: true, revision: 4 },
      aiReadiness: readiness,
    });

    expect(render()).toEqual({
      providers: [],
      unresolved: true,
      aiKeyPolicy: { requireOrgKeys: true, revision: 4 },
      aiReadiness: readiness,
    });
  });

  it("waits for organization policy when the project has only providers", () => {
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfigForProject",
      {
        providers: [{ providerKey: "openai", enabled: true, hasSecret: true }],
      },
    );
    expect(render()).toBe(PENDING_ORG_MODEL_CONFIG);
    mockState.queryResults.set("organizationModelProviders:getVisibleConfig", {
      providers: [],
      aiKeyPolicy: { requireOrgKeys: true, revision: 4 },
    });
    expect(render()?.aiKeyPolicy?.requireOrgKeys).toBe(true);
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
      {
        providers: [{ providerKey: "openai", enabled: true, hasSecret: true }],
      },
    );
    mockState.queryResults.set("organizationModelProviders:getVisibleConfig", {
      providers: [],
      aiKeyPolicy: { requireOrgKeys: true, revision: 4 },
    });

    const result = render();
    expect(result?.providers).toHaveLength(1);
    expect(result?.aiKeyPolicy).toEqual({ requireOrgKeys: true, revision: 4 });
  });

  it("waits for the project owner even when the active organization policy is off", () => {
    const organizationConfig = {
      providers: [],
      aiKeyPolicy: { requireOrgKeys: false, revision: 1 },
    };
    mockState.queryResults.set(
      "organizationModelProviders:getVisibleConfig",
      organizationConfig,
    );

    expect(render()).toBe(PENDING_ORG_MODEL_CONFIG);
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
