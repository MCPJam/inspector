import { useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { FlaskConical } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import type { EvalCase, EvalIteration, EvalSuite } from "./evals/types";
import { aggregateSuite } from "./evals/helpers";
import { SuitesOverview } from "./evals/suites-overview";
import { SuiteIterationsView } from "./evals/suite-iterations-view";

export function EvalsResultsTab() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();

  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);

  const enableOverviewQuery = isAuthenticated && !!user;
  const overviewData = useQuery(
    "evals:getCurrentUserEvalTestSuitesWithMetadata" as any,
    enableOverviewQuery ? ({} as any) : "skip",
  ) as unknown as
    | {
        testSuites: EvalSuite[];
        metadata: { iterationsPassed: number; iterationsFailed: number };
      }
    | undefined;

  const enableSuiteDetailsQuery =
    isAuthenticated && !!user && !!selectedSuiteId;
  const suiteDetails = useQuery(
    "evals:getAllTestCasesAndIterationsBySuite" as any,
    enableSuiteDetailsQuery ? ({ suiteId: selectedSuiteId } as any) : "skip",
  ) as unknown as
    | { testCases: EvalCase[]; iterations: EvalIteration[] }
    | undefined;

  const suites = overviewData?.testSuites;
  const isOverviewLoading = overviewData === undefined;
  const isSuiteDetailsLoading =
    enableSuiteDetailsQuery && suiteDetails === undefined;

  const selectedSuite = useMemo(() => {
    if (!selectedSuiteId || !suites) return null;
    return suites.find((suite) => suite._id === selectedSuiteId) ?? null;
  }, [selectedSuiteId, suites]);

  const iterationsForSelectedSuite = useMemo(() => {
    if (!suiteDetails) return [];
    return [...suiteDetails.iterations].sort(
      (a, b) => (b.startedAt || b.createdAt) - (a.startedAt || a.createdAt),
    );
  }, [suiteDetails]);

  const suiteAggregate = useMemo(() => {
    if (!selectedSuite || !suiteDetails) return null;
    return aggregateSuite(
      selectedSuite,
      suiteDetails.testCases,
      suiteDetails.iterations,
    );
  }, [selectedSuite, suiteDetails]);

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex h-64 items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
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

  if (isOverviewLoading && enableOverviewQuery) {
    return (
      <div className="p-6">
        <div className="flex h-64 items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-4 text-muted-foreground">
              Loading your eval data...
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Evaluation results</h1>
      </div>

      {!selectedSuite ? (
        <SuitesOverview
          suites={suites || []}
          onSelectSuite={setSelectedSuiteId}
        />
      ) : isSuiteDetailsLoading ? (
        <div className="flex h-64 items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-4 text-muted-foreground">
              Loading suite details...
            </p>
          </div>
        </div>
      ) : (
        <SuiteIterationsView
          suite={selectedSuite}
          cases={suiteDetails?.testCases || []}
          iterations={iterationsForSelectedSuite}
          aggregate={suiteAggregate}
          onBack={() => setSelectedSuiteId(null)}
        />
      )}
    </div>
  );
}
