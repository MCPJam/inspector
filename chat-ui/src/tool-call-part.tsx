import { Terminal } from "lucide-react";
import { cn } from "./internal/cn";
import { getToolStateMeta, type ToolState } from "./internal/thread-helpers";
import { JsonView } from "./parts/json-view";

export interface ToolCallPartProps {
  toolName: string;
  toolState?: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  /**
   * Optional "from {appName}" attribution. The inspector resolves this via
   * `useAppToolAttribution`; the read-only package accepts it as a plain prop.
   */
  attributionLabel?: string;
  className?: string;
}

/**
 * Read-only, provider-free tool call/result block: name, state, input, output,
 * and error. The inspector's interactive `ToolPart` (save-view button,
 * display-mode controls, CSP workbench, widget debug tabs, analytics,
 * navigation) is intentionally NOT part of this — hosts inject that via the
 * `renderTool` seam on `PartSwitch`.
 */
export function ToolCallPart({
  toolName,
  toolState,
  input,
  output,
  errorText,
  attributionLabel,
  className,
}: ToolCallPartProps) {
  const stateMeta = getToolStateMeta(toolState);
  const hasInput = input !== undefined && input !== null;
  const hasError = typeof errorText === "string" && errorText.length > 0;
  const hasOutput = !hasError && output !== undefined && output !== null;

  return (
    <div
      className={cn(
        "mcpjam-chat-tool space-y-2 rounded-lg border border-border bg-card p-3 text-xs",
        className,
      )}
      data-tool-name={toolName}
      data-tool-state={toolState ?? "unknown"}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono font-medium text-foreground">
            {toolName}
          </span>
          {attributionLabel ? (
            <span className="shrink-0 text-muted-foreground">
              from {attributionLabel}
            </span>
          ) : null}
        </div>
        {stateMeta ? (
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
            <stateMeta.Icon className={stateMeta.className} />
            <span>{stateMeta.label}</span>
          </span>
        ) : null}
      </div>

      {hasInput ? (
        <div className="space-y-1">
          <div className="font-medium text-muted-foreground">Input</div>
          <JsonView value={input} />
        </div>
      ) : null}

      {hasError ? (
        <div className="space-y-1">
          <div className="font-medium text-destructive">Error</div>
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive">
            {errorText}
          </pre>
        </div>
      ) : null}

      {hasOutput ? (
        <div className="space-y-1">
          <div className="font-medium text-muted-foreground">Output</div>
          <JsonView value={output} />
        </div>
      ) : null}
    </div>
  );
}
