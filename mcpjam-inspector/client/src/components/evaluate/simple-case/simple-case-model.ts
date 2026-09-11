/**
 * Pure model for the Evaluate case form.
 *
 * The form authors one prompt, any sequence of interact steps and widget
 * asserts, non-widget `toolCalledWith` asserts (the tool question), and every
 * other non-widget assert (the step-authored rows under "More checks"). What
 * it cannot author — a second prompt, a pinned `toolCall` — is listed as
 * "Also in this case" and edited in the deep step list. Nothing is rewritten
 * on read: an assert step stays a step, a case predicate stays a predicate.
 *
 * `isSimpleCaseShape` is NOT a gate on the form any more; it survives only as
 * the precondition of the route rollup's adopt action, which rewrites steps
 * through this model and assumes one prompt plus tool asserts.
 */

import {
  insertStepAfter,
  isAssertStep,
  isInteractStep,
  isPromptStep,
  isToolCallStep,
  isWidgetAssertion,
  newStepId,
  stepTurnIndices,
  WIDGET_ASSERTION_LABELS,
  type InteractAction,
  type InteractStep,
  type TestStep,
  type WidgetAssertion,
} from "@/shared/steps";
import {
  MATCH_OPTIONS_DEFAULTS,
  checkRole,
  type CasePredicates,
  type EvalMatchOptions,
  type Predicate,
} from "@/shared/eval-matching";

export const UNSET_TOOLS_BLOCK_REASON =
  "Choose which tool should handle it, or that no tool should be called.";

/**
 * A negative case asserts the model called NO tool. Any check that requires a
 * tool call contradicts it — whether it was authored as a step, on the case,
 * or inherited from the suite. `toolCalledWith` is the only one the backend
 * hard-rejects (`NEGATIVE_TEST_HAS_TOOL_CALLS`); the other two are just as
 * unsatisfiable, so the form warns on all three.
 */
export const NEGATIVE_CONTRADICTING_KINDS: ReadonlySet<Predicate["type"]> =
  new Set<Predicate["type"]>([
    "toolCalledWith",
    "toolCalledAtLeastOnce",
    "firstToolWas",
  ]);

export type CaseKind = "capability" | "regression";

export type ToolsChoice = "unset" | "tools" | "noTool";

/**
 * What the tool question actually shows. `"checks"` is DERIVED, never stored:
 * a case whose checks carry its tool expectation (a `firstToolWas` step, a
 * rubric, a case predicate) is a positive case that names no route.
 *
 * Deriving it rather than storing a fourth `ToolsChoice` keeps one source of
 * truth: the value cannot go stale while the form is unmounted behind the deep
 * step list, and no effect has to sync it back when the last check is removed.
 * It also closes a hole in the stored tri-state — `"tools"` with zero rows and
 * no other assertion used to pass the unset block and save as a derived
 * negative; it now resolves back to `"unset"` and blocks.
 *
 * A named route outranks a stored `"noTool"`: choosing "no tool" removes the
 * `toolCalledWith` asserts, so the two can only coexist when one was added
 * afterwards in the step list. Reading that as positive is the safe answer —
 * the backend rejects a negative case that kept a tool assert
 * (`NEGATIVE_TEST_HAS_TOOL_CALLS`), and the form warns about the pair.
 */
export type ToolsQuestion = ToolsChoice | "checks";

export function resolveToolsQuestion(input: {
  choice: ToolsChoice;
  hasToolAsserts: boolean;
  hasOwnAssertion: boolean;
}): ToolsQuestion {
  if (input.hasToolAsserts) return "tools";
  if (input.choice === "noTool") return "noTool";
  if (input.hasOwnAssertion) return "checks";
  return "unset";
}

/**
 * The client mirror of the backend's `caseHasAssertion` (convex
 * `testSuites.ts`): a positive case must assert something or it passes
 * vacuously, and the backend answers `POSITIVE_TEST_NO_ASSERTION`.
 *
 * Suite defaults deliberately do not count — the backend inspects the per-case
 * override only. An `inherit`-mode list does not count either: the editor
 * blanks that list on save, so it is not an assertion the case carries.
 */
export function caseHasOwnAssertion(input: {
  steps: TestStep[];
  expectedOutput?: string;
  predicates?: CasePredicates;
}): boolean {
  if (input.steps.some(isAssertStep)) return true;
  if ((input.expectedOutput?.trim().length ?? 0) > 0) return true;
  const predicates = input.predicates;
  return Boolean(
    predicates && predicates.mode !== "inherit" && predicates.list.length > 0,
  );
}

export function initialToolsChoice(input: {
  tools: SimpleCaseTool[];
  isNegativeTest?: boolean;
}): ToolsChoice {
  if (input.tools.length > 0) return "tools";
  if (input.isNegativeTest) return "noTool";
  return "unset";
}

export type SimpleCaseTool = {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

export type WidgetAssertStep = Extract<TestStep, { kind: "assert" }> & {
  assertion: WidgetAssertion;
};

export type InAppStep = InteractStep | WidgetAssertStep;

export type SimpleCaseView = {
  prompt: string;
  inApp: InAppStep[];
  tools: SimpleCaseTool[];
  noTool: boolean;
};

export type WriteSimpleCaseView = {
  prompt: string;
  tools: Array<{
    id?: string;
    toolName: string;
    arguments?: Record<string, unknown>;
  }>;
  noTool: boolean;
};

/**
 * A `toolCalledWith` assert that actually routes the case.
 *
 * GATING ONLY, and that qualifier is load-bearing. `deriveExpectedToolCalls`
 * and `stepsToPromptTurns` both skip an advisory `toolCalledWith`, so an
 * advisory one never becomes a matcher expectation — the runner grades it as
 * an ordinary predicate instead. Treating it as the route here would show a
 * Gate route on a case the backend does not route, which is the one thing the
 * tool question exists to answer. It files as a step scorer instead
 * (`isStepCheckAssert`), wearing its own Warn or Report role.
 */
export function isToolCalledWithAssert(step: TestStep): boolean {
  return (
    isAssertStep(step) &&
    !isWidgetAssertion(step.assertion) &&
    step.assertion.type === "toolCalledWith" &&
    checkRole(step.assertion) !== "advisory"
  );
}

export function isWidgetAssertStep(step: TestStep): step is WidgetAssertStep {
  return isAssertStep(step) && isWidgetAssertion(step.assertion);
}

export function isInAppStep(step: TestStep): step is InAppStep {
  return isInteractStep(step) || isWidgetAssertStep(step);
}

/**
 * An assert step the "More checks" section owns: a transcript predicate that
 * is not the tool route. `toolCalledWith` belongs to the tool question above
 * the disclosure, widget asserts to "In the app".
 */
export function isStepCheckAssert(step: TestStep): boolean {
  return (
    isAssertStep(step) &&
    !isWidgetAssertion(step.assertion) &&
    !isToolCalledWithAssert(step)
  );
}

/** A check the author wrote as a step, rendered as a first-class check row. */
export type StepCheck = { stepId: string; predicate: Predicate };

/**
 * Step-authored checks in execution order.
 *
 * These stay steps. The executor runs the flat list fail-fast and evaluates
 * each assert against the transcript AT THAT POINT; case predicates are
 * evaluated once over the finished transcript. Rewriting one into the other
 * would change when a case fails and which later checks run at all.
 */
export function readStepChecks(steps: TestStep[]): StepCheck[] {
  const checks: StepCheck[] = [];
  for (const step of steps) {
    if (!isStepCheckAssert(step) || !isAssertStep(step)) continue;
    const assertion = step.assertion;
    if (isWidgetAssertion(assertion)) continue;
    checks.push({ stepId: step.id, predicate: assertion });
  }
  return checks;
}

/** Rewrite one step-authored check in place — same id, same list index. */
export function updateStepCheck(
  steps: TestStep[],
  stepId: string,
  predicate: Predicate,
): TestStep[] {
  return steps.map((step) =>
    step.id === stepId && isAssertStep(step)
      ? { ...step, assertion: predicate }
      : step,
  );
}

/**
 * Steps the form has no section for, as the COMPLEMENT of what it renders —
 * so a step kind added later surfaces here instead of disappearing from the
 * only editor on the surface.
 *
 * In practice: a prompt after the first, a pinned `toolCall`, and a leading
 * non-prompt step.
 */
export function leftoverSteps(steps: TestStep[]): TestStep[] {
  return steps.filter((step, index) => {
    if (index === 0 && isPromptStep(step)) return false;
    return (
      !isInAppStep(step) &&
      !isToolCalledWithAssert(step) &&
      !isStepCheckAssert(step)
    );
  });
}

export function hasLeftoverSteps(steps: TestStep[]): boolean {
  return leftoverSteps(steps).length > 0;
}

/**
 * True when the form's prompt box owns `steps[0]`. An empty case counts: a
 * fresh draft is where the author types the first prompt.
 *
 * When false the case opens on something the form cannot author (a pinned
 * `toolCall`), so the prompt box and the tool question go read-only rather
 * than rewriting the head of the list.
 */
export function isPromptFirst(steps: TestStep[]): boolean {
  return steps.length === 0 || isPromptStep(steps[0]!);
}

/** Turn ordinal (1-based) per step id, for labelling leftover rows. */
export function turnOrdinalByStepId(steps: TestStep[]): Map<string, number> {
  const turns = stepTurnIndices(steps);
  const map = new Map<string, number>();
  steps.forEach((step, index) => {
    map.set(step.id, (turns[index] ?? 0) + 1);
  });
  return map;
}

export function leftoverStepLabel(step: TestStep): string {
  if (isPromptStep(step)) {
    const prompt = step.prompt.trim();
    const clipped = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
    return clipped ? `Prompt: "${clipped}"` : "Prompt (empty)";
  }
  if (isToolCallStep(step)) {
    const server = step.serverName?.trim();
    const tool = step.toolName?.trim() || "tool";
    return server ? `Tool call: ${server}/${tool}` : `Tool call: ${tool}`;
  }
  return step.kind;
}

/**
 * Regression is the strict-order + no-extras pair. `argumentMatching` is
 * deliberately not part of the discriminant — both kinds keep `partial`.
 */
/** Persisted kind wins; otherwise derive from resolved matchOptions. */
export function displayCaseKind(
  persisted: CaseKind | null | undefined,
  resolvedMatchOptions: Pick<
    EvalMatchOptions,
    "toolCallOrder" | "maxExtraToolCalls"
  >,
): CaseKind {
  if (persisted === "capability" || persisted === "regression") {
    return persisted;
  }
  return deriveCaseKind(resolvedMatchOptions);
}

export function deriveCaseKind(
  resolvedMatchOptions: Pick<
    EvalMatchOptions,
    "toolCallOrder" | "maxExtraToolCalls"
  >,
): CaseKind {
  return resolvedMatchOptions.toolCallOrder === "strict" &&
    resolvedMatchOptions.maxExtraToolCalls === 0
    ? "regression"
    : "capability";
}

/**
 * The matchOptions a kind writes. `argumentMatching` is carried over from
 * `current` (the RESOLVED options, suite defaults included) rather than
 * reset: the toggle decides order and extras, and an authored `exact` must
 * not silently become `partial` because the author flipped the kind.
 */
export function matchOptionsForKind(
  kind: CaseKind,
  current?: Pick<EvalMatchOptions, "argumentMatching">,
): Required<Omit<EvalMatchOptions, "allowExtraToolCalls">> {
  const argumentMatching =
    current?.argumentMatching ?? MATCH_OPTIONS_DEFAULTS.argumentMatching;
  if (kind === "regression") {
    return {
      toolCallOrder: "strict",
      maxExtraToolCalls: 0,
      argumentMatching,
    };
  }
  return { ...MATCH_OPTIONS_DEFAULTS, argumentMatching };
}

/**
 * `steps[0]` is a prompt and every later step is an interact, a widget
 * assert, or a non-widget `toolCalledWith` assert. Prompt-only is simple.
 * A second prompt, `toolCall`, or any other inline predicate is not.
 */
export function isSimpleCaseShape(steps: TestStep[]): boolean {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  if (!isPromptStep(steps[0])) return false;
  return steps
    .slice(1)
    .every((step) => isInAppStep(step) || isToolCalledWithAssert(step));
}

export function readSimpleCase(steps: TestStep[]): SimpleCaseView {
  // `steps[0]` is `undefined` on an empty draft, and the narrowing helpers
  // dereference `.kind`. The old form never saw that shape — the editor seeded
  // a prompt before mounting it — but the first-run form renders a case that
  // has nothing yet, which is exactly where a new case starts.
  const first = steps.length > 0 ? steps[0] : undefined;
  const prompt = first && isPromptStep(first) ? first.prompt : "";
  const inApp: InAppStep[] = [];
  const tools: SimpleCaseTool[] = [];
  for (const step of steps) {
    if (isInAppStep(step)) {
      inApp.push(step);
      continue;
    }
    if (!isToolCalledWithAssert(step) || !isAssertStep(step)) continue;
    const assertion = step.assertion;
    if (isWidgetAssertion(assertion) || assertion.type !== "toolCalledWith") {
      continue;
    }
    tools.push({
      id: step.id,
      toolName: assertion.toolName,
      arguments: assertion.args.args ?? {},
    });
  }
  return { prompt, inApp, tools, noTool: tools.length === 0 };
}

function toolAssertStep(
  id: string,
  tool: WriteSimpleCaseView["tools"][number],
): TestStep {
  return {
    id,
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: tool.toolName,
      args: { args: tool.arguments ?? {} },
    },
  };
}

/**
 * Rewrite the simple-case slice of `prevSteps` without reordering surviving
 * steps. The executor runs the flat list in order and fail-fast, so
 * bucket-and-concat would change grading.
 *
 * - Every existing step keeps its index and id.
 * - A newly chosen tool assert is spliced after the last existing tool
 *   assert (or at the end).
 * - `noTool` removes `toolCalledWith` asserts in place.
 * - Interact / widget-assert rows are left where they are.
 */
export function writeSimpleCase(
  prevSteps: TestStep[],
  view: WriteSimpleCaseView,
): TestStep[] {
  // Same guard as `readSimpleCase`: on a fresh draft `prevSteps[0]` is
  // `undefined` and the narrowing helpers dereference `.kind`. The comment
  // below already contemplates "the case is empty", so this shape was always
  // meant to be reachable.
  const prevFirst = prevSteps.length > 0 ? prevSteps[0] : undefined;
  const prevPrompt =
    prevFirst && isPromptStep(prevFirst) ? prevFirst : undefined;
  /**
   * Lead with a prompt only when the case already had one, the case is empty
   * (a fresh draft), or the author actually typed one. Every tool button in
   * the form rewrites through here, so an unconditional prompt would let
   * "No tool should be called" splice an empty model turn onto the front of a
   * `toolCall`-first render check — inventing a turn the author never wrote.
   */
  const writePrompt =
    Boolean(prevPrompt) ||
    prevSteps.length === 0 ||
    view.prompt.trim().length > 0;
  const promptStep: TestStep | undefined = writePrompt
    ? {
        id: prevPrompt?.id ?? newStepId("prompt"),
        kind: "prompt",
        prompt: view.prompt,
      }
    : undefined;
  const rest = prevPrompt ? prevSteps.slice(1) : [...prevSteps];
  const lead = promptStep ? [promptStep] : [];

  if (view.noTool) {
    // Negative applies to every model turn (and the backend rejects a negative
    // case that kept any `toolCalledWith`), so this drops them list-wide.
    return [
      ...lead,
      ...rest.filter(
        (step) =>
          !(
            step.kind === "assert" &&
            "type" in step.assertion &&
            step.assertion.type === "toolCalledWith"
          ),
      ),
    ];
  }

  const prevTools = rest.filter(isToolCalledWithAssert);
  const assigned = view.tools.map((tool, index) => {
    const id = tool.id ?? prevTools[index]?.id ?? newStepId("assert");
    return { ...tool, id };
  });
  const assignedById = new Map(assigned.map((tool) => [tool.id, tool]));
  const prevToolIds = new Set(prevTools.map((step) => step.id));

  const kept: TestStep[] = [];
  for (const step of rest) {
    if (isToolCalledWithAssert(step)) {
      const incoming = assignedById.get(step.id);
      if (!incoming) continue;
      kept.push(toolAssertStep(step.id, incoming));
      continue;
    }
    kept.push(step);
  }

  const brandNew = assigned.filter((tool) => !prevToolIds.has(tool.id));
  if (brandNew.length === 0) {
    return [...lead, ...kept];
  }

  /**
   * A tool chosen under "Which tool should handle it?" belongs to the turn the
   * form's prompt box authors — the FIRST one. Searching the whole list would
   * attach it after the last tool assert anywhere, so on a two-turn case the
   * tool would silently grade turn 2. Bound the search to the first turn:
   * everything before the next `prompt`/`toolCall` that opens another turn.
   *
   * With no leading prompt there is no model turn at the front to own it, so
   * fall back to appending. The form hides the tool question in that shape
   * (the prompt is locked), so this is a direct-call path only.
   */
  const firstTurnEnd = (() => {
    if (!promptStep) return kept.length;
    const next = kept.findIndex(
      (step) => isPromptStep(step) || isToolCallStep(step),
    );
    return next === -1 ? kept.length : next;
  })();
  let lastToolIdx = -1;
  for (let i = firstTurnEnd - 1; i >= 0; i -= 1) {
    if (isToolCalledWithAssert(kept[i]!)) {
      lastToolIdx = i;
      break;
    }
  }
  /**
   * The anchor the bounded search above resolved to, as a step ID for the one
   * shared splice (`insertStepAfter`):
   *   - after the last tool assert in this turn, when there is one;
   *   - else after the turn's last step, when the turn has any;
   *   - else `null` — turn 1 is the prompt alone, so the tool goes to the front
   *     of `kept`, which is directly after the prompt in `[...lead, ...kept]`.
   * Each new tool then chains off the previous one's ID (an assert anchor
   * inserts immediately after it), preserving the authored order.
   */
  const anchorId =
    lastToolIdx !== -1
      ? kept[lastToolIdx]!.id
      : firstTurnEnd > 0
        ? kept[firstTurnEnd - 1]!.id
        : null;
  let withTools = kept;
  let previousId = anchorId;
  for (const tool of brandNew) {
    const step = toolAssertStep(tool.id, tool);
    withTools = insertStepAfter(withTools, previousId, step);
    previousId = step.id;
  }
  return [...lead, ...withTools];
}

export function removeStepById(steps: TestStep[], stepId: string): TestStep[] {
  return steps.filter((step) => step.id !== stepId);
}

/**
 * The locator's most readable handle, in the recorder's own precedence
 * (testId → role+name → text → css). On the contract `role` is an object,
 * `{ role, name?, exact? }`, never a string.
 */
function locatorTarget(action: InteractAction): string {
  const target = "target" in action ? action.target : undefined;
  if (!target || typeof target !== "object") return "";
  const locator = target as {
    testId?: string;
    role?: { role?: string; name?: string };
    text?: string;
    css?: string;
  };
  return (
    locator.testId?.trim() ||
    locator.role?.name?.trim() ||
    locator.text?.trim() ||
    locator.role?.role?.trim() ||
    locator.css?.trim() ||
    ""
  );
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** Verb + target for an *In the app* row, `browserStepLabel` style. */
export function inAppStepLabel(step: InAppStep): string {
  if (isInteractStep(step)) {
    const verb = capitalize(step.action.kind);
    const target = locatorTarget(step.action);
    return target ? `${verb} ${target}` : verb;
  }
  const kindLabel = WIDGET_ASSERTION_LABELS[step.assertion.kind];
  if (step.assertion.kind === "textVisible") {
    return `${kindLabel} · ${step.assertion.text}`;
  }
  if (step.assertion.kind === "inputValue") {
    return step.assertion.equals
      ? `${kindLabel} · ${step.assertion.equals}`
      : kindLabel;
  }
  if (step.assertion.kind === "widgetToolCalled") {
    return `${kindLabel} · ${step.assertion.calledToolName}`;
  }
  const target = locatorTarget({
    kind: "click",
    target: step.assertion.target,
  });
  return target ? `${kindLabel} · ${target}` : kindLabel;
}
