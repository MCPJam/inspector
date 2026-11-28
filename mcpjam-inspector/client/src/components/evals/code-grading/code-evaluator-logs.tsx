import { cn } from "@mcpjam/design-system/cn";
import { ChevronRight } from "lucide-react";
import { SCRIPT_TEXT_CLASS } from "./setup-cleanup-row";

/**
 * A code evaluator's output tail (stdout and stderr, the last 8 KB), behind a
 * "Logs" disclosure. Raw output, so it keeps its own monospace block with
 * ligatures off and scrolls inside it.
 */
export function CodeEvaluatorLogs({
  output,
  fileName,
  defaultOpen = false,
}: {
  output: string;
  /** The script's file, named beside "Logs" when there are several. */
  fileName?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className="group text-xs" open={defaultOpen}>
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-muted-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3 shrink-0 group-open:rotate-90"
        />
        Logs
        {fileName ? (
          <span className={SCRIPT_TEXT_CLASS}>{fileName}</span>
        ) : null}
      </summary>
      {output ? (
        <pre
          className={cn(
            SCRIPT_TEXT_CLASS,
            "mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-foreground",
          )}
        >
          {output}
        </pre>
      ) : (
        <p className="mt-1.5 text-muted-foreground">No output.</p>
      )}
    </details>
  );
}
