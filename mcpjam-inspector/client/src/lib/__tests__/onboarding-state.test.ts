import { describe, it, expect, beforeEach } from "vitest";
import {
  readOnboardingState,
  writeOnboardingState,
  clearOnboardingState,
  isFirstRunEligible,
  markOnboardingStarted,
  markOnboardingShown,
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

    it("marks onboarding as started before the NUX is shown", () => {
      markOnboardingStarted();
      expect(readOnboardingState()).toEqual(
        expect.objectContaining({ status: "started" }),
      );
    });

    it("marks onboarding as shown only after the NUX renders", () => {
      markOnboardingStarted();
      markOnboardingShown();
      expect(readOnboardingState()).toEqual(
        expect.objectContaining({ status: "seen", shownAt: expect.any(Number) }),
      );
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

    it("returns false when the user is signed in with WorkOS", () => {
      expect(isFirstRunEligible(false, "", true)).toBe(false);
    });

    it("does not treat guest Convex auth as signed-in WorkOS state", () => {
      expect(isFirstRunEligible(false, "", false)).toBe(true);
    });

    it("uses the remote user row as source of truth when available", () => {
      writeOnboardingState({ status: "seen", shownAt: Date.now() });
      expect(isFirstRunEligible(false, "", false, false)).toBe(true);
      expect(isFirstRunEligible(false, "", false, true)).toBe(false);
    });

    it("returns false when onboarding was completed", () => {
      writeOnboardingState({ status: "completed", completedAt: Date.now() });
      expect(isFirstRunEligible(false, "")).toBe(false);
    });

    it("returns false when onboarding was dismissed", () => {
      writeOnboardingState({ status: "dismissed" });
      expect(isFirstRunEligible(false, "")).toBe(false);
    });

    it("returns true when auto-connect started but the NUX was not shown yet", () => {
      writeOnboardingState({ status: "started", startedAt: Date.now() });
      expect(isFirstRunEligible(false, "")).toBe(true);
    });

    it("returns true for legacy seen state without shownAt", () => {
      writeOnboardingState({ status: "seen" });
      expect(isFirstRunEligible(false, "")).toBe(true);
    });

    it("returns false when onboarding was visibly shown", () => {
      writeOnboardingState({ status: "seen", shownAt: Date.now() });
      expect(isFirstRunEligible(false, "")).toBe(false);
    });
  });
});
