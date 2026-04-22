import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  FlaskConical,
  Loader2,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import posthog from "posthog-js";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import type { EvalSuite, EvalSuiteOverviewEntry } from "./types";
import { evalOverviewEntryOutcomeTitle } from "./helpers";
import { cn } from "@/lib/utils";

function useTick(intervalMs = 60_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "—";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

const passBadge = (
  <span
    className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300"
    aria-label="Passed"
  >
    Passed
  </span>
);

const failBadge = (
  <span
    className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-rose-500/15 text-rose-700 dark:bg-rose-400/20 dark:text-rose-300"
    aria-label="Failed"
  >
    Failed
  </span>
);

function suiteLastRunCell(entry: EvalSuiteOverviewEntry) {
  const r = entry.latestRun;
  const lastRunTimestamp = r
    ? (r.completedAt ?? r.createdAt ?? null)
    : undefined;

  if (!r) {
    return (
      <span
        className="inline-flex items-center justify-end rounded-full border border-dashed border-muted-foreground/25 bg-muted/40 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
        title="This suite has not been run yet"
      >
        Never run
      </span>
    );
  }

  if (r.status === "running" || r.status === "pending") {
    return (
      <span className="text-xs text-amber-600 dark:text-amber-400 text-right tabular-nums">
        Running
        {lastRunTimestamp ? (
          <span className="font-normal text-muted-foreground">
            {" "}
            · {formatRelativeTime(lastRunTimestamp)}
          </span>
        ) : null}
      </span>
    );
  }

  if (r.result === "passed") {
    return (
      <span className="text-xs text-right tabular-nums text-muted-foreground">
        {passBadge}
        {lastRunTimestamp ? (
          <span className="font-normal">
            {" "}
            · {formatRelativeTime(lastRunTimestamp)}
          </span>
        ) : null}
      </span>
    );
  }

  if (r.result === "failed" || r.status === "failed") {
    return (
      <span className="text-xs text-right tabular-nums text-muted-foreground">
        {failBadge}
        {lastRunTimestamp ? (
          <span className="font-normal">
            {" "}
            · {formatRelativeTime(lastRunTimestamp)}
          </span>
        ) : null}
      </span>
    );
  }

  if (r.result === "cancelled" || r.status === "cancelled") {
    return (
      <span className="text-xs text-muted-foreground text-right tabular-nums">
        Cancelled
        {lastRunTimestamp ? (
          <span className="font-normal">
            {" "}
            · {formatRelativeTime(lastRunTimestamp)}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span className="text-xs text-muted-foreground text-right tabular-nums">
      {r.status.replace(/-/g, " ")}
      {lastRunTimestamp ? (
        <span className="font-normal">
          {" "}
          · {formatRelativeTime(lastRunTimestamp)}
        </span>
      ) : null}
    </span>
  );
}

type EvalsSuiteListSidebarProps = {
  suites: EvalSuiteOverviewEntry[];
  selectedSuiteId: string | null;
  onSelectSuite: (suiteId: string) => void;
  onCreateSuite: () => void;
  isLoading?: boolean;
  /** When true with {@link onDeleteSuitesBatch}, show batch delete for selected suites. */
  canDeleteSuites?: boolean;
  onDeleteSuitesBatch?: (suiteIds: string[]) => Promise<void>;
  /** Disable selection actions while a suite delete is in progress elsewhere. */
  deleteInProgress?: boolean;
  /**
   * When set, the row play control runs the full suite (same as suite header "Run all")
   * instead of only navigating into the suite.
   */
  onRunAll?: (suite: EvalSuite) => void | Promise<void>;
  rerunningSuiteId?: string | null;
  replayingRunId?: string | null;
  runningTestCaseId?: string | null;
};

export function EvalsSuiteListSidebar({
  suites,
  selectedSuiteId,
  onSelectSuite,
  onCreateSuite,
  isLoading = false,
  canDeleteSuites = false,
  onDeleteSuitesBatch,
  deleteInProgress = false,
  onRunAll,
  rerunningSuiteId = null,
  replayingRunId = null,
  runningTestCaseId = null,
}: EvalsSuiteListSidebarProps) {
  useTick();

  const [selectedForBatch, setSelectedForBatch] = useState<Set<string>>(
    () => new Set(),
  );
  const [showBatchDeleteModal, setShowBatchDeleteModal] = useState(false);
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);

  const batchDeleteEnabled = Boolean(canDeleteSuites && onDeleteSuitesBatch);
  const selectionBlocked = deleteInProgress || isBatchDeleting;

  useEffect(() => {
    const valid = new Set(suites.map((e) => e.suite._id));
    setSelectedForBatch((prev) => {
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size && [...next].every((id) => prev.has(id))
        ? prev
        : next;
    });
  }, [suites]);

  const toggleSuiteSelected = useCallback((suiteId: string) => {
    setSelectedForBatch((prev) => {
      const next = new Set(prev);
      if (next.has(suiteId)) {
        next.delete(suiteId);
      } else {
        next.add(suiteId);
      }
      return next;
    });
  }, []);

  const toggleAllSuites = useCallback(() => {
    if (suites.length === 0) {
      return;
    }
    setSelectedForBatch((prev) => {
      if (prev.size === suites.length) {
        return new Set();
      }
      return new Set(suites.map((e) => e.suite._id));
    });
  }, [suites]);

  const confirmBatchDeleteSuites = useCallback(async () => {
    if (!onDeleteSuitesBatch || selectedForBatch.size === 0) {
      return;
    }
    setIsBatchDeleting(true);
    try {
      await onDeleteSuitesBatch([...selectedForBatch]);
      setSelectedForBatch(new Set());
      setShowBatchDeleteModal(false);
    } finally {
      setIsBatchDeleting(false);
    }
  }, [onDeleteSuitesBatch, selectedForBatch]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-card text-card-foreground">
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border/50 px-5 py-4">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold text-foreground">
              Browse and open suites
            </p>
            <p className="text-xs text-muted-foreground">
              Click a row to see runs, test cases, and environment.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0 font-semibold"
            onClick={onCreateSuite}
          >
            <Plus className="h-3.5 w-3.5" />
            New suite
          </Button>
        </div>

        {isLoading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-16 text-center">
            <div
              className="h-8 w-8 animate-pulse rounded-full bg-muted"
              aria-hidden
            />
            <p className="text-sm font-medium text-muted-foreground">
              Loading suites…
            </p>
          </div>
        ) : suites.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
              <FlaskConical className="h-7 w-7 text-primary" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">
                No suites yet
              </p>
              <p className="max-w-xs text-xs text-muted-foreground">
                Create a suite to group test cases, runs, and environment
                config.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              className="font-semibold shadow-sm"
              onClick={onCreateSuite}
            >
              <Plus className="h-3.5 w-3.5" />
              Create your first suite
            </Button>
          </div>
        ) : (
          <>
            {batchDeleteEnabled ? (
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/40 px-5 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Checkbox
                    checked={
                      suites.length > 0 &&
                      selectedForBatch.size === suites.length
                    }
                    onCheckedChange={() => toggleAllSuites()}
                    aria-label="Select all suites"
                    disabled={suites.length === 0 || selectionBlocked}
                  />
                  <span className="truncate text-xs text-muted-foreground">
                    Select all
                  </span>
                </div>
                {selectedForBatch.size > 0 ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {selectedForBatch.size} selected
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 text-muted-foreground"
                      onClick={() => setSelectedForBatch(new Set())}
                      disabled={selectionBlocked}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      className="h-8"
                      onClick={() => setShowBatchDeleteModal(true)}
                      disabled={selectionBlocked}
                    >
                      Delete
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div className="flex flex-col gap-2">
                {suites.map((entry) => {
                  const suite = entry.suite;
                  const serverSummary =
                    suite.environment?.servers?.length > 0
                      ? suite.environment.servers.join(", ")
                      : "No servers configured";
                  const rowTitle = evalOverviewEntryOutcomeTitle(entry);
                  const isSelected = selectedSuiteId === suite._id;
                  const suiteTitle = suite.name || "Untitled suite";
                  const latestRun = entry.latestRun;
                  const showLastRunFailed =
                    latestRun != null &&
                    (latestRun.result === "failed" ||
                      latestRun.status === "failed");
                  const runAllBlocked = Boolean(
                    rerunningSuiteId ||
                      replayingRunId != null ||
                      runningTestCaseId != null,
                  );
                  const isThisSuiteRerunning = rerunningSuiteId === suite._id;

                  return (
                    <div
                      key={suite._id}
                      data-testid={`suite-row-${suite._id}`}
                      className={cn(
                        "group/row flex w-full min-w-0 items-center gap-3 rounded-lg border px-4 py-3 transition-colors",
                        isSelected
                          ? "border-primary/35 bg-primary/[0.06]"
                          : "border-border/60 bg-background hover:border-border hover:bg-muted/30",
                      )}
                    >
                      {batchDeleteEnabled ? (
                        <div className="flex shrink-0 items-center">
                          <Checkbox
                            checked={selectedForBatch.has(suite._id)}
                            onCheckedChange={() =>
                              toggleSuiteSelected(suite._id)
                            }
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Select suite ${suiteTitle}`}
                            disabled={selectionBlocked}
                          />
                        </div>
                      ) : null}
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`Select suite: ${suiteTitle}`}
                        title={`${rowTitle}\n${serverSummary}`}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
                        onClick={() => onSelectSuite(suite._id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectSuite(suite._id);
                          }
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {suiteTitle}
                        </span>
                        <div className="flex shrink-0 items-center gap-2">
                          {suiteLastRunCell(entry)}
                          <ChevronRight
                            className="h-4 w-4 shrink-0 text-muted-foreground/45 transition group-hover/row:translate-x-0.5 group-hover/row:text-primary"
                            aria-hidden
                          />
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-8 w-8 shrink-0 p-0"
                        aria-label={
                          onRunAll
                            ? `Run all cases in ${suiteTitle}`
                            : `Open suite: ${suiteTitle}`
                        }
                        aria-busy={onRunAll ? isThisSuiteRerunning : undefined}
                        disabled={onRunAll ? runAllBlocked : false}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (onRunAll) {
                            posthog.capture("run_all_cases_button_clicked", {
                              location: "suite_list_sidebar",
                              platform: detectPlatform(),
                              environment: detectEnvironment(),
                              suite_id: suite._id,
                            });
                            void onRunAll(suite);
                          } else {
                            onSelectSuite(suite._id);
                          }
                        }}
                      >
                        {onRunAll && isThisSuiteRerunning ? (
                          <Loader2
                            className="h-3.5 w-3.5 animate-spin"
                            aria-hidden
                          />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>

            <Dialog
              open={batchDeleteEnabled && showBatchDeleteModal}
              onOpenChange={(open) => {
                if (batchDeleteEnabled) {
                  setShowBatchDeleteModal(open);
                }
              }}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Trash2 className="h-5 w-5 text-destructive" />
                    Delete {selectedForBatch.size} suite
                    {selectedForBatch.size === 1 ? "" : "s"}
                  </DialogTitle>
                  <DialogDescription>
                    Are you sure you want to delete{" "}
                    {selectedForBatch.size === 1
                      ? "this suite"
                      : `these ${selectedForBatch.size} suites`}
                    ? This cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowBatchDeleteModal(false)}
                    disabled={isBatchDeleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void confirmBatchDeleteSuites()}
                    disabled={isBatchDeleting}
                  >
                    {isBatchDeleting ? "Deleting..." : "Delete"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </div>
    </div>
  );
}
