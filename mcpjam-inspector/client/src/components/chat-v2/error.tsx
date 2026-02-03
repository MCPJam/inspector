import {
  CircleAlert,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { JsonEditor } from "@/components/ui/json-editor";
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
}: ErrorBoxProps) {
  const [isErrorDetailsOpen, setIsErrorDetailsOpen] = useState(false);
  const errorDetailsJson = parseErrorDetails(errorDetails);

  // Platform errors use warning styling to indicate "not your fault"
  const isPlatformError = isMCPJamPlatformError === true;

  const containerClasses = isPlatformError
    ? "border-warning bg-warning/20 text-warning-foreground"
    : "border-destructive bg-destructive/20 text-destructive-foreground";

  const iconClasses = isPlatformError ? "text-warning" : "text-destructive";

  const triggerClasses = isPlatformError
    ? "text-warning hover:text-warning/80"
    : "text-destructive hover:text-destructive/80";

  const borderClasses = isPlatformError
    ? "border-warning/30"
    : "border-destructive/30";

  const preClasses = isPlatformError
    ? "text-warning-foreground"
    : "text-destructive-foreground";

  const errorLabel = isPlatformError
    ? "MCPJam platform issue"
    : "An error occurred";

  return (
    <div
      className={cn("flex flex-col gap-3 border rounded p-4", containerClasses)}
    >
      <div className="flex items-center gap-3">
        <CircleAlert className={cn("h-6 w-6 flex-shrink-0", iconClasses)} />
        <div className="flex-1">
          <p className="text-sm leading-6">
            {errorLabel}: {message}
          </p>
          {isPlatformError && (
            <p className="text-xs opacity-75 mt-0.5">
              This is a temporary issue on our end.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 ml-auto flex-shrink-0">
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
