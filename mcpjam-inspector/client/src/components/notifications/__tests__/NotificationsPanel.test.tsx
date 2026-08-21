import { render, screen } from "@testing-library/react";
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

function renderWith(notifications: Notification[]) {
  mockUseNotifications.mockReturnValue({ notifications, isLoading: false });
  return render(<NotificationsPanelContent />);
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
});
