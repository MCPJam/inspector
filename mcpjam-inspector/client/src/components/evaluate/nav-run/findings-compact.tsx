/**
 * Findings on the Suite run page, one line per finding with how to fix it
 * and a prompt to copy always shown under it.
 */
import { ArrowUpRight, Wrench } from "lucide-react";
import type { ActionableFinding } from "@/lib/insights-envelope-api";
import { CopyFindingPrompt } from "@/components/shared/actionable-insights/finding-summary";
import { InfoHint } from "../../evals/global-gates-info";

export const FINDINGS_HINT =
  "What broke, grouped by the stage it broke at and why, each with how to fix it and a prompt to copy. Open iteration shows one that failed.";

/** The first iteration a finding cites that `held` contains, if any. */
export function openableIteration(
  finding: ActionableFinding,
  held: ReadonlySet<string>,
): string | null {
  for (const item of finding.evidence) {
    if (item.iterationId && held.has(item.iterationId)) return item.iterationId;
  }
  return null;
}

export function FindingsCompactList({
  findings,
  scope,
  heldIterationIds,
  onOpenIteration,
}: {
  /** In display order. */
  findings: readonly ActionableFinding[];
  /** What the count covers, e.g. "across 2 models"; "" for a one-model run. */
  scope: string;
  /** Iterations this page holds; a finding citing none offers no Open iteration. */
  heldIterationIds: ReadonlySet<string>;
  onOpenIteration?: (iterationId: string) => void;
}) {
  const note = findings.length
    ? `${findings.length}${scope ? ` ${scope}` : ""}`
    : scope;
  return (
    <section aria-label="Findings" data-testid="nav-findings">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          Findings
          <InfoHint
            label="About Findings"
            className="border border-border bg-muted/50"
          >
            {FINDINGS_HINT}
          </InfoHint>
        </h3>
        {note ? (
          <span className="text-xs text-muted-foreground">{note}</span>
        ) : null}
      </div>
      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No issue found in the recorded assertions.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border">
          {findings.map((finding) => {
            const iterationId = onOpenIteration
              ? openableIteration(finding, heldIterationIds)
              : null;
            return (
              <li
                key={finding.id}
                className="px-3 py-2.5"
                data-testid="nav-finding"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <span
                    aria-hidden
                    className="mt-2 size-1.5 shrink-0 rounded-full bg-warning"
                  />
                  <span className="min-w-0 flex-1 text-sm text-foreground">
                    {finding.observed}
                  </span>
                  {iterationId && onOpenIteration ? (
                    <button
                      type="button"
                      onClick={() => onOpenIteration(iterationId)}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Open iteration
                      <ArrowUpRight className="size-3.5" aria-hidden />
                    </button>
                  ) : null}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 pl-3.5">
                  <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                    <span className="mr-1 inline-flex items-center gap-1 font-medium text-foreground">
                      <Wrench className="size-3" aria-hidden />
                      How to fix:
                    </span>
                    {finding.recommendation}
                  </p>
                  <CopyFindingPrompt
                    finding={finding}
                    context={{ rerunLabel: "this eval suite" }}
                    className="h-7 px-2 text-xs shadow-none"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
