import { useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { FlaskConical } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import type { EvalCase, EvalIteration, EvalSuite } from "./evals/types";
import { withinSuiteWindow, aggregateSuite } from "./evals/helpers";
import { SuitesOverview } from "./evals/suites-overview";
import { SuiteIterationsView } from "./evals/suite-iterations-view";

export function EvalsTab() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();

  // Fetch eval data for authenticated user
  const enableQueries = isAuthenticated && !!user;
  const suites = isAuthenticated && useQuery(
    "evals:getCurrentUserEvalTestSuites" as any,
    enableQueries ? ({} as any) : (undefined as any),
  ) as unknown as EvalSuite[] | undefined;
  const cases = isAuthenticated && useQuery(
    "evals:getCurrentUserEvalTestGroups" as any,
    enableQueries ? ({} as any) : (undefined as any),
  ) as unknown as EvalCase[] | undefined;
  const iterations = isAuthenticated && useQuery(
    "evals:getCurrentUserEvalTestIterations" as any,
    enableQueries ? ({} as any) : (undefined as any),
  ) as unknown as EvalIteration[] | undefined;

  const isDataLoading =
    suites === undefined || cases === undefined || iterations === undefined;

  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);

  const selectedSuite = useMemo(() => {
    if (!selectedSuiteId) return null;
    return (
      (suites || []).find((suite) => suite._id === selectedSuiteId) ?? null
    );
  }, [selectedSuiteId, suites]);

  const iterationsForSelectedSuite = useMemo(() => {
    if (!selectedSuite) return [];
    return (iterations || [])
      .filter((iteration) => withinSuiteWindow(iteration, selectedSuite))
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [iterations, selectedSuite]);

  const suiteAggregate = useMemo(() => {
    if (!selectedSuite) return null;
    return aggregateSuite(selectedSuite, cases || [], iterations || []);
  }, [selectedSuite, cases, iterations]);

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

      {!selectedSuite ? (
        <SuitesOverview
          suites={suites || []}
          cases={cases || []}
          iterations={iterations || []}
          onSelectSuite={setSelectedSuiteId}
        />
      ) : (
        <SuiteIterationsView
          suite={selectedSuite}
          cases={cases || []}
          iterations={iterationsForSelectedSuite}
          aggregate={suiteAggregate}
          onBack={() => setSelectedSuiteId(null)}
        />
      )}
    </div>
  );
}
