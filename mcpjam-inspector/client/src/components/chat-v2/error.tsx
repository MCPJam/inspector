import { CircleAlert, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
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
  retryAfter?: number;
  onRetry?: () => void;
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

function CountdownTimer({ retryAfterMs, onComplete }: { retryAfterMs: number; onComplete?: () => void }) {
  const [remainingMs, setRemainingMs] = useState(retryAfterMs);

  useEffect(() => {
    if (remainingMs <= 0) {
      onComplete?.();
      return;
    }

    const timer = setInterval(() => {
      setRemainingMs(prev => {
        const next = prev - 1000;
        if (next <= 0) {
          onComplete?.();
          return 0;
        }
        return next;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [remainingMs, onComplete]);

  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);

  if (remainingMs <= 0) return null;

  return (
    <span className="font-mono text-xs">
      ({minutes}:{seconds.toString().padStart(2, '0')} remaining)
    </span>
  );
}

export function ErrorBox({
  message,
  errorDetails,
  onResetChat,
  code,
  statusCode,
  isRetryable,
  isMCPJamPlatformError,
  retryAfter,
  onRetry,
}: ErrorBoxProps) {
  const [isErrorDetailsOpen, setIsErrorDetailsOpen] = useState(false);
  const [canRetry, setCanRetry] = useState(!retryAfter || retryAfter <= 0);
  const errorDetailsJson = parseErrorDetails(errorDetails);

  // Platform errors use amber styling to indicate "not your fault"
  const isPlatformError = isMCPJamPlatformError === true;

  const containerClasses = isPlatformError
    ? "border-amber-500 bg-amber-200/80 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-600"
    : "border-red-500 bg-red-300/80 text-red-900 dark:bg-red-900/30 dark:text-red-200 dark:border-red-600";

  const iconClasses = isPlatformError
    ? "text-amber-900 dark:text-amber-200"
    : "text-red-900 dark:text-red-200";

  const triggerClasses = isPlatformError
    ? "text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
    : "text-red-700 hover:text-red-800 dark:text-red-300 dark:hover:text-red-200";

  const borderClasses = isPlatformError
    ? "border-amber-500/30"
    : "border-red-500/30";

  const preClasses = isPlatformError
    ? "text-amber-700 dark:text-amber-300"
    : "text-red-700 dark:text-red-300";

  const errorLabel = isPlatformError
    ? "MCPJam platform issue"
    : "An error occurred";

  return (
    <div className={cn("flex flex-col gap-3 border rounded p-4", containerClasses)}>
      <div className="flex items-center gap-3">
        <CircleAlert className={cn("h-6 w-6 flex-shrink-0", iconClasses)} />
        <div className="flex-1">
          <p className="text-sm leading-6">{errorLabel}: {message}</p>
          {isPlatformError && (
            <p className="text-xs opacity-75 mt-0.5">
              This is a temporary issue on our end, not something you did wrong.
            </p>
          )}
          {retryAfter && retryAfter > 0 && (
            <div className="mt-1">
              <CountdownTimer
                retryAfterMs={retryAfter}
                onComplete={() => setCanRetry(true)}
              />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 ml-auto flex-shrink-0">
          {isRetryable && onRetry && canRetry && (
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
          <Button
            type="button"
            variant="outline"
            onClick={onResetChat}
          >
            Reset chat
          </Button>
        </div>
      </div>
      {errorDetails && (
        <Collapsible
          open={isErrorDetailsOpen}
          onOpenChange={setIsErrorDetailsOpen}
        >
          <CollapsibleTrigger className={cn("flex items-center gap-1.5 text-xs transition-colors", triggerClasses)}>
            <span>More details</span>
            {isErrorDetailsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className={cn("rounded border bg-background/50 p-2", borderClasses)}>
              {errorDetailsJson ? (
                <JsonView
                  src={errorDetailsJson}
                  style={{
                    backgroundColor: "transparent",
                    fontSize: "11px",
                  }}
                />
              ) : (
                <pre className={cn("text-xs font-mono whitespace-pre-wrap overflow-x-auto", preClasses)}>
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
