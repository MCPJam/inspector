import { useMemo, useState } from "react";
import { Copy, Download, PanelRightClose, Search } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { cn } from "@/lib/utils";
import { LogRow } from "@/components/ui/log-row";
import type { WebMcpActivityEntry } from "@/shared/webmcp-inspector-protocol";
import { ActionMenu, ActionMenuItem } from "./ActionMenu";

/**
 * What happened, in order, across navigations.
 *
 * This is the part Chrome's own WebMCP panel does not keep: a record that
 * survives the page moving, pairs each invocation with before/after evidence,
 * and can be exported. Newest first, because the interesting entry is almost
 * always the last one.
 */
export function ActivityTimeline({
  entries,
  onCopy,
  onExportJson,
  onExportOtlp,
  onClose,
}: {
  entries: WebMcpActivityEntry[];
  onCopy?: (entries: WebMcpActivityEntry[]) => void;
  onExportJson?: () => void;
  onExportOtlp?: () => void;
  onClose?: () => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const newestFirst = [...entries].reverse();
    if (!query) return newestFirst;
    return newestFirst.filter((entry) => activityHaystack(entry).includes(query));
  }, [entries, searchQuery]);

  const canExport = entries.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="@container/logger-toolbar flex min-w-0 shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search logs"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="h-7 pl-7 text-xs"
          />
        </div>
        <span className="hidden whitespace-nowrap text-xs text-muted-foreground @min-[400px]/logger-toolbar:inline-block">
          {filtered.length} / {entries.length}
        </span>
        {canExport ? (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onCopy?.(filtered)}
              disabled={filtered.length === 0}
              className="h-7 w-7 shrink-0"
              title="Copy logs to clipboard"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <ActionMenu
              triggerLabel="Export activity"
              triggerTitle="Export activity"
              align="end"
              trigger={<Download className="h-3.5 w-3.5" />}
            >
              {(close) => (
                <>
                  <ActionMenuItem
                    onSelect={() => {
                      onExportJson?.();
                      close();
                    }}
                  >
                    Export JSON
                  </ActionMenuItem>
                  <ActionMenuItem
                    onSelect={() => {
                      onExportOtlp?.();
                      close();
                    }}
                  >
                    Export OTLP
                  </ActionMenuItem>
                </>
              )}
            </ActionMenu>
          </>
        ) : null}
        {onClose ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-7 w-7 flex-shrink-0"
            title="Hide activity"
            aria-label="Hide activity"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="py-8 text-center">
            <div className="text-xs text-muted-foreground">
              {entries.length === 0 ? "No logs yet" : "No matches in this view"}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">
              {entries.length === 0
                ? "Navigation, tool registrations and invocations show up here."
                : "Try a different search term"}
            </div>
          </div>
        ) : (
          <div>
            {filtered.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function activityHaystack(entry: WebMcpActivityEntry): string {
  const parts: string[] = [entry.kind];
  switch (entry.kind) {
    case "session_started":
    case "navigated":
    case "popup_opened":
      parts.push(entry.url);
      if (entry.kind === "popup_opened") parts.push(entry.note);
      break;
    case "tools_added":
    case "tools_removed":
      parts.push(...entry.tools.map((tool) => `${tool.name} ${tool.toolKey}`));
      break;
    case "invocation_started":
      parts.push(entry.toolKey, entry.source, JSON.stringify(entry.input));
      break;
    case "invocation_settled":
      parts.push(
        entry.toolKey,
        entry.state,
        entry.errorMessage ?? "",
        JSON.stringify(entry.output),
      );
      break;
    case "external_invocation":
      parts.push(entry.note);
      break;
    case "session_error":
    case "unsupported":
      parts.push(entry.message);
      break;
  }
  return parts.join(" ").toLowerCase();
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

function ActivityRow({ entry }: { entry: WebMcpActivityEntry }) {
  const [open, setOpen] = useState(false);
  const summary = summarizeActivity(entry);
  const isError =
    entry.kind === "session_error" ||
    (entry.kind === "invocation_settled" && entry.state !== "succeeded");

  return (
    <LogRow
      expanded={open}
      onToggle={() => setOpen((value) => !value)}
      isError={isError}
      borderClass={isError ? "border-l-destructive" : "border-l-transparent"}
      badge={<KindBadge label={summary.badge} tone={summary.tone} />}
      title={summary.detail}
      titleTooltip={summary.detail}
      timestamp={timeOf(entry.ts)}
    >
      <ActivityDetail entry={entry} />
    </LogRow>
  );
}

function summarizeActivity(entry: WebMcpActivityEntry): {
  badge: string;
  detail: string;
  tone?: "error" | "warn" | "call" | "res" | "nav";
} {
  switch (entry.kind) {
    case "session_started":
      return { badge: "sess", detail: entry.url };
    case "navigated":
      return { badge: "nav", detail: entry.url, tone: "nav" };
    case "popup_opened":
      return { badge: "popup", detail: entry.url, tone: "warn" };
    case "tools_added":
      return {
        badge: "reg",
        detail: entry.tools.map((tool) => tool.name).join(", "),
      };
    case "tools_removed":
      return {
        badge: "unreg",
        detail: entry.tools.map((tool) => tool.name).join(", "),
      };
    case "external_invocation":
      return { badge: "ext", detail: entry.note, tone: "warn" };
    case "session_error":
      return { badge: "err", detail: entry.message, tone: "error" };
    case "unsupported":
      return { badge: "warn", detail: entry.message, tone: "warn" };
    case "invocation_started":
      return {
        badge: "call",
        detail: `${entry.toolKey}${entry.source === "chat" ? " · chat" : ""}`,
        tone: "call",
      };
    case "invocation_settled":
      return {
        badge: entry.state === "succeeded" ? "res" : "err",
        detail: `${entry.toolKey} · ${entry.durationMs}ms`,
        tone: entry.state === "succeeded" ? "res" : "error",
      };
  }
}

function ActivityDetail({ entry }: { entry: WebMcpActivityEntry }) {
  switch (entry.kind) {
    case "invocation_started":
      return (
        <div className="space-y-2">
          <Payload
            label="Input"
            value={entry.input}
            truncated={entry.inputTruncated}
          />
          <Shot base64={entry.screenshotBase64} caption="Before" />
        </div>
      );
    case "invocation_settled":
      return (
        <div className="space-y-2">
          {entry.errorMessage ? (
            <p className="text-xs text-destructive">{entry.errorMessage}</p>
          ) : (
            <Payload
              label="Output"
              value={entry.output}
              truncated={entry.outputTruncated}
              bytes={entry.outputBytes}
            />
          )}
          <Shot base64={entry.screenshotBase64} caption="After" />
        </div>
      );
    case "tools_added":
    case "tools_removed":
      return (
        <ul className="space-y-1.5">
          {entry.tools.map((tool) => (
            <li key={tool.toolKey} className="font-mono text-[11px]">
              <p>{tool.name}</p>
              <p className="truncate text-muted-foreground">{tool.toolKey}</p>
            </li>
          ))}
          {entry.kind === "tools_removed" ? (
            <li className="text-[11px] text-muted-foreground">
              cause: {entry.cause}
            </li>
          ) : null}
        </ul>
      );
    default:
      return (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/40 p-2 text-[11px]">
          {JSON.stringify(activityPayload(entry), null, 2)}
        </pre>
      );
  }
}

function activityPayload(entry: WebMcpActivityEntry): Record<string, unknown> {
  const { screenshotBase64: _screenshot, ...rest } = entry as WebMcpActivityEntry & {
    screenshotBase64?: string;
  };
  return rest;
}

function Payload({
  label,
  value,
  truncated,
  bytes,
}: {
  label: string;
  value: unknown;
  truncated?: boolean;
  bytes?: number;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
        {truncated ? ` · truncated${bytes ? ` from ${bytes} bytes` : ""}` : ""}
      </p>
      {/* Text, never markup: page output is untrusted. */}
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/40 p-2 text-[11px]">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function Shot({ base64, caption }: { base64?: string; caption: string }) {
  if (!base64) return null;
  return (
    <figure className="space-y-1">
      <img
        src={`data:image/jpeg;base64,${base64}`}
        alt={`${caption} the invocation`}
        className="max-h-48 rounded border"
      />
      <figcaption className="text-[11px] text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}
