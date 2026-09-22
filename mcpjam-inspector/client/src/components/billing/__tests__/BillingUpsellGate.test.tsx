import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BillingUpsellGate } from "../BillingUpsellGate";

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));

vi.mock("@/lib/analytics", () => ({
  track: trackMock,
}));

describe("BillingUpsellGate", () => {
  beforeEach(() => {
    trackMock.mockReset();
  });

  it("captures billing_upsell_gate_viewed once on mount", () => {
    render(
      <BillingUpsellGate
        organizationId="org-1"
        feature="scenarios"
        currentPlan="free"
        upgradePlan="team"
        canManageBilling
        onNavigateToBilling={vi.fn()}
      />,
    );

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith("billing_upsell_gate_viewed", {
      location: "billing_upsell_gate",
      organization_id: "org-1",
      feature: "scenarios",
      current_plan: "free",
      upgrade_plan: "team",
      can_manage_billing: true,
      surface: expect.any(String),
    });
  });

  it("captures a new impression when the organization changes without a remount", () => {
    const { rerender } = render(
      <BillingUpsellGate
        organizationId="org-1"
        feature="scenarios"
        currentPlan="free"
        upgradePlan="team"
        canManageBilling
        onNavigateToBilling={vi.fn()}
      />,
    );

    rerender(
      <BillingUpsellGate
        organizationId="org-1"
        feature="scenarios"
        currentPlan="free"
        upgradePlan="team"
        canManageBilling
        onNavigateToBilling={vi.fn()}
      />,
    );
    expect(trackMock).toHaveBeenCalledTimes(1);

    rerender(
      <BillingUpsellGate
        organizationId="org-2"
        feature="scenarios"
        currentPlan="free"
        upgradePlan="team"
        canManageBilling
        onNavigateToBilling={vi.fn()}
      />,
    );

    expect(trackMock).toHaveBeenCalledTimes(2);
    expect(trackMock).toHaveBeenLastCalledWith(
      "billing_upsell_gate_viewed",
      expect.objectContaining({ organization_id: "org-2" }),
    );
  });

  it("shows Upgrade and calls onNavigateToBilling for billing managers", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <BillingUpsellGate
        organizationId="org-1"
        feature="evals"
        currentPlan="free"
        upgradePlan="team"
        canManageBilling
        onNavigateToBilling={onNavigate}
      />,
    );

    expect(screen.getByText("Generate Evals")).toBeInTheDocument();
    expect(
      screen.getByText(/Included in Team and above/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /upgrade/i }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("shows ask-admin copy when user cannot manage billing", () => {
    render(
      <BillingUpsellGate
        organizationId="org-1"
        feature="scenarios"
        currentPlan="free"
        upgradePlan="team"
        canManageBilling={false}
        onNavigateToBilling={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        /Share a hosted chat link for each client, manage access, and review sessions and feedback/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ask your admin to upgrade/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /upgrade/i }),
    ).not.toBeInTheDocument();
  });
});
