/**
 * The edits a person makes to a test plan on the Readiness page, as pure
 * functions of the plan. Each keeps the plan's rules: an excluded tool has no
 * cases, and restored cases take their place in the default run order, with
 * destructive calls last (D28).
 */
import {
  orderDirectoryTestCases,
  type DirectoryTestBudget,
  type DirectoryTestCase,
  type DirectoryTestPlan,
  type DirectoryToolPlan,
} from "@mcpjam/sdk/browser";
import type { PlatformDirectoryTestArgumentDraft } from "@mcpjam/sdk/platform";

type Plan = DirectoryTestPlan;

export function editCase(
  plan: Plan,
  caseId: string,
  patch: Partial<Pick<DirectoryTestCase, "arguments" | "expectedError">>,
): Plan {
  const cases = plan.cases.map((entry) =>
    entry.id === caseId ? { ...entry, ...patch } : entry,
  );
  return { ...plan, cases };
}

/** A draft's arguments, and a negative case's expected refusal, in its case. */
export function acceptDraft(
  plan: Plan,
  draft: PlatformDirectoryTestArgumentDraft,
): Plan {
  const { caseId, arguments: args, expectedError } = draft;
  return editCase(plan, caseId, {
    arguments: args,
    ...(expectedError ? { expectedError } : {}),
  });
}

export const editBudget = (
  plan: Plan,
  patch: Partial<DirectoryTestBudget>,
): Plan => ({ ...plan, budget: { ...plan.budget, ...patch } });

export function editExclusion(
  plan: Plan,
  tool: string,
  exclusion: NonNullable<DirectoryToolPlan["exclusion"]>,
): Plan {
  const tools = plan.tools.map((entry) =>
    entry.tool === tool ? { ...entry, exclusion } : entry,
  );
  return { ...plan, tools };
}

/**
 * Runs a tool, limits it to its negative cases, or excludes it. An excluded
 * tool loses its cases; including it again brings back the saved plan's cases
 * for it, or one valid-input case for its arguments to be filled in.
 */
export function setToolAction(
  plan: Plan,
  tool: string,
  action: DirectoryToolPlan["action"],
  saved?: Plan,
): Plan {
  const tools = plan.tools.map((entry) => {
    if (entry.tool !== tool) return entry;
    const { exclusion: _exclusion, ...included } = entry;
    return action === "excluded"
      ? { ...entry, action }
      : { ...included, action };
  });
  const others = plan.cases.filter((entry) => entry.tool !== tool);
  if (action === "excluded") return { ...plan, tools, cases: others };
  if (others.length < plan.cases.length) return { ...plan, tools };
  const kept = saved?.cases.filter((entry) => entry.tool === tool) ?? [];
  const restored: DirectoryTestCase[] =
    kept.length > 0 ? kept : [{ id: `${tool}#valid`, tool, kind: "valid" }];
  const cases = orderDirectoryTestCases({
    tools,
    cases: [...plan.cases, ...restored],
  });
  return { ...plan, tools, cases };
}
