import { formatTime } from "./helpers";
import { IterationDetails } from "./iteration-details";
import { EvalCase, EvalIteration } from "./types";
import { CheckCircle, XCircle, Clock } from "lucide-react";

export function IterationCard({
    iteration,
    testCase,
    isOpen,
    onToggle,
  }: {
    iteration: EvalIteration;
    testCase: EvalCase | null;
    isOpen: boolean;
    onToggle: () => void;
  }) {
    const isPending = iteration.status === "running" || iteration.result === "pending";
  
    return (
      <div className={`transition-colors ${isOpen ? "bg-muted/50" : "bg-background"}`}>
        <button
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="font-semibold">
                Iteration #{iteration.iterationNumber}
              </div>
              {testCase ? (
                <span className="text-xs text-muted-foreground">{testCase.title}</span>
              ) : null}
            </div>
            <div className="text-xs text-muted-foreground">
              Started {formatTime(iteration.startedAt)} · Tokens {Number(iteration.tokensUsed || 0).toLocaleString()} · Tools {iteration.actualToolCalls.length}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isPending ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock className="h-4 w-4 text-yellow-500" />
                <span className="capitalize">{iteration.status}</span>
              </div>
            ) : iteration.result === "failed" ? (
              <div className="flex items-center gap-2 text-xs text-red-600">
                <XCircle className="h-4 w-4" />
                <span className="capitalize">{iteration.result}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-green-600">
                <CheckCircle className="h-4 w-4" />
                <span className="capitalize">{iteration.result}</span>
              </div>
            )}
          </div>
        </button>
        {isOpen ? (
          <div className="px-4 pb-4">
            <IterationDetails iteration={iteration} />
          </div>
        ) : null}
      </div>
    );
  }