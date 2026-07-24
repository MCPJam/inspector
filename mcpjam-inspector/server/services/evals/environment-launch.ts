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
  hostConfigId?: string;
  /** The closed server selection (Convex projectServer ids). */
  selectedServerIds: string[];
  /** Stable runtime server names for the same selection (wire-tolerant). */
  selectedServerNames?: string[];
  serverAttachmentId?: string | null;
}

/**
 * Runtime server refs for manager connection / eval execution: the eval
 * pipeline keys managers by runtime server NAME, so prefer the name
 * projection and fall back to ids when the backend omits it.
 */
export function environmentServerRefs(
  resolved: ResolvedEnvironmentForLaunch
): string[] {
  return resolved.selectedServerNames && resolved.selectedServerNames.length > 0
    ? resolved.selectedServerNames
    : resolved.selectedServerIds;
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
