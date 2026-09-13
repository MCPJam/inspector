/**
 * "Suggested from this run" — what the evidence would let you require next.
 *
 * Each row leads with what the assertion PROTECTS, because a row that opens with
 * "Response contains ORD-48213" says what it does and nothing about whether
 * you want it. The mechanism is underneath, the evidence beside it, and a
 * requirement also states its consequence — accepting one changes whether
 * future runs fail, and that is not something to discover later.
 *
 * When the batch did not succeed the card leads with that instead and offers
 * no requirements at all.
 */

import { useState, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { measurementUnitLabel } from "@mcpjam/sdk/contract";
import { EVAL_WARN_BADGE_STRONG_CLASS } from "@/components/evals/constants";
import { RoleChip } from "@/components/evals/scorer-role-control";
import type { SuggestDiagnosis, Suggestion } from "./suggest-from-run";

const VISIBLE = 6;

export function SuggestedFromRunCard({
  suggestions,
  diagnosis,
  of,
  read,
  accepted,
  onAccept,
  onAcceptAll,
  onDismiss,
  onSeeFailure,
}: {
  suggestions: Suggestion[];
  diagnosis: SuggestDiagnosis | null;
  of: number;
  read: { pending: number; failed: number; capped: number; total: number };
  accepted: ReadonlySet<string>;
  onAccept: (suggestion: Suggestion) => void;
  onAcceptAll: (all: Suggestion[]) => void;
  onDismiss: (suggestion: Suggestion) => void;
  onSeeFailure?: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const visible = showAll ? suggestions : suggestions.slice(0, VISIBLE);
  const hidden = suggestions.length - visible.length;
  const pending = suggestions.filter((s) => !accepted.has(s.key));
  const requirements = pending.filter((s) => s.role === "gate").length;

  const groups = new Map<string, Suggestion[]>();
  for (const suggestion of visible) {
    const key =
      suggestion.placement.kind === "afterStep"
        ? `After step ${suggestion.placement.actionOrdinal}`
        : "After the run";
    groups.set(key, [...(groups.get(key) ?? []), suggestion]);
  }

  return (
    <section
      data-testid="suggested-from-run-card"
      className="space-y-2 rounded-md border border-border bg-muted/20 p-3 text-[11px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[11px] font-medium text-foreground">
            Suggested from this run
          </h3>
          <p className="text-[11px] text-muted-foreground">
            {diagnosis
              ? "Reports only — requirements need a run that worked."
              : `Held in every iteration of the newest batch${of > 0 ? `, and every iteration accomplished the goal` : ""}.`}
          </p>
        </div>
        {pending.length >= 2 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() =>
              requirements > 0 ? setConfirmAll(true) : onAcceptAll(pending)
            }
          >
            Add all {pending.length}
          </Button>
        ) : null}
      </div>

      <ReadState read={read} />

      {diagnosis ? (
        <div
          className="space-y-1 rounded border border-border/60 bg-background/40 px-2 py-1.5"
          data-testid="suggestion-diagnosis"
        >
          <p className="text-foreground">
            {diagnosis.noSignal
              ? "Nothing confirmed that this run accomplished the goal."
              : `${diagnosis.unsuccessful} of ${diagnosis.of} ${measurementUnitLabel(
                  "trial",
                  diagnosis.of,
                )} did not accomplish the goal.`}
            {onSeeFailure && !diagnosis.noSignal ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-1 h-5 px-1 text-[11px]"
                onClick={onSeeFailure}
              >
                See where it failed
              </Button>
            ) : null}
          </p>
          <p className="text-muted-foreground">
            {diagnosis.noSignal
              ? "Run test with a goal sentence so the judge can confirm the run succeeded, then its route and tools can be required."
              : "Requirements are suggested once every iteration accomplishes the goal."}
          </p>
        </div>
      ) : null}

      {confirmAll ? (
        <div
          className="space-y-1.5 rounded border border-border bg-background px-2 py-1.5"
          data-testid="suggestion-add-all-confirm"
        >
          <p className="text-foreground">
            Add {requirements}{" "}
            {requirements === 1 ? "requirement" : "requirements"} and{" "}
            {pending.length - requirements}{" "}
            {pending.length - requirements === 1 ? "report" : "reports"}?
            Requirements fail this case on future runs when they are not met.
          </p>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setConfirmAll(false);
                onAcceptAll(pending);
              }}
            >
              Add all
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setConfirmAll(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {[...groups.entries()].map(([heading, rows]) => (
        <div key={heading} className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {heading}
          </div>
          <ul className="space-y-1">
            {rows.map((suggestion) => (
              <SuggestionRow
                key={suggestion.key}
                suggestion={suggestion}
                of={of}
                accepted={accepted.has(suggestion.key)}
                onAccept={() => onAccept(suggestion)}
                onDismiss={() => onDismiss(suggestion)}
              />
            ))}
          </ul>
        </div>
      ))}

      {hidden > 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px] text-muted-foreground"
          onClick={() => setShowAll(true)}
        >
          Show {hidden} more
        </Button>
      ) : null}

      {suggestions.length === 0 && read.pending === 0 && !diagnosis ? (
        <p className="text-muted-foreground">
          Nothing else was stable across every iteration.
        </p>
      ) : null}

      <p className="text-muted-foreground">
        No assertion covers Response yet — tool results and latency are not
        gradable in this release.
      </p>
    </section>
  );
}

function ReadState({
  read,
}: {
  read: { pending: number; failed: number; capped: number; total: number };
}) {
  if (read.pending > 0) {
    return (
      <p className="text-muted-foreground" data-testid="suggestion-read-state">
        Reading {read.pending} iteration{" "}
        {read.pending === 1 ? "trace" : "traces"}…
      </p>
    );
  }
  const lines: string[] = [];
  if (read.failed > 0) {
    lines.push(
      `${read.failed} ${read.failed === 1 ? "trace" : "traces"} could not be read, so wording and error assertions are not offered.`,
    );
  }
  if (read.capped > 0) {
    lines.push(
      `This batch has ${read.total} ${measurementUnitLabel("trial", read.total)}; traces are read for ${read.total - read.capped}, so only assertions that need no trace are offered.`,
    );
  }
  if (lines.length === 0) return null;
  return (
    <p className="text-muted-foreground" data-testid="suggestion-read-state">
      {lines.join(" ")}
    </p>
  );
}

/** One suggestion. Exported so the chain's detail card can render the same row. */
export function SuggestionRow({
  suggestion,
  of,
  accepted,
  onAccept,
  onDismiss,
}: {
  suggestion: Suggestion;
  of: number;
  accepted: boolean;
  onAccept: () => void;
  onDismiss?: () => void;
}): ReactNode {
  if (accepted) {
    return (
      <li
        className="px-2 py-1 text-muted-foreground"
        data-testid="suggestion-row"
        data-key={suggestion.key}
        data-accepted="yes"
      >
        Added — run again to grade it; this run is not re-graded.
      </li>
    );
  }
  const lonely = of === 1;
  return (
    <li
      data-testid="suggestion-row"
      data-key={suggestion.key}
      data-role={suggestion.role}
      className="rounded border border-border/60 bg-background/40 px-2 py-1.5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">
          {suggestion.purpose}
        </span>
        <RoleChip role={suggestion.role} />
        <span className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={onAccept}
          >
            Add
          </Button>
          {onDismiss ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground"
              aria-label="Dismiss suggestion"
              onClick={onDismiss}
            >
              <X className="h-3 w-3" />
            </Button>
          ) : null}
        </span>
      </div>
      <p className="text-muted-foreground">{suggestion.label}</p>
      <p className="text-muted-foreground">{suggestion.evidence}</p>
      {suggestion.consequence ? (
        <p className="text-muted-foreground">{suggestion.consequence}</p>
      ) : null}
      <p
        className={cn(
          "text-muted-foreground",
          lonely && EVAL_WARN_BADGE_STRONG_CLASS,
        )}
      >
        {lonely
          ? "1 of 1 — run more to be sure"
          : `held in ${suggestion.stability.held} of ${suggestion.stability.of} ${measurementUnitLabel(
              "trial",
              suggestion.stability.of,
            )}`}
      </p>
    </li>
  );
}
