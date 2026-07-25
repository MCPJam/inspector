/**
 * Decision D2 — execution-time re-gate for a journey target's pinned plugin
 * servers.
 *
 * A journey run snapshot stores the servers an environment's pinned plugins
 * contributed in `hosts[].pluginServerIds`, deliberately as a SIBLING of
 * `serverIds` rather than merged into it. The snapshot is immutable and written
 * with no scope validation, so a plugin-materialized id living inside
 * `serverIds` would be a permanent grant — a re-run would reconnect an
 * uninstalled plugin forever. That is exactly the lifecycle bypass the backend's
 * `plugin_component` guards exist to stop.
 *
 * So the stored list is a record of what was PINNED, never of what may still
 * run. This module asks the backend that second question, at the moment we
 * connect, via `journeyRuns:resolveJourneyRunPluginServersForExecution` — which
 * re-resolves the live plugin on every call. Disable or uninstall the plugin
 * and the answer changes, with no snapshot rewrite.
 *
 * FAIL CLOSED IS THE WHOLE POINT. Every path that cannot produce a verified
 * list throws rather than returning `[]`: a target that connects a shrunken
 * server set runs an environment nobody configured, and does it silently. "I
 * couldn't check" must never be delivered as "nothing to add".
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

interface RunPluginServerUnavailable {
  pluginVersionId: string;
  reason: string;
  pluginName?: string;
  componentKey?: string;
}

interface JourneyRunPluginServerResolution {
  targets: Array<{
    targetId?: string;
    servers: RunPluginServer[];
    unavailable: RunPluginServerUnavailable[];
    droppedSnapshotServerIds: string[];
  }>;
}

/** Thrown when a target's pins cannot be verified as still-connectable. */
export class JourneyPluginServersUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JourneyPluginServersUnavailableError";
  }
}

function describeUnavailable(entry: RunPluginServerUnavailable): string {
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
      return `"${who}" provides a server that can't run in a hosted journey`;
    case "unresolvable_scope":
      return `"${who}" could not be resolved in this project`;
    default:
      return `"${who}" is unavailable (${entry.reason})`;
  }
}

/**
 * The server ids ONE journey target may connect from its pinned plugins.
 *
 * `snapshotPluginServerIds` is the target's stored list. When it is empty the
 * target pinned no server-bearing plugin (or predates the field) and we return
 * `[]` WITHOUT calling Convex — that keeps every plugin-free journey working
 * against a backend that has not deployed the D2 query yet. Once the snapshot
 * does name plugin servers the query becomes mandatory, and a backend that
 * can't answer it is a hard failure: we would otherwise be guessing about a
 * capability we are about to hand an agent.
 */
export async function resolveTargetPluginServerIds(
  convexClient: ConvexHttpClient,
  args: {
    runId: string;
    targetId?: string;
    snapshotPluginServerIds?: string[];
  }
): Promise<string[]> {
  const pinned = args.snapshotPluginServerIds ?? [];
  if (pinned.length === 0) return [];

  if (!args.targetId) {
    // `pluginServerIds` and `targetId` are both fresh-run fields, so a snapshot
    // carrying one without the other is malformed rather than legacy. Resolving
    // without a target id would silently answer for EVERY target.
    throw new JourneyPluginServersUnavailableError(
      "This journey target pins plugin servers but has no target id, so its plugins can't be verified. Re-launch the journey."
    );
  }

  let raw: unknown;
  try {
    raw = await convexClient.query(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- string
      // function refs are the established inspector→Convex pattern (see
      // services/evals/environment-launch.ts); there is no codegen here.
      "journeyRuns:resolveJourneyRunPluginServersForExecution" as any,
      { runId: args.runId, targetId: args.targetId }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/could not find public function/i.test(message)) {
      throw new JourneyPluginServersUnavailableError(
        "This deployment can't verify pinned plugins yet, so the journey was stopped rather than run without them. Retry after the backend deploys."
      );
    }
    throw error;
  }

  const resolution = raw as JourneyRunPluginServerResolution | null;
  // `null` is the backend's "no answer" (run gone, or this target isn't in the
  // run) — deliberately NOT the same shape as "no plugins".
  if (!resolution || !Array.isArray(resolution.targets)) {
    throw new JourneyPluginServersUnavailableError(
      "This journey run's pinned plugins could not be resolved. Re-launch the journey."
    );
  }
  const target = resolution.targets[0];
  if (!target) {
    throw new JourneyPluginServersUnavailableError(
      "This journey target's pinned plugins could not be resolved. Re-launch the journey."
    );
  }

  const problems = [
    ...(target.unavailable ?? []).map(describeUnavailable),
    ...(target.droppedSnapshotServerIds ?? []).map(
      (id) => `a pinned plugin server (${id}) is no longer provided`
    ),
  ];
  if (problems.length > 0) {
    throw new JourneyPluginServersUnavailableError(
      `This journey pins plugins that can't be used right now: ${problems.join(
        "; "
      )}. Update the environment's plugin pins and re-launch.`
    );
  }

  return (target.servers ?? []).map((server) => server.serverId);
}
