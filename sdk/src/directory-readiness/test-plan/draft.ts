/**
 * The default plan for a server: every tool it lists, ordered so nothing
 * changes until the reads are done and nothing is destroyed until the end.
 *
 * Parity is the rule (the directories' reviewers run every tool), so the
 * draft excludes nothing; a person or an agent excludes a costly or
 * destructive tool with a reason. The arguments and fixtures most calls need
 * are left for the drafting model or a person, and the validator lists them.
 *
 * Pure. Safe from the browser entry.
 */

import { acceptsEmptyArguments } from "../lazy-auth.js";
import {
  DIRECTORY_TEST_PLAN_LIMITS,
  DIRECTORY_TEST_PLAN_SCHEMA_VERSION,
} from "./types.js";
import type {
  DirectoryTestBudget,
  DirectoryTestCase,
  DirectoryTestPlan,
  DirectoryTestPlanTool,
  DirectoryToolEffect,
  DirectoryToolPlan,
} from "./types.js";

/** What the annotations say a call may do, with MCP's defaults for what they leave out. */
export function directoryToolEffect(
  tool: Pick<DirectoryTestPlanTool, "annotations">
): { effect: DirectoryToolEffect; openWorld: boolean } {
  const hints = tool.annotations ?? {};
  // MCP's defaults: not read-only, destructive when it writes, open world.
  const effect: DirectoryToolEffect =
    hints.readOnlyHint === true
      ? "read"
      : hints.destructiveHint === false
        ? "write"
        : "destructive";
  return { effect, openWorld: hints.openWorldHint !== false };
}

export function draftDirectoryTestPlan(
  tools: readonly DirectoryTestPlanTool[],
  options: { budget?: Partial<DirectoryTestBudget> } = {}
): DirectoryTestPlan {
  const entries = new Map<string, DirectoryToolPlan>();
  const cases: DirectoryTestCase[] = [];
  for (const tool of tools) {
    if (entries.has(tool.name)) continue;
    const { effect, openWorld } = directoryToolEffect(tool);
    entries.set(tool.name, {
      tool: tool.name,
      effect,
      openWorld,
      action: "run",
      writes: [],
    });
    const bare = acceptsEmptyArguments(tool);
    cases.push({
      id: `${tool.name}#valid`,
      tool: tool.name,
      kind: "valid",
      ...(bare ? { arguments: {} } : {}),
    });
    // A read must refuse a call missing its required arguments. A write is
    // never sent one: accepted, it would change data outside every fixture.
    if (!bare && effect === "read") {
      cases.push({
        id: `${tool.name}#missing-arguments`,
        tool: tool.name,
        kind: "negative",
        arguments: {},
        expectation: "The tool refuses a call without its required arguments.",
      });
    }
  }
  const plan: DirectoryTestPlan = {
    schemaVersion: DIRECTORY_TEST_PLAN_SCHEMA_VERSION,
    fixtures: [],
    tools: [...entries.values()],
    cases,
    budget: {
      maxCalls: Math.min(
        Math.max(cases.length, 1),
        DIRECTORY_TEST_PLAN_LIMITS.maxCalls
      ),
      concurrency: 1,
      callTimeoutMs: 30_000,
      ...options.budget,
    },
    cleanup: [],
  };
  return { ...plan, cases: orderDirectoryTestCases(plan) };
}

/**
 * The default order: cases that create fixtures, then reads, then other
 * writes, then every destructive case. Within each, closed-world calls come
 * first, so a budget that runs out stops at the calls that reach past the
 * server; otherwise the plan's order holds.
 */
export function orderDirectoryTestCases(
  plan: Pick<DirectoryTestPlan, "tools" | "cases">
): DirectoryTestCase[] {
  const entries = new Map(plan.tools.map((entry) => [entry.tool, entry]));
  const rank = (testCase: DirectoryTestCase) => {
    const entry = entries.get(testCase.tool);
    const effect = entry?.effect ?? "destructive";
    const stage =
      effect === "destructive"
        ? 3
        : testCase.creates?.length
          ? 0
          : effect === "read"
            ? 1
            : 2;
    return stage * 2 + (entry?.openWorld === false ? 0 : 1);
  };
  return plan.cases
    .map((testCase, index) => ({ testCase, index, rank: rank(testCase) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ testCase }) => testCase);
}
