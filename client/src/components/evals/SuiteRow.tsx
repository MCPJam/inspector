import { useMemo } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { formatTime, aggregateSuite } from "./helpers";
import type { EvalSuite, EvalCase, EvalIteration } from "./types";

interface SuiteRowProps {
  suite: EvalSuite;
  onSelectSuite: (id: string) => void;
}

interface SuiteStatusBadgesProps {
  passed: number;
  failed: number;
  cancelled: number;
  pending: number;
}

function SuiteStatusBadges({
  passed,
  failed,
  cancelled,
  pending,
}: SuiteStatusBadgesProps) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {passed > 0 && (
        <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-green-700">
          {passed} passed
        </span>
      )}
      {failed > 0 && (
        <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-red-700">
          {failed} failed
        </span>
      )}
      {cancelled > 0 && (
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-gray-700">
          {cancelled} cancelled
        </span>
      )}
      {pending > 0 && (
        <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-yellow-700">
          {pending} pending
        </span>
      )}
    </div>
  );
}

export function SuiteRow({ suite, onSelectSuite }: SuiteRowProps) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();

  const enableQuery = isAuthenticated && !!user;
  const suiteDetails = useQuery(
    "evals:getAllTestCasesAndIterationsBySuite" as any,
    enableQuery ? ({ suiteId: suite._id } as any) : "skip",
  ) as unknown as
    | { testCases: EvalCase[]; iterations: EvalIteration[] }
    | undefined;

  const aggregate = useMemo(() => {
    if (!suiteDetails) return null;
    return aggregateSuite(
      suite,
      suiteDetails.testCases,
      suiteDetails.iterations,
    );
  }, [suite, suiteDetails]);

  const testCount = Array.isArray(suite.config?.tests)
    ? suite.config.tests.length
    : 0;

  return (
    <button
      onClick={() => onSelectSuite(suite._id)}
      className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,0.8fr)] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <div>
        <div className="font-medium">
          {new Date(suite._creationTime || 0).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })}
        </div>
        <div className="text-xs text-muted-foreground">
          {testCount} test{testCount !== 1 ? "s" : ""}
        </div>
      </div>
      <div>
        {aggregate ? (
          <SuiteStatusBadges
            passed={aggregate.totals.passed}
            failed={aggregate.totals.failed}
            cancelled={aggregate.totals.cancelled}
            pending={0}
          />
        ) : (
          <span className="text-xs text-muted-foreground">Loading...</span>
        )}
      </div>
      <div className="text-sm text-muted-foreground">
        {formatTime(suite._creationTime)}
      </div>
    </button>
  );
}
