/**
 * The steps editor, as pure data.
 *
 * Storage does not change: a case is still one flat `TestStep[]`. The editor
 * numbers the prompts, tool calls and interactions 1..N and nests each
 * assertion under the step it follows, because the stored order already says
 * which step an assertion grades. `actionRows` is that projection; this module
 * names it for the editor. The after-run section reads `buildCaseScorecard`'s
 * rows, so the editor never resolves the route or predicates a second way.
 */
import { describeLocator } from "@/components/evals/assert-pick-chooser";
import { isLocatorComplete } from "@/shared/scripted-steps";
import {
  actionRows,
  insertStepAfter,
  isAssertStep,
  type InteractStep,
  type SpineAction,
  type SpineChild,
  type TestStep,
} from "@/shared/steps";
import type {
  CaseScorecard,
  ScorecardRow,
} from "../case-scorecard/case-scorecard-model";

/** Title and subtitle per step kind, shared by the step cards and the editor. */
export const STEP_COPY: Record<
  "prompt" | "interact" | "toolCall",
  { title: string; subtitle: string }
> = {
  prompt: {
    title: "User prompt",
    subtitle: "The agent runs and chooses tools.",
  },
  interact: {
    title: "Interact",
    subtitle: "MCPJam acts in the rendered view. No model.",
  },
  toolCall: {
    title: "Call tool",
    subtitle: "MCPJam calls the tool directly. No model.",
  },
};

// ── editor grouping ──────────────────────────────────────────────

export type CaseStepGroups = {
  /** Assertions before the first step: "Before the first step", unnumbered. */
  leading: SpineChild[];
  /** Numbered steps 1..N, each with the assertions that follow it (`checks`). */
  steps: SpineAction[];
  /** steps.length + 1 */
  outcomeOrdinal: number;
  /** steps.length + 2 */
  afterRunOrdinal: number;
};

export function groupCaseSteps(steps: TestStep[]): CaseStepGroups {
  const { leading, actions } = actionRows(steps);
  return {
    leading,
    steps: actions,
    outcomeOrdinal: actions.length + 1,
    afterRunOrdinal: actions.length + 2,
  };
}

/** Inverse of groupCaseSteps: leading, then each step followed by its checks. */
export function flattenCaseSteps(
  groups: Pick<CaseStepGroups, "leading" | "steps">,
): TestStep[] {
  return [
    ...groups.leading.map((child) => child.step),
    ...groups.steps.flatMap((action) => [
      action.step,
      ...action.checks.map((child) => child.step),
    ]),
  ];
}

/** "Graded after" — move one assertion to the end of another step's block (null: before the first step). */
export function moveAssertionTo(
  steps: TestStep[],
  assertId: string,
  stepId: string | null,
): TestStep[] {
  const assertion = steps.find((step) => step.id === assertId);
  if (!assertion || !isAssertStep(assertion)) return steps;
  if (stepId !== null) {
    const target = steps.find((step) => step.id === stepId);
    if (!target || isAssertStep(target)) return steps;
  }
  const rest = steps.filter((step) => step.id !== assertId);
  return insertStepAfter(rest, stepId, assertion);
}

// ── After-run section (editor) ───────────────────────────────────

export type AfterRunRoute =
  | { kind: "noTools"; row: ScorecardRow }
  | { kind: "exactOrder"; row: ScorecardRow; toolNames: string[] };

export type AfterRunSection = {
  route: AfterRunRoute | null;
  /** Suite defaults, in suite order. Empty when the case replaces them. */
  suiteRows: ScorecardRow[];
  /** The case's own predicates, in case order. */
  caseRows: ScorecardRow[];
  /** Suite defaults the case replaced (card.hiddenSuiteCount). */
  replacedSuiteCount: number;
  isEmpty: boolean;
};

function afterRunRoute(row: ScorecardRow): AfterRunRoute | null {
  const route = row.route;
  if (route?.kind === "noTool") return { kind: "noTools", row };
  if (
    route?.kind === "tools" &&
    route.matchMode === "regression" &&
    route.tools.length > 0
  ) {
    return {
      kind: "exactOrder",
      row,
      toolNames: route.tools.map((tool) => tool.toolName.trim() || "?"),
    };
  }
  return null;
}

function rowsOf(
  card: CaseScorecard,
  provenance: "suite" | "case",
): ScorecardRow[] {
  return card.groups
    .flatMap((group) => group.rows)
    .filter((row) => row.provenance === provenance)
    .sort((a, b) => (a.predicateIndex ?? 0) - (b.predicateIndex ?? 0));
}

export function afterRunSection(card: CaseScorecard): AfterRunSection {
  const replaced = card.envelopeMode === "replace";
  const route = afterRunRoute(card.route);
  const suiteRows = replaced ? [] : rowsOf(card, "suite");
  const caseRows = rowsOf(card, "case");
  return {
    route,
    suiteRows,
    caseRows,
    replacedSuiteCount: replaced ? card.hiddenSuiteCount : 0,
    isEmpty: !route && suiteRows.length === 0 && caseRows.length === 0,
  };
}

// ── step text ────────────────────────────────────────────────────

const quoted = (text: string) => `“${text}”`;
const trimmed = (value: string | undefined) => (value ?? "").trim();

/** `describeLocator` for a usable locator, else nothing to print. */
function where(target: Parameters<typeof isLocatorComplete>[0]): string {
  return target && isLocatorComplete(target) ? describeLocator(target) : "";
}

/** The action as a phrase ("click …", "press Enter"); "" while incomplete. */
export function interactText(action: InteractStep["action"]): string {
  switch (action.kind) {
    case "click": {
      const at = where(action.target);
      return at ? `click ${at}` : "";
    }
    case "type": {
      const at = where(action.target);
      return at ? `type ${quoted(trimmed(action.text))} into ${at}` : "";
    }
    case "key": {
      const key = trimmed(action.key);
      return key ? `press ${key}` : "";
    }
    case "scroll":
      return `scroll ${action.direction}`;
    case "wait":
      return `wait ${action.ms.toLocaleString("en-US")} ms`;
  }
}
