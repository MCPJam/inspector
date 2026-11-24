import type { ReactNode } from "react";
import { ResultBadge } from "./result-badge";
import { UnitProgress } from "./unit-progress";

/** The baseline or a round while it runs: what is running and how far each run has got. */
export function RunningView({
  eyebrow,
  title,
  climbId,
  unitKey,
  labels,
  note,
}: {
  eyebrow?: string;
  title: string;
  climbId: string;
  unitKey: string | undefined;
  labels: Record<string, string>;
  note?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          {eyebrow ? <div className="text-xs text-muted-foreground">{eyebrow}</div> : null}
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        </div>
        <ResultBadge result="running" />
      </div>
      <UnitProgress climbId={climbId} unitKey={unitKey} labels={labels} />
      {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}
