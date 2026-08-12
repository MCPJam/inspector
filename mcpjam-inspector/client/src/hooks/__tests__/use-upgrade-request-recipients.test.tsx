import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpgradeRequestRecipients } from "../use-upgrade-request-recipients";

const { authState, membersState, useOrganizationMembersMock } = vi.hoisted(
  () => ({
    authState: { isAuthenticated: false, isLoading: true },
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
  })
);

vi.mock("convex/react", () => ({
  useConvexAuth: () => authState,
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
});
