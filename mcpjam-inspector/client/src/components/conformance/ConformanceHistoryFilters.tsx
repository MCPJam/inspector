/**
 * The search box, server filter and sort above Conformance History, laid out
 * like the Swarms sessions filters, and the rule that applies the search and
 * sort to the runs History has loaded.
 */
import { Input } from "@mcpjam/design-system/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";

export type HistorySort = "newest" | "server";

const serverNameCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

/**
 * The runs a search and sort leave, in order. `texts` are what a search
 * matches; `serverName` is what the name sort orders by. The sort is stable,
 * so each server's runs keep the newest-first order they arrived in.
 */
export function searchAndSortHistory<Run>(
  runs: Run[],
  {
    query,
    sort,
    texts,
    serverName,
  }: {
    /** Already trimmed and lowercased; empty matches every run. */
    query: string;
    sort: HistorySort;
    texts: (run: Run) => string[];
    serverName: (run: Run) => string;
  },
): Run[] {
  const matching = query
    ? runs.filter((run) =>
        texts(run).some((text) => text.toLowerCase().includes(query)),
      )
    : runs;
  return sort === "server"
    ? [...matching].sort((a, b) =>
        serverNameCollator.compare(serverName(a), serverName(b)),
      )
    : matching;
}

const filterTriggerClass = "h-8 w-auto min-w-0 gap-1.5 px-2.5 text-xs";

export function ConformanceHistoryFilters({
  search,
  onSearchChange,
  serverFilter,
  onServerFilterChange,
  serverNames,
  sort,
  onSortChange,
}: {
  search: string;
  onSearchChange: (search: string) => void;
  /** A saved server's id, or null for every server. */
  serverFilter: string | null;
  onServerFilterChange: (serverId: string | null) => void;
  /** Saved server id → display name: the filter's options. */
  serverNames?: ReadonlyMap<string, string>;
  sort: HistorySort;
  onSortChange: (sort: HistorySort) => void;
}) {
  const serverOptions = [...(serverNames ?? new Map<string, string>())].sort(
    ([, a], [, b]) => serverNameCollator.compare(a, b),
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder="Search runs…"
        aria-label="Search runs"
        className="h-8 min-w-0 flex-1 basis-56 sm:max-w-xs"
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
        <SelectContent>
          <SelectItem value="all">All servers</SelectItem>
          {serverOptions.map(([id, name]) => (
            <SelectItem key={id} value={id}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={sort}
        onValueChange={(value) => {
          if (value === "newest" || value === "server") onSortChange(value);
        }}
      >
        <SelectTrigger
          data-testid="conformance-history-sort"
          className={filterTriggerClass}
          aria-label="Sort runs"
        >
          <SelectValue placeholder="Sort" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="newest">Newest first</SelectItem>
          <SelectItem value="server">Server name</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
