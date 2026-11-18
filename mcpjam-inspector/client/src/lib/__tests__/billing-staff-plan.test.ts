import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatStaffPlanEndLine,
  getDisplayedCurrentPlan,
  isStaffSetPlan,
} from "../billing-staff-plan";

type StaffPlanFixture = NonNullable<
  Parameters<typeof getDisplayedCurrentPlan>[0]
>;

function billingStatusFixture(
  overrides: Partial<StaffPlanFixture> = {},
): StaffPlanFixture {
  return {
    plan: "free",
    effectivePlan: "free",
    source: "subscription",
    ...overrides,
  };
}

// Midnight UTC after Dec 31, 2026: the exclusive end of a plan through Dec 31.
const END_OF_2026 = Date.UTC(2027, 0, 1);

describe("isStaffSetPlan", () => {
  it("is true only when the backend sends a staff plan", () => {
    expect(
      isStaffSetPlan(billingStatusFixture({ staffPlan: { expiresAt: null } })),
    ).toBe(true);
    expect(
      isStaffSetPlan(
        billingStatusFixture({ staffPlan: { expiresAt: END_OF_2026 } }),
      ),
    ).toBe(true);
    expect(isStaffSetPlan(billingStatusFixture({ staffPlan: null }))).toBe(
      false,
    );
  });

  it("yields to a staff simulation, as the panel and the grid both must", () => {
    expect(
      isStaffSetPlan(
        billingStatusFixture({
          staffPlan: { expiresAt: null },
          source: "simulation",
          effectivePlan: "pro",
        }),
      ),
    ).toBe(false);
    expect(
      getDisplayedCurrentPlan(
        billingStatusFixture({
          staffPlan: { expiresAt: null },
          source: "simulation",
          effectivePlan: "pro",
        }),
      ),
    ).toBe("free");
  });

  it("reads an older backend that omits the field as no staff plan", () => {
    expect(isStaffSetPlan(billingStatusFixture())).toBe(false);
    expect(isStaffSetPlan(undefined)).toBe(false);
    expect(isStaffSetPlan(null)).toBe(false);
  });
});

describe("getDisplayedCurrentPlan", () => {
  it("names the staff tier, not the stored Free plan", () => {
    expect(
      getDisplayedCurrentPlan(
        billingStatusFixture({
          effectivePlan: "team",
          staffPlan: { expiresAt: null },
        }),
      ),
    ).toBe("team");
  });

  it("keeps the stored plan without a staff plan", () => {
    // Other sources of a higher effective plan (a trial, a simulation) keep
    // their own handling; only a staff plan changes what reads as current.
    for (const staffPlan of [null, undefined]) {
      expect(
        getDisplayedCurrentPlan(
          billingStatusFixture({ effectivePlan: "team", staffPlan }),
        ),
      ).toBe("free");
    }
    expect(
      getDisplayedCurrentPlan(
        billingStatusFixture({ plan: "pro", effectivePlan: "pro" }),
      ),
    ).toBe("pro");
  });

  it("falls back to Free while billing status is loading", () => {
    expect(getDisplayedCurrentPlan(undefined)).toBe("free");
  });
});

describe("formatStaffPlanEndLine", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names the last day the plan covers", () => {
    expect(formatStaffPlanEndLine(END_OF_2026)).toBe("Through Dec 31, 2026");
  });

  it("has no line for a plan with no end date", () => {
    expect(formatStaffPlanEndLine(null)).toBeNull();
  });

  it.each([
    ["UTC+8", "Asia/Singapore", 1],
    ["UTC-8", "America/Los_Angeles", 31],
  ])("names the same day at %s", (_offset, timeZone, localDayOfLastMs) => {
    vi.stubEnv("TZ", timeZone);
    // The zone took effect: read locally, the last millisecond falls on a
    // different day in each zone.
    expect(new Date(END_OF_2026 - 1).getDate()).toBe(localDayOfLastMs);
    expect(formatStaffPlanEndLine(END_OF_2026)).toBe("Through Dec 31, 2026");
  });
});
