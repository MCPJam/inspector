import { useState } from "react";
import { AlertTriangle, Check, ChevronLeft, Copy, History } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import type { EvalIteration } from "../../evals/types";

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function IterationIdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm font-mono text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
      title={`Iteration ${id} — click to copy`}
      aria-label={`Copy iteration id ${id}`}
    >
      {copied ? (
        <Check className="h-2.5 w-2.5 text-success" aria-hidden />
      ) : (
        <Copy className="h-2.5 w-2.5" aria-hidden />
      )}
      {id.slice(-6)}
    </button>
  );
}

export function InspectStrip({
  iteration,
  edited,
  onEditCase,
}: {
  iteration: EvalIteration;
  edited: boolean;
  onEditCase: () => void;
}) {
  const ranAt = iteration.startedAt ?? iteration.createdAt;
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 pb-2"
      data-testid="case-workspace-inspect-strip"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning-foreground">
          <History className="h-2.5 w-2.5" aria-hidden />
          Viewing run
        </span>
        <span className="truncate">
          Iter #{iteration.iterationNumber}
          <span aria-hidden> · </span>
          {formatTimeAgo(ranAt)}
        </span>
        <span className="shrink-0 opacity-40" aria-hidden>
          ·
        </span>
        <IterationIdChip id={iteration._id} />
        {edited ? (
          <>
            <span className="shrink-0 opacity-40" aria-hidden>
              ·
            </span>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="Case changed since this run"
                >
                  <AlertTriangle className="h-3 w-3 text-warning" aria-hidden />
                  Changed
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                side="bottom"
                className="w-64 p-2.5 text-[11px] leading-snug text-muted-foreground"
              >
                This view shows the scenario frozen at run time. Edit case
                restores the current draft.
              </PopoverContent>
            </Popover>
          </>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={onEditCase}
      >
        <ChevronLeft className="h-3 w-3" aria-hidden />
        Edit case
      </Button>
    </div>
  );
}
