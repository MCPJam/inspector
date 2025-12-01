import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { IterationDetails } from "./iteration-details";
import type { EvalIteration, EvalCase } from "./types";
import { formatTime, formatDuration } from "./helpers";

interface TestResultsPanelProps {
  iteration: EvalIteration | null;
  testCase: EvalCase | null;
  loading?: boolean;
  onClear?: () => void;
  serverNames?: string[];
}

export function TestResultsPanel({
  iteration,
  testCase,
  loading = false,
  onClear,
  serverNames = [],
}: TestResultsPanelProps) {
  const hasResult = iteration !== null;
  const isPassed = iteration?.result === "passed";
  const isFailed = iteration?.result === "failed";
  const isPending =
    iteration?.status === "running" || iteration?.status === "pending";
  const modelName = iteration?.testCaseSnapshot?.model || "Unknown";
  const provider = iteration?.testCaseSnapshot?.provider || "";

  return (
    <div className="h-full flex flex-col bg-muted/20">
      {/* Header */}
      {hasResult && !loading && (
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <div className="flex items-center gap-3">
            {isPassed && <CheckCircle2 className="h-5 w-5 text-success" />}
            {isFailed && <XCircle className="h-5 w-5 text-destructive" />}
            {isPending && (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            )}
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="font-mono font-medium text-foreground">
                {modelName}
              </span>
              <span>{iteration.actualToolCalls?.length || 0} tools</span>
              <span>{iteration.tokensUsed?.toLocaleString() || 0} tokens</span>
              {iteration.duration && (
                <span>{formatDuration(iteration.duration)}</span>
              )}
            </div>
          </div>
          {onClear && (
            <button
              onClick={onClear}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">Running test...</p>
            </div>
          </div>
        ) : !hasResult ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-xs text-muted-foreground">
              Click Run to execute this test
            </p>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="p-3">
              <IterationDetails
                iteration={iteration}
                testCase={testCase}
                serverNames={serverNames}
              />
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
