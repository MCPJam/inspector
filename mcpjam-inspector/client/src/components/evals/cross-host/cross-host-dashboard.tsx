import { useEffect, useMemo, useRef, useState } from "react";
import { Network, Trash2 } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { standardEventProps } from "@/lib/PosthogUtils";
import { cn } from "@/lib/utils";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "../types";
import { evalSurfaceCardClass } from "../eval-surface-chrome";
import { EVAL_DESTRUCTIVE_BUTTON_CLASS } from "../constants";
import { CrossHostMatrix, type HostVerdictMap } from "./cross-host-matrix";
import type { CaseRowSort } from "./case-row-metrics";
import { useCrossHostData, type CellData } from "./use-cross-host-data";
import {
  buildJudgeByRunAndCaseKey,
  buildWorkflowByRunAndCaseKey,
} from "../goal-completion-presentation";

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
  /** Click a matrix cell → drill into that (case, host) iteration. */
  onCellOpen?: (cell: CellData, hostId: string, caseId: string) => void;
  /** Delete test cases (renders a trash control on each case row). */
  onDeleteTestCasesBatch?: (testCaseIds: string[]) => Promise<void>;
  /** Hide "historical" (detached) host columns — see CrossHostMatrix. */
  hideHistorical?: boolean;
  /** When true, matrix cells include per-run trend strips. */
  cellTrends?: boolean;
  caseRowSort?: CaseRowSort;
  onCaseRowSortChange?: (sort: CaseRowSort) => void;
  sortControlInHeader?: boolean;
  /** Per-host cross-host verdicts (group view only); keyed by namedHostId. */
  hostVerdicts?: HostVerdictMap;
}

export function CrossHostDashboard({
  suite,
  cases,
  runs,
  allIterations,
  onConfigureHosts,
  expanded = false,
  onTestCaseClick,
  onCellOpen,
  onDeleteTestCasesBatch,
  hideHistorical = false,
  cellTrends = false,
  caseRowSort,
  onCaseRowSortChange,
  sortControlInHeader = false,
  hostVerdicts,
}: CrossHostDashboardProps) {
  const data = useCrossHostData(suite, cases, runs, allIterations, {
    cellTrends,
  });
  // Advisory judge verdicts indexed by run → caseKey, so each cell shows the
  // verdict from its own run next to the deterministic pass/fail.
  const judgeByRunAndCaseKey = useMemo(
    () => buildJudgeByRunAndCaseKey(runs),
    [runs],
  );
  // Server-quality workflow findings, also per (case×host), for the cell drill-down.
  const workflowByRunAndCaseKey = useMemo(
    () => buildWorkflowByRunAndCaseKey(runs),
    [runs],
  );
  const [caseToDelete, setCaseToDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [isDeletingCase, setIsDeletingCase] = useState(false);

  const confirmDeleteCase = async () => {
    if (!caseToDelete || !onDeleteTestCasesBatch) return;
    setIsDeletingCase(true);
    try {
      await onDeleteTestCasesBatch([caseToDelete.id]);
      toast.success("Test case deleted");
      setCaseToDelete(null);
    } catch (error) {
      console.error("Failed to delete test case:", error);
      toast.error("Failed to delete test case");
    } finally {
      setIsDeletingCase(false);
    }
  };
  const visibleHostCount = hideHistorical
    ? data.hostColumns.filter((col) => !col.isHistorical).length
    : data.hostColumns.length;
  const posthog = usePostHog();
  // Fire the viewed event once per suite mount, not per render. The
  // ref-keyed-by-suite-id guard means navigating between suites re-fires;
  // re-renders within the same suite (e.g. when iterations stream in) do
  // not. Wrapped in try/catch because analytics throwing must not block
  // the dashboard from rendering — same convention as
  // CreateHostDialog's `client_created` capture.
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

  // On the suite landing (hideHistorical), the matrix only adds value with ≥2
  // clients to compare. With a single client it collapses to a list of cases +
  // pass/fail — identical to the Cases tab — so render nothing and let the
  // tabs own per-case status.
  if (hideHistorical && visibleHostCount < 2) {
    return null;
  }

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
          <h3 className="text-sm font-medium">Across clients</h3>
          <p className="text-xs text-muted-foreground">
            {visibleHostCount} client{visibleHostCount !== 1 ? "s" : ""} ·{" "}
            {data.caseRows.length} case
            {data.caseRows.length !== 1 ? "s" : ""}
          </p>
        </div>
      ) : null}
      <div
        className={
          expanded
            ? "min-h-0 w-full flex-1 overflow-hidden"
            : cn("overflow-hidden", evalSurfaceCardClass)
        }
      >
        <CrossHostMatrix
          data={data}
          expanded={expanded}
          onTestCaseClick={onTestCaseClick}
          onCellOpen={onCellOpen}
          onDeleteCase={
            onDeleteTestCasesBatch
              ? (id, title) => setCaseToDelete({ id, title })
              : undefined
          }
          hideHistorical={hideHistorical}
          cellTrends={cellTrends}
          caseRowSort={caseRowSort}
          onCaseRowSortChange={onCaseRowSortChange}
          sortControlInHeader={sortControlInHeader}
          hostVerdicts={hostVerdicts}
          judgeByRunAndCaseKey={judgeByRunAndCaseKey}
          workflowByRunAndCaseKey={workflowByRunAndCaseKey}
        />
      </div>

      <Dialog
        open={caseToDelete != null}
        onOpenChange={(open) => {
          if (!open && !isDeletingCase) setCaseToDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" />
              Delete test case
            </DialogTitle>
            <DialogDescription>
              Delete “{caseToDelete?.title || "Untitled test case"}”? This cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCaseToDelete(null)}
              disabled={isDeletingCase}
            >
              Cancel
            </Button>
            <Button
              className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
              onClick={confirmDeleteCase}
              disabled={isDeletingCase}
            >
              {isDeletingCase ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
