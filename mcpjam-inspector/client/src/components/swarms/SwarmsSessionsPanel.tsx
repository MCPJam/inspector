/**
 * Flat Sessions browser for Swarms — list + detail over project `chatSessions`
 * with `sourceType: "swarm"`. Defaults to all personas; the top-bar persona
 * picker narrows to `listSessionsByPersona`. Mirrors the Scenarios Sessions layout.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { MessageSquare } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  SessionListChrome,
  ShareUsageThreadList,
} from "@/components/connection/share-usage/ShareUsageThreadList";
import { sessionCountLabel } from "@/components/connection/share-usage/session-list-format";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import {
  SwarmSessionsGroupedList,
  SwarmSessionsGroupCount,
} from "@/components/swarms/SwarmSessionsGroupedList";
import { SwarmSessionsMetricStrip } from "@/components/swarms/swarm-sessions-metric-strip";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import {
  DEFAULT_PAGE_SIZE,
  SWARM_QUERIES,
  groupSwarmSessionsByGoal,
  groupSwarmSessionsByRun,
  journeySessionRowToThread,
  type JourneySessionRow,
} from "@/lib/swarm-api";

type SessionsGroupBy = "session" | "run" | "goal";
import { buildSwarmSessionPath } from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/scenario-session";

export function SwarmsSessionsPanel({
  projectId,
  personas,
  hosts = [],
  personaRefId,
  onPersonaRefIdChange,
  initialThreadId,
  runLabels,
  goalLabels,
  journeyRunIds,
}: {
  projectId: string;
  personas: ReadonlyArray<{ _id: string; name: string; role?: string }>;
  /** Project hosts — resolves display names for the host filter. */
  hosts?: ReadonlyArray<{ hostId: string; name: string }>;
  /** When set, narrows the list to that persona; `null` = all project sessions. */
  personaRefId: string | null;
  onPersonaRefIdChange: (personaRefId: string | null) => void;
  /** Deep-link session (`chatSessions` `_id`) to preselect. */
  initialThreadId?: string | null;
  /** Run-id → "Persona · Goal" for runs this session launched. */
  runLabels?: ReadonlyMap<string, string>;
  /** Goal id (`journeyRefId`) → display name for "By goal" grouping. */
  goalLabels?: ReadonlyMap<string, string>;
  /**
   * When set, keep only sessions whose `journeyRunId` is in this set (Swarm
   * Run detail). Filtered client-side over loaded pages — same pattern as the
   * host filter.
   */
  journeyRunIds?: ReadonlyArray<string> | ReadonlySet<string>;
}) {
  const filtered = Boolean(personaRefId);
  const personaName = personas.find((p) => p._id === personaRefId)?.name;
  const queryName = filtered
    ? SWARM_QUERIES.listSessionsByPersona
    : SWARM_QUERIES.listSessionsByProject;
  const queryArgs = filtered
    ? ({ personaRefId } as any)
    : ({ projectId } as any);

  const {
    results: sessions,
    status,
    loadMore,
  } = usePaginatedQuery(queryName as any, queryArgs, {
    initialNumItems: Math.max(DEFAULT_PAGE_SIZE, 25),
  });

  const loadedRows = sessions as JourneySessionRow[];

  const runIdSet = useMemo(() => {
    if (!journeyRunIds) return null;
    return journeyRunIds instanceof Set
      ? journeyRunIds
      : new Set(journeyRunIds);
  }, [journeyRunIds]);

  // Host / run-id filters — client-side over the loaded pages (there is no
  // per-host backend query; the persona filter stays server-side as before).
  // Remaining pages keep arriving as each one lands.
  const allRows = useMemo(
    () =>
      runIdSet
        ? loadedRows.filter(
            (r) => r.journeyRunId != null && runIdSet.has(r.journeyRunId)
          )
        : loadedRows,
    [loadedRows, runIdSet]
  );

  const [groupBy, setGroupBy] = useState<SessionsGroupBy>("run");
  const [hostFilter, setHostFilter] = useState<string | null>(null);
  const hostOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of allRows) {
      if (r.hostId && !seen.has(r.hostId)) {
        seen.set(
          r.hostId,
          hosts.find((h) => h.hostId === r.hostId)?.name ?? r.hostId.slice(0, 8)
        );
      }
    }
    return Array.from(seen, ([hostId, name]) => ({ hostId, name }));
  }, [allRows, hosts]);
  const rows = useMemo(
    () =>
      hostFilter ? allRows.filter((r) => r.hostId === hostFilter) : allRows,
    [allRows, hostFilter]
  );

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    initialThreadId ?? null
  );

  // Reset selection when the persona filter changes; re-seed from the deep
  // link when it still applies.
  const prevPersonaRef = useRef(personaRefId);
  useEffect(() => {
    if (prevPersonaRef.current === personaRefId) return;
    prevPersonaRef.current = personaRefId;
    setHostFilter(null);
    setSelectedThreadId(initialThreadId ?? null);
  }, [personaRefId, initialThreadId]);

  // Drop a selection the host filter just hid — the detail pane must not show
  // a session missing from the visible list.
  useEffect(() => {
    if (!hostFilter || !selectedThreadId) return;
    if (!rows.some((r) => r.id === selectedThreadId)) {
      setSelectedThreadId(null);
    }
  }, [hostFilter, rows, selectedThreadId]);

  // Apply deep-link once the matching row appears. Later pages keep arriving
  // on their own, so a target past the first page still applies when it lands.
  const appliedInitialRef = useRef(false);
  const prevInitialThreadRef = useRef(initialThreadId);
  if (prevInitialThreadRef.current !== initialThreadId) {
    prevInitialThreadRef.current = initialThreadId;
    appliedInitialRef.current = false;
    // A URL that no longer names a session is a REQUEST to stop showing one.
    // Only the deep link ever seeded this, and the effect below early-returns
    // on a null target — so the panel kept the previous session open while the
    // page around it acted as though it had been dismissed. That is what made
    // "Back to the live run" look inert: the URL changed, the button that
    // offered it disappeared with the `?session=` it keyed on, and the session
    // the viewer asked to leave stayed on screen. An in-panel click does not
    // touch the URL, so it never reaches this branch.
    if (!initialThreadId) {
      setSelectedThreadId(null);
    }
    // main reset `initialPagesPulledRef` here; this branch retired that
    // counter for the per-feed `autoPagesLoaded` budget below. Clearing
    // `appliedInitialRef` just above already re-arms paging for the new deep
    // link, because `pendingDeepLink` is derived from it.
  }
  useEffect(() => {
    if (appliedInitialRef.current || !initialThreadId) return;
    if (rows.some((r) => r.id === initialThreadId)) {
      appliedInitialRef.current = true;
      setSelectedThreadId(initialThreadId);
    }
  }, [initialThreadId, rows]);

  // Walk the feed as each page lands, but do NOT drain an unbounded project
  // history just because someone opened the Sessions tab. Automatic paging is
  // for work that needs rows it has not seen yet:
  //   - an unresolved deep link, until its row arrives
  //   - the run-scoped view, whose filter runs client-side over loaded pages
  // The plain feed gets a few pages, then hands the reader a Load more button.
  const AUTO_PAGE_LIMIT = 4;
  const [autoPagesLoaded, setAutoPagesLoaded] = useState(0);
  // The budget belongs to ONE feed. Switching persona (or project) swaps the
  // paginated query underneath us and Convex starts its results over, so a
  // budget left at the cap would leave the fresh feed stranded on page one
  // with no auto-paging. Re-key it to the new feed instead.
  const feedKey = filtered ? `persona:${personaRefId}` : `project:${projectId}`;
  const [autoPagesFeedKey, setAutoPagesFeedKey] = useState(feedKey);
  if (autoPagesFeedKey !== feedKey) {
    setAutoPagesFeedKey(feedKey);
    setAutoPagesLoaded(0);
  }
  const pendingDeepLink = Boolean(initialThreadId) && !appliedInitialRef.current;
  const autoPagingAllowed =
    pendingDeepLink || Boolean(runIdSet) || autoPagesLoaded < AUTO_PAGE_LIMIT;
  useEffect(() => {
    if (status !== "CanLoadMore" || !autoPagingAllowed) return;
    setAutoPagesLoaded((n) => n + 1);
    loadMore(DEFAULT_PAGE_SIZE);
    // `autoPagesLoaded` is a dep on purpose: each landed page re-evaluates the
    // budget, so the walk continues until the cap and then stops.
  }, [status, loadMore, autoPagingAllowed, autoPagesLoaded]);

  const threads = useMemo(
    () => rows.map((r) => journeySessionRowToThread(r, personaName)),
    [rows, personaName]
  );
  const threadsById = useMemo(
    () => new Map(threads.map((thread) => [thread._id, thread])),
    [threads]
  );
  const runGroups = useMemo(() => groupSwarmSessionsByRun(rows), [rows]);
  const goalGroups = useMemo(() => groupSwarmSessionsByGoal(rows), [rows]);
  const canLoadMore =
    status === "CanLoadMore" || status === "LoadingMore";
  const isGrouped = groupBy === "run" || groupBy === "goal";

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedThreadId) ?? null,
    [rows, selectedThreadId]
  );

  const linkPersonaRefId =
    selectedRow?.personaRefId ?? personaRefId ?? undefined;
  const sessionLink =
    selectedRow &&
    linkPersonaRefId &&
    selectedRow.journeyRunId &&
    selectedRow.hostId
      ? `${getShareableAppOrigin()}${buildSwarmSessionPath({
          personaRefId: linkPersonaRefId,
          runId: selectedRow.journeyRunId,
          hostId: selectedRow.hostId,
          threadId: selectedRow.id,
        })}`
      : undefined;

  const emptyListCopy = hostFilter
    ? "No loaded sessions for this client"
    : runIdSet
    ? "No sessions for this swarm run yet"
    : filtered
    ? "No sessions for this persona yet"
    : "No swarm sessions yet";

  const listCountLabel =
    status === "LoadingFirstPage"
      ? groupBy === "run"
        ? "Loading runs…"
        : groupBy === "goal"
          ? "Loading goals…"
          : "Loading sessions…"
      : groupBy === "run" || groupBy === "goal"
        ? null
        : sessionCountLabel(threads.length, { canLoadMore });

  const filterTriggerClass = "h-7 w-auto min-w-0 gap-1.5 px-2.5 text-xs";

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="swarms-sessions-panel"
    >
      <ErrorBoundary fallback={null}>
        <SwarmSessionsMetricStrip
          projectId={projectId}
          personaRefId={personaRefId}
        />
      </ErrorBoundary>

      <div className="min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={32} minSize={22}>
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              <SessionListChrome
                countLabel={
                  listCountLabel ??
                  (groupBy === "goal" ? (
                    <SwarmSessionsGroupCount
                      groups={goalGroups}
                      canLoadMore={canLoadMore}
                      unit="goal"
                    />
                  ) : (
                    <SwarmSessionsGroupCount
                      groups={runGroups}
                      canLoadMore={canLoadMore}
                      unit="run"
                    />
                  ))
                }
              >
                <Select
                  value={groupBy}
                  onValueChange={(value) => {
                    if (
                      value === "run" ||
                      value === "goal" ||
                      value === "session"
                    ) {
                      setGroupBy(value);
                    }
                  }}
                >
                  <SelectTrigger
                    data-testid="swarms-sessions-group-by"
                    className={filterTriggerClass}
                    aria-label="Group sessions by"
                  >
                    <SelectValue placeholder="Group by sessions" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="session">By session</SelectItem>
                    <SelectItem value="run">By run</SelectItem>
                    <SelectItem value="goal">By goal</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={personaRefId ?? "all"}
                  onValueChange={(value) =>
                    onPersonaRefIdChange(value === "all" ? null : value)
                  }
                >
                  <SelectTrigger
                    data-testid="swarms-sessions-persona-filter"
                    className={filterTriggerClass}
                    aria-label="Filter sessions by persona"
                  >
                    <SelectValue placeholder="Personas" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All personas</SelectItem>
                    {personas.map((persona) => (
                      <SelectItem key={persona._id} value={persona._id}>
                        {persona.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {hostOptions.length > 0 ? (
                  <Select
                    value={hostFilter ?? "all"}
                    onValueChange={(value) =>
                      setHostFilter(value === "all" ? null : value)
                    }
                  >
                    <SelectTrigger
                      data-testid="swarms-sessions-host-filter"
                      className={filterTriggerClass}
                      aria-label="Filter sessions by client"
                    >
                      <SelectValue placeholder="Clients" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All clients</SelectItem>
                      {hostOptions.map((h) => (
                        <SelectItem key={h.hostId} value={h.hostId}>
                          {h.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                {status === "CanLoadMore" && !autoPagingAllowed ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 shrink-0 text-xs"
                    data-testid="swarms-sessions-load-more"
                    // One click, one page. Resetting the budget here would
                    // re-arm auto-paging and drain several more pages on top
                    // of this click — the opposite of handing the reader the
                    // pace.
                    onClick={() => loadMore(DEFAULT_PAGE_SIZE)}
                  >
                    Load more
                  </Button>
                ) : null}
              </SessionListChrome>
              <div className="min-h-0 flex-1 overflow-hidden">
                {isGrouped ? (
                  <SwarmSessionsGroupedList
                    groups={groupBy === "goal" ? goalGroups : runGroups}
                    threadsById={threadsById}
                    selectedThreadId={selectedThreadId}
                    onSelectThread={setSelectedThreadId}
                    runLabels={groupBy === "goal" ? goalLabels : runLabels}
                    groupUnit={groupBy === "goal" ? "goal" : "run"}
                  />
                ) : (
                  <ShareUsageThreadList
                    threads={threads}
                    selectedThreadId={selectedThreadId}
                    onSelectThread={setSelectedThreadId}
                  />
                )}
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={68} minSize={40}>
            <div className="h-full overflow-hidden">
              {selectedThreadId ? (
                <ShareUsageThreadDetail
                  threadId={selectedThreadId}
                  sessionLink={sessionLink}
                  promote={
                    selectedRow?.projectId
                      ? {
                          projectId: selectedRow.projectId,
                          // The Swarms route is gated at project member
                          // (canViewSwarms), so being here is the check.
                          canPromote: true,
                        }
                      : undefined
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center p-6">
                  {/* A measure keeps the copy a readable block instead of one
                      long line on a wide pane, and off the edges on a narrow
                      one — this pane is dragged to both. */}
                  <div className="max-w-[36ch] text-center text-balance">
                    <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">
                      {threads.length === 0
                        ? emptyListCopy
                        : "Select a conversation to view"}
                    </p>
                    {!filtered && threads.length === 0 ? (
                      <p className="mt-1 text-xs text-muted-foreground/70">
                        Run a goal to generate sessions, or filter by persona.
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
