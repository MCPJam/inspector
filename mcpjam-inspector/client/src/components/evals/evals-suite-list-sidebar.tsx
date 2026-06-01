import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlaskConical,
  Loader2,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
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
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type { EvalSuite, EvalSuiteOverviewEntry } from "./types";
import {
  evalOverviewEntryMiniBarClass,
  evalOverviewEntryOutcomeTitle,
  getEffectiveSuiteServers,
} from "./helpers";
import {
  SuiteOverviewStatusIcon,
  SuiteSourceBadge,
  collectSuiteTags,
  formatOverviewRelativeTime,
  formatServerChipSummary,
  getSuitePassFailCounts,
  sortSuiteOverviewEntries,
  stripTimestampSuffix,
  type SuiteListSortKey,
} from "./suite-overview-presentation";
import { cn } from "@/lib/utils";
import {
  EVAL_DESTRUCTIVE_BUTTON_CLASS,
  EVAL_LOW_PASS_RATE_TEXT_CLASS,
} from "./constants";

function useTick(intervalMs = 60_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
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

const SUITE_ROW_GRID =
  "grid w-full min-w-0 items-center gap-x-3 [grid-template-columns:minmax(0,1fr)_3.5rem_minmax(0,0.85fr)_2rem]";

function suiteRowStatusLabel(entry: EvalSuiteOverviewEntry): string {
  const latestRun = entry.latestRun;
  if (!latestRun) {
    return "—";
  }
  if (
    latestRun.status === "running" ||
    latestRun.status === "pending"
  ) {
    return "Run";
  }
  const counts = getSuitePassFailCounts(entry);
  if (!counts) {
    return "—";
  }
  return `${counts.passed}/${counts.total}`;
}

function SuiteListHeader({
  suiteSearch,
  onSuiteSearchChange,
  failuresOnly,
  onFailuresOnlyChange,
  allTags,
  filterTag,
  onFilterTagChange,
  sortKey,
  onSortKeyChange,
  onCreateSuite,
}: {
  suiteSearch: string;
  onSuiteSearchChange: (value: string) => void;
  failuresOnly: boolean;
  onFailuresOnlyChange: (value: boolean) => void;
  allTags: string[];
  filterTag: string | null;
  onFilterTagChange: (tag: string | null) => void;
  sortKey: SuiteListSortKey;
  onSortKeyChange: (key: SuiteListSortKey) => void;
  onCreateSuite: () => void;
}) {
  const activeFilterCount =
    (failuresOnly ? 1 : 0) +
    (filterTag ? 1 : 0) +
    (sortKey !== "severity" ? 1 : 0);

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2.5">
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          placeholder="Search suites…"
          value={suiteSearch}
          onChange={(e) => onSuiteSearchChange(e.target.value)}
          className="h-8 w-full pl-8 text-xs"
          aria-label="Search suites"
        />
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="relative h-8 w-8 shrink-0"
            aria-label="Suite filters"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {activeFilterCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold text-primary-foreground">
                {activeFilterCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 space-y-3 p-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="suite-failures-only"
              checked={failuresOnly}
              onCheckedChange={(checked) =>
                onFailuresOnlyChange(checked === true)
              }
            />
            <Label
              htmlFor="suite-failures-only"
              className="cursor-pointer text-xs font-normal"
            >
              Failures only
            </Label>
          </div>

          {allTags.length > 0 ? (
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Tag</Label>
              <Select
                value={filterTag ?? "__all__"}
                onValueChange={(value) =>
                  onFilterTagChange(value === "__all__" ? null : value)
                }
              >
                <SelectTrigger
                  className="h-8 w-full text-xs"
                  aria-label="Filter by tag"
                >
                  <SelectValue placeholder="All tags" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All tags</SelectItem>
                  {allTags.map((tag) => (
                    <SelectItem key={tag} value={tag}>
                      {tag}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground">Sort</Label>
            <Select
              value={sortKey}
              onValueChange={(value) =>
                onSortKeyChange(value as SuiteListSortKey)
              }
            >
              <SelectTrigger
                className="h-8 w-full text-xs"
                aria-label="Sort suites"
              >
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="severity">Most failing first</SelectItem>
                <SelectItem value="recently_run">Recently run</SelectItem>
                <SelectItem value="pass_rate">Pass rate</SelectItem>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="most_failing">Most failures</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </PopoverContent>
      </Popover>

      <Button
        type="button"
        size="sm"
        className="h-8 shrink-0 px-2.5 font-semibold"
        onClick={onCreateSuite}
        aria-label="New suite"
      >
        <Plus className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">New</span>
      </Button>
    </div>
  );
}

function SuiteTableHeader({
  batchDeleteEnabled,
  allVisibleSelected,
  visibleCount,
  selectionBlocked,
  onToggleAll,
  selectedCount,
  onClearSelection,
  onDeleteSelected,
}: {
  batchDeleteEnabled: boolean;
  allVisibleSelected: boolean;
  visibleCount: number;
  selectionBlocked: boolean;
  onToggleAll: () => void;
  selectedCount: number;
  onClearSelection: () => void;
  onDeleteSelected: () => void;
}) {
  const gridClass = batchDeleteEnabled
    ? cn(
        SUITE_ROW_GRID,
        "[grid-template-columns:1.25rem_minmax(0,1fr)_3.5rem_minmax(0,0.85fr)_2rem]",
      )
    : SUITE_ROW_GRID;

  return (
    <div className="sticky top-0 z-[1] shrink-0 border-b border-border/40 bg-card/95 px-4 py-2 backdrop-blur-sm">
      <div className={gridClass}>
        {batchDeleteEnabled ? (
          <Checkbox
            checked={visibleCount > 0 && allVisibleSelected}
            onCheckedChange={() => onToggleAll()}
            aria-label="Select all suites"
            disabled={visibleCount === 0 || selectionBlocked}
            className="justify-self-start"
          />
        ) : null}
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
          Suite
        </span>
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
          Score
        </span>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
            Last run
          </span>
          {batchDeleteEnabled && selectedCount > 0 ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {selectedCount} selected
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground"
                onClick={onClearSelection}
                disabled={selectionBlocked}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className={cn(
                  "h-6 px-2 text-[11px]",
                  EVAL_DESTRUCTIVE_BUTTON_CLASS,
                )}
                onClick={onDeleteSelected}
                disabled={selectionBlocked}
              >
                Delete
              </Button>
            </div>
          ) : null}
        </div>
        <span className="sr-only">Actions</span>
      </div>
    </div>
  );
}

function SuiteOverviewRow({
  entry,
  isSelected,
  batchDeleteEnabled,
  isChecked,
  onToggleChecked,
  selectionBlocked,
  onSelectSuite,
  onRunAll,
  runAllBlocked,
  isThisSuiteRerunning,
}: {
  entry: EvalSuiteOverviewEntry;
  isSelected: boolean;
  batchDeleteEnabled: boolean;
  isChecked: boolean;
  onToggleChecked: () => void;
  selectionBlocked: boolean;
  onSelectSuite: (suiteId: string) => void;
  onRunAll?: (suite: EvalSuite) => void | Promise<void>;
  runAllBlocked: boolean;
  isThisSuiteRerunning: boolean;
}) {
  const suite = entry.suite;
  const suiteTitle =
    stripTimestampSuffix(suite.name || "") || "Untitled suite";
  const servers = getEffectiveSuiteServers(suite);
  const serverSummary = formatServerChipSummary(servers);
  const rowTitle = evalOverviewEntryOutcomeTitle(entry);
  const statusLabel = suiteRowStatusLabel(entry);
  const latestRun = entry.latestRun;
  const lastRunTimestamp = latestRun
    ? (latestRun.completedAt ?? latestRun.createdAt)
    : undefined;
  const runCount = entry.totals.runs;
  const statusStripeClass = evalOverviewEntryMiniBarClass(entry);

  const lastRunParts: string[] = [];
  if (servers.length > 0) {
    lastRunParts.push(serverSummary);
  }
  if (runCount > 0) {
    lastRunParts.push(`${runCount} run${runCount === 1 ? "" : "s"}`);
  }
  if (lastRunTimestamp) {
    lastRunParts.push(formatOverviewRelativeTime(lastRunTimestamp));
  }

  const gridClass = batchDeleteEnabled
    ? cn(
        SUITE_ROW_GRID,
        "[grid-template-columns:1.25rem_minmax(0,1fr)_3.5rem_minmax(0,0.85fr)_2rem]",
      )
    : SUITE_ROW_GRID;

  return (
    <div
      data-testid={`suite-row-${suite._id}`}
      className={cn(
        "group/row relative overflow-hidden rounded-md border transition-colors",
        isSelected
          ? "border-primary/35 bg-primary/[0.05]"
          : "border-transparent hover:border-border/60 hover:bg-muted/25",
      )}
    >
      <div
        className={cn(
          "absolute bottom-0 left-0 top-0 w-0.5",
          statusStripeClass,
        )}
        aria-hidden
      />

      <div className={cn(gridClass, "px-3 py-2")}>
        {batchDeleteEnabled ? (
          <Checkbox
            checked={isChecked}
            onCheckedChange={() => onToggleChecked()}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select suite ${suiteTitle}`}
            disabled={selectionBlocked}
            className="justify-self-start"
          />
        ) : null}

        <button
          type="button"
          aria-label={`Select suite: ${suiteTitle}`}
          title={`${rowTitle}\n${servers.length > 0 ? servers.join(", ") : "No servers configured"}`}
          className="flex min-w-0 cursor-pointer items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1"
          onClick={() => onSelectSuite(suite._id)}
        >
          <SuiteOverviewStatusIcon entry={entry} className="h-3.5 w-3.5" />
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {suiteTitle}
          </span>
          <SuiteSourceBadge source={suite.source} />
        </button>

        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="cursor-pointer text-left font-mono text-xs tabular-nums text-muted-foreground focus:outline-none"
          onClick={() => onSelectSuite(suite._id)}
        >
          {statusLabel}
        </button>

        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="min-w-0 cursor-pointer truncate text-left text-[11px] text-muted-foreground focus:outline-none"
          onClick={() => onSelectSuite(suite._id)}
        >
          {lastRunParts.length > 0
            ? lastRunParts.join(" · ")
            : servers.length === 0
              ? "No servers"
              : "—"}
        </button>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0 opacity-70 transition group-hover/row:opacity-100"
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
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

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
  const [suiteSearch, setSuiteSearch] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SuiteListSortKey>("severity");

  const batchDeleteEnabled = Boolean(canDeleteSuites && onDeleteSuitesBatch);
  const selectionBlocked = deleteInProgress || isBatchDeleting;
  const allTags = useMemo(() => collectSuiteTags(suites), [suites]);

  const visibleSuites = useMemo(() => {
    let list = [...suites];

    if (filterTag) {
      list = list.filter((entry) => entry.suite.tags?.includes(filterTag));
    }

    if (suiteSearch.trim()) {
      const query = suiteSearch.trim().toLowerCase();
      list = list.filter((entry) =>
        (entry.suite.name || "").toLowerCase().includes(query),
      );
    }

    if (failuresOnly) {
      list = list.filter(
        (entry) =>
          entry.latestRun?.result === "failed" || !entry.latestRun,
      );
    }

    return sortSuiteOverviewEntries(list, sortKey);
  }, [suites, filterTag, suiteSearch, failuresOnly, sortKey]);

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
    if (visibleSuites.length === 0) {
      return;
    }
    setSelectedForBatch((prev) => {
      const visibleIds = visibleSuites.map((e) => e.suite._id);
      const allVisibleSelected = visibleIds.every((id) => prev.has(id));
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const id of visibleIds) {
          next.delete(id);
        }
        return next;
      }
      return new Set([...prev, ...visibleIds]);
    });
  }, [visibleSuites]);

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

  const runAllBlocked = Boolean(
    rerunningSuiteId || replayingRunId != null || runningTestCaseId != null,
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/60 bg-card text-card-foreground">
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
            <SuiteListHeader
              suiteSearch={suiteSearch}
              onSuiteSearchChange={setSuiteSearch}
              failuresOnly={failuresOnly}
              onFailuresOnlyChange={setFailuresOnly}
              allTags={allTags}
              filterTag={filterTag}
              onFilterTagChange={setFilterTag}
              sortKey={sortKey}
              onSortKeyChange={setSortKey}
              onCreateSuite={onCreateSuite}
            />

            <SuiteTableHeader
              batchDeleteEnabled={batchDeleteEnabled}
              allVisibleSelected={
                visibleSuites.length > 0 &&
                visibleSuites.every((entry) =>
                  selectedForBatch.has(entry.suite._id),
                )
              }
              visibleCount={visibleSuites.length}
              selectionBlocked={selectionBlocked}
              onToggleAll={toggleAllSuites}
              selectedCount={selectedForBatch.size}
              onClearSelection={() => setSelectedForBatch(new Set())}
              onDeleteSelected={() => setShowBatchDeleteModal(true)}
            />

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              {visibleSuites.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                  <p className="text-sm font-medium text-foreground">
                    No suites match your filters
                  </p>
                  <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                    Try clearing search, tag, or failures-only filters.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {visibleSuites.map((entry) => {
                    const suite = entry.suite;
                    const isSelected = selectedSuiteId === suite._id;
                    const isThisSuiteRerunning =
                      rerunningSuiteId === suite._id;

                    return (
                      <SuiteOverviewRow
                        key={suite._id}
                        entry={entry}
                        isSelected={isSelected}
                        batchDeleteEnabled={batchDeleteEnabled}
                        isChecked={selectedForBatch.has(suite._id)}
                        onToggleChecked={() => toggleSuiteSelected(suite._id)}
                        selectionBlocked={selectionBlocked}
                        onSelectSuite={onSelectSuite}
                        onRunAll={onRunAll}
                        runAllBlocked={runAllBlocked}
                        isThisSuiteRerunning={isThisSuiteRerunning}
                      />
                    );
                  })}
                </div>
              )}
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
                    <Trash2
                      className={cn("h-5 w-5", EVAL_LOW_PASS_RATE_TEXT_CLASS)}
                    />
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
                    className={EVAL_DESTRUCTIVE_BUTTON_CLASS}
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
