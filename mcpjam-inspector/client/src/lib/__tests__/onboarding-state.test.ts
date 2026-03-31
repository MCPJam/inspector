import { describe, it, expect, beforeEach } from "vitest";
import {
  readOnboardingState,
  writeOnboardingState,
  clearOnboardingState,
  isFirstRunEligible,
} from "../onboarding-state";

describe("onboarding-state", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("readOnboardingState / writeOnboardingState", () => {
    it("returns null when nothing stored", () => {
      expect(readOnboardingState()).toBeNull();
    });

    it("round-trips a seen state", () => {
      writeOnboardingState({ status: "seen" });
      expect(readOnboardingState()).toEqual({ status: "seen" });
    });

    it("round-trips a completed state with timestamp", () => {
      const state = { status: "completed" as const, completedAt: 1234567890 };
      writeOnboardingState(state);
      expect(readOnboardingState()).toEqual(state);
    });

    it("returns null for invalid JSON", () => {
      localStorage.setItem("mcp-onboarding-state", "not json");
      expect(readOnboardingState()).toBeNull();
    });

    it("returns null for invalid status", () => {
      localStorage.setItem(
        "mcp-onboarding-state",
        JSON.stringify({ status: "invalid" }),
      );
      expect(readOnboardingState()).toBeNull();
    });
  });

  describe("clearOnboardingState", () => {
    it("removes the stored state", () => {
      writeOnboardingState({ status: "seen" });
      clearOnboardingState();
      expect(readOnboardingState()).toBeNull();
    });
  });

  describe("isFirstRunEligible", () => {
    it("returns true when hash is empty, no servers, no stored state", () => {
      expect(isFirstRunEligible(false, "")).toBe(true);
    });

    it("returns true when hash is # only", () => {
      expect(isFirstRunEligible(false, "#")).toBe(true);
    });

    it("returns true when hash is #/", () => {
      expect(isFirstRunEligible(false, "#/")).toBe(true);
    });

    it("returns true when hash is #servers (the default)", () => {
      expect(isFirstRunEligible(false, "#servers")).toBe(true);
    });

    it("returns false when hash points to a specific tab", () => {
      expect(isFirstRunEligible(false, "#tools")).toBe(false);
    });

    it("returns false when hash is #learning", () => {
      expect(isFirstRunEligible(false, "#learning")).toBe(false);
    });

    it("returns false when there are any saved servers", () => {
      expect(isFirstRunEligible(true, "")).toBe(false);
    });

    it("returns false when the user is already authenticated", () => {
      expect(isFirstRunEligible(false, "", true)).toBe(false);
    });

    it("returns false when onboarding was completed", () => {
      writeOnboardingState({ status: "completed", completedAt: Date.now() });
      expect(isFirstRunEligible(false, "")).toBe(false);
    });

    it("returns false when onboarding was dismissed", () => {
      writeOnboardingState({ status: "dismissed" });
      expect(isFirstRunEligible(false, "")).toBe(false);
    });

    it("returns false when onboarding was seen", () => {
      writeOnboardingState({ status: "seen" });
      expect(isFirstRunEligible(false, "")).toBe(false);
    });
  });
});
