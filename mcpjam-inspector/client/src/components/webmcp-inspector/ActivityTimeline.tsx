import { useState } from "react";
import { cn } from "@/lib/utils";
import type { WebMcpActivityEntry } from "@/shared/webmcp-inspector-protocol";

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
}: {
  entries: WebMcpActivityEntry[];
}) {
  if (entries.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Navigation, tool registrations and invocations show up here.
      </p>
    );
  }
  return (
    <ol className="divide-y">
      {[...entries].reverse().map((entry) => (
        <li key={entry.id} className="px-3 py-2">
          <ActivityRow entry={entry} />
        </li>
      ))}
    </ol>
  );
}

function timeOf(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function ActivityRow({ entry }: { entry: WebMcpActivityEntry }) {
  const [open, setOpen] = useState(false);

  const header = (label: string, detail?: string, tone?: "error" | "warn") => (
    <div className="flex items-baseline gap-2">
      <span className="text-[11px] tabular-nums text-muted-foreground">
        {timeOf(entry.ts)}
      </span>
      <span
        className={cn(
          "text-xs font-medium",
          tone === "error" && "text-destructive",
          tone === "warn" && "text-amber-600 dark:text-amber-500",
        )}
      >
        {label}
      </span>
      {detail ? (
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      ) : null}
    </div>
  );

  switch (entry.kind) {
    case "session_started":
      return header("Session started", entry.url);
    case "navigated":
      return header("Navigated", entry.url);
    case "popup_opened":
      return (
        <div>
          {header("Popup opened", entry.url, "warn")}
          <p className="pl-14 text-[11px] text-muted-foreground">
            {entry.note}
          </p>
        </div>
      );
    case "tools_added":
      return header(
        `Registered ${entry.tools.length} tool${entry.tools.length === 1 ? "" : "s"}`,
        entry.tools.map((tool) => tool.name).join(", "),
      );
    case "tools_removed":
      return header(
        `Removed ${entry.tools.length} tool${entry.tools.length === 1 ? "" : "s"}`,
        entry.tools.map((tool) => tool.name).join(", "),
      );
    case "external_invocation":
      return header("Tool invoked elsewhere", entry.note, "warn");
    case "session_error":
      return header("Session error", entry.message, "error");
    case "unsupported":
      return header("WebMCP unavailable", entry.message, "warn");
    // The two invocation rows are disclosures: the HEADER is the button, and
    // the panel is its sibling. Nesting the panel inside would put flow content
    // (div/p/pre/figure) in a <button>, which is invalid, and would make the
    // whole payload — screenshot included — one giant click target.
    case "invocation_started":
      return (
        <div>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="w-full text-left"
          >
            {header(
              `Invoked ${entry.toolKey}`,
              entry.source === "chat" ? "from chat" : "manual",
            )}
          </button>
          {open ? (
            <div className="pl-14 pt-1 space-y-2">
              <Payload
                label="Input"
                value={entry.input}
                truncated={entry.inputTruncated}
              />
              <Shot base64={entry.screenshotBase64} caption="Before" />
            </div>
          ) : null}
        </div>
      );
    case "invocation_settled":
      return (
        <div>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="w-full text-left"
          >
            {header(
              `${entry.state} · ${entry.toolKey}`,
              `${entry.durationMs}ms`,
              entry.state === "succeeded" ? undefined : "error",
            )}
          </button>
          {open ? (
            <div className="pl-14 pt-1 space-y-2">
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
          ) : null}
        </div>
      );
  }
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
      <pre className="max-h-56 overflow-auto rounded border bg-muted/40 p-2 text-[11px] whitespace-pre-wrap break-words">
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
