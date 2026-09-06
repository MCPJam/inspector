import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MCPJamLimitDialog } from "../mcpjam-limit-dialog";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { useModelPickerIntentStore } from "@/stores/model-picker-intent-store";

const signIn = vi.fn();
const signUp = vi.fn();
const trackMock = vi.hoisted(() => vi.fn());
// Guest credit-wall A/B flag. Defaults to control (undefined); treatment tests
// flip it to "treatment".
const guestVariantMock = vi.hoisted(() =>
  vi.fn<() => string | boolean | undefined>(() => undefined)
);
// Controls posthog's hasLoadedFlags so tests can exercise the flags-loading gate.
const flagsLoadedMock = vi.hoisted(() => ({ value: true }));
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
    signUp,
  }),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagVariantKey: (...args: unknown[]) => guestVariantMock(...args),
  // Matches the real contract: useActiveFeatureFlags always returns string[]
  // (the component uses it only for its re-render subscription). The load gate
  // reads hasLoadedFlags off the client, which flagsLoadedMock drives.
  useActiveFeatureFlags: () => [],
  usePostHog: () => ({
    featureFlags: { hasLoadedFlags: flagsLoadedMock.value },
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
  signUp.mockReset();
  guestVariantMock.mockReset();
  guestVariantMock.mockReturnValue(undefined);
  flagsLoadedMock.value = true;
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
    pendingInput: null,
  });
  useModelPickerIntentStore.setState({ openProvidersTabNonce: 0 });
});

afterEach(() => {
  window.location.hash = originalHash;
  // Restore any spies (e.g. window.open) even if an assertion threw first, so a
  // mock can't leak into a later test.
  vi.restoreAllMocks();
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
        variant: "control",
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

  it("renders the treatment copy and both CTAs when the flag is on", () => {
    guestVariantMock.mockReturnValue("treatment");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    expect(
      screen.getByRole("heading", { name: /there's so much more to jam on/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^create free account$/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^see paid plans$/i })
    ).toBeInTheDocument();
    // The control headline and single Sign in button are gone in treatment.
    expect(
      screen.queryByRole("heading", {
        name: /you've used up your free guest credits/i,
      })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^sign in$/i })
    ).not.toBeInTheDocument();
  });

  it("calls signUp() (not signIn) from the treatment primary CTA", async () => {
    const user = userEvent.setup();
    guestVariantMock.mockReturnValue("treatment");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    await user.click(
      screen.getByRole("button", { name: /^create free account$/i })
    );
    expect(signUp).toHaveBeenCalledTimes(1);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("opens the pricing page from the treatment secondary CTA", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    guestVariantMock.mockReturnValue("treatment");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    await user.click(screen.getByRole("button", { name: /^see paid plans$/i }));

    expect(openSpy).toHaveBeenCalledWith(
      "https://www.mcpjam.com/pricing",
      "_blank",
      "noopener,noreferrer"
    );
    openSpy.mockRestore();
  });

  it("tags the treatment impression with variant and create_account", () => {
    guestVariantMock.mockReturnValue("treatment");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    const impressions = trackMock.mock.calls.filter(
      ([event]) => event === "plan_limit_dialog_shown"
    );
    expect(impressions).toHaveLength(1);
    expect(impressions[0]?.[1]).toEqual(
      expect.objectContaining({
        wall_kind: "guest_credits",
        audience: "guest",
        variant: "treatment",
        primary_action: "create_account",
        secondary_action: "see_plans",
      })
    );
  });

  it("reports plan_limit_create_account_clicked from the treatment primary CTA", async () => {
    const user = userEvent.setup();
    guestVariantMock.mockReturnValue("treatment");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    await user.click(
      screen.getByRole("button", { name: /^create free account$/i })
    );
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_create_account_clicked",
      expect.objectContaining({ wall_kind: "guest_credits", variant: "treatment" })
    );
  });

  it("reports plan_limit_see_plans_clicked from the treatment secondary CTA", async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    guestVariantMock.mockReturnValue("treatment");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    await user.click(screen.getByRole("button", { name: /^see paid plans$/i }));
    expect(trackMock).toHaveBeenCalledWith(
      "plan_limit_see_plans_clicked",
      expect.objectContaining({ wall_kind: "guest_credits", variant: "treatment" })
    );
    openSpy.mockRestore();
  });

  it("hides the treatment illustration if the asset fails to load", () => {
    guestVariantMock.mockReturnValue("treatment");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    // The dialog renders through a portal on document.body, not the container.
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    // A missing asset must degrade to no image, not a broken one.
    fireEvent.error(img as HTMLImageElement);
    expect((img as HTMLImageElement).style.display).toBe("none");
  });

  it("treats an empty flag value as control", () => {
    guestVariantMock.mockReturnValue("");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    expect(
      screen.getByRole("heading", {
        name: /you've used up your free guest credits/i,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^sign in$/i })
    ).toBeInTheDocument();
  });

  it("freezes the variant for the opening even if the flag flips", () => {
    guestVariantMock.mockReturnValue("treatment");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    const view = render(<MCPJamLimitDialog />);

    // Flag resolves to a different value while the dialog is still open.
    guestVariantMock.mockReturnValue("control");
    view.rerender(<MCPJamLimitDialog />);

    // Copy must not swap under the user...
    expect(
      screen.getByRole("heading", { name: /there's so much more to jam on/i })
    ).toBeInTheDocument();
    // ...and exactly one impression was recorded, still tagged treatment.
    const impressions = trackMock.mock.calls.filter(
      ([event]) => event === "plan_limit_dialog_shown"
    );
    expect(impressions).toHaveLength(1);
    expect(impressions[0]?.[1]).toEqual(
      expect.objectContaining({ variant: "treatment" })
    );
  });

  it("does not read the guest flag until the wall is shown", () => {
    // The flag hook lives in the wall child, which only mounts when the wall
    // shows — so no PostHog exposure fires for sessions that never hit it.
    const { rerender } = render(<MCPJamLimitDialog />);
    expect(guestVariantMock).not.toHaveBeenCalled();

    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    rerender(<MCPJamLimitDialog />);
    expect(guestVariantMock).toHaveBeenCalled();
  });

  it("shows control and holds the impression until flags load", () => {
    flagsLoadedMock.value = false;
    guestVariantMock.mockReturnValue("treatment");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    const view = render(<MCPJamLimitDialog />);

    // Flags still loading: render the safe control fallback and do NOT enroll
    // or record a variant yet.
    expect(
      screen.getByRole("button", { name: /^sign in$/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^create free account$/i })
    ).not.toBeInTheDocument();
    expect(trackMock).not.toHaveBeenCalledWith(
      "plan_limit_dialog_shown",
      expect.anything()
    );

    // Flags resolve to treatment.
    flagsLoadedMock.value = true;
    view.rerender(<MCPJamLimitDialog />);

    expect(
      screen.getByRole("heading", { name: /there's so much more to jam on/i })
    ).toBeInTheDocument();
    const impressions = trackMock.mock.calls.filter(
      ([event]) => event === "plan_limit_dialog_shown"
    );
    expect(impressions).toHaveLength(1);
    expect(impressions[0]?.[1]).toEqual(
      expect.objectContaining({ variant: "treatment" })
    );
  });

  it("keeps a control fallback and records no impression while flags never load", () => {
    flagsLoadedMock.value = false;
    // A treatment-bucketed guest whose /flags never resolves (e.g. blocked)
    // must not be committed to control.
    guestVariantMock.mockReturnValue("treatment");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    // The guest still sees a usable control wall so they aren't stuck...
    expect(
      screen.getByRole("button", { name: /^sign in$/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^create free account$/i })
    ).not.toBeInTheDocument();
    // ...but nothing is recorded until the real variant resolves, so a late
    // treatment guest is never misattributed to control.
    expect(trackMock).not.toHaveBeenCalledWith(
      "plan_limit_dialog_shown",
      expect.anything()
    );
  });

  it("orders the primary CTA first in the DOM so it takes opening focus", () => {
    guestVariantMock.mockReturnValue("treatment");
    useMCPJamLimitDialogStore.setState({ isOpen: true, intent: "guest" });
    render(<MCPJamLimitDialog />);

    const create = screen.getByRole("button", {
      name: /^create free account$/i,
    });
    const plans = screen.getByRole("button", { name: /^see paid plans$/i });
    // "See paid plans" follows "Create free account" in the DOM, so Radix's
    // focus scope lands on the primary and Enter converts.
    expect(
      create.compareDocumentPosition(plans) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
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
