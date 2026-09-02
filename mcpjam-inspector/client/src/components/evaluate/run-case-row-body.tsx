/**
 * What broke inside one case, and what to do about it.
 *
 * Failures are grouped by reason rather than listed per iteration, because the
 * reason is what a fix keys on: ten iterations that missed the same call are
 * one piece of work, and listing them ten times makes that look like ten. Each
 * group shows expected against observed for one representative iteration, then
 * the contract's recommendation for that reason, then a prompt for it.
 *
 * The recommendation's wording travels with it: a judge-scored group asks the
 * reader to check, an unmeasured one says plainly that nothing about the server
 * was established. Neither renders as an instruction to change server code.
 */
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";

import { copyToClipboard } from "@/lib/clipboard";
import {
  USER_VALUE_STAGE_LABELS,
  type EvalRunDecisionDiagnostic,
} from "@mcpjam/sdk/contract";

import type { EvalIteration } from "../evals/types";
import type {
  CaseFailureGroup,
  EvaluateCaseRow,
} from "./evaluate-case-row-model";
import { buildStageFixPrompt } from "./stage-fix-prompt";
import { remedyForReason, type StageRemedy } from "./stage-remedy";

function ToolList({
  label,
  names,
  missing = [],
}: {
  label: string;
  names: string[];
  /** Expected calls with no observed counterpart. ALL of them, not the first. */
  missing?: readonly string[];
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {names.length === 0 ? (
          <li className="text-[12.5px] text-muted-foreground">none recorded</li>
        ) : (
          names.map((name, index) => (
            // Keyed by position, because a case may legitimately call the same
            // tool twice and two list items cannot share a key.
            <li
              key={`${name}-${index}`}
              className="font-mono text-[12.5px] text-foreground"
            >
              {name}
            </li>
          ))
        )}
        {missing.map((name, index) => (
          <li
            key={`missing-${name}-${index}`}
            className="font-mono text-[12.5px] text-destructive"
          >
            {name}{" "}
            {/* A real space, not just the margin: this text is read aloud and
                copied, and "export_to_excalidrawnever called" is neither. */}
            <span className="font-sans text-[11.5px]">never called</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function groupHeading(group: CaseFailureGroup, count: number): string {
  const iterations = count === 1 ? "1 iteration" : `${count} iterations`;
  if (group.stage) {
    return `${iterations} broke at ${USER_VALUE_STAGE_LABELS[group.stage]}`;
  }
  return `${iterations} did not complete, and no stage was established`;
}

async function copyPrompt(text: string) {
  const ok = await copyToClipboard(text);
  if (ok) {
    toast.success("Fix prompt copied — paste it into your coding agent");
  } else {
    toast.error("Copy failed");
  }
}

function FailureGroup({
  row,
  group,
  iterations,
}: {
  row: EvaluateCaseRow;
  group: CaseFailureGroup;
  iterations: readonly EvalIteration[];
}) {
  const diagnostic: EvalRunDecisionDiagnostic | null = group.representative;
  const iteration = iterations.find(
    (candidate) => candidate._id === group.iterationIds[0],
  );

  const expectedNames =
    diagnostic?.expected?.toolNames ??
    (iteration?.testCaseSnapshot?.expectedToolCalls ?? []).map(
      (call: { toolName: string }) => call.toolName,
    );
  const observedNames =
    diagnostic?.observed?.toolNames ??
    (iteration?.actualToolCalls ?? []).map(
      (call: { toolName: string }) => call.toolName,
    );
  // Every expected call with no observed counterpart, matched by occurrence so
  // a case expecting two writes and observing one reports the second missing.
  const remaining = [...observedNames];
  const missing: string[] = [];
  for (const name of expectedNames) {
    const at = remaining.indexOf(name);
    if (at === -1) missing.push(name);
    else remaining.splice(at, 1);
  }
  const missingSet = new Set(missing);

  // The contract's own sentence, or nothing. A reason it deliberately leaves
  // without a remedy gets no block here rather than a manufactured one.
  const remedy: StageRemedy | null = group.reason
    ? remedyForReason(group.reason)
    : null;

  return (
    <section className="rounded-lg border border-border/50">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/40 px-3.5 py-2.5">
        <span className="text-[13px] font-medium text-foreground">
          {groupHeading(group, group.iterationIds.length)}
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          {group.iterationIds.length > 1
            ? "evidence below is from the first of them"
            : null}
        </span>
      </header>

      <div className="grid gap-4 px-3.5 py-3 sm:grid-cols-2">
        <ToolList label="Expected" names={[...expectedNames]} />
        <ToolList
          label="Observed"
          names={observedNames.filter((name) => !missingSet.has(name))}
          missing={missing}
        />
      </div>

      {diagnostic?.observed?.failure ? (
        <p className="border-t border-border/40 px-3.5 py-2.5 font-mono text-[12px] text-destructive">
          {diagnostic.observed.failure}
        </p>
      ) : null}

      {remedy ? (
        <div className="flex flex-col gap-3 border-t border-border/40 bg-muted/25 px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-primary">
              {remedy.voice === "checkWhether"
                ? "Worth checking"
                : "What to change"}
            </div>
            <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-foreground">
              {remedy.text}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            onClick={() =>
              copyPrompt(
                buildStageFixPrompt({
                  caseTitle: row.title,
                  stage: group.stage,
                  reason: group.reason,
                  ...(diagnostic?.chain.status === "verified"
                    ? {
                        chain: diagnostic.chain.stages,
                        failureCategory: diagnostic.chain.failureCategory,
                      }
                    : {}),
                  ...(diagnostic?.nextAction
                    ? { nextAction: diagnostic.nextAction }
                    : {}),
                  expectedToolCalls: expectedNames.map((toolName) => ({
                    toolName,
                  })),
                  observedToolCalls: (iteration?.actualToolCalls ??
                    observedNames.map((toolName) => ({ toolName }))) as {
                    toolName: string;
                    arguments?: unknown;
                  }[],
                  observedFailure: diagnostic?.observed?.failure ?? null,
                  iterations: {
                    failed: group.iterationIds.length,
                    total: row.iterations.total,
                  },
                  remedy,
                }),
              )
            }
          >
            <Copy className="h-3.5 w-3.5" />
            Copy fix prompt
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function RunCaseRowBody({
  row,
  iterations,
  onOpenIteration,
  onEditCase,
}: {
  row: EvaluateCaseRow;
  iterations: readonly EvalIteration[];
  onOpenIteration?: (target: {
    testCaseId: string;
    iterationId: string;
  }) => void;
  onEditCase?: (testCaseId: string) => void;
}) {
  const nudges: string[] = [];
  if (row.iterations.total === 1) {
    // One observation says nothing about consistency, and the fix for a flaky
    // case differs from the fix for a consistent one.
    nudges.push(
      "This case ran once, so this run says nothing about whether the result is consistent.",
    );
  }
  if (row.verdict.kind === "matched") {
    const threshold = row.verdict.variants.find(
      (variant) =>
        variant.verdict === "passed" &&
        variant.failedTrials > 0 &&
        variant.effectivePassThreshold !== null,
    );
    if (threshold) {
      nudges.push(
        `This case passed on its threshold: ${threshold.passedTrials} of ${threshold.configuredTrials} iterations cleared ${threshold.effectivePassThreshold}.`,
      );
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {row.failureGroups.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          No failing iteration on this run.
        </p>
      ) : (
        row.failureGroups.map((group) => (
          <FailureGroup
            key={group.key}
            row={row}
            group={group}
            iterations={iterations}
          />
        ))
      )}

      {nudges.map((nudge) => (
        <p key={nudge} className="text-[12px] text-muted-foreground">
          {nudge}
        </p>
      ))}

      <div className="flex flex-wrap gap-2">
        {onOpenIteration && row.testCaseId && row.opensIterationId ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[12.5px]"
            onClick={() =>
              onOpenIteration({
                testCaseId: row.testCaseId as string,
                iterationId: row.opensIterationId as string,
              })
            }
          >
            Open iteration trace
          </Button>
        ) : null}
        {onEditCase && row.testCaseId ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[12.5px]"
            onClick={() => onEditCase(row.testCaseId as string)}
          >
            Edit case
          </Button>
        ) : null}
      </div>
    </div>
  );
}
