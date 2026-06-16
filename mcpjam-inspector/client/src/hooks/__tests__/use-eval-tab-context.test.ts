import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEvalTabContext } from "../use-eval-tab-context";

const mocks = vi.hoisted(() => ({
  useSharedAppState: vi.fn(),
  useProjectMembers: vi.fn(),
  useAvailableModels: vi.fn(),
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: mocks.useSharedAppState,
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: mocks.useProjectMembers,
}));

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: mocks.useAvailableModels,
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
    mocks.useAvailableModels.mockReturnValue({ availableModels: [] });
  });

  it("always surfaces suite deletion while keeping run deletion on member-management rights", () => {
    mocks.useProjectMembers.mockReturnValue({
      members: [],
      canManageMembers: false,
    });

    const { result } = renderHook(() =>
      useEvalTabContext({
        isAuthenticated: true,
        projectId: "project-1",
      }),
    );

    expect(result.current.canDeleteSuite).toBe(true);
    expect(result.current.canDeleteRuns).toBe(false);
    expect(result.current.connectedServerNames).toEqual(new Set(["connected"]));
  });

  it("allows suite deletion without a project id", () => {
    mocks.useProjectMembers.mockReturnValue({
      members: [],
      canManageMembers: false,
    });

    const { result } = renderHook(() =>
      useEvalTabContext({
        isAuthenticated: false,
        projectId: null,
      }),
    );

    expect(result.current.canDeleteSuite).toBe(true);
    expect(result.current.canDeleteRuns).toBe(true);
  });
});
