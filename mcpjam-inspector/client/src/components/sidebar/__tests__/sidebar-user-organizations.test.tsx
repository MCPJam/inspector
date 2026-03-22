import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const signOutMock = vi.fn();

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: { firstName: "Test", lastName: "User", email: "test@example.com" },
    signIn: vi.fn(),
    signOut: signOutMock,
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQuery: () => ({ name: "Test User" }),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/hooks/useProfilePicture", () => ({
  useProfilePicture: () => ({ profilePictureUrl: null }),
}));

const mockOrganizations = [
  {
    _id: "org_admin",
    name: "Admin Org",
    myRole: "admin",
    logoUrl: undefined,
  },
  {
    _id: "org_member",
    name: "Member Org",
    myRole: "member",
    logoUrl: undefined,
  },
  {
    _id: "org_owner",
    name: "Owner Org",
    myRole: "owner",
    logoUrl: undefined,
  },
];

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({
    sortedOrganizations: mockOrganizations,
  }),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarMenu: ({ children }: any) => (
    <div data-testid="sidebar-menu">{children}</div>
  ),
  SidebarMenuItem: ({ children }: any) => <div>{children}</div>,
  SidebarMenuButton: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  useSidebar: () => ({ isMobile: false }),
}));

// Render dropdown menu items directly so we can test clicks
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, ...props }: any) => (
    <div role="menuitem" onClick={onClick} {...props}>
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: any) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: any) => <div>{children}</div>,
  AvatarImage: () => null,
  AvatarFallback: ({ children }: any) => <span>{children}</span>,
}));

vi.mock("@/components/organization/CreateOrganizationDialog", () => ({
  CreateOrganizationDialog: () => null,
}));

import { SidebarUser } from "../sidebar-user";

describe("SidebarUser - organization navigation", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  it("navigates when clicking an org where user is a member (non-admin)", () => {
    render(<SidebarUser />);

    fireEvent.click(screen.getByText("Member Org"));

    expect(window.location.hash).toBe("#organizations/org_member");
  });

  it("navigates when clicking an org where user is an admin", () => {
    render(<SidebarUser />);

    fireEvent.click(screen.getByText("Admin Org"));

    expect(window.location.hash).toBe("#organizations/org_admin");
  });

  it("navigates when clicking an org where user is an owner", () => {
    render(<SidebarUser />);

    fireEvent.click(screen.getByText("Owner Org"));

    expect(window.location.hash).toBe("#organizations/org_owner");
  });

  it("renders all organizations in the dropdown", () => {
    render(<SidebarUser />);

    expect(screen.getByText("Admin Org")).toBeDefined();
    expect(screen.getByText("Member Org")).toBeDefined();
    expect(screen.getByText("Owner Org")).toBeDefined();
  });
});
