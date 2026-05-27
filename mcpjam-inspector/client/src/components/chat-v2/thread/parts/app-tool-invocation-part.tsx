import { useState, type KeyboardEvent } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Database,
  Loader2,
  XCircle,
} from "lucide-react";

import { JsonEditor } from "@/components/ui/json-editor";
import { cn } from "@/lib/chat-utils";
import type { AppToolInvocation } from "../app-tool-invocations";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

export function AppToolInvocationPart({
  invocation,
}: {
  invocation: AppToolInvocation;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasInput = invocation.input !== undefined;
  const hasOutput = invocation.output !== undefined;
  const hasError = invocation.status === "error" && !!invocation.errorText;
  const hasDetails = hasInput || hasOutput || hasError;

  const toggleExpanded = () => {
    if (!hasDetails) return;
    setIsExpanded((value) => !value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleExpanded();
  };

  const StatusIcon =
    invocation.status === "running"
      ? Loader2
      : invocation.status === "error"
      ? XCircle
      : CheckCircle2;

  return (
    <div className="@container rounded-lg border text-xs border-border/50 bg-background/70">
      <div
        role="button"
        tabIndex={hasDetails ? 0 : -1}
        className={cn(
          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
          hasDetails && "cursor-pointer"
        )}
        onClick={toggleExpanded}
        onKeyDown={handleKeyDown}
        aria-expanded={isExpanded}
      >
        <span className="inline-flex items-center gap-2 font-medium normal-case text-foreground min-w-0">
          <span className="inline-flex items-center gap-2 min-w-0">
            <img
              src="/mcp.svg"
              alt=""
              role="presentation"
              aria-hidden="true"
              className="h-3 w-3 shrink-0"
            />
            <span className="font-mono text-xs tracking-tight text-muted-foreground/80 truncate">
              {invocation.toolName}
            </span>
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground shrink-0">
          <StatusIcon
            className={cn(
              "h-3.5 w-3.5",
              invocation.status === "running" && "animate-spin",
              invocation.status === "error" && "text-destructive",
              invocation.status === "success" && "text-success"
            )}
          />
          {hasDetails && (
            <span
              className="inline-flex items-center gap-0.5 border border-border/40 rounded-md p-0.5 bg-muted/30"
              onClick={(event) => event.stopPropagation()}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="Data"
                    onClick={toggleExpanded}
                    className={cn(
                      "inline-flex items-center gap-1 px-1.5 py-1 rounded transition-colors cursor-pointer",
                      isExpanded
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-background/50"
                    )}
                  >
                    <Database className="h-3.5 w-3.5" />
                    <span className="text-[9px] leading-none hidden @[33rem]:inline">
                      Data
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-medium">Data</p>
                </TooltipContent>
              </Tooltip>
            </span>
          )}
          {hasDetails && (
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                isExpanded && "rotate-180"
              )}
            />
          )}
        </span>
      </div>

      {isExpanded && hasDetails && (
        <div className="border-t border-border/40 p-3 space-y-4">
          {hasInput && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Input
              </div>
              <div className="rounded-md border border-border/30 bg-muted/20 max-h-[300px] overflow-auto">
                <JsonEditor
                  height="100%"
                  viewOnly
                  value={invocation.input}
                  className="p-2 text-[11px]"
                  collapsible
                  defaultExpandDepth={2}
                />
              </div>
            </div>
          )}

          {hasOutput && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Result
              </div>
              <div className="rounded-md border border-border/30 bg-muted/20 max-h-[300px] overflow-auto">
                <JsonEditor
                  height="100%"
                  viewOnly
                  value={invocation.output}
                  className="p-2 text-[11px]"
                  collapsible
                  defaultExpandDepth={2}
                />
              </div>
            </div>
          )}

          {hasError && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Error
              </div>
              <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                {invocation.errorText}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
