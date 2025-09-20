import { useMemo } from "react";
import { useAuth } from "@workos-inc/authkit-react";
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
  const { user, signIn } = useAuth();

  const suites = useQuery(
    "evals:getCurrentUserEvalTestSuites" as any,
  ) as unknown as EvalSuite[] | undefined;
  const cases = useQuery(
    "evals:getCurrentUserEvalTestGroups" as any,
  ) as unknown as EvalCase[] | undefined;
  const iterations = useQuery(
    "evals:getCurrentUserEvalTestIterations" as any,
  ) as unknown as EvalIteration[] | undefined;

  const isDataLoading =
    isLoading || suites === undefined || cases === undefined || iterations === undefined;

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
        <div className="flex items-center justify-center">
          <Button onClick={() => signIn()}>Sign up / Sign in</Button>
        </div>
      </div>
    );
  }

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

  const getStatusBadge = (status: EvalSuite["status"]) => {
    if (status === "running")
      return (
        <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
          Running
        </Badge>
      );
    if (status === "failed")
      return (
        <Badge variant="destructive">
          Failed
        </Badge>
      );
    if (status === "cancelled")
      return (
        <Badge className="bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200">
          Cancelled
        </Badge>
      );
    return <Badge>Completed</Badge>;
  };

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

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="xl:col-span-1">
          <CardHeader>
            <CardTitle>Suites</CardTitle>
            <CardDescription>Historical runs</CardDescription>
          </CardHeader>
          <CardContent>
            {suites && suites.length > 0 ? (
              <div className="space-y-3">
                {suites.map((s) => (
                  <div key={s._id} className="flex items-center justify-between border rounded-md p-3">
                    <div>
                      <div className="font-medium">Started {formatTime(s.startedAt)}</div>
                      <div className="text-sm text-muted-foreground">
                        Tests: {s.totalTests} • Finished {formatTime(s.finishedAt)}
                      </div>
                    </div>
                    {getStatusBadge(s.status)}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No suites yet.</div>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-1">
          <CardHeader>
            <CardTitle>Test Cases</CardTitle>
            <CardDescription>Reusable prompts and configs</CardDescription>
          </CardHeader>
          <CardContent>
            {cases && cases.length > 0 ? (
              <div className="space-y-3">
                {cases.map((c) => (
                  <div key={c._id} className="border rounded-md p-3">
                    <div className="font-medium">{c.title}</div>
                    <div className="text-sm text-muted-foreground">
                      {c.provider}/{c.model} • Planned runs: {c.runs}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No test cases yet.</div>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-1">
          <CardHeader>
            <CardTitle>Iterations</CardTitle>
            <CardDescription>Latest executions</CardDescription>
          </CardHeader>
          <CardContent>
            {iterations && iterations.length > 0 ? (
              <div className="space-y-3">
                {iterations.map((it) => (
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
            ) : (
              <div className="text-sm text-muted-foreground">No iterations yet.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}