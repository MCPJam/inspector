import { Button } from "@mcpjam/design-system/button";
import { Play } from "lucide-react";
import { VerdictPill, type VerdictStatus } from "./verdict-pill";

export type PreviewResult = {
  id: string;
  iterationLabel: string;
  status: VerdictStatus;
  explanation?: string;
};

/**
 * Runs a draft evaluator against past iterations without saving anything.
 * One header for every evaluator method. It always says nothing is saved
 * and shows the model cost before running. Correct feeds a reviewer example.
 */
export function EvaluatorPreviewPanel({
  sourceLabel,
  iterationCount,
  costLabel,
  results,
  running = false,
  onRun,
  onCorrect,
}: {
  /** Where the iterations come from, e.g. "Run #4 · last 3 iterations". */
  sourceLabel: string;
  iterationCount: number;
  /** Model cost of one preview. Omit for evaluators that call no model. */
  costLabel?: string;
  results: readonly PreviewResult[];
  running?: boolean;
  onRun: () => void;
  onCorrect?: (id: string) => void;
}) {
  return (
    <section
      aria-label="Test on recent iterations"
      className="overflow-hidden rounded-lg border border-border bg-popover"
    >
      <div className="flex flex-col gap-1 border-b border-border px-3.5 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-card-foreground">
            Test on recent iterations
          </h3>
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            disabled={running}
            onClick={onRun}
          >
            <Play aria-hidden />
            Run {iterationCount}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {sourceLabel} · Nothing is saved
          {costLabel ? ` · ${costLabel}` : ""}
        </p>
      </div>
      {results.length ? (
        <ul aria-label="Preview results" className="divide-y divide-border">
          {results.map((result) => (
            <li
              key={result.id}
              className="flex items-start gap-3 px-3.5 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm text-card-foreground">
                  {result.iterationLabel}
                </div>
                {result.explanation ? (
                  <p className="text-xs text-muted-foreground">
                    {result.explanation}
                  </p>
                ) : null}
              </div>
              <VerdictPill size="sm" status={result.status} />
              {onCorrect ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Correct ${result.iterationLabel}`}
                  onClick={() => onCorrect(result.id)}
                >
                  Correct
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
