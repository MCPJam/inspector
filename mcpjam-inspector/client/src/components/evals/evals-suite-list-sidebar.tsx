import { useCallback, useEffect, useState } from "react";
import { CircleAlert, FlaskConical, Play, Plus, Trash2 } from "lucide-react";
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
import type { EvalSuiteOverviewEntry } from "./types";
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
      <span className="text-xs text-muted-foreground text-right tabular-nums">
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
      <div className="rounded-xl border bg-card text-card-foreground flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="border-b px-4 py-2 shrink-0 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground min-w-0">
            Click a suite to open runs, test cases, and environment.
          </p>
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0"
            onClick={onCreateSuite}
          >
            <Plus className="h-3.5 w-3.5" />
            New suite
          </Button>
        </div>

        {isLoading ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            Loading suites...
          </div>
        ) : suites.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-12 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <FlaskConical className="h-5 w-5" />
            </div>
            <p className="text-sm text-muted-foreground">No suites yet.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCreateSuite}
            >
              Create your first suite
            </Button>
          </div>
        ) : (
          <>
            <div className="border-b px-4 py-2 shrink-0 flex items-center justify-between gap-3 bg-muted/50">
              <div className="flex items-center gap-3 min-w-0">
                <Checkbox
                  checked={
                    suites.length > 0 &&
                    selectedForBatch.size === suites.length
                  }
                  onCheckedChange={() => toggleAllSuites()}
                  aria-label="Select all suites"
                  disabled={suites.length === 0 || selectionBlocked}
                />
                <span className="text-xs font-medium truncate">
                  Select all
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {selectedForBatch.size > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {selectedForBatch.size} selected
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedForBatch(new Set())}
                  disabled={
                    selectionBlocked || selectedForBatch.size === 0
                  }
                >
                  Cancel
                </Button>
                {batchDeleteEnabled ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => setShowBatchDeleteModal(true)}
                    disabled={
                      selectionBlocked || selectedForBatch.size === 0
                    }
                  >
                    Delete
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="flex w-full items-center gap-2 border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground">
              <div className="flex w-7 shrink-0 justify-center" aria-hidden />
              <div className="min-w-0 flex-1">Suite name</div>
              <div className="flex max-w-[min(100%,20rem)] flex-1 min-w-0 items-center justify-end gap-2">
                <span className="text-right">Last run</span>
                <span className="w-3.5 shrink-0" aria-hidden />
              </div>
              <div className="w-7 shrink-0" aria-hidden />
            </div>

            <div className="min-h-0 flex-1 divide-y overflow-y-auto">
              {suites.map((entry) => {
                const suite = entry.suite;
                const serverSummary =
                  suite.environment?.servers?.length > 0
                    ? suite.environment.servers.join(", ")
                    : "No servers configured";
                const rowTitle = evalOverviewEntryOutcomeTitle(entry);
                const showLastRunFailed =
                  entry.latestRun?.result === "failed" ||
                  entry.latestRun?.status === "failed";
                const isSelected = selectedSuiteId === suite._id;
                const suiteTitle = suite.name || "Untitled suite";

                return (
                  <div
                    key={suite._id}
                    data-testid={`suite-row-${suite._id}`}
                    className={cn(
                      "flex w-full items-center gap-2 px-4 py-2.5 transition-colors hover:bg-muted/50",
                      isSelected && "bg-muted/60",
                    )}
                  >
                    <div className="flex w-7 shrink-0 justify-center">
                      <Checkbox
                        checked={selectedForBatch.has(suite._id)}
                        onCheckedChange={() => toggleSuiteSelected(suite._id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select suite ${suiteTitle}`}
                        disabled={selectionBlocked}
                      />
                    </div>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-label={`Select suite: ${suiteTitle}`}
                      title={`${rowTitle}\n${serverSummary}`}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      onClick={() => onSelectSuite(suite._id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectSuite(suite._id);
                        }
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
                        {suiteTitle}
                      </span>
                      <div className="flex max-w-[min(100%,20rem)] flex-1 min-w-0 items-center justify-end gap-2">
                        {suiteLastRunCell(entry)}
                        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                          {showLastRunFailed ? (
                            <CircleAlert
                              className="h-3.5 w-3.5 text-destructive"
                              aria-label="Last run failed"
                            />
                          ) : null}
                        </span>
                      </div>
                    </div>
                    <span className="inline-flex shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        aria-label={`Open suite: ${suiteTitle}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onSelectSuite(suite._id);
                        }}
                      >
                        <Play className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </div>
                );
              })}
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
