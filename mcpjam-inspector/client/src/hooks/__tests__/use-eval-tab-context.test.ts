import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEvalTabContext } from "../use-eval-tab-context";

const mocks = vi.hoisted(() => ({
  useSharedAppState: vi.fn(),
  useWorkspaceMembers: vi.fn(),
  useAvailableEvalModels: vi.fn(),
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: mocks.useSharedAppState,
}));

vi.mock("@/hooks/useWorkspaces", () => ({
  useWorkspaceMembers: mocks.useWorkspaceMembers,
}));

vi.mock("@/hooks/use-available-eval-models", () => ({
  useAvailableEvalModels: mocks.useAvailableEvalModels,
}));

describe("useEvalTabContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useSharedAppState.mockReturnValue({
      servers: {
        connected: { connectionStatus: "connected" },
        disconnected: { connectionStatus: "disconnected" },
      },
    });
    mocks.useAvailableEvalModels.mockReturnValue({ availableModels: [] });
  });

  it("always surfaces suite deletion while keeping run deletion on member-management rights", () => {
    mocks.useWorkspaceMembers.mockReturnValue({
      members: [],
      canManageMembers: false,
    });

    const { result } = renderHook(() =>
      useEvalTabContext({
        isAuthenticated: true,
        workspaceId: "workspace-1",
      }),
    );

    expect(result.current.canDeleteSuite).toBe(true);
    expect(result.current.canDeleteRuns).toBe(false);
    expect(result.current.connectedServerNames).toEqual(new Set(["connected"]));
  });

  it("allows suite deletion without a workspace id", () => {
    mocks.useWorkspaceMembers.mockReturnValue({
      members: [],
      canManageMembers: false,
    });

    const { result } = renderHook(() =>
      useEvalTabContext({
        isAuthenticated: false,
        workspaceId: null,
      }),
    );

    expect(result.current.canDeleteSuite).toBe(true);
    expect(result.current.canDeleteRuns).toBe(true);
  });
});
