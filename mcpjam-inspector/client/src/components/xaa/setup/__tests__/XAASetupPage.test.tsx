import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAASetupPage } from "../XAASetupPage";
import {
  buildXaaSetupPath,
  parseXaaSetupSection,
  type XaaSetupSection,
} from "@/lib/app-navigation";

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

let myRole: string | undefined = "admin";
vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({
    sortedOrganizations: [
      { _id: "org_test", name: "Test Org", myRole, isCreator: false },
    ],
    isLoading: false,
    createdCount: 0,
    canCreateOrganization: true,
  }),
}));

// The section under test is the shell — sections are stubs that surface the
// props the shell derives (admin gating).
vi.mock("../XAASetupPeopleSection", () => ({
  XAASetupPeopleSection: ({ canManage }: { canManage: boolean }) => (
    <div data-testid="people-section" data-can-manage={String(canManage)} />
  ),
}));
vi.mock("../XAASetupAppsSection", () => ({
  XAASetupAppsSection: ({ canManage }: { canManage: boolean }) => (
    <div data-testid="apps-section" data-can-manage={String(canManage)} />
  ),
}));
vi.mock("../XAASetupAccessSection", () => ({
  XAASetupAccessSection: ({ canManage }: { canManage: boolean }) => (
    <div data-testid="access-section" data-can-manage={String(canManage)} />
  ),
}));
vi.mock("../MCPJamAgentCard", () => ({
  MCPJamAgentCard: () => <div data-testid="agent-card" />,
}));

// Keep the real path builders/parsers; only pin the location-derived section
// and capture navigation.
let currentSection: XaaSetupSection = "people";
const navigateMock = vi.fn();
vi.mock("@/lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-navigation")>();
  return {
    ...actual,
    useXaaSetupSection: () => currentSection,
    useAppNavigate: () => navigateMock,
  };
});

const ORG_ID = "org_test";

describe("XAASetupPage", () => {
  beforeEach(() => {
    myRole = "admin";
    currentSection = "people";
    navigateMock.mockClear();
  });

  it("renders the agent card and the default People section for admins", () => {
    render(<XAASetupPage organizationId={ORG_ID} />);

    expect(screen.getByTestId("agent-card")).toBeInTheDocument();
    expect(screen.getByTestId("people-section")).toHaveAttribute(
      "data-can-manage",
      "true",
    );
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });

  it("marks the page read-only for plain members", () => {
    myRole = "member";
    render(<XAASetupPage organizationId={ORG_ID} />);

    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByTestId("people-section")).toHaveAttribute(
      "data-can-manage",
      "false",
    );
  });

  it("navigates to a section path when a segment is clicked", async () => {
    const user = userEvent.setup();
    render(<XAASetupPage organizationId={ORG_ID} />);

    await user.click(screen.getByRole("button", { name: "Apps" }));
    expect(navigateMock).toHaveBeenCalledWith("/xaa-flow/setup/apps");

    await user.click(screen.getByRole("button", { name: "Access" }));
    expect(navigateMock).toHaveBeenCalledWith("/xaa-flow/setup/access");

    // The default section canonicalizes to the bare setup path.
    await user.click(screen.getByRole("button", { name: "People" }));
    expect(navigateMock).toHaveBeenCalledWith("/xaa-flow/setup");
  });

  it("renders the section resolved from the URL (deep link)", () => {
    currentSection = "access";
    render(<XAASetupPage organizationId={ORG_ID} />);

    expect(screen.getByTestId("access-section")).toBeInTheDocument();
    expect(screen.queryByTestId("people-section")).not.toBeInTheDocument();
  });

  it("navigates back to the debugger", async () => {
    const user = userEvent.setup();
    render(<XAASetupPage organizationId={ORG_ID} />);

    await user.click(screen.getByRole("button", { name: /back to debugger/i }));
    expect(navigateMock).toHaveBeenCalledWith("/xaa-flow");
  });

  it("shows the hosted/org empty state when there is no organization", () => {
    render(<XAASetupPage organizationId={null} />);

    expect(
      screen.getByText(/available on app\.mcpjam\.com/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("people-section")).not.toBeInTheDocument();
  });
});

describe("setup deep-link paths", () => {
  it("builds section paths with people as the canonical default", () => {
    expect(buildXaaSetupPath()).toBe("/xaa-flow/setup");
    expect(buildXaaSetupPath("people")).toBe("/xaa-flow/setup");
    expect(buildXaaSetupPath("apps")).toBe("/xaa-flow/setup/apps");
    expect(buildXaaSetupPath("access")).toBe("/xaa-flow/setup/access");
  });

  it("parses section segments, defaulting unknown segments to people", () => {
    expect(parseXaaSetupSection("/xaa-flow/setup")).toBe("people");
    expect(parseXaaSetupSection("/xaa-flow/setup/apps")).toBe("apps");
    expect(parseXaaSetupSection("/xaa-flow/setup/access")).toBe("access");
    expect(parseXaaSetupSection("/xaa-flow/setup/bogus")).toBe("people");
    expect(parseXaaSetupSection("/xaa-flow")).toBeNull();
    expect(parseXaaSetupSection("/servers")).toBeNull();
  });
});
