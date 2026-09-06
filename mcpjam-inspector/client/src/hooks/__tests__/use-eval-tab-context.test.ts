import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEvalTabContext } from "../use-eval-tab-context";

const mocks = vi.hoisted(() => ({
  useSharedAppState: vi.fn(),
  useProjectMembers: vi.fn(),
  useAvailableModels: vi.fn(),
  useQuery: vi.fn(),
}));

// The hook reads the signed-in Convex user to answer "did YOU make this?".
// Stubbed rather than provider-wrapped: nothing here exercises Convex.
vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
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
    mocks.useQuery.mockReturnValue({ _id: "user-me" });
  });

  it("lets a plain member delete their OWN artifacts but not other people's", () => {
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

    expect(result.current.canManageEvalArtifacts).toBe(false);
    expect(result.current.canDeleteArtifact("user-me")).toBe(true);
    expect(result.current.canDeleteArtifact("user-someone-else")).toBe(false);
    // The surface still opens — there is at least one row they can act on.
    expect(result.current.canDeleteRuns).toBe(true);
    expect(result.current.connectedServerNames).toEqual(new Set(["connected"]));
  });

  it("lets a member manager delete artifacts they did not create", () => {
    mocks.useProjectMembers.mockReturnValue({
      members: [],
      canManageMembers: true,
    });

    const { result } = renderHook(() =>
      useEvalTabContext({
        isAuthenticated: true,
        projectId: "project-1",
      }),
    );

    expect(result.current.canManageEvalArtifacts).toBe(true);
    expect(result.current.canDeleteArtifact("user-someone-else")).toBe(true);
  });

  it("withholds deletion entirely when nobody is signed in", () => {
    // No viewer identity means authorship can never be established, so the
    // creator hatch cannot open. Guessing `true` here would show a delete
    // button whose mutation refuses.
    mocks.useProjectMembers.mockReturnValue({
      members: [],
      canManageMembers: false,
    });
    mocks.useQuery.mockReturnValue(null);

    const { result } = renderHook(() =>
      useEvalTabContext({
        isAuthenticated: true,
        projectId: "project-1",
      }),
    );

    expect(result.current.canDeleteArtifact("user-me")).toBe(false);
    expect(result.current.canDeleteArtifact(undefined)).toBe(false);
    expect(result.current.canDeleteRuns).toBe(false);
  });

  it("allows deletion without a project id", () => {
    // Local and playground work ranks no membership, so there is nothing to
    // withhold — including for an unauthenticated caller.
    mocks.useProjectMembers.mockReturnValue({
      members: [],
      canManageMembers: false,
    });
    mocks.useQuery.mockReturnValue(null);

    const { result } = renderHook(() =>
      useEvalTabContext({
        isAuthenticated: false,
        projectId: null,
      }),
    );

    expect(result.current.canManageEvalArtifacts).toBe(true);
    expect(result.current.canDeleteArtifact("anyone")).toBe(true);
    expect(result.current.canDeleteRuns).toBe(true);
  });
});
