/**
 * The search box and server filter above Conformance History, the sortable
 * column headers inside it, and the rule that applies the search and sort to
 * the runs History has loaded.
 */
import { Input } from "@mcpjam/design-system/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { ArrowDownUp } from "lucide-react";
import { cn } from "@/lib/utils";

export type HistorySortKey = "server" | "score" | "date";
export type HistorySortDirection = "asc" | "desc";
export type HistorySort = {
  key: HistorySortKey;
  direction: HistorySortDirection;
};

/** The order the backend returns runs in: newest first. */
export const DEFAULT_HISTORY_SORT: HistorySort = {
  key: "date",
  direction: "desc",
};

/**
 * A column's first click sorts the way people usually read it: names A to Z,
 * the highest score and the newest date first.
 */
const FIRST_DIRECTION: Record<HistorySortKey, HistorySortDirection> = {
  server: "asc",
  score: "desc",
  date: "desc",
};

/** Clicking the sorted column flips it; clicking another one sorts by it. */
export function nextHistorySort(
  current: HistorySort,
  key: HistorySortKey,
): HistorySort {
  return current.key === key
    ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
    : { key, direction: FIRST_DIRECTION[key] };
}

/** The sort is the backend's own order, so pages can load one at a time. */
export function isBackendHistoryOrder(sort: HistorySort): boolean {
  return (
    sort.key === DEFAULT_HISTORY_SORT.key &&
    sort.direction === DEFAULT_HISTORY_SORT.direction
  );
}

const serverNameCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

/**
 * The runs a search and sort leave, in order. `texts` are what a search
 * matches; the other accessors are what each column sorts by. The sort is
 * stable, so runs that tie keep the newest-first order they arrived in, and
 * runs without a score stay last whichever way the score sorts.
 */
export function searchAndSortHistory<Run>(
  runs: Run[],
  {
    query,
    sort,
    texts,
    serverName,
    score,
    createdAt,
  }: {
    /** Already trimmed and lowercased; empty matches every run. */
    query: string;
    sort: HistorySort;
    texts: (run: Run) => string[];
    serverName: (run: Run) => string;
    score: (run: Run) => number | null;
    createdAt: (run: Run) => number;
  },
): Run[] {
  const matching = query
    ? runs.filter((run) =>
        texts(run).some((text) => text.toLowerCase().includes(query)),
      )
    : runs;
  if (isBackendHistoryOrder(sort)) return matching;

  const sign = sort.direction === "asc" ? 1 : -1;
  const compare = (a: Run, b: Run): number => {
    switch (sort.key) {
      case "server":
        return sign * serverNameCollator.compare(serverName(a), serverName(b));
      case "score": {
        const left = score(a);
        const right = score(b);
        if (left == null || right == null) {
          return left == null ? (right == null ? 0 : 1) : -1;
        }
        return sign * (left - right);
      }
      case "date":
        return sign * (createdAt(a) - createdAt(b));
    }
  };
  return [...matching].sort(compare);
}

const filterTriggerClass = "h-8 w-auto min-w-0 shrink-0 gap-1.5 px-2.5 text-xs";

/**
 * Search takes the row's width and the server filter sits at its right end.
 * Sorting lives on the column headers ({@link HistorySortHeader}).
 */
export function ConformanceHistoryFilters({
  search,
  onSearchChange,
  serverFilter,
  onServerFilterChange,
  serverNames,
}: {
  search: string;
  onSearchChange: (search: string) => void;
  /** A saved server's id, or null for every server. */
  serverFilter: string | null;
  onServerFilterChange: (serverId: string | null) => void;
  /** Saved server id → display name: the filter's options. */
  serverNames?: ReadonlyMap<string, string>;
}) {
  const serverOptions = [...(serverNames ?? new Map<string, string>())].sort(
    ([, a], [, b]) => serverNameCollator.compare(a, b),
  );

  return (
    <div className="flex items-center gap-2">
      <Input
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder="Search runs…"
        aria-label="Search runs"
        className="h-8 min-w-0 flex-1"
        data-testid="conformance-history-search"
      />
      <Select
        value={serverFilter ?? "all"}
        onValueChange={(value) =>
          onServerFilterChange(value === "all" ? null : value)
        }
      >
        <SelectTrigger
          data-testid="conformance-history-server-filter"
          className={filterTriggerClass}
          aria-label="Filter runs by server"
        >
          <SelectValue placeholder="Servers" />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="all">All servers</SelectItem>
          {serverOptions.map(([id, name]) => (
            <SelectItem key={id} value={id}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The same up-and-down arrow on every sortable column: full strength on the
 * sorted one, faint on the rest, and MCPJam orange while hovered.
 */
function SortIcon({ active }: { active: boolean }) {
  return (
    <ArrowDownUp
      aria-hidden
      className={cn(
        "size-4 shrink-0 transition-colors group-hover:text-primary",
        active ? "text-foreground" : "text-muted-foreground/50",
      )}
    />
  );
}

/** A History column header that sorts the table by its column on click. */
export function HistorySortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: HistorySortKey;
  sort: HistorySort;
  onSort: (sort: HistorySort) => void;
  className?: string;
}) {
  const direction = sort.key === sortKey ? sort.direction : null;
  const name = label.charAt(0) + label.slice(1).toLowerCase();
  return (
    <button
      type="button"
      onClick={() => onSort(nextHistorySort(sort, sortKey))}
      aria-label={
        direction === "asc"
          ? `${name}, sorted ascending`
          : direction === "desc"
            ? `${name}, sorted descending`
            : `Sort by ${name.toLowerCase()}`
      }
      className={cn(
        "group flex w-fit min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-primary",
        className,
      )}
      data-testid={`conformance-history-sort-${sortKey}`}
      data-sort-direction={direction ?? undefined}
    >
      <span className="truncate">{label}</span>
      <SortIcon active={direction !== null} />
    </button>
  );
}
