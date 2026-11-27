import { ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { CheckRow, type CheckRowProps } from "./check-row";
import { EvaluatorKindBadge } from "./evaluator-kind-badge";
import type { EvaluatorOrigin } from "./evaluator-library-types";
import { VerdictPill, type VerdictStatus } from "./verdict-pill";

type ResultCheck = CheckRowProps & { id: string };

export type ScorecardEvaluatorCardProps = {
  name: string;
  icon: LucideIcon;
  origin?: EvaluatorOrigin;
  status: VerdictStatus;
  checks: readonly ResultCheck[];
};

/**
 * One evaluator's result on an iteration. Failed evaluators start open with
 * failing checks first; passed ones start collapsed.
 */
export function ScorecardEvaluatorCard({
  name,
  icon: Icon,
  origin,
  status,
  checks,
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
        <span className="ml-auto">
          <VerdictPill status={status} />
        </span>
      </div>
      {open ? (
        <div id={bodyId} className="border-t border-border">
          <ul className="divide-y divide-border">
            {ordered.map(({ id, ...check }) => (
              <CheckRow key={id} {...check} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
