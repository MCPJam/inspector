import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { IterationDetails } from "./iteration-details";
import type { EvalIteration, EvalCase } from "./types";
import { formatTime, formatDuration } from "./helpers";

interface TestResultsPanelProps {
  iteration: EvalIteration | null;
  testCase: EvalCase | null;
  loading?: boolean;
}

export function TestResultsPanel({
  iteration,
  testCase,
  loading = false,
}: TestResultsPanelProps) {
  const hasResult = iteration !== null;
  const isPassed = iteration?.result === "passed";
  const isFailed = iteration?.result === "failed";
  const isPending = iteration?.status === "running" || iteration?.status === "pending";
  const modelName = iteration?.testCaseSnapshot?.model || "Unknown";
  const provider = iteration?.testCaseSnapshot?.provider || "";

  return (
    <div className="h-full flex flex-col border-t border-border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-4">
          {hasResult && !loading && (
            <>
              {isPassed && (
                <Badge
                  variant="default"
                  className="bg-green-600 hover:bg-green-700"
                >
                  <CheckCircle2 className="h-3 w-3 mr-1.5" />
                  Passed
                </Badge>
              )}
              {isFailed && (
                <Badge variant="destructive">
                  <XCircle className="h-3 w-3 mr-1.5" />
                  Failed
                </Badge>
              )}
              {isPending && (
                <Badge variant="secondary">
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                  Running
                </Badge>
              )}
            </>
          )}
        </div>
        {hasResult && !loading && (
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="font-mono font-medium">
              {modelName}
            </span>
            <span>
              Tools: {iteration.actualToolCalls?.length || 0}
            </span>
            <span>
              Tokens: {iteration.tokensUsed?.toLocaleString() || 0}
            </span>
            {iteration.duration && (
              <span>Duration: {formatDuration(iteration.duration)}</span>
            )}
            <span>{formatTime(iteration.createdAt)}</span>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto mb-3" />
              <p className="text-xs font-semibold text-foreground mb-1">
                Running test...
              </p>
              <p className="text-xs text-muted-foreground font-medium">
                This may take a few moments
              </p>
            </div>
          </div>
        ) : !hasResult ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-sm">
              <p className="text-sm font-semibold text-foreground mb-2">
                No results yet
              </p>
              <p className="text-xs text-muted-foreground font-medium">
                Select a model and click Run to execute this test
              </p>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="p-4">
              <IterationDetails iteration={iteration} testCase={testCase} />
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

