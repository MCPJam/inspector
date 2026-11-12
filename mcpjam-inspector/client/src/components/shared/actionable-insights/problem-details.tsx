/**
 * A recorded problem's details: up to three options to choose among, with
 * scope, steps, verification and the copied prompt following the selection.
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { copyToClipboard } from "@/lib/clipboard";
import type {
  FindingOption,
  FindingProblem,
} from "@/lib/insights-envelope-api";
import type { FindingPromptContext } from "./finding-prompts";
import type { FindingEvidenceLocator } from "./finding-evidence";
import {
  AffectedIterationsList,
  type AffectedIterationRow,
} from "./affected-iterations-list";
import { FindingText } from "./finding-text";
import {
  buildOptionPrompt,
  OPTION_KIND_LABEL,
  optionPromptLabel,
  optionTargetLabel,
  plural,
} from "./problem-prompts";

const KIND_BADGE: Record<FindingOption["kind"], string> = {
  fix: "Fix · not yet verified",
  experiment: "Experiment · untested",
  investigation: "Investigation",
};

/** Why an analysis that ran left this problem without a checked cause. */
const OUTCOME_LINE: Record<
  Exclude<
    NonNullable<FindingProblem["outcome"]>["state"],
    "explained" | "addressed"
  >,
  string
> = {
  no_proposal: "Analysis ran and proposed nothing for this problem.",
  rejected: "Analysis ran; its proposals did not hold up against the evidence.",
  withheld: "Analysis ran but could not confirm a cause from the evidence.",
  not_reached: "Analysis ran but did not reach this problem.",
};

/** What the analysis established about this problem's iterations. */
export function coverageLine(problem: FindingProblem): string {
  const { observed, explained, unresolved } = problem.coverage;
  const state = problem.outcome?.state;
  const parts = [
    explained > 0
      ? `Evidence reviewed for ${explained} of ${plural(observed, "iteration")}.`
      : ((state && state !== "explained" && state !== "addressed"
          ? OUTCOME_LINE[state]
          : undefined) ?? "Cause not established."),
  ];
  if (unresolved > 0 && unresolved < observed)
    parts.push(
      `${plural(unresolved, "iteration")} ${unresolved === 1 ? "has" : "have"} no checked cause or analysis option.`,
    );
  return parts.join(" ");
}

export function CopyOptionPrompt({
  problem,
  option,
  context,
}: {
  problem: FindingProblem;
  option: FindingOption;
  context?: FindingPromptContext;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "unavailable">("idle");
  const prompt = buildOptionPrompt(problem, option, context);
  return (
    <div className="min-w-0 space-y-3">
      <Button
        variant="outline"
        size="sm"
        className="h-9 shadow-none"
        data-testid="problem-copy-prompt"
        onClick={() => {
          void copyToClipboard(prompt).then((ok) => {
            setStatus(ok ? "copied" : "unavailable");
            if (ok) setTimeout(() => setStatus("idle"), 2000);
          });
        }}
      >
        {status === "copied" ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
        {status === "copied" ? "Copied" : optionPromptLabel(option)}
      </Button>
      {status === "unavailable" ? (
        <>
          <p role="status" className="text-xs text-muted-foreground">
            The clipboard is unavailable. Select the prompt below to copy it.
          </p>
          <pre
            tabIndex={0}
            className="max-h-80 max-w-[calc(100vw-3rem)] overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--code-bg)] p-3 font-code text-xs text-[var(--code-text)]"
            data-testid="problem-prompt-text"
          >
            {prompt}
          </pre>
        </>
      ) : null}
    </div>
  );
}

function rowsFor(
  problem: FindingProblem,
  iterationRows: Record<string, AffectedIterationRow>,
): AffectedIterationRow[] {
  return problem.iterationIds.map(
    (id) =>
      iterationRows[id] ?? {
        iterationId: id,
        caseTitle: "Iteration not loaded on this page",
        iterationNumber: null,
        client: null,
        model: null,
        result: "unknown",
        canOpen: false,
      },
  );
}

export function ProblemDetailsContent({
  problem,
  context,
  iterationRows = {},
  onOpenEvidence,
}: {
  problem: FindingProblem;
  context?: FindingPromptContext;
  iterationRows?: Record<string, AffectedIterationRow>;
  onOpenEvidence?: (locator: FindingEvidenceLocator) => void;
}) {
  const [chosen, setChosen] = useState(problem.recommendedOptionId);
  const option =
    problem.options.find((row) => row.id === chosen) ?? problem.options[0];
  const recommended = option?.id === problem.recommendedOptionId;
  const scope = new Set(option?.iterationIds ?? []);
  const explained = new Set(
    problem.explanations.flatMap((e) => e.iterationIds),
  );
  const unresolved = new Set(problem.coverage.unresolvedIterationIds);
  const target = option ? optionTargetLabel(option) : null;
  return (
    <div className="space-y-6 px-6 pb-8 text-sm leading-relaxed">
      <section>
        <h5 className="mb-3 font-semibold">What happened</h5>
        <p className="break-words text-[15px] leading-7">
          <FindingText text={problem.observed} />
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {coverageLine(problem)}
        </p>
      </section>
      {option ? (
        <section className="space-y-4 border-t border-border/60 pt-5">
          {problem.options.length > 1 ? (
            <div>
              <label
                className="mb-2 block text-xs font-semibold"
                htmlFor={`problem-option-${problem.id}`}
              >
                Options ({problem.options.length})
              </label>
              <Select
                value={option.id}
                onValueChange={setChosen}
              >
                <SelectTrigger
                  className="w-full min-w-0 [&>span]:block [&>span]:truncate"
                  id={`problem-option-${problem.id}`}
                  aria-label="Choose an option"
                  data-testid="problem-option-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-w-[var(--radix-select-trigger-width)]">
                  {problem.options.map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {row.id === problem.recommendedOptionId
                        ? "Recommended"
                        : "Alternative"}
                      : {OPTION_KIND_LABEL[row.kind].toLowerCase()} ·{" "}
                      {row.change.length > 70
                        ? `${row.change.slice(0, 69)}…`
                        : row.change}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <h5 className="font-semibold">{OPTION_KIND_LABEL[option.kind]}</h5>
            <Badge variant="outline">{KIND_BADGE[option.kind]}</Badge>
          </div>
          <p className="break-words text-[15px] leading-7">
            <FindingText text={option.change} />
          </p>
          <p className="text-xs text-muted-foreground">
            Applies to {option.iterationIds.length} of{" "}
            {plural(problem.coverage.observed, "affected iteration")}
            {target ? ` · ${target}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            Effort: {option.effort} · Compatibility risk:{" "}
            {option.compatibilityRisk}
          </p>
          <div>
            <h6 className="mb-1 font-semibold">
              {recommended ? "Why this option" : "Why consider this option"}
            </h6>
            {recommended && problem.recommendationReason ? (
              <p className="mb-2">{problem.recommendationReason}</p>
            ) : null}
            <p>
              <FindingText text={option.rationale} />
            </p>
          </div>
          {option.hypothesis ? (
            <dl className="space-y-2">
              {[
                ["Hypothesis", option.hypothesis],
                ["Supports it if", option.supportsIf],
                ["Weakens it if", option.weakensIf],
              ]
                .filter((row): row is [string, string] => Boolean(row[1]))
                .map(([term, text]) => (
                  <div key={term}>
                    <dt className="font-semibold">{term}</dt>
                    <dd>
                      <FindingText text={text} />
                    </dd>
                  </div>
                ))}
            </dl>
          ) : null}
          <div>
            <h6 className="mb-1 font-semibold">How to verify</h6>
            <p>
              <FindingText text={option.verification} />
            </p>
          </div>
          <CopyOptionPrompt
            key={option.id}
            problem={problem}
            option={option}
            context={context}
          />
        </section>
      ) : null}
      {problem.explanations.length > 0 ? (
        <section className="border-t border-border/60 pt-5">
          <h5 className="mb-2 font-semibold">Reviewed explanation</h5>
          <ul className="list-disc space-y-1 pl-5">
            {problem.explanations.map((row) => (
              <li key={row.id}>
                <FindingText text={row.rootCause ?? row.title} />{" "}
                <span className="text-muted-foreground">
                  ({plural(row.iterationIds.length, "iteration")})
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="border-t border-border/60 pt-5">
        <h5 className="mb-3 font-semibold">
          Affected iterations · {problem.affected.count} of{" "}
          {problem.affected.total}
        </h5>
        <AffectedIterationsList
          rows={rowsFor(problem, iterationRows)}
          total={problem.affected.count}
          ariaLabel="Affected iterations"
          detail={(row) =>
            explained.has(row.iterationId)
              ? "Evidence reviewed"
              : unresolved.has(row.iterationId)
                ? "Unresolved"
                : scope.has(row.iterationId)
                  ? "Addressed by this option"
                  : "Covered by another option"
          }
          {...(onOpenEvidence
            ? {
                onOpen: (id: string) =>
                  onOpenEvidence({ kind: "iteration", id }),
              }
            : {})}
        />
      </section>
      {option ? (
        <p className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
          {option.source === "analysis"
            ? "Proposed by the trace analysis from cited evidence. Nothing has been changed or rerun."
            : "Guidance from the recorded facts alone; no model was asked."}{" "}
          You decide the next action and start any rerun.
        </p>
      ) : null}
    </div>
  );
}
