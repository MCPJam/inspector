import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it } from "vitest";
import { PricingEstimator } from "../PricingEstimator";
import type { PlanCatalogEntry } from "@/hooks/useOrganizationBilling";
it("updates a catalog-based estimate and explains the reservation boundary", () => {
  render(
    <PricingEstimator
      entry={
        {
          displayName: "Pro",
          rateCard: {
            id: "v2",
            creditsPerProviderDollar: 100,
            platformFees: { eval_step: 3 },
          },
        } as PlanCatalogEntry
      }
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("10 credits");
  fireEvent.change(screen.getByLabelText("Eval steps"), {
    target: { value: "10" },
  });
  expect(screen.getByRole("status")).toHaveTextContent("40 credits");
  expect(screen.getByText(/does not reserve credits/)).toBeInTheDocument();
});
