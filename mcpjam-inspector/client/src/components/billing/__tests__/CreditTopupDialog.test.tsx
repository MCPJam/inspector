import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CreditTopupDialog } from "../CreditTopupDialog";

vi.mock("@/hooks/useCreditTopupPricing", () => ({
  useCreditTopupPricing: () =>
    Object.assign((preset: unknown) => preset, {
      canPurchase: pricingState.canPurchase,
      error: pricingState.error,
      requiresUpgrade: pricingState.requiresUpgrade,
      isLoading: pricingState.isLoading,
    }),
}));

const pricingState = vi.hoisted(() => ({
  canPurchase: true,
  requiresUpgrade: false,
  isLoading: false,
  error: null as Error | null,
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => navigateMock,
}));
const startCheckoutMock = vi.fn();
const trackMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/analytics", () => ({ track: trackMock }));

let presetsState:
  | Array<{
      packageId: string;
      priceCents: number;
      displayPrice: string;
      displayCredits: string;
    }>
  | undefined = undefined;
let presetsLoadingState = false;
let isStartingCheckoutState = false;

vi.mock("@/hooks/useCreditTopup", () => ({
  useCreditTopup: () => ({
    presets: presetsState,
    presetsLoading: presetsLoadingState,
    startCheckout: startCheckoutMock,
    isStartingCheckout: isStartingCheckoutState,
    error: null,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const DEFAULT_PRESETS = [
  {
    packageId: "credits_500",
    priceCents: 500,
    displayPrice: "$5",
    displayCredits: "500 credits",
  },
  {
    packageId: "credits_1000",
    priceCents: 1000,
    displayPrice: "$10",
    displayCredits: "1,000 credits",
  },
  {
    packageId: "credits_2000",
    priceCents: 2000,
    displayPrice: "$20",
    displayCredits: "2,000 credits",
  },
];

describe("CreditTopupDialog", () => {
  beforeEach(() => {
    pricingState.canPurchase = true;
    pricingState.requiresUpgrade = false;
    pricingState.isLoading = false;
    pricingState.error = null;
    startCheckoutMock.mockReset();
    trackMock.mockReset();
    presetsState = DEFAULT_PRESETS;
    presetsLoadingState = false;
    isStartingCheckoutState = false;
  });

  it("blocks ineligible manual purchases", async () => {
    pricingState.canPurchase = false;
    render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        organizationId="org-1"
        source="chat_banner"
      />,
    );
    const button = screen.getByRole("button", { name: /Continue/ });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(startCheckoutMock).not.toHaveBeenCalled();
  });
  it("renders three preset chips with the correct labels", () => {
    render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage="hello"
        organizationId="org-1"
        source="chat_banner"
      />,
    );

    expect(
      screen.getByRole("radio", { name: /500\s*credits/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /1,000\s*credits/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /2,000\s*credits/ }),
    ).toBeInTheDocument();
  });

  it("reports one rich impression across rerenders", async () => {
    const view = render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage="hello"
        organizationId="org-1"
        source="chat_banner"
      />,
    );

    // Rerender with a *changed* impression dependency. Identical props would
    // leave the effect's dependency array untouched, so the test would pass
    // with the ref guard deleted and prove nothing.
    view.rerender(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage="hello"
        organizationId="org-1"
        source="limit_modal"
      />,
    );

    await waitFor(() => {
      const impressions = trackMock.mock.calls.filter(
        ([event]) => event === "credit_topup_dialog_shown",
      );
      expect(impressions).toHaveLength(1);
      expect(impressions[0]?.[1]).toEqual(
        expect.objectContaining({
          source: "chat_banner",
          package_count: 3,
          organization_resolved: true,
          packages_available: true,
          has_resume_context: true,
        }),
      );
      expect(impressions[0]?.[1]).not.toHaveProperty("organization_id");
      expect(impressions[0]?.[1]).not.toHaveProperty("default_package_id");
    });
  });

  it("reports explicit package selection and dismissal once", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <CreditTopupDialog
        open
        onOpenChange={onOpenChange}
        chatSessionId="chat-1"
        lastUserMessage="hello"
        organizationId="org-1"
        source="limit_modal"
      />,
    );

    await user.click(screen.getByRole("radio", { name: /1,000\s*credits/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(trackMock).toHaveBeenCalledWith(
      "credit_topup_package_selected",
      expect.objectContaining({
        package_index: 1,
        package_count: 3,
      }),
    );
    expect(trackMock).toHaveBeenCalledWith(
      "credit_topup_dialog_dismissed",
      expect.objectContaining({
        dismissal_method: "cancel",
        had_selection: true,
      }),
    );
    for (const [, properties] of trackMock.mock.calls) {
      expect(properties).not.toHaveProperty("package_id");
      expect(properties).not.toHaveProperty("price_cents");
    }
    expect(
      trackMock.mock.calls.filter(
        ([event]) => event === "credit_topup_dialog_dismissed",
      ),
    ).toHaveLength(1);
  });

  it("auto-selects the first preset without surfacing fee or credited dollar amounts", () => {
    render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage="hello"
        organizationId="org-1"
        source="chat_banner"
      />,
    );

    expect(
      screen.getByRole("radio", { name: /500\s*credits/ }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByText(/Credits cover usage across our product/),
    ).toBeInTheDocument();
    expect(screen.getByText(/user testing, and CI\/CD/)).toBeInTheDocument();
    // The processing-fee disclaimer was removed so users can't back-compute
    // the take rate.
    expect(
      screen.queryByText(
        /A portion of your payment covers payment processing and platform fees/,
      ),
    ).not.toBeInTheDocument();
    // Guard against regressions that surface a "credited" / "you'll receive
    // $X.XX" dollar value (which would leak the take rate).
    expect(screen.queryByText(/You'll receive \$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/in model credit/)).not.toBeInTheDocument();
  });

  it("calls startCheckout with the selected package, org, and chat context", async () => {
    const user = userEvent.setup();
    render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage="please continue"
        organizationId="org-1"
        source="chat_banner"
      />,
    );

    await user.click(screen.getByRole("radio", { name: /1,000\s*credits/ }));
    await user.click(
      screen.getByRole("button", { name: /Continue with \$10/ }),
    );

    expect(startCheckoutMock).toHaveBeenCalledTimes(1);
    expect(startCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        packageId: "credits_1000",
        chatSessionId: "chat-1",
        lastUserMessage: "please continue",
        source: "chat_banner",
      }),
    );
    expect(startCheckoutMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "priceCents",
    );
  });

  it("passes the current page URL as returnUrl so Stripe round-trips back to it", async () => {
    const user = userEvent.setup();
    render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage=""
        organizationId="org-1"
        source="billing_page"
      />,
    );

    await user.click(screen.getByRole("radio", { name: /1,000\s*credits/ }));
    await user.click(
      screen.getByRole("button", { name: /Continue with \$10/ }),
    );

    expect(startCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: window.location.href,
      }),
    );
  });

  it("calls onOpenChange(false) when Cancel is clicked", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <CreditTopupDialog
        open
        onOpenChange={onOpenChange}
        chatSessionId="chat-1"
        lastUserMessage="hello"
        organizationId="org-1"
        source="chat_banner"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows a loading message while presets are fetching", () => {
    presetsState = undefined;
    presetsLoadingState = true;
    render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage="hello"
        organizationId="org-1"
        source="chat_banner"
      />,
    );

    expect(screen.getByText(/Loading amounts/)).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: /500\s*credits/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the unavailable message when no presets are returned", () => {
    presetsState = undefined;
    presetsLoadingState = false;
    render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage="hello"
        organizationId="org-1"
        source="chat_banner"
      />,
    );

    expect(
      screen.getByText(/Credit packages are unavailable/),
    ).toBeInTheDocument();
  });

  it("disables both buttons while a checkout is in flight", () => {
    isStartingCheckoutState = true;
    render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage="hello"
        organizationId="org-1"
        source="chat_banner"
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Redirecting/ })).toBeDisabled();
  });

  it("disables checkout when no organization is available", () => {
    render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage="hello"
        source="chat_banner"
      />,
    );

    expect(
      screen.getByRole("button", { name: /Continue with \$5/ }),
    ).toBeDisabled();
  });
});

it("keeps pricing failures in the dialog and allows dismissal", async () => {
  pricingState.error = new Error("Server Error");
  pricingState.canPurchase = false;
  const onOpenChange = vi.fn();
  render(
    <CreditTopupDialog
      open
      onOpenChange={onOpenChange}
      organizationId="org-1"
      chatSessionId=""
      lastUserMessage=""
      source="billing_page"
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Credit pricing is unavailable",
  );
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("routes Free organizations to Plans instead of checkout", async () => {
  const onOpenChange = vi.fn();
  navigateMock.mockClear();
  startCheckoutMock.mockClear();
  pricingState.error = null;
  pricingState.requiresUpgrade = true;
  pricingState.canPurchase = false;
  render(
    <CreditTopupDialog
      open
      onOpenChange={onOpenChange}
      organizationId="org-1"
      chatSessionId=""
      lastUserMessage=""
      source="billing_page"
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Upgrade to Pro or Team to buy credits.",
  );
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Continue/ }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Explore plan" }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(navigateMock).toHaveBeenCalledWith("/organizations/org-1/plans");
  expect(startCheckoutMock).not.toHaveBeenCalled();
});

it("waits for organization pricing before showing Free plan credit options", () => {
  pricingState.error = null;
  pricingState.requiresUpgrade = false;
  pricingState.isLoading = true;
  pricingState.canPurchase = false;
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    organizationId: "org-1",
    chatSessionId: "",
    lastUserMessage: "",
    source: "billing_page" as const,
  };
  const { rerender } = render(<CreditTopupDialog {...props} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading credit options",
  );
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  expect(screen.queryByText("Price at checkout")).not.toBeInTheDocument();
  pricingState.isLoading = false;
  pricingState.requiresUpgrade = true;
  rerender(<CreditTopupDialog {...props} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Upgrade to Pro or Team to buy credits.",
  );
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
});
