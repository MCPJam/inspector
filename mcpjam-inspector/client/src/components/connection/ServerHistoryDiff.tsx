import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { cn } from "@/lib/utils";
import {
  diffDiscoveryField,
  diffToolField,
  revisionMissing,
  type DiffLine,
  type FieldDiff,
  type SnapshotDiscovery,
  type SnapshotTool,
} from "./server-history-diff";

/** `diffInspectionRevisions`'s diff, kept narrow to what we render. */
export interface SnapshotDiff {
  discovery?: { changed: boolean; changedFields: string[] };
  tools: {
    added: SnapshotTool[];
    removed: Array<{ name: string }>;
    changed: Array<{
      name: string;
      changedFields: string[];
      before?: SnapshotTool;
      after?: SnapshotTool;
    }>;
  };
}

/** What one revision row adds that the diff itself does not carry. */
export interface RevisionSide {
  revisionNumber: number;
  discovery?: SnapshotDiscovery;
  droppedFields?: string[];
}

/** Past this many changed tools, rows start closed to keep the list short. */
const OPEN_BY_DEFAULT_MAX = 5;

export function RevisionDiffView({
  diff,
  from,
  to,
}: {
  diff: SnapshotDiff;
  /** `undefined` while the revision loads; `null` if it is missing. */
  from: RevisionSide | null | undefined;
  to: RevisionSide | null | undefined;
}) {
  const { added, removed, changed } = diff.tools;
  const discovery = diff.discovery;
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        changed.length <= OPEN_BY_DEFAULT_MAX
          ? changed.map((tool) => tool.name)
          : [],
      ),
  );
  const allOpen = changed.every((tool) => open.has(tool.name));
  const toggle = (name: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  const missingIn = (path: string) => revisionMissing([from, to], path);

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
        <DiffGroup
          label={`Changed (${changed.length})`}
          tone="text-warning"
          action={
            changed.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  setOpen(
                    new Set(allOpen ? [] : changed.map((tool) => tool.name)),
                  )
                }
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                {allOpen ? "Collapse all" : "Expand all"}
              </button>
            )
          }
        >
          {changed.map((tool) => (
            <ChangedTool
              key={tool.name}
              tool={tool}
              isOpen={open.has(tool.name)}
              onToggle={() => toggle(tool.name)}
              missingIn={missingIn}
            />
          ))}
        </DiffGroup>
      )}
      {discovery?.changed && (
        <DiffGroup label="Server info" tone="text-warning">
          <div className="space-y-2.5">
            {discovery.changedFields.map((field) => (
              <DiscoveryField key={field} field={field} from={from} to={to} />
            ))}
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

function ChangedTool({
  tool,
  isOpen,
  onToggle,
  missingIn,
}: {
  tool: SnapshotDiff["tools"]["changed"][number];
  isOpen: boolean;
  onToggle: () => void;
  missingIn: (path: string) => number | undefined;
}) {
  // Closed rows draw no diff, so they skip computing one.
  const diffs = useMemo(
    () =>
      isOpen
        ? tool.changedFields.map((field) =>
            diffToolField(tool.before, tool.after, field),
          )
        : [],
    [tool, isOpen],
  );
  return (
    <div>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={onToggle}
        className="flex w-full min-w-0 items-baseline gap-2 rounded text-left hover:bg-muted/50"
      >
        <DiffRowContent
          sigil="~"
          tone="text-warning"
          name={tool.name}
          // Open, each field labels its own diff below.
          note={isOpen ? undefined : tool.changedFields.join(", ")}
        />
        <ChevronRight
          aria-hidden
          className={cn(
            "h-3 w-3 shrink-0 self-center text-muted-foreground transition-transform",
            isOpen && "rotate-90",
          )}
        />
      </button>
      {isOpen && (
        <div className="mb-2.5 ml-4 mt-1.5 space-y-2.5">
          {tool.changedFields.map((field, index) => (
            <FieldBlock
              key={field}
              label={field}
              diff={diffs[index]}
              missingFrom={missingIn(`tools.${tool.name}.${field}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DiscoveryField({
  field,
  from,
  to,
}: {
  field: string;
  from: RevisionSide | null | undefined;
  to: RevisionSide | null | undefined;
}) {
  const label = field.replace(/^serverInfo\./, "");
  const before = from?.discovery;
  const after = to?.discovery;
  const diff = useMemo(
    () => diffDiscoveryField(before, after, field),
    [before, after, field],
  );
  if (!from || !to) {
    return (
      <FieldBlock label={label}>
        {from === null || to === null ? (
          <Note>Revision not found, so these values can't be shown.</Note>
        ) : (
          <Skeleton className="h-4 w-40" />
        )}
      </FieldBlock>
    );
  }
  return (
    <FieldBlock
      label={label}
      diff={diff}
      missingFrom={revisionMissing([from, to], `discovery.${field}`)}
    />
  );
}

function FieldBlock({
  label,
  diff,
  missingFrom,
  children,
}: {
  label: string;
  diff?: FieldDiff;
  missingFrom?: number;
  children?: ReactNode;
}) {
  const body =
    missingFrom !== undefined ? (
      <Note>
        Revision {missingFrom} was too large to store in full, so this field
        can't be compared.
      </Note>
    ) : diff ? (
      <FieldDiffBody diff={diff} />
    ) : (
      children
    );
  const inline = diff?.kind === "inline" && missingFrom === undefined;
  return (
    <div className={cn("min-w-0", inline && "flex items-baseline gap-2")}>
      <div
        className={cn(
          "shrink-0 font-mono text-[11px] text-muted-foreground",
          !inline && "mb-1",
        )}
      >
        {label}
      </div>
      {body}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <div className="text-[11.5px] text-muted-foreground">{children}</div>;
}

function FieldDiffBody({ diff }: { diff: FieldDiff }) {
  if (diff.kind === "inline") {
    return <InlineChange before={diff.before} after={diff.after} />;
  }
  if (diff.lines.length === 0) {
    return <Note>Only whitespace changed.</Note>;
  }
  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-background font-mono text-[11.5px] leading-[18px]">
      {diff.lines.map((line, index) => (
        <DiffLineRow key={index} line={line} />
      ))}
    </div>
  );
}

function InlineChange({ before, after }: { before?: string; after?: string }) {
  const value = (text: string | undefined, tint: string) =>
    text === undefined ? (
      <span className="italic text-muted-foreground">not set</span>
    ) : (
      <span className={cn("break-all rounded-sm px-1", tint)}>{text}</span>
    );
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-mono text-[11.5px]">
      {value(
        before,
        "bg-destructive/10 line-through decoration-destructive/60",
      )}
      <span aria-hidden className="text-muted-foreground">
        →
      </span>
      <span className="sr-only">changed to</span>
      {value(after, "bg-success/10")}
    </span>
  );
}

const LINE_STYLES = {
  removed: {
    row: "bg-destructive/10",
    sigil: "-",
    tone: "text-destructive",
    label: "Removed: ",
    mark: "bg-destructive/25",
  },
  added: {
    row: "bg-success/10",
    sigil: "+",
    tone: "text-success",
    label: "Added: ",
    mark: "bg-success/25",
  },
} as const;

function DiffLineRow({ line }: { line: DiffLine }) {
  if (line.kind === "gap") {
    return (
      <div className="bg-muted/50 px-2 text-[10.5px] text-muted-foreground">
        {line.count} unchanged {line.count === 1 ? "line" : "lines"}
      </div>
    );
  }
  const style = line.kind === "context" ? undefined : LINE_STYLES[line.kind];
  return (
    <div className={cn("flex min-h-[18px]", style?.row)}>
      <span
        aria-hidden
        className={cn("w-5 shrink-0 select-none text-center", style?.tone)}
      >
        {style?.sigil}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap pr-2 [overflow-wrap:anywhere]",
          !style && "text-muted-foreground",
        )}
      >
        {line.kind === "context" ? (
          line.text
        ) : (
          <>
            <span className="sr-only">{style?.label}</span>
            {line.segments.map((segment, index) =>
              segment.changed ? (
                <span key={index} className={cn("rounded-[2px]", style?.mark)}>
                  {segment.text}
                </span>
              ) : (
                segment.text
              ),
            )}
          </>
        )}
      </span>
    </div>
  );
}

export function DiffGroup({
  label,
  tone,
  action,
  children,
}: {
  label: string;
  tone: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <div
          className={`text-[10px] font-semibold uppercase tracking-wide ${tone}`}
        >
          {label}
        </div>
        {action}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

type RowProps = { sigil: string; tone: string; name: string; note?: string };

export function DiffRow(props: RowProps) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <DiffRowContent {...props} />
    </div>
  );
}

function DiffRowContent({ sigil, tone, name, note }: RowProps) {
  return (
    <>
      <span className={`font-mono font-semibold ${tone}`}>{sigil}</span>
      <code className="shrink-0 font-mono text-[12px] font-medium">{name}</code>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
        {note}
      </span>
    </>
  );
}
