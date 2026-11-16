import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { CheckRow, type CheckRowResultProps } from "./check-row";
import { EvaluatorKindBadge, OwaspTag } from "./evaluator-kind-badge";
import type { EvaluatorOrigin, OwaspId } from "./evaluator-library-types";
import { VerdictPill, type VerdictStatus } from "./verdict-pill";

type ResultCheck = Omit<CheckRowResultProps, "mode"> & { id: string };

export type ScorecardEvaluatorCardProps = {
  name: string;
  icon: LucideIcon;
  origin?: EvaluatorOrigin;
  owasp?: readonly OwaspId[];
  status: VerdictStatus;
  checks: readonly ResultCheck[];
  /** The attack text planted in a tool result, for security evaluators. */
  fixture?: { label: string; content: string };
  /** A model question's answer. Always rendered after the checks. */
  modelAnswer?: ResultCheck;
};

/**
 * One evaluator's result on an iteration. Failed evaluators start open with
 * failing checks first; passed ones start collapsed. The planted fixture
 * comes before the checks and the model's answer comes last.
 */
export function ScorecardEvaluatorCard({
  name,
  icon: Icon,
  origin,
  owasp,
  status,
  checks,
  fixture,
  modelAnswer,
}: ScorecardEvaluatorCardProps) {
  const [open, setOpen] = useState(status === "failed" || status === "error");
  const bodyId = useId();
  const ordered = [...checks].sort(
    (a, b) => Number(b.status === "failed") - Number(a.status === "failed"),
  );
  return (
    <section
      aria-label={name}
      className="overflow-hidden rounded-lg border border-border bg-popover"
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-2 text-sm font-semibold text-card-foreground"
        >
          {open ? (
            <ChevronDown aria-hidden className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight
              aria-hidden
              className="size-4 text-muted-foreground"
            />
          )}
          <Icon aria-hidden className="size-4 text-muted-foreground" />
          <span className="truncate">{name}</span>
        </button>
        {origin ? <EvaluatorKindBadge origin={origin} /> : null}
        {owasp ? <OwaspTag ids={owasp} /> : null}
        <span className="ml-auto">
          <VerdictPill status={status} />
        </span>
      </div>
      {open ? (
        <div id={bodyId} className="border-t border-border">
          {fixture ? (
            <div className="border-b border-border px-3 py-2.5">
              <div className="text-xs font-medium text-muted-foreground">
                {fixture.label}
              </div>
              <pre className="mt-1 whitespace-pre-wrap rounded-md bg-muted px-2.5 py-2 font-mono text-xs text-card-foreground">
                {fixture.content}
              </pre>
            </div>
          ) : null}
          <ul className="divide-y divide-border">
            {ordered.map(({ id, ...check }) => (
              <CheckRow key={id} mode="result" {...check} />
            ))}
            {modelAnswer ? (
              <CheckRow
                key={modelAnswer.id}
                mode="result"
                variant="model"
                label={modelAnswer.label}
                role={modelAnswer.role}
                status={modelAnswer.status}
                scoreLabel={modelAnswer.scoreLabel}
                evidence={modelAnswer.evidence}
              />
            ) : null}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
