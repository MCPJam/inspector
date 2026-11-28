import {
  type EvalSuiteFileCaseV2,
  evalSuiteFileCaseV2Schema,
} from "./suite-file.js";
import type { InteractStep, ToolCallStep, WidgetAssertion } from "./steps.js";

export const MAX_RECORDED_APP_BROWSER_STEPS = 12;

export interface RecordedAppAction {
  toolCallId: string;
  stepIndex: number;
  action: string;
  actor?: "persona" | "model" | "scripted";
  ok?: boolean;
  target?: { role: string; name: string; scope?: "host" };
  followUps?: readonly string[];
  requiresModelFollowUp?: boolean;
}

/**
 * Compile a single recorded app journey. The caller supplies the captured
 * starting call and assertions for the state it wants to preserve in CI.
 * Pass all actions for this journey so unsupported actions fail compilation.
 */
export function compileRecordedAppCase(input: {
  id: string;
  title: string;
  openingCall: Omit<ToolCallStep, "id" | "kind"> & { toolCallId: string };
  actions: readonly RecordedAppAction[];
  assertions: readonly WidgetAssertion[];
}): EvalSuiteFileCaseV2 {
  const { toolCallId, ...openingCall } = input.openingCall;
  const encodedArgs = JSON.stringify(openingCall.arguments);
  if (
    encodedArgs &&
    /\[REDACTED\]|<redacted>|\[secret:[^\]]+\]|\[truncated: max depth\]/.test(
      encodedArgs
    )
  ) {
    throw new Error(
      "Opening call arguments contain redacted or truncated values."
    );
  }
  const sortedActions = [...input.actions].sort(
    (a, b) => a.stepIndex - b.stepIndex
  );
  const clicks: InteractStep[] = [];
  for (const [index, step] of sortedActions.entries()) {
    const label = `Recorded action ${step.stepIndex}`;
    if (step.toolCallId !== toolCallId || step.stepIndex !== index) {
      throw new Error(
        `${label} is outside the opening app call or its sequence is incomplete.`
      );
    }
    if (
      step.action !== "left_click" ||
      step.actor !== "persona" ||
      !step.ok ||
      !step.target?.name
    ) {
      throw new Error(
        `${label} needs a successful persona click with a named target.`
      );
    }
    if (step.requiresModelFollowUp || step.followUps?.length) {
      throw new Error(`${label} sent a message that requires a model turn.`);
    }
    const { scope, role, name } = step.target;
    clicks.push({
      id: `click-${step.stepIndex}`,
      kind: "interact",
      toolName: openingCall.toolName,
      action: {
        kind: "click",
        target: {
          ...(scope ? { scope } : {}),
          role: { role, name, exact: true },
        },
      },
    });
  }
  if (clicks.length + input.assertions.length > MAX_RECORDED_APP_BROWSER_STEPS) {
    throw new Error(`A recorded app case can use at most ${MAX_RECORDED_APP_BROWSER_STEPS} clicks and assertions in total.`);
  }
  if (!clicks.length || !input.assertions.length) {
    throw new Error(
      "A recorded app case needs a persona click and at least one assertion."
    );
  }
  if (
    input.assertions.some(
      (assertion) => assertion.toolName !== openingCall.toolName
    )
  ) {
    throw new Error(
      "App assertions must target the tool that opened the recorded app."
    );
  }
  return evalSuiteFileCaseV2Schema.parse({
    id: input.id,
    title: input.title,
    steps: [
      { ...openingCall, id: "open-app", kind: "toolCall" },
      ...clicks,
      ...input.assertions.map((assertion, index) => ({
        id: `assert-${index}`,
        kind: "assert",
        assertion,
      })),
    ],
  });
}
