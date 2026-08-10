import React from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { reportBoundaryError } from "@/lib/error-reporting";

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
 * one.
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
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    // Reported here rather than at the ~21 mount sites: a boundary rendering
    // `fallback={null}` used to swallow its error entirely.
    reportBoundaryError(error, errorInfo, this.props.name);
    this.props.onError?.(error, errorInfo);
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
              {this.state.error?.message || "An unexpected error occurred"}
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
