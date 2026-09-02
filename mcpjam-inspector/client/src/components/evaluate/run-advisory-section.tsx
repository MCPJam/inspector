/**
 * Judge findings, folded away.
 *
 * This is the section that used to dominate the run page. Its header read
 * "1 suggested fix · 67% accuracy" and its rows were three low-confidence
 * "workflow inefficiency" flags — two of them on cases that PASSED — while the
 * one case that measurably failed had no action anywhere. The findings were not
 * wrong; their placement was. A judge's opinion of a passing case was the most
 * prominent thing on a page about a failing one.
 *
 * So it keeps every row and moves them below the failures, closed by default,
 * under a heading that says what they are worth. That is the same separation
 * the eval contract already draws: predicates gate, judges inform. Mixing the
 * two in one list is what made the page unreadable.
 */
import { useState } from "react";
import { ChevronRight, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";

import { copyToClipboard } from "@/lib/clipboard";
import { ActionableFindings } from "../shared/actionable-insights/actionable-findings";
import { buildFixPrompt, type TriageRow } from "../evals/ai-triage-helpers";

async function copyPrompt(row: TriageRow) {
  const ok = await copyToClipboard(buildFixPrompt(row));
  if (ok) {
    toast.success("Fix prompt copied — paste it into your coding agent");
  } else {
    toast.error("Copy failed");
  }
}

export function RunAdvisorySection({
  suiteRunId,
  triageRows,
  showActionableFindings,
}: {
  suiteRunId: string;
  triageRows: readonly TriageRow[];
  /** False until the run's server-quality analysis exists. */
  showActionableFindings: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Nothing to fold. An empty disclosure is a promise of content that is not
  // there, which is worse than no section at all.
  if (triageRows.length === 0 && !showActionableFindings) return null;

  const count = triageRows.length;

  return (
    <section
      className="border-t border-border/40"
      data-testid="run-advisory-section"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-muted/40"
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-[13px] font-semibold text-foreground">
          Worth a look, never required
        </span>
        <span className="hidden text-[12.5px] text-muted-foreground sm:inline">
          Model-generated observations. They do not change the verdict.
        </span>
        {count > 0 ? (
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11.5px] tabular-nums text-muted-foreground">
            {count} {count === 1 ? "finding" : "findings"}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="px-5 pb-4">
          {showActionableFindings ? (
            <div className="mb-3 rounded-lg border border-border/50 bg-card/40 empty:hidden">
              <ActionableFindings
                boundaryName="evaluate-run-actionable-findings"
                surface={{ kind: "eval_run", suiteRunId }}
                context={{ rerunLabel: "this eval suite" }}
              />
            </div>
          ) : null}

          {triageRows.length > 0 ? (
            <ul className="divide-y divide-border/40 rounded-lg border border-border/50">
              {triageRows.map((row) => (
                <li
                  key={row.id}
                  className="flex items-start justify-between gap-3 px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] text-foreground">{row.title}</p>
                    {row.rawIssues.length > 0 ? (
                      <p className="mt-0.5 text-[12px] text-muted-foreground">
                        {row.rawIssues[0]}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-[12.5px]"
                    onClick={() => copyPrompt(row)}
                    aria-label={`Copy fix prompt: ${row.title}`}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
