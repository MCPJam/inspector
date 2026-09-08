import { Terminal } from "lucide-react";
import { cn } from "./internal/cn";
import { Markdown } from "./internal/markdown";
import { getToolStateMeta, type ToolState } from "./internal/thread-helpers";
import { JsonView, renderJsonText } from "./parts/json-view";
import { FoldedBlock } from "./parts/folded-block";

export interface ToolCallPartProps {
  toolName: string;
  toolState?: ToolState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  /**
   * The READABLE form of the result, when the trace adapter produced one.
   *
   * This is the difference between a conversation and a JSON dump (BB-198). A
   * tool that returns text returns it here as prose; one that returns
   * structure returns it pre-fenced. The adapter has computed this all along
   * — under `attached-to-tool` it is the ONLY place the result is carried, and
   * nothing rendered it, so User Testing sessions showed the raw payload while
   * Swarm sessions (which get the result as a sibling text part) read fine.
   */
  resultText?: string;
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
 *
 * **Input and output FOLD when large.** A tool result is evidence, not the
 * conversation: a session whose every call inlines two hundred lines of JSON
 * stops being a transcript anyone can read (BB-198). Small payloads stay open
 * and gain no control.
 *
 * **The readable result wins over the raw one.** When `resultText` is present
 * it replaces the JSON view of `output` rather than sitting beside it —
 * showing both would put the dump back in the transcript next to its own
 * translation. The raw payload is still one click away in the session's Raw /
 * Trace tab, which is where someone who wants bytes is looking.
 */
export function ToolCallPart({
  toolName,
  toolState,
  input,
  output,
  errorText,
  resultText,
  attributionLabel,
  className,
}: ToolCallPartProps) {
  const stateMeta = getToolStateMeta(toolState);
  const hasInput = input !== undefined && input !== null;
  const hasError = typeof errorText === "string" && errorText.length > 0;
  // `PartSwitch` already applies this test via `readTraceDisplayText`; kept
  // here for direct callers of the public component, which reach this prop
  // without passing through the shared reader.
  const readableResult =
    typeof resultText === "string" && resultText.trim().length > 0
      ? resultText
      : null;
  const hasRawOutput =
    !hasError && !readableResult && output !== undefined && output !== null;

  // Serialised ONCE and handed to both the fold (which sizes it) and the view
  // (which shows it). Doing it here and again inside `JsonView` stringified
  // every large payload twice per render, and left the measured text and the
  // displayed text agreeing only because two call sites happened to branch the
  // same way.
  const inputText = hasInput ? renderJsonText(input) : "";
  const outputText = hasRawOutput ? renderJsonText(output) : "";

  return (
    <div
      className={cn(
        "mcpjam-chat-tool space-y-2 rounded-lg border border-border bg-card p-3 text-xs",
        className
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
        <FoldedBlock label="Input" text={inputText}>
          <JsonView value={input} text={inputText} />
        </FoldedBlock>
      ) : null}

      {hasError ? (
        <div className="space-y-1">
          <div className="font-medium text-destructive">Error</div>
          <pre className="overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive">
            {errorText}
          </pre>
        </div>
      ) : null}

      {readableResult ? (
        <FoldedBlock label="Result" text={readableResult}>
          {/* One renderer for both kinds the adapter produces: prose the tool
              returned, and structured output it already fenced as ```json.
              Markdown gives the fence its code treatment, so there is no
              second branch to keep in step. */}
          <Markdown
            content={readableResult}
            className="max-w-full overflow-auto break-words text-foreground"
          />
        </FoldedBlock>
      ) : null}

      {hasRawOutput ? (
        <FoldedBlock label="Output" text={outputText}>
          <JsonView value={output} text={outputText} />
        </FoldedBlock>
      ) : null}
    </div>
  );
}
