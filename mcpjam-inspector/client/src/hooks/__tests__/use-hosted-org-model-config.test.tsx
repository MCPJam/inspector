import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHostedOrgModelConfig } from "../use-hosted-org-model-config";

const mockState = vi.hoisted(() => ({
  isAuthenticated: true,
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

describe("useHostedOrgModelConfig", () => {
  beforeEach(() => {
    mockState.isAuthenticated = true;
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
});
