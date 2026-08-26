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
 *   - **`kind: 'forbidden'` is a TIER denial and answers 403.** A different
 *     shape from the `FORBIDDEN` code above, raised only once membership has
 *     already resolved, so hiding it behind a 404 would tell a legitimate
 *     member their own resource does not exist. Still subject to
 *     `adminFailureIsForbidden` for the resources that deliberately hide their
 *     gate.
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

type ConvexErrorData = {
  code?: unknown;
  message?: unknown;
  kind?: unknown;
  /** The stable sub-code a coded refusal carries alongside its prose. */
  reason?: unknown;
};

/**
 * The five `gate_waiver_*` refusal codes, mirrored from `GATE_WAIVER_REFUSAL`
 * in mcpjam-backend `convex/lib/gateWaivers.ts`.
 *
 * Enumerated rather than matched with a `gate_waiver_` prefix test. A prefix
 * would silently adopt every future code the backend adds under that
 * namespace, mapping it to 400 before anyone here decided that is right — the
 * "a predicate over names exempts whatever it did not anticipate" failure,
 * running in the other direction. An unlisted code falls through to the
 * translator's terminal 500, which is logged, which is how we would find out.
 */
const GATE_WAIVER_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "gate_waiver_unscoped_suite",
  "gate_waiver_reason_empty",
  "gate_waiver_reason_too_long",
  "gate_waiver_expiry_not_future",
  "gate_waiver_expiry_too_far",
]);

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
/**
 * The current value a compare-and-set precondition disagreed with.
 *
 * Forwarded so a 409 is RECOVERABLE without a second round-trip: a caller that
 * sent a stale `expectedConfigId` gets the live one back and can decide whether
 * to re-read and retry. Copied key by key rather than spread, for the same
 * reason as `billingDetails` — the payload is the backend's internal error
 * shape, and spreading it would publish whatever it gains next without anyone
 * deciding to.
 *
 * `currentImpact` is a small object of counts rather than a scalar, and it is
 * forwarded whole: an agent proposal that conflicted on impact needs to know
 * WHICH consumer count moved to describe the edit honestly the second time.
 */
function preconditionDetails(
  data: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  const payload = data?.data;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const source = payload as Record<string, unknown>;
  const details: Record<string, unknown> = {};
  for (const key of ["currentConfigId", "currentName", "currentImpact"]) {
    if (source[key] !== undefined) details[key] = source[key];
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

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
    // WHEN the cap lifts — epoch ms of the UTC midnight a daily limit rolls
    // at. Documented on `BILLING_LIMIT_REACHED` in `web/errors.ts` since that
    // code existed, and dropped here the whole time, which left "Plan limit
    // reached" as advice a caller could act on only by guessing. It is also
    // the input the 429 below turns into `Retry-After`, so dropping it cost
    // the header as well as the field.
    "resetsAt",
  ]) {
    if (data[key] !== undefined) details[key] = data[key];
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * Ceiling on an advertised wait, in seconds — one day.
 *
 * `Number.isFinite` is not enough on its own. `Number.MAX_VALUE` is finite,
 * and `String(Math.ceil(Number.MAX_VALUE / 1000))` is `1.797...e+305`, which
 * `Headers` accepts and every client parses as `NaN`. That is the failure the
 * junk-metadata guard was written to prevent, arriving through the one input
 * shape it does not reject — so the magnitude is clamped as well as the type.
 *
 * A day is the longest wait worth advertising: past that a `Retry-After` reads
 * as "this endpoint is gone" rather than "come back later", and the caps this
 * serves all roll at UTC midnight anyway.
 */
const MAX_RETRY_AFTER_SECONDS = 86_400;

/** Whole seconds, floored at 1 and capped at a day. Always an integer string. */
function formatRetryAfterSeconds(deltaMs: number): string {
  const seconds = Math.ceil(deltaMs / 1000);
  if (!Number.isFinite(seconds)) return String(MAX_RETRY_AFTER_SECONDS);
  return String(Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, seconds)));
}

/** Seconds-until, floored at 1 — the `Retry-After` value from an instant. */
function retryAfterFromResetsAt(
  resetsAt: unknown,
  now: number = Date.now()
): string | undefined {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) {
    return undefined;
  }
  // A reset already in the past means the window rolled between the backend
  // raising this and us serializing it. Advertise the floor rather than
  // omitting the header: the caller's next attempt will succeed, and "1" says
  // so more usefully than silence.
  return formatRetryAfterSeconds(resetsAt - now);
}

/** Same, from a duration a token bucket measured directly. */
function retryAfterFromMs(retryAfterMs: unknown): string | undefined {
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs)) {
    return undefined;
  }
  return formatRetryAfterSeconds(retryAfterMs);
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
  const kind = typeof data?.kind === "string" ? data.kind : undefined;

  // ── The eval tier denial (mcpjam-backend lib/evalPermissions.ts) ─────────
  //
  // `EvalAccessDeniedError` reaches us as
  // `ConvexError({ kind: 'forbidden', action, message })` — with NO `code`
  // field at all. So it matches none of the coded branches below, none of the
  // prose patterns (its message is "Insufficient permissions for <action>:
  // requires <tier>", which the `insufficient .* permissions` pattern does not
  // match — that alternative needs a second space-delimited word between the
  // two), and not the string-data branch either, since its data is an object.
  // It therefore fell all the way to the terminal 500: a deliberate,
  // well-formed refusal reported as our own bug, paged for, and handed to the
  // caller as a generic internal error.
  //
  // 403 rather than the neutral 404 the generic `FORBIDDEN` branch gives, and
  // the backend is explicit about why: this denial is only reachable by a
  // caller who ALREADY resolved membership, so it reveals nothing they could
  // not see, while "not found" would send a legitimate member hunting for a
  // run sitting in front of them. The denials that DO mean "you cannot see
  // this scope at all" never arrive here — the backend collapses those into
  // its own not-found strings before they leave the mutation.
  //
  // No `/admin/i` message test, unlike the generic `FORBIDDEN` branch. That
  // test exists there because the `FORBIDDEN` code also covers membership
  // denials, which must hide; this `kind` is only raised after membership
  // resolved, so there is nothing left to hide.
  //
  // `adminFailureIsForbidden` is still honored. A route that deliberately
  // HIDES its permission gate (sandbox images, whose gate also guards shared
  // environments) asked for that, and a new branch that overrode the knob
  // would quietly reopen the existence oracle the knob was added to close.
  //
  // Placed before the coded branches for the same reason `FEATURE_UNAVAILABLE`
  // is: it is a recognized refusal that must keep its own status and its own
  // message, and anything downstream would take one or both away.
  if (kind === "forbidden") {
    return adminFailureIsForbidden
      ? new WebRouteError(
          403,
          ErrorCode.FORBIDDEN,
          structuredMessage ?? "You do not have permission to do that."
        )
      : new WebRouteError(404, ErrorCode.NOT_FOUND, notFoundMessage);
  }

  // ── Gate-waiver refusals (mcpjam-backend lib/gateWaivers.ts) ─────────────
  //
  // All five are 400s the CALLER can fix, and every message is customer-facing
  // copy written deliberately — the unscoped-suite one in particular names the
  // condition AND the remedy, because a caller cannot otherwise tell it apart
  // from a permission problem. Forwarded verbatim.
  //
  // Handled explicitly rather than left to fall through: an unrecognized code
  // matches none of the coded branches, and the prose fallbacks below sniff
  // `error.message`, which for a ConvexError is the JSON of its data. That
  // path either loses the message on the terminal 500 or, worse, matches a
  // pattern by accident and answers with the wrong status.
  if (GATE_WAIVER_REFUSAL_CODES.has(code ?? "")) {
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      structuredMessage ?? fallbackMessage
    );
  }

  // ── Import eligibility (mcpjam-backend lib/evalImportEligibility.ts) ─────
  //
  // A launch refused because an imported case in it cannot run: an
  // approximation with no approval, an approval naming a case the run does not
  // execute, an `unsupported` or `unresolved` case among the selected ones.
  // Every one of them is the caller's to fix — approve it, deselect it, or fix
  // the file — so 400 rather than the terminal 500 an unrecognized code gets.
  //
  // The backend's `message` is customer-facing copy naming the case AND the
  // remedy, and `reason` is the stable code a program branches on. Both are
  // forwarded; nothing else from the payload is, because the rest of it is the
  // backend's internal shape and spreading it would publish whatever it gains
  // next without anybody deciding to.
  //
  // Handled explicitly for the same reason the waiver codes above are: an
  // unrecognized code falls through to prose sniffing over `error.message`,
  // which for a ConvexError is the JSON of its data — so it either loses the
  // message on a 500 or matches a pattern by accident and answers with the
  // wrong status.
  if (code === "IMPORT_INELIGIBLE") {
    const reason = data?.reason;
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      structuredMessage ?? fallbackMessage,
      typeof reason === "string" && reason.length > 0 ? { reason } : undefined
    );
  }

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

  // ── Baseline selection refusals (mcpjam-backend convex/testSuites.ts) ────
  //
  // `compareTestSuiteRuns` refuses two malformed baseline selections with
  // structured codes. Handled HERE, before the generic branches, for the same
  // reason `FEATURE_UNAVAILABLE` is: an unrecognized code matches none of the
  // `code === "..."` branches below, so it falls past all of them, past the
  // prose sniffing (which only inspects STRING `data`, and these carry an
  // object), and lands on the terminal 500 — where the message is dropped on
  // purpose and the failure is logged as OUR bug. Both of these are the
  // caller's malformed input, so that outcome would be wrong twice: a 500 for
  // a 400, and an on-call page for a usage error.
  //
  // The backend's message is forwarded verbatim because it is already
  // customer-facing and already names which of the two mutually exclusive
  // selectors was the problem — rewriting it here would create a second place
  // to keep that copy correct.
  //
  // NOT to be confused with a baseline that resolved to nothing: an
  // unresolvable SHA is the `baseline_not_found` ENVELOPE status, not a throw,
  // and must keep mapping to 404 + `reason: "BASELINE_NOT_FOUND"` so the CLI
  // reports exit 3 ("we looked and established nothing") rather than a
  // regression nobody observed.
  if (
    code === "EVAL_COMPARE_BASELINE_CONFLICT" ||
    code === "EVAL_COMPARE_BASELINE_INVALID"
  ) {
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      structuredMessage ??
        (code === "EVAL_COMPARE_BASELINE_CONFLICT"
          ? "Pass either a baseline run id or a baseline commit SHA, not both."
          : "The baseline commit SHA must not be blank.")
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
  // A BURST BRAKE, distinct from the daily cap below. The backend's
  // per-category token buckets (`lib/expensiveWriteRateLimit.ts`) refuse with
  // this code and a measured `retryAfterMs`; without this branch it falls all
  // the way to the terminal 500 — a refusal we deliberately raised, reported
  // as our own bug and paged for. The wait it carries is seconds, not hours:
  // the only correct client response is to retry, which is exactly what the
  // header tells a generic one to do.
  if (code === "rate_limited") {
    const rawRetryAfterMs = (data as Record<string, unknown> | null)
      ?.retryAfterMs;
    const retryAfter = retryAfterFromMs(rawRetryAfterMs);
    // Published only when it is a number we would also put in the header.
    // Copying the raw value through would put `"soon"` or `NaN` on a public
    // 429 while the header correctly omitted it — a caller reading the body
    // for the same answer deserves the same guard.
    const retryAfterMs =
      typeof rawRetryAfterMs === "number" && Number.isFinite(rawRetryAfterMs)
        ? rawRetryAfterMs
        : undefined;
    const error = new WebRouteError(
      429,
      ErrorCode.RATE_LIMITED,
      structuredMessage ?? "Too many requests. Slow down and retry.",
      retryAfterMs !== undefined ? { retryAfterMs } : undefined
    );
    return retryAfter
      ? error.withHeaders({ "Retry-After": retryAfter })
      : error;
  }

  if (code === "billing_limit_reached") {
    const details = billingDetails(data as Record<string, unknown> | null);
    const error = new WebRouteError(
      429,
      ErrorCode.RATE_LIMITED,
      structuredMessage ?? "Plan limit reached.",
      // The backend's payload names the cap, the plan and the upgrade target.
      // Dropping it leaves a caller with "Plan limit reached" and no way to
      // say WHICH limit or what to do about it.
      details
    );
    // A daily cap knows the INSTANT it lifts (UTC midnight), not a duration —
    // so the header is computed here rather than read off the payload. Absent
    // when the backend sent no `resetsAt`, which is the honest answer: a cap
    // with no known reset should not invite a timed retry.
    const retryAfter = retryAfterFromResetsAt(details?.resetsAt);
    return retryAfter
      ? error.withHeaders({ "Retry-After": retryAfter })
      : error;
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
      structuredMessage ?? conflictMessage,
      preconditionDetails(data as Record<string, unknown> | null)
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

  // ── A DELIBERATE prose refusal keeps its 400 and its message. ────────────
  //
  // The backend's mutations throw `new ConvexError('A journey needs a goal')`
  // — string data, no `{code}` — as their ordinary user-facing refusals, and
  // `ConvexError` data is the one thing Convex's production redaction
  // preserves, which is exactly why the backend puts customer copy there. So
  // string data IS the recognition: someone chose this message for the
  // caller. Routing these into the 500 below would page the on-call every
  // time a user submits a journey with no goal, and hand that user a generic
  // error in place of the sentence written to help them. The structured
  // branches above stay first so a string that happens to say "not found"
  // still cannot bypass the coded mappings — this branch only sees errors no
  // prose pattern claimed.
  const proseData = (error as { data?: unknown } | null)?.data;
  if (typeof proseData === "string" && proseData.trim().length > 0) {
    return new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      proseData.trim()
    );
  }

  // ── Nothing recognized it. That is OUR bug, and it answers 500. ──────────
  //
  // This used to be a 400 VALIDATION_ERROR carrying Convex's prose, which got
  // the reporting exactly backwards. Every branch above is a recognized
  // outcome: a structured `ConvexError` code, string-data prose the backend
  // wrote for the caller, or one of the prose shapes a mixed-version
  // deployment still throws. An error that matches NONE of them is a write
  // path we do not understand — a mutation throwing a new code, a renamed or
  // undeployed function, a broken deploy — and none of those are the
  // caller's malformed input.
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
