import { useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  useGoalOutcomeDrilldown,
  type SessionOutcome,
} from "@/hooks/useUsageInsights";
import {
  chipKey,
  outcomeChipValue,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";

/**
 * Sessions behind one goal × outcome cell.
 *
 * Paged server-side. The cell shows an exact count and this list has to be able
 * to reach all of it, which the insights list's fixed 100-row fetch plus a
 * client-side filter could not do — it would silently show a subset whose total
 * disagreed with the number the user clicked.
 */
const PAGE_SIZE = 25;

type DrilldownRow = {
  _id: string;
  firstMessagePreview?: string;
  lastActivityAt: number;
};

interface ChatboxGoalOutcomeDrilldownProps {
  chatboxId: string;
  cell: {
    clusterId: string;
    clusterLabel?: string;
    outcome: SessionOutcome | null;
  } | null;
  /** Other active facet chips, applied on top of the cell selection. */
  filter: UsageFilterState;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

function outcomeLabel(outcome: SessionOutcome | null): string {
  return outcome === null ? "not analyzed" : outcome;
}

/**
 * Identity of everything the paged request depends on: the chatbox, the cell,
 * and the other active facet chips.
 *
 * The filters belong in the key because they are part of the query. Keying on
 * the cell alone means changing an unrelated chip while a cell is open keeps the
 * old cursor and the already-accumulated rows — so the list would show sessions
 * the current filter excludes and would start from page two of a set that no
 * longer exists.
 */
function requestKeyOf(
  chatboxId: string,
  cell: ChatboxGoalOutcomeDrilldownProps["cell"],
  filter: UsageFilterState
): string | null {
  if (!cell) return null;
  // Chip order is not semantically meaningful, so sort for a stable key.
  const chips = filter.chips.map(chipKey).sort().join(",");
  return [
    chatboxId,
    cell.clusterId,
    outcomeChipValue(cell.outcome),
    filter.preset,
    chips,
  ].join("|");
}

type PagingState = {
  requestKey: string | null;
  before?: number;
  rows: DrilldownRow[];
  /**
   * Last known values from a settled query. Advancing the cursor makes the
   * subscription return `undefined` again, and without these the header would
   * flip back to "Loading…" and the pager would vanish from under the cursor on
   * every click. Replaced only when fresh data arrives.
   */
  lastTotal?: number;
  lastTotalTruncated?: boolean;
  lastNextBefore?: number | null;
};

/**
 * The pager's cursor for this render.
 *
 * NOT a `??` chain over the live value: a settled page reports "no more rows"
 * AS `nextBefore: null`, so coalescing on null would fall back to the previous
 * page's cursor and keep rendering "Load more" for a paint after the set is
 * exhausted — the settled null is an answer, not a gap. The last settled cursor
 * is a fallback only while the next page is in flight (live result undefined).
 */
export function resolveNextBefore(
  live: { nextBefore: number | null } | undefined,
  lastSettled: number | null | undefined,
): number | null {
  return live !== undefined ? live.nextBefore : (lastSettled ?? null);
}

export function ChatboxGoalOutcomeDrilldown({
  chatboxId,
  cell,
  filter,
  onClose,
  onOpenSession,
}: ChatboxGoalOutcomeDrilldownProps) {
  const requestKey = requestKeyOf(chatboxId, cell, filter);

  // Cursor + accumulated pages, stored TOGETHER WITH the request they belong to.
  // Resetting in an effect instead would leave one render where the query runs
  // with the new request but the previous one's cursor, and the accumulate
  // effect could merge the old rows into the new list.
  const [paging, setPaging] = useState<PagingState>({
    requestKey: null,
    rows: [],
  });

  // React's documented "adjust state when props change" pattern: reset during
  // render, conditionally, so the reset is visible to the query below on this
  // very render rather than one render late.
  const active: PagingState =
    paging.requestKey === requestKey
      ? paging
      : { requestKey, before: undefined, rows: [] };
  if (paging.requestKey !== requestKey) {
    setPaging(active);
  }

  const { drilldown, isLoading } = useGoalOutcomeDrilldown({
    chatboxId,
    clusterId: cell?.clusterId ?? null,
    outcome: cell?.outcome,
    filters: filter,
    limit: PAGE_SIZE,
    before: active.before,
    enabled: cell !== null,
  });

  useEffect(() => {
    if (!drilldown) return;
    setPaging((prev) => {
      // A result that arrives after the request changed belongs to neither
      // list; drop it rather than appending it to the wrong one.
      if (prev.requestKey !== requestKey) return prev;
      const seen = new Set(prev.rows.map((row) => row._id));
      const fresh = drilldown.sessions.filter((row) => !seen.has(row._id));
      return {
        ...prev,
        rows: fresh.length === 0 ? prev.rows : [...prev.rows, ...fresh],
        lastTotal: drilldown.total,
        lastTotalTruncated: drilldown.totalTruncated,
        lastNextBefore: drilldown.nextBefore,
      };
    });
  }, [requestKey, drilldown]);

  if (!cell) return null;

  const rows = active.rows;
  // Prefer live data; fall back to the last settled values so paging does not
  // blank the header and the pager mid-click.
  const total = drilldown?.total ?? active.lastTotal;
  const totalTruncated =
    drilldown?.totalTruncated ?? active.lastTotalTruncated ?? false;
  const nextBefore = resolveNextBefore(drilldown, active.lastNextBefore);
  const showEmpty = !isLoading && drilldown !== undefined && rows.length === 0;

  return (
    <div className="flex flex-col gap-2 border-b bg-muted/20 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium">
            {cell.clusterLabel ?? "Goal"} &middot; {outcomeLabel(cell.outcome)}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            {total === undefined
              ? "Loading sessions…"
              : `${total.toLocaleString()}${totalTruncated ? "+" : ""} session${
                  total === 1 ? "" : "s"
                } in this cell`}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close cell drill-down"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {totalTruncated ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            The count above stops at the scan limit; this cell has at least that
            many sessions.
          </span>
        </div>
      ) : null}

      <ul className="divide-y divide-border/60">
        {rows.map((session) => (
          <li key={session._id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 py-1.5 text-left text-xs hover:text-primary"
              onClick={() => onOpenSession(session._id)}
            >
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {session.firstMessagePreview?.trim() || "(no preview)"}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {new Date(session.lastActivityAt).toLocaleDateString()}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {nextBefore != null ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            setPaging((prev) =>
              prev.requestKey === requestKey
                ? { ...prev, before: nextBefore ?? undefined }
                : prev
            )
          }
        >
          Load {PAGE_SIZE} more
        </Button>
      ) : null}

      {showEmpty ? (
        <p className="text-[11px] text-muted-foreground">
          No sessions match this cell with the current filters.
        </p>
      ) : null}
    </div>
  );
}
