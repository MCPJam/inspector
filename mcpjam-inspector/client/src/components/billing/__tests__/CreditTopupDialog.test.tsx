import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CreditTopupDialog } from "../CreditTopupDialog";

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
    startCheckoutMock.mockReset();
    trackMock.mockReset();
    presetsState = DEFAULT_PRESETS;
    presetsLoadingState = false;
    isStartingCheckoutState = false;
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
      />
    );

    expect(
      screen.getByRole("radio", { name: /500\s*credits/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /1,000\s*credits/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /2,000\s*credits/ })
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
      />
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
      />
    );

    await waitFor(() => {
      const impressions = trackMock.mock.calls.filter(
        ([event]) => event === "credit_topup_dialog_shown"
      );
      expect(impressions).toHaveLength(1);
      expect(impressions[0]?.[1]).toEqual(
        expect.objectContaining({
          organization_id: "org-1",
          source: "chat_banner",
          package_count: 3,
          default_package_id: "credits_500",
          has_resume_context: true,
        })
      );
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
      />
    );

    await user.click(screen.getByRole("radio", { name: /1,000\s*credits/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(trackMock).toHaveBeenCalledWith(
      "credit_topup_package_selected",
      expect.objectContaining({
        package_id: "credits_1000",
        price_cents: 1000,
        package_index: 1,
      })
    );
    expect(trackMock).toHaveBeenCalledWith(
      "credit_topup_dialog_dismissed",
      expect.objectContaining({
        dismissal_method: "cancel",
        selected_package_id: "credits_1000",
      })
    );
    expect(
      trackMock.mock.calls.filter(
        ([event]) => event === "credit_topup_dialog_dismissed"
      )
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
      />
    );

    expect(
      screen.getByRole("radio", { name: /500\s*credits/ })
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByText(
        /Credits cover model usage in chat, playground, and agents/
      )
    ).toBeInTheDocument();
    // Names the boundary explicitly so nobody buys credits expecting a higher
    // eval-iteration cap.
    expect(
      screen.getByText(/doesn't change your plan limits/)
    ).toBeInTheDocument();
    // The processing-fee disclaimer was removed so users can't back-compute
    // the take rate.
    expect(
      screen.queryByText(
        /A portion of your payment covers payment processing and platform fees/
      )
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
      />
    );

    await user.click(screen.getByRole("radio", { name: /1,000\s*credits/ }));
    await user.click(
      screen.getByRole("button", { name: /Continue with \$10/ })
    );

    expect(startCheckoutMock).toHaveBeenCalledTimes(1);
    expect(startCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        packageId: "credits_1000",
        priceCents: 1000,
        chatSessionId: "chat-1",
        lastUserMessage: "please continue",
        source: "chat_banner",
      })
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
      />
    );

    await user.click(screen.getByRole("radio", { name: /1,000\s*credits/ }));
    await user.click(
      screen.getByRole("button", { name: /Continue with \$10/ })
    );

    expect(startCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        returnUrl: window.location.href,
      })
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
      />
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
      />
    );

    expect(screen.getByText(/Loading amounts/)).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: /500\s*credits/ })
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
      />
    );

    expect(
      screen.getByText(/Credit packages are unavailable/)
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
      />
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
      />
    );

    expect(
      screen.getByRole("button", { name: /Continue with \$5/ })
    ).toBeDisabled();
  });
});
