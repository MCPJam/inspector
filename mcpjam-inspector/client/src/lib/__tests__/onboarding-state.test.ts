import { describe, it, expect, beforeEach } from "vitest";
import {
  readOnboardingState,
  writeOnboardingState,
  clearOnboardingState,
  isFirstRunEligible,
  markOnboardingDismissed,
  markOnboardingStarted,
  markOnboardingShown,
  isFirstRunServerChoiceEligible,
  markFirstRunPlaygroundPromptConsumed,
  markFirstRunPlaygroundPromptPending,
  markFirstRunServerChoiceDismissed,
  markFirstRunServerChoiceStarted,
  markFirstRunServerChoiceWelcomeShown,
  markFirstRunServerChoiceCompleted,
  readFirstRunServerChoiceState,
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
        expect.objectContaining({
          status: "seen",
          shownAt: expect.any(Number),
        }),
      );
    });

    it("round-trips a completed state with timestamp", () => {
      const state = { status: "completed" as const, completedAt: 1234567890 };
      writeOnboardingState(state);
      expect(readOnboardingState()).toEqual(state);
    });

    it("records an explicit dismissal", () => {
      markOnboardingDismissed();
      expect(readOnboardingState()).toEqual({ status: "dismissed" });
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

    it("returns true when hash is #connect (hosts hub slug)", () => {
      expect(isFirstRunEligible(false, "#connect")).toBe(true);
    });

    it("returns true when hash is legacy #hosts", () => {
      expect(isFirstRunEligible(false, "#hosts")).toBe(true);
    });

    it("returns true when hash is #home (the default landing route)", () => {
      expect(isFirstRunEligible(false, "#home")).toBe(true);
    });

    it("returns true from the Playground entry route", () => {
      expect(isFirstRunEligible(false, "playground")).toBe(true);
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

    it("returns true for a brand-new signed-in account (not yet onboarded)", () => {
      // isSignedInWithWorkOs=true but isNewSignedInAccount=true and the remote
      // onboarding flag is false → genuinely-new signups get the first-run NUX.
      expect(isFirstRunEligible(false, "", true, false, true)).toBe(true);
    });

    it("returns false for a new signed-in account that already saw onboarding", () => {
      expect(isFirstRunEligible(false, "", true, true, true)).toBe(false);
    });

    it("returns false for a signed-in account that is not flagged new", () => {
      // Older/returning accounts (isNewSignedInAccount=false) stay on Home even
      // when their remote onboarding flag was never set.
      expect(isFirstRunEligible(false, "", true, false, false)).toBe(false);
    });

    it("does not treat guest Convex auth as signed-in WorkOS state", () => {
      expect(isFirstRunEligible(false, "", false)).toBe(true);
    });

    it("uses the remote user row as source of truth when available", () => {
      writeOnboardingState({ status: "seen", shownAt: Date.now() });
      expect(isFirstRunEligible(false, "", false, false)).toBe(true);
      expect(isFirstRunEligible(false, "", false, true)).toBe(false);
    });

    it("local completed state beats a remote false (fresh guest session)", () => {
      // Guest Convex sessions start with hasSeenOnboarding: false on a new
      // user row. That must not override a locally-completed state from a
      // previous session or NUX completion.
      writeOnboardingState({ status: "completed", completedAt: Date.now() });
      expect(isFirstRunEligible(false, "", false, false)).toBe(false);
    });

    it("local dismissed state beats a remote false (fresh guest session)", () => {
      writeOnboardingState({ status: "dismissed" });
      expect(isFirstRunEligible(false, "", false, false)).toBe(false);
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

  describe("isFirstRunServerChoiceEligible", () => {
    it("records the welcome as shown before the user interacts", () => {
      markFirstRunServerChoiceWelcomeShown();

      expect(readFirstRunServerChoiceState()).toEqual(
        expect.objectContaining({
          status: "started",
          shownAt: expect.any(Number),
        }),
      );
    });

    it("keeps a visibly started flow eligible when a server row hydrates", () => {
      markFirstRunServerChoiceWelcomeShown();

      expect(
        isFirstRunServerChoiceEligible(
          true,
          "playground",
          readFirstRunServerChoiceState(),
        ),
      ).toBe(true);
    });

    it("records the server associated with a connection attempt", () => {
      markFirstRunServerChoiceWelcomeShown();
      markFirstRunServerChoiceStarted("Personal server");

      expect(readFirstRunServerChoiceState()).toEqual(
        expect.objectContaining({
          status: "started",
          attemptedServerName: "Personal server",
        }),
      );
    });

    it("keeps the attempted server and starter prompt across completion", () => {
      markFirstRunServerChoiceWelcomeShown();
      markFirstRunServerChoiceStarted("Excalidraw (App)");
      markFirstRunServerChoiceCompleted();
      markFirstRunPlaygroundPromptPending();

      expect(readFirstRunServerChoiceState()).toEqual(
        expect.objectContaining({
          status: "completed",
          attemptedServerName: "Excalidraw (App)",
          playgroundPromptPending: true,
        }),
      );

      markFirstRunPlaygroundPromptConsumed();
      expect(readFirstRunServerChoiceState()).toEqual(
        expect.objectContaining({
          status: "completed",
          attemptedServerName: "Excalidraw (App)",
          playgroundPromptPending: false,
        }),
      );
    });

    it("does not inherit completion from the legacy automatic flow", () => {
      writeOnboardingState({ status: "seen", shownAt: Date.now() });

      expect(
        isFirstRunServerChoiceEligible(
          false,
          "home",
          readFirstRunServerChoiceState(),
        ),
      ).toBe(true);
    });

    it("stays hidden after the user explicitly chooses setup later", () => {
      markFirstRunServerChoiceDismissed();

      expect(
        isFirstRunServerChoiceEligible(
          false,
          "home",
          readFirstRunServerChoiceState(),
        ),
      ).toBe(false);
    });

    it("does not hide the welcome after an automatic legacy completion", () => {
      localStorage.setItem(
        "mcp-first-run-server-choice-state",
        JSON.stringify({ status: "completed", completedAt: Date.now() }),
      );

      expect(
        isFirstRunServerChoiceEligible(
          false,
          "home",
          readFirstRunServerChoiceState(),
        ),
      ).toBe(true);
    });

    it("lets a legacy completion without shownAt enter and exit the explicit flow", () => {
      localStorage.setItem(
        "mcp-first-run-server-choice-state",
        JSON.stringify({ status: "completed", completedAt: Date.now() }),
      );

      markFirstRunServerChoiceWelcomeShown();
      expect(readFirstRunServerChoiceState()).toEqual(
        expect.objectContaining({
          status: "started",
          shownAt: expect.any(Number),
        }),
      );

      markFirstRunServerChoiceDismissed();
      expect(readFirstRunServerChoiceState()).toEqual({ status: "dismissed" });
    });

    it("stays hidden after an explicit welcome and successful connection", () => {
      markFirstRunServerChoiceWelcomeShown();
      markFirstRunServerChoiceStarted();
      markFirstRunServerChoiceCompleted();

      expect(
        isFirstRunServerChoiceEligible(
          false,
          "home",
          readFirstRunServerChoiceState(),
        ),
      ).toBe(false);
    });
  });
});
