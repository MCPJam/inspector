import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, HelpCircle, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { LogRow } from "@/components/ui/log-row";
import { LogToolbar } from "@/components/ui/log-toolbar";
import { useLocalBrowserActivity } from "@/components/browser/useLocalBrowserActivity";
import type {
  LocalBrowserTraceEntry,
  LocalBrowserTraceRow,
} from "@/lib/local-browser/client";

/**
 * Browser commands as log rows. The playground Logs tab feeds these into
 * `LoggerView` so MCP traffic and the ledger share one search; this component
 * is the isolated list used by tests of the ledger itself.
 */
export function BrowserActivityList({
  projectId,
  consentToken,
  active,
  className,
}: {
  projectId: string | null;
  consentToken: string | null;
  /** False while the tab is hidden: a pane nobody is looking at polls nothing. */
  active: boolean;
  className?: string;
}) {
  const { entries, warning } = useLocalBrowserActivity({
    projectId,
    consentToken,
    active,
  });
  const [searchQuery, setSearchQuery] = useState("");

  const newestFirst = useMemo(() => [...entries].reverse(), [entries]);
  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return newestFirst;
    return newestFirst.filter((entry) =>
      entryHaystack(entry).includes(query),
    );
  }, [entries, newestFirst, searchQuery]);

  const copyLogs = useCallback(async () => {
    const copied = await copyToClipboard(JSON.stringify(filtered, null, 2));
    if (copied) toast.success("Logs copied to clipboard");
    else toast.error("Could not copy logs to your clipboard");
  }, [filtered]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <LogToolbar
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        filteredCount={filtered.length}
        totalCount={entries.length}
        onCopy={entries.length > 0 ? copyLogs : undefined}
        copyDisabled={filtered.length === 0}
        leading={
          warning ? (
            <span
              className="flex items-center gap-1 text-[11px] text-destructive"
              title={warning}
            >
              <AlertTriangle className="h-3 w-3" />
              {warning.includes("could not be read")
                ? "history unavailable"
                : "history incomplete"}
            </span>
          ) : null
        }
      />
      <div
        data-testid="rail-browser-activity"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <div className="py-8 text-center">
            <div className="text-xs text-muted-foreground">
              {entries.length === 0
                ? "Nothing has driven this browser yet."
                : "No matches in this view"}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {entries.length === 0
                ? "Commands the agent, the model, or you issue show up here."
                : "Try a different search term"}
            </div>
          </div>
        ) : (
          filtered.map((entry) =>
            entry.kind === "gap" ? (
              <GapRow key={`gap-${entry.seq}`} entry={entry} />
            ) : (
              <CommandRow key={`row-${entry.seq}`} row={entry} />
            ),
          )
        )}
      </div>
    </div>
  );
}

/**
 * One command, as a log row.
 *
 * The three outcomes are shown as three different things rather than as a
 * colour on one thing: `refused` means nothing ran, `unknown` means we cannot
 * say, and a reader who cannot tell those apart cannot tell whether to retry.
 */
export function CommandRow({ row }: { row: LocalBrowserTraceRow }) {
  const [open, setOpen] = useState(false);
  const failed = row.outcome === "executed" && row.ok === false;
  const isError = row.outcome === "refused" || row.outcome === "unknown" || failed;
  const summary = summarizeCommand(row);
  return (
    <LogRow
      expanded={open}
      onToggle={() => setOpen((value) => !value)}
      isError={isError}
      borderClass={isError ? "border-l-destructive" : "border-l-transparent"}
      badge={<KindBadge label={summary.badge} tone={summary.tone} />}
      title={summary.detail}
      titleTooltip={summary.detail}
      meta={
        <>
          <span
            className="shrink-0 text-[11px] text-muted-foreground"
            title={row.actor.label ?? undefined}
          >
            {actorLabel(row)}
          </span>
          <Outcome row={row} failed={failed} />
        </>
      }
      timestamp={timeOf(row.ts)}
    >
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/40 p-2 text-[11px]">
        {JSON.stringify(row, null, 2)}
      </pre>
    </LogRow>
  );
}

function Outcome({
  row,
  failed,
}: {
  row: LocalBrowserTraceRow;
  failed: boolean;
}) {
  if (row.outcome === "refused") {
    return (
      <span
        className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
        title={`Refused: ${row.errorCode ?? "no reason given"} — nothing ran`}
      >
        <ShieldOff className="h-3 w-3" />
        {row.errorCode ?? "refused"}
      </span>
    );
  }
  if (row.outcome === "unknown") {
    return (
      <span
        className="flex shrink-0 items-center gap-1 text-[11px] text-destructive"
        title={
          `Unknown: ${row.errorCode ?? "no reason given"} — this may or may ` +
          "not have run. Do not assume it did not."
        }
      >
        <HelpCircle className="h-3 w-3" />
        unknown
      </span>
    );
  }
  if (failed) {
    return (
      <span
        className="shrink-0 text-[11px] text-destructive"
        title={row.errorCode ?? undefined}
      >
        {row.errorCode ?? "failed"}
      </span>
    );
  }
  return null;
}

/** A stretch of history that is missing, said out loud. */
export function GapRow({
  entry,
}: {
  entry: Extract<LocalBrowserTraceEntry, { kind: "gap" }>;
}) {
  const [open, setOpen] = useState(false);
  const detail = gapMessage(entry);
  return (
    <LogRow
      expanded={open}
      onToggle={() => setOpen((value) => !value)}
      borderClass="border-l-transparent"
      badge={<KindBadge label="gap" tone="warn" />}
      title={detail}
      titleTooltip={detail}
      timestamp={timeOf(entry.ts)}
    >
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/40 p-2 text-[11px]">
        {JSON.stringify(entry, null, 2)}
      </pre>
    </LogRow>
  );
}

function gapMessage(
  entry: Extract<LocalBrowserTraceEntry, { kind: "gap" }>,
): string {
  if (entry.reason === "daemon_restart") return "the browser restarted here";
  if (entry.reason === "ring_overflow") {
    return `${entry.toSeq - entry.fromSeq + 1} earlier commands are no longer kept`;
  }
  return "some history could not be recorded";
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function KindBadge({
  label,
  tone,
}: {
  label: string;
  tone?: "error" | "warn" | "call" | "res" | "nav";
}) {
  return (
    <span
      className={cn(
        "flex-shrink-0 font-mono text-[10px] leading-none",
        tone === "error" && "text-destructive",
        tone === "warn" && "text-amber-600 dark:text-amber-400",
        tone === "call" && "text-green-600 dark:text-green-400",
        tone === "res" && "text-blue-600 dark:text-blue-400",
        tone === "nav" && "text-blue-600 dark:text-blue-400",
        !tone && "text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function summarizeCommand(row: LocalBrowserTraceRow): {
  badge: string;
  detail: string;
  tone?: "error" | "warn" | "call" | "res" | "nav";
} {
  const detail = describe(row);
  const kind = row.command.kind;
  if (kind === "navigate" || kind === "back" || kind === "reload") {
    return { badge: "nav", detail, tone: "nav" };
  }
  if (kind === "observe") return { badge: "obs", detail, tone: "res" };
  if (kind === "note") return { badge: "note", detail };
  if (kind === "webmcp_invoke") return { badge: "call", detail, tone: "call" };
  if (kind === "webmcp_cancel") return { badge: "call", detail };
  if (kind === "act") {
    return { badge: row.command.verb ?? "act", detail, tone: "call" };
  }
  return { badge: kind, detail };
}

function entryHaystack(entry: LocalBrowserTraceEntry): string {
  if (entry.kind === "gap") {
    return [gapMessage(entry), entry.reason, String(entry.seq)].join(" ").toLowerCase();
  }
  return [
    describe(entry),
    actorLabel(entry),
    entry.url ?? "",
    entry.outcome,
    entry.errorCode ?? "",
    entry.command.kind,
    String(entry.seq),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * What a row says it did, in one line.
 *
 * Reads from the RECORDED command rather than re-deriving anything: a typed
 * value is already `{redacted, chars}` by the time it reaches here, and a URL
 * has already lost its query. There is nothing to redact in this component,
 * which is the point — the pane cannot leak what it was never sent.
 */
export function describe(row: LocalBrowserTraceRow): string {
  const command = row.command;
  const target =
    command.target?.a11yRef ??
    command.target?.selector ??
    (command.target?.coordinates
      ? `(${command.target.coordinates.join(", ")})`
      : undefined);
  switch (command.kind) {
    case "navigate":
      return `navigate ${command.url ?? ""}`.trim();
    case "back":
      return "back";
    case "reload":
      return "reload";
    case "note":
      return `note — ${command.value ?? ""}`;
    case "observe":
      return `observe ${command.mode ?? ""}`.trim();
    case "webmcp_invoke":
      return "page tool";
    case "webmcp_cancel":
      return "cancel page tool";
    case "act": {
      const value = command.redactedValue
        ? `${command.redactedValue.chars} chars (hidden)`
        : command.value;
      return [command.verb, target, value].filter(Boolean).join(" ");
    }
    default:
      return command.kind;
  }
}

/** Who did it, short enough for a rail. */
export function actorLabel(row: LocalBrowserTraceRow): string {
  if (row.actor.kind === "human") return "you";
  if (row.actor.kind === "model") return "model";
  if (row.actor.kind === "agent") return row.actor.id;
  return row.actor.id;
}
