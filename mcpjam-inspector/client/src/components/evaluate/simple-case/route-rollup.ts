import type { TestStep } from "@/shared/steps";
import type { EvalIteration } from "../../evals/types";
import {
  readSimpleCase,
  writeSimpleCase,
  type CaseKind,
} from "./simple-case-model";

export function toolsFromIteration(
  iteration: EvalIteration,
  kind: "capability" | "regression",
): Array<{ toolName: string; arguments: Record<string, unknown> }> {
  const calls = iteration.actualToolCalls ?? [];
  if (kind === "capability") {
    const seen = new Set<string>();
    const tools: Array<{
      toolName: string;
      arguments: Record<string, unknown>;
    }> = [];
    for (const call of calls) {
      if (seen.has(call.toolName)) continue;
      seen.add(call.toolName);
      tools.push({ toolName: call.toolName, arguments: {} });
    }
    return tools;
  }
  return calls.map((call) => ({
    toolName: call.toolName,
    arguments: (call.arguments ?? {}) as Record<string, unknown>,
  }));
}

/** Write this trial's observed route into the simple-case expected tools. */
export function adoptRouteFromIteration(
  steps: TestStep[],
  iteration: EvalIteration,
  kind: CaseKind,
): TestStep[] {
  const view = readSimpleCase(steps);
  const tools = toolsFromIteration(iteration, kind);
  return writeSimpleCase(steps, {
    prompt: view.prompt,
    tools,
    noTool: tools.length === 0,
  });
}
