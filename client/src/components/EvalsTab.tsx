import { useMemo, useState, useCallback } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { FlaskConical, CheckCircle, XCircle, Clock, Play } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type EvalSuite = {
  _id: string;
  createdBy: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  totalTests: number;
  config: { tests: unknown; environment: unknown; llms: unknown };
};

type EvalCase = {
  _id: string;
  createdBy: string;
  title: string;
  query: string;
  provider: string;
  model: string;
  runs: number;
};

type EvalIteration = {
  _id: string;
  testCaseId?: string;
  createdBy: string;
  createdAt: number;
  startedAt: number;
  iterationNumber: number;
  updatedAt: number;
  blob?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result: "passed" | "failed" | "cancelled";
  actualToolCalls: string[];
  tokensUsed: number;
};

function formatTime(ts?: number) {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function EvalsTab() {
  const { isAuthenticated, isLoading } = useConvexAuth();

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

  const metrics = useMemo(() => {
    const totalSuites = suites?.length ?? 0;
    const runningSuites = suites?.filter((s) => s.status === "running").length ?? 0;
    const completedSuites = suites?.filter((s) => s.status === "completed").length ?? 0;
    const failedSuites = suites?.filter((s) => s.status === "failed").length ?? 0;

    const totalIterations = iterations?.length ?? 0;
    const passedIterations = iterations?.filter((i) => i.result === "passed").length ?? 0;
    const failedIterations = iterations?.filter((i) => i.result === "failed").length ?? 0;
    const totalTokens = iterations?.reduce((sum, i) => sum + (i.tokensUsed || 0), 0) ?? 0;

    return {
      totalSuites,
      runningSuites,
      completedSuites,
      failedSuites,
      totalIterations,
      passedIterations,
      failedIterations,
      totalTokens,
    };
  }, [suites, iterations]);

  if (isDataLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
            <p className="mt-4 text-muted-foreground">Loading your eval data...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <FlaskConical className="h-6 w-6" />
          <h1 className="text-2xl font-bold">Evals</h1>
        </div>
        <Button>
          <Play className="h-4 w-4 mr-2" />
          Run New Eval
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Suites</CardTitle>
            <CardDescription>Total runs</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{metrics.totalSuites}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Passed Runs</CardTitle>
            <CardDescription>Completed suites</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-500" />
              <span className="text-3xl font-semibold">{metrics.completedSuites}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Failed Runs</CardTitle>
            <CardDescription>Suites marked failed</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-500" />
              <span className="text-3xl font-semibold">{metrics.failedSuites}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Tokens Used</CardTitle>
            <CardDescription>Across all iterations</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{metrics.totalTokens.toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      {/* Suites section moved below global metrics and stacked vertically */}
      <SuitesRow
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
      if (it.result === "passed") acc.passed += 1;
      else if (it.result === "failed") acc.failed += 1;
      else acc.cancelled += 1;
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
    if (it.result === "passed") entry.passed += 1;
    else if (it.result === "failed") entry.failed += 1;
    else entry.cancelled += 1;
    entry.tokens += it.tokensUsed || 0;
  }

  return {
    filteredIterations: filtered,
    totals,
    byCase: Array.from(byCaseMap.values()),
  };
}

function SuitesRow({
  suites,
  cases,
  iterations,
}: {
  suites: EvalSuite[];
  cases: EvalCase[];
  iterations: EvalIteration[];
}) {
  const [expandedSuiteId, setExpandedSuiteId] = useState<string | null>(null);

  const toggle = useCallback((id: string) => {
    setExpandedSuiteId((prev) => (prev === id ? null : id));
  }, []);

  const expandedSuite = suites.find((s) => s._id === expandedSuiteId) || null;
  const aggregate = expandedSuite
    ? aggregateSuite(expandedSuite, cases, iterations)
    : null;

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">Suites</h2>

      {suites.length === 0 ? (
        <div className="text-sm text-muted-foreground">No suites yet.</div>
      ) : (
        <div className="space-y-3">
          {suites.map((s) => (
            <button
              key={s._id}
              onClick={() => toggle(s._id)}
              className={`w-full text-left border rounded-xl p-4 hover:shadow-sm transition-shadow ${
                expandedSuiteId === s._id ? "border-primary" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="font-medium">{formatTime(s.startedAt)}</div>
                <div>
                  <Badge className="ml-2">{s.status}</Badge>
                </div>
              </div>
              <div className="text-sm text-muted-foreground mt-1">
                Tests: {s.totalTests} • Finished {formatTime(s.finishedAt)}
              </div>
            </button>
          ))}
        </div>
      )}

      {expandedSuite && aggregate && (
        <Card>
          <CardHeader>
            <CardTitle>Suite started {formatTime(expandedSuite.startedAt)}</CardTitle>
            <CardDescription>
              {aggregate.totals.passed} passed · {aggregate.totals.failed} failed · {aggregate.totals.cancelled} cancelled · {aggregate.totals.tokens.toLocaleString()} tokens
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div>
              <div className="text-sm font-medium mb-2">Per test case</div>
              {aggregate.byCase.length === 0 ? (
                <div className="text-sm text-muted-foreground">No case-level results in this window.</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {aggregate.byCase.map((c) => (
                    <div key={c.testCaseId} className="border rounded-md p-3">
                      <div className="font-medium">{c.title}</div>
                      <div className="text-xs text-muted-foreground mb-1">
                        {c.provider}/{c.model} • Planned runs: {c.runs}
                      </div>
                      <div className="text-sm">
                        <span className="text-green-600">{c.passed} passed</span>
                        <span className="mx-2">·</span>
                        <span className="text-red-600">{c.failed} failed</span>
                        <span className="mx-2">·</span>
                        <span className="text-muted-foreground">{c.cancelled} cancelled</span>
                        <span className="mx-2">·</span>
                        <span className="text-muted-foreground">{c.tokens.toLocaleString()} tokens</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Iterations in suite window</div>
              {aggregate.filteredIterations.length === 0 ? (
                <div className="text-sm text-muted-foreground">No iterations found.</div>
              ) : (
                <div className="space-y-2">
                  {aggregate.filteredIterations.slice(0, 20).map((it) => (
                    <div key={it._id} className="flex items-center justify-between border rounded-md p-3">
                      <div>
                        <div className="font-medium">Iteration #{it.iterationNumber}</div>
                        <div className="text-sm text-muted-foreground">
                          {formatTime(it.startedAt)} • Tokens: {it.tokensUsed} • Tools: {it.actualToolCalls.length}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {it.status === "running" ? (
                          <Clock className="h-4 w-4 text-yellow-500" />
                        ) : it.result === "passed" ? (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-500" />
                        )}
                        <Badge variant={it.result === "passed" ? "default" : it.result === "failed" ? "destructive" : "outline"}>
                          {it.result}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// (Legacy list components removed after vertical redesign)