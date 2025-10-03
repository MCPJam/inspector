import { useMemo } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { aggregateSuite } from "./helpers";
import type { EvalSuite, EvalCase, EvalIteration } from "./types";

interface SuiteRowProps {
  suite: EvalSuite;
  onSelectSuite: (id: string) => void;
}

function formatCompactStatus(
  passed: number,
  failed: number,
  cancelled: number,
  pending: number,
): string {
  const parts: string[] = [];

  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  if (pending > 0) parts.push(`${pending} pending`);

  return parts.join(" · ") || "No results";
}

export function SuiteRow({ suite, onSelectSuite }: SuiteRowProps) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const servers = suite.config?.environment.servers;

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

  const serverTags = useMemo(() => {
    if (!Array.isArray(servers)) return [] as string[];

    const sanitized = servers
      .filter((server): server is string => typeof server === "string")
      .map((server) => server.trim())
      .filter(Boolean);

    if (sanitized.length <= 2) {
      return sanitized;
    }

    const remaining = sanitized.length - 2;
    return [...sanitized.slice(0, 2), `+${remaining} more`];
  }, [servers]);

  const totalIterations = aggregate?.filteredIterations.length ?? 0;

  return (
    <button
      onClick={() => onSelectSuite(suite._id)}
      className="group relative flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
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
            {serverTags.length > 0 ? serverTags.join(", ") : "No servers"}
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {testCount} test{testCount !== 1 ? "s" : ""} · {totalIterations} iteration{totalIterations !== 1 ? "s" : ""}
        </div>
        <div className="text-sm text-muted-foreground">
          {aggregate
            ? formatCompactStatus(
                aggregate.totals.passed,
                aggregate.totals.failed,
                aggregate.totals.cancelled,
                aggregate.totals.pending,
              )
            : "Loading..."}
        </div>
      </div>
    </button>
  );
}
