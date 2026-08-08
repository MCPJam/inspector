import * as Sentry from "@sentry/react";
import posthog from "posthog-js";

export type ReportLevel = "fatal" | "error" | "warning" | "info";

export interface ReportOptions {
  /**
   * Stable identifier for the call site, e.g. `"session_token_bootstrap"`.
   * Becomes a Sentry tag so issues from one surface group together.
   */
  source: string;
  level?: ReportLevel;
  extra?: Record<string, unknown>;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  try {
    return new Error(typeof error === "string" ? error : JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

/**
 * Forward a caught error to both error sinks.
 *
 * PostHog's `capture_exceptions` only sees uncaught errors on `window.onerror`
 * / `unhandledrejection`; anything we `catch` (or React catches in a boundary)
 * never reaches those handlers, so there is no double-count between this and
 * the global handler.
 *
 * Never throws. Reporting is diagnostics — a broken transport, an ad-blocked
 * PostHog, or an uninitialized SDK must not escalate into a second failure on
 * a path that is already handling one.
 */
export function reportCaught(error: unknown, options: ReportOptions): void {
  const normalized = toError(error);

  try {
    Sentry.captureException(normalized, {
      level: options.level ?? "error",
      tags: { source: options.source },
      ...(options.extra ? { extra: options.extra } : {}),
    });
  } catch {
    // ignore — see doc comment
  }

  try {
    posthog.captureException(normalized, {
      source: options.source,
      level: options.level ?? "error",
      ...(options.extra ?? {}),
    });
  } catch {
    // ignore — see doc comment
  }
}

/**
 * Report an error caught by a React error boundary, preserving the component
 * stack. `name` identifies which boundary caught it so the ~21 mount sites
 * stay distinguishable in Sentry without editing any of them.
 */
export function reportBoundaryError(
  error: unknown,
  info: { componentStack?: string | null },
  name?: string,
): void {
  reportCaught(error, {
    source: name ? `react_boundary:${name}` : "react_boundary",
    extra: {
      componentStack: info?.componentStack ?? undefined,
      boundary: name ?? "unnamed",
    },
  });
}
