/**
 * The next question, and what answers it.
 *
 * Every capability named here already existed. What did not exist was a path
 * to it from the moment the question arises — a newcomer who just watched
 * their first case pass has no reason to know that "does it pass
 * consistently?" is a Trials chip. One line, one action: a list of five next
 * steps is a menu, and a menu is what the observe-first flow avoids.
 */

import { describe, expect, it } from "vitest";
import {
  nextQuestionFor,
  type NextQuestionState,
} from "../case-scorecard/next-question";

const state = (over: Partial<NextQuestionState> = {}): NextQuestionState => ({
  hasTrial: true,
  judgedPass: true,
  hasFailure: false,
  trials: 1,
  hasChecks: false,
  hasSuggestions: false,
  suiteHasGate: false,
  ...over,
});

describe("nextQuestionFor", () => {
  it("says nothing before the first run — the Run button is the answer", () => {
    expect(nextQuestionFor(state({ hasTrial: false }))).toBeNull();
  });

  it("asks for repetition after one passing trial", () => {
    expect(nextQuestionFor(state())).toMatchObject({
      action: "trials",
      copy: "It worked once. Run 3 iterations to see if it is consistent.",
    });
  });

  it("puts a failure ahead of everything else", () => {
    // Hardening a case whose run did not work is the wrong next step, and so
    // is comparing models.
    expect(
      nextQuestionFor(
        state({ hasFailure: true, trials: 3, hasSuggestions: true }),
      ),
    ).toMatchObject({ action: "failure" });
  });

  it("offers hardening once the run is repeatable and something is suggested", () => {
    expect(
      nextQuestionFor(state({ trials: 3, hasSuggestions: true })),
    ).toMatchObject({ action: "harden" });
  });

  it("moves on to gating once the case has checks", () => {
    expect(
      nextQuestionFor(state({ trials: 3, hasChecks: true })),
    ).toMatchObject({ action: "gate" });
  });

  it("suggests another model once the suite already gates", () => {
    expect(
      nextQuestionFor(
        state({ trials: 3, hasChecks: true, suiteHasGate: true }),
      ),
    ).toMatchObject({ action: "models" });
  });

  it("says nothing when a run has neither checks nor suggestions to offer", () => {
    expect(nextQuestionFor(state({ trials: 3, judgedPass: false }))).toBeNull();
  });

  it("never returns more than one thing to do", () => {
    const next = nextQuestionFor(state({ trials: 3, hasSuggestions: true }));
    expect(next?.copy.split(".").filter(Boolean)).toHaveLength(1);
  });
});
