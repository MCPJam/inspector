/**
 * The per-case IMPORT CLAIM, as a compact badge and as a read-only note.
 *
 * One component, used by the overview, the case sidebar and the case editor,
 * because the single most important property of this badge is that all three
 * say the SAME WORDS. A converted case's trustworthiness is not something a
 * reader should have to reconcile across surfaces.
 *
 * The copy is the feature. `exact` is a CONVERTER CLAIM — the converter says
 * it applied a structural mapping rule — and MCPJam has verified nothing about
 * semantic equivalence. So the badge reads "claimed exact", never "verified",
 * "accepted", or "exact" on its own, and it is styled NEUTRALLY. A green tick
 * beside a claim nobody checked is the one visual that would make this whole
 * feature dishonest: it would read as an MCPJam guarantee, and people would
 * stop reading the note that explains what the claim actually rests on.
 *
 * The other three are graded by what they cost the reader:
 *   - `approximated` is CAUTIONARY (amber): it still runs, but only with a
 *     fresh human approval on every run.
 *   - `unsupported` and `unresolved` are BLOCKERS (destructive-toned): a
 *     selected case in either state refuses to run. They are scoped to the
 *     case, though — the badge says this case cannot run, never that the
 *     suite is broken, because the rest of the suite is fine.
 */

import type { EvalCaseImportClaim } from "./types";
import { cn } from "@/lib/utils";

type ClaimPresentation = {
  /** Exact badge text. Asserted verbatim by the tests — see the docblock. */
  label: string;
  /** Long-form copy, shown on hover and read by assistive tech. */
  description: string;
  className: string;
};

const CLAIM_PRESENTATION: Record<
  EvalCaseImportClaim["status"],
  ClaimPresentation
> = {
  exact: {
    label: "claimed exact",
    description:
      "Converter-claimed exact: the converter says it applied a structural " +
      "mapping rule. MCPJam has not verified that this case means what the " +
      "source case meant.",
    // Neutral on purpose. See the module docblock.
    className: "border-border/60 text-muted-foreground",
  },
  approximated: {
    label: "approximated",
    description:
      "The converter intentionally approximated the source behaviour. A " +
      "human must approve this case for every run; approval never persists.",
    className: "border-warning/40 bg-warning/10 text-warning-foreground",
  },
  unsupported: {
    label: "unsupported",
    description:
      "The source behaviour cannot currently be represented in MCPJam. This " +
      "case cannot run; the rest of the suite is unaffected.",
    className: "border-destructive/50 bg-destructive/10 text-destructive",
  },
  unresolved: {
    label: "unresolved",
    description:
      "A deterministic reference in this case does not resolve against the " +
      "target. This case cannot run; the rest of the suite is unaffected.",
    className: "border-destructive/50 bg-destructive/10 text-destructive",
  },
};

/**
 * The compact badge.
 *
 * Renders nothing for a native case — absence of a claim is not a status, and
 * a "native" chip on every hand-authored case would be noise on the surface
 * where hand-authored cases are the norm.
 */
export function ImportClaimBadge({
  claim,
  className,
}: {
  claim: EvalCaseImportClaim | undefined;
  className?: string;
}) {
  if (!claim) return null;
  const presentation = CLAIM_PRESENTATION[claim.status];
  // A status this build does not know is shown as nothing rather than as a
  // guess: an unrecognized claim rendered with a made-up label would read as
  // an assertion MCPJam never made.
  if (!presentation) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded border px-1 py-px text-[9px] font-medium uppercase tracking-wide",
        presentation.className,
        className,
      )}
      title={presentation.description}
      aria-label={`Import: ${presentation.label}`}
      data-testid={`import-claim-${claim.status}`}
    >
      {presentation.label}
    </span>
  );
}

/**
 * The converter's mapping note, READ-ONLY.
 *
 * Read-only because it is a record of what a converter did, not a field a
 * reviewer edits. Making it editable here would let somebody rewrite the
 * justification for a claim without changing the claim, which is the one edit
 * that makes the record actively misleading.
 */
export function ImportClaimDetails({
  claim,
  className,
}: {
  claim: EvalCaseImportClaim | undefined;
  className?: string;
}) {
  if (!claim) return null;
  const presentation = CLAIM_PRESENTATION[claim.status];
  if (!presentation) return null;
  return (
    <div
      className={cn(
        "rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs",
        className,
      )}
      data-testid="import-claim-details"
    >
      <div className="flex items-center gap-2">
        <ImportClaimBadge claim={claim} />
        <span className="text-muted-foreground">Imported case</span>
      </div>
      <p className="mt-1.5 text-muted-foreground">{presentation.description}</p>
      {claim.note ? (
        <p className="mt-1.5 whitespace-pre-wrap text-foreground">
          {claim.note}
        </p>
      ) : null}
      {claim.sourceCaseKey ? (
        <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">
          Source case: {claim.sourceCaseKey}
        </p>
      ) : null}
    </div>
  );
}

/** Exported for tests, so the pinned copy has exactly one definition. */
export const IMPORT_CLAIM_PRESENTATION = CLAIM_PRESENTATION;
