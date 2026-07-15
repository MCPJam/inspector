import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { ChevronRight } from "lucide-react";

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

interface SnapshotDiff {
  discovery?: { changed: boolean; changedFields: string[] };
  tools: {
    added: Array<{ name: string; description?: string }>;
    removed: Array<{ name: string }>;
    changed: Array<{ name: string; changedFields: string[] }>;
  };
}

interface SnapshotTool {
  name: string;
  description?: string;
}

interface RevisionSnapshot {
  snapshot: {
    tools?: SnapshotTool[];
  };
  counts: { tools: number };
}

function compactAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
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
      limit: 50,
    } as never
  ) as RevisionSummary[] | undefined;

  const [expanded, setExpanded] = useState<number | null>(null);

  if (revisions === undefined) {
    return (
      <div className="space-y-2 py-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-9 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (revisions.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No snapshots captured yet
      </div>
    );
  }

  return (
    <div className="space-y-0.5 py-1">
      {revisions.map((rev, i) => {
        const prev = revisions[i + 1];
        const isLatest = i === 0;
        const isOpen = expanded === rev.revisionNumber;
        return (
          <div key={rev.revisionNumber}>
            <button
              type="button"
              onClick={() =>
                setExpanded(isOpen ? null : rev.revisionNumber)
              }
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-muted/50"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  isLatest ? "bg-primary" : "bg-muted-foreground/40"
                }`}
              />
              <span className="shrink-0 text-[13px] font-medium">
                Revision {rev.revisionNumber}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
                <DeltaLabel rev={rev} prev={prev} />
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {compactAgo(rev.capturedAt)}
              </span>
              <ChevronRight
                className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
                  isOpen ? "rotate-90" : ""
                }`}
              />
            </button>
            {isOpen && (
              <div className="mb-1 ml-[18px]">
                <RevisionDetail
                  projectId={projectId}
                  serverId={serverId}
                  revisionNumber={rev.revisionNumber}
                  hasPrev={rev.revisionNumber > 1}
                />
              </div>
            )}
          </div>
        );
      })}
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

  const { added, removed, changed } = result.diff.tools;
  const discovery = result.diff.discovery;
  const empty =
    added.length === 0 &&
    removed.length === 0 &&
    changed.length === 0 &&
    !discovery?.changed;

  return (
    <>
      {added.length > 0 && (
        <DiffGroup label={`Added (${added.length})`} tone="text-success">
          {added.map((tool) => (
            <DiffRow
              key={tool.name}
              sigil="+"
              tone="text-success"
              name={tool.name}
              note={tool.description}
            />
          ))}
        </DiffGroup>
      )}
      {removed.length > 0 && (
        <DiffGroup
          label={`Removed (${removed.length})`}
          tone="text-destructive"
        >
          {removed.map((tool) => (
            <DiffRow
              key={tool.name}
              sigil="−"
              tone="text-destructive"
              name={tool.name}
            />
          ))}
        </DiffGroup>
      )}
      {changed.length > 0 && (
        <DiffGroup label={`Changed (${changed.length})`} tone="text-warning">
          {changed.map((tool) => (
            <DiffRow
              key={tool.name}
              sigil="~"
              tone="text-warning"
              name={tool.name}
              note={tool.changedFields.join(", ")}
            />
          ))}
        </DiffGroup>
      )}
      {discovery?.changed && (
        <DiffGroup label="Server info" tone="text-warning">
          <div className="text-[11.5px] text-muted-foreground">
            {discovery.changedFields.join(", ")}
          </div>
        </DiffGroup>
      )}
      {empty && (
        <div className="text-[11.5px] text-muted-foreground">
          No tool changes
        </div>
      )}
    </>
  );
}

function DiffGroup({
  label,
  tone,
  children,
}: {
  label: string;
  tone: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div
        className={`mb-1.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
      >
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function DiffRow({
  sigil,
  tone,
  name,
  note,
}: {
  sigil: string;
  tone: string;
  name: string;
  note?: string;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <span className={`font-mono font-semibold ${tone}`}>{sigil}</span>
      <code className="shrink-0 font-mono text-[12px] font-medium">{name}</code>
      {note && (
        <span className="truncate text-[11.5px] text-muted-foreground">
          {note}
        </span>
      )}
    </div>
  );
}
