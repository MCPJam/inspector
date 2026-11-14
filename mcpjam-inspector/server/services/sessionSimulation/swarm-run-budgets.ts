import {
  platformExecutionBudgetCeilings,
  resolveExecutionBudgetsForSurface,
  type ResolvedExecutionBudgets,
} from "@mcpjam/sdk/contract";

/**
 * The swarm platform defaults, taken from the contract's own resolver rather
 * than written out here. A second copy of these numbers is a second thing to
 * keep in step with the ceilings and the settings surface.
 */
function defaultSwarmExecutionBudgets(): ResolvedExecutionBudgets {
  const resolution = resolveExecutionBudgetsForSurface({ surface: "swarms" });
  if (!resolution.ok) {
    // Unreachable: the platform defaults are the thing ceilings are defined
    // against. Thrown rather than silently patched, because a violation here
    // means the two tables have drifted and every run is mis-bounded.
    throw new Error(
      `platform swarm budgets must resolve: ${JSON.stringify(resolution.violations)}`,
    );
  }
  return resolution.resolved;
}

/**
 * The budgets a swarm run executes on.
 *
 * Frozen budgets run exactly as the backend froze them: its resolver
 * (`resolveSwarmRunExecutionBudgets`) already sized a default run clock for
 * local sessions, and an authored one is the author's number. A run from a
 * backend that froze none gets the platform defaults, with the run clock sized
 * the same way here, because the launcher's machine runs its local sessions
 * two at a time.
 */
export function swarmRunBudgets(
  frozen: ResolvedExecutionBudgets | undefined,
  localSessions: number,
): ResolvedExecutionBudgets {
  if (frozen) return frozen;
  const budgets = defaultSwarmExecutionBudgets();
  budgets.runTimeoutMs = Math.min(
    platformExecutionBudgetCeilings("swarms").runTimeoutMs,
    Math.max(
      budgets.runTimeoutMs,
      Math.ceil(localSessions / 2) * budgets.unitTimeoutMs,
    ),
  );
  return budgets;
}
