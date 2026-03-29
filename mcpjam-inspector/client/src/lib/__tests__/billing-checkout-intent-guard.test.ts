import { describe, expect, it } from "vitest";
import { guardCheckoutIntentAgainstEffectivePlan } from "../billing-checkout-intent-guard";

describe("guardCheckoutIntentAgainstEffectivePlan", () => {
  it("allows upgrade from free to starter", () => {
    expect(
      guardCheckoutIntentAgainstEffectivePlan("free", "starter"),
    ).toEqual({ proceed: true });
  });

  it("allows upgrade from free to team", () => {
    expect(guardCheckoutIntentAgainstEffectivePlan("free", "team")).toEqual({
      proceed: true,
    });
  });

  it("allows upgrade from starter to team", () => {
    expect(guardCheckoutIntentAgainstEffectivePlan("starter", "team")).toEqual(
      { proceed: true },
    );
  });

  it("blocks when already on requested starter", () => {
    expect(guardCheckoutIntentAgainstEffectivePlan("starter", "starter")).toEqual(
      {
        proceed: false,
        reason: "already_on",
        currentPlan: "starter",
      },
    );
  });

  it("blocks when already on requested team", () => {
    expect(guardCheckoutIntentAgainstEffectivePlan("team", "team")).toEqual({
      proceed: false,
      reason: "already_on",
      currentPlan: "team",
    });
  });

  it("blocks starter link when on team", () => {
    expect(guardCheckoutIntentAgainstEffectivePlan("team", "starter")).toEqual({
      proceed: false,
      reason: "already_higher",
      currentPlan: "team",
    });
  });

  it("blocks starter link when on enterprise", () => {
    expect(
      guardCheckoutIntentAgainstEffectivePlan("enterprise", "starter"),
    ).toEqual({
      proceed: false,
      reason: "already_higher",
      currentPlan: "enterprise",
    });
  });

  it("blocks team link when on enterprise", () => {
    expect(guardCheckoutIntentAgainstEffectivePlan("enterprise", "team")).toEqual(
      {
        proceed: false,
        reason: "already_higher",
        currentPlan: "enterprise",
      },
    );
  });
});
