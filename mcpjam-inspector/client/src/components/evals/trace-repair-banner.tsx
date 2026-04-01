import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Loader2, Sparkles, X } from "lucide-react";
import {
  activeAutoFixSentence,
  terminalAutoFixSentence,
  type AutoFixJobViewSnapshot,
  type AutoFixOutcomeSnapshot,
} from "./auto-fix-status-sentence";

export type TraceRepairJobViewSnapshot = AutoFixJobViewSnapshot;
export type TraceRepairOutcomeSnapshot = AutoFixOutcomeSnapshot;

const OUTCOME_DISMISS_PREFIX = "mcpjam:traceRepairOutcomeDismissed:";

function isOutcomeDismissed(jobId: string): boolean {
  if (typeof sessionStorage === "undefined") {
    return false;
  }
  return sessionStorage.getItem(`${OUTCOME_DISMISS_PREFIX}${jobId}`) === "1";
}

function setOutcomeDismissedStorage(jobId: string) {
  sessionStorage.setItem(`${OUTCOME_DISMISS_PREFIX}${jobId}`, "1");
}

const cardClass =
  "rounded-md border border-violet-200/70 bg-violet-50/40 dark:border-violet-900/45 dark:bg-violet-950/20";
const headerDividerClass =
  "flex flex-wrap items-center justify-between gap-2 border-b border-violet-200/50 px-3 py-2 dark:border-violet-900/40";

export interface TraceRepairBannerProps {
  scope: "suite" | "case";
  activeView: TraceRepairJobViewSnapshot | null;
  caseTitleByKey: Record<string, string>;
  onStop: () => void | Promise<void>;
  latestOutcome?: TraceRepairOutcomeSnapshot | null;
  showTerminalOutcome?: boolean;
  className?: string;
}

export function TraceRepairBanner({
  scope,
  activeView,
  caseTitleByKey,
  onStop,
  latestOutcome,
  showTerminalOutcome = true,
  className,
}: TraceRepairBannerProps) {
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  const active = activeView != null;
  const dismissed =
    latestOutcome &&
    (dismissedId === latestOutcome.jobId ||
      isOutcomeDismissed(latestOutcome.jobId));

  const activeSentence = useMemo(() => {
    if (!activeView) {
      return "";
    }
    return activeAutoFixSentence(activeView, scope, caseTitleByKey);
  }, [activeView, scope, caseTitleByKey]);

  const terminalSentence = useMemo(() => {
    if (!latestOutcome || active || !showTerminalOutcome || dismissed) {
      return "";
    }
    return terminalAutoFixSentence(latestOutcome, scope);
  }, [latestOutcome, active, showTerminalOutcome, dismissed, scope]);

  if (active && activeView) {
    return (
      <div className={cn(cardClass, className)}>
        <div className={headerDividerClass}>
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <Badge
              variant="outline"
              className="border-violet-300/70 bg-violet-100/60 text-violet-800 text-[10px] font-bold uppercase tracking-wider shrink-0 dark:border-violet-800/50 dark:bg-violet-900/35 dark:text-violet-300"
            >
              <Sparkles className="mr-1 h-3 w-3" />
              AI
            </Badge>
            <span className="text-xs font-medium text-foreground">
              Auto fix
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-muted-foreground shrink-0"
            onClick={() => void onStop()}
          >
            <X className="h-3.5 w-3.5" />
            Stop
          </Button>
        </div>
        <div className="px-3 py-2 text-xs leading-relaxed">
          <span className="flex items-start gap-2 text-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0 mt-0.5" />
            <span>{activeSentence}</span>
          </span>
        </div>
      </div>
    );
  }

  if (showTerminalOutcome && latestOutcome && !dismissed && terminalSentence) {
    return (
      <div className={cn("relative", cardClass, className)}>
        <div className={cn(headerDividerClass, "pr-10")}>
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <Badge
              variant="outline"
              className="border-violet-300/70 bg-violet-100/60 text-violet-800 text-[10px] font-bold uppercase tracking-wider shrink-0 dark:border-violet-800/50 dark:bg-violet-900/35 dark:text-violet-300"
            >
              <Sparkles className="mr-1 h-3 w-3" />
              AI
            </Badge>
            <span className="text-xs font-medium text-foreground">
              Auto fix
            </span>
          </div>
        </div>
        <button
          type="button"
          className="absolute right-2 top-2 rounded p-0.5 text-muted-foreground hover:bg-violet-100/50 hover:text-foreground dark:hover:bg-violet-950/40"
          aria-label="Dismiss auto fix outcome"
          onClick={() => {
            setDismissedId(latestOutcome.jobId);
            setOutcomeDismissedStorage(latestOutcome.jobId);
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="px-3 py-2 text-xs leading-relaxed">
          <p className="text-foreground pr-6">{terminalSentence}</p>
        </div>
      </div>
    );
  }

  return null;
}
