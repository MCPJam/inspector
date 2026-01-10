import * as Sentry from "@sentry/node";

const isVerbose = () => process.env.VERBOSE_LOGS === "true";
const isDev = () => process.env.NODE_ENV !== "production";
const shouldLog = () => isVerbose() || isDev();

/**
 * Centralized logger that sends errors to Sentry and only logs to console
 * in dev mode or when verbose mode is enabled (--verbose flag or VERBOSE_LOGS=true).
 */
export const logger = {
  /**
   * Log an error. Always sends to Sentry, only prints to console in dev/verbose mode.
   */
  error(message: string, error?: unknown, context?: Record<string, unknown>) {
    Sentry.captureException(error ?? new Error(message), {
      extra: { message, ...context },
    });

    if (shouldLog()) {
      console.error(message, error);
    }
  },

  /**
   * Log a warning. Always sends to Sentry, only prints to console in dev/verbose mode.
   */
  warn(message: string, context?: Record<string, unknown>) {
    Sentry.captureMessage(message, { level: "warning", extra: context });

    if (shouldLog()) {
      console.warn(message);
    }
  },

  /**
   * Log info. Only prints to console in dev/verbose mode. Does not send to Sentry.
   */
  info(message: string) {
    if (shouldLog()) {
      console.log(message);
    }
  },

  /**
   * Log debug info. Only prints to console in dev/verbose mode. Does not send to Sentry.
   */
  debug(message: string, ...args: unknown[]) {
    if (shouldLog()) {
      console.log(message, ...args);
    }
  },
};
