import { useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "./internal/cn";
import { Markdown } from "./internal/markdown";
import { McpIcon } from "./internal/mcp-icon";
import { getToolStateMeta, type ToolState } from "./internal/thread-helpers";
import { JsonView, renderJsonText } from "./parts/json-view";
import type { JsonRenderer } from "./types";

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
  /**
   * How to display the JSON payloads. Defaults to {@link JsonView}, this
   * package's plain `<pre>`; the inspector passes the collapsible tree the
   * Playground uses. See {@link JsonRenderer}.
   *
   * It governs the two RAW payloads — input and unreadable output — and never
   * the readable result, which is prose or an already-fenced block and goes
   * through Markdown whatever this is set to.
   */
  renderJson?: JsonRenderer;
  /**
   * Whether the card starts open. Defaults to closed, matching the inspector's
   * own tool card — except for a FAILED call, which opens itself; see the note
   * on collapsing below.
   */
  defaultOpen?: boolean;
  className?: string;
}

/** The small-caps heading over each payload. */
function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  );
}

/**
 * The frame a payload sits in: one scroll box, capped, so a long result cannot
 * push the next section off the screen. Same measurements as the inspector's
 * card, which is the point.
 */
function PayloadBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-h-[300px] overflow-auto rounded-md border border-border/30 bg-muted/20">
      {children}
    </div>
  );
}

/**
 * Read-only, provider-free tool call/result block: name, state, input, output,
 * and error. The inspector's interactive `ToolPart` (save-view button,
 * display-mode controls, CSP workbench, widget debug tabs, analytics,
 * navigation) is intentionally NOT part of this — hosts inject that via the
 * `renderTool` seam on `PartSwitch`.
 *
 * **It wears the same card the inspector's own tool block does.** One product
 * showed a tool call two different ways depending on which tab you were in:
 * the Playground's card collapses to a single header line and opens onto
 * labelled, boxed payloads, while this one was a header with each payload
 * folding separately underneath. The shell here — the header row, the MCP
 * mark, the mono tool name, the state on the right, the chevron, the
 * INPUT/RESULT headings and the capped payload boxes — is that card's, so the
 * two read as the same thing seen twice rather than two components.
 *
 * What is deliberately NOT carried over is the inspector card's toolbar
 * (Inline / PiP / Fullscreen, Data, Sandbox, Edit). Those drive a live widget
 * and re-run a tool with edited input; against a recorded session there is
 * nothing for them to act on.
 *
 * **The whole card collapses, and starts collapsed.** It replaces the
 * per-payload fold this had before, and answers the same complaint more
 * completely: a transcript whose every call inlines two hundred lines of JSON
 * stops being something anyone can read (BB-198). One header line per call
 * means the conversation stays the thing on screen, and a call you are curious
 * about is one click away. `defaultOpen` is there for a host that is showing a
 * single call rather than a transcript of them.
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
  renderJson,
  defaultOpen,
  className,
}: ToolCallPartProps) {
  const stateMeta = getToolStateMeta(toolState);
  const hasInput = input !== undefined && input !== null;
  const hasError = typeof errorText === "string" && errorText.length > 0;
  // A FAILED call opens itself. Collapsing by default is right for the two
  // hundred lines of JSON a working call returns; an error is the reason
  // someone opened the session, and putting it behind a disclosure means the
  // one thing they came to read is the one thing they have to hunt for. An
  // explicit `defaultOpen` still wins, in either direction.
  //
  // DERIVED, not seeded into `useState`. `MessageView` keys a tool part by its
  // `toolCallId`, which is stable from the moment the input starts streaming —
  // so a call that fails LATER keeps the component it mounted with, and a
  // `useState(… ?? hasError)` initialiser, which runs once, would leave the
  // card collapsed over exactly the failure this rule exists to surface.
  // `null` here means the reader has not touched this card; once they have,
  // their answer outranks ours, including when an error arrives afterwards.
  const [readerOpen, setReaderOpen] = useState<boolean | null>(null);
  const open = readerOpen ?? defaultOpen ?? hasError;
  // `PartSwitch` already applies this test via `readTraceDisplayText`; kept
  // here for direct callers of the public component, which reach this prop
  // without passing through the shared reader.
  const readableResult =
    typeof resultText === "string" && resultText.trim().length > 0
      ? resultText
      : null;
  const hasRawOutput =
    !hasError && !readableResult && output !== undefined && output !== null;

  // Serialised ONCE and handed to the renderer, rather than again inside
  // `JsonView`: doing it in both places stringified every large payload twice
  // per render, and left the two call sites agreeing only by coincidence.
  const inputText = hasInput ? renderJsonText(input) : "";
  const outputText = hasRawOutput ? renderJsonText(output) : "";

  // One place decides, so input and output cannot end up rendered by two
  // different things — which is what happened while only one call site had
  // been switched over.
  const showJson = (value: unknown, text: string) =>
    renderJson ? (
      renderJson(value, text)
    ) : (
      // The box around it already draws the frame; without this the default
      // renderer's own border and ground sit inside a second one.
      <JsonView
        value={value}
        text={text}
        className="rounded-none border-0 bg-transparent p-2 text-[11px]"
      />
    );

  const toggle = () => setReaderOpen(!open);
  const onHeaderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  };

  return (
    <div
      className={cn(
        "mcpjam-chat-tool @container rounded-lg border border-border/50 bg-background/70 text-xs",
        className
      )}
      data-tool-name={toolName}
      data-tool-state={toolState ?? "unknown"}
    >
      {/* The whole row is the target, not a chevron a few pixels wide. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onHeaderKeyDown}
        data-testid="tool-card-header"
        className={cn(
          "mcpjam-chat-tool-header flex w-full cursor-pointer items-center",
          "justify-between gap-2 px-3 py-2 text-left",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          <McpIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
          <span className="truncate font-mono text-xs tracking-tight text-muted-foreground/80">
            {toolName}
          </span>
          {attributionLabel ? (
            <span className="inline-flex shrink-0 items-center rounded-full bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground/80">
              from {attributionLabel}
            </span>
          ) : null}
        </span>
        <span className="inline-flex shrink-0 items-center gap-2 text-muted-foreground">
          {stateMeta ? (
            <span className="inline-flex items-center gap-1">
              <stateMeta.Icon className={stateMeta.className} />
              <span>{stateMeta.label}</span>
            </span>
          ) : null}
          <ChevronDown
            aria-hidden
            className={cn(
              "h-4 w-4 transition-transform duration-150",
              open && "rotate-180"
            )}
          />
        </span>
      </div>

      {open ? (
        <div className="space-y-3 border-t border-border/40 px-3 py-3">
          {hasInput ? (
            <div className="space-y-1">
              <SectionLabel>Input</SectionLabel>
              <PayloadBox>{showJson(input, inputText)}</PayloadBox>
            </div>
          ) : null}

          {hasError ? (
            <div className="space-y-1">
              <SectionLabel>Error</SectionLabel>
              <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
                {errorText}
              </pre>
            </div>
          ) : null}

          {readableResult ? (
            <div className="space-y-1">
              <SectionLabel>Result</SectionLabel>
              {/* One renderer for both kinds the adapter produces: prose the
                  tool returned, and structured output it already fenced as
                  ```json. Markdown gives the fence its code treatment, so there
                  is no second branch to keep in step.

                  NOT in a `PayloadBox`: this is the readable answer, the one
                  thing in the card meant to be read rather than inspected, and
                  boxing it as a payload is what BB-198 asked us to stop doing.
                  It still gets the same cap, so a long answer cannot bury the
                  next call. */}
              <Markdown
                content={readableResult}
                className="max-h-[300px] max-w-full overflow-auto break-words text-foreground"
              />
            </div>
          ) : null}

          {hasRawOutput ? (
            <div className="space-y-1">
              <SectionLabel>Result</SectionLabel>
              <PayloadBox>{showJson(output, outputText)}</PayloadBox>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
