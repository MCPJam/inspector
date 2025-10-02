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
  const isPending =
    iteration.status === "pending" ||
    iteration.status === "running" ||
    iteration.result === "pending";

  return (
    <div
      className={`transition-colors ${isOpen ? "bg-muted/50" : "bg-background"}`}
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <div className="flex items-center gap-4 flex-1">
          <div className="flex items-center gap-2">
            {isPending ? (
              <Clock className="h-4 w-4 text-yellow-500" />
            ) : iteration.result === "failed" ? (
              <XCircle className="h-4 w-4 text-red-600" />
            ) : (
              <CheckCircle className="h-4 w-4 text-green-600" />
            )}
          </div>
          <div className="space-y-1 flex-1">
            <div className="flex items-center gap-2">
              {testCase ? (
                <div className="font-semibold">{testCase.title}</div>
              ) : (
                <div className="font-semibold">
                  Iteration #{iteration.iterationNumber}
                </div>
              )}
              {testCase ? (
                <span className="text-xs text-muted-foreground">
                  Iteration #{iteration.iterationNumber}
                </span>
              ) : null}
            </div>
            <div className="text-xs text-muted-foreground">
              {iteration.startedAt
                ? `Started ${formatTime(iteration.startedAt)}`
                : "Not started yet"}{" "}
              · Tokens {Number(iteration.tokensUsed || 0).toLocaleString()} ·
              Tools {iteration.actualToolCalls.length}
            </div>
          </div>
        </div>
      </button>
      {isOpen ? (
        <div className="px-4 pb-4">
          <IterationDetails iteration={iteration} testCase={testCase} />
        </div>
      ) : null}
    </div>
  );
}
