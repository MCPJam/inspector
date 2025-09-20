import { useMemo, useState, useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { FlaskConical, CheckCircle, XCircle, Clock, ChevronDown, ChevronRight } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
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
  result: "pending" | "passed" | "failed" | "cancelled";
  actualToolCalls: string[];
  tokensUsed: number;
};

function formatTime(ts?: number) {
  return ts ? new Date(ts).toLocaleString() : "—";
}

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

  const metrics = useMemo(() => {
    const totalSuites = suites?.length ?? 0;
    const runningSuites = suites?.filter((s) => s.status === "running").length ?? 0;
    const completedSuites = suites?.filter((s) => s.status === "completed").length ?? 0;
    const failedSuites = suites?.filter((s) => s.status === "failed").length ?? 0;

    const nonRunningIterations = iterations?.filter((i) => i.status !== "running") ?? [];
    const totalIterations = nonRunningIterations.length;
    const passedIterations = nonRunningIterations.filter((i) => i.result === "passed").length;
    const failedIterations = nonRunningIterations.filter((i) => i.result === "failed").length;
    const totalTokens = (iterations ?? []).reduce((sum, i) => sum + (i.tokensUsed || 0), 0);

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
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [selectedIterationId, setSelectedIterationId] = useState<string | null>(null);
  const [expandedSuiteIds, setExpandedSuiteIds] = useState<Set<string>>(new Set());

  const selectedSuite = selectedSuiteId
    ? suites.find((s) => s._id === selectedSuiteId) || null
    : null;
  const selectedCase = selectedCaseId
    ? cases.find((c) => c._id === selectedCaseId) || null
    : null;
  const selectedIteration = selectedIterationId
    ? iterations.find((i) => i._id === selectedIterationId) || null
    : null;

  const suiteAgg = selectedSuite
    ? aggregateSuite(selectedSuite, cases, iterations)
    : null;

  const iterationsForSelectedCase = useMemo(() => {
    if (!selectedSuite || !selectedCase) return [] as EvalIteration[];
    return iterations
      .filter((it) => withinSuiteWindow(it, selectedSuite))
      .filter((it) => it.testCaseId === selectedCase._id);
  }, [iterations, selectedSuite, selectedCase]);

  const handleSelectSuite = (id: string) => {
    setSelectedSuiteId(id);
    setSelectedCaseId(null);
    setSelectedIterationId(null);
  };

  const handleSelectCase = (id: string) => {
    setSelectedCaseId(id);
    setSelectedIterationId(null);
  };

  const handleSelectIteration = (id: string) => {
    setSelectedIterationId(id);
  };

  const toggleExpanded = (id: string) => {
    setExpandedSuiteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div className="md:col-span-1 border rounded-xl p-3">
        <div className="text-sm font-medium mb-2">Suites</div>
        {suites.length === 0 ? (
          <div className="text-sm text-muted-foreground">No suites yet.</div>
        ) : (
          <div className="space-y-2">
            {suites.map((s) => {
              const isSelected = s._id === selectedSuiteId;
              const isExpanded = expandedSuiteIds.has(s._id);
              const perSuiteAgg = aggregateSuite(s, cases, iterations);
              return (
                <div key={s._id} className={`border rounded-md ${isSelected ? "border-primary" : "border-border"}`}>
                  <div className="flex items-stretch">
                    <button
                      className="flex-1 text-left p-3"
                      onClick={() => handleSelectSuite(s._id)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{formatTime(s.startedAt)}</div>
                        <Badge>{s.status}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Tests: {s.totalTests} • Finished {formatTime(s.finishedAt)}
                      </div>
                    </button>
                    <button
                      className="px-2 text-muted-foreground hover:text-foreground"
                      aria-label="Toggle test cases"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(s._id);
                      }}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-5 w-5" />
                      ) : (
                        <ChevronRight className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="border-t p-2 space-y-1">
                      {perSuiteAgg.byCase.map((c) => (
                        <button
                          key={c.testCaseId}
                          className={`w-full text-left text-sm rounded px-2 py-1 ${
                            selectedCaseId === c.testCaseId && isSelected ? "bg-muted" : "hover:bg-muted"
                          }`}
                          onClick={() => {
                            handleSelectSuite(s._id);
                            handleSelectCase(c.testCaseId);
                          }}
                        >
                          {c.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="md:col-span-2">
        {!selectedSuite ? (
          <div className="h-[420px] flex items-center justify-center border rounded-xl">
            <div className="text-muted-foreground">Empty State</div>
          </div>
        ) : !selectedCase ? (
          <SuiteDetails suite={selectedSuite} aggregate={suiteAgg!} />
        ) : !selectedIteration ? (
          <CaseDetails
            suite={selectedSuite}
            testCase={selectedCase}
            iterations={iterationsForSelectedCase}
            onSelectIteration={handleSelectIteration}
          />
        ) : (
          <IterationDetails iteration={selectedIteration} />
        )}
      </div>
    </div>
  );
}

function SuiteDetails({
  suite,
  aggregate,
}: {
  suite: EvalSuite;
  aggregate: SuiteAggregate;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Suite started {formatTime(suite.startedAt)}</CardTitle>
        <CardDescription>
          {aggregate.totals.passed} passed · {aggregate.totals.failed} failed · {aggregate.totals.cancelled} cancelled · {aggregate.totals.tokens.toLocaleString()} tokens
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-muted-foreground">
          Status: <Badge className="ml-1 align-middle">{suite.status}</Badge>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
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
      </CardContent>
    </Card>
  );
}

function CaseDetails({
  suite,
  testCase,
  iterations,
  onSelectIteration,
}: {
  suite: EvalSuite;
  testCase: EvalCase;
  iterations: EvalIteration[];
  onSelectIteration: (id: string) => void;
}) {
  const counts = useMemo(() => {
    return iterations.reduce(
      (acc, it) => {
        if (it.status === "running" || it.result === "pending") return acc;
        if (it.result === "passed") acc.passed += 1;
        else if (it.result === "failed") acc.failed += 1;
        else if (it.result === "cancelled") acc.cancelled += 1;
        acc.tokens += it.tokensUsed || 0;
        return acc;
      },
      { passed: 0, failed: 0, cancelled: 0, tokens: 0 }
    );
  }, [iterations]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{testCase.title}</CardTitle>
        <CardDescription>
          {testCase.provider}/{testCase.model} • Planned runs: {testCase.runs}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm text-muted-foreground">
          In suite started {formatTime(suite.startedAt)} • {counts.passed} passed · {counts.failed} failed · {counts.cancelled} cancelled · {counts.tokens.toLocaleString()} tokens
        </div>
        <div className="space-y-2">
          {iterations.length === 0 ? (
            <div className="text-sm text-muted-foreground">No iterations for this case in the selected suite.</div>
          ) : (
            iterations.slice(0, 50).map((it) => (
              <button
                key={it._id}
                onClick={() => onSelectIteration(it._id)}
                className="w-full flex items-center justify-between border rounded-md p-3 text-left hover:bg-muted"
              >
                <div>
                  <div className="font-medium">Iteration #{it.iterationNumber}</div>
                  <div className="text-sm text-muted-foreground">
                    {formatTime(it.startedAt)} • Tokens: {it.tokensUsed} • Tools: {it.actualToolCalls.length}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {it.status === "running" || it.result === "pending" ? (
                    <>
                      <Clock className="h-4 w-4 text-yellow-500" />
                      <Badge variant="outline">pending</Badge>
                    </>
                  ) : it.result === "passed" ? (
                    <>
                      <CheckCircle className="h-4 w-4 text-green-500" />
                      <Badge>passed</Badge>
                    </>
                  ) : it.result === "failed" ? (
                    <>
                      <XCircle className="h-4 w-4 text-red-500" />
                      <Badge variant="destructive">failed</Badge>
                    </>
                  ) : (
                    <Badge variant="outline">cancelled</Badge>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function IterationDetails({ iteration }: { iteration: EvalIteration }) {
  const getBlob = useAction("evals:getEvalTestBlob" as any) as unknown as (
    args: { blobId: string }
  ) => Promise<any>;

  const [blob, setBlob] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!iteration.blob) {
        setBlob(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await getBlob({ blobId: iteration.blob });
        if (!cancelled) setBlob(data);
      } catch (e: any) {
        if (!cancelled) setError("Failed to load blob");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [iteration.blob, getBlob]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Iteration #{iteration.iterationNumber}</CardTitle>
        <CardDescription>
          {formatTime(iteration.startedAt)} • Tokens: {iteration.tokensUsed} • Tools: {iteration.actualToolCalls.length}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm">
          Status: <Badge className="ml-1 align-middle">{iteration.status}</Badge>
          <span className="mx-2">·</span>
          Result: <Badge className="ml-1 align-middle">{iteration.result}</Badge>
        </div>
        <div className="border rounded-md p-3 bg-muted/50">
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading blob…</div>
          ) : error ? (
            <div className="text-sm text-red-600">{error}</div>
          ) : iteration.blob ? (
            <pre className="text-xs overflow-auto max-h-[480px] whitespace-pre-wrap break-words">
{JSON.stringify(blob, null, 2)}
            </pre>
          ) : (
            <div className="text-sm text-muted-foreground">No blob attached to this iteration.</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}