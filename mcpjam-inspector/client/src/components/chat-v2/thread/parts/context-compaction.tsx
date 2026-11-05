import type { MouseEvent } from "react";
import { ChevronDown, FoldVertical } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import {
  CONTEXT_COMPACTION_PART,
  type ContextCompactionReport,
} from "@/shared/model-context-budget";

export type ShortenedResult = ContextCompactionReport["shortened"][number];

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });

/** The turn's compaction report, when `part` is one (PLB-300). */
export function contextCompactionReportOf(
  part: unknown,
): ContextCompactionReport | undefined {
  if ((part as { type?: unknown })?.type !== CONTEXT_COMPACTION_PART) {
    return undefined;
  }
  const data = (part as { data?: Partial<ContextCompactionReport> }).data;
  return Array.isArray(data?.shortened) && Array.isArray(data?.cleared)
    ? (data as ContextCompactionReport)
    : undefined;
}

/** How much of this call's result the model got, when it was shortened. */
export function shortenedResultFor(
  parts: readonly unknown[] | undefined,
  toolCallId: string | undefined,
): ShortenedResult | undefined {
  if (!parts || !toolCallId) return undefined;
  for (const part of parts) {
    const entry = contextCompactionReportOf(part)?.shortened.find(
      (candidate) => candidate.toolCallId === toolCallId,
    );
    if (entry) return entry;
  }
  return undefined;
}

/** On the tool card: the model got only the start and end of this result. */
export function TruncatedResultNotice({ entry }: { entry: ShortenedResult }) {
  return (
    <div className="px-3 pb-3">
      <div
        role="status"
        data-testid="tool-result-truncated"
        className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-foreground"
      >
        <p className="text-xs font-medium leading-5">
          The model got {compact.format(entry.keptTokens)} of{" "}
          {compact.format(entry.originalTokens)} tokens from this result
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          The model saw the start and the end. Return less from this tool, or a
          link instead of file contents, so the whole result reaches the model.
        </p>
      </div>
    </div>
  );
}

function showToolCall(event: MouseEvent<HTMLElement>, toolCallId: string) {
  // The thread is the list holding this message; another open thread (a
  // compare view) can hold the same transcript.
  const thread =
    event.currentTarget.closest("[data-message-id]")?.parentElement;
  const card = thread?.querySelector<HTMLElement>(
    `[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
  );
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  card?.querySelector<HTMLElement>("[role=button]")?.focus({
    preventScroll: true,
  });
}

/** In the turn: older tool results were cleared from the model's view. */
export function ContextCompactedLine({
  cleared,
}: {
  cleared: ContextCompactionReport["cleared"];
}) {
  const count = cleared.length;
  return (
    <Collapsible
      data-testid="context-compacted-line"
      className="text-xs text-muted-foreground"
    >
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-3 rounded-md py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <FoldVertical className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium">Context compacted</span>{" "}
          <span aria-hidden>·</span>
          <span>
            {count} older tool {count === 1 ? "result" : "results"} cleared
          </span>
          <ChevronDown
            className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180"
            aria-hidden
          />
        </span>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mx-auto mt-2 max-w-md space-y-2">
        <ul className="space-y-1">
          {cleared.map((entry) => (
            <li key={entry.toolCallId} className="flex items-center gap-2">
              <span className="font-mono text-foreground">
                {entry.toolName}
              </span>
              <span className="tabular-nums">
                {entry.tokens.toLocaleString("en-US")} tokens
              </span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="ml-auto h-auto p-0 text-xs"
                onClick={(event) => showToolCall(event, entry.toolCallId)}
              >
                Show in chat
              </Button>
            </li>
          ))}
        </ul>
        <p>
          The model can call these tools again if it needs the results. The chat
          keeps them in full.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
