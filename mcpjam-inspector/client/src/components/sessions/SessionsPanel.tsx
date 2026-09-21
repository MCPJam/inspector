/**
 * The cross-surface Sessions page — every transcript in the project
 * (Playground, User Testing, Evals, Swarms) in one recency feed, with
 * server-side sourceType/status filters and relevance-ranked title search.
 *
 * Mirrors the Swarms Sessions layout (list + detail split); the data layer is
 * the unified backend feed (`sessionsFeed:*`, see `@/lib/sessions-feed-api`)
 * rather than a per-surface query. Unlike the client-side-filter convention in
 * `project-runs-table.tsx`, the sourceType/status filters here are QUERY ARGS:
 * the backend built `by_project_sourceType_status`-family indexes for exactly
 * these, so pushing them down changes which index serves the page instead of
 * hiding loaded rows.
 *
 * Row-level visibility is the backend's job (`canViewSessionInProject`):
 * other members' private Playground sessions never reach this client, so the
 * panel renders whatever the page contains without re-deriving policy.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare, Search } from "lucide-react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { ScrollArea } from "@mcpjam/design-system/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import { SessionReadinessBadge } from "@/components/scenarios/session-readiness";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { cn } from "@/lib/utils";
import {
  buildSessionsPath,
  useAppNavigate,
  useCurrentSearchParam,
} from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/scenario-session";
import {
  SESSIONS_FEED_PAGE_SIZE,
  SESSIONS_FEED_QUERIES,
  SESSION_SOURCE_TYPE_LABELS,
  sessionOriginChipLabel,
  sessionParentChipLabel,
  type SessionFeedItem,
  type SessionFeedSourceType,
} from "@/lib/sessions-feed-api";

const SOURCE_TYPE_PILLS: SessionFeedSourceType[] = [
  "direct",
  "scenario",
  "eval",
  "swarm",
];

type StatusFilter = "all" | "active" | "archived";

/** Keystroke → query settle delay for the search subscription. */
const SEARCH_DEBOUNCE_MS = 250;

export function SessionsPanel({ projectId }: { projectId: string }) {
  const [sourceFilter, setSourceFilter] = useState<Set<SessionFeedSourceType>>(
    new Set()
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Selection lives in the URL, not in component state. `/sessions?session=…`
  // is the backend's universal permalink fallback (every `/v1/sessions` item
  // carries a `link`), so arriving at one must open that session — which local
  // state cannot do. It also makes the selection shareable and survivable
  // across a reload, and gives Back/Forward the meaning a reader expects.
  const navigate = useAppNavigate();
  const selectedThreadId = useCurrentSearchParam("session");

  useEffect(() => {
    const handle = window.setTimeout(
      () => setDebouncedQuery(searchInput.trim()),
      SEARCH_DEBOUNCE_MS
    );
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  const searching = debouncedQuery.length > 0;

  // Selecting every pill means the same thing as selecting none; omit the arg
  // in both cases so the backend serves the plain project index.
  const sourceTypesArg =
    sourceFilter.size > 0 && sourceFilter.size < SOURCE_TYPE_PILLS.length
      ? SOURCE_TYPE_PILLS.filter((s) => sourceFilter.has(s))
      : undefined;
  const statusArg = statusFilter === "all" ? undefined : statusFilter;

  const queryName = searching
    ? SESSIONS_FEED_QUERIES.searchProjectSessions
    : SESSIONS_FEED_QUERIES.listProjectSessions;
  const queryArgs = {
    projectId,
    ...(sourceTypesArg ? { sourceTypes: sourceTypesArg } : {}),
    ...(statusArg ? { status: statusArg } : {}),
    ...(searching ? { q: debouncedQuery } : {}),
  };

  const { results, status, loadMore } = usePaginatedQuery(
    queryName as any,
    queryArgs as any,
    { initialNumItems: SESSIONS_FEED_PAGE_SIZE }
  );
  const rows = results as SessionFeedItem[];

  const isLoadingFirstPage = status === "LoadingFirstPage";
  const canLoadMore = status === "CanLoadMore";
  const isFiltering =
    sourceFilter.size > 0 || statusFilter !== "all" || searching;

  const toggleSource = (value: SessionFeedSourceType) => {
    setSourceFilter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedThreadId) ?? null,
    [rows, selectedThreadId]
  );

  /**
   * Move the selection into the URL, stamping the panel's own `projectId`.
   *
   * The panel's own `projectId`, not one read back out of the URL: it knows
   * which project these rows came from, so the link it mints says so in its
   * path. That is the same reason the shareable link below passes `projectId`
   * — a link that names no project resolves against whatever project the
   * reader happens to be parked on.
   *
   * Not `replace`: each session a reader opens is a place they can go Back from.
   */
  const handleSelect = useCallback(
    (threadId: string) => {
      navigate(buildSessionsPath({ session: threadId, project: projectId }));
    },
    [navigate, projectId]
  );

  /**
   * NO stale-selection cleanup here, deliberately.
   *
   * Selection lives in the URL, so in principle it could outlive a project
   * switch and leave this pane loading a thread absent from the list beside it.
   * It cannot in practice: a project switch IS a navigation now — the picker
   * goes to `/p/<nextProjectId>/servers` — so this panel unmounts and the URL
   * carrying the selection is gone with it.
   *
   * An effect here could not close that gap anyway: App renders this panel as
   * `key={projectId}`, so a project change REMOUNTS it, and any "previous
   * project" ref would re-initialize to the new value and never observe the
   * transition. Machinery that cannot fire is worse than none — a reader would
   * trust it.
   */

  // The shareable form of the same link.
  const sessionLink = selectedThreadId
    ? `${getShareableAppOrigin()}${buildSessionsPath({
        session: selectedThreadId,
        project: projectId,
      })}`
    : undefined;

  const emptyListCopy = searching
    ? "No sessions match this search"
    : isFiltering
    ? "No sessions match the current filters"
    : "No sessions yet";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="sessions-panel">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/40 px-8 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight">Sessions</h1>
          <p className="hidden truncate text-xs text-muted-foreground sm:block">
            Every conversation in this project, across Playground, User Testing,
            Evals, and Swarms.
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/40 px-4 py-2.5">
        <div className="relative w-[min(100%,16rem)]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            data-testid="sessions-search"
            aria-label="Search sessions"
            placeholder="Search sessions…"
            className="h-8 pl-8 text-xs"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          Source
        </span>
        {SOURCE_TYPE_PILLS.map((value) => {
          const active = sourceFilter.has(value);
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              data-testid={`sessions-source-pill-${value}`}
              onClick={() => toggleSource(value)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors",
                active
                  ? "border-primary/50 bg-primary/10 text-foreground"
                  : "border-border/60 bg-transparent text-muted-foreground hover:bg-muted/50"
              )}
            >
              {SESSION_SOURCE_TYPE_LABELS[value]}
            </button>
          );
        })}
        <Select
          value={statusFilter}
          onValueChange={(value) => {
            if (value === "all" || value === "active" || value === "archived") {
              setStatusFilter(value);
            }
          }}
        >
          <SelectTrigger
            data-testid="sessions-status-filter"
            className="h-8 w-[min(100%,9rem)] text-xs"
            aria-label="Filter sessions by status"
          >
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          {isLoadingFirstPage ? (
            <p className="text-xs text-muted-foreground">Loading sessions…</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {`${rows.length}${canLoadMore ? "+" : ""} session${
                rows.length === 1 ? "" : "s"
              }`}
            </p>
          )}
          {canLoadMore ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="rounded-xl"
              onClick={() => loadMore(SESSIONS_FEED_PAGE_SIZE)}
            >
              Load more
            </Button>
          ) : null}
        </div>
      </div>

      {searching && !isLoadingFirstPage ? (
        // Search pages are relevance-ordered, not newest-first — say so
        // rather than letting the reordering read as a bug.
        <p className="shrink-0 px-4 pt-2 text-[11px] text-muted-foreground">
          Results ranked by title relevance.
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={32} minSize={22}>
            <ScrollArea className="h-full">
              <div className="space-y-1 p-2">
                {rows.map((row) => (
                  <SessionFeedRow
                    key={row.id}
                    row={row}
                    selected={row.id === selectedThreadId}
                    onSelect={() => handleSelect(row.id)}
                  />
                ))}
              </div>
            </ScrollArea>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={68} minSize={40}>
            <div className="h-full overflow-hidden">
              {selectedThreadId ? (
                // The shared detail pane is scenario/swarm-native; a Playground
                // or eval transcript that trips one of its branches degrades
                // to the row's own metadata instead of white-screening.
                <ErrorBoundary
                  name="sessions-thread-detail"
                  fallback={<SessionDetailFallback row={selectedRow} />}
                >
                  <ShareUsageThreadDetail
                    threadId={selectedThreadId}
                    sessionLink={sessionLink}
                  />
                </ErrorBoundary>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">
                      {rows.length === 0 && !isLoadingFirstPage
                        ? emptyListCopy
                        : "Select a session to view"}
                    </p>
                    {!isFiltering &&
                    rows.length === 0 &&
                    !isLoadingFirstPage ? (
                      <p className="mt-1 text-xs text-muted-foreground/70">
                        Chat in the Playground, share a scenario, or run an eval
                        or swarm to generate sessions.
                      </p>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

function SessionFeedRow({
  row,
  selected,
  onSelect,
}: {
  row: SessionFeedItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const parentChip = sessionParentChipLabel(row.parentRef);
  const originChip = sessionOriginChipLabel(row.origin);
  const title = row.title?.trim() || row.firstMessagePreview || "Untitled";

  return (
    <button
      type="button"
      data-testid={`session-row-${row.chatSessionId}`}
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-transparent hover:border-border/60 hover:bg-muted/40"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {title}
        </span>
        {row.readiness ? (
          <SessionReadinessBadge readiness={row.readiness} />
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className="rounded-full border border-border/60 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {SESSION_SOURCE_TYPE_LABELS[row.sourceType] ?? row.sourceType}
        </span>
        {originChip ? (
          <span
            data-testid="session-origin-chip"
            className="rounded-full border border-border/60 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {originChip}
          </span>
        ) : null}
        {row.ownedByViewer ? (
          <span className="rounded-full border border-border/60 px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
            Yours
          </span>
        ) : null}
        {row.visibility === "project" ? (
          <span className="rounded-full border border-border/60 px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
            Shared
          </span>
        ) : null}
        {row.synthetic ? (
          <span
            className="h-1.5 w-1.5 rounded-full bg-violet-500/70"
            title="Synthetic session"
          />
        ) : null}
        {parentChip ? (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {parentChip}
          </span>
        ) : null}
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
        {row.firstMessagePreview}
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground/80">
          {formatDistanceToNow(new Date(row.lastActivityAt), {
            addSuffix: true,
          })}
        </span>
        <span className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground/80">
          {row.modelId ? <span>{row.modelId}</span> : null}
          <span className="flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            {row.messageCount}
          </span>
        </span>
      </div>
    </button>
  );
}

/**
 * What the detail pane shows when the shared viewer throws on a sourceType it
 * doesn't fully model yet — the row's own metadata, which is always safe.
 */
function SessionDetailFallback({ row }: { row: SessionFeedItem | null }) {
  if (!row) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          This session can't be displayed.
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm font-medium text-foreground">
          {row.title ?? row.firstMessagePreview}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {SESSION_SOURCE_TYPE_LABELS[row.sourceType] ?? row.sourceType} session
          · {row.messageCount} messages
        </p>
        <p className="mt-2 text-xs text-muted-foreground/70">
          The full transcript view for this session type isn't available here
          yet.
        </p>
      </div>
    </div>
  );
}
