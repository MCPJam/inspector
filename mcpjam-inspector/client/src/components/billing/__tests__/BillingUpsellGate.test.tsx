import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BillingUpsellGate } from "../BillingUpsellGate";

const captureMock = vi.fn();

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: captureMock }),
}));

vi.mock("@/lib/PosthogUtils", () => ({
  standardEventProps: (location: string) => ({
    location,
    platform: "web",
    environment: "test",
  }),
}));

describe("BillingUpsellGate", () => {
  beforeEach(() => {
    captureMock.mockReset();
  });

  it("captures billing_upsell_gate_viewed once on mount", () => {
    render(
      <BillingUpsellGate
        feature="chatboxes"
        currentPlan="free"
        upgradePlan="team"
        canManageBilling
        onNavigateToBilling={vi.fn()}
      />,
    );

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith("billing_upsell_gate_viewed", {
      location: "billing_upsell_gate",
      platform: "web",
      environment: "test",
      feature: "chatboxes",
      current_plan: "free",
      upgrade_plan: "team",
      can_manage_billing: true,
      surface: expect.any(String),
    });
  });

  it("shows Upgrade and calls onNavigateToBilling for billing managers", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <BillingUpsellGate
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
        feature="chatboxes"
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
