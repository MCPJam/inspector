import * as Sentry from "@sentry/react";
import posthog from "posthog-js";
import { ConvexError } from "convex/values";
import {
  describeError,
  isNormalizedError,
  originOf,
  type NormalizedError,
} from "@mcpjam/sdk/browser";
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
 * A `NormalizedError` the server already attached, if the shape holds up.
 *
 * Shape-validated rather than trusted: this rides in on a response body, so a
 * proxy or an older server can put anything there, and `originOf` would fall
 * back to `ambiguous` on a malformed block anyway — silently, which is the
 * failure mode worth avoiding.
 */
function attachedNormalized(error: unknown): NormalizedError | undefined {
  // Every read below can run a getter, and this whole path exists to report a
  // failure that already happened. A throwing `normalized` getter must fall
  // back to `describeError` rather than suppress an otherwise classifiable
  // MCPJam failure, so the reads are guarded rather than trusted.
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const candidate = (error as { normalized?: unknown }).normalized;
    // The SDK's own guard, not a hand-rolled subset. It checks the COMPLETE
    // shape, which matters here: a half-formed block carrying
    // `origin: "mcpjam"` would otherwise pass the gate below and page on the
    // strength of one proxy-controlled string. It is also the guard the render
    // path already uses, so "trusted enough to report" and "trusted enough to
    // display" cannot drift apart.
    return isNormalizedError(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
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
    // Checked here as well as in `reportCaught`, so the documented return value
    // stays honest: without this a refusal would be dropped downstream and
    // still reported as sent.
    if (isAuthorizationRefusal(error)) return false;

    // Prefer a normalized block the SERVER attached. A hosted route classifies
    // the real failure with the error object in hand and puts the verdict on
    // its envelope; by the time it reaches here it is a `WebApiError` whose
    // message is an HTTP status line. `describeError` does not look at
    // `.normalized`, so re-describing the wrapper resolves `internal/unknown`
    // — `ambiguous` — and the strict gate below drops the report even when the
    // server said `mcpjam` outright.
    const normalized = attachedNormalized(error) ?? describeError(error);
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
        // The severity PostHog actually reads. `captureException(err, props)`
        // merges `props` OVER the properties it built, and error tracking
        // groups, alerts and filters on `$exception_level` — so the plain
        // `level` above lands as a custom property nothing looks at, and every
        // report kept the `error` default no matter what the caller declared.
        //
        // That silently overrode the one caller that asks for anything else.
        // `oauth_debugger_step` is `warning` on purpose — it reports the
        // server UNDER TEST misbehaving, which is what a debugger is for, and
        // its value is the aggregate trend rather than a page. It alerted as
        // an Inspector crash anyway: 378 events across 97 users in 18 days,
        // more than half of every client `$exception` in the project.
        //
        // `level` is kept alongside it: it has been on these events since the
        // sink was written, and dropping it would break any saved filter.
        $exception_level: options.level ?? "error",
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
