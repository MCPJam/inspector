/**
 * Which authored inputs describe the trial on screen.
 *
 * THE MISTAKE THIS PREVENTS. The left pane always shows the DRAFT — what the
 * case says right now. The right pane shows a TRIAL — what some past run
 * actually graded. Feeding the draft to both is right only while they agree;
 * the moment an author edits a check, the scorecard would start attributing
 * today's scorers to yesterday's run, and rows would join nothing while
 * claiming to describe it.
 *
 * So: when the selected trial still matches the draft, both panes read the
 * same inputs and are identical by construction. When it does not — an edit
 * since the run, or an explicit History pick — the rows come from the
 * iteration's own frozen snapshot instead.
 *
 * WHAT THE SNAPSHOT CANNOT SAY. `testCaseSnapshot.predicates` is the RESOLVED
 * list: suite defaults and case overrides already merged, with no marker for
 * which was which, and `run.configSnapshot` carries no `defaultPredicates` to
 * reconstruct it from. Matching them against the live suite would be a guess
 * that goes wrong exactly when the suite has changed — which is the case a
 * reader opened History to investigate. Those rows are therefore labelled
 * "Run snapshot" and claim no provenance at all.
 */

import {
  resolveCasePredicates,
  type CasePredicates,
  type Predicate,
} from "@/shared/eval-matching";
import type {
  EvalJudgeConfig,
  EvalSuiteRun,
  EvalIteration,
} from "@/components/evals/types";
import type { SelectedTrial } from "../case-workspace/selected-trial";
import { trialMatchesDraft } from "../case-workspace/selected-trial";
import type { TestStep } from "@/shared/steps";
import { isToolCalledWithAssert } from "../simple-case/simple-case-model";
import type { CaseScorecardInput } from "./case-scorecard-model";

export type AuthoredForTrial = {
  authored: CaseScorecardInput;
  basis: "draft" | "snapshot";
};

/** Resolved list off a frozen iteration, or nothing to freeze. */
function snapshotPredicates(
  iteration: EvalIteration | undefined,
): Predicate[] | undefined {
  const frozen = iteration?.testCaseSnapshot?.predicates;
  return Array.isArray(frozen) ? frozen : undefined;
}

function asCasePredicates(
  value: CasePredicates | Predicate[] | undefined,
): CasePredicates | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? { mode: "replace", list: value } : value;
}

/**
 * Did the frozen steps pin any route tool?
 *
 * Reads the snapshot's own steps rather than the live case: the question is
 * what THAT trial was graded against.
 */
function snapshotHasRouteTools(steps: TestStep[] | undefined): boolean {
  return (steps ?? []).some((step) => isToolCalledWithAssert(step));
}

export function authoredForTrial(input: {
  trial: SelectedTrial | null;
  /** What the left pane is showing: `editForm` plus the live suite. */
  draft: CaseScorecardInput;
  run: Pick<EvalSuiteRun, "configSnapshot"> | null;
  /** Forced by Inspect mode, where the reader asked for the frozen view. */
  forceSnapshot?: boolean;
}): AuthoredForTrial {
  const trial = input.trial;
  if (!trial) return { authored: input.draft, basis: "draft" };

  if (trial.kind === "live") {
    // An attempt in flight was launched from a snapshot taken at launch, which
    // is what it will be graded against even if the author keeps typing.
    const launch = trial.record.launchSnapshot;
    if (!launch?.steps) return { authored: input.draft, basis: "draft" };
    return {
      authored: {
        ...input.draft,
        steps: launch.steps,
        predicates: asCasePredicates(launch.predicates),
        matchOptions: launch.matchOptions,
        expectedOutput: launch.expectedOutput,
      },
      basis: "draft",
    };
  }

  // Compare like with like. `testCaseSnapshot.predicates` is the RESOLVED
  // list — suite defaults already merged — while the draft holds the case's
  // own envelope, and `caseSnapshotSignature` resolves an envelope against no
  // suite defaults at all. Handing it the raw envelope would report every case
  // in a suite that HAS defaults as edited, on every trial.
  const matches =
    !input.forceSnapshot &&
    trialMatchesDraft(trial, {
      steps: input.draft.steps,
      predicates: resolveCasePredicates(
        input.draft.suiteDefaultPredicates,
        input.draft.predicates,
      ),
      matchOptions: input.draft.matchOptions,
      expectedOutput: input.draft.expectedOutput,
    });
  if (matches) return { authored: input.draft, basis: "draft" };

  const iteration = trial.iteration;
  const snapshot = iteration.testCaseSnapshot;
  const frozenJudge: EvalJudgeConfig | undefined =
    input.run?.configSnapshot?.judgeConfig ?? input.draft.suiteJudgeConfig;

  return {
    authored: {
      ...input.draft,
      steps: snapshot?.steps ?? input.draft.steps,
      matchOptions: snapshot?.matchOptions ?? input.draft.matchOptions,
      /**
       * The tool question as the TRIAL froze it, not as the case reads today.
       *
       * `toolsChoice` decides whether the route row says "No tool should be
       * called" or "Any route", and it arrived here from the live draft. A
       * case that used to forbid tools and is now unrestricted therefore
       * showed an old no-tool trial as "Any route" — losing the matcher join
       * and describing a gate that trial actually graded as absent.
       */
      toolsChoice: snapshot
        ? snapshot.isNegativeTest
          ? "noTool"
          : snapshotHasRouteTools(snapshot.steps)
            ? "tools"
            : "unset"
        : input.draft.toolsChoice,
      expectedOutput: snapshot?.expectedOutput ?? undefined,
      // Both are superseded by the resolved list; passing it as
      // `snapshotPredicates` is what makes the rows say "Run snapshot".
      predicates: undefined,
      suiteDefaultPredicates: undefined,
      snapshotPredicates: snapshotPredicates(iteration),
      suiteJudgeConfig: frozenJudge,
    },
    basis: "snapshot",
  };
}
