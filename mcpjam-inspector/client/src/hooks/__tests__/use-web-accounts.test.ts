import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWebAccounts } from "../use-web-accounts";

const state = vi.hoisted(() => ({
  queries: [] as unknown[],
  list: undefined as unknown[] | undefined,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: (_query: unknown, args: unknown) => {
    state.queries.push(args);
    return args === "skip" ? undefined : state.list;
  },
}));
vi.mock("@/hooks/useWebClientsEnabled", () => ({
  useWebClientsEnabled: () => true,
}));
vi.mock("@/hooks/useProjects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useProjects")>()),
  useCanManageProjectClients: () => ({ canManage: true, isLoading: false }),
}));

describe("useWebAccounts", () => {
  beforeEach(() => {
    state.queries = [];
    state.list = undefined;
  });

  it("waits for the list of a project it asks about", () => {
    const { result } = renderHook(() => useWebAccounts("project-1", "claude"));
    expect(state.queries).toContainEqual({ projectId: "project-1" });
    expect(result.current.loaded).toBe(false);
  });

  it("settles on no accounts for a project it can't ask about", () => {
    // A local project's id; the list is never asked, so it never arrives.
    const { result } = renderHook(() =>
      useWebAccounts("local_project", "claude"),
    );
    expect(state.queries.every((args) => args === "skip")).toBe(true);
    expect(result.current).toMatchObject({ accounts: [], loaded: true });
  });
});
