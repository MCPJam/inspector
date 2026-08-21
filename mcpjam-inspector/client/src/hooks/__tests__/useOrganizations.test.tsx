import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DbUserReadyProvider } from "@/contexts/db-user-ready-context";
import {
  canManageOrgModels,
  useOrganizationQueries,
} from "../useOrganizations";

const mockUseQuery = vi.hoisted(() => vi.fn());

vi.mock("convex/react", () => ({
  useQuery: mockUseQuery,
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
}));

function readyWrapper(isUserReady: boolean) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <DbUserReadyProvider isUserReady={isUserReady}>
        {children}
      </DbUserReadyProvider>
    );
  };
}

describe("useOrganizationQueries", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
    mockUseQuery.mockReturnValue(undefined);
  });

  it("stays loading while an authenticated actor is waiting for user bootstrap", () => {
    const { result } = renderHook(() =>
      useOrganizationQueries({ isAuthenticated: true }), {
        wrapper: readyWrapper(false),
      }
    );

    expect(mockUseQuery).toHaveBeenCalledWith(
      "organizations:getMyOrganizations",
      "skip"
    );
    expect(result.current.isLoading).toBe(true);
    expect(result.current.sortedOrganizations).toEqual([]);
  });

  it("queries and sorts once the user row is ready", () => {
    mockUseQuery.mockReturnValue([
      { _id: "a", updatedAt: 1 },
      { _id: "b", updatedAt: 2 },
    ]);

    const { result } = renderHook(
      () => useOrganizationQueries({ isAuthenticated: true }),
      { wrapper: readyWrapper(true) }
    );

    expect(mockUseQuery).toHaveBeenCalledWith(
      "organizations:getMyOrganizations",
      {}
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.sortedOrganizations.map((o) => o._id)).toEqual([
      "b",
      "a",
    ]);
  });

  // Selecting a pending-invite org made the server refuse every org-scoped call.
  it("excludes pending invites the caller has not claimed", () => {
    mockUseQuery.mockReturnValue([
      { _id: "joined", updatedAt: 2, isPendingInvite: false },
      { _id: "invited", updatedAt: 3, isPendingInvite: true },
    ]);

    const { result } = renderHook(
      () => useOrganizationQueries({ isAuthenticated: true }),
      { wrapper: readyWrapper(true) }
    );

    expect(result.current.sortedOrganizations.map((o) => o._id)).toEqual([
      "joined",
    ]);
  });
  it("does not report loading for unauthenticated actors", () => {
    const { result } = renderHook(() =>
      useOrganizationQueries({ isAuthenticated: false }), {
        wrapper: readyWrapper(false),
      }
    );

    expect(mockUseQuery).toHaveBeenCalledWith(
      "organizations:getMyOrganizations",
      "skip"
    );
    expect(result.current.isLoading).toBe(false);
  });
});

describe("canManageOrgModels", () => {
  it("allows owners and admins", () => {
    expect(canManageOrgModels({ myRole: "owner" })).toBe(true);
    expect(canManageOrgModels({ myRole: "admin" })).toBe(true);
  });

  it("fails closed for everyone else", () => {
    expect(canManageOrgModels({ myRole: "member" })).toBe(false);
    expect(canManageOrgModels({ myRole: "guest" })).toBe(false);
    expect(canManageOrgModels({ myRole: undefined })).toBe(false);
    expect(canManageOrgModels(null)).toBe(false);
    expect(canManageOrgModels(undefined)).toBe(false);
  });
});
