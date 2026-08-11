import * as Sentry from "@sentry/react";
import posthog from "posthog-js";
import { describeError, originOf } from "@mcpjam/sdk/browser";
import {
  isCredentialBearingPath,
  isErrorCaptureSurface,
} from "./PosthogUtils";

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

/**
 * Report a caught client failure, but only when it might be ours.
 *
 * `reportCaught` is unconditional by design — a React error boundary must
 * always report. These backfilled call sites are different: they sit on paths
 * that reach a user's own MCP server, where "the tool call failed" usually
 * means that server failed, and reporting all of them would rebuild on the
 * client the same noise the server-side origin policy exists to remove.
 *
 * So: skip anything the catalog positively attributes to the user's server or
 * the user's configuration, and skip self-hosted surfaces entirely (the Sentry
 * leg of `reportCaught` is NOT gated, so it must be gated here). Everything
 * else is reported with the classification attached, so triage can slice by
 * slug without re-deriving it.
 *
 * Returns whether anything was sent, so callers and tests can assert the gate.
 */
export function reportPossiblyOurFailure(
  error: unknown,
  options: ReportOptions,
): boolean {
  try {
    if (!isErrorCaptureSurface()) return false;

    const normalized = describeError(error);
    const origin = originOf(normalized);
    // `mcpjam` only — the same policy the server capture path applies, and for
    // the same reason. `ambiguous` on these routes is dominated by a user's
    // server behaving unpredictably, and there is no client-side volume data
    // yet to argue otherwise. That makes this a narrow gate today, which is
    // the intended trade: these three call sites reported NOTHING before, and
    // widening later should be a decision made from measurements rather than
    // from the fear of missing something.
    if (origin !== "mcpjam") return false;

    reportCaught(error, {
      ...options,
      extra: {
        ...(options.extra ?? {}),
        slug: normalized.slug,
        origin,
      },
    });
    return true;
  } catch {
    // Reporting must never escalate a failure into a second one.
    return false;
  }
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

  // PostHog is gated to the same surfaces as `capture_exceptions`.
  // `capture_exceptions: false` only disables posthog-js's AUTOMATIC
  // window.onerror handler — an explicit `captureException` call still sends.
  // Without this check, every npx/Docker install would ship caught errors to
  // the shared project, which is exactly the boundary PR-4 set out to draw.
  //
  // The gate evaluation is INSIDE the try, not just the send. This function
  // must never throw (see the doc comment), and it runs on paths that are
  // already handling a failure — including `componentDidCatch`, where a throw
  // would escape the boundary that just caught something. Fail-closed: if we
  // cannot determine the surface, we do not send.
  try {
    if (isErrorCaptureSurface() && !isCredentialBearingPath()) {
      posthog.captureException(normalized, {
        source: options.source,
        level: options.level ?? "error",
        ...(options.extra ?? {}),
      });
    }
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
