import { Network } from "lucide-react";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "../types";
import { CrossHostMatrix } from "./cross-host-matrix";
import { useCrossHostData } from "./use-cross-host-data";

interface CrossHostDashboardProps {
  suite: EvalSuite;
  cases: EvalCase[];
  runs: EvalSuiteRun[];
  allIterations: EvalIteration[];
  /** Called when the user wants to navigate to host attachment settings. */
  onConfigureHosts?: () => void;
}

export function CrossHostDashboard({
  suite,
  cases,
  runs,
  allIterations,
  onConfigureHosts,
}: CrossHostDashboardProps) {
  const data = useCrossHostData(suite, cases, runs, allIterations);

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
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium">Cross-host comparison</h3>
        <p className="text-xs text-muted-foreground">
          {data.hostColumns.length} host
          {data.hostColumns.length !== 1 ? "s" : ""} · {data.caseRows.length}{" "}
          case{data.caseRows.length !== 1 ? "s" : ""}
        </p>
      </div>
      <div className="rounded-xl border bg-card overflow-hidden">
        <CrossHostMatrix data={data} />
      </div>
    </div>
  );
}
