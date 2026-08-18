import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OrganizationBillingSection } from "@/components/organization/OrganizationBillingSection";

vi.mock("@/hooks/useCreditTopupReturnFlow", () => ({
  useCreditTopupReturnFlowBilling: () => undefined,
}));

// `planCatalog` is undefined in two unrelated situations: the read is still in
// flight, and the org was denied it. The card renders on `!planCatalog` either
// way, so only the copy can tell them apart.
function renderCatalogCard(isLoadingPlanCatalog: boolean) {
  return render(
    <OrganizationBillingSection
      organizationId="org_1"
      organizationName="Acme"
      showPlanBilling
      showCredits={false}
      canManageCredits={false}
      billingStatus={undefined}
      planCatalog={undefined}
      isLoadingBilling={false}
      isLoadingPlanCatalog={isLoadingPlanCatalog}
      isStartingPlanChange={false}
      pendingPlanChangeTarget={null}
      isOpeningPortal={false}
      onDowngradePlan={vi.fn()}
      onStartPlanChange={vi.fn()}
    />
  );
}

describe("OrganizationBillingSection plan catalog placeholder", () => {
  it("says it is loading while the catalog read is in flight", () => {
    renderCatalogCard(true);

    expect(screen.getByText("Loading plan catalog...")).toBeInTheDocument();
  });

  // The denial case: the flag is already false, so claiming to load here is a
  // spinner that never resolves.
  it("says the catalog is unavailable once the read has resolved without one", () => {
    renderCatalogCard(false);

    expect(
      screen.getByText("Plan catalog unavailable for this organization.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading plan catalog...")).toBeNull();
  });
});
