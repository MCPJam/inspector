/**
 * "On r7 · History" — the suite settings header's one piece of state.
 *
 * The header used to carry a Done button, which told a reader the settings
 * sheet was a FORM: fill it in, press Done, and something happens. Nothing
 * happened — Done only navigated, and the actual save had lived in the commit
 * bar since the draft shipped. Meanwhile the thing a reader of a shared suite
 * genuinely needs from that corner — which version of these settings am I
 * looking at, and who moved it last — was nowhere on the page.
 *
 * So the button is gone (the breadcrumb is the way back) and the revision is
 * here instead. It HIDES rather than rendering a placeholder when the backend
 * does not record revisions: "r—" is a number that does not exist, and a reader
 * cannot tell it from a suite that has never been edited.
 */

import { History } from "lucide-react";

export function SuiteRevisionPill({
  revisionNumber,
  onOpenHistory,
}: {
  /** Absent on a deployment that does not record revisions — then nothing renders. */
  revisionNumber?: number;
  onOpenHistory: () => void;
}) {
  if (revisionNumber === undefined) return null;
  return (
    <button
      type="button"
      onClick={onOpenHistory}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      data-testid="suite-revision-pill"
    >
      <span>On r{revisionNumber}</span>
      <span aria-hidden>·</span>
      <span className="flex items-center gap-1">
        <History className="h-3.5 w-3.5" />
        History
      </span>
    </button>
  );
}
