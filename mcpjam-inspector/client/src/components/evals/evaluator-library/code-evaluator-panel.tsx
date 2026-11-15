import { Button } from "@mcpjam/design-system/button";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * What the evaluator runner enforces, stated where the author writes code.
 * These mirror the runtime: DEFAULT_EVALUATOR_TIMEOUT_MS is 60 s, a throw is
 * finalized to an error result, and a score outside [0, 1] is rejected.
 */
export const RUNNER_LIMITS = [
  "Runs in a sandbox with no network or file system",
  "60 s limit per evaluator",
  "If your code fails to run, the result is an error and gets no score",
  "score must be a number from 0 to 1",
] as const;

export type CodeEvaluatorPanelProps = {
  fileName: string;
  code: string;
  /** 1-based line to highlight, e.g. where a test iteration threw. */
  errorLine?: number;
  /** Runner output for the selected test iteration. */
  consoleOutput?: string;
  /** Files synced from GitHub are read-only here. */
  source?: "hosted" | "github";
  onRunTests?: () => void;
};

/**
 * A read-only view of a code evaluator with its test output. It shows the
 * shape authors write against, `evaluate(context)` returning a score and an
 * explanation; editing arrives with the editor integration.
 */
export function CodeEvaluatorPanel({
  fileName,
  code,
  errorLine,
  consoleOutput,
  source = "hosted",
  onRunTests,
}: CodeEvaluatorPanelProps) {
  const lines = code.split("\n");
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-[var(--code-bg)]">
      <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5">
        <span className="font-mono text-xs text-card-foreground">
          {fileName}
        </span>
        {source === "github" ? (
          <span className="text-xs text-muted-foreground">
            Synced from GitHub · edits open a pull request
          </span>
        ) : null}
        {onRunTests ? (
          <Button size="sm" className="ml-auto h-7" onClick={onRunTests}>
            <Play aria-hidden />
            Run tests
          </Button>
        ) : null}
      </div>
      <pre
        role="region"
        aria-label={`${fileName} source`}
        className="overflow-x-auto py-2.5 font-mono text-xs leading-relaxed text-[var(--code-text)]"
      >
        {lines.map((line, index) => {
          const lineNumber = index + 1;
          const isError = lineNumber === errorLine;
          return (
            <div
              key={lineNumber}
              data-error-line={isError || undefined}
              className={cn("flex pr-3", isError && "bg-destructive/10")}
            >
              <span
                aria-hidden
                className="w-10 shrink-0 select-none pr-3 text-right text-[var(--code-comment)]"
              >
                {lineNumber}
              </span>
              <span className="whitespace-pre">{line || " "}</span>
            </div>
          );
        })}
      </pre>
      {consoleOutput ? (
        <div
          role="log"
          aria-label="Console"
          className="border-t border-border bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive"
        >
          {consoleOutput}
        </div>
      ) : null}
      <ul
        aria-label="Runner limits"
        className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-xs text-muted-foreground"
      >
        {RUNNER_LIMITS.map((limit) => (
          <li key={limit}>{limit}</li>
        ))}
      </ul>
    </div>
  );
}
