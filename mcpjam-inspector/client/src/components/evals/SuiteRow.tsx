import { useMemo } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { aggregateSuite } from "./helpers";
import type { EvalSuite, EvalCase, EvalIteration } from "./types";

interface SuiteRowProps {
  suite: EvalSuite;
  onSelectSuite: (id: string) => void;
  onRerun: (suite: EvalSuite) => void;
  connectedServerNames: Set<string>;
  rerunningSuiteId: string | null;
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

export function SuiteRow({
  suite,
  onSelectSuite,
  onRerun,
  connectedServerNames,
  rerunningSuiteId,
}: SuiteRowProps) {
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const servers = suite.environment?.servers || [];

  const enableQuery = isAuthenticated && !!user;
  const suiteDetails = useQuery(
    "testSuites:getAllTestCasesAndIterationsBySuite" as any,
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

  const getBorderColor = () => {
    if (!aggregate) return "bg-muted";

    const { passed, failed, cancelled, pending } = aggregate.totals;
    const total = passed + failed + cancelled + pending;

    if (total === 0) return "bg-muted";

    const completedTotal = passed + failed;
    if (completedTotal === 0) return "bg-muted";

    const failureRate = (failed / completedTotal) * 100;

    if (failureRate === 0) return "bg-success/50";
    if (failureRate <= 30) return "bg-warning/50";
    return "bg-destructive/50";
  };

  // Check if all servers are connected
  const suiteServers = Array.isArray(servers) ? servers : [];
  const missingServers = suiteServers.filter(
    (server) => !connectedServerNames.has(server),
  );
  const canRerun = missingServers.length === 0;
  const isRerunning = rerunningSuiteId === suite._id;

  const handleRerunClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRerun(suite);
  };

  return (
    <div className="group relative flex w-full items-center gap-4 py-3 pl-4 pr-4 transition-colors hover:bg-muted/50">
      <div className={`absolute left-0 top-0 h-full w-1 ${getBorderColor()}`} />
      <button
        onClick={() => onSelectSuite(suite._id)}
        className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 cursor-pointer"
      >
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
          {testCount} test{testCount !== 1 ? "s" : ""} · {totalIterations}{" "}
          iteration{totalIterations !== 1 ? "s" : ""}
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
      </button>
      <div className="w-20 flex justify-end">
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRerunClick}
                disabled={!canRerun || isRerunning}
                className="h-8 w-8 p-0"
              >
                <RotateCw
                  className={`h-4 w-4 ${isRerunning ? "animate-spin" : ""}`}
                />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {!canRerun
              ? `Connect the following servers: ${missingServers.join(", ")}`
              : "Run all tests"}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
