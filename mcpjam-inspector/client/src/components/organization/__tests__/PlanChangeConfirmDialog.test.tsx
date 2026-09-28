import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PlanChangeConfirmDialog } from "../PlanChangeConfirmDialog";
import type { PlanCatalogEntry } from "@/hooks/useOrganizationBilling";

function makeEntry(overrides: Partial<PlanCatalogEntry> = {}): PlanCatalogEntry {
  return {
    plan: "team",
    displayName: "Team",
    billingModel: "flat",
    isSelfServe: true,
    prices: { monthly: 3800, annual: 36000 },
    features: {} as PlanCatalogEntry["features"],
    limits: {} as PlanCatalogEntry["limits"],
    includedSeats: null,
    seatMinimum: null,
    checkout: { plan: "team", supportedIntervals: ["monthly", "annual"] },
    ...overrides,
  };
}

function renderDialog(
  overrides: Partial<ComponentProps<typeof PlanChangeConfirmDialog>> = {},
) {
  const onConfirm = vi.fn();
  const onIntervalChange = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <PlanChangeConfirmDialog
      open
      onOpenChange={onOpenChange}
      plan="team"
      entry={makeEntry()}
      currency="USD"
      interval="annual"
      onIntervalChange={onIntervalChange}
      annualDiscountPct={21}
      currentPlanName="Free"
      seatQuantity={null}
      isNewSubscription
      isStarting={false}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onConfirm, onIntervalChange, onOpenChange };
}

describe("PlanChangeConfirmDialog", () => {
  it("names the yearly charge before confirming a flat annual plan", () => {
    const { onConfirm } = renderDialog();

    expect(screen.getByTestId("plan-confirm-charge")).toHaveTextContent(
      "$360 per year",
    );
    fireEvent.click(screen.getByTestId("plan-confirm-cta"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("reports an interval change without confirming", () => {
    const { onIntervalChange, onConfirm } = renderDialog();

    fireEvent.click(screen.getByTestId("plan-confirm-interval-monthly"));

    expect(onIntervalChange).toHaveBeenCalledWith("monthly");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("multiplies a per-seat price by the seats Stripe will bill", () => {
    renderDialog({
      entry: makeEntry({ billingModel: "per_seat", seatMinimum: 2 }),
      interval: "monthly",
      seatQuantity: 3,
    });

    expect(screen.getByTestId("plan-confirm-charge")).toHaveTextContent(
      "$114 per month (3 seats)",
    );
  });

  it("claims no total for a per-seat plan with an unknown seat count", () => {
    renderDialog({ entry: makeEntry({ billingModel: "per_seat" }) });

    expect(screen.getByTestId("plan-confirm-charge")).toHaveTextContent(
      "Confirmed at checkout",
    );
  });

  it("offers only the intervals the plan can be checked out on", () => {
    renderDialog({
      entry: makeEntry({
        prices: { monthly: null, annual: 36000 },
        checkout: { plan: "team", supportedIntervals: ["annual"] },
      }),
    });

    expect(screen.queryByTestId("plan-confirm-interval-monthly")).toBeNull();
    expect(screen.getByTestId("plan-confirm-interval-annual")).toBeTruthy();
  });

  it("holds the dialog open while checkout is starting", () => {
    const { onOpenChange } = renderDialog({ isStarting: true });

    expect(screen.getByTestId("plan-confirm-cta")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
