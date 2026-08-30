/**
 * Flat Sessions browser for Swarms — list + detail over project `chatSessions`
 * with `sourceType: "swarm"`. Defaults to all personas; the top-bar persona
 * picker narrows to `listSessionsByPersona`. Mirrors the Scenarios Sessions layout.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { MessageSquare } from "lucide-react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { ShareUsageThreadList } from "@/components/connection/share-usage/ShareUsageThreadList";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";
import {
  SwarmSessionsGroupedList,
  SwarmSessionsGroupCount,
} from "@/components/swarms/SwarmSessionsGroupedList";
import { SwarmSessionsMetricStrip } from "@/components/swarms/swarm-sessions-metric-strip";
import { SwarmRunStageFunnelPanels } from "@/components/shared/user-value-chain/StageFunnelPanels";
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

/**
 * How many extra pages the deep-link walk may pull looking for its target.
 * The flat project feed is unbounded, so this is what stops a link naming a
 * session outside this list (or one that no longer exists) from paging forever.
 */
const MAX_DEEP_LINK_PAGE_PULLS = 10;

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
  // "Load more" keeps paginating the unfiltered list.
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

  // Apply deep-link once the matching row appears (may need Load more).
  const appliedInitialRef = useRef(false);
  const initialPagesPulledRef = useRef(0);
  // A NEW target (an Overview finding drilling into a second session while the
  // panel stays mounted) re-arms both the claim and the page budget — without
  // this the walk below would be spent and the second link would never apply.
  const prevInitialThreadRef = useRef(initialThreadId);
  if (prevInitialThreadRef.current !== initialThreadId) {
    prevInitialThreadRef.current = initialThreadId;
    appliedInitialRef.current = false;
    initialPagesPulledRef.current = 0;
  }
  useEffect(() => {
    if (appliedInitialRef.current || !initialThreadId) return;
    if (rows.some((r) => r.id === initialThreadId)) {
      appliedInitialRef.current = true;
      setSelectedThreadId(initialThreadId);
    }
  }, [initialThreadId, rows]);

  // The effect above only searches LOADED rows, so a target past the first
  // page never applies and the viewer lands on a session list that ignored
  // their click. Pull pages until it turns up or the budget runs out — same
  // shape as the run-detail deep-link walk in `run-sessions-context.tsx`.
  //
  // BOUNDED on purpose: the project feed is unbounded, so an unlimited walk
  // over a large project would page forever for a session that (after a host
  // filter, say) is not in this list at all.
  useEffect(() => {
    if (appliedInitialRef.current || !initialThreadId) return;
    if (status !== "CanLoadMore") return;
    if (initialPagesPulledRef.current >= MAX_DEEP_LINK_PAGE_PULLS) return;
    initialPagesPulledRef.current += 1;
    loadMore(DEFAULT_PAGE_SIZE);
    // `rows` is a dependency so each landed page re-evaluates: the effect above
    // runs first on that commit and sets the applied ref when the target is
    // present, which stops the walk without an extra query.
  }, [initialThreadId, rows, status, loadMore]);

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
  const canLoadMore = status === "CanLoadMore";
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

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="swarms-sessions-panel"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/40 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {status === "LoadingFirstPage" ? (
            <p className="shrink-0 truncate text-xs text-muted-foreground">
              {groupBy === "run"
                ? "Loading runs…"
                : groupBy === "goal"
                ? "Loading goals…"
                : "Loading sessions…"}
            </p>
          ) : groupBy === "run" ? (
            <SwarmSessionsGroupCount
              groups={runGroups}
              canLoadMore={canLoadMore}
              unit="run"
            />
          ) : groupBy === "goal" ? (
            <SwarmSessionsGroupCount
              groups={goalGroups}
              canLoadMore={canLoadMore}
              unit="goal"
            />
          ) : (
            <p className="shrink-0 truncate text-xs text-muted-foreground">
              {`${threads.length}${canLoadMore ? "+" : ""} session${
                threads.length === 1 ? "" : "s"
              }`}
            </p>
          )}
          <Select
            value={groupBy}
            onValueChange={(value) => {
              if (value === "run" || value === "goal" || value === "session") {
                setGroupBy(value);
              }
            }}
          >
            <SelectTrigger
              data-testid="swarms-sessions-group-by"
              className="h-8 w-[min(100%,10rem)] text-xs"
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
              className="h-8 w-[min(100%,12rem)] text-xs"
              aria-label="Filter sessions by persona"
            >
              <SelectValue placeholder="All personas" />
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
                className="h-8 w-[min(100%,12rem)] text-xs"
                aria-label="Filter sessions by client"
              >
                <SelectValue placeholder="All clients" />
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
        </div>
        <div className="flex items-center gap-2">
          {status === "CanLoadMore" ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="rounded-xl"
              onClick={() => loadMore(DEFAULT_PAGE_SIZE)}
            >
              Load more
            </Button>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 px-4 pt-3">
        <ErrorBoundary fallback={null}>
          <SwarmSessionsMetricStrip
            projectId={projectId}
            personaRefId={personaRefId}
          />
        </ErrorBoundary>
      </div>

      {/* D8: one funnel PER RUN, never one folded across runs — two runs
          against different hosts have different denominators and a combined
          bar would describe neither. Rendered only on the run-scoped mount:
          without `journeyRunIds` this panel is project-wide, which is not a
          population any single funnel can honestly describe. */}
      {/* The spacing rides on the component rather than on a wrapper here:
          `runIdSet` is an empty-but-TRUTHY Set when the caller passes an empty
          list, and a wrapper would then reserve `pt-3` of blank band above the
          session list for a funnel that never appears. Owning its own class
          means the component that decides whether to render anything also
          decides whether anything takes up space. */}
      {runIdSet ? (
        <SwarmRunStageFunnelPanels
          journeyRunIds={[...runIdSet]}
          className="shrink-0 space-y-2 px-4 pt-3"
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={32} minSize={22}>
            <div className="h-full overflow-hidden">
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
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">
                      {threads.length === 0
                        ? emptyListCopy
                        : "Select a conversation to view"}
                    </p>
                    {!filtered && threads.length === 0 ? (
                      <p className="mt-1 text-xs text-muted-foreground/70">
                        Run a goal to generate sessions, or filter by persona
                        above.
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
