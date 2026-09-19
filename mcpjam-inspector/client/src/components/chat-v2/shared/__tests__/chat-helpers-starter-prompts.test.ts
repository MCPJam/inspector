/**
 * Who gets the starter chips above the composer.
 *
 * The chips ("What can this server do?", "What tools can I use?", "Give me
 * example prompts to try") are a playground affordance. The rule that gates
 * them lives in a predicate rather than inline in `ChatTabV2`, because that
 * component cannot be mounted in a unit test — the first version of this
 * change was "covered" by a test in `ScenarioChatPage.test.tsx`, where
 * `ChatTabV2` is mocked away, so the chips were absent no matter what the rule
 * said and the test could not fail.
 */
import { describe, expect, it } from "vitest";

import { shouldShowStarterPrompts } from "../chat-helpers";

const READY = {
  hasMessages: false,
  isAuthLoading: false,
  showDisabledCallout: false,
  hostedScenarioId: undefined,
} as const;

describe("shouldShowStarterPrompts", () => {
  it("offers them on an empty playground chat", () => {
    expect(shouldShowStarterPrompts(READY)).toBe(true);
  });

  it("withholds them on the hosted study page", () => {
    // The tester is here to use the thing, and the study's own "What to try"
    // list is what tells them where to start. Asserted against an otherwise
    // fully-ready state, so the scenario id is provably the only reason.
    expect(
      shouldShowStarterPrompts({ ...READY, hostedScenarioId: "sbx_1" }),
    ).toBe(false);
  });

  it("withholds them on a study whose chat has already started", () => {
    // Both reasons at once must not cancel out.
    expect(
      shouldShowStarterPrompts({
        ...READY,
        hostedScenarioId: "sbx_1",
        hasMessages: true,
      }),
    ).toBe(false);
  });

  it("keeps every reason it withheld them for before", () => {
    // The hosted-study rule was ADDED to these, not swapped in for them.
    expect(shouldShowStarterPrompts({ ...READY, hasMessages: true })).toBe(
      false,
    );
    expect(shouldShowStarterPrompts({ ...READY, isAuthLoading: true })).toBe(
      false,
    );
    expect(
      shouldShowStarterPrompts({ ...READY, showDisabledCallout: true }),
    ).toBe(false);
  });
});
