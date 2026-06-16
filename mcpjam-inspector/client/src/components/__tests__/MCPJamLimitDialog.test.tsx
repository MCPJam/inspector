import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MCPJamLimitDialog } from "../mcpjam-limit-dialog";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

const signIn = vi.fn();
const authState: { isLoading: boolean; user: { id: string } | null } = {
  isLoading: false,
  user: null,
};

const sortedOrganizationsState: Array<{
  _id: string;
  myRole?: string;
  isCreator?: boolean;
}> = [];

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    isLoading: authState.isLoading,
    user: authState.user,
    signIn,
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: !!authState.user,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({
    sortedOrganizations: sortedOrganizationsState,
    isLoading: false,
  }),
  canManageOrgCredits: (
    org: { myRole?: string; isCreator?: boolean } | null | undefined
  ) =>
    !!org &&
    (org.myRole === "owner" ||
      org.myRole === "admin" ||
      org.isCreator === true),
}));

const originalHash = window.location.hash;

beforeEach(() => {
  signIn.mockReset();
  authState.isLoading = false;
  authState.user = null;
  sortedOrganizationsState.length = 0;
  window.location.hash = "";
  localStorage.clear();
  useMCPJamLimitDialogStore.setState({
    authStatus: "loading",
    hasPendingLimit: false,
    isOpen: false,
    intent: null,
    organizationId: null,
    pendingInput: null,
  });
});

afterEach(() => {
  window.location.hash = originalHash;
});

describe("MCPJamLimitDialog", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<MCPJamLimitDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the dialog with guest copy when the store opens", () => {
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    expect(
      screen.getByRole("heading", {
        name: /you've used up your free guest credits/i,
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/10×/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^sign in$/i })
    ).toBeInTheDocument();
  });

  it("calls signIn() when the Sign in button is clicked", async () => {
    const user = userEvent.setup();
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("closes the store when the dialog is dismissed", async () => {
    const user = userEvent.setup();
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("does not render while auth state is loading", () => {
    authState.isLoading = true;
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });

    const { container } = render(<MCPJamLimitDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the topup variant for signed-in users", () => {
    authState.user = { id: "user-1" };
    sortedOrganizationsState.push({ _id: "org-1", myRole: "owner" });
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    expect(
      screen.getByRole("heading", {
        name: /your org is out of credits/i,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^top up$/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /bring your own key/i })
    ).toBeInTheDocument();
  });

  it("shows the ask-admin copy and no CTAs for org members", () => {
    authState.user = { id: "user-1" };
    sortedOrganizationsState.push({ _id: "org-1", myRole: "member" });
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    expect(screen.getByTestId("limit-dialog-description")).toHaveTextContent(
      /Ask your org admin to top up credits/
    );
    // Members get no CTAs at all — neither top up nor BYOK.
    expect(
      screen.queryByRole("button", { name: /^top up$/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /bring your own key/i })
    ).not.toBeInTheDocument();
  });

  it("redirects to the org models page on BYOK click", async () => {
    const user = userEvent.setup();
    authState.user = { id: "user-1" };
    localStorage.setItem("active-organization-id:user-1", "org-active");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    await user.click(
      screen.getByRole("button", { name: /bring your own key/i })
    );

    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(window.location.pathname).toBe("/organizations/org-active/models");
  });

  it("redirects to the active org's billing page with the topup flag on CTA click", async () => {
    const user = userEvent.setup();
    authState.user = { id: "user-1" };
    localStorage.setItem("active-organization-id:user-1", "org-active");
    sortedOrganizationsState.push({ _id: "org-fallback" });
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    await user.click(screen.getByRole("button", { name: /^top up$/i }));

    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(window.location.pathname).toBe("/organizations/org-active/billing");
    expect(window.location.search).toBe("?topup=open");
  });

  it("prefers the org that hit the limit over the stored active org", async () => {
    const user = userEvent.setup();
    authState.user = { id: "user-1" };
    localStorage.setItem("active-organization-id:user-1", "org-b");
    sortedOrganizationsState.push(
      { _id: "org-a", myRole: "owner" },
      { _id: "org-b", myRole: "owner" }
    );
    useMCPJamLimitDialogStore.setState({
      isOpen: true,
      intent: "topup",
      organizationId: "org-a",
    });
    render(<MCPJamLimitDialog />);

    await user.click(screen.getByRole("button", { name: /^top up$/i }));

    expect(window.location.pathname).toBe("/organizations/org-a/billing");
    expect(window.location.search).toBe("?topup=open");
  });

  it("falls back to the most-recent membership org when no active org is stored", async () => {
    const user = userEvent.setup();
    authState.user = { id: "user-1" };
    sortedOrganizationsState.push({ _id: "org-fallback", myRole: "owner" });
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    await user.click(screen.getByRole("button", { name: /^top up$/i }));

    expect(window.location.pathname).toBe(
      "/organizations/org-fallback/billing"
    );
    expect(window.location.search).toBe("?topup=open");
  });

  it("keeps the modal open when no org is resolvable yet (e.g. membership still loading)", async () => {
    const user = userEvent.setup();
    authState.user = { id: "user-1" };
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    await user.click(screen.getByRole("button", { name: /^top up$/i }));

    // Modal stays open and no nav happens — once orgs load, the user can
    // click again and be routed correctly.
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(true);
    expect(window.location.hash).toBe("");
  });

  it("renders nothing for signed-in users when no intent is set", () => {
    authState.user = { id: "user-1" };
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: null });

    const { container } = render(<MCPJamLimitDialog />);
    expect(container).toBeEmptyDOMElement();
  });
});
