/**
 * Project-environment launch resolution for eval suite runs (backend P0.1).
 *
 * An environment run never trusts browser-supplied server ids: the backend's
 * member-read query `projectEnvironments:resolveEnvironmentForLaunch` returns
 * the closed execution preview for ONE environment revision, and
 * `startTestSuiteRun` re-checks that revision (`expectedEnvironmentRevision`)
 * before inserting any run row — so a tool snapshot from one revision can
 * never pair with a Convex run snapshot from another.
 *
 * Hand-mirrored contract (no codegen; string function refs like the rest of
 * the inspector→Convex surface).
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
  hostConfigId?: string;
  /** The raw closed server selection (Convex server ids) — do not substitute. */
  selectedServerIds: string[];
  /**
   * Live-healed connectable projection of `selectedServerIds`: each id healed
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
 * and matches the batch we connect) and fall back to the raw closed set only
 * when the backend omits the healed projection.
 */
export function environmentServerIds(
  resolved: ResolvedEnvironmentForLaunch
): string[] {
  return resolved.servers && resolved.servers.length > 0
    ? resolved.servers.map((s) => s.serverId)
    : resolved.selectedServerIds;
}

/**
 * Display names aligned by index with {@link environmentServerIds}, for the
 * manager's `serverNames` projection. Empty when the backend omits the healed
 * projection (the manager then falls back to showing the server id).
 */
export function environmentServerNames(
  resolved: ResolvedEnvironmentForLaunch
): string[] {
  return resolved.servers && resolved.servers.length > 0
    ? resolved.servers.map((s) => s.name)
    : [];
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
 * True when a `startTestSuiteRun` rejection is the backend's structured
 * `expectedEnvironmentRevision` mismatch. Matched on the ConvexError data
 * code with a message fallback (wire-tolerant across backend renames).
 */
export function isEnvironmentRevisionConflict(error: unknown): boolean {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object") {
    const code = (data as { code?: unknown }).code;
    if (code === "ENV_REVISION_CONFLICT" || code === "CONFLICT") return true;
  }
  const message =
    typeof data === "string"
      ? data
      : error instanceof Error
      ? error.message
      : "";
  return /environment/i.test(message) && /revision|conflict/i.test(message);
}

/** The readable 409 interactive callers surface for a revision conflict. */
export function environmentRevisionConflictError(): WebRouteError {
  return new WebRouteError(
    409,
    ErrorCode.ENVIRONMENT_REVISION_CONFLICT,
    "Environment changed — retry the run."
  );
}
