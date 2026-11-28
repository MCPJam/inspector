/**
 * The Conformance History table: sortable Server, Score and Date headers over
 * one row per run. A row opens the run's detail page.
 */
import type { ConformanceRunListItem } from "./ConformanceHistory";
import {
  HistorySortHeader,
  type HistorySort,
} from "./ConformanceHistoryFilters";
import { RunResultRing } from "./RunResultRing";

/** Where a run came from, in the words the History table uses. */
export const HISTORY_SOURCE_LABEL: Record<string, string> = {
  ui: "UI",
  sdk: "SDK",
  cli: "CLI",
  github_action: "GitHub",
  github_app: "GitHub",
  api: "API",
};

export const historyDateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const header = "text-[11px] font-semibold tracking-[0.06em] text-foreground";
const columns =
  "grid w-full grid-cols-[minmax(0,1.8fr)_repeat(6,minmax(0,1fr))] items-center gap-x-4";
const cell = "min-w-0 truncate";

export function ConformanceHistoryTable({
  rows,
  sort,
  onSort,
  loading,
  dimmed,
  serverLabel,
  onOpenRun,
}: {
  rows: ConformanceRunListItem[];
  sort: HistorySort;
  onSort: (sort: HistorySort) => void;
  /** History is reading every run: the sorted header spins. */
  loading: boolean;
  /** The rows are the last complete order, held until the new one is in. */
  dimmed: boolean;
  serverLabel: (run: ConformanceRunListItem) => string;
  onOpenRun: (runId: string) => void;
}) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-card"
      aria-busy={loading || undefined}
    >
      <div className={`${columns} bg-muted/60 px-4.5 py-2`}>
        <HistorySortHeader
          label="SERVER"
          sortKey="server"
          sort={sort}
          onSort={onSort}
          loading={loading}
          className={header}
        />
        <span className={`${cell} ${header}`}>PROTOCOL</span>
        <HistorySortHeader
          label="SCORE"
          sortKey="score"
          sort={sort}
          onSort={onSort}
          loading={loading}
          className={header}
        />
        <span className={`${cell} ${header}`}>CHECKS</span>
        <span className={`${cell} ${header}`}>RESULT</span>
        <HistorySortHeader
          label="DATE"
          sortKey="date"
          sort={sort}
          onSort={onSort}
          loading={loading}
          className={header}
        />
        <span className={`${cell} ${header}`}>SOURCE</span>
      </div>
      <ul className={`transition-opacity ${dimmed ? "opacity-60" : ""}`}>
        {rows.map((run) => (
          <li
            key={run._id}
            className="border-t border-border/60 first:border-t-0"
          >
            <button
              type="button"
              className={`${columns} bg-popover px-4.5 py-3.5 text-left text-popover-foreground transition-colors hover:bg-muted/30`}
              data-testid="conformance-history-row"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenRun(run._id);
              }}
            >
              <span className={`${cell} text-sm font-semibold`}>
                {serverLabel(run)}
              </span>
              <span className={`${cell} text-[13px] text-muted-foreground`}>
                {run.protocolVersion ?? "Auto"}
              </span>
              <span
                className={`${cell} text-sm tabular-nums ${
                  run.score == null ? "text-muted-foreground" : ""
                }`}
              >
                {run.score == null ? "—" : `${run.score}%`}
              </span>
              <span className={`${cell} text-sm font-semibold tabular-nums`}>
                {run.passed}/{run.applicable}
              </span>
              <span className="flex min-w-0 items-center">
                <RunResultRing run={run} />
              </span>
              <span className="whitespace-nowrap text-[13px] text-muted-foreground">
                {historyDateFormat.format(run.createdAt)}
              </span>
              <span className={`${cell} text-[13px] text-muted-foreground`}>
                {HISTORY_SOURCE_LABEL[run.source] ?? run.source}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
