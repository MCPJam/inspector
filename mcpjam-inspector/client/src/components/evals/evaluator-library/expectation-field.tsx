import type { ReactNode } from "react";
import { CASE_FIELD_LABEL } from "./case-field-dependency";
import type { CaseField } from "./evaluator-library-types";

function heading(field: CaseField): string {
  const label = CASE_FIELD_LABEL[field].replace(/[“”]/g, "");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * One thing the case says the run should do, with the evaluators on this
 * suite that read it. When no evaluator reads it, the field collapses to a
 * line saying so instead of asking for data nothing uses.
 */
export function ExpectationField({
  field,
  readBy,
  isNew = false,
  children,
}: {
  field: CaseField;
  readBy: readonly { evaluatorId: string; name: string }[];
  isNew?: boolean;
  /** The field's own editor. */
  children: ReactNode;
}) {
  const title = heading(field);
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-2 rounded-lg border border-border bg-popover p-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-sm font-semibold text-card-foreground">{title}</h4>
        {isNew ? (
          <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
            New
          </span>
        ) : null}
        {readBy.length ? null : (
          // An unused field is one compact line: no editor, just the reason.
          <p className="text-xs text-muted-foreground">
            No evaluator on this suite reads this field.
          </p>
        )}
      </div>
      {readBy.length ? (
        <>
          {children}
          <p className="text-xs text-muted-foreground">
            Read by {readBy.map((e) => e.name).join(", ")}
          </p>
        </>
      ) : null}
    </section>
  );
}
