import { useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { cn } from "@/lib/utils";
import type { RefusedToolCall } from "@/shared/eval-tool-call-projection";

/**
 * Calls MCPJam refused before they reached the server, listed beside the
 * expected-vs-actual comparison and never inside it: they were not executed,
 * so the verdict did not count them. Each row says what the model sent and
 * the error text it got back, which is what the model read before retrying.
 */
export function RefusedToolCalls({
  calls,
  className,
}: {
  calls: readonly RefusedToolCall[];
  className?: string;
}) {
  if (calls.length === 0) return null;
  return (
    <div
      className={cn("flex flex-col gap-1 pt-2", className)}
      data-testid="refused-tool-calls"
    >
      <p className="px-0.5 text-xs text-muted-foreground">
        {calls.length === 1
          ? "MCPJam refused this call before it reached the server, so it doesn't count as a tool call."
          : "MCPJam refused these calls before they reached the server, so they don't count as tool calls."}
      </p>
      {calls.map((call) => (
        <RefusedToolCallRow key={call.toolCallId} call={call} />
      ))}
    </div>
  );
}

function RefusedToolCallRow({ call }: { call: RefusedToolCall }) {
  const [open, setOpen] = useState(false);
  const rawText =
    typeof call.arguments === "string" ? call.arguments : undefined;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-md border border-l-2 border-border/40 border-l-warning/60 bg-background/40"
      data-testid="refused-tool-call"
    >
      <CollapsibleTrigger
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/20"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          {call.toolName}
        </span>
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-warning">
          Refused by client
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t border-border/40 px-2.5 py-2">
        <Detail
          label={
            rawText === undefined
              ? "Arguments sent"
              : "Arguments sent as raw text"
          }
          text={rawText ?? JSON.stringify(call.arguments ?? {}, null, 2)}
        />
        <Detail
          label="Error sent to the model"
          text={call.reason ?? "No error text recorded."}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function Detail({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/90">
        {text}
      </pre>
    </div>
  );
}
