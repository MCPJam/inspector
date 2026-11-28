import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PastDueBanner, type PastDueBannerStatus } from "../PastDueBanner";

const { openBillingUrlInNewTab } = vi.hoisted(() => ({
  openBillingUrlInNewTab: vi.fn(async () => true),
}));
vi.mock("@/lib/billing-portal-tab", () => ({
  reserveBillingTab: () => null,
  openBillingUrlInNewTab,
}));

const GRACE_ENDS_AT = Date.UTC(2026, 11, 11, 12);

function status(
  overrides: Partial<PastDueBannerStatus> = {},
): PastDueBannerStatus {
  return {
    organizationId: "org-1",
    organizationName: "Acme Labs",
    plan: "team",
    source: "subscription",
    billingConfigured: true,
    canManageBilling: true,
    paymentState: "past_due",
    paymentGraceEndsAt: GRACE_ENDS_AT,
    ...overrides,
  };
}

const openPortal = vi.fn<(returnUrl: string) => Promise<string>>();

function renderBanner(billingStatus: PastDueBannerStatus) {
  return render(
    <PastDueBanner
      billingStatus={billingStatus}
      openPortal={openPortal}
      isOpeningPortal={false}
    />,
  );
}

const graceLabel = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
}).format(new Date(GRACE_ENDS_AT));

describe("PastDueBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openPortal.mockResolvedValue("https://billing.stripe.test/session");
  });

  it("asks a billing manager to update the card by the grace date", () => {
    renderBanner(status());
    expect(screen.getByRole("alert").textContent).toContain(
      `Payment failed for Acme Labs. Update your card by ${graceLabel} to keep Team.`,
    );
    expect(screen.getByRole("button", { name: "Update card" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("drops the date when there is no grace period", () => {
    renderBanner(status({ paymentGraceEndsAt: null }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Payment failed for Acme Labs. Update your card to keep Team.",
    );
  });

  it("opens the billing portal in a new tab from Update card", async () => {
    renderBanner(status());
    fireEvent.click(screen.getByRole("button", { name: "Update card" }));
    await waitFor(() =>
      expect(openBillingUrlInNewTab).toHaveBeenCalledWith(
        "https://billing.stripe.test/session",
        null,
      ),
    );
    expect(openPortal).toHaveBeenCalledWith(
      `${window.location.origin}/organizations/org-1/billing`,
    );
  });

  it("shows members a quiet bar with no action, which they can dismiss", () => {
    renderBanner(status({ canManageBilling: false }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Billing for Acme Labs needs attention. An owner has been asked to update the card.",
    );
    expect(screen.queryByRole("button", { name: "Update card" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows nothing when the payment is fine", () => {
    renderBanner(status({ paymentState: "ok" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows nothing to organization guests", () => {
    render(
      <PastDueBanner
        billingStatus={status({ canManageBilling: false })}
        viewerRole="guest"
        openPortal={openPortal}
        isOpeningPortal={false}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    ["owner banner", true, "alert"],
    ["member bar", false, "status"],
  ] as const)(
    "removes the %s once the payment goes through",
    (_, canManageBilling, role) => {
      const { rerender } = renderBanner(status({ canManageBilling }));
      expect(screen.getByRole(role)).toBeTruthy();
      rerender(
        <PastDueBanner
          billingStatus={status({ canManageBilling, paymentState: "ok" })}
          openPortal={openPortal}
          isOpeningPortal={false}
        />,
      );
      expect(screen.queryByRole(role)).toBeNull();
    },
  );

  it("shows the member bar again if a payment fails after recovering", () => {
    const props = { openPortal, isOpeningPortal: false };
    const { rerender } = render(
      <PastDueBanner
        billingStatus={status({ canManageBilling: false })}
        {...props}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    rerender(
      <PastDueBanner
        billingStatus={status({ canManageBilling: false, paymentState: "ok" })}
        {...props}
      />,
    );
    rerender(
      <PastDueBanner
        billingStatus={status({ canManageBilling: false })}
        {...props}
      />,
    );
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
