import { describe, expect, it } from "vitest";
import {
  creditAllowanceLabel,
  creditUpgradeBenefit,
} from "../credit-limit-copy";
import type { PlanCatalogEntry } from "@/hooks/useOrganizationBilling";

describe("credit allowance purchase copy", () => {
  it("uses catalog quantities and distinguishes flat from per-seat allowances", () => {
    expect(creditAllowanceLabel({ model: "monthly_ledger", flat: 7500 })).toBe(
      "7,500 credits each month",
    );
    expect(
      creditAllowanceLabel({ model: "monthly_ledger", perSeat: 3000 }),
    ).toBe("3,000 credits per seat each month");
    const plan = {
      displayName: "Pro",
      includedCredits: { model: "monthly_ledger", flat: 7500 },
    } as PlanCatalogEntry;
    expect(creditUpgradeBenefit([plan])).toContain(
      "Pro includes 7,500 credits each month",
    );
    expect(creditUpgradeBenefit([plan])).toContain("evaluations and Swarms");
  });
  it("does not invent quantities for unknown, daily, negotiated, or invalid allowances", () => {
    expect(creditAllowanceLabel(undefined)).toBeNull();
    expect(
      creditAllowanceLabel({ model: "daily_bucket", dailyCredits: 200 }),
    ).toBeNull();
    expect(
      creditAllowanceLabel({ model: "monthly_ledger", negotiated: true }),
    ).toBeNull();
    expect(
      creditAllowanceLabel({ model: "monthly_ledger", flat: NaN }),
    ).toBeNull();
    expect(creditUpgradeBenefit()).toContain("more monthly credits");
    expect(creditUpgradeBenefit()).not.toMatch(/\d/);
  });
});
