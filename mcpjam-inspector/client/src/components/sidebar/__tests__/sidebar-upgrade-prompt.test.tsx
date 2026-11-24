import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { SidebarUpgradePrompt } from "../sidebar-upgrade-prompt";
import { AccountCreatedToast } from "../sidebar-guest-signup-prompt";
import { SidebarProConfirmDialog } from "../sidebar-pro-upgrade-prompt";
import { markPendingSignUpToast } from "@/lib/pending-signup-toast";

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  toastSuccess: vi.fn(),
  signUp: vi.fn(),
  captureReturn: vi.fn(),
  billingStatus: vi.fn(),
  user: vi.fn(),
  start: vi.fn(),
  setInterval: vi.fn(),
  recipients: vi.fn(),
  assign: vi.fn(),
  hasPro: vi.fn(() => true),
  navigate: vi.fn(),
}));

const flags = vi.hoisted(() => ({
  proCard: "test" as string | boolean | undefined,
}));

vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => undefined,
  useFeatureFlagVariantKey: (key: string) =>
    key === "sidebar-pro-upgrade-card" ? flags.proCard : undefined,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess } }));
vi.mock("@/hooks/use-inspector-auth", () => ({
  useInspectorAuth: () => ({ signUp: mocks.signUp, signIn: vi.fn() }),
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: mocks.user() }),
}));
vi.mock("@/lib/app-signin-return-path", () => ({
  captureAppSignInReturnPath: mocks.captureReturn,
}));
vi.mock("@/lib/permalink-signin-return", () => ({
  permalinkSignInOptions: () => ({ state: "return" }),
}));
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/pricing-catalog", () => ({ canCheckoutPlan: () => true }));
vi.mock("@/hooks/useOrganizationBilling", () => ({
  useOrganizationBillingStatus: (organizationId: string | null) =>
    organizationId ? mocks.billingStatus() : undefined,
  useOrganizationBilling: () => ({
    planCatalog: {
      currency: "usd",
      plans: {
        free: { displayName: "Free" },
        pro: mocks.hasPro()
          ? { displayName: "Pro", prices: { monthly: 2900, annual: 29000 } }
          : undefined,
      },
    },
  }),
}));
vi.mock("@/hooks/use-upgrade-checkout", () => ({
  useUpgradeCheckout: () => ({
    interval: "monthly",
    setInterval: mocks.setInterval,
    annualDiscountPct: 17,
    currentPlan: "free",
    isStarting: false,
    start: mocks.start,
  }),
}));
vi.mock("@/hooks/use-upgrade-request-recipients", () => ({
  useUpgradeRequestRecipients: () => ({
    recipients: mocks.recipients(),
    isLoading: false,
  }),
}));
vi.mock("@/components/organization/PlanChangeConfirmDialog", () => ({
  PlanChangeConfirmDialog: ({
    plan,
    onConfirm,
    onIntervalChange,
    onOpenChange,
  }: {
    plan: string;
    onConfirm: () => void;
    onIntervalChange: (interval: "monthly" | "annual") => void;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-testid="plan-confirm-dialog" data-plan={plan}>
      <button onClick={() => onOpenChange(false)}>Close</button>
      <button onClick={() => onIntervalChange("annual")}>Annual</button>
      <button onClick={onConfirm}>Continue to checkout</button>
    </div>
  ),
}));

function freeStatus(overrides: Record<string, unknown> = {}) {
  return {
    organizationName: "Acme",
    effectivePlan: "free",
    trialStatus: "none",
    canManageBilling: true,
    isOwner: true,
    billingConfigured: true,
    ...overrides,
  };
}

function renderPrompt(props: { isGuest: boolean; organizationId?: string }) {
  return render(
    <SidebarProvider>
      <SidebarUpgradePrompt
        isGuest={props.isGuest}
        organizationId={props.organizationId ?? null}
      />
      <SidebarProConfirmDialog
        organizationId={props.organizationId ?? "org-1"}
      />
    </SidebarProvider>,
  );
}

function onPage(pathname: string) {
  vi.stubGlobal("location", { ...window.location, pathname });
}

describe("SidebarUpgradePrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    flags.proCard = "test";
    mocks.user.mockReturnValue(null);
    mocks.hasPro.mockReturnValue(true);
    mocks.billingStatus.mockReturnValue(freeStatus());
    mocks.start.mockResolvedValue({ redirected: true, shouldDismiss: false });
    mocks.recipients.mockReturnValue([
      { email: "owner@example.com", name: "Owner" },
    ]);
    vi.stubGlobal("location", {
      ...window.location,
      pathname: "/servers",
      hash: "",
      assign: mocks.assign,
    });
  });

  it("sends a guest straight to sign-up and remembers to confirm the account", () => {
    renderPrompt({ isGuest: true });

    const card = screen.getByTestId("sidebar-prompt-guest_signup");
    expect(card).toHaveTextContent("Create a free account");
    expect(card).toHaveTextContent(
      "Get 200 credits a day, plus every testing tool we offer",
    );
    expect(mocks.track).toHaveBeenCalledWith(
      "sidebar_prompt_shown",
      expect.objectContaining({ prompt: "guest_signup", page: "/servers" }),
    );

    fireEvent.click(card);

    expect(mocks.track).toHaveBeenCalledWith("sign_up_button_clicked", {
      location: "sidebar_prompt",
      page: "/servers",
    });
    expect(mocks.captureReturn).toHaveBeenCalled();
    expect(mocks.signUp).toHaveBeenCalledWith({ state: "return" });
    expect(sessionStorage.length).toBe(1);
  });

  it("confirms a new account once, after the guest returns signed in", () => {
    markPendingSignUpToast();
    mocks.user.mockReturnValue({ createdAt: new Date().toISOString() });

    const { rerender } = render(<AccountCreatedToast />);
    rerender(<AccountCreatedToast />);

    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Account created",
      expect.anything(),
    );
  });

  it("skips the account toast for an existing user who signed in instead", () => {
    markPendingSignUpToast();
    mocks.user.mockReturnValue({ createdAt: "2024-01-01T00:00:00.000Z" });

    render(<AccountCreatedToast />);

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("skips the account toast for an account made minutes before the click", () => {
    mocks.user.mockReturnValue({
      createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    markPendingSignUpToast();

    render(<AccountCreatedToast />);

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("shows nothing for an owner when billing is not configured", () => {
    mocks.billingStatus.mockReturnValue(
      freeStatus({ canManageBilling: false, billingConfigured: false }),
    );

    renderPrompt({ isGuest: false, organizationId: "org-1" });

    expect(screen.queryByTestId(/^sidebar-prompt-/)).toBeNull();
  });

  it("hides the member card when the catalog offers no Pro", () => {
    mocks.hasPro.mockReturnValue(false);
    mocks.billingStatus.mockReturnValue(
      freeStatus({ canManageBilling: false, isOwner: false }),
    );

    renderPrompt({ isGuest: false, organizationId: "org-1" });

    expect(screen.queryByTestId("sidebar-prompt-owner_request")).toBeNull();
  });

  it("opens the Plans page with the Pro confirm dialog for a Free owner", async () => {
    const { rerender } = renderPrompt({
      isGuest: false,
      organizationId: "org-1",
    });

    const card = screen.getByTestId("sidebar-prompt-pro_upgrade");
    expect(card).toHaveTextContent(
      "No daily credit limit, add more credits anytime",
    );
    fireEvent.click(card);

    expect(mocks.track).toHaveBeenCalledWith(
      "upgrade_button_clicked",
      expect.objectContaining({
        prompt: "pro_upgrade",
        plan: "free",
        target_plan: "pro",
        page: "/servers",
      }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith("/organizations/org-1/plans");
    onPage("/organizations/org-1/plans");
    // The Plans page hides the sidebar; the dialog must outlive the card.
    rerender(
      <SidebarProvider>
        <SidebarProConfirmDialog organizationId="org-1" />
      </SidebarProvider>,
    );
    expect(screen.getByTestId("plan-confirm-dialog")).toHaveAttribute(
      "data-plan",
      "pro",
    );

    fireEvent.click(screen.getByRole("button", { name: "Annual" }));
    expect(mocks.setInterval).toHaveBeenCalledWith("annual");

    fireEvent.click(
      screen.getByRole("button", { name: "Continue to checkout" }),
    );
    expect(mocks.track).toHaveBeenCalledWith(
      "plans_upgrade_confirm_submitted",
      expect.objectContaining({ location: "sidebar_prompt" }),
    );
    expect(mocks.start).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("plan-confirm-dialog")).toBeNull();
  });

  it("keeps the offer through a StrictMode re-mount on the Plans page", () => {
    renderPrompt({ isGuest: false, organizationId: "org-1" });
    fireEvent.click(screen.getByTestId("sidebar-prompt-pro_upgrade"));
    onPage("/organizations/org-1/plans");
    const { unmount } = render(
      <StrictMode>
        <SidebarProConfirmDialog organizationId="org-1" />
      </StrictMode>,
    );
    expect(screen.getAllByTestId("plan-confirm-dialog")).toHaveLength(2);
    unmount();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
  });

  it("drops the Pro offer once the user leaves the Plans page", () => {
    const { unmount } = renderPrompt({
      isGuest: false,
      organizationId: "org-1",
    });
    fireEvent.click(screen.getByTestId("sidebar-prompt-pro_upgrade"));
    expect(screen.getByTestId("plan-confirm-dialog")).toBeInTheDocument();

    onPage("/servers");
    unmount();
    renderPrompt({ isGuest: false, organizationId: "org-1" });
    expect(screen.queryByTestId("plan-confirm-dialog")).toBeNull();
  });

  it.each(["control", undefined])(
    "keeps today's sidebar for an owner in the %s arm",
    (variant) => {
      flags.proCard = variant;
      renderPrompt({ isGuest: false, organizationId: "org-1" });
      expect(screen.queryByTestId("sidebar-prompt-pro_upgrade")).toBeNull();
      expect(mocks.track).not.toHaveBeenCalledWith(
        "sidebar_prompt_shown",
        expect.anything(),
      );
    },
  );

  it("asks the owners instead of opening checkout for a member", () => {
    mocks.billingStatus.mockReturnValue(freeStatus({ canManageBilling: false, isOwner: false }));
    renderPrompt({ isGuest: false, organizationId: "org-1" });

    fireEvent.click(screen.getByTestId("sidebar-prompt-owner_request"));

    expect(screen.queryByTestId("plan-confirm-dialog")).not.toBeInTheDocument();
    expect(mocks.assign).toHaveBeenCalledWith(
      expect.stringMatching(/^mailto:owner%40example\.com|^mailto:owner@example\.com/),
    );
  });

  it("hides the member card when the org has no owner to ask", () => {
    mocks.billingStatus.mockReturnValue(freeStatus({ canManageBilling: false, isOwner: false }));
    mocks.recipients.mockReturnValue([]);
    renderPrompt({ isGuest: false, organizationId: "org-1" });

    expect(screen.queryByTestId(/sidebar-prompt-/)).not.toBeInTheDocument();
  });

  it.each([
    ["a paid org", freeStatus({ effectivePlan: "pro" })],
    ["an active trial", freeStatus({ trialStatus: "active" })],
  ])("shows nothing for %s", (_label, status) => {
    mocks.billingStatus.mockReturnValue(status);
    renderPrompt({ isGuest: false, organizationId: "org-1" });

    expect(screen.queryByTestId(/sidebar-prompt-/)).not.toBeInTheDocument();
  });
});
