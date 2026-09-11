import React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { reportBoundaryError, reportCaught } from "@/lib/error-reporting";
import {
  attemptStaleChunkRecovery,
  isStaleChunkError,
  STALE_CHUNK_MESSAGE,
} from "@/lib/stale-chunk";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?:
    | React.ReactNode
    | ((input: { error: Error | null; reset: () => void }) => React.ReactNode);
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  /**
   * Identifies this boundary in Sentry (`react_boundary:<name>`). Optional so
   * every existing mount reports without a call-site edit; name the ones whose
   * failures you expect to triage separately.
   */
  name?: string;
  /**
   * Opt one boundary out of reporting for errors it EXPECTS, by predicate.
   *
   * Deliberately not a boolean. A boundary that suppressed everything would
   * also swallow the real bug it was meant to surface, and the whole point of
   * reporting here rather than at the mount sites is that a `fallback={null}`
   * cannot silently eat one. A predicate keeps the exception as narrow as the
   * call site can describe it: match the shape you know is expected, and
   * anything else still reports exactly as before.
   *
   * The case this exists for is a dark-shipped query. `useQuery` throws while
   * the function is not deployed yet, and a probe mounted on a page a user
   * visits repeatedly turns a DOCUMENTED, intended state into one Sentry issue
   * and one PostHog event per visit — noise that is indistinguishable from a
   * real regression precisely when a real regression would matter most.
   *
   * `onError` still fires, and the fallback still renders: this suppresses the
   * telemetry, never the handling.
   */
  isExpectedError?: (error: Error) => boolean;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Domain-agnostic error boundary primitive.
 *
 * Every caught error is reported to Sentry + PostHog regardless of which
 * fallback renders — "silent to the user" is a UI choice, never a telemetry
 * one. The single exception is `isExpectedError`, an opt-in predicate for a
 * boundary that can name a failure shape it genuinely expects; see below.
 *
 * Fallback semantics:
 * - `fallback={null}` → render nothing on error (intentional silence; e.g.
 *   gracefully hiding an experimental tile when its query throws). Reserve it
 *   for surfaces the user never expected to see; if they did, give them a
 *   fallback that explains the gap.
 * - `fallback={<X />}` → render that fallback.
 * - omitted OR `fallback={undefined}` → fall through to the default UI
 *   (TS `?: ReactNode` treats `undefined` as "absent", which is what we
 *   honor here via `!== undefined`).
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // A chunk this build no longer serves is not a defect in the subtree that
    // happened to import it, and no reset can fix it — only a document load
    // can. Recover first, and report it as the deploy-shaped warning it is
    // rather than as one error issue per boundary that mounts a lazy child.
    if (isStaleChunkError(error)) {
      const recovery = attemptStaleChunkRecovery();
      reportCaught(error, {
        source: "stale_chunk",
        level: "warning",
        extra: { recovery, boundary: this.props.name ?? "unnamed" },
      });
      this.props.onError?.(error, errorInfo);
      return;
    }
    // An expected error is still worth a breadcrumb — it just is not a fault,
    // so it goes to `debug` rather than shouting on the console once per visit.
    const expected = this.isExpected(error);
    if (expected) {
      console.debug("ErrorBoundary caught an expected error:", error);
    } else {
      console.error("ErrorBoundary caught an error:", error, errorInfo);
      // Reported here rather than at the ~21 mount sites: a boundary rendering
      // `fallback={null}` used to swallow its error entirely.
      reportBoundaryError(error, errorInfo, this.props.name);
    }
    // Outside the branch on purpose: suppressing telemetry must not also
    // suppress the caller's handling of the failure.
    this.props.onError?.(error, errorInfo);
  }

  /** A throwing predicate must not stop the error from being reported. */
  private isExpected(error: Error): boolean {
    if (!this.props.isExpectedError) return false;
    try {
      return this.props.isExpectedError(error) === true;
    } catch {
      return false;
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) {
        if (typeof this.props.fallback === "function") {
          return this.props.fallback({
            error: this.state.error,
            reset: this.handleReset,
          });
        }
        return this.props.fallback;
      }

      return (
        <div className="flex items-center justify-center min-h-[400px] p-6">
          <div className="text-center max-w-md">
            <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
            <p className="text-sm text-muted-foreground mb-4">
              {isStaleChunkError(this.state.error)
                ? STALE_CHUNK_MESSAGE
                : this.state.error?.message || "An unexpected error occurred"}
            </p>
            <Button onClick={this.handleReset} variant="outline">
              Try again
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
