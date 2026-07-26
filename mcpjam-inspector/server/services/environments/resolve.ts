/**
 * Project-environment launch resolution (reproducibility surfaces).
 *
 * An environment run never trusts browser-supplied server ids: the backend's
 * member-read query `projectEnvironments:resolveEnvironmentForLaunch` returns
 * the closed execution preview for ONE environment revision, and
 * `startTestSuiteRun` re-checks that revision plus the resolved host config and
 * effective server set (the `expectedEnvironment*` echoes) before inserting any
 * run row. So a tool snapshot from one revision can never pair with a Convex
 * run snapshot from another, AND a host-config rotation or attachment edit at
 * an UNCHANGED revision is caught as drift instead of silently executed.
 *
 * This module is target-agnostic — it lives under `services/environments/`,
 * not `services/evals/`, because eval launches and any future reproducibility
 * surface share it. Interactive per-turn resolution is a different contract
 * (live, override-aware) and belongs in a sibling runtime service, not here.
 *
 * Hand-mirrored contract (no codegen; string function refs like the rest of
 * the inspector→Convex surface) and deliberately deploy-skew tolerant: fields a
 * newer backend added are optional here so an older backend still parses.
 */
import type { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

export interface ResolvedEnvironmentForLaunch {
  environmentRef: {
    environmentId: string;
    name: string;
    revision: number;
  };
  hostId: string;
  hostName?: string;
  /**
   * The host's CURRENT config at resolve time, echoed back as
   * `expectedEnvironmentHostConfigId`. An environment pins a `hostId`, never a
   * config, so a host rotation drifts this preview at an unchanged revision —
   * the revision alone does not make a launch atomic.
   */
  hostConfigId?: string;
  /** The raw closed NON-PLUGIN server selection (Convex ids) — do not substitute. */
  selectedServerIds: string[];
  /**
   * `selectedServerIds` plus the servers contributed by the environment's
   * pinned plugin VERSIONS — the set a run actually connects, and the one
   * echoed back as `expectedEnvironmentServerIds`. Identical to
   * `selectedServerIds` when the environment pins no plugins.
   *
   * Optional for deploy skew only (an older backend omits it); callers fall
   * back to `selectedServerIds`.
   */
  effectiveServerIds?: string[];
  /**
   * Identity + `bundleHash` of every resolved plugin pin, in pin order — the
   * same rows the run snapshot records as
   * `configSnapshot.environmentPluginVersions`.
   */
  pluginVersions?: Array<{
    pluginId: string;
    pluginVersionId: string;
    name: string;
    bundleHash: string;
  }>;
  /**
   * Live-healed connectable projection of `effectiveServerIds`: each id healed
   * to its current live server (delete + re-add-same-name), genuinely-gone
   * servers dropped, deduped by live id, in selection order.
   */
  servers: Array<{ serverId: string; name: string }>;
  serverAttachmentId?: string | null;
}

/**
 * Server IDs for manager priming / connection / lookup. The eval manager keys
 * every server by its Convex server ID (`createAuthorizedManager` →
 * `effectiveAuthByServerId`), so both the manager batch and
 * `resolveServerIdsOrThrow` must use IDs, never names. Prefer the live-healed
 * `servers[].serverId` (delete + re-add-same-name resolves to the current id
 * and matches the batch we connect).
 *
 * PRESENCE, not length, selects the healed projection. A present `[]` is a real
 * answer — every stored edge was genuinely removed during live healing — and
 * must stay empty; treating it as "missing" would resurrect the stored ids and
 * connect servers the environment no longer resolves to. Only a backend that
 * omits the field entirely (deploy skew) falls through, and then to
 * `effectiveServerIds` before `selectedServerIds`, because the latter excludes
 * plugin-contributed servers.
 */
export function environmentServerIds(
  resolved: ResolvedEnvironmentForLaunch
): string[] {
  return Array.isArray(resolved.servers)
    ? resolved.servers.map((s) => s.serverId)
    : resolved.effectiveServerIds ?? resolved.selectedServerIds;
}

/**
 * Display names aligned by index with {@link environmentServerIds}, for the
 * manager's `serverNames` projection. Empty when the backend omits the healed
 * projection (the manager then falls back to showing the server id).
 */
export function environmentServerNames(
  resolved: ResolvedEnvironmentForLaunch
): string[] {
  return Array.isArray(resolved.servers)
    ? resolved.servers.map((s) => s.name)
    : [];
}

/**
 * The effective server set to echo as `expectedEnvironmentServerIds`. This is
 * the STORED closed set the backend compares against, so it is deliberately
 * NOT the live-healed projection: the backend's drift check re-derives the same
 * stored set, and echoing healed ids would read as drift on any server that had
 * been delete-and-re-added. Falls back for deploy skew.
 */
export function environmentEffectiveServerIds(
  resolved: ResolvedEnvironmentForLaunch
): string[] {
  return resolved.effectiveServerIds ?? resolved.selectedServerIds;
}

export async function resolveEnvironmentForLaunch(
  convexClient: ConvexHttpClient,
  args: { projectId: string; environmentId: string }
): Promise<ResolvedEnvironmentForLaunch> {
  let raw: unknown;
  try {
    raw = await convexClient.query(
      "projectEnvironments:resolveEnvironmentForLaunch" as any,
      args
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/could not find public function/i.test(message)) {
      // Deploy-order skew: the P0.1 backend contract isn't deployed yet.
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "This deployment cannot resolve project environments yet. Retry after the backend deploys."
      );
    }
    throw error;
  }
  const resolved = raw as ResolvedEnvironmentForLaunch | null;
  if (
    !resolved ||
    !resolved.environmentRef ||
    typeof resolved.environmentRef.revision !== "number" ||
    !Array.isArray(resolved.selectedServerIds)
  ) {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "Environment not found (it may have been archived). Update the suite's environments and retry."
    );
  }
  return resolved;
}

/**
 * True when a `startTestSuiteRun` rejection is one of the backend's structured
 * environment preconditions failing — either the revision moved
 * (`ENV_REVISION_CONFLICT`) or the environment resolved differently at an
 * unchanged revision (`ENV_HOST_DRIFT`: the host rotated its config, or the
 * pinned attachment's server set changed). Both mean the same thing to a
 * caller — the run we prepared is not the run we would have started — so both
 * map to the same 409.
 *
 * Matched on the ConvexError data code with a message fallback (wire-tolerant
 * across backend renames).
 */
export function isEnvironmentLaunchConflict(error: unknown): boolean {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object") {
    const code = (data as { code?: unknown }).code;
    if (
      code === "ENV_REVISION_CONFLICT" ||
      code === "ENV_HOST_DRIFT" ||
      code === "CONFLICT"
    ) {
      return true;
    }
  }
  const message =
    typeof data === "string"
      ? data
      : error instanceof Error
      ? error.message
      : "";
  return (
    /environment/i.test(message) && /revision|conflict|drift/i.test(message)
  );
}

/** Which precondition failed, for a message that names the actual cause. */
function environmentConflictKind(error: unknown): "drift" | "revision" {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object") {
    if ((data as { code?: unknown }).code === "ENV_HOST_DRIFT") return "drift";
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /drift/i.test(message) ? "drift" : "revision";
}

/**
 * The readable 409 interactive callers surface. Drift gets its own wording
 * because the fix is different: a revision conflict means someone edited the
 * environment, while drift means the environment is unchanged but what it
 * points AT moved (host config rotated, or the pinned server group was
 * edited) — telling a user to "reload the environment" would be misleading.
 */
export function environmentLaunchConflictError(error?: unknown): WebRouteError {
  const message =
    error !== undefined && environmentConflictKind(error) === "drift"
      ? "This environment's host or server group changed while the run was being prepared — retry the run."
      : "Environment changed — retry the run.";
  return new WebRouteError(
    409,
    ErrorCode.ENVIRONMENT_REVISION_CONFLICT,
    message
  );
}
