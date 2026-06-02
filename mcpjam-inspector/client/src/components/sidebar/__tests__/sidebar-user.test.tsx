import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

const authState = vi.hoisted(() => ({
  signInMock: vi.fn(),
  signOutMock: vi.fn(),
  user: null as
    | null
    | {
        email: string;
        firstName?: string;
        lastName?: string;
      },
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: authState.user,
    signIn: authState.signInMock,
    signOut: authState.signOutMock,
  }),
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

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@/components/sidebar/sidebar-credit-usage", () => ({
  SidebarCreditUsage: ({
    className,
    variant,
  }: {
    className?: string;
    variant?: string;
  }) => (
    <div
      data-testid="sidebar-credit-usage"
      data-variant={variant}
      className={className}
    />
  ),
}));

vi.mock("@mcpjam/design-system/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="account-menu">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    variant: _variant,
    ...props
  }: {
    children: ReactNode;
    variant?: string;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
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

import { SidebarUser } from "../sidebar-user";

describe("SidebarUser", () => {
  beforeEach(() => {
    authState.user = null;
    authState.signInMock.mockClear();
    authState.signOutMock.mockClear();
    window.isElectron = false;
  });

  it("renders sign-in button when unauthenticated in hosted mode", () => {
    render(<SidebarUser />);
    expect(screen.getByText("Sign in")).toBeDefined();
    const signInButton = screen.getByRole("button", { name: "Sign in" });
    expect(signInButton).toHaveAttribute("aria-label", "Sign in");
    expect(signInButton.className).toContain(
      "data-[state=open]:bg-sidebar-accent",
    );
  });

  it("calls signIn when button is clicked", () => {
    render(<SidebarUser />);
    fireEvent.click(screen.getByText("Sign in"));
    expect(authState.signInMock).toHaveBeenCalled();
  });

  it("no longer renders credit usage in the account dropdown (moved to the org switcher)", () => {
    authState.user = {
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "Example",
    };

    render(<SidebarUser />);

    expect(
      screen.queryByTestId("sidebar-credit-usage")
    ).not.toBeInTheDocument();
  });

  it("returns logout to the app origin instead of the callback route", () => {
    authState.user = {
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "Example",
    };

    render(<SidebarUser />);

    fireEvent.click(screen.getByText("Log out"));

    expect(authState.signOutMock).toHaveBeenCalledWith({
      returnTo: window.location.origin,
    });
  });

  it("runs sign-out cleanup before WorkOS signOut", async () => {
    authState.user = {
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "Example",
    };
    const onBeforeSignOut = vi.fn().mockResolvedValue(undefined);

    render(<SidebarUser onBeforeSignOut={onBeforeSignOut} />);

    fireEvent.click(screen.getByText("Log out"));

    expect(onBeforeSignOut).toHaveBeenCalled();
    await waitFor(() => {
      expect(authState.signOutMock).toHaveBeenCalledWith({
        returnTo: window.location.origin,
      });
    });
    expect(onBeforeSignOut.mock.invocationCallOrder[0]).toBeLessThan(
      authState.signOutMock.mock.invocationCallOrder[0],
    );
  });

  it("uses non-navigation logout in Electron", () => {
    authState.user = {
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "Example",
    };
    window.isElectron = true;
    authState.signOutMock.mockReturnValue(new Promise(() => {}));

    render(<SidebarUser />);

    fireEvent.click(screen.getByText("Log out"));

    expect(authState.signOutMock).toHaveBeenCalledWith({
      returnTo: window.location.origin,
      navigate: false,
    });
  });
});
