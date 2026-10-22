import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { expectLegalConsentLinks } from "@/test/legal-consent";
import { FrontierSignInDialogView } from "@/components/billing/FrontierSignInDialogView";
import { GuestCreditWallView } from "@/components/billing/GuestCreditWallView";
import { PlanLimitDialogView } from "@/components/billing/PlanLimitDialogView";

function renderPlanLimit(showUpgrade: boolean) {
  render(
    <PlanLimitDialogView
      title="Eval limit reached"
      description="Upgrade to keep running evals."
      showUpgrade={showUpgrade}
      showEnterprise={!showUpgrade}
      showRequest={false}
      requestRecipients={[]}
      organizationId="org-1"
      organizationName="Acme"
      origin="evals"
      limitKind="eval_iterations"
      interval="monthly"
      onIntervalChange={vi.fn()}
      annualPriceLabel="$30"
      monthlyPriceLabel="$38"
      annualDiscountPct={21}
      annualSupported
      monthlySupported
      teamName="Team"
      isStarting={false}
      onUpgrade={vi.fn()}
      onRequestEnterprise={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
}

describe("legal consent links in guest and checkout dialogs", () => {
  it.each([true, false])(
    "guest credit wall links both documents (treatment: %s)",
    (isTreatment) => {
      render(
        <GuestCreditWallView
          isTreatment={isTreatment}
          onDismiss={vi.fn()}
          onCreateAccount={vi.fn()}
          onSeePlans={vi.fn()}
          onSignIn={vi.fn()}
        />,
      );
      expectLegalConsentLinks();
    },
  );

  it("frontier sign-in dialog links both documents", () => {
    render(<FrontierSignInDialogView onSignIn={vi.fn()} onDismiss={vi.fn()} />);
    expectLegalConsentLinks();
  });

  it("plan limit dialog links both documents next to self-serve upgrade", () => {
    renderPlanLimit(true);
    expectLegalConsentLinks();
  });

  it("plan limit dialog shows no consent line on the sales path", () => {
    renderPlanLimit(false);
    expect(
      screen.queryByRole("link", { name: "Terms of Use" }),
    ).not.toBeInTheDocument();
  });

  it("opens the documents in a new tab", () => {
    render(<FrontierSignInDialogView onSignIn={vi.fn()} onDismiss={vi.fn()} />);
    const link = screen.getByRole("link", { name: "Privacy Policy" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
