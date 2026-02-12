import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrganizationMemberRow } from "../OrganizationMemberRow";

vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AvatarImage: () => null,
  AvatarFallback: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

function createMember(role: "owner" | "admin" | "member") {
  return {
    _id: "member-1",
    organizationId: "org-1",
    userId: "user-1",
    email: "member@example.com",
    role,
    isOwner: role === "owner",
    addedBy: "user-owner",
    addedAt: 1,
    user: {
      name: "Member User",
      email: "member@example.com",
      imageUrl: "",
    },
  };
}

describe("OrganizationMemberRow", () => {
  it("shows only one role label when role is editable", () => {
    render(
      <OrganizationMemberRow
        member={createMember("member")}
        canEditRole
        onRoleChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("combobox", {
        name: "Role for member@example.com",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/^member$/i)).toHaveLength(1);
  });

  it("shows read-only role badge when role is not editable", () => {
    render(<OrganizationMemberRow member={createMember("member")} />);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText(/^member$/i)).toBeInTheDocument();
  });

  it("does not show remove control for owner role even if legacy isOwner is false", () => {
    const inconsistentOwner = {
      ...createMember("member"),
      role: "owner" as const,
      isOwner: false,
    };

    render(
      <OrganizationMemberRow member={inconsistentOwner} onRemove={vi.fn()} />,
    );

    expect(screen.getByText(/^owner$/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
