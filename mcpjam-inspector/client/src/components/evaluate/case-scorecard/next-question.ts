/**
 * The one question a reader is most likely to ask next, and where it is
 * answered.
 *
 * Every capability named here already exists — repeated trials, the chain's
 * stage evidence, the model and host pickers, the suite's quality gate. What
 * did not exist was any path to them from the moment the question arises. A
 * newcomer who just watched their first case pass has no reason to know that
 * "does it pass consistently?" is a Trials chip, or that "will a release
 * break this?" is a suite setting.
 *
 * Deliberately ONE line and one action: a list of five next steps is a menu,
 * and a menu is the thing the observe-first flow exists to avoid.
 */

export type NextQuestionState = {
  /** A finished batch exists for this case. */
  hasTrial: boolean;
  /** Its judge answered, and said the goal was accomplished. */
  judgedPass: boolean;
  /** Any trial in the batch did not accomplish the goal. */
  hasFailure: boolean;
  /** How many trials the newest batch ran. */
  trials: number;
  /** The case authors at least one deterministic check. */
  hasChecks: boolean;
  /** Something is suggested that would harden it. */
  hasSuggestions: boolean;
  /** The suite already gates releases. */
  suiteHasGate: boolean;
};

export type NextQuestion = {
  copy: string;
  action: "trials" | "failure" | "harden" | "models" | "gate";
  actionLabel: string;
} | null;

export function nextQuestionFor(state: NextQuestionState): NextQuestion {
  // Before a run there is nothing to ask about; the Run button is the answer.
  if (!state.hasTrial) return null;

  // A failure outranks everything: hardening a case whose run did not work is
  // the wrong next step, and so is comparing models.
  if (state.hasFailure) {
    return {
      copy: "See where it failed.",
      action: "failure",
      actionLabel: "Open the failed step",
    };
  }

  if (state.judgedPass && state.trials <= 1) {
    return {
      copy: "It worked once. Run 3 iterations to see if it is consistent.",
      action: "trials",
      actionLabel: "Run 3 iterations",
    };
  }

  if (state.hasSuggestions && !state.hasChecks) {
    return {
      copy: "Harden it — the assertions below held in every iteration.",
      action: "harden",
      actionLabel: "Review the suggestions",
    };
  }

  if (state.hasChecks && !state.suiteHasGate) {
    return {
      copy: "Gate releases on this suite.",
      action: "gate",
      actionLabel: "Open the quality gate",
    };
  }

  if (state.hasChecks) {
    return {
      copy: "Try another model or client.",
      action: "models",
      actionLabel: "Change the model",
    };
  }

  return null;
}
