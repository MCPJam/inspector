/**
 * The steps editor and its execution preview, as pure data.
 *
 * Storage does not change: a case is still one flat `TestStep[]`. The editor
 * numbers the prompts, tool calls and interactions 1..N and nests each
 * assertion under the step it follows, because the stored order already says
 * which step an assertion grades. `actionRows` is that projection; this module
 * only names it for the editor and walks it for the preview.
 *
 * The preview lists the run top to bottom: leading assertions, each step with
 * its assertions, the expected outcome, then one end-of-run item. The route,
 * the judge and the suite and case predicates all come from
 * `buildCaseScorecard`, so the preview never resolves them a second way.
 */
import { checkRole } from "@mcpjam/sdk/predicates";
import { describeLocator } from "@/components/evals/assert-pick-chooser";
import {
  formatCriterion,
  INLINE_ASSERT_LABELS,
} from "@/shared/predicate-kinds";
import { isLocatorComplete } from "@/shared/scripted-steps";
import {
  actionRows,
  insertStepAfter,
  isAssertStep,
  isWidgetAssertion,
  WIDGET_ASSERTION_LABELS,
  type AssertStep,
  type InteractStep,
  type SpineAction,
  type SpineChild,
  type TestStep,
  type WidgetAssertion,
} from "@/shared/steps";
import {
  buildCaseScorecard,
  type CaseScorecard,
  type CaseScorecardInput,
  type ScorecardRow,
} from "../case-scorecard/case-scorecard-model";

/** Title and subtitle per step kind. The editor (2E) and the preview share them. */
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

// ── execution preview ────────────────────────────────────────────

export type PreviewMarker = "agent" | "runner" | "check" | "outcome";
export type PreviewLine = { suite: boolean; text: string };
export type PreviewItem = {
  /** "check:<step id>" | "action:<step id>" | "outcome" | "after-run" */
  key: string;
  marker: PreviewMarker;
  title: string;
  badge?: string;
  detail?: string;
  /** End-of-run item only. */
  lines?: PreviewLine[];
};

/** The case as the editor holds it, plus the suite it runs in. No run snapshot. */
export type ExecutionPreviewInput = Omit<
  CaseScorecardInput,
  "snapshotPredicates" | "numbering"
>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
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

function widgetValue(assertion: WidgetAssertion): string {
  switch (assertion.kind) {
    case "textVisible":
      return trimmed(assertion.text);
    case "inputValue": {
      const equals = trimmed(assertion.equals);
      if (!equals) return "";
      const at = where(assertion.target);
      return at ? `${at} = ${quoted(equals)}` : quoted(equals);
    }
    case "widgetToolCalled":
      return trimmed(assertion.calledToolName);
    case "elementVisible":
    case "elementHidden":
      return where(assertion.target);
  }
}

function assertionItem(step: AssertStep): PreviewItem {
  const key = `check:${step.id}`;
  const assertion = step.assertion;
  if (isWidgetAssertion(assertion)) {
    const label = WIDGET_ASSERTION_LABELS[assertion.kind];
    const value = widgetValue(assertion);
    return {
      key,
      marker: "check",
      title: value ? `${label} ${quoted(value)}` : label,
      detail: "Checked in the live view. Blocking.",
    };
  }
  return {
    key,
    marker: "check",
    title:
      INLINE_ASSERT_LABELS[assertion.type] ??
      formatCriterion({ predicate: assertion }),
    detail:
      checkRole(assertion) === "advisory"
        ? "Non-blocking: a miss only warns."
        : "Blocking: a miss fails the run and skips later steps.",
  };
}

function stepItem(action: SpineAction): PreviewItem {
  const step = action.step;
  const key = `action:${step.id}`;
  const tag = `Step ${action.ordinal}`;
  switch (step.kind) {
    case "prompt": {
      const prompt = trimmed(step.prompt);
      return {
        key,
        marker: "agent",
        title: `${tag} · ${STEP_COPY.prompt.title}`,
        badge: "agent runs",
        detail: prompt ? quoted(prompt) : "No prompt written yet.",
      };
    }
    case "interact": {
      const text = interactText(step.action);
      const view = trimmed(step.toolName);
      return {
        key,
        marker: "runner",
        title: `${tag} · ${STEP_COPY.interact.title}`,
        badge: "no model",
        detail:
          text && view
            ? `MCPJam's runner will ${text} in the ${view} view.`
            : "Pick a view and a target.",
      };
    }
    case "toolCall": {
      const tool = trimmed(step.toolName);
      return {
        key,
        marker: "runner",
        title: `${tag} · ${STEP_COPY.toolCall.title}`,
        badge: "no model",
        detail: tool
          ? `MCPJam calls ${tool} on ${trimmed(step.serverName)} directly.`
          : "Pick a tool.",
      };
    }
    case "assert":
      // `actionRows` never opens a step on an assert; kept total for the switch.
      return assertionItem(step);
  }
}

function judgeLine(card: CaseScorecard): PreviewLine {
  const facts = card.judge.judge;
  const mode = facts?.suiteMode ?? "unknown";
  if (mode === "off") return { suite: true, text: "Judge: off for this suite" };
  if (facts?.skippedForCase) {
    return { suite: false, text: "Judge: skipped for this case" };
  }
  if (mode === "unknown") {
    return { suite: true, text: "Judge: state unavailable" };
  }
  const role = card.judge.role === "advisory" ? "non-blocking" : "blocking";
  return { suite: true, text: `Judge grades the expected outcome (${role})` };
}

const ROUTE_WORD: Record<AfterRunRoute["kind"], string> = {
  noTools: "No tools called",
  exactOrder: "Tools in exact order",
};

function endOfRunLines(
  card: CaseScorecard,
  section: AfterRunSection,
): PreviewLine[] {
  const lines: PreviewLine[] = [judgeLine(card)];
  lines.push(
    card.envelopeMode === "replace"
      ? { suite: false, text: "Suite evaluators: replaced for this case" }
      : {
          suite: true,
          text: plural(section.suiteRows.length, "suite evaluator"),
        },
  );
  const parts = [
    section.route ? ROUTE_WORD[section.route.kind] : "",
    section.caseRows.length > 0
      ? plural(section.caseRows.length, "case assertion")
      : "",
  ].filter(Boolean);
  if (parts.length > 0) lines.push({ suite: false, text: parts.join(" · ") });
  return lines;
}

export function buildExecutionPreview(
  input: ExecutionPreviewInput,
): PreviewItem[] {
  const card = buildCaseScorecard({
    ...input,
    snapshotPredicates: undefined,
    numbering: "action",
  });
  const section = afterRunSection(card);
  const groups = groupCaseSteps(input.steps);
  const expected = trimmed(input.expectedOutput);
  return [
    ...groups.leading.map((child) => assertionItem(child.step)),
    ...groups.steps.flatMap((action) => [
      stepItem(action),
      ...action.checks.map((child) => assertionItem(child.step)),
    ]),
    {
      key: "outcome",
      marker: "outcome",
      title: "Expected outcome",
      detail: expected ? quoted(expected) : "No expected outcome written yet.",
    },
    {
      key: "after-run",
      marker: "agent",
      title: "End-of-run evaluation",
      lines: endOfRunLines(card, section),
    },
  ];
}
