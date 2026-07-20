/**
 * Flat Sessions browser for Swarms — list + detail over project `chatSessions`
 * with `sourceType: "swarm"`. Defaults to all personas; the top-bar persona
 * picker narrows to `listSessionsByPersona`. Mirrors the Chatboxes Sessions layout.
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
import { ConvertSwarmSessionDialog } from "@/components/swarms/convert-swarm-session-dialog";
import {
  DEFAULT_PAGE_SIZE,
  SWARM_QUERIES,
  journeySessionRowToThread,
  type JourneySessionRow,
} from "@/lib/swarm-api";
import {
  buildEvalsPath,
  buildSwarmSessionPath,
  navigateApp,
} from "@/lib/app-navigation";
import { getShareableAppOrigin } from "@/lib/chatbox-session";

export function SwarmsSessionsPanel({
  projectId,
  personas,
  personaRefId,
  onPersonaRefIdChange,
  initialThreadId,
}: {
  projectId: string;
  personas: ReadonlyArray<{ _id: string; name: string; role?: string }>;
  /** When set, narrows the list to that persona; `null` = all project sessions. */
  personaRefId: string | null;
  onPersonaRefIdChange: (personaRefId: string | null) => void;
  /** Deep-link session (`chatSessions` `_id`) to preselect. */
  initialThreadId?: string | null;
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

  const rows = sessions as JourneySessionRow[];
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    initialThreadId ?? null,
  );
  const [sessionToPromote, setSessionToPromote] =
    useState<JourneySessionRow | null>(null);

  // Reset selection when the persona filter changes; re-seed from the deep
  // link when it still applies.
  const prevPersonaRef = useRef(personaRefId);
  useEffect(() => {
    if (prevPersonaRef.current === personaRefId) return;
    prevPersonaRef.current = personaRefId;
    setSelectedThreadId(initialThreadId ?? null);
    setSessionToPromote(null);
  }, [personaRefId, initialThreadId]);

  // Apply deep-link once the matching row appears (may need Load more).
  const appliedInitialRef = useRef(false);
  useEffect(() => {
    if (appliedInitialRef.current || !initialThreadId) return;
    if (rows.some((r) => r.id === initialThreadId)) {
      appliedInitialRef.current = true;
      setSelectedThreadId(initialThreadId);
    }
  }, [initialThreadId, rows]);

  const threads = useMemo(
    () => rows.map((r) => journeySessionRowToThread(r, personaName)),
    [rows, personaName],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.id === selectedThreadId) ?? null,
    [rows, selectedThreadId],
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

  const emptyListCopy = filtered
    ? "No sessions for this persona yet"
    : "No swarm sessions yet";

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="swarms-sessions-panel">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/40 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <p className="shrink-0 truncate text-xs text-muted-foreground">
            {status === "LoadingFirstPage"
              ? "Loading sessions…"
              : `${threads.length}${status === "CanLoadMore" ? "+" : ""} session${
                  threads.length === 1 ? "" : "s"
                }`}
          </p>
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
        </div>
        <div className="flex items-center gap-2">
          {selectedRow ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-xl"
              onClick={() => setSessionToPromote(selectedRow)}
            >
              Promote to test case
            </Button>
          ) : null}
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

      <div className="min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={32} minSize={22}>
            <div className="h-full overflow-hidden">
              <ShareUsageThreadList
                threads={threads}
                selectedThreadId={selectedThreadId}
                onSelectThread={setSelectedThreadId}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={68} minSize={40}>
            <div className="h-full overflow-hidden">
              {selectedThreadId ? (
                <ShareUsageThreadDetail
                  threadId={selectedThreadId}
                  sessionLink={sessionLink}
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
                        Run a journey to generate sessions, or filter by persona
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

      <ConvertSwarmSessionDialog
        open={sessionToPromote !== null}
        session={sessionToPromote}
        onOpenChange={(open) => {
          if (!open) setSessionToPromote(null);
        }}
        onImported={({ suiteId, testCaseId }) => {
          setSessionToPromote(null);
          navigateApp(
            buildEvalsPath({
              type: "test-edit",
              suiteId,
              testId: testCaseId,
            }),
          );
        }}
      />
    </div>
  );
}
