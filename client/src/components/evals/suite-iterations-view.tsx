import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IterationCard } from "./iteration-card";
import { formatTime } from "./helpers";
import { EvalCase, EvalIteration, EvalSuite, SuiteAggregate } from "./types";

export function SuiteIterationsView({
  suite,
  cases,
  iterations,
  aggregate,
  onBack,
}: {
  suite: EvalSuite;
  cases: EvalCase[];
  iterations: EvalIteration[];
  aggregate: SuiteAggregate | null;
  onBack: () => void;
}) {
  const [openIterationId, setOpenIterationId] = useState<string | null>(null);

  const caseById = useMemo(() => {
    return new Map(cases.map((testCase) => [testCase._id, testCase]));
  }, [cases]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← Back to suites
          </Button>
          <div>
            <h2 className="text-xl font-semibold">Suite started {formatTime(suite.startedAt)}</h2>
            <p className="text-sm text-muted-foreground">
              {aggregate?.totals.passed ?? 0} passed · {aggregate?.totals.failed ?? 0} failed · {aggregate?.totals.cancelled ?? 0} cancelled ·
              {(aggregate?.totals.tokens ?? 0).toLocaleString()} tokens · Result {suite.result}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge className="capitalize">{suite.status}</Badge>
          <Badge
            className="capitalize"
            variant={
              suite.result === "failed"
                ? "destructive"
                : suite.result === "passed"
                ? "default"
                : "outline"
            }
          >
            {suite.result}
          </Badge>
        </div>
      </div>

      <div className="rounded-xl border">
        <div className="border-b bg-muted/40 px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
          Iterations ({iterations.length})
        </div>
        <div className="divide-y">
          {iterations.length === 0 ? (
            <div className="px-4 py-8 text-sm text-muted-foreground">
              No iterations recorded for this suite yet.
            </div>
          ) : (
            iterations.map((iteration) => (
              <IterationCard
                key={iteration._id}
                iteration={iteration}
                testCase={iteration.testCaseId ? caseById.get(iteration.testCaseId) ?? null : null}
                isOpen={openIterationId === iteration._id}
                onToggle={() =>
                  setOpenIterationId((current) =>
                    current === iteration._id ? null : iteration._id,
                  )
                }
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}


