import {
  CircleAlert,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { useAuth } from "@workos-inc/authkit-react";
import { JsonEditor } from "@/components/ui/json-editor";
import { isMCPJamModelLimitError } from "@/lib/guest-limit";
import { cn } from "@/lib/utils";

interface ErrorBoxProps {
  message: string;
  errorDetails?: string;
  onResetChat: () => void;
  // New props for enhanced error display
  code?: string;
  statusCode?: number;
  isRetryable?: boolean;
  isMCPJamPlatformError?: boolean;
  onRetry?: () => void;
  canTopUp?: boolean;
  onTopUp?: () => void;
  /** When true, render the locked-account banner instead of any other state. */
  walletLocked?: boolean;
  /** Sub-classification of a rate-limit error. `"concurrency"` triggers the
   * transient retry banner. */
  limitKind?: "total" | "concurrency";
  /** Raw retry hint in milliseconds. Used by the concurrency banner to render
   * second-level granularity ("Retry in N seconds"). */
  retryAfterMs?: number;
}

const parseErrorDetails = (details: string | undefined) => {
  if (!details) return null;
  try {
    const parsed = JSON.parse(details);
    return parsed;
  } catch {
    return null;
  }
};

export function ErrorBox({
  message,
  errorDetails,
  onResetChat,
  code,
  statusCode,
  isRetryable,
  isMCPJamPlatformError,
  onRetry,
  canTopUp,
  onTopUp,
  walletLocked,
  limitKind,
  retryAfterMs,
}: ErrorBoxProps) {
  const [isErrorDetailsOpen, setIsErrorDetailsOpen] = useState(false);
  const errorDetailsJson = parseErrorDetails(errorDetails);

  const { user, isLoading } = useAuth();

  // Three priority states for the rate-limit-adjacent variants. Order
  // matters: walletLocked is the highest-priority terminal state (no
  // self-serve recovery), then the concurrency throttle (transient,
  // user-driven retry), then everything else falls back to the existing
  // model-limit / generic error rendering.
  const isWalletLocked = walletLocked === true;
  const isConcurrencyThrottle =
    !isWalletLocked &&
    code === "user_rate_limit" &&
    limitKind === "concurrency";

  const isMCPJamModelLimit =
    !isWalletLocked &&
    !isConcurrencyThrottle &&
    (code === "user_rate_limit" ||
      isMCPJamModelLimitError({
        code,
        details: errorDetails,
        message,
      }));

  // Guests hitting the daily model limit see the global GuestLimitDialog
  // instead of an inline banner. Wallet/concurrency states fall through
  // to their dedicated banners above; signed-in users keep the inline UI.
  const isGuest = !isLoading && !user;
  if (isMCPJamModelLimit && isGuest) {
    return null;
  }

  // Platform and quota errors use warning styling to indicate recoverable state.
  const isPlatformError = isMCPJamPlatformError === true || isMCPJamModelLimit;

  const containerClasses = isPlatformError
    ? "border-warning bg-warning/20 text-warning-foreground"
    : "border-destructive bg-destructive/20 text-destructive";

  const iconClasses = isPlatformError ? "text-warning" : "text-destructive";

  const triggerClasses = isPlatformError
    ? "text-warning hover:text-warning/80"
    : "text-destructive hover:text-destructive/80";

  const borderClasses = isPlatformError
    ? "border-warning/30"
    : "border-destructive/30";

  const preClasses = isPlatformError
    ? "text-warning-foreground"
    : "text-destructive";

  const isAuthError = code === "auth_error";

  const errorLabel = isMCPJamModelLimit
    ? "Daily MCPJam model limit reached"
    : isPlatformError
      ? "MCPJam platform issue"
      : "An error occurred";
  const errorPrefix = isMCPJamModelLimit ? `${errorLabel}.` : `${errorLabel}:`;

  if (isWalletLocked) {
    // Server has paused this account from spending or topping up. The user
    // cannot self-serve out of this; only support can clear it. Render a
    // dedicated locked-state banner with a contact link — no top-up, no
    // retry, just a way to reach out.
    return (
      <div className="flex flex-col gap-3 border rounded p-4 border-warning bg-warning/20 text-warning-foreground">
        <div className="flex items-start gap-3">
          <ShieldAlert className="h-6 w-6 flex-shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-6">
              Account under review
            </p>
            <p className="text-sm leading-6 opacity-90">
              We&apos;ve paused this account while a recent payment is
              reviewed.{" "}
              <a
                className="underline hover:no-underline"
                href="mailto:founders@mcpjam.com?subject=MCPJam%20Account%20Review"
              >
                Reach out to support
              </a>{" "}
              to get back in.
            </p>
          </div>
          <div className="ml-auto flex flex-shrink-0 flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={onResetChat}>
              Reset chat
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isConcurrencyThrottle) {
    // Another credit-funded chat is still in flight server-side. Short
    // wait, then retry — render a transient-feeling banner with a retry
    // button. Top-up doesn't help here; just wait it out.
    const retrySeconds = Math.max(
      1,
      Math.ceil((retryAfterMs ?? 0) / 1000),
    );
    return (
      <div className="flex flex-col gap-2 border rounded p-3 border-border bg-muted/40 text-foreground">
        <div className="flex items-start gap-3">
          <CircleAlert className="h-4 w-4 flex-shrink-0 text-muted-foreground mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-xs leading-5">
              Another credit-funded chat is finishing. Retry in{" "}
              {retrySeconds} second{retrySeconds === 1 ? "" : "s"}.
            </p>
          </div>
          <div className="ml-auto flex flex-shrink-0 flex-wrap items-center gap-2">
            {onRetry && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetry}
                className="gap-1.5"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-col gap-3 border rounded p-4", containerClasses)}
    >
      <div className="flex items-start gap-3">
        <CircleAlert className={cn("h-6 w-6 flex-shrink-0", iconClasses)} />
        <div className="min-w-0 flex-1">
          {isMCPJamModelLimit && !isAuthError ? (
            <>
              <p className="text-sm font-medium leading-6">{errorLabel}</p>
              <p className="text-sm leading-6 opacity-90">{message}</p>
            </>
          ) : (
            <p className="text-sm leading-6">
              {isAuthError ? (
                message
              ) : (
                <>
                  <span className="font-medium">{errorPrefix}</span> {message}
                </>
              )}
            </p>
          )}
          {isPlatformError && !isMCPJamModelLimit && (
            <p className="text-xs opacity-75 mt-0.5">
              This is a temporary issue on our end.
            </p>
          )}
        </div>
        <div className="ml-auto flex flex-shrink-0 flex-wrap items-center gap-2">
          {canTopUp && onTopUp && (
            <Button type="button" onClick={onTopUp}>
              Top up to keep chatting
            </Button>
          )}
          {isRetryable && onRetry && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetry}
              className="gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onResetChat}>
            Reset chat
          </Button>
        </div>
      </div>
      {errorDetails && (
        <Collapsible
          open={isErrorDetailsOpen}
          onOpenChange={setIsErrorDetailsOpen}
        >
          <CollapsibleTrigger
            className={cn(
              "flex items-center gap-1.5 text-xs transition-colors",
              triggerClasses,
            )}
          >
            <span>More details</span>
            {isErrorDetailsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div
              className={cn(
                "rounded border bg-background/50 p-2",
                borderClasses,
              )}
            >
              {errorDetailsJson ? (
                <JsonEditor
                  height="100%"
                  value={errorDetailsJson}
                  readOnly
                  showToolbar={false}
                />
              ) : (
                <pre
                  className={cn(
                    "text-xs font-mono whitespace-pre-wrap overflow-x-auto",
                    preClasses,
                  )}
                >
                  {errorDetails}
                </pre>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
