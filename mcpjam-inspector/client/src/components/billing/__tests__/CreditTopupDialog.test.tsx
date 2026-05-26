import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CreditTopupDialog } from "../CreditTopupDialog";

const startCheckoutMock = vi.fn();

let presetsState: Array<{
  amountCents: number;
  amountUsd: string;
}> | undefined = undefined;
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
  { amountCents: 500, amountUsd: "$5" },
  { amountCents: 1000, amountUsd: "$10" },
  { amountCents: 2000, amountUsd: "$20" },
];

describe("CreditTopupDialog", () => {
  beforeEach(() => {
    startCheckoutMock.mockReset();
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
        source="chat_banner"
      />,
    );

    expect(screen.getByRole("radio", { name: "$5" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "$10" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "$20" })).toBeInTheDocument();
  });

  it("auto-selects the first preset without surfacing fee or credited dollar amounts", () => {
    render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage="hello"
        source="chat_banner"
      />,
    );

    expect(screen.getByRole("radio", { name: "$5" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
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

  it("calls startCheckout with the selected amount and chat context", async () => {
    const user = userEvent.setup();
    render(
      <CreditTopupDialog
        open
        onOpenChange={vi.fn()}
        chatSessionId="chat-1"
        lastUserMessage="please continue"
        source="chat_banner"
      />,
    );

    await user.click(screen.getByRole("radio", { name: "$10" }));
    await user.click(
      screen.getByRole("button", { name: /Continue with \$10/ }),
    );

    expect(startCheckoutMock).toHaveBeenCalledTimes(1);
    expect(startCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 1000,
        chatSessionId: "chat-1",
        lastUserMessage: "please continue",
        source: "chat_banner",
      }),
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
        source="billing_page"
      />,
    );

    await user.click(screen.getByRole("radio", { name: "$10" }));
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
        source="chat_banner"
      />,
    );

    expect(screen.getByText(/Loading amounts/)).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: "$5" }),
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
        source="chat_banner"
      />,
    );

    expect(
      screen.getByText(/Top-up amounts are unavailable/),
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
        source="chat_banner"
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Redirecting/ }),
    ).toBeDisabled();
  });
});
