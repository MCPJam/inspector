/**
 * Pure model for the Evaluate simple case editor.
 *
 * A case is "simple" when it is one prompt plus any sequence of interact
 * steps, widget asserts, and non-widget `toolCalledWith` asserts — the shape
 * the three-section form can author without loss. Anything else (a second
 * prompt, a `toolCall`, a non-tool inline predicate) still opens the step
 * list, losslessly.
 */

import {
  isAssertStep,
  isInteractStep,
  isPromptStep,
  isWidgetAssertion,
  WIDGET_ASSERTION_LABELS,
  type InteractAction,
  type InteractStep,
  type TestStep,
  type WidgetAssertion,
} from "@/shared/steps";
import {
  MATCH_OPTIONS_DEFAULTS,
  type EvalMatchOptions,
  type Predicate,
} from "@/shared/eval-matching";

export type MoreCheckGroupId = "response" | "selection" | "appView";

/**
 * The "More checks" groups, labelled by what a reader is checking rather
 * than by the analyzer's stage (`PREDICATE_STAGE` files every response
 * predicate at `userValue`, because no authorable grader measures the
 * `response` link today).
 *
 * Partition rule, test-enforced: every kind in `PREDICATE_KIND_LABELS` is
 * in exactly one group or in `EXCLUDED_FROM_MORE_CHECKS`. A kind added to
 * the catalog fails that test until somebody files it — a group list that
 * merely omits a kind would hide it silently.
 */
export const MORE_CHECK_GROUPS: ReadonlyArray<{
  id: MoreCheckGroupId;
  label: string;
  kinds: ReadonlyArray<Predicate["type"]>;
}> = [
  {
    id: "response",
    label: "Response",
    kinds: [
      "responseContains",
      "responseMatches",
      "finalAssistantMessageNonEmpty",
      "noToolErrors",
      "tokenBudgetUnder",
      "turnCountUnder",
    ],
  },
  {
    id: "selection",
    label: "Selection and call",
    kinds: ["toolCalledAtLeastOnce", "toolNeverCalled", "firstToolWas"],
  },
  {
    id: "appView",
    label: "App view",
    kinds: [
      "widgetRendered",
      "widgetRenderLatencyUnder",
      "widgetNoConsoleErrors",
    ],
  },
];

/**
 * Owned by the tool question above the disclosure. Offering it again here
 * would author the route twice, and on a no-tool case would create the
 * contradiction the corpus guard rejects.
 */
export const EXCLUDED_FROM_MORE_CHECKS: ReadonlySet<Predicate["type"]> =
  new Set<Predicate["type"]>(["toolCalledWith"]);

export const UNSET_TOOLS_BLOCK_REASON =
  "Choose which tool should handle it, or that no tool should be called.";

export type CaseKind = "capability" | "regression";

export type ToolsChoice = "unset" | "tools" | "noTool";

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

let stepIdCounter = 0;
function newStepId(kind: string): string {
  stepIdCounter += 1;
  return `${kind}-${Date.now()}-${stepIdCounter}`;
}

export function isToolCalledWithAssert(step: TestStep): boolean {
  return (
    isAssertStep(step) &&
    !isWidgetAssertion(step.assertion) &&
    step.assertion.type === "toolCalledWith"
  );
}

export function isWidgetAssertStep(step: TestStep): step is WidgetAssertStep {
  return isAssertStep(step) && isWidgetAssertion(step.assertion);
}

export function isInAppStep(step: TestStep): step is InAppStep {
  return isInteractStep(step) || isWidgetAssertStep(step);
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
  const prompt = isPromptStep(steps[0]) ? steps[0].prompt : "";
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
  const prevPrompt = isPromptStep(prevSteps[0]) ? prevSteps[0] : undefined;
  const promptStep: TestStep = {
    id: prevPrompt?.id ?? newStepId("prompt"),
    kind: "prompt",
    prompt: view.prompt,
  };
  const rest = prevPrompt ? prevSteps.slice(1) : [...prevSteps];

  if (view.noTool) {
    return [
      promptStep,
      ...rest.filter((step) => !isToolCalledWithAssert(step)),
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
    return [promptStep, ...kept];
  }

  let lastToolIdx = -1;
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    if (isToolCalledWithAssert(kept[i]!)) {
      lastToolIdx = i;
      break;
    }
  }
  const insertAt = lastToolIdx === -1 ? kept.length : lastToolIdx + 1;
  kept.splice(
    insertAt,
    0,
    ...brandNew.map((tool) => toolAssertStep(tool.id, tool)),
  );
  return [promptStep, ...kept];
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
