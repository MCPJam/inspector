import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MCPJamLimitDialog } from "../mcpjam-limit-dialog";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { useModelPickerIntentStore } from "@/stores/model-picker-intent-store";

const signIn = vi.fn();
const trackMock = vi.hoisted(() => vi.fn());
const upgradeHookOrganizationIdMock = vi.hoisted(() => vi.fn());
const recipientHookOrganizationIdMock = vi.hoisted(() => vi.fn());
const recipientsState = vi.hoisted(() => ({
  recipients: [{ email: "dana@acme.test", name: "Dana Ruiz" }],
  isLoading: false,
}));
const authState: { isLoading: boolean; user: { id: string } | null } = {
  isLoading: false,
  user: null,
};

const sortedOrganizationsState: Array<{
  _id: string;
  myRole?: string;
  isCreator?: boolean;
}> = [];

const upgradeState = {
  currentPlan: "free" as string,
  effectivePlan: "free" as string,
  canManageBilling: true,
  start: vi.fn(),
};

// The upgrade path has its own coverage in PlanLimitDialog.test.tsx. Stubbing
// it here keeps this file focused on the credits routing and copy, and avoids
// pulling the Convex plan-catalog queries into a mock that only exports
// useConvexAuth.
vi.mock("@/hooks/use-upgrade-checkout", () => ({
  useUpgradeCheckout: ({
    organizationId,
  }: {
    organizationId: string | null;
  }) => {
    upgradeHookOrganizationIdMock(organizationId);
    return {
      interval: "annual",
      setInterval: vi.fn(),
      annualPriceLabel: "$30",
      monthlyPriceLabel: "$38",
      annualDiscountPct: 21,
      annualSupported: true,
      monthlySupported: true,
      teamName: "Team",
      teamEvalIterations: 15000,
      currentPlan: upgradeState.currentPlan,
      effectivePlan: upgradeState.effectivePlan,
      organizationName: "Acme Robotics",
      canManageBilling: upgradeState.canManageBilling,
      isLoadingBilling: false,
      isStarting: false,
      start: upgradeState.start,
    };
  },
}));

vi.mock("@/lib/analytics", () => ({ track: trackMock }));

vi.mock("@/hooks/use-upgrade-request-recipients", () => ({
  useUpgradeRequestRecipients: (organizationId: string | null) => {
    recipientHookOrganizationIdMock(organizationId);
    return recipientsState;
  },
}));

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
  trackMock.mockReset();
  upgradeHookOrganizationIdMock.mockReset();
  recipientHookOrganizationIdMock.mockReset();
  upgradeState.start.mockReset();
  upgradeState.currentPlan = "free";
  upgradeState.effectivePlan = "free";
  upgradeState.canManageBilling = true;
  recipientsState.recipients = [{ email: "dana@acme.test", name: "Dana Ruiz" }];
  recipientsState.isLoading = false;
  authState.isLoading = false;
  authState.user = null;
  sortedOrganizationsState.length = 0;
  window.location.hash = "";
  localStorage.clear();
  useMCPJamLimitDialogStore.setState({
    authStatus: "loading",
    hasPendingLimit: false,
    outOfCreditsHit: false,
    outOfCreditsOrganizationId: null,
    isOpen: false,
    intent: null,
    organizationId: null,
    surface: null,
    period: null,
    pendingInput: null,
  });
  useModelPickerIntentStore.setState({ openProvidersTabNonce: 0 });
});

afterEach(() => {
  window.location.hash = originalHash;
});

describe("MCPJamLimitDialog", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<MCPJamLimitDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not subscribe to billing or owner members while closed", () => {
    authState.user = { id: "user-1" };
    localStorage.setItem("active-organization-id:user-1", "org-active");

    render(<MCPJamLimitDialog />);

    expect(upgradeHookOrganizationIdMock).toHaveBeenLastCalledWith(null);
    expect(recipientHookOrganizationIdMock).toHaveBeenLastCalledWith(null);
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

  it("reports the guest wall once across rerenders", () => {
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    const view = render(<MCPJamLimitDialog />);

    view.rerender(<MCPJamLimitDialog />);

    const impressions = trackMock.mock.calls.filter(
      ([event]) => event === "plan_limit_dialog_shown"
    );
    expect(impressions).toHaveLength(1);
    expect(impressions[0]?.[1]).toEqual(
      expect.objectContaining({
        wall_kind: "guest_credits",
        audience: "guest",
        primary_action: "sign_in",
      })
    );
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
      screen.getByRole("button", { name: /^buy credits$/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /use your own API key/i })
    ).toBeInTheDocument();
    expect(upgradeHookOrganizationIdMock).toHaveBeenLastCalledWith("org-1");
    expect(recipientHookOrganizationIdMock).toHaveBeenLastCalledWith("org-1");
  });

  it("closes after an in-place plan change succeeds", async () => {
    const user = userEvent.setup();
    authState.user = { id: "user-1" };
    sortedOrganizationsState.push({ _id: "org-1", myRole: "owner" });
    upgradeState.start.mockResolvedValue({
      redirected: false,
      shouldDismiss: true,
    });
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    await user.click(screen.getByTestId("upgrade-plan-cta"));

    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("does not pitch Team when a Team trial runs out of credits", () => {
    authState.user = { id: "user-1" };
    sortedOrganizationsState.push({ _id: "org-1", myRole: "owner" });
    upgradeState.currentPlan = "free";
    upgradeState.effectivePlan = "team";
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    expect(screen.getByTestId("limit-dialog-description")).toHaveTextContent(
      /Buy credits to keep your team going/
    );
    expect(screen.queryByTestId("upgrade-plan-cta")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^buy credits$/i })
    ).toBeInTheDocument();
  });

  it("shows the ask-owner copy and no CTAs for org members", () => {
    authState.user = { id: "user-1" };
    sortedOrganizationsState.push({ _id: "org-1", myRole: "member" });
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    // Owners, not admins: the only action here emails the resolved owners, and
    // an admin can't upgrade anyway.
    expect(screen.getByTestId("limit-dialog-description")).toHaveTextContent(
      /Ask an organization owner to buy credits or upgrade/
    );
    expect(
      screen.getByTestId("limit-dialog-description")
    ).not.toHaveTextContent(/admin/i);
    // Members can't buy or upgrade, so those CTAs stay gone. They now get one
    // action: email an owner who can.
    expect(
      screen.queryByRole("button", { name: /^buy credits$/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /use your own API key/i })
    ).not.toBeInTheDocument();
    // Decoded first: the address is percent-encoded in the href, so asserting
    // the raw string would be checking the encoding rather than the recipient.
    const memberHref = decodeURIComponent(
      screen.getByTestId("request-upgrade-mail").getAttribute("href") ?? ""
    );
    expect(memberHref).toContain("mailto:dana@acme.test");
  });

  it("waits for owner recipients before reporting a member impression", () => {
    authState.user = { id: "user-1" };
    sortedOrganizationsState.push({ _id: "org-1", myRole: "member" });
    recipientsState.recipients = [];
    recipientsState.isLoading = true;
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    const view = render(<MCPJamLimitDialog />);

    expect(trackMock).not.toHaveBeenCalledWith(
      "plan_limit_dialog_shown",
      expect.anything()
    );

    recipientsState.recipients = [
      { email: "dana@acme.test", name: "Dana Ruiz" },
    ];
    recipientsState.isLoading = false;
    view.rerender(<MCPJamLimitDialog />);

    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_dialog_shown",
      expect.objectContaining({
        wall_kind: "organization_credits",
        primary_action: "request_owner",
        request_recipient_count: 1,
      })
    );
  });

  it("waits for owner recipients before reporting an admin impression", () => {
    // An admin can buy credits but can't upgrade, so they still get a
    // request-an-owner button. Reporting before the owners resolve would
    // record a recipient count of 0 for a button that then renders.
    authState.user = { id: "user-1" };
    sortedOrganizationsState.push({ _id: "org-1", myRole: "admin" });
    upgradeState.canManageBilling = false;
    recipientsState.recipients = [];
    recipientsState.isLoading = true;
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    const view = render(<MCPJamLimitDialog />);

    expect(trackMock).not.toHaveBeenCalledWith(
      "plan_limit_dialog_shown",
      expect.anything()
    );

    recipientsState.recipients = [
      { email: "dana@acme.test", name: "Dana Ruiz" },
    ];
    recipientsState.isLoading = false;
    view.rerender(<MCPJamLimitDialog />);

    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_dialog_shown",
      expect.objectContaining({
        wall_kind: "organization_credits",
        can_buy_credits: true,
        can_manage_billing: false,
        request_recipient_count: 1,
      })
    );
    expect(screen.getByTestId("request-upgrade-mail")).toBeInTheDocument();
  });

  it("asks paid-org members to request credits instead of a Team upgrade", () => {
    authState.user = { id: "user-1" };
    sortedOrganizationsState.push({ _id: "org-1", myRole: "member" });
    upgradeState.currentPlan = "team";
    upgradeState.effectivePlan = "team";
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    expect(screen.getByTestId("limit-dialog-description")).toHaveTextContent(
      /Ask an organization owner to buy credits\./
    );
    const href = decodeURIComponent(
      screen.getByTestId("request-upgrade-mail").getAttribute("href") ?? ""
    );
    expect(href).toContain("Credit purchase request for Acme Robotics");
    expect(href).toContain("Our organization has run out of MCPJam credits.");
    expect(href).toContain("Could you buy more credits for Acme Robotics?");
    expect(href).not.toContain("upgrade Acme Robotics to the Team plan");
  });

  it("opens the model picker's Your providers tab on BYOK click (no org redirect)", async () => {
    const user = userEvent.setup();
    authState.user = { id: "user-1" };
    localStorage.setItem("active-organization-id:user-1", "org-active");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    const nonceBefore =
      useModelPickerIntentStore.getState().openProvidersTabNonce;
    render(<MCPJamLimitDialog />);

    await user.click(
      screen.getByRole("button", { name: /use your own API key/i })
    );

    // Closes the dialog and asks the picker to open its "Your providers" tab —
    // it must NOT navigate to the org models settings page.
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(useModelPickerIntentStore.getState().openProvidersTabNonce).toBe(
      nonceBefore + 1
    );
    expect(window.location.pathname).not.toContain("/models");
  });

  const openSwarmWall = (
    org: { _id: string; myRole?: string },
    period?: "daily" | "monthly"
  ) => {
    authState.user = { id: "user-1" };
    localStorage.setItem("active-organization-id:user-1", org._id);
    sortedOrganizationsState.push(org);
    useMCPJamLimitDialogStore.setState({
      isOpen: true,
      intent: "topup",
      surface: "swarm",
      period: period ?? null,
    });
  };

  it("names the daily allowance, and answers the BYOK question that filed the bug", () => {
    openSwarmWall({ _id: "org-active", myRole: "owner" }, "daily");
    render(<MCPJamLimitDialog />);

    expect(
      screen.getByRole("heading", { name: /daily MCPJam limit reached/i })
    ).toBeInTheDocument();
    // "I have my own key, why am I blocked" is the question that filed this
    // bug, and this modal is the only thing on screen to answer it.
    expect(screen.getByTestId("limit-dialog-description")).toHaveTextContent(
      /your own API key doesn't cover it/i
    );
    expect(screen.getByTestId("limit-dialog-description")).toHaveTextContent(
      /resets tomorrow/i
    );
  });

  it("tells a Team org its credits renew with the billing period, not tomorrow", () => {
    openSwarmWall({ _id: "org-active", myRole: "owner" }, "monthly");
    render(<MCPJamLimitDialog />);

    expect(
      screen.getByRole("heading", { name: /monthly MCPJam credits spent/i })
    ).toBeInTheDocument();
    // Telling a monthly org to wait for "tomorrow" would be plain wrong: the
    // allowance renews with the billing period, which can be weeks out.
    expect(screen.getByTestId("limit-dialog-description")).toHaveTextContent(
      /renew with the billing period/i
    );
    expect(
      screen.getByTestId("limit-dialog-description")
    ).not.toHaveTextContent(/resets tomorrow/i);
  });

  it("falls back to period-neutral copy when the message didn't say which", () => {
    openSwarmWall({ _id: "org-active", myRole: "owner" });
    render(<MCPJamLimitDialog />);

    expect(
      screen.getByRole("heading", { name: /MCPJam model limit reached/i })
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("limit-dialog-description")
    ).not.toHaveTextContent(/tomorrow|billing period/i);
  });

  it("offers only the actions that resolve a swarm limit", () => {
    openSwarmWall({ _id: "org-active", myRole: "owner" }, "daily");
    render(<MCPJamLimitDialog />);

    expect(
      screen.getByRole("button", { name: /buy MCPJam credits/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /explore MCPJam plans/i })
    ).toBeInTheDocument();
    // Both dead ends on a swarm: no screen there mounts the model picker the
    // BYOK link drives, and the upgrade picker belongs to the credits wall.
    expect(
      screen.queryByRole("button", { name: /use your own API key/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/\$30/)).not.toBeInTheDocument();
  });

  it("routes a member who can't buy credits to an owner instead", () => {
    openSwarmWall({ _id: "org-active", myRole: "member" }, "daily");
    render(<MCPJamLimitDialog />);

    expect(
      screen.queryByRole("button", { name: /buy MCPJam credits/i })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("request-upgrade-mail")).toBeInTheDocument();
    // The owner guidance is ADDED to the explanation, not swapped for it. A
    // member asks "my own key is configured, why am I blocked" too.
    const description = screen.getByTestId("limit-dialog-description");
    expect(description).toHaveTextContent(/your own API key doesn't cover it/i);
    expect(description).toHaveTextContent(/resets tomorrow/i);
    expect(description).toHaveTextContent(/ask an organization owner/i);
  });

  it("sends Explore MCPJam plans to billing without the topup flag", async () => {
    const user = userEvent.setup();
    openSwarmWall({ _id: "org-active", myRole: "owner" });
    render(<MCPJamLimitDialog />);

    await user.click(
      screen.getByRole("button", { name: /explore MCPJam plans/i })
    );

    expect(window.location.pathname).toBe("/organizations/org-active/billing");
    // Plans sit below credits and payment history; the flag is what scrolls
    // the page to them. Not `topup`, which opens the purchase dialog instead.
    expect(window.location.search).toContain("plans=open");
    expect(window.location.search).not.toContain("topup");
  });

  it("redirects to the active org's billing page with the topup flag on CTA click", async () => {
    const user = userEvent.setup();
    authState.user = { id: "user-1" };
    localStorage.setItem("active-organization-id:user-1", "org-active");
    sortedOrganizationsState.push({ _id: "org-fallback" });
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    await user.click(screen.getByRole("button", { name: /^buy credits$/i }));

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

    await user.click(screen.getByRole("button", { name: /^buy credits$/i }));

    expect(window.location.pathname).toBe("/organizations/org-a/billing");
    expect(window.location.search).toBe("?topup=open");
  });

  it("falls back to the most-recent membership org when no active org is stored", async () => {
    const user = userEvent.setup();
    authState.user = { id: "user-1" };
    sortedOrganizationsState.push({ _id: "org-fallback", myRole: "owner" });
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "topup" });
    render(<MCPJamLimitDialog />);

    await user.click(screen.getByRole("button", { name: /^buy credits$/i }));

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

    await user.click(screen.getByRole("button", { name: /^buy credits$/i }));

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
