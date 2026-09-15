import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import type { AutoTopupView } from "@/hooks/useAutoTopup";
import { AutoTopupSettings } from "../AutoTopupSettings";
const view = (overrides: Partial<AutoTopupView> = {}): AutoTopupView => ({
  preferences: {
    thresholdCredits: 100,
    topupCredits: 1000,
    monthlySpendLimitCents: 2700,
    updatedAt: 1,
    updatedByUserId: "user",
  },
  revision: 1,
  consentVersion: "auto-topup-v1",
  currency: "usd",
  refillPriceCents: 900,
  eligible: true,
  activationAllowed: true,
  status: "not_active",
  paymentIssue: null,
  card: null,
  monthlySpend: { month: "2026-09", chargedCents: 900, reservedCents: 900 },
  ...overrides,
});
describe("AutoTopupSettings", () => {
  it("keeps unconfigured setup concise and billing details collapsed", () => {
    render(
      <AutoTopupSettings
        canManage
        cardSetupConfigured={false}
        view={view({
          preferences: null,
          status: "not_configured",
          activationAllowed: false,
          monthlySpend: { month: "2026-09", chargedCents: 0, reservedCents: 0 },
        })}
      />,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "setup is currently unavailable",
    );
    expect(screen.queryByText(/Charged:/)).not.toBeInTheDocument();
    expect(
      screen.getByText("How billing works").closest("details"),
    ).not.toHaveAttribute("open");
  });
  it("allows clearing settings after downgrade and surfaces failures", async () => {
    const clear = vi.fn().mockRejectedValue(new Error("Try again"));
    render(
      <AutoTopupSettings
        view={view({ eligible: false })}
        canManage
        onClear={clear}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Clear saved settings" }),
    );
    expect(clear).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent("Try again");
  });
  it("does not resave unchanged enrolled preferences but allows edits", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(
      <AutoTopupSettings
        view={view({ status: "enrolled" })}
        canManage
        onSave={save}
      />,
    );
    const button = screen.getByRole("button", { name: "Save settings" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(save).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Minimum balance"));
    await user.type(screen.getByLabelText("Minimum balance"), "200");
    expect(button).toBeEnabled();
    await user.click(button);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ thresholdCredits: 200 }),
    );
  });
  it("saves integer USD cents without claiming enrollment", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<AutoTopupSettings view={view()} canManage onSave={save} />);
    expect(screen.getByText(/Saved, not active/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Maximum monthly spend/)).toHaveValue("27.00");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(save).toHaveBeenCalledWith({
      thresholdCredits: 100,
      topupCredits: 1000,
      monthlySpendLimitCents: 2700,
    });
  });
  it("requires unchecked consent to the exact saved quote, and blocks unsaved edits", async () => {
    const user = userEvent.setup();
    const begin = vi.fn();
    render(<AutoTopupSettings view={view()} canManage onBegin={begin} />);
    expect(screen.getByLabelText(/I authorize/)).not.toBeChecked();
    expect(screen.getByLabelText(/I authorize/)).toHaveAccessibleName(
      /1,000 credits for \$9.00.*100.*\$27.00.*UTC/,
    );
    const button = screen.getByRole("button", {
      name: "Continue to card setup",
    });
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText(/I authorize/));
    await user.click(button);
    expect(begin).toHaveBeenCalledOnce();
    await user.clear(screen.getByLabelText("Minimum balance"));
    await user.type(screen.getByLabelText("Minimum balance"), "200");
    expect(button).toBeDisabled();
  });
  it("validates threshold, refill range and decimal money without rounding", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<AutoTopupSettings view={view()} canManage onSave={save} />);
    const amount = screen.getByLabelText("Credits to add");
    await user.clear(amount);
    await user.type(amount, "499");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(screen.getByRole("alert")).toHaveTextContent("500");
    await user.clear(amount);
    await user.type(amount, "1000");
    const cap = screen.getByLabelText(/Maximum monthly spend/);
    await user.clear(cap);
    await user.type(cap, "9.001");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(save).not.toHaveBeenCalled();
  });
  it("shows reserved spend and permits disabling when payment masks enrollment", async () => {
    const user = userEvent.setup();
    const disable = vi.fn();
    render(
      <AutoTopupSettings
        view={view({ status: "payment_pending", activationAllowed: false })}
        canManage
        onDisable={disable}
      />,
    );
    expect(
      screen.getByText(/already-authorized payment can still complete/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Charged: \$9.00.*Reserved: \$9.00/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Turn off auto-reload" }),
    );
    expect(disable).toHaveBeenCalledOnce();
    expect(
      screen.getByText(/New automatic purchases are off/),
    ).toBeInTheDocument();
  });
  it("keeps members read-only and rollout-off enrollment unavailable", () => {
    const { rerender } = render(
      <AutoTopupSettings view={view()} canManage={false} onBegin={vi.fn()} />,
    );
    expect(screen.getByLabelText("Credits to add")).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Continue to card setup" }),
    ).not.toBeInTheDocument();
    rerender(
      <AutoTopupSettings
        view={view({ activationAllowed: false })}
        canManage
        onBegin={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Continue to card setup" }),
    ).not.toBeInTheDocument();
  });
  it("shows unknown payment issues without offering a payment retry", () => {
    render(
      <AutoTopupSettings
        view={view({ status: "needs_attention", paymentIssue: "future_issue" })}
        canManage
      />,
    );
    expect(screen.getByText(/needs attention/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /retry payment/i }),
    ).not.toBeInTheDocument();
  });
});
