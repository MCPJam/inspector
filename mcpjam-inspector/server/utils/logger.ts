import { buildLegacyLogRow, buildStrictLogRow } from "../../shared/strict-log.js";
import * as Sentry from "@sentry/node";
import { Axiom } from "@axiomhq/js";
import { resolveEnvironment } from "./log-events.js";
import type {
  LogEventName,
  RequestEventMap,
  SystemEventMap,
  RequestLogContext,
  SystemLogContext,
} from "./log-events.js";
import { HOSTED_MODE } from "../config.js";
import { isOriginCaptureHandled } from "./error-capture-stamp.js";
import { sentryIdentityMetadata } from "./sentry-request-identity.js";

function withIdentityCapture(capture: () => void): void {
  if (isTrackingDisabled()) return;
  const identity = sentryIdentityMetadata();
  if (!("user" in identity)) {
    capture();
    return;
  }
  // Sentry merges users from several scopes. Strip ambient identity AFTER
  // that merge so an old email or another request's user cannot survive.
  Sentry.withScope((scope) => {
    scope.addEventProcessor((event) => ({
      ...event,
      user: identity.user?.id ? { id: identity.user.id } : undefined,
      tags: { ...event.tags, ...identity.tags },
    }));
    capture();
  });
}

const isVerbose = () => process.env.VERBOSE_LOGS === "true";
const isDev = () => process.env.NODE_ENV !== "production";
const shouldLog = () => isVerbose() || isDev();

/**
 * The same opt-out `server/sentry.ts` and `server/utils/analytics.ts` honor.
 * Checked here too: `DO_NOT_TRACK` means no telemetry, and log shipping is
 * telemetry. Without this the startup notice ("error reporting disabled")
 * would be true of Sentry and false of Axiom.
 *
 * Read at INGEST time, not module load. `server/index.ts` statically imports
 * this module, so its body evaluates before `loadInspectorEnv()` — a
 * `DO_NOT_TRACK=1` coming from `.env` would be invisible to a module-load
 * read, and Axiom would keep shipping while Sentry and PostHog (which both
 * read it at call time) correctly went quiet. Same trap that made the old
 * import-time `Sentry.init` a no-op. `analytics.ts` reads it lazily for this
 * reason too.
 */
function isTrackingDisabled(): boolean {
  const dnt = process.env.DO_NOT_TRACK;
  return dnt === "1" || dnt === "true";
}

// The client is constructed lazily for the same reason: at module load the
// AXIOM_* credentials may not be in the environment yet either.
let axiomClient: Axiom | null | undefined;

function getAxiom(): Axiom | null {
  if (isTrackingDisabled()) return null;
  if (axiomClient === undefined) {
    axiomClient =
      process.env.AXIOM_TOKEN && dataset()
        ? new Axiom({ token: process.env.AXIOM_TOKEN })
        : null;
  }
  return axiomClient;
}

const dataset = () =>
  process.env.AXIOM_CLEAN_DATASET || process.env.AXIOM_DATASET || "inspector-logs";

/**
 * Same resolver the typed-event path uses.
 *
 * These two disagreed. `logger.event` went through `resolveEnvironment()`,
 * which maps anything outside the allowlist onto a canonical value, while the
 * free-form logs below read `ENVIRONMENT` raw — so a deploy setting
 * `ENVIRONMENT=production` split Axiom in half: typed rows tagged `"prod"`,
 * free-form rows tagged `"production"`, and any query that filtered on one
 * silently missed the other. Sharing the resolver kills that class of bug
 * permanently, rather than fixing the one value that happened to diverge.
 *
 * NOTE for dashboards: historical production rows are still `"production"`.
 * Saved queries that span the seam need `in ("prod","production")`.
 */
const environment = () => resolveEnvironment();

/**
 * Sentry capture for typed events is **opt-in**: pass `{ sentry: true }` at the
 * callsite that owns the error. Auto-capture for any heuristic (e.g. ".failed"
 * suffix) was removed because it caused double-capture when both middleware
 * and the route's error handler fired Sentry for the same exception.
 */
type SentryOptions = { error?: unknown; sentry?: boolean };

/**
 * Every free-form row goes through the same scrubber as `logger.event`.
 * Before, only typed events did, and the free-form path is where the raw
 * context lives: an MCP server's URL and name, a sandbox's stderr, `debug`'s
 * arbitrary arguments.
 */
function ingestToAxiom(
  level: "info" | "warn" | "error" | "debug",
  message: string,
  context?: Record<string, unknown>,
  error?: unknown,
) {
  const axiom = getAxiom();
  if (!axiom) return;
  const row = buildLegacyLogRow(message, { ...context, level, environment: environment() }, error);
  if (level !== "debug" || row.event !== "log.unknown") axiom.ingest(dataset(), [row]);
}

/**
 * Send an error-origin capture to Sentry.
 *
 * The one seam in this module's "single Sentry capture path" rule, and it is
 * deliberately narrow: `error-origin-capture.ts` decides WHETHER an error is
 * MCPJam's fault, and that policy is worth keeping in its own module — but the
 * MECHANISM stays here, so there is still exactly one place where the server
 * talks to Sentry, one place where the SDK could be swapped, and no second
 * implementation of the tags/extra shape to keep in sync.
 *
 * Not `logger.error`, because these two differ on purpose: this one has
 * already made a capture decision and must NOT consult the stamp (it is the
 * thing that sets it), carries structured tags rather than a free-form
 * message, and does not write an Axiom row — its caller does that separately,
 * with the verdict attached.
 *
 * Route handlers must never call this. They go through `reportRouteFailure`.
 */
export function captureOriginErrorToSentry(
  error: Error,
  options: {
    tags: Record<string, string>;
    extra: Record<string, unknown>;
    /** Set by a surface's capture policy; Sentry's default is `error`. */
    level?: "error" | "warning";
    /** Set by a surface's capture policy; Sentry groups by stack otherwise. */
    fingerprint?: string[];
  },
): void {
  const identity = sentryIdentityMetadata();
  withIdentityCapture(() =>
    Sentry.captureException(error, {
      ...options,
      ...identity,
      tags: { ...options.tags, ...identity.tags },
    }),
  );
}

/**
 * Centralized logger that sends errors to Sentry and only logs to console
 * in dev mode or when verbose mode is enabled (--verbose flag or VERBOSE_LOGS=true).
 * Sends logs with AXIOM_TOKEN to AXIOM_CLEAN_DATASET, then AXIOM_DATASET, or inspector-logs.
 */
export const logger = {
  /**
   * Log an error. Always sends to Sentry and Axiom, only prints to console in dev/verbose mode.
   *
   * This is the server's single Sentry capture path for free-form errors —
   * `Hono.onError` routes through here, so route handlers never call
   * `captureException` themselves and nothing double-counts.
   *
   * NOTE: For new production diagnostics in `server/routes/web/`, prefer `logger.event()` —
   * free-form messages are not queryable in Axiom. Legacy callers (CLI, system code,
   * non-route utilities) remain on this API. See `server/utils/LOGGING.md`.
   */
  error(message: string, error?: unknown, context?: Record<string, unknown>) {
    // `logger.error` still captures by DEFAULT. Genuinely-ours background
    // failures (schedulers, eval workers) reach Sentry through here and must
    // not vanish. The single exception is an error an error-origin capture
    // point has already ruled on: a route that logs an error and then
    // serializes it into an envelope holds the same object at both sites, and
    // without this check every declined user-fault error would be re-captured
    // here — rebuilding the noise the origin policy exists to remove.
    if (!isOriginCaptureHandled(error)) {
      // The final Sentry transport reconstructs approved diagnostics.
      withIdentityCapture(() =>
        Sentry.captureException(error ?? new Error(message), {
          extra: { message, ...context },
          ...sentryIdentityMetadata(),
        }),
      );
    }

    ingestToAxiom("error", message, context, error);

    if (shouldLog()) {
      console.error(message, error);
    }
  },

  /**
   * Log a warning. Sends to Axiom, only prints to console in dev/verbose mode.
   *
   * Deliberately does NOT capture to Sentry. Every `logger.warn` in the tree
   * used to become a Sentry event, which across thousands of self-hosted
   * installs is the single largest quota-spike vector we have — and a warning
   * is by definition something we chose not to treat as a failure. Axiom is
   * the right home for it: queryable, cheap, no issue-tracker noise. A warning
   * that genuinely needs a Sentry issue should be an explicit
   * `logger.event(..., { error, sentry: true })` at the callsite that owns it.
   *
   * NOTE: For new production diagnostics in `server/routes/web/`, prefer `logger.event()` —
   * free-form messages are not queryable in Axiom. Legacy callers (CLI, system code,
   * non-route utilities) remain on this API. See `server/utils/LOGGING.md`.
   */
  warn(message: string, context?: Record<string, unknown>) {
    ingestToAxiom("warn", message, context);

    if (shouldLog()) {
      console.warn(message);
    }
  },

  /**
   * Log info. Always sends to Axiom. Only prints to console in dev/verbose mode.
   *
   * NOTE: For new production diagnostics in `server/routes/web/`, prefer `logger.event()` —
   * free-form messages are not queryable in Axiom. Legacy callers (CLI, system code,
   * non-route utilities) remain on this API. See `server/utils/LOGGING.md`.
   */
  info(message: string, context?: Record<string, unknown>) {
    ingestToAxiom("info", message, context);

    if (shouldLog()) {
      console.log(message);
    }
  },

  /**
   * Log debug info. Always sends to Axiom. Only prints to console in dev/verbose mode. Does not send to Sentry.
   *
   * Axiom gets the SHAPE of `args`, not their values: these are whatever the
   * caller had in hand, and that is routinely a request or a tool result.
   */
  debug(message: string, ...args: unknown[]) {
    ingestToAxiom("debug", message, args.length ? { args } : undefined);
    if (shouldLog()) {
      console.log(message, ...args);
    }
  },

  /**
   * Flush pending Axiom events. Call before process exit.
   */
  async flush() {
    await getAxiom()?.flush();
  },

  event<E extends keyof RequestEventMap>(
    eventName: E,
    base: RequestLogContext,
    payload: RequestEventMap[E],
    options?: SentryOptions,
  ): void {
    emit(eventName, base, payload, options);
  },

  systemEvent<E extends keyof SystemEventMap>(
    eventName: E,
    base: SystemLogContext,
    payload: SystemEventMap[E],
    options?: SentryOptions,
  ): void {
    emit(eventName, base, payload, options);
  },
};

/** Typed events share the reconstructed vendor boundary with free-form logs. */
function emit(
  eventName: LogEventName,
  base: RequestLogContext | SystemLogContext,
  payload: Record<string, unknown>,
  options?: SentryOptions,
): void {
  const fullPayload = buildStrictLogRow(eventName, { ...base }, payload, options?.error);

  const axiom = getAxiom();
  if (axiom) {
    axiom.ingest(dataset(), [fullPayload]);
  }

  if (HOSTED_MODE && eventName === "telemetry_canary" && !isTrackingDisabled()) {
    process.stdout.write(`${JSON.stringify(fullPayload)}\n`);
  }

  if (options?.sentry === true) {
    if (options.error instanceof Error) {
      withIdentityCapture(() =>
        Sentry.captureException(options.error, {
          extra: fullPayload,
          ...sentryIdentityMetadata(),
        }),
      );
    } else {
      withIdentityCapture(() =>
        Sentry.captureMessage(eventName, {
          level: "error",
          ...sentryIdentityMetadata(),
          extra: {
            ...fullPayload,
          },
        }),
      );
    }
  }

  if (shouldLog()) {
    const consoleFn = eventName.endsWith(".failed")
      ? console.error
      : console.log;
    consoleFn(`[event] ${eventName}`, fullPayload);
  }
}

process.on("beforeExit", () => logger.flush());
