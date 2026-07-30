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
 * The shape validation, the reason-code prose, and the "which problems mean
 * stop?" rule now live in `services/plugins/run-plugin-servers.ts`, shared with
 * the suite twin BE-5 added. Only the journey-shaped envelope (`{ targets: [] }`,
 * with a per-target id to cross-check) and the journey wording are here.
 *
 * Hand-mirrored contract (no codegen; string function refs like the rest of the
 * inspector→Convex surface).
 */
import type { ConvexHttpClient } from "convex/browser";
import {
  RunPluginServersUnavailableError,
  assertRunPluginResolutionShape,
  assertRunPluginResolutionUsable,
  queryRunPluginResolution,
  readRunPluginServerIds,
  type RunPluginServer,
  type RunPluginServerResolution,
} from "../plugins/run-plugin-servers.js";

interface JourneyRunPluginServerResolution {
  targets: Array<Partial<RunPluginServerResolution> & { targetId?: string }>;
}

/**
 * Thrown when a target's pins cannot be verified as still-connectable.
 *
 * Extends the shared error so a caller may catch either, and every shared throw
 * is re-wrapped into it below so journey callers keep seeing exactly one type.
 */
export class JourneyPluginServersUnavailableError extends RunPluginServersUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "JourneyPluginServersUnavailableError";
  }
}

/** Re-wrap a shared-core failure without altering its (journey-worded) message. */
function asJourneyError(error: unknown): unknown {
  if (
    error instanceof RunPluginServersUnavailableError &&
    !(error instanceof JourneyPluginServersUnavailableError)
  ) {
    return new JourneyPluginServersUnavailableError(error.message);
  }
  return error;
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
  /**
   * Lazily supplies the Convex client — a THUNK, not a client, on purpose.
   * `createConvexClient` throws when `CONVEX_URL` is unset, and this runs after
   * the journey run row already exists, where a throw would orphan a durable
   * run with no runner. Taking a thunk keeps the "no pins ⇒ no client" decision
   * in ONE place (the early return below) instead of duplicating it at the
   * callsite where it could drift.
   */
  getConvexClient: () => ConvexHttpClient,
  args: {
    runId: string;
    targetId?: string;
    snapshotPluginServerIds?: string[];
  }
): Promise<string[]> {
  return (await resolveTargetPluginServers(getConvexClient, args)).map(
    (server) => server.serverId
  );
}

/**
 * The same re-gate, returning the RICH rows (plugin id / version / name /
 * component key) rather than bare ids. Internal for now: the journey connect
 * path needs only the ids, and a synthetic session's plugin provenance is
 * derived server-side by Convex from the run snapshot (BE-5), never sent up
 * from here.
 */
async function resolveTargetPluginServers(
  getConvexClient: () => ConvexHttpClient,
  args: {
    runId: string;
    targetId?: string;
    snapshotPluginServerIds?: string[];
  }
): Promise<RunPluginServer[]> {
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

  try {
    const raw = (await queryRunPluginResolution(
      getConvexClient,
      "journeyRuns:resolveJourneyRunPluginServersForExecution",
      { runId: args.runId, targetId: args.targetId },
      "This deployment can't verify pinned plugins yet, so the journey was stopped rather than run without them. Retry after the backend deploys."
    )) as JourneyRunPluginServerResolution | null;

    // `null` is the backend's "no answer" (run gone, or this target isn't in
    // the run) — deliberately NOT the same shape as "no plugins".
    if (!raw || !Array.isArray(raw.targets)) {
      throw new JourneyPluginServersUnavailableError(
        "This journey run's pinned plugins could not be resolved. Re-launch the journey."
      );
    }
    const target = raw.targets[0];
    const unrecognized =
      "This journey target's pinned plugins could not be resolved (unrecognized response). Retry after the backend deploys, or re-launch the journey.";
    assertRunPluginResolutionShape(target, unrecognized);

    // A response for a DIFFERENT target would apply the wrong plugin set to
    // this one. The backend echoes `targetId`; when it does, it must match.
    const echoedTargetId = (target as { targetId?: string }).targetId;
    if (echoedTargetId !== undefined && echoedTargetId !== args.targetId) {
      throw new JourneyPluginServersUnavailableError(
        "This journey target's pinned plugins resolved against a different target. Re-launch the journey."
      );
    }

    assertRunPluginResolutionUsable(target, {
      surfaceNoun: "journey",
      remedy: "Update the environment's plugin pins and re-launch.",
    });
    readRunPluginServerIds(
      target,
      "This journey target's pinned plugins resolved to an unrecognized server entry. Retry after the backend deploys, or re-launch the journey."
    );
    return target.servers;
  } catch (error) {
    throw asJourneyError(error);
  }
}
