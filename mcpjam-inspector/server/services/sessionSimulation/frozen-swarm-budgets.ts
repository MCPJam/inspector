import {
  resolvedExecutionBudgetsSchema,
  type ResolvedExecutionBudgets,
} from "@mcpjam/sdk/contract";

/** The code a run's attempts are closed under when its budgets are unreadable. */
export const UNREADABLE_SWARM_BUDGETS_CODE = "invalid_execution_budgets";

export const UNREADABLE_SWARM_BUDGETS_MESSAGE =
  "This swarm run could not start because its time limits could not be read. Ask an organization admin to check the swarm time limits, then launch again.";

export type FrozenSwarmBudgets =
  | { ok: true; budgets?: ResolvedExecutionBudgets }
  | { ok: false; issues: string };

/**
 * The execution budgets the backend froze into a run's launch snapshot, read
 * with the contract's strict schema.
 *
 * Absent is a backend that predates frozen swarm budgets, and the runner
 * resolves (and sizes) the platform defaults itself. Present but not the
 * contract's shape is refused, never defaulted: an org ceiling of zero, or a
 * clock this runner does not know, would otherwise run on numbers nobody
 * resolved, which is what freezing them at launch exists to prevent.
 */
export function readFrozenSwarmBudgets(snapshot: object): FrozenSwarmBudgets {
  if (
    !("executionBudgets" in snapshot) ||
    snapshot.executionBudgets === undefined
  ) {
    return { ok: true };
  }
  const parsed = resolvedExecutionBudgetsSchema.safeParse(
    snapshot.executionBudgets,
  );
  return parsed.success
    ? { ok: true, budgets: parsed.data }
    : { ok: false, issues: parsed.error.message };
}
