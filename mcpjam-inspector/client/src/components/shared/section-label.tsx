/**
 * Field-group label for persona surfaces: the small uppercase band above
 * "Persona", "Use cases & context" and "Goals".
 *
 * Lives in `shared/` rather than in the Confirm step it was born in (BB-123):
 * the Personas library consumes it too, and importing a label out of a
 * 1,400-line step file made the step look like the owner of a rule that is
 * really about how a persona is described anywhere.
 *
 * Findings kickers ("Finding summary", "Choose a persona", "Goals they
 * tried") use this same face so a section label is one type. Size and
 * tracking come from Tailwind (`text-xs`, `tracking-widest`) — DESIGN.md
 * has no invented 10px / 0.14em scale.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionLabel({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <p
      id={id}
      className={cn(
        "text-xs font-semibold uppercase tracking-widest text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}
