/**
 * ReplayedScenarioPane — the editor's left "Test scenario" column while a past
 * run is being replayed. The live editor on the left always shows today's case,
 * but a case can change over the life of a suite, so when the user opens a
 * historical run we swap the editor for a read-only render of that run's
 * `testCaseSnapshot` — the prompt, expected tool calls and checks exactly as
 * they were when the iteration executed. A single-row header marks replay mode;
 * when the live case differs, a popover explains why.
 */
import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Copy,
  History,
  ListChecks,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { resolvePromptTurns } from "@/shared/steps";
import { promptTurnsToSteps, type TestStep } from "@/shared/steps";
import { describeCheck } from "../preview/expected-conversation";
import { StepListEditor } from "../step-list-editor";
import type { EvalIteration } from "../types";

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Copyable iteration id — the short tail is the scannable handle; clicking
 *  copies the full Convex id for pasting into a query/log search. */
function IterationIdChip({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm font-mono text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
      title={`Iteration ${id} — click to copy`}
      aria-label={`Copy iteration id ${id}`}
    >
      {copied ? (
        <Check className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
      ) : (
        <Copy className="h-2.5 w-2.5" aria-hidden />
      )}
      {id.slice(-6)}
    </button>
  );
}

export function ReplayedScenarioPane({
  iteration,
  edited,
  onBackToEditing,
}: {
  iteration: EvalIteration;
  /** True when today's case differs from this run's snapshot scenario. */
  edited: boolean;
  onBackToEditing: () => void;
}) {
  const snapshot = iteration.testCaseSnapshot;
  // The snapshot now carries `steps`; render them with the same step-card editor
  // as live edit mode (read-only) so the replayed scenario matches the editor's
  // look. Pre-migration iterations resolve legacy turns and convert to steps.
  const steps: TestStep[] = Array.isArray(snapshot?.steps)
    ? (snapshot.steps as TestStep[])
    : promptTurnsToSteps(
        resolvePromptTurns({
          promptTurns: snapshot?.promptTurns,
          query: snapshot?.query,
          expectedToolCalls: snapshot?.expectedToolCalls,
          expectedOutput: snapshot?.expectedOutput,
        }),
      );
  // Case-level gate frozen at run time (suite defaults + case override merged).
  // Per-turn checks already render inside ExpectedConversation, so this only
  // covers the case-wide gate.
  const caseChecks = snapshot?.predicates ?? [];
  const ranAt = iteration.startedAt ?? iteration.createdAt;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
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
                    <AlertTriangle
                      className="h-3 w-3 text-amber-600/80 dark:text-amber-500/80"
                      aria-hidden
                    />
                    Changed
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  side="bottom"
                  className="w-64 p-2.5 text-[11px] leading-snug text-muted-foreground"
                >
                  This view shows the scenario frozen at run time. Back to
                  editing restores the current version.
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
          onClick={onBackToEditing}
        >
          <ChevronLeft className="h-3 w-3" aria-hidden />
          Back to editing
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-muted/10">
        <div className="px-5 py-6">
          <StepListEditor
            steps={steps}
            onStepsChange={() => {}}
            availableTools={[]}
            suiteServers={[]}
            evalValidationBorderClass=""
            readOnly
          />
        </div>
        {caseChecks.length ? (
          <div className="border-t border-border px-5 py-4">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <ListChecks className="h-3.5 w-3.5 shrink-0" />
              Checks
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {caseChecks.map((check, index) => (
                <span
                  key={`case-check-${index}`}
                  className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {describeCheck(check)}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
