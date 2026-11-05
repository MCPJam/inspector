/**
 * Pure projections behind the steps editor and the execution preview.
 *
 * A case is stored as one flat, ordered `steps` list, and an `assert` grades
 * whatever precedes it. Nothing here changes that list: both views are read
 * off it. `actionRows` already decides which action owns an assertion, so
 * this module numbers and labels its blocks rather than grouping a second way.
 *
 * The editor shows numbered steps (each action with its assertions nested
 * under it), then Expected outcome, then After-run assertions. The execution
 * preview walks the same list top to bottom, then the outcome, then one
 * end-of-run item for everything graded over the finished transcript.
 */

import { checkRole } from "@mcpjam/sdk/predicates";
import {
  actionRows,
  isWidgetAssertion,
  type AssertStep,
  type TestStep,
} from "@/shared/steps";
import type {
  CaseScorecard,
  JudgeFacts,
  ScorecardProvenance,
  ScorecardRow,
} from "../case-scorecard/case-scorecard-model";

/** The step kinds the editor numbers. Assertions nest under one of these. */
export type EditorActionKind = Exclude<TestStep["kind"], "assert">;

/** One heading per editor step. "Assertions", not "checks", per the evals vocabulary. */
export const EDITOR_STEP_TITLES = {
  prompt: "User prompt",
  toolCall: "Call tool",
  interact: "Interact",
  outcome: "Expected outcome",
  afterRun: "After-run assertions",
} as const satisfies Record<EditorActionKind | "outcome" | "afterRun", string>;

/**
 * The editor anchor for one place in the case.
 *
 * The preview and the editor share it, so a preview item opens the editor at
 * the step it names.
 */
export type EditorAnchor =
  `step:${string}` | `assertion:${string}` | "outcome" | "after-run";

export function stepAnchor(step: TestStep): EditorAnchor {
  return step.kind === "assert" ? `assertion:${step.id}` : `step:${step.id}`;
}

export type EditorActionStep = {
  kind: EditorActionKind;
  anchor: EditorAnchor;
  /** 1-based, the number the editor prints beside the step. */
  number: number;
  title: string;
  step: Exclude<TestStep, AssertStep>;
  /** Assertions that grade this step, in stored order. */
  assertions: AssertStep[];
};

export type EditorStep =
  | EditorActionStep
  | {
      kind: "outcome";
      anchor: "outcome";
      number: number;
      title: string;
    }
  | {
      kind: "afterRun";
      anchor: "after-run";
      number: number;
      title: string;
    };

export type EditorSteps = {
  /**
   * Assertions stored before any action (CLI-authored). They grade the run
   * before any prompt, so they belong to no numbered step.
   */
  leading: AssertStep[];
  steps: EditorStep[];
};

/**
 * Group a case's flat steps into numbered editor steps.
 *
 * Actions are numbered 1..N in stored order, Expected outcome is N+1 and
 * After-run assertions N+2. Both trailing steps are always present: the
 * outcome is the judge's goal and the after-run block holds the suite's
 * defaults, so neither depends on what the steps list contains.
 */
export function groupEditorSteps(steps: TestStep[]): EditorSteps {
  const { leading, actions } = actionRows(steps);
  const numbered: EditorStep[] = [];
  for (const action of actions) {
    const step = action.step;
    if (step.kind === "assert") continue;
    numbered.push({
      kind: step.kind,
      anchor: stepAnchor(step),
      number: action.ordinal,
      title: EDITOR_STEP_TITLES[step.kind],
      step,
      assertions: action.checks.map((child) => child.step),
    });
  }
  const outcome = numbered.length + 1;
  return {
    leading: leading.map((child) => child.step),
    steps: [
      ...numbered,
      {
        kind: "outcome",
        anchor: "outcome",
        number: outcome,
        title: EDITOR_STEP_TITLES.outcome,
      },
      {
        kind: "afterRun",
        anchor: "after-run",
        number: outcome + 1,
        title: EDITOR_STEP_TITLES.afterRun,
      },
    ],
  };
}

/**
 * The flat list back from the editor's grouping: leading assertions, then
 * each action followed by its assertions. Equal to the input of
 * `groupEditorSteps`, which the tests pin, so editing a group and flattening
 * it never moves an assertion to another step.
 */
export function flattenEditorSteps(grouped: EditorSteps): TestStep[] {
  return [
    ...grouped.leading,
    ...grouped.steps.flatMap((item) =>
      "step" in item ? [item.step, ...item.assertions] : [],
    ),
  ];
}

// ── execution preview ────────────────────────────────────────────────────────

/** Who performs an action: the model, or MCPJam's runner with no model. */
export type PreviewPerformer = "agent" | "runner";

export type PreviewAssertion = {
  kind: "assertion";
  anchor: EditorAnchor;
  number: number;
  step: AssertStep;
  /** The editor step it grades, or `null` for a leading assertion. */
  gradesStep: number | null;
  /** `widget` is checked in the live view; `transcript` against the run so far. */
  evaluatedIn: "widget" | "transcript";
  /** A blocking miss fails the run and skips later steps. */
  blocking: boolean;
};

export type PreviewAction = {
  kind: EditorActionKind;
  anchor: EditorAnchor;
  number: number;
  /** The editor step number, which the preview prints as "Step N". */
  stepNumber: number;
  title: string;
  step: Exclude<TestStep, AssertStep>;
  performer: PreviewPerformer;
};

export type PreviewOutcome = {
  kind: "outcome";
  anchor: "outcome";
  number: number;
  /** The judge's goal sentence, trimmed; empty when none is written. */
  expectedOutput: string;
};

export type EndOfRunJudge = {
  /** `skipped`: the suite runs a judge and this case opted out. */
  state: "runs" | "skipped" | "off";
  blocking: boolean;
  /** Absent only when the scorecard could not read the suite's judge. */
  facts?: JudgeFacts;
};

export type EndOfRunAssertion = {
  provenance: Extract<
    ScorecardProvenance,
    "route" | "suite" | "case" | "snapshot"
  >;
  blocking: boolean;
  row: ScorecardRow;
};

export type PreviewEndOfRun = {
  kind: "endOfRun";
  anchor: "after-run";
  number: number;
  judge: EndOfRunJudge;
  /** Whole-run assertions in the order the runner resolves them. */
  assertions: EndOfRunAssertion[];
  /** Suite defaults this case replaced, so they do not run. */
  replacedSuiteDefaults: number;
};

export type ExecutionPreviewItem =
  PreviewAssertion | PreviewAction | PreviewOutcome | PreviewEndOfRun;

function previewAssertion(
  number: number,
  step: AssertStep,
  gradesStep: number | null,
): PreviewAssertion {
  const base = {
    kind: "assertion" as const,
    number,
    anchor: stepAnchor(step),
    step,
    gradesStep,
  };
  // A DOM assertion has no role to author; the harness always stops on it.
  if (isWidgetAssertion(step.assertion)) {
    return { ...base, evaluatedIn: "widget", blocking: true };
  }
  return {
    ...base,
    evaluatedIn: "transcript",
    blocking: checkRole(step.assertion) !== "advisory",
  };
}

function endOfRunJudge(card: CaseScorecard): EndOfRunJudge {
  const facts = card.judge.judge;
  const suiteRunsJudge =
    facts !== undefined && !["off", "unknown"].includes(facts.suiteMode);
  const state = facts?.runsForCase
    ? "runs"
    : suiteRunsJudge && facts?.skippedForCase
      ? "skipped"
      : "off";
  return { state, blocking: card.judge.role === "required", facts };
}

/**
 * Whole-run assertions, in the runner's order.
 *
 * `resolveCasePredicates` evaluates suite defaults first and the case's own
 * list after them (extend), so the preview lists them that way. A frozen run
 * carries only the resolved list, shown as one snapshot block. The route
 * leads when it is a whole-run claim no step shows: "no tool called", or an
 * exact tool order. Tools merely reached are already step assertions.
 */
function endOfRunAssertions(card: CaseScorecard): EndOfRunAssertion[] {
  const rows = card.groups.flatMap((group) => group.rows);
  const take = (provenance: "suite" | "case" | "snapshot") =>
    rows
      .filter((row) => row.provenance === provenance)
      .sort((a, b) => (a.predicateIndex ?? 0) - (b.predicateIndex ?? 0))
      .map((row) => ({
        provenance,
        blocking: row.role === "required",
        row,
      }));
  const route = card.route.route;
  const routeIsWholeRun =
    route?.kind === "noTool" ||
    (route?.kind === "tools" &&
      route.tools.length > 0 &&
      route.matchMode === "regression");
  return [
    ...(routeIsWholeRun
      ? [{ provenance: "route" as const, blocking: true, row: card.route }]
      : []),
    ...take("suite"),
    ...take("case"),
    ...take("snapshot"),
  ];
}

/**
 * The case as it runs, top to bottom.
 *
 * Leading assertions, then each action followed by the assertions that grade
 * it, then the Expected outcome, then one end-of-run item holding the judge
 * and every whole-run assertion. Items are numbered 1..N in that order.
 *
 * `card` is the case's `buildCaseScorecard` result, built with
 * `numbering: "action"` so its step numbers match the editor's. It carries
 * the suite defaults, the case's own after-run assertions and the judge, all
 * already resolved against the case's envelope.
 */
export function buildExecutionPreview(
  steps: TestStep[],
  card: CaseScorecard,
): ExecutionPreviewItem[] {
  const { leading, actions } = actionRows(steps);
  const items: ExecutionPreviewItem[] = [];
  const next = () => items.length + 1;
  for (const child of leading) {
    items.push(previewAssertion(next(), child.step, null));
  }
  for (const action of actions) {
    const step = action.step;
    if (step.kind === "assert") continue;
    items.push({
      kind: step.kind,
      anchor: stepAnchor(step),
      number: next(),
      stepNumber: action.ordinal,
      title: EDITOR_STEP_TITLES[step.kind],
      step,
      performer: step.kind === "prompt" ? "agent" : "runner",
    });
    for (const child of action.checks) {
      items.push(previewAssertion(next(), child.step, action.ordinal));
    }
  }
  items.push({
    kind: "outcome",
    anchor: "outcome",
    number: next(),
    expectedOutput: (card.judge.judge?.goal ?? "").trim(),
  });
  items.push({
    kind: "endOfRun",
    anchor: "after-run",
    number: next(),
    judge: endOfRunJudge(card),
    assertions: endOfRunAssertions(card),
    replacedSuiteDefaults: card.hiddenSuiteCount,
  });
  return items;
}
