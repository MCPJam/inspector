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
 *   - **An unrecognized failure is a 500, and it is logged.** Everything above
 *     is a recognized outcome; what falls past all of it is a write path we do
 *     not understand, which is ours. It used to answer 400 with Convex's prose
 *     and no log at all — a broken write path reporting itself as the caller's
 *     mistake, below every 5xx monitor and invisible in Sentry.
 *   - **Convex's prose is scrubbed** of `[Request ID: …]`, `Server Error` and
 *     `Uncaught ConvexError:` before it can reach a public response body, and
 *     is not forwarded at all on the 500.
 *
 * `resource` names what the caller was addressing, so a not-found reads
 * "Server not found" rather than every router borrowing whichever noun the
 * copy it was forked from happened to use.
 */
import { ErrorCode, WebRouteError, mapRuntimeError } from "../web/errors.js";
import { logger } from "../../utils/logger.js";
import { redactForLog } from "./redact-log-message.js";

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
  /**
   * Copy for the two cases with no better wording: a structured `VALIDATION`
   * throw that carried no message (400), and the terminal unrecognized-failure
   * branch (500). Keep it neutral about fault — it is the only thing the caller
   * sees in both, and the second one is ours, not theirs.
   */
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

/**
 * The actionable fields off a billing ConvexError, forwarded as `details`.
 *
 * `limit` says WHICH cap, `plan` and `upgradePlan` say what would lift it, and
 * `currentValue`/`allowedValue` say by how much. Without them a caller gets
 * "Plan limit reached" and has to guess — and an agent has nothing to tell a
 * human beyond that something is capped.
 *
 * Copied field by field rather than passed through: the payload is the
 * backend's internal error shape, and spreading it would publish whatever it
 * gains next without anyone deciding to.
 */
function billingDetails(
  data: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const details: Record<string, unknown> = {};
  for (const key of [
    "limit",
    "gateKey",
    "plan",
    "upgradePlan",
    "currentValue",
    "allowedValue",
  ]) {
    if (data[key] !== undefined) details[key] = data[key];
  }
  return Object.keys(details).length > 0 ? details : undefined;
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
  // See `billingDetails` below for what travels with them.
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
      structuredMessage ?? "Plan limit reached.",
      // The backend's payload names the cap, the plan and the upgrade target.
      // Dropping it leaves a caller with "Plan limit reached" and no way to
      // say WHICH limit or what to do about it.
      billingDetails(data as Record<string, unknown> | null)
    );
  }
  if (code === "billing_feature_not_included") {
    return new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      structuredMessage ?? "This feature is not included in your plan.",
      billingDetails(data as Record<string, unknown> | null)
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

  // ── Nothing recognized it. That is OUR bug, and it answers 500. ──────────
  //
  // This used to be a 400 VALIDATION_ERROR carrying Convex's prose, which got
  // the reporting exactly backwards. Every branch above is a recognized
  // outcome: a structured `ConvexError` code, or one of the prose shapes a
  // mixed-version deployment still throws. An error that matches NONE of them
  // is a write path we do not understand — a mutation throwing a new code, a
  // renamed or undeployed function, a broken deploy — and none of those are
  // the caller's malformed input.
  //
  // Reporting them as 400 was invisible twice over: no 5xx monitor counts a
  // 400, and this function had no logger at all, so a wholly broken write path
  // could answer "your request was invalid" to every caller and emit nothing
  // anywhere. 500 puts it back in the range the monitors watch, and the log
  // line below is what names it once it is there.
  //
  // The message stops being forwarded for the same reason the read translator
  // never forwards its upstream text: it is written for us, it can carry
  // function names, argument-validator output with the arguments in it, and
  // request ids — a free read of our internals for anyone who can reach the
  // route. The detail goes to the log; the caller gets the route's own copy.
  // `logger.warn`, NOT `logger.error`, and the difference is one Sentry event
  // rather than two. Every caller THROWS the `WebRouteError` this returns, so
  // `v1OnError` maps it — 500 + INTERNAL_ERROR, exactly what the
  // `mcpjam_internal` boundary promotes — and captures it there. A
  // `logger.error` here would capture a *different* object (the redacted
  // Error) which carries no stamp of its own, so the same failure would arrive
  // in Sentry twice, under two fingerprints. This log is the Axiom record; the
  // capture belongs to the envelope that owns the boundary declaration.
  //
  // The detail goes under `detail`, not `message`: `ingestToAxiom` spreads the
  // context and THEN sets `message` from its first argument, so a `message`
  // key here would be silently overwritten and the diagnosis lost.
  logger.warn(`[v1.convexWrite] unrecognized ${resource} write failure`, {
    resource,
    detail: redactForLog(error),
  });
  return new WebRouteError(500, ErrorCode.INTERNAL_ERROR, fallbackMessage);
}
