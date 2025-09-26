import { useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { FlaskConical } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EvalCase, EvalIteration, EvalSuite } from "./evals/types";
import { IterationCard } from "./evals/iteration-card";
import { formatTime } from "./evals/helpers";

export function EvalsTab() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
            <p className="mt-4 text-muted-foreground">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="p-6">
        <EmptyState
          icon={FlaskConical}
          title="Sign in to view your evals"
          description="Create an account or sign in to see previous runs and metrics."
          className="h-[calc(100vh-200px)]"
        />
      </div>
    );
  }

  return <EvalsContent />;
}

function EvalsContent() {
  const suites = useQuery(
    "evals:getCurrentUserEvalTestSuites" as any,
    {} as any,
  ) as unknown as EvalSuite[] | undefined;
  const cases = useQuery(
    "evals:getCurrentUserEvalTestGroups" as any,
    {} as any,
  ) as unknown as EvalCase[] | undefined;
  const iterations = useQuery(
    "evals:getCurrentUserEvalTestIterations" as any,
    {} as any,
  ) as unknown as EvalIteration[] | undefined;

  const isDataLoading =
    suites === undefined || cases === undefined || iterations === undefined;

  if (isDataLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
            <p className="mt-4 text-muted-foreground">
              Loading your eval data...
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <h1 className="text-2xl font-bold">Evals</h1>
        </div>
      </div>

      <SuitesBrowser
        suites={suites || []}
        cases={cases || []}
        iterations={iterations || []}
      />
    </div>
  );
}

// --- Helper and subcomponents ---

function withinSuiteWindow(it: EvalIteration, suite: EvalSuite): boolean {
  const started = suite.startedAt ?? 0;
  const finished = suite.finishedAt ?? Number.MAX_SAFE_INTEGER;
  return it.startedAt >= started && it.startedAt <= finished;
}

type SuiteAggregate = {
  filteredIterations: EvalIteration[];
  totals: { passed: number; failed: number; cancelled: number; tokens: number };
  byCase: Array<{
    testCaseId: string;
    title: string;
    provider: string;
    model: string;
    runs: number;
    passed: number;
    failed: number;
    cancelled: number;
    tokens: number;
  }>;
};

function aggregateSuite(
  suite: EvalSuite,
  cases: EvalCase[],
  iterations: EvalIteration[],
): SuiteAggregate {
  const filtered = iterations.filter((it) => withinSuiteWindow(it, suite));
  const totals = filtered.reduce(
    (acc, it) => {
      // Do not count running/pending iterations toward pass/fail/cancelled
      if (it.status === "running" || it.result === "pending") {
        // skip counting while in-flight
      } else if (it.result === "passed") acc.passed += 1;
      else if (it.result === "failed") acc.failed += 1;
      else if (it.result === "cancelled") acc.cancelled += 1;
      acc.tokens += it.tokensUsed || 0;
      return acc;
    },
    { passed: 0, failed: 0, cancelled: 0, tokens: 0 },
  );

  const byCaseMap = new Map<string, SuiteAggregate["byCase"][number]>();
  for (const it of filtered) {
    const id = it.testCaseId;
    if (!id) continue;
    if (!byCaseMap.has(id)) {
      const c = cases.find((x) => x._id === id);
      byCaseMap.set(id, {
        testCaseId: id,
        title: c?.title || "Untitled",
        provider: c?.provider || "",
        model: c?.model || "",
        runs: c?.runs || 0,
        passed: 0,
        failed: 0,
        cancelled: 0,
        tokens: 0,
      });
    }
    const entry = byCaseMap.get(id)!;
    if (it.status === "running" || it.result === "pending") {
      // do not count pending/running
    } else if (it.result === "passed") entry.passed += 1;
    else if (it.result === "failed") entry.failed += 1;
    else if (it.result === "cancelled") entry.cancelled += 1;
    entry.tokens += it.tokensUsed || 0;
  }

  return {
    filteredIterations: filtered,
    totals,
    byCase: Array.from(byCaseMap.values()),
  };
}

function SuitesBrowser({
  suites,
  cases,
  iterations,
}: {
  suites: EvalSuite[];
  cases: EvalCase[];
  iterations: EvalIteration[];
}) {
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);

  const selectedSuite = useMemo(() => {
    if (!selectedSuiteId) return null;
    return suites.find((suite) => suite._id === selectedSuiteId) ?? null;
  }, [selectedSuiteId, suites]);

  const iterationsForSelectedSuite = useMemo(() => {
    if (!selectedSuite) return [];
    return iterations
      .filter((iteration) => withinSuiteWindow(iteration, selectedSuite))
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [iterations, selectedSuite]);

  const suiteAggregate = useMemo(() => {
    if (!selectedSuite) return null;
    return aggregateSuite(selectedSuite, cases, iterations);
  }, [selectedSuite, cases, iterations]);

  if (!selectedSuite) {
    return (
      <SuitesOverview
        suites={suites}
        cases={cases}
        iterations={iterations}
        onSelectSuite={setSelectedSuiteId}
      />
    );
  }

  return (
    <SuiteIterationsView
      suite={selectedSuite}
      cases={cases}
      iterations={iterationsForSelectedSuite}
      aggregate={suiteAggregate}
      onBack={() => setSelectedSuiteId(null)}
    />
  );
}

function SuitesOverview({
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
                  <div className="font-medium">{formatTime(suite.startedAt)}</div>
                  <div className="text-xs text-muted-foreground">
                    Tests: {suite.totalTests} · Finished {formatTime(suite.finishedAt)}
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
                  <span className="text-foreground font-medium">{totals.passed}</span> passed ·
                  <span className="ml-1 text-foreground font-medium">{totals.failed}</span> failed ·
                  <span className="ml-1">{totals.cancelled}</span> cancelled
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

function SuiteIterationsView({
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
