import { useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { ChevronRight } from "lucide-react";
import {
  DiffGroup,
  DiffRow,
  RevisionDiffView,
  type RevisionSide,
  type SnapshotDiff,
} from "./ServerHistoryDiff";
import {
  ServerUrlChangeDetails,
  useServerUrlChangeEvents,
  type ServerUrlChangeEvent,
} from "./ServerUrlChangeHistory";
import type { SnapshotDiscovery, SnapshotTool } from "./server-history-diff";

/**
 * Server snapshot history. Each revision is an immutable capture of this
 * server's tool/capability contract, minted server-side only when the
 * contract actually changes (see `serverInspections.recordFromConnect`).
 * Reads persisted Convex data, so it works while the server is disconnected.
 *
 * DTOs are mirrored from the backend by hand (two-repo layout) and kept
 * narrow to what we render — the source of truth is
 * `mcpjam-backend/convex/serverInspections.ts`.
 */
type RevisionSource = "connect" | "evalRun" | "traceRepair" | "chatSession";

interface RevisionSummary {
  revisionNumber: number;
  capturedAt: number;
  source: RevisionSource;
  counts: {
    tools: number;
    prompts?: number;
    resources?: number;
    resourceTemplates?: number;
  };
}

interface RevisionSnapshot {
  revisionNumber: number;
  snapshot: {
    tools?: SnapshotTool[];
    discovery?: SnapshotDiscovery;
    /** Pre-v3 snapshots kept discovery under `initialize`. */
    initialize?: SnapshotDiscovery;
  };
  counts: { tools: number };
  redaction?: { droppedFields?: string[] };
}

type HistoryEvent = {
  key: string;
  timestamp: number;
} & (
  | { kind: "urlChange"; change: ServerUrlChangeEvent }
  | { kind: "revision"; revision: RevisionSummary; previous?: RevisionSummary }
);

const dayFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const REVISION_HISTORY_LIMIT = 50;

function groupHistoryByDay(
  changes: ServerUrlChangeEvent[],
  revisions: RevisionSummary[]
) {
  const events: HistoryEvent[] = [
    ...changes.map((change) => ({
      kind: "urlChange" as const,
      key: `url-${change.id}`,
      timestamp: change.timestamp,
      change,
    })),
    ...revisions.slice(0, REVISION_HISTORY_LIMIT).map((revision, index) => ({
      kind: "revision" as const,
      key: `revision-${revision.revisionNumber}`,
      timestamp: revision.capturedAt,
      revision,
      previous: revisions[index + 1],
    })),
  ];
  const days = new Map<string, HistoryEvent[]>();
  for (const event of events.sort((a, b) => b.timestamp - a.timestamp)) {
    const day = dayFormat.format(event.timestamp);
    const entries = days.get(day);
    if (entries) entries.push(event);
    else days.set(day, [event]);
  }
  return days;
}

export function ServerHistoryContent({
  projectId,
  serverId,
}: {
  projectId: string;
  serverId: string;
}) {
  const revisions = useQuery(
    "serverInspections:listInspectionRevisions" as never,
    {
      projectId,
      serverId,
      // Keep one extra revision to detect truncation and diff the last row.
      limit: REVISION_HISTORY_LIMIT + 1,
    } as never
  ) as RevisionSummary[] | undefined;
  const { changes, isLoading, hasError } = useServerUrlChangeEvents(serverId);
  const { user } = useAuth();

  const [expanded, setExpanded] = useState<number | null>(null);

  if (revisions === undefined || isLoading) {
    return (
      <div className="space-y-2 py-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-9 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  const days = groupHistoryByDay(changes, revisions);
  if (days.size === 0 && !hasError) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No server activity yet
      </div>
    );
  }

  return (
    <div className="space-y-4 py-1">
      {hasError && (
        <p role="status" className="text-sm text-muted-foreground">
          Server URL and command changes unavailable
        </p>
      )}
      {revisions.length > REVISION_HISTORY_LIMIT && (
        <p className="text-xs text-muted-foreground">
          Only the latest {REVISION_HISTORY_LIMIT} inspection revisions are shown.
        </p>
      )}
      {[...days].map(([day, events]) => (
        <section key={day}>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">
            {day}
          </h3>
          <ol
            role="list"
            className="ms-1.5 divide-y divide-border border-s border-border ps-3"
          >
            {events.map((event) => {
              const isOpen =
                event.kind === "revision" &&
                expanded === event.revision.revisionNumber;
              const date = new Date(event.timestamp);
              const time = (
                <time
                  dateTime={date.toISOString()}
                  title={date.toLocaleString()}
                  className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground"
                >
                  {timeFormat.format(event.timestamp)}
                </time>
              );
              return (
                <li
                  key={event.key}
                  className={cn(
                    "relative min-w-0 before:absolute before:-start-[17px] before:top-3.5 before:size-2 before:rounded-full before:ring-2 before:ring-background",
                    event.kind === "urlChange"
                      ? "before:bg-primary"
                      : "before:bg-muted-foreground/60"
                  )}
                >
                  {event.kind === "urlChange" ? (
                    <ServerUrlChangeDetails
                      event={event.change}
                      viewerEmail={user?.email}
                    >
                      {time}
                    </ServerUrlChangeDetails>
                  ) : (
                    <div>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setExpanded(
                            isOpen ? null : event.revision.revisionNumber
                          )
                        }
                        className="h-auto w-full justify-start px-2 py-2 text-left has-[>svg]:px-2"
                      >
                        <span className="shrink-0">
                          Revision {event.revision.revisionNumber}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">
                          <DeltaLabel
                            rev={event.revision}
                            prev={event.previous}
                          />
                        </span>
                        {time}
                        <ChevronRight
                          aria-hidden="true"
                          className={cn(
                            "size-3.5 text-muted-foreground motion-safe:transition-transform",
                            isOpen && "rotate-90"
                          )}
                        />
                      </Button>
                      {isOpen && (
                        <div className="mb-2 px-2">
                          <RevisionDetail
                            projectId={projectId}
                            serverId={serverId}
                            revisionNumber={event.revision.revisionNumber}
                            hasPrev={event.revision.revisionNumber > 1}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

function DeltaLabel({
  rev,
  prev,
}: {
  rev: RevisionSummary;
  prev?: RevisionSummary;
}) {
  if (!prev) {
    return <>{rev.counts.tools} tools</>;
  }
  const delta = rev.counts.tools - prev.counts.tools;
  if (delta > 0)
    return (
      <span className="text-success">
        +{delta} tool{delta > 1 ? "s" : ""}
      </span>
    );
  if (delta < 0)
    return (
      <span className="text-destructive">
        −{-delta} tool{-delta > 1 ? "s" : ""}
      </span>
    );
  return <>Updated</>;
}

function RevisionDetail({
  projectId,
  serverId,
  revisionNumber,
  hasPrev,
}: {
  projectId: string;
  serverId: string;
  revisionNumber: number;
  hasPrev: boolean;
}) {
  const [mode, setMode] = useState<"diff" | "snapshot">(
    hasPrev ? "diff" : "snapshot"
  );
  return (
    <div className="space-y-3 rounded-lg bg-muted/30 p-3 text-[12.5px]">
      {hasPrev && <ViewToggle mode={mode} onChange={setMode} />}
      {mode === "diff" ? (
        <DiffBody
          projectId={projectId}
          serverId={serverId}
          revisionNumber={revisionNumber}
        />
      ) : (
        <SnapshotBody
          projectId={projectId}
          serverId={serverId}
          revisionNumber={revisionNumber}
        />
      )}
    </div>
  );
}

function ViewToggle({
  mode,
  onChange,
}: {
  mode: "diff" | "snapshot";
  onChange: (next: "diff" | "snapshot") => void;
}) {
  return (
    <div className="inline-flex rounded-md bg-muted/60 p-0.5 text-[11px] font-medium">
      {(["diff", "snapshot"] as const).map((option) => {
        const active = mode === option;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option)}
            className={`rounded px-2 py-0.5 capitalize ${
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

function SnapshotBody({
  projectId,
  serverId,
  revisionNumber,
}: {
  projectId: string;
  serverId: string;
  revisionNumber: number;
}) {
  const result = useQuery(
    "serverInspections:getInspectionRevision" as never,
    {
      projectId,
      serverId,
      revisionNumber,
    } as never
  ) as RevisionSnapshot | null | undefined;

  if (result === undefined) {
    return <Skeleton className="h-4 w-40" />;
  }
  if (result === null) {
    return (
      <div className="text-[11.5px] text-muted-foreground">
        Snapshot unavailable
      </div>
    );
  }

  const tools = result.snapshot.tools ?? [];
  if (tools.length === 0) {
    return (
      <div className="text-[11.5px] text-muted-foreground">No tools</div>
    );
  }

  return (
    <DiffGroup
      label={`Tools (${result.counts.tools})`}
      tone="text-muted-foreground"
    >
      {tools.map((tool) => (
        <DiffRow
          key={tool.name}
          sigil="·"
          tone="text-muted-foreground"
          name={tool.name}
          note={tool.description}
        />
      ))}
    </DiffGroup>
  );
}

function DiffBody({
  projectId,
  serverId,
  revisionNumber,
}: {
  projectId: string;
  serverId: string;
  revisionNumber: number;
}) {
  const result = useQuery(
    "serverInspections:diffInspectionRevisions" as never,
    {
      projectId,
      serverId,
      fromRevisionNumber: revisionNumber - 1,
      toRevisionNumber: revisionNumber,
    } as never
  ) as { diff: SnapshotDiff } | null | undefined;
  // Server info values and storage drops live on the revisions, not the diff.
  const from = useRevisionSide(projectId, serverId, revisionNumber - 1);
  const to = useRevisionSide(projectId, serverId, revisionNumber);

  if (result === undefined) {
    return <Skeleton className="h-4 w-40" />;
  }
  if (result === null) {
    return (
      <div className="text-[11.5px] text-muted-foreground">
        Diff unavailable
      </div>
    );
  }
  return <RevisionDiffView diff={result.diff} from={from} to={to} />;
}

function useRevisionSide(
  projectId: string,
  serverId: string,
  revisionNumber: number
): RevisionSide | null | undefined {
  const revision = useQuery(
    "serverInspections:getInspectionRevision" as never,
    { projectId, serverId, revisionNumber } as never
  ) as RevisionSnapshot | null | undefined;
  return useMemo(
    () =>
      revision && {
        revisionNumber: revision.revisionNumber,
        discovery: revision.snapshot.discovery ?? revision.snapshot.initialize,
        droppedFields: revision.redaction?.droppedFields,
      },
    [revision]
  );
}
