/** The Test run page's Findings and Scorecards sections. Presentational. */
import { useState, type ReactNode } from "react";
import { ArrowUpRight, Copy, Info, Wrench } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { UserValueStage } from "@mcpjam/sdk/contract";
import { BUILT_IN_BADGE } from "../../evals/runner-checks";
import type { TestRunFinding } from "./test-run-findings-model";
import type {
  TestRunScorecard,
  TestRunScorecardRow,
} from "./test-run-scorecard-model";

const FINDINGS_HINT =
  "What broke, grouped by the stage it broke at and why, each with how to fix it and a prompt to copy. Open iteration shows one that failed.";
const SCORECARDS_HINT =
  "Every assertion this test run carries, totalled across its iterations and grouped by stage. ↗ opens an iteration where that assertion failed.";

function SectionInfo({ hint, label }: { hint: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          className="inline-flex cursor-help items-center rounded-full border border-border bg-muted/50 p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-3" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

function SectionHead({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {title}
        <SectionInfo hint={hint} label={title} />
      </h3>
      {children}
    </div>
  );
}

/** Severity of a break by where it happened: the mock's map. */
const STAGE_DOT: Record<UserValueStage, string> = {
  connection: "bg-destructive",
  discovery: "bg-destructive",
  selection: "bg-warning",
  call: "bg-destructive",
  response: "bg-destructive",
  userValue: "bg-warning",
};

const OPEN_BUTTON =
  "inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-background text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const capitalized = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

export function TestRunFindings({
  findings,
  onOpenIteration,
  onCopyFixPrompt,
}: {
  findings: readonly TestRunFinding[];
  onOpenIteration: (iterationId: string) => void;
  onCopyFixPrompt: (finding: TestRunFinding) => void;
}) {
  return (
    <section aria-label="Findings" data-testid="nav-findings">
      <SectionHead title="Findings" hint={FINDINGS_HINT}>
        {findings.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {findings.length}
          </span>
        )}
      </SectionHead>
      {findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No issue found in the recorded assertions.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border">
          {findings.map((finding) => (
            <li key={finding.key} className="px-3 py-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-2 size-1.5 shrink-0 rounded-full",
                    finding.stage
                      ? STAGE_DOT[finding.stage]
                      : "bg-muted-foreground",
                  )}
                />
                <span className="min-w-0 flex-1 text-sm text-foreground">
                  {finding.observed}
                </span>
                {finding.iterationIds[0] && (
                  <button
                    type="button"
                    className={cn(OPEN_BUTTON, "gap-1 px-2")}
                    onClick={() => onOpenIteration(finding.iterationIds[0])}
                  >
                    Open iteration
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
              {finding.remedy && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 pl-3.5">
                  <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                    <span className="mr-1 inline-flex items-center gap-1 font-medium text-foreground">
                      <Wrench className="size-3" aria-hidden="true" />
                      {finding.remedy.voice === "checkWhether"
                        ? "Worth checking:"
                        : "How to fix:"}
                    </span>
                    {capitalized(finding.remedy.text)}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs shadow-none"
                    onClick={() => onCopyFixPrompt(finding)}
                  >
                    <Copy className="size-3.5" aria-hidden="true" />
                    Copy fix prompt
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** An icon button whose label slides open to its left, so the icon stays under the cursor. */
function SlideButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      className={cn(OPEN_BUTTON, "px-1.5")}
    >
      <span
        aria-hidden="true"
        className={cn(
          "overflow-hidden whitespace-nowrap motion-safe:transition-[max-width,margin-right] motion-safe:duration-200 motion-safe:ease-in-out",
          open ? "mr-1 max-w-40" : "mr-0 max-w-0",
        )}
      >
        {label}
      </span>
      <ArrowUpRight className="size-3.5" aria-hidden="true" />
    </button>
  );
}

function rowTone(row: TestRunScorecardRow): string {
  if (row.failed > 0) {
    return row.role === "required" && !row.builtin
      ? "text-destructive"
      : "text-warning";
  }
  return row.passed > 0 ? "text-success" : "text-muted-foreground";
}

export function TestRunScorecards({
  scorecard,
  onOpenIteration,
}: {
  scorecard: TestRunScorecard;
  onOpenIteration: (iterationId: string) => void;
}) {
  const { total, timedOut } = scorecard;
  return (
    <section aria-label="Scorecards" data-testid="nav-scorecard-summary">
      <SectionHead title="Scorecards" hint={SCORECARDS_HINT}>
        <span className="text-xs text-muted-foreground">
          every assertion, across {total}{" "}
          {total === 1 ? "iteration" : "iterations"}
        </span>
        {timedOut > 0 && (
          <span className="text-xs text-warning">
            · {timedOut} timed out, so {timedOut === 1 ? "its" : "their"}{" "}
            assertions weren't measured
          </span>
        )}
      </SectionHead>
      <div className="divide-y divide-border/60 rounded-lg border border-border">
        {scorecard.stages.map((stage) => (
          <div
            key={stage.stage}
            className="grid gap-x-4 gap-y-1 px-3 py-2 sm:grid-cols-[8rem_minmax(0,1fr)]"
          >
            <span className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {stage.label}
            </span>
            <ul className="min-w-0 space-y-1">
              {stage.rows.map((row) => {
                const tone = rowTone(row);
                const measured = row.passed + row.failed > 0;
                const failingId = row.firstFailedIterationId;
                return (
                  <li
                    key={row.key}
                    className="flex min-w-0 items-center gap-2 text-sm"
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 shrink-0 rounded-full bg-current",
                        tone,
                      )}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-foreground"
                      title={row.label}
                    >
                      {row.label}
                    </span>
                    {row.builtin ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {BUILT_IN_BADGE}
                      </span>
                    ) : row.role === "advisory" ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        Advisory
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        "w-24 shrink-0 text-right text-xs tabular-nums",
                        tone,
                      )}
                    >
                      {measured
                        ? `${row.passed}/${total} passed`
                        : "not measured"}
                    </span>
                    <span className="flex w-7 shrink-0 justify-end">
                      {failingId && (
                        <SlideButton
                          label="Open failing iteration"
                          onClick={() => onOpenIteration(failingId)}
                        />
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
