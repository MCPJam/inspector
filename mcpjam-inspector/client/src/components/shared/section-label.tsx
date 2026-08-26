/**
 * Field-group label for persona surfaces: the small uppercase band above
 * "Persona", "Use cases & context" and "Goals".
 *
 * Lives in `shared/` rather than in the Confirm step it was born in (BB-123):
 * the Personas library consumes it too, and importing a label out of a
 * 1,400-line step file made the step look like the owner of a rule that is
 * really about how a persona is described anywhere.
 */
import type { ReactNode } from "react";

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}
