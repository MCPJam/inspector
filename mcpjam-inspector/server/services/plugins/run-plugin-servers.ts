/**
 * Decision D2 — the SHARED execution-time re-gate for a run's pinned plugin
 * servers, for both run products.
 *
 * Journeys got this first (`services/journeys/plugin-servers.ts`). BE-5 shipped
 * the suite twin (`testSuites:resolveRunPluginServersForExecution`) with the
 * same contract, resolved by the same backend module
 * (`convex/lib/runPluginServers.ts`). Two copies of "which of these problems
 * means stop?" would be two chances to relax one of them, so the rules live
 * here once and each product supplies only its own query name, arguments, and
 * response envelope.
 *
 * The contract, restated because every line below exists to hold it:
 *
 *   A run snapshot's `environmentPluginVersions` / `pluginServerIds` is
 *   PROVENANCE — a record of what was pinned, never a grant to connect it
 *   again. The backend re-resolves the live plugin rows on every call, so
 *   disabling or uninstalling a plugin changes the answer with no snapshot
 *   rewrite. A non-empty `unavailable` OR `droppedSnapshotServerIds` means the
 *   execution MUST NOT PROCEED.
 *
 * FAIL CLOSED IS THE WHOLE POINT. Every path that cannot produce a verified
 * list throws rather than returning `[]`: a run that connects a shrunken server
 * set runs an environment nobody configured, and does it silently. "I couldn't
 * check" must never be delivered as "nothing to add".
 *
 * Hand-mirrored contract (no codegen; string function refs like the rest of the
 * inspector→Convex surface).
 */
import type { ConvexHttpClient } from "convex/browser";

/** One connectable server contributed by a still-valid pin. */
export interface RunPluginServer {
  serverId: string;
  name: string;
  pluginVersionId: string;
  pluginId: string;
  pluginName: string;
  componentKey: string;
}

/** Why one pinned version contributes nothing to THIS execution. */
export interface RunPluginServerUnavailable {
  pluginVersionId: string;
  /** Backend-authored reason code; unknown values are reported verbatim. */
  reason: string;
  pluginName?: string;
  componentKey?: string;
}

/** The three-list envelope both products' queries return. */
export interface RunPluginServerResolution {
  servers: RunPluginServer[];
  unavailable: RunPluginServerUnavailable[];
  droppedSnapshotServerIds: string[];
}

/**
 * Thrown when a run's pins cannot be verified as still-connectable — including
 * "the backend could not tell us". Callers turn this into a SETUP failure that
 * finalizes the run before any model executes.
 */
export class RunPluginServersUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunPluginServersUnavailableError";
  }
}

/**
 * One human sentence per unavailable pin, naming the plugin (and the component
 * when the backend could identify it) so a setup failure is ATTRIBUTABLE rather
 * than a bare "plugins unavailable".
 *
 * The `default` arm matters: reason codes are a backend-owned union that will
 * grow, and an unrecognized code must still stop the run and say what it was.
 */
export function describeRunPluginUnavailable(
  entry: RunPluginServerUnavailable,
  /** How to name this execution in prose — "journey" or "run". */
  surfaceNoun: string
): string {
  const who = entry.pluginName ?? entry.pluginVersionId;
  switch (entry.reason) {
    case "disabled":
      return `"${who}" is disabled`;
    case "uninstalled":
      return `"${who}" was uninstalled`;
    case "not_found":
      return `"${who}" no longer exists in this project`;
    case "not_ready":
      return `"${who}" has not finished importing`;
    case "server_missing":
      return `"${who}" no longer provides its server${
        entry.componentKey ? ` "${entry.componentKey}"` : ""
      }`;
    case "unsupported_placement":
      return `"${who}" provides a server that can't run in a hosted ${surfaceNoun}`;
    case "unresolvable_scope":
      return `"${who}" could not be resolved in this project`;
    default:
      return `"${who}" is unavailable (${entry.reason})`;
  }
}

/**
 * Validate the SHAPE of one resolution before trusting it.
 *
 * This crosses a deploy boundary, so an incompatible or truncated payload is a
 * live possibility during skew — and a permissive read of one is
 * indistinguishable from a clean all-clear. `{}` would satisfy a naive check
 * and then fall through three `?? []` defaults to "no plugins, proceed",
 * silently shrinking the environment: the exact failure this module prevents.
 * All three arrays are REQUIRED, not optional-with-a-default, because an absent
 * `unavailable` is "I wasn't told about problems", never "there are none".
 */
export function assertRunPluginResolutionShape(
  value: unknown,
  unrecognizedMessage: string
): asserts value is RunPluginServerResolution {
  const candidate = value as Partial<RunPluginServerResolution> | null;
  if (
    !candidate ||
    !Array.isArray(candidate.servers) ||
    !Array.isArray(candidate.unavailable) ||
    !Array.isArray(candidate.droppedSnapshotServerIds)
  ) {
    throw new RunPluginServersUnavailableError(unrecognizedMessage);
  }
}

/**
 * Throw unless the resolution is a clean all-clear.
 *
 * `droppedSnapshotServerIds` is folded into the same failure as `unavailable`
 * on purpose: the backend suppresses it whenever `unavailable` already explains
 * the shrinkage, so a non-empty list here always means a server went missing
 * with NO version-level explanation — the case that would otherwise read as a
 * clean, quietly smaller environment.
 */
export function assertRunPluginResolutionUsable(
  resolution: RunPluginServerResolution,
  copy: {
    /** How to name this execution in prose — "journey" or "run". */
    surfaceNoun: string;
    /** What the operator should do about it, appended verbatim. */
    remedy: string;
  }
): void {
  const problems = [
    ...resolution.unavailable.map((entry) =>
      describeRunPluginUnavailable(entry, copy.surfaceNoun)
    ),
    ...resolution.droppedSnapshotServerIds.map(
      (id) => `a pinned plugin server (${id}) is no longer provided`
    ),
  ];
  if (problems.length > 0) {
    throw new RunPluginServersUnavailableError(
      `This ${copy.surfaceNoun} pins plugins that can't be used right now: ${problems.join(
        "; "
      )}. ${copy.remedy}`
    );
  }
}

/**
 * The verified server ids, one per row. Each entry must actually carry an id: a
 * malformed row would otherwise map to `undefined` and be handed to the
 * connection manager as a server.
 */
export function readRunPluginServerIds(
  resolution: RunPluginServerResolution,
  unrecognizedMessage: string
): string[] {
  return resolution.servers.map((server) => {
    const serverId = server?.serverId;
    if (typeof serverId !== "string" || serverId.length === 0) {
      throw new RunPluginServersUnavailableError(unrecognizedMessage);
    }
    return serverId;
  });
}

/**
 * Run one D2 query, mapping the undeployed-function rejection to a fail-closed
 * error. A backend that cannot answer must stop the run: we would otherwise be
 * guessing about a capability we are about to hand an agent.
 */
export async function queryRunPluginResolution(
  getConvexClient: () => ConvexHttpClient,
  functionRef: string,
  args: Record<string, unknown>,
  deploySkewMessage: string
): Promise<unknown> {
  try {
    return await getConvexClient().query(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- string
      // function refs are the established inspector→Convex pattern (see
      // services/environments/resolve.ts); there is no codegen here.
      functionRef as any,
      args
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/could not find public function/i.test(message)) {
      throw new RunPluginServersUnavailableError(deploySkewMessage);
    }
    throw error;
  }
}

/**
 * Decision D2 for a SUITE (eval) run — BE-5's
 * `testSuites:resolveRunPluginServersForExecution`.
 *
 * Unlike the journey twin there is no "skip the call when the snapshot pinned
 * nothing" shortcut available to the caller: a suite run's pins live in
 * `configSnapshot.environmentPluginVersions`, which `prepareEvalRun` never
 * reads back. So the query is ALWAYS called for an environment run, and the
 * backend's documented all-clear (`servers: []` with both failure lists empty
 * for a run that pinned no plugins, including every legacy run) is what makes
 * that safe.
 *
 * `allowUndeployedBackend` exists for exactly one caller shape: a NON-environment
 * (legacy host) suite run, which structurally cannot pin a plugin — the
 * environment is the only pin carrier. Calling anyway on a deployment that
 * predates BE-5 would fail every legacy run for a capability it cannot have.
 *
 * Returns the rich rows, not just ids: a caller reports plugin origin per
 * connected server, and re-deriving that from an id would need a second read.
 */
export async function resolveSuiteRunPluginServers(
  getConvexClient: () => ConvexHttpClient,
  args: { runId: string; allowUndeployedBackend?: boolean }
): Promise<RunPluginServer[]> {
  let raw: unknown;
  try {
    raw = await queryRunPluginResolution(
      getConvexClient,
      "testSuites:resolveRunPluginServersForExecution",
      { runId: args.runId },
      "This deployment can't verify this run's pinned plugins yet, so the run was stopped rather than executed without them. Retry after the backend deploys."
    );
  } catch (error) {
    if (
      args.allowUndeployedBackend &&
      error instanceof RunPluginServersUnavailableError
    ) {
      // Only reachable for a run that cannot carry pins at all (see above).
      return [];
    }
    throw error;
  }

  assertRunPluginResolutionShape(
    raw,
    "This run's pinned plugins could not be resolved (unrecognized response). Retry after the backend deploys, or re-run the suite."
  );
  assertRunPluginResolutionUsable(raw, {
    surfaceNoun: "run",
    remedy: "Update the environment's plugin pins and re-run the suite.",
  });
  readRunPluginServerIds(
    raw,
    "This run's pinned plugins resolved to an unrecognized server entry. Retry after the backend deploys, or re-run the suite."
  );
  return raw.servers;
}
