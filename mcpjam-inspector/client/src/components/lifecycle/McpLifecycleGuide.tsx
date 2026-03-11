import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Circle,
  Play,
  RotateCcw,
} from "lucide-react";
import {
  HTTP_STEP_ORDER,
  getLifecycleStepGuide,
  type McpLifecycleStepGuide,
} from "./mcp-lifecycle-guide-data";

interface McpLifecycleGuideProps {
  stepIndex: number; // -1 = overview, 0+ = step
  totalSteps: number;
  onGoToStep: (index: number) => void;
  onFocusStep: (stepId: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onReset: () => void;
}

type StepStatus = "complete" | "current" | "pending";

function getStepStatus(index: number, currentStepIndex: number): StepStatus {
  if (currentStepIndex === -1) return "pending";
  if (index < currentStepIndex) return "complete";
  if (index === currentStepIndex) return "current";
  return "pending";
}

const PHASE_COLORS: Record<string, string> = {
  initialization:
    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800",
  operation:
    "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800",
  shutdown:
    "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-300 dark:border-orange-800",
};

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "complete":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case "current":
      return (
        <Circle className="h-4 w-4 text-blue-500 fill-blue-100 dark:fill-blue-900" />
      );
    case "pending":
      return <Circle className="h-4 w-4 text-muted-foreground/40" />;
  }
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 overflow-auto">
      <pre className="p-3 text-[11px] leading-relaxed font-mono text-foreground/80">
        {code}
      </pre>
    </div>
  );
}

function DataTable({
  table,
}: {
  table: NonNullable<McpLifecycleStepGuide["table"]>;
}) {
  return (
    <div className="rounded-md border border-border overflow-hidden">
      <div className="px-3 py-1.5 bg-muted/30 border-b border-border">
        <p className="text-xs font-semibold text-muted-foreground">
          {table.caption}
        </p>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/10">
            {table.headers.map((header) => (
              <th
                key={header}
                className="text-left px-3 py-1.5 font-semibold text-muted-foreground"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr
              key={i}
              className={cn(
                i < table.rows.length - 1 && "border-b border-border",
              )}
            >
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={cn(
                    "px-3 py-1.5 text-muted-foreground",
                    j === 0 && "font-mono font-medium text-foreground/80",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function McpLifecycleGuide({
  stepIndex,
  totalSteps,
  onGoToStep,
  onFocusStep,
  onNext,
  onPrev,
  onReset,
}: McpLifecycleGuideProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const isOverview = stepIndex === -1;
  const isLastStep = stepIndex === totalSteps - 1;

  // Auto-expand current step when stepIndex changes
  useEffect(() => {
    if (stepIndex >= 0 && stepIndex < HTTP_STEP_ORDER.length) {
      const stepId = HTTP_STEP_ORDER[stepIndex];
      setExpandedSteps((prev) => {
        const next = new Set(prev);
        next.add(stepId);
        return next;
      });
    }
  }, [stepIndex]);

  // Auto-scroll to current step
  useEffect(() => {
    if (stepIndex >= 0 && scrollRef.current) {
      const stepEl = scrollRef.current.querySelector(
        `[data-step-index="${stepIndex}"]`,
      );
      if (stepEl) {
        stepEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }, [stepIndex]);

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Guide header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Guide</h3>
          {!isOverview && (
            <span className="text-xs text-muted-foreground tabular-nums">
              Step {stepIndex + 1} of {totalSteps}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {isOverview ? (
            <Button variant="outline" size="sm" onClick={onNext}>
              <Play className="mr-1 h-3.5 w-3.5" />
              Start
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onPrev}
                disabled={isOverview}
                title="Previous step"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={onNext}
                disabled={isLastStep}
              >
                Continue
                <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onReset}
                title="Reset to overview"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Scrollable step cards */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-4">
        {isOverview && (
          <div className="mb-6 rounded-lg border border-border bg-muted/10 p-4">
            <h4 className="text-sm font-semibold mb-2">
              MCP Protocol Lifecycle
            </h4>
            <p className="text-xs text-muted-foreground leading-relaxed mb-3">
              Walk through the complete HTTP lifecycle of an MCP connection step
              by step. You'll learn how the client and server negotiate
              capabilities, exchange messages during normal operation, and how
              connections are shut down.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Click <strong>Start</strong> to begin, then use{" "}
              <strong>Continue</strong> to advance through each step. The
              sequence diagram on the left will highlight the current message.
            </p>
          </div>
        )}

        <div className="space-y-3">
          {HTTP_STEP_ORDER.map((stepId, index) => {
            const guide = getLifecycleStepGuide(stepId);
            if (!guide) return null;

            const status = getStepStatus(index, stepIndex);
            const isActive = status === "current";
            const isExpanded = expandedSteps.has(stepId);
            const isLast = index === HTTP_STEP_ORDER.length - 1;

            return (
              <div
                key={stepId}
                className="relative"
                data-step-index={index}
              >
                {/* Timeline connector line */}
                {!isLast && (
                  <div className="absolute left-[11px] top-[32px] bottom-0 w-[2px] bg-border" />
                )}

                {/* Step card */}
                <div
                  className={cn(
                    "relative bg-background border rounded-lg transition-all",
                    isActive
                      ? "border-blue-400 shadow-md ring-1 ring-blue-400/20"
                      : "border-border shadow-sm hover:shadow-md",
                  )}
                >
                  {/* Step header - clickable */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleStep(stepId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleStep(stepId);
                      }
                    }}
                    className="w-full px-4 py-3 flex items-start gap-3 hover:bg-muted/30 transition-colors rounded-t-lg cursor-pointer"
                  >
                    {/* Status icon */}
                    <div className="flex-shrink-0 mt-0.5">
                      <StatusIcon status={status} />
                    </div>

                    {/* Step info */}
                    <div className="flex-1 min-w-0 text-left">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-foreground">
                          {index + 1}. {guide.title}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] h-4 px-1.5",
                            PHASE_COLORS[guide.phase],
                          )}
                        >
                          {guide.phase}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {guide.summary}
                      </p>
                    </div>

                    {/* Right side actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          onFocusStep(stepId);
                          // Also navigate to this step if we're not there
                          onGoToStep(index);
                        }}
                        className="h-7 px-2 text-xs"
                      >
                        Show in diagram
                      </Button>

                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </div>

                  {/* Collapsible content */}
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-2 space-y-3 border-t">
                      {/* What to pay attention to */}
                      {guide.teachableMoments.length > 0 && (
                        <div className="rounded-md border border-border bg-muted/10 p-3">
                          <p className="text-xs font-semibold text-muted-foreground mb-2">
                            What to pay attention to
                          </p>
                          <ul className="list-disc pl-5 space-y-1">
                            {guide.teachableMoments.map((item) => (
                              <li
                                key={item}
                                className="text-xs text-muted-foreground"
                              >
                                {item}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Tips */}
                      {guide.tips.length > 0 && (
                        <div className="rounded-md border border-border bg-muted/10 p-3">
                          <p className="text-xs font-semibold text-muted-foreground mb-2">
                            Tips
                          </p>
                          <ul className="list-disc pl-5 space-y-1">
                            {guide.tips.map((tip) => (
                              <li
                                key={tip}
                                className="text-xs text-muted-foreground"
                              >
                                {tip}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Code example */}
                      {guide.codeExample && (
                        <CodeBlock code={guide.codeExample} />
                      )}

                      {/* Table */}
                      {guide.table && <DataTable table={guide.table} />}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
