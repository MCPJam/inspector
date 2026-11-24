import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Notification } from "@/hooks/useNotifications";

const mockUseConvexAuth = vi.fn();
const mockUseNotifications = vi.fn();
const mockUseNotificationMutations = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: (...args: unknown[]) => mockUseConvexAuth(...args),
}));

vi.mock("@/hooks/useNotifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNotifications: (...args: unknown[]) => mockUseNotifications(...args),
  useNotificationMutations: (...args: unknown[]) =>
    mockUseNotificationMutations(...args),
}));

vi.mock("@mcpjam/design-system/popover", () => ({
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@mcpjam/design-system/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@mcpjam/design-system/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

import { NotificationsPanelContent } from "../NotificationsPanel";

function notification(overrides: Partial<Notification>): Notification {
  return {
    _id: "n1",
    userId: "user_1",
    type: "organization_added",
    entityId: "org_1",
    entityName: "Acme",
    actorName: "Ada",
    isRead: false,
    createdAt: Date.now(),
    ...overrides,
  } as Notification;
}

function renderWith(notifications: Notification[], onNavigate?: () => void) {
  mockUseNotifications.mockReturnValue({ notifications, isLoading: false });
  return render(<NotificationsPanelContent onNavigate={onNavigate} />);
}

describe("NotificationsPanelContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseConvexAuth.mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
    });
    mockUseNotificationMutations.mockReturnValue({
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
      clearAllNotifications: vi.fn(),
    });
  });

  it("renders workspace membership messages", () => {
    renderWith([
      notification({
        _id: "n-added",
        type: "workspace_added",
        entityName: "Platform",
      }),
      notification({
        _id: "n-removed",
        type: "workspace_removed",
        entityName: "Platform",
      }),
    ]);

    expect(
      screen.getByText('Ada added you to workspace "Platform"')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ada removed you from workspace "Platform"')
    ).toBeInTheDocument();
  });

  it("renders the seat-payment request with its own icon and neutral styling", () => {
    // Owner-targeted, and neither a grant nor a removal — the panel used to
    // colour purely on whether the type contained "added", which would have
    // styled this as a destructive event.
    const { container } = renderWith([
      notification({
        _id: "n-seat",
        type: "organization_seat_payment_required",
        entityName: "Acme",
        actorName: "Joey",
      }),
    ]);

    expect(
      screen.getByText('Joey signed up and needs a paid seat in "Acme"')
    ).toBeInTheDocument();

    const icon = container.querySelector(".bg-primary\\/10");
    expect(icon).not.toBeNull();
    expect(icon?.className).toContain("text-primary");
    expect(container.querySelector(".bg-destructive\\/10")).toBeNull();
    expect(container.querySelector(".bg-success\\/10")).toBeNull();
  });

  it("still styles ordinary grants and removals distinctly", () => {
    const { container } = renderWith([
      notification({ _id: "n-org-added", type: "organization_added" }),
      notification({ _id: "n-org-removed", type: "organization_removed" }),
    ]);
    expect(container.querySelector(".bg-success\\/10")).not.toBeNull();
    expect(container.querySelector(".bg-destructive\\/10")).not.toBeNull();
  });

  it("opens the access request page from a project access request", () => {
    const markAsRead = vi.fn();
    mockUseNotificationMutations.mockReturnValue({
      markAsRead,
      markAllAsRead: vi.fn(),
      clearAllNotifications: vi.fn(),
    });
    window.history.replaceState({}, "", "/");
    const { container } = renderWith([
      notification({
        _id: "n-access",
        type: "project_access_requested",
        entityId: "req_1",
        entityName: "Payments",
        actorName: "Ada",
      }),
    ]);

    const row = screen.getByText('Ada asked for access to project "Payments"');
    expect(container.querySelector(".bg-primary\\/10")).not.toBeNull();
    fireEvent.click(row);
    expect(markAsRead).toHaveBeenCalledWith({ notificationId: "n-access" });
    expect(window.location.pathname).toBe("/access-requests/req_1");
  });

  it("opens the access request page from the keyboard", () => {
    const markAsRead = vi.fn();
    mockUseNotificationMutations.mockReturnValue({
      markAsRead,
      markAllAsRead: vi.fn(),
      clearAllNotifications: vi.fn(),
    });
    window.history.replaceState({}, "", "/");
    renderWith([
      notification({
        _id: "n-access",
        type: "project_access_requested",
        entityId: "req_1",
        entityName: "Payments",
        actorName: "Ada",
      }),
      notification({ _id: "n-org", type: "organization_added" }),
    ]);

    // Only the row that opens a page is a link; the others stay plain rows.
    const link = screen.getByRole("link", {
      name: /Ada asked for access to project "Payments"/,
    });
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(link).toHaveAttribute("tabindex", "0");
    link.focus();
    fireEvent.keyDown(link, { key: "Enter" });
    expect(markAsRead).toHaveBeenCalledWith({ notificationId: "n-access" });
    expect(window.location.pathname).toBe("/access-requests/req_1");
  });

  it("tells the caller after a row opens a page, and not for other rows", () => {
    mockUseNotificationMutations.mockReturnValue({
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
      clearAllNotifications: vi.fn(),
    });
    window.history.replaceState({}, "", "/");
    const onNavigate = vi.fn();
    renderWith(
      [
        notification({
          _id: "n-access",
          type: "project_access_requested",
          entityId: "req_1",
          entityName: "Payments",
          actorName: "Ada",
        }),
        notification({
          _id: "n-org",
          type: "organization_added",
          entityName: "Acme",
          actorName: "Ada",
        }),
      ],
      onNavigate,
    );

    fireEvent.click(screen.getByText('Ada added you to organization "Acme"'));
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(
      screen.getByRole("link", { name: /Ada asked for access/ }),
      { key: "Enter" },
    );
    expect(window.location.pathname).toBe("/access-requests/req_1");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
