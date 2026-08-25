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
   *
   * Optional for deploy skew, like the fields above — an older backend omits
   * it, which is exactly the case `environmentServerIds` /
   * `environmentServerNames` fall back for. `resolveEnvironmentForLaunch` does
   * NOT require it, so typing it required would give a caller that dereferences
   * `.servers` directly a false guarantee. Note the distinction those helpers
   * turn on: ABSENT means fall back, present-but-`[]` is a real answer.
   */
  servers?: Array<{ serverId: string; name: string }>;
  serverAttachmentId?: string | null;
  /**
   * The environment's pinned computer image, when it pins one. The backend
   * returns it; DECLARED here because a harness run requires a pinned image
   * and the admission gate has to distinguish "this environment pins none"
   * from "nobody looked". An undeclared field survives the cast this module
   * does today, but only by accident — the next reader adding a projection
   * would drop it silently.
   */
  computerEnvironmentId?: string;
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
 * The 409 for an environment that cannot name a model to run, or null when
 * `error` is something else.
 *
 * The backend refuses a headless launch whose environment resolves to no model
 * — no override on the environment, none pinned on its client — with a
 * structured `ENV_MODEL_REQUIRED`. Untranslated, that reaches an eval caller as
 * a bare Convex rejection, which reads as an internal fault rather than as the
 * one-field misconfiguration it is.
 *
 * Shaped to match the v1 environments resolve route byte for byte (`code` +
 * the backend's `details` + a stable `reason` slug), so a caller branching on
 * `details.reason` gets the same answer whichever surface refused it. Returns
 * null rather than throwing so call sites read as one line next to the other
 * translations.
 */
/**
 * Every OTHER structured refusal `startTestSuiteRun` can raise before it
 * creates anything: a bad `ephemeralEnvironment` request, an environment that
 * is not a suite member, an ambiguous multi-environment launch, and the
 * resolver's own cross-project / archived / missing verdicts.
 *
 * Without this they reach the caller as `500 "Server Error"`. The backend
 * deliberately raises `ConvexError` for these so the reason SURVIVES
 * production redaction — Convex redacts a plain `Error`'s message and keeps a
 * `ConvexError`'s data — and then the launch path threw the whole thing away
 * by rethrowing it raw into the generic handler. Converting the throw and not
 * translating it buys nothing: the caller still cannot tell "you named an
 * environment this suite does not have" from "the server broke".
 *
 * Codes, not prose: the message is the backend's and is forwarded verbatim,
 * but the branch is on `code`, so rewording a backend message cannot silently
 * change which status a caller sees.
 *
 * Returns null for anything unrecognized, so a genuinely unknown failure stays
 * a logged 500 rather than being relabelled as the caller's mistake.
 */
const LAUNCH_REJECTION_STATUS: Record<string, 400 | 404> = {
  // Malformed request: the argument combination cannot mean anything.
  VALIDATION: 400,
  // Named an environment the suite does not have, or named none when the
  // suite has several. Both are fixable by the caller, and naming the id back
  // reveals nothing they did not already send.
  ENV_NOT_A_MEMBER: 400,
  ENV_AMBIGUOUS: 400,
  // Archived is a state the caller can see and undo; cross-project and
  // not-found both answer 404, so a probe cannot use this route to learn
  // whether an id exists in someone else's project.
  ENV_ARCHIVED: 400,
  ENV_CROSS_PROJECT: 404,
  ENV_NOT_FOUND: 404,
};

export function environmentLaunchRejectionError(
  error: unknown
): WebRouteError | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const code = typeof record.code === "string" ? record.code : undefined;
  if (!code) return null;
  const status = LAUNCH_REJECTION_STATUS[code];
  if (!status) return null;
  // The 404s collapse ENTIRELY — one message, one code, one reason, no backend
  // details — because collapsing only the STATUS does not collapse anything a
  // caller reads. Forwarding "Environment belongs to a different project"
  // under `ENV_CROSS_PROJECT` next to "Environment not found" under
  // `ENV_NOT_FOUND` lets someone submit an arbitrary id and learn which
  // project it lives in, which is the enumeration answering 404 was meant to
  // prevent, reintroduced one field lower. Matches how the shared Convex
  // translator answers every 404: the resource noun, and nothing else.
  if (status === 404) {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, "Environment not found", {
      code: "ENV_NOT_FOUND",
      reason: "env_not_found",
    });
  }
  const message =
    typeof record.message === "string" && record.message.trim()
      ? record.message
      : "This eval run could not be started as requested.";
  const details =
    record.details &&
    typeof record.details === "object" &&
    !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : {};
  return new WebRouteError(status, ErrorCode.VALIDATION_ERROR, message, {
    code,
    ...details,
    reason: code.toLowerCase(),
  });
}

export function environmentModelRequiredError(
  error: unknown
): WebRouteError | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (record.code !== "ENV_MODEL_REQUIRED") return null;
  const message =
    typeof record.message === "string" && record.message.trim()
      ? record.message
      : "This environment has no model to run. Set a model on the environment, or pin one on its client.";
  const details =
    record.details && typeof record.details === "object" &&
    !Array.isArray(record.details)
      ? (record.details as Record<string, unknown>)
      : {};
  return new WebRouteError(409, ErrorCode.CONFLICT, message, {
    code: "ENV_MODEL_REQUIRED",
    ...details,
    reason: "environment_model_required",
  });
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
