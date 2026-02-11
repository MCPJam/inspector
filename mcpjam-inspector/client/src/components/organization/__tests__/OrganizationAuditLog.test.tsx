import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationAuditLog } from "../OrganizationAuditLog";
import type { AuditEvent } from "@/hooks/useOrganizationAudit";

const mockUseOrganizationAudit = vi.fn();

vi.mock("@/hooks/useOrganizationAudit", () => ({
  useOrganizationAudit: (...args: unknown[]) =>
    mockUseOrganizationAudit(...args),
}));

function createEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    _id: "evt-1",
    actorType: "user",
    actorEmail: "owner@example.com",
    action: "organization.member.added",
    organizationId: "org-1",
    targetType: "member",
    targetId: "member@example.com",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("OrganizationAuditLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseOrganizationAudit.mockReturnValue({
      events: [],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it("renders compact export-only UI with idle hint", () => {
    render(
      <OrganizationAuditLog
        organizationId="org-1"
        organizationName="Acme Org"
        isAuthenticated
      />,
    );

    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Export CSV" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Click Refresh to load events, then Export CSV."),
    ).toBeInTheDocument();

    expect(mockUseOrganizationAudit).toHaveBeenCalledWith({
      organizationId: "org-1",
      isAuthenticated: true,
      initialLimit: 500,
    });
  });

  it("exports csv when loaded events exist", () => {
    mockUseOrganizationAudit.mockReturnValue({
      events: [createEvent()],
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });

    const createObjectUrl = vi.fn(() => "blob:mock");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      writable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      writable: true,
      value: revokeObjectUrl,
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(
      <OrganizationAuditLog
        organizationId="org-1"
        organizationName="Acme Org"
        isAuthenticated
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:mock");

    clickSpy.mockRestore();
  });

  it("shows missing-function error message when audit query is unavailable", () => {
    mockUseOrganizationAudit.mockReturnValue({
      events: [],
      isLoading: false,
      error: new Error(
        "Could not find public function for 'auditEvents:listByOrganization'",
      ),
      refresh: vi.fn(),
    });

    render(
      <OrganizationAuditLog
        organizationId="org-1"
        organizationName="Acme Org"
        isAuthenticated
      />,
    );

    expect(
      screen.getByText(
        "Audit export is unavailable because the backend audit function is not deployed yet.",
      ),
    ).toBeInTheDocument();
  });
});
