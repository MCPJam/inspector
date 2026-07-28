import * as Sentry from "@sentry/node";
import { Axiom } from "@axiomhq/js";
import type {
  LogEventName,
  RequestEventMap,
  SystemEventMap,
  RequestLogContext,
  SystemLogContext,
} from "./log-events.js";
import { scrubLogPayload } from "./log-scrubber.js";

const isVerbose = () => process.env.VERBOSE_LOGS === "true";
const isDev = () => process.env.NODE_ENV !== "production";
const shouldLog = () => isVerbose() || isDev();

const axiom =
  process.env.AXIOM_TOKEN && process.env.AXIOM_DATASET
    ? new Axiom({ token: process.env.AXIOM_TOKEN })
    : null;

const dataset = process.env.AXIOM_DATASET ?? "";

const environment = process.env.ENVIRONMENT ?? "unknown";

/**
 * Sentry capture for typed events is **opt-in**: pass `{ sentry: true }` at the
 * callsite that owns the error. Auto-capture for any heuristic (e.g. ".failed"
 * suffix) was removed because it caused double-capture when both middleware
 * and the route's error handler fired Sentry for the same exception.
 */
type SentryOptions = { error?: unknown; sentry?: boolean };

function ingestToAxiom(
  level: "info" | "warn" | "error" | "debug",
  message: string,
  context?: Record<string, unknown>,
) {
  if (!axiom) return;
  axiom.ingest(dataset, [{ ...context, level, message, environment }]);
}

/**
 * Centralized logger that sends errors to Sentry and only logs to console
 * in dev mode or when verbose mode is enabled (--verbose flag or VERBOSE_LOGS=true).
 * Sends info/warn/error logs to Axiom when AXIOM_TOKEN and AXIOM_DATASET are set.
 */
export const logger = {
  /**
   * Log an error. Always sends to Sentry and Axiom, only prints to console in dev/verbose mode.
   *
   * NOTE: For new production diagnostics in `server/routes/web/`, prefer `logger.event()` —
   * free-form messages are not queryable in Axiom. Legacy callers (CLI, system code,
   * non-route utilities) remain on this API. See `server/utils/LOGGING.md`.
   */
  error(message: string, error?: unknown, context?: Record<string, unknown>) {
    Sentry.captureException(error ?? new Error(message), {
      extra: { message, ...context },
    });

    ingestToAxiom("error", message, {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });

    if (shouldLog()) {
      console.error(message, error);
    }
  },

  /**
   * Log a warning. Always sends to Sentry and Axiom, only prints to console in dev/verbose mode.
   *
   * NOTE: For new production diagnostics in `server/routes/web/`, prefer `logger.event()` —
   * free-form messages are not queryable in Axiom. Legacy callers (CLI, system code,
   * non-route utilities) remain on this API. See `server/utils/LOGGING.md`.
   */
  warn(message: string, context?: Record<string, unknown>) {
    Sentry.captureMessage(message, { level: "warning", extra: context });

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
    await axiom?.flush();
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

/**
 * Internal emit shared by `logger.event` and `logger.systemEvent`.
 *
 * - `timestamp` is set at emit time; this is the event-observation time and
 *   is what Axiom indexes as `_time`. Request-start time is recoverable from
 *   `timestamp - durationMs` for HTTP events.
 * - Sentry is opt-in via `options.sentry === true`; the caller that owns the
 *   error decides whether to forward it.
 * - `options.error` is ALSO serialized into the Axiom payload, independent
 *   of the Sentry opt-in: Error instances become `error: {name, message,
 *   stack}`, anything else is stringified (with a non-throwing fallback for
 *   values whose coercion throws). Message/stack are length-capped, and the
 *   result goes through `scrubLogPayload` like every other field — upstream
 *   error strings can quote URLs with embedded credentials. Before this,
 *   the error object reached only Sentry and every failure event landed in
 *   Axiom with no cause — a 502 investigation couldn't name the underlying
 *   ECONNRESET without leaving the log pipeline.
 * - `*.failed` events route their console echo to stderr.
 */
const MAX_ERROR_MESSAGE_CHARS = 2000;
const MAX_ERROR_STACK_CHARS = 4000;

/**
 * Bounded, non-throwing serialization of an emit-time error for the Axiom
 * payload. Length caps keep pathological upstream errors (an MCP server can
 * return an arbitrarily large body quoted into the message) from bloating
 * ingestion; the try/catch keeps a rejection reason with a throwing
 * `toString` (e.g. `Object.create(null)`) from turning the logging of a
 * failure into a new crash — this runs inside the process-level
 * `unhandledRejection` handler. Secret scrubbing is NOT this function's job:
 * the returned value flows through `scrubLogPayload` with the rest of the
 * payload.
 */
function serializeEmitError(error: unknown): unknown {
  try {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message.slice(0, MAX_ERROR_MESSAGE_CHARS),
        ...(error.stack
          ? { stack: error.stack.slice(0, MAX_ERROR_STACK_CHARS) }
          : {}),
      };
    }
    return String(error).slice(0, MAX_ERROR_MESSAGE_CHARS);
  } catch {
    return "[unserializable error]";
  }
}

function emit(
  eventName: LogEventName,
  base: RequestLogContext | SystemLogContext,
  payload: Record<string, unknown>,
  options?: SentryOptions,
): void {
  const fullPayload = scrubLogPayload({
    ...base,
    ...payload,
    ...(options?.error !== undefined
      ? { error: serializeEmitError(options.error) }
      : {}),
    event: eventName,
    timestamp: new Date().toISOString(),
  }) as Record<string, unknown>;

  if (axiom) {
    axiom.ingest(dataset, [fullPayload]);
  }

  if (options?.sentry === true) {
    if (options.error instanceof Error) {
      Sentry.captureException(options.error, { extra: fullPayload });
    } else {
      Sentry.captureMessage(eventName, {
        level: "error",
        extra: {
          ...fullPayload,
          ...(options.error !== undefined
            ? { rawError: String(options.error) }
            : {}),
        },
      });
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
