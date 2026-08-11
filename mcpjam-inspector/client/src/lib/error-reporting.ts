import * as Sentry from "@sentry/react";
import posthog from "posthog-js";
import { ConvexError } from "convex/values";
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

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  try {
    return new Error(typeof error === "string" ? error : JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

/**
 * Did the backend refuse, or did it fail?
 *
 * A `ConvexError` carrying `kind: 'forbidden'` is the server declining to
 * answer — the caller is not a member, the role is too low. The UI already
 * handles that (it hides the surface), so it is not a defect and must not reach
 * the error sinks: an expected refusal that pages the team trains everyone to
 * ignore the channel.
 *
 * This is deliberately narrow. Only the explicit `forbidden` shape is quiet;
 * every other `ConvexError`, and every plain throw, still reports. Convex masks
 * plain throws as `Server Error` on production, so a backend that wants silence
 * here has to say so.
 */
function isAuthorizationRefusal(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "forbidden"
  );
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
  if (isAuthorizationRefusal(error)) return;

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
