import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BillingUpsellGate } from "../BillingUpsellGate";

describe("BillingUpsellGate", () => {
  it("shows Upgrade and calls onNavigateToBilling for billing managers", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <BillingUpsellGate
        feature="evals"
        currentPlan="free"
        upgradePlan="starter"
        canManageBilling
        onNavigateToBilling={onNavigate}
      />,
    );

    expect(screen.getByText("Generate Evals")).toBeInTheDocument();
    expect(
      screen.getByText(/Included in Starter and above/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /upgrade/i }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("shows ask-admin copy when user cannot manage billing", () => {
    render(
      <BillingUpsellGate
        feature="sandboxes"
        currentPlan="free"
        upgradePlan="team"
        canManageBilling={false}
        onNavigateToBilling={vi.fn()}
      />,
    );

    expect(screen.getByText(/Ask your admin to upgrade/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /upgrade/i }),
    ).not.toBeInTheDocument();
  });
});
