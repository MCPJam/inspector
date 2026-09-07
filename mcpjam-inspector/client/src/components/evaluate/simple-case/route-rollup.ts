import { buildPathKey } from "@mcpjam/sdk/contract";
import type { TestStep } from "@/shared/steps";
import { groupCaseIterations } from "../../evals/runs/group-case-iterations";
import type { EvalIteration } from "../../evals/types";
import {
  readSimpleCase,
  writeSimpleCase,
  type CaseKind,
} from "./simple-case-model";

export type RouteSummary = {
  pathKey: string;
  count: number;
  iterationIds: string[];
};

export type RouteRollup = {
  total: number;
  routes: RouteSummary[];
};

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

export function expectedPathKeyFromSteps(steps: TestStep[]): string {
  return buildPathKey(readSimpleCase(steps).tools.map((tool) => tool.toolName));
}

export function pathKeyForIteration(iteration: EvalIteration): string {
  return buildPathKey(
    (iteration.actualToolCalls ?? []).map((call) => call.toolName),
  );
}

/** Summarize routes over the latest batch of a case's iterations. */
export function summarizeRoutes(iterations: EvalIteration[]): RouteRollup {
  const batch = groupCaseIterations(iterations)[0];
  const latest = batch?.iterations ?? [];
  const byPath = new Map<string, RouteSummary>();
  for (const iteration of latest) {
    const pathKey = pathKeyForIteration(iteration);
    const existing = byPath.get(pathKey);
    if (existing) {
      existing.count += 1;
      existing.iterationIds.push(iteration._id);
    } else {
      byPath.set(pathKey, {
        pathKey,
        count: 1,
        iterationIds: [iteration._id],
      });
    }
  }
  return {
    total: latest.length,
    routes: [...byPath.values()].sort((a, b) => b.count - a.count),
  };
}
