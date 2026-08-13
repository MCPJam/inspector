/**
 * One translator from a Convex write failure to a v1 HTTP error.
 *
 * Every write router grew its own near-copy of this — `hosts.ts`, `images.ts`,
 * `environments.ts`, and (before this module) the new `projects.ts` and
 * `servers.ts`. Five copies meant five different answers to the same question:
 * whether a permission failure is a 403 or a 404, whether a Convex timeout is
 * reported to the caller as bad input, and how much of Convex's own error prose
 * leaks into a public response.
 *
 * The rules, in one place:
 *
 *   - **Structured first.** A backend mutation raising
 *     `ConvexError({ code, message })` is authoritative: CONFLICT → 409,
 *     VALIDATION → 400, NOT_FOUND → 404, FORBIDDEN → see below. Prose sniffing
 *     is the mixed-version fallback for a deployment that predates the
 *     structured throw, not the primary path.
 *   - **FORBIDDEN answers 404 unless it is explicitly about admin rights.**
 *     Telling an outsider "you are not an admin here" confirms the resource
 *     exists. Only a message that names the admin requirement — which the caller
 *     can only reach if they are already a member — earns a 403.
 *   - **Infrastructure failures are 5xx.** A timeout or a reset socket is not
 *     the caller's bad input; those defer to `mapRuntimeError` so a transient
 *     outage is not reported as a validation error.
 *   - **Convex's prose is scrubbed** of `[Request ID: …]`, `Server Error` and
 *     `Uncaught ConvexError:` before it can reach a public response body.
 *
 * `resource` names what the caller was addressing, so a not-found reads
 * "Server not found" rather than every router borrowing whichever noun the
 * copy it was forked from happened to use.
 */
import { ErrorCode, WebRouteError, mapRuntimeError } from "../web/errors.js";

type ConvexErrorData = { code?: unknown; message?: unknown };

function convexErrorData(error: unknown): ConvexErrorData | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as ConvexErrorData;
}

/** Strip Convex's own framing so it cannot reach a public response body. */
function cleanConvexMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\[Request ID:[^\]]*\]\s*/g, "")
    .replace(/^Server Error\s*/i, "")
    .replace(/Uncaught (Error|ConvexError):\s*/i, "")
    .split("\n")[0]!
    .trim();
}

export interface TranslateConvexWriteErrorOptions {
  /** The noun for not-found copy — "Server", "Project", "Host". */
  resource: string;
  /** Message for a 400 when nothing more specific is available. */
  fallbackMessage?: string;
  /** Copy for a 404 that may equally be a missing parent or no access. */
  notFoundMessage?: string;
  /** Copy for a 409 when the backend sent none. */
  conflictMessage?: string;
  /**
   * Whether an admin-gate failure may answer 403 (default) or must collapse
   * into the same neutral 404 as everything else.
   *
   * Genuinely per-resource, not a style choice. Environments SURFACE the admin
   * gate: you are already a member, so "requires admin" tells you something
   * actionable and reveals nothing you could not see. Sandbox images HIDE it:
   * their gate also guards shared environments, and there a 403 would confirm
   * the resource exists to somebody who cannot otherwise see it. When in doubt
   * leave it hidden.
   */
  adminFailureIsForbidden?: boolean;
}

export function translateConvexWriteError(
  error: unknown,
  options: TranslateConvexWriteErrorOptions
): WebRouteError {
  // A route that already decided (a project-scope guard, a bad body) wins.
  if (error instanceof WebRouteError) return error;

  const {
    resource,
    fallbackMessage = `${resource} write rejected by the platform`,
    notFoundMessage = `${resource} not found`,
    conflictMessage = `${resource} changed since you loaded it.`,
    adminFailureIsForbidden = true,
  } = options;

  const data = convexErrorData(error);
  const code = typeof data?.code === "string" ? data.code : undefined;
  const structuredMessage =
    typeof data?.message === "string" ? data.message : undefined;

  // The `sandboxes-enabled` beta gate (mcpjam-backend lib/sandboxesGate.ts).
  //
  // Handled BEFORE the generic branches, and given a real 403 with the real
  // message, because the default treatment would be actively misleading: the
  // gate throws a ConvexError whose `code` would otherwise fall through to
  // the FORBIDDEN branch below, which collapses to 404 so a non-member cannot
  // probe for existence. That rule is right for membership and wrong here — a
  // flagged-off customer would be told their own project does not exist,
  // rather than that a feature is not available to them yet.
  //
  // The message is the backend's, forwarded verbatim: it is already
  // customer-facing, already feature-parameterized ("Swarms" vs "User
  // testing"), and re-writing it here would create a second place to keep
  // that copy correct.
  if (code === "FEATURE_UNAVAILABLE") {
    return new WebRouteError(
      403,
      // FORBIDDEN, not FEATURE_NOT_SUPPORTED, and the distinction is not
      // cosmetic: the canonical contract maps FEATURE_NOT_SUPPORTED to **422**
      // (unprocessable content), which describes a malformed request. This is
      // a well-formed request the server refuses to authorize for this
      // organization — 403, exactly what FORBIDDEN means. What makes it safe to
      // reuse the code here is that this branch runs BEFORE the generic
      // FORBIDDEN one, so it keeps the real message and its 403 instead of
      // being collapsed into the neutral 404.
      ErrorCode.FORBIDDEN,
      structuredMessage ??
        "This feature is not available for your organization."
    );
  }

  // ── Billing gates (mcpjam-backend lib/entitlements.ts) ──────────────────
  //
  // These arrive as ConvexErrors whose `code` is one of the `billing_*`
  // literals, and without these branches every one of them falls through to
  // the generic 400 at the bottom — a plan limit reported as a malformed
  // request, which tells a caller to fix their input when the input was fine.
  //
  // The split matters as much as the mapping. A DAILY LIMIT is a 429: wait, or
  // stop asking so often. A FEATURE NOT IN THE PLAN is a 403: waiting will
  // never help, and someone has to change the plan. Collapsing them would send
  // a customer who hit today's insight cap to a sales page for a plan they
  // already have — the shared `insightsPerDay` ledger makes that reachable on
  // an ordinary Tuesday, from either the swarms or the user-testing surface.
  if (code === "billing_limit_reached") {
    return new WebRouteError(
      429,
      ErrorCode.RATE_LIMITED,
      structuredMessage ?? "Plan limit reached."
    );
  }
  if (code === "billing_feature_not_included") {
    return new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      structuredMessage ?? "This feature is not included in your plan."
    );
  }

  if (code === "CONFLICT") {
    return new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      structuredMessage ?? conflictMessage
    );
  }
  if (code === "VALIDATION") {
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      structuredMessage ?? fallbackMessage
    );
  }
  if (code === "NOT_FOUND") {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, notFoundMessage);
  }
  if (code === "FORBIDDEN") {
    if (
      adminFailureIsForbidden &&
      structuredMessage &&
      /admin/i.test(structuredMessage)
    ) {
      return new WebRouteError(403, ErrorCode.FORBIDDEN, structuredMessage);
    }
    return new WebRouteError(404, ErrorCode.NOT_FOUND, notFoundMessage);
  }

  // ── Mixed-version fallbacks: a deployment that still throws prose. ────────
  const raw = error instanceof Error ? error.message : String(error);
  if (/already exists|name conflict|duplicate/i.test(raw)) {
    return new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      cleanConvexMessage(error)
    );
  }
  if (/not found|unauthorized|not a member/i.test(raw)) {
    return new WebRouteError(404, ErrorCode.NOT_FOUND, notFoundMessage);
  }
  if (
    /requires admin|only .* admins|insufficient .* permissions|cannot manage/i.test(
      raw
    )
  ) {
    return adminFailureIsForbidden
      ? new WebRouteError(403, ErrorCode.FORBIDDEN, cleanConvexMessage(error))
      : new WebRouteError(404, ErrorCode.NOT_FOUND, notFoundMessage);
  }
  if (
    /timed out|timeout|fetch failed|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(
      raw
    )
  ) {
    return mapRuntimeError(error);
  }

  return new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    cleanConvexMessage(error) || fallbackMessage
  );
}
