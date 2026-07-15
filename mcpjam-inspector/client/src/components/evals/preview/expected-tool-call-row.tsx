/**
 * ExpectedToolCallRow — a lightweight, read-only tool-call row for the editor's
 * right-pane "Preview". It mirrors the visual language of the chat ToolPart
 * header (icon + mono tool name + args summary + chevron) WITHOUT the
 * ToolUIPart / widget-host machinery, because an *expected* call is a spec, not
 * a real streamed invocation. The live/replay panes use the real chat surface.
 */
import { ChevronDown, Wrench, Check, X, Play, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ExpectedRowTint = "pass" | "fail" | null;

function summarizeArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const body = keys
    .map((k) => {
      const v = args[k];
      const printed =
        typeof v === "string"
          ? v
          : v === null || v === undefined
            ? "…"
            : typeof v === "object"
              ? "{…}"
              : String(v);
      return `${k}: ${printed}`;
    })
    .join(", ");
  return `{ ${body} }`;
}

export function ExpectedToolCallRow({
  toolName,
  arguments: args,
  tint = null,
  isWidget = false,
  onRun,
  isRunning = false,
}: {
  toolName: string;
  arguments?: Record<string, unknown>;
  tint?: ExpectedRowTint;
  /** This tool renders a widget — when true and `onRun` is set, the row becomes
   *  a "run the session and render this widget" entry point. */
  isWidget?: boolean;
  onRun?: () => void;
  isRunning?: boolean;
}) {
  const summary = summarizeArgs(args);
  // A widget tool with a run handler (and no pass/fail tint, i.e. the editable
  // spec) is actionable: click to run the case and render the widget live.
  const runnable = isWidget && !!onRun && !tint;

  const className = cn(
    "flex w-full items-center gap-2 overflow-hidden rounded-xl border bg-card px-3 py-2 text-left",
    tint === "pass" && "border-emerald-500/40",
    tint === "fail" && "border-rose-500/50",
    !tint && "border-border",
    runnable &&
      "group cursor-pointer transition-colors hover:border-primary/50 hover:bg-accent/40",
  );

  const inner = (
    <>
      <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="font-mono text-[13px] text-foreground">{toolName || "—"}</span>
      {summary ? (
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {summary}
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {tint === "pass" ? (
          <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
        ) : tint === "fail" ? (
          <X className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />
        ) : runnable ? (
          isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          ) : (
            <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors group-hover:text-primary">
              <Play className="h-3 w-3" />
              Render
            </span>
          )
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/50" />
        )}
      </span>
    </>
  );

  if (runnable) {
    return (
      <button
        type="button"
        className={className}
        onClick={onRun}
        disabled={isRunning}
        aria-label={`Run the session and render the ${toolName} widget`}
        title="Run the session and render this widget"
      >
        {inner}
      </button>
    );
  }

  return <div className={className}>{inner}</div>;
}
