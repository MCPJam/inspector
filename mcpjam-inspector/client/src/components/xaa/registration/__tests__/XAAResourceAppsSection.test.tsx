import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAAResourceAppsSection } from "../XAAResourceAppsSection";
import type { XaaResourceApp } from "@/lib/xaa/types";

let flagValue: boolean | undefined = true;
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => flagValue,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

let resourceApps: XaaResourceApp[] = [];
let hookAuthenticated = true;
const removeMock = vi.fn(async () => undefined);
vi.mock("@/hooks/useXaaResourceApps", () => ({
  useXaaResourceApps: () => ({
    resourceApps,
    isLoading: false,
    isAuthenticated: hookAuthenticated,
    error: null,
    upsert: vi.fn(),
    remove: removeMock,
  }),
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

vi.mock("../XAARegistrationWizard", () => ({
  XAARegistrationWizard: ({ open }: { open: boolean }) =>
    open ? <div data-testid="xaa-reg-wizard-open" /> : null,
}));

const ORG_ID = "org_test";

const APP: XaaResourceApp = {
  id: "app_1",
  name: "My Resource",
  resourceType: "mcp",
  resourceUrl: "https://resource.example.com/mcp",
  authServerMode: "own",
  tokenEndpoint: "https://auth.example.com/oauth/token",
  hasSecret: true,
  createdAt: 1,
  updatedAt: 2,
};

describe("XAAResourceAppsSection", () => {
  beforeEach(() => {
    flagValue = true;
    resourceApps = [];
    hookAuthenticated = true;
    myRole = "admin";
    removeMock.mockClear();
  });

  describe("gating", () => {
    it("renders nothing when the flag is false", () => {
      flagValue = false;
      render(<XAAResourceAppsSection organizationId={ORG_ID} />);
      expect(screen.queryByText("Registered resource apps")).toBeNull();
    });

    it("renders nothing when the flag is undefined", () => {
      flagValue = undefined;
      render(<XAAResourceAppsSection organizationId={ORG_ID} />);
      expect(screen.queryByText("Registered resource apps")).toBeNull();
    });

    it("renders nothing when the hook gate is closed (local mode / logged out)", () => {
      hookAuthenticated = false;
      render(<XAAResourceAppsSection organizationId={ORG_ID} />);
      expect(screen.queryByText("Registered resource apps")).toBeNull();
    });
  });

  it("shows the empty state with a Register CTA", async () => {
    const user = userEvent.setup();
    render(<XAAResourceAppsSection organizationId={ORG_ID} />);

    expect(screen.getByTestId("xaa-reg-empty")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /register/i }));
    expect(screen.getByTestId("xaa-reg-wizard-open")).toBeInTheDocument();
  });

  it("lists registrations with type/AS badges and a stored-secret indicator", () => {
    resourceApps = [APP];
    render(<XAAResourceAppsSection organizationId={ORG_ID} />);

    const row = screen.getByTestId("xaa-reg-row-app_1");
    expect(row).toHaveTextContent("My Resource");
    expect(row).toHaveTextContent("MCP");
    expect(row).toHaveTextContent("Own AS");
    expect(row).toHaveTextContent("https://resource.example.com/mcp");
    expect(screen.getByLabelText("Client secret stored")).toBeInTheDocument();
  });

  it("deletes only after confirmation", async () => {
    resourceApps = [APP];
    const user = userEvent.setup();
    render(<XAAResourceAppsSection organizationId={ORG_ID} />);

    await user.click(
      screen.getByRole("button", { name: "Delete My Resource" }),
    );
    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.getByText("Delete My Resource?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("app_1"));
  });

  it("cancelling the confirm dialog does not delete", async () => {
    resourceApps = [APP];
    const user = userEvent.setup();
    render(<XAAResourceAppsSection organizationId={ORG_ID} />);

    await user.click(
      screen.getByRole("button", { name: "Delete My Resource" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeMock).not.toHaveBeenCalled();
  });

  describe("non-admin locked state", () => {
    it("renders inert edit/delete with a reason tooltip instead of live buttons", async () => {
      myRole = "member";
      resourceApps = [APP];
      const user = userEvent.setup();
      render(<XAAResourceAppsSection organizationId={ORG_ID} />);

      const editButton = screen.getByRole("button", {
        name: "Edit My Resource",
      });
      expect(editButton).toHaveAttribute("aria-disabled", "true");

      const deleteButton = screen.getByRole("button", {
        name: "Delete My Resource",
      });
      expect(deleteButton).toHaveAttribute("aria-disabled", "true");

      // Clicking does nothing — no confirm dialog, no wizard.
      await user.click(deleteButton);
      expect(removeMock).not.toHaveBeenCalled();
      expect(screen.queryByText("Delete My Resource?")).toBeNull();

      await user.click(editButton);
      expect(screen.queryByTestId("xaa-reg-wizard-open")).toBeNull();
    });
  });
});
