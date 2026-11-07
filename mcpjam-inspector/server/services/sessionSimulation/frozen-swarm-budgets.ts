import {
  resolvedExecutionBudgetsSchema,
  type ResolvedExecutionBudgets,
} from "@mcpjam/sdk/contract";
import type { JourneySnapshot } from "../swarm-agent.js";

/** The code a run's attempts are closed under when its budgets are unreadable. */
export const UNREADABLE_SWARM_BUDGETS_CODE = "invalid_execution_budgets";

export const UNREADABLE_SWARM_BUDGETS_MESSAGE =
  "This swarm run could not start because its time limits could not be read. Ask an organization admin to check the swarm time limits, then launch again.";

export const UNSUPPORTED_SWARM_BUDGETS_MESSAGE =
  "This swarm run could not start because this version of MCPJam does not support its time limits. Update MCPJam, then launch again.";

/**
 * What a newer contract looks like to this one: a clock, or a provenance, it
 * has never heard of. An admin cannot change that, so it gets its own message.
 */
const NEWER_CONTRACT_ISSUES = new Set(["unrecognized_keys", "invalid_value"]);

export type FrozenSwarmBudgets =
  | { ok: true; budgets?: ResolvedExecutionBudgets }
  | { ok: false; issues: string; message: string };

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
export function readFrozenSwarmBudgets(
  snapshot: JourneySnapshot & { executionBudgets?: unknown },
): FrozenSwarmBudgets {
  if (snapshot.executionBudgets === undefined) return { ok: true };
  const parsed = resolvedExecutionBudgetsSchema.safeParse(
    snapshot.executionBudgets,
  );
  if (parsed.success) return { ok: true, budgets: parsed.data };
  const newerContract = parsed.error.issues.some((issue) =>
    NEWER_CONTRACT_ISSUES.has(issue.code),
  );
  return {
    ok: false,
    issues: parsed.error.message,
    message: newerContract
      ? UNSUPPORTED_SWARM_BUDGETS_MESSAGE
      : UNREADABLE_SWARM_BUDGETS_MESSAGE,
  };
}
