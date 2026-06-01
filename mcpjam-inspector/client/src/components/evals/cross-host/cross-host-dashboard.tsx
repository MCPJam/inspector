import { useEffect, useRef } from "react";
import { Network } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { standardEventProps } from "@/lib/PosthogUtils";
import { cn } from "@/lib/utils";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "../types";
import { evalSurfaceCardClass } from "../eval-surface-chrome";
import { CrossHostMatrix } from "./cross-host-matrix";
import { useCrossHostData } from "./use-cross-host-data";

interface CrossHostDashboardProps {
  suite: EvalSuite;
  cases: EvalCase[];
  runs: EvalSuiteRun[];
  allIterations: EvalIteration[];
  /** Called when the user wants to navigate to host attachment settings. */
  onConfigureHosts?: () => void;
  /** Full-height matrix inside the suite dashboard By host view. */
  expanded?: boolean;
  onTestCaseClick?: (testCaseId: string) => void;
}

export function CrossHostDashboard({
  suite,
  cases,
  runs,
  allIterations,
  onConfigureHosts,
  expanded = false,
  onTestCaseClick,
}: CrossHostDashboardProps) {
  const data = useCrossHostData(suite, cases, runs, allIterations);
  const posthog = usePostHog();
  // Fire the viewed event once per suite mount, not per render. The
  // ref-keyed-by-suite-id guard means navigating between suites re-fires;
  // re-renders within the same suite (e.g. when iterations stream in) do
  // not. Wrapped in try/catch because analytics throwing must not block
  // the dashboard from rendering — same convention as
  // CreateClientDialog's `client_created` capture.
  const lastFiredSuiteId = useRef<string | null>(null);
  useEffect(() => {
    if (lastFiredSuiteId.current === suite._id) return;
    lastFiredSuiteId.current = suite._id;
    try {
      posthog.capture("evals_cross_host_viewed", {
        ...standardEventProps("cross_host_dashboard"),
        suite_id: suite._id,
        host_count: data.hostColumns.length,
        case_count: data.caseRows.length,
        has_historical_host: data.hostColumns.some((c) => c.isHistorical),
        has_data: data.hasAnyData,
        has_host_attachments: data.hasHostAttachments,
      });
    } catch {
      // swallow — analytics must not block the dashboard render path
    }
  }, [suite._id, posthog, data]);

  if (!data.hasHostAttachments && !data.hasAnyData) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-xl border bg-card px-6 py-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <Network className="size-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">No host attachments</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Attach MCP host applications to this suite to compare results across
            Claude Desktop, Cursor, ChatGPT, and others.
          </p>
        </div>
        {onConfigureHosts && (
          <button
            type="button"
            onClick={onConfigureHosts}
            className="text-xs text-primary hover:underline"
          >
            Configure host attachments
          </button>
        )}
      </div>
    );
  }

  if (!data.hasAnyData) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border bg-card px-6 py-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <Network className="size-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">No cross-host data yet</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Run the suite across its attached hosts to see per-host pass rates,
            latency, and token usage in this matrix.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        expanded ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-4 p-4"
      }
    >
      {!expanded ? (
        <div>
          <h3 className="text-sm font-medium">Cross-host comparison</h3>
          <p className="text-xs text-muted-foreground">
            {data.hostColumns.length} host
            {data.hostColumns.length !== 1 ? "s" : ""} · {data.caseRows.length}{" "}
            case{data.caseRows.length !== 1 ? "s" : ""}
          </p>
        </div>
      ) : null}
      <div
        className={
          expanded
            ? "min-h-0 flex-1 overflow-hidden"
            : cn("overflow-hidden", evalSurfaceCardClass)
        }
      >
        <CrossHostMatrix
          data={data}
          expanded={expanded}
          onTestCaseClick={onTestCaseClick}
        />
      </div>
    </div>
  );
}
