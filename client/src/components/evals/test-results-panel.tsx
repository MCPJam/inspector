import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
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
  const [showRawJson, setShowRawJson] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  const hasResult = iteration !== null;
  const isPassed = iteration?.result === "passed";
  const isFailed = iteration?.result === "failed";
  const isPending = iteration?.status === "running" || iteration?.status === "pending";
  const modelName = iteration?.testCaseSnapshot?.model || "Unknown";
  const provider = iteration?.testCaseSnapshot?.provider || "";

  return (
    <div className="h-full flex flex-col border-t border-border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <div className="flex items-center gap-4">
          <h2 className="text-xs font-semibold text-foreground">Result</h2>
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
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={!showRawJson ? "default" : "outline"}
              onClick={() => setShowRawJson(false)}
            >
              Formatted
            </Button>
            <Button
              size="sm"
              variant={showRawJson ? "default" : "outline"}
              onClick={() => setShowRawJson(true)}
            >
              Raw
            </Button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
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
        ) : showRawJson ? (
          // Raw JSON view
          <ScrollArea className="h-full">
            <div className="p-4">
              <JsonView
                src={iteration}
                dark={true}
                theme="atom"
                enableClipboard={true}
                displaySize={false}
                collapseStringsAfterLength={100}
                style={{
                  fontSize: "12px",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
                  backgroundColor: "hsl(var(--background))",
                  padding: "16px",
                  borderRadius: "8px",
                  border: "1px solid hsl(var(--border))",
                }}
              />
            </div>
          </ScrollArea>
        ) : (
          // Formatted view
          <ScrollArea className="h-full">
            <div className="p-4 space-y-4">
              {/* Summary Card */}
              <div
                className="rounded-lg border hover:bg-accent/50 transition-colors cursor-pointer"
                onClick={() => setIsExpanded(!isExpanded)}
              >
                <div className="flex items-center gap-3 p-3">
                  {/* Expand/Collapse Icon */}
                  <div className="shrink-0">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>

                  {/* Result Icon */}
                  <div className="shrink-0">
                    {isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin text-amber-600" />
                    ) : isPassed ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    ) : isFailed ? (
                      <XCircle className="h-4 w-4 text-red-600" />
                    ) : null}
                  </div>

                  {/* Model & Stats */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-mono font-medium truncate">
                        {provider}/{modelName}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {iteration.result}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground mt-1">
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
                  </div>
                </div>
              </div>

              {/* Expanded Details */}
              {isExpanded && (
                <div className="pl-2">
                  <IterationDetails iteration={iteration} testCase={testCase} />
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

