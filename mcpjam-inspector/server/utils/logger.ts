import * as Sentry from "@sentry/node";
import { Axiom } from "@axiomhq/js";

const isVerbose = () => process.env.VERBOSE_LOGS === "true";
const isDev = () => process.env.NODE_ENV !== "production";
const shouldLog = () => isVerbose() || isDev();

const axiom =
  process.env.AXIOM_TOKEN && process.env.AXIOM_DATASET
    ? new Axiom({ token: process.env.AXIOM_TOKEN })
    : null;

const dataset = process.env.AXIOM_DATASET ?? "";

const environment = process.env.ENVIRONMENT ?? "unknown";

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
};

process.on("beforeExit", () => logger.flush());
