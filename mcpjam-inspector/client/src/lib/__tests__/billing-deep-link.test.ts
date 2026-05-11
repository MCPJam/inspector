import { afterEach, describe, expect, it } from "vitest";
import {
  clearBillingSignInReturnPath,
  clearPersistedCheckoutIntent,
  hashMatchesOrganizationBilling,
  hasInvalidCheckoutIntervalParam,
  hasInvalidCheckoutQueryParams,
  isBillingEntryPathname,
  persistCheckoutIntent,
  readBillingSignInReturnPath,
  readCheckoutIntentFromSearch,
  readPersistedCheckoutIntent,
  resolveCheckoutOrganizationId,
  writeBillingSignInReturnPath,
} from "../billing-deep-link";

describe("readCheckoutIntentFromSearch", () => {
  it("parses team + annual", () => {
    expect(
      readCheckoutIntentFromSearch("?plan=team&interval=annual"),
    ).toEqual({ plan: "team", interval: "annual" });
  });

  it("defaults interval to monthly when omitted", () => {
    expect(readCheckoutIntentFromSearch("?plan=team")).toEqual({
      plan: "team",
      interval: "monthly",
    });
  });

  it("returns null for invalid plan", () => {
    expect(readCheckoutIntentFromSearch("?plan=solo")).toBeNull();
    expect(readCheckoutIntentFromSearch("?plan=enterprise")).toBeNull();
  });

  it("returns null when interval is present but invalid", () => {
    expect(
      readCheckoutIntentFromSearch("?plan=team&interval=weekly"),
    ).toBeNull();
  });
});

describe("hasInvalidCheckoutQueryParams", () => {
  it("is false when plan absent", () => {
    expect(hasInvalidCheckoutQueryParams("?foo=1")).toBe(false);
  });

  it("is true when plan is bogus", () => {
    expect(hasInvalidCheckoutQueryParams("?plan=bogus")).toBe(true);
  });
});

describe("hasInvalidCheckoutIntervalParam", () => {
  it("is false when interval absent", () => {
    expect(hasInvalidCheckoutIntervalParam("?plan=team")).toBe(false);
  });

  it("is true when interval invalid", () => {
    expect(hasInvalidCheckoutIntervalParam("?interval=weekly")).toBe(true);
  });
});

describe("sessionStorage persistence", () => {
  afterEach(() => {
    clearBillingSignInReturnPath();
    clearPersistedCheckoutIntent();
  });

  it("round-trips plan and interval", () => {
    persistCheckoutIntent({ plan: "team", interval: "annual" });
    expect(readPersistedCheckoutIntent()).toEqual({
      plan: "team",
      interval: "annual",
    });
  });

  it("round-trips the billing sign-in return path", () => {
    writeBillingSignInReturnPath("/billing");
    expect(readBillingSignInReturnPath()).toBe("/billing");
    clearBillingSignInReturnPath();
    expect(readBillingSignInReturnPath()).toBeNull();
  });

  it("ignores invalid billing sign-in return paths", () => {
    writeBillingSignInReturnPath("/servers");
    expect(readBillingSignInReturnPath()).toBeNull();
  });
});

describe("isBillingEntryPathname", () => {
  it("accepts /billing and /billing/", () => {
    expect(isBillingEntryPathname("/billing")).toBe(true);
    expect(isBillingEntryPathname("/billing/")).toBe(true);
  });

  it("rejects other paths", () => {
    expect(isBillingEntryPathname("/billing/foo")).toBe(false);
    expect(isBillingEntryPathname("/")).toBe(false);
  });
});

describe("hashMatchesOrganizationBilling", () => {
  it("matches canonical hash", () => {
    expect(
      hashMatchesOrganizationBilling(
        "#organizations/org_abc/billing",
        "org_abc",
      ),
    ).toBe(true);
  });

  it("rejects wrong org", () => {
    expect(
      hashMatchesOrganizationBilling(
        "#organizations/org_other/billing",
        "org_abc",
      ),
    ).toBe(false);
  });
});

describe("resolveCheckoutOrganizationId", () => {
  const orgs = [{ _id: "a" }, { _id: "b" }];

  it("returns null for empty list", () => {
    expect(resolveCheckoutOrganizationId([], "a", "b")).toBeNull();
  });

  it("returns sole org", () => {
    expect(
      resolveCheckoutOrganizationId([{ _id: "only" }], undefined, undefined),
    ).toBe("only");
  });

  it("prefers active organization when valid", () => {
    expect(resolveCheckoutOrganizationId(orgs, "b", "a")).toBe("b");
  });

  it("falls back to project org", () => {
    expect(resolveCheckoutOrganizationId(orgs, undefined, "a")).toBe("a");
  });

  it("falls back to first org", () => {
    expect(resolveCheckoutOrganizationId(orgs, "ghost", "ghost")).toBe("a");
  });
});
