/**
 * Pure model for the flag-gated simple case editor.
 *
 * A case is "simple" when it is one prompt plus zero or more
 * `toolCalledWith` asserts — the shape the three-question form can
 * author without loss. Kind is derived from resolved matchOptions
 * (PR1–PR5); a persisted `kind` field arrives later (PR7).
 */

import {
  isAssertStep,
  isPromptStep,
  isWidgetAssertion,
  type TestStep,
} from "@/shared/steps";
import {
  MATCH_OPTIONS_DEFAULTS,
  type EvalMatchOptions,
} from "@/shared/eval-matching";

export const SIMPLE_CASE_EDITOR_FLAG = "eval-simple-case-editor";

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

export type SimpleCaseView = {
  prompt: string;
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

/**
 * Regression is the strict-order + no-extras pair. `argumentMatching` is
 * deliberately not part of the discriminant — both kinds keep `partial`.
 */
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

export function matchOptionsForKind(kind: CaseKind): Required<
  Omit<EvalMatchOptions, "allowExtraToolCalls">
> {
  if (kind === "regression") {
    return {
      toolCallOrder: "strict",
      maxExtraToolCalls: 0,
      argumentMatching: "partial",
    };
  }
  return { ...MATCH_OPTIONS_DEFAULTS };
}

/**
 * `steps[0]` is a prompt and every other step is a non-widget
 * `toolCalledWith` assert. Prompt-only is simple. A second prompt,
 * `toolCall`, `interact`, widget assert, or any other inline predicate
 * is not.
 */
export function isSimpleCaseShape(steps: TestStep[]): boolean {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  if (!isPromptStep(steps[0])) return false;
  return steps.slice(1).every(isToolCalledWithAssert);
}

export function readSimpleCase(steps: TestStep[]): SimpleCaseView {
  const prompt = isPromptStep(steps[0]) ? steps[0].prompt : "";
  const tools: SimpleCaseTool[] = [];
  for (const step of steps) {
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
  return { prompt, tools, noTool: tools.length === 0 };
}

/**
 * Rewrite the simple-case slice of `prevSteps`. Keeps step 0's id when it
 * is already a prompt, and reuses existing `toolCalledWith` assert ids by
 * index (or an explicit `id` on the incoming tool). `noTool` drops only
 * `toolCalledWith` asserts so flipping back can restore from caller state.
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

  const leftover = prevSteps
    .slice(prevPrompt ? 1 : 0)
    .filter((step) => !isToolCalledWithAssert(step));

  if (view.noTool) {
    return [promptStep, ...leftover];
  }

  const prevTools = prevSteps.filter(isToolCalledWithAssert);
  const toolSteps: TestStep[] = view.tools.map((tool, index) => {
    const prev = prevTools[index];
    return {
      id: tool.id ?? prev?.id ?? newStepId("assert"),
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: tool.toolName,
        args: { args: tool.arguments ?? {} },
      },
    };
  });

  return [promptStep, ...toolSteps, ...leftover];
}
