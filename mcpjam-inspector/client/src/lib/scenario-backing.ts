/**
 * What deleting (or unpublishing, or rebinding) a scenario did to the setup
 * behind it — and how to say so.
 *
 * A scenario is a chatbox pointing at an environment. Two kinds of environment
 * can be behind that pointer, and they retire differently:
 *
 *   - The PRIVATE backing minted by the User Testing create flow: a nameless
 *     ad-hoc environment over a client that exists only for this scenario.
 *     Both retire with the scenario — otherwise the client becomes permanently
 *     undeletable (its live environment blocks the delete) and accumulates as
 *     a ghost in the project.
 *   - A saved environment the user published from, which is theirs and stays.
 *
 * The backend decides which case applies and returns a report; nothing here
 * infers it. That is the point: the copy this replaces asserted "the
 * environment is left untouched" unconditionally, and went on saying it after
 * the behavior changed.
 */

/** Mirrors `ScenarioBackingRetirement` in mcpjam-backend convex/lib/scenarioBacking.ts. */
export interface ScenarioBackingRetirement {
  environmentArchived: boolean;
  hostDeleted: boolean;
  /** Why something was kept. Present whenever anything was. */
  keptReason?: string;
}

/**
 * One sentence describing what a scenario deletion actually removed, for the
 * agent-tool result and any UI that reports the outcome.
 *
 * `retirement` is optional, and its absence means an older backend that has no
 * retirement path at all — which left the environment alone, so the
 * kept-the-environment sentence is the honest one there, not a hedge.
 */
export function describeScenarioDeletion(
  environmentId: string | null | undefined,
  retirement?: ScenarioBackingRetirement,
): string {
  const base = "The scenario and its history are gone.";
  // A host-backed scenario has no environment to say anything about.
  if (!environmentId) return base;
  if (retirement?.environmentArchived && retirement.hostDeleted) {
    return `${base} Its setup and the private client behind it were removed with it.`;
  }
  if (retirement?.environmentArchived) {
    return `${base} Its setup was archived, but the client behind it was kept${
      retirement.keptReason ? ` — ${retirement.keptReason}` : "."
    }`;
  }
  return `${base} The environment it was published from is unchanged.`;
}
