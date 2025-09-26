import { Badge } from "@/components/ui/badge";
import { aggregateSuite, formatTime } from "./helpers";
import { EvalCase, EvalIteration, EvalSuite } from "./types";

export function SuitesOverview({
  suites,
  cases,
  iterations,
  onSelectSuite,
}: {
  suites: EvalSuite[];
  cases: EvalCase[];
  iterations: EvalIteration[];
  onSelectSuite: (id: string) => void;
}) {
  if (suites.length === 0) {
    return (
      <div className="h-[calc(100vh-220px)] flex items-center justify-center rounded-xl border border-dashed">
        <div className="text-center space-y-2">
          <div className="text-lg font-semibold">No evaluation suites yet</div>
          <p className="text-sm text-muted-foreground">
            Trigger a test run to see your evaluation history here.
          </p>
        </div>
      </div>
    );
  }

  const sortedSuites = [...suites].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border">
        <div className="grid grid-cols-[minmax(0,1.2fr)_140px_140px_220px_160px] items-center gap-3 border-b bg-muted/50 px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
          <div>Test</div>
          <div>Status</div>
          <div>Result</div>
          <div>Summary</div>
          <div>Tokens used</div>
        </div>
        <div className="divide-y">
          {sortedSuites.map((suite) => {
            const { totals } = aggregateSuite(suite, cases, iterations);
            return (
              <button
                key={suite._id}
                onClick={() => onSelectSuite(suite._id)}
                className="grid w-full grid-cols-[minmax(0,1.2fr)_140px_140px_220px_160px] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <div>
                  <div className="font-medium">
                    {formatTime(suite.startedAt)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Tests: {suite.totalTests} · Finished{" "}
                    {formatTime(suite.finishedAt)}
                  </div>
                </div>
                <div>
                  <Badge className="capitalize">{suite.status}</Badge>
                </div>
                <div>
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
                <div className="text-sm text-muted-foreground">
                  <span className="text-foreground font-medium">
                    {totals.passed}
                  </span>{" "}
                  passed ·
                  <span className="ml-1 text-foreground font-medium">
                    {totals.failed}
                  </span>{" "}
                  failed ·<span className="ml-1">{totals.cancelled}</span>{" "}
                  cancelled
                </div>
                <div className="text-sm text-muted-foreground">
                  {totals.tokens.toLocaleString()}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
