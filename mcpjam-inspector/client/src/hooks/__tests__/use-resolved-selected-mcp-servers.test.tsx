import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useResolvedSelectedMcpServers } from "../use-resolved-selected-mcp-servers";

const mockState = vi.hoisted(() => ({
  projectServers: {
    serversById: new Map<string, string>(),
    serversByName: new Map<string, string>(),
    isLoading: false,
  },
  appState: {
    selectedMultipleServers: [] as string[],
    servers: {} as Record<string, any>,
  },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => mockState.projectServers,
}));

vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => mockState.appState,
}));

describe("useResolvedSelectedMcpServers", () => {
  beforeEach(() => {
    mockState.projectServers = {
      serversById: new Map<string, string>([
        ["srv_asana", "asana"],
        ["srv_github", "github"],
      ]),
      serversByName: new Map<string, string>([
        ["asana", "srv_asana"],
        ["github", "srv_github"],
      ]),
      isLoading: false,
    };
    mockState.appState = {
      selectedMultipleServers: [],
      servers: {
        asana: {
          connectionStatus: "connected",
          oauthTokens: { access_token: "asana-token" },
        },
        github: {
          connectionStatus: "connected",
          oauthTokens: { access_token: "github-token" },
        },
      },
    };
  });

  it("resolves explicit selected names to server ids and OAuth tokens", () => {
    const { result } = renderHook(() =>
      useResolvedSelectedMcpServers({
        projectId: "proj_1",
        selectedServerNames: ["github"],
      })
    );

    expect(result.current.selectedServerNames).toEqual(["github"]);
    expect(result.current.selectedServerIds).toEqual(["srv_github"]);
    expect(result.current.oauthTokens).toEqual({
      srv_github: "github-token",
    });
    expect(result.current.isReady).toBe(true);
  });

  it("derives Home selection from shared selected/connected server state", () => {
    mockState.appState.selectedMultipleServers = ["asana"];

    const { result } = renderHook(() =>
      useResolvedSelectedMcpServers({ projectId: "proj_1" })
    );

    expect(result.current.selectedServerNames).toEqual(["asana"]);
    expect(result.current.selectedServerIds).toEqual(["srv_asana"]);
    expect(result.current.oauthTokens).toEqual({
      srv_asana: "asana-token",
    });
  });

  it("falls back to all connected servers when shared multi-select is empty", () => {
    const { result } = renderHook(() =>
      useResolvedSelectedMcpServers({ projectId: "proj_1" })
    );

    expect(result.current.selectedServerNames).toEqual(["asana", "github"]);
    expect(result.current.selectedServerIds).toEqual([
      "srv_asana",
      "srv_github",
    ]);
  });
});
