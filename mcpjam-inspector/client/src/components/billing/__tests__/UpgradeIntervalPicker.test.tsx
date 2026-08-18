import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { UpgradeIntervalPicker } from "../UpgradeIntervalPicker";

function renderPicker(
  overrides: Partial<ComponentProps<typeof UpgradeIntervalPicker>> = {}
) {
  const onUpgrade = vi.fn();
  const onIntervalChange = vi.fn();
  render(
    <UpgradeIntervalPicker
      interval="annual"
      onIntervalChange={onIntervalChange}
      annualPriceLabel="$30"
      monthlyPriceLabel="$38"
      annualDiscountPct={21}
      annualSupported
      monthlySupported
      teamName="Team"
      isStarting={false}
      onUpgrade={onUpgrade}
      {...overrides}
    />
  );
  return { onUpgrade, onIntervalChange };
}

describe("UpgradeIntervalPicker", () => {
  it("confirms the upgrade once the selected interval has a price", async () => {
    const user = userEvent.setup();
    const { onUpgrade } = renderPicker();

    const cta = screen.getByTestId("upgrade-plan-cta");
    expect(cta).toBeEnabled();
    await user.click(cta);

    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it("reports the choice without starting checkout", async () => {
    const user = userEvent.setup();
    const { onIntervalChange, onUpgrade } = renderPicker();

    await user.click(screen.getByTestId("upgrade-interval-monthly"));

    expect(onIntervalChange).toHaveBeenCalledWith("monthly");
    // Selecting is not confirming — the CTA is the only thing that buys.
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  it("freezes the whole picker while prices are explicitly loading", async () => {
    const user = userEvent.setup();
    // Both labels are present, so only the loading flag can close checkout
    // here — this is the flag's own path, not the missing-price one below.
    const { onIntervalChange, onUpgrade } = renderPicker({
      isLoadingPrices: true,
    });

    const cta = screen.getByTestId("upgrade-plan-cta");
    expect(cta).toBeDisabled();
    expect(cta).toHaveTextContent("Loading prices…");
    expect(screen.getByTestId("upgrade-interval-annual")).toBeDisabled();
    expect(screen.getByTestId("upgrade-interval-monthly")).toBeDisabled();

    await user.click(screen.getByTestId("upgrade-interval-monthly"));
    await user.click(cta);

    expect(onIntervalChange).not.toHaveBeenCalled();
    expect(onUpgrade).not.toHaveBeenCalled();
  });

  it("keeps checkout closed when the selected card shows no price", async () => {
    const user = userEvent.setup();
    const { onUpgrade } = renderPicker({ annualPriceLabel: null });

    const cta = screen.getByTestId("upgrade-plan-cta");
    expect(cta).toBeDisabled();
    expect(cta).toHaveTextContent("Loading prices…");
    await user.click(cta);

    expect(onUpgrade).not.toHaveBeenCalled();
  });

  it("stays usable when the unselected card is the one missing a price", () => {
    renderPicker({ monthlyPriceLabel: null });

    expect(screen.getByTestId("upgrade-plan-cta")).toBeEnabled();
  });

  it("renders nothing when no interval is supported", () => {
    renderPicker({ annualSupported: false, monthlySupported: false });

    expect(screen.queryByTestId("upgrade-plan-cta")).toBeNull();
  });
});
