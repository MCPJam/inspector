import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpgradeRequestRecipients } from "../use-upgrade-request-recipients";

const { authState, dbUserState, membersState, useOrganizationMembersMock } =
  vi.hoisted(() => ({
    authState: { isAuthenticated: false, isLoading: true },
    dbUserState: { isUserReady: true },
    membersState: {
      activeMembers: [] as Array<{
        role: "owner" | "member";
        isOwner: boolean;
        email: string;
        user: { name: string } | null;
      }>,
      isLoading: false,
    },
    useOrganizationMembersMock: vi.fn(),
  }));

vi.mock("convex/react", () => ({
  useConvexAuth: () => authState,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => dbUserState.isUserReady,
}));

vi.mock("@/hooks/useOrganizations", () => ({
  resolveOrganizationRole: (member: { role: "owner" | "member" }) =>
    member.role,
  useOrganizationMembers: (args: unknown) => {
    useOrganizationMembersMock(args);
    return membersState;
  },
}));

describe("useUpgradeRequestRecipients", () => {
  beforeEach(() => {
    authState.isAuthenticated = false;
    authState.isLoading = true;
    dbUserState.isUserReady = true;
    membersState.activeMembers = [];
    membersState.isLoading = false;
    useOrganizationMembersMock.mockClear();
  });

  it("stays loading while Convex auth resolves and the members query is skipped", () => {
    const { result } = renderHook(() => useUpgradeRequestRecipients("org-1"));

    expect(useOrganizationMembersMock).toHaveBeenCalledWith({
      isAuthenticated: false,
      organizationId: "org-1",
    });
    expect(result.current).toEqual({ recipients: [], isLoading: true });
  });

  it("skips the members query until the db user row exists", () => {
    // Convex auth authenticates before `users:ensureUser` lands; the org query
    // throws rather than returning empty in that window.
    authState.isAuthenticated = true;
    authState.isLoading = false;
    dbUserState.isUserReady = false;

    const { result } = renderHook(() => useUpgradeRequestRecipients("org-1"));

    expect(useOrganizationMembersMock).toHaveBeenCalledWith({
      isAuthenticated: false,
      organizationId: "org-1",
    });
    expect(result.current).toEqual({ recipients: [], isLoading: true });
  });

  it("settles instead of hanging when there is no authenticated session", () => {
    authState.isAuthenticated = false;
    authState.isLoading = false;
    dbUserState.isUserReady = false;

    const { result } = renderHook(() => useUpgradeRequestRecipients("org-1"));

    expect(result.current).toEqual({ recipients: [], isLoading: false });
  });

  it("stays loading while the authenticated members query resolves", () => {
    authState.isAuthenticated = true;
    authState.isLoading = false;
    membersState.isLoading = true;

    const { result } = renderHook(() => useUpgradeRequestRecipients("org-1"));

    expect(result.current.isLoading).toBe(true);
  });

  it("returns owner recipients after auth and membership settle", () => {
    authState.isAuthenticated = true;
    authState.isLoading = false;
    membersState.activeMembers = [
      {
        role: "owner",
        isOwner: true,
        email: "owner@example.com",
        user: { name: "Owner Name" },
      },
      {
        role: "member",
        isOwner: false,
        email: "member@example.com",
        user: { name: "Member Name" },
      },
    ];

    const { result } = renderHook(() => useUpgradeRequestRecipients("org-1"));

    expect(result.current).toEqual({
      recipients: [{ email: "owner@example.com", name: "Owner Name" }],
      isLoading: false,
    });
  });

  it("keeps an owner whose user row carries no name", () => {
    authState.isAuthenticated = true;
    authState.isLoading = false;
    membersState.activeMembers = [
      {
        role: "owner",
        isOwner: true,
        email: "owner@example.com",
        user: null,
      },
    ];

    const { result } = renderHook(() => useUpgradeRequestRecipients("org-1"));

    expect(result.current.recipients).toEqual([
      { email: "owner@example.com", name: null },
    ]);
  });

  it("drops an owner with no email rather than addressing an empty draft", () => {
    authState.isAuthenticated = true;
    authState.isLoading = false;
    membersState.activeMembers = [
      {
        role: "owner",
        isOwner: true,
        email: "",
        user: { name: "Owner Name" },
      },
    ];

    const { result } = renderHook(() => useUpgradeRequestRecipients("org-1"));

    expect(result.current.recipients).toEqual([]);
  });
});
