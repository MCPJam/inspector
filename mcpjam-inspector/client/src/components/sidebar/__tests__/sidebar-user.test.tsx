import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const signInMock = vi.fn();

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null, signIn: signInMock, signOut: vi.fn() }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
  useQuery: () => null,
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/hooks/useProfilePicture", () => ({
  useProfilePicture: () => ({ profilePictureUrl: null }),
}));

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({ sortedOrganizations: [] }),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarMenu: ({ children }: any) => <div data-testid="sidebar-menu">{children}</div>,
  SidebarMenuItem: ({ children }: any) => <div>{children}</div>,
  SidebarMenuButton: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("@/components/organization/CreateOrganizationDialog", () => ({
  CreateOrganizationDialog: () => null,
}));

import { SidebarUser } from "../sidebar-user";

describe("SidebarUser", () => {
  it("renders sign-in button when unauthenticated in hosted mode", () => {
    render(<SidebarUser />);
    expect(screen.getByText("Sign in")).toBeDefined();
  });

  it("calls signIn when button is clicked", () => {
    render(<SidebarUser />);
    fireEvent.click(screen.getByText("Sign in"));
    expect(signInMock).toHaveBeenCalled();
  });
});
