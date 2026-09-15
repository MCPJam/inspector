/**
 * BB-234: swarm setup's standing note that a run acts for real on whatever
 * server it is pointed at.
 *
 * It started life inside `ServerPicker`'s popover, which put it on roughly ten
 * screens — evals, the environment editor and two chat authoring flows among
 * them — and only while the dropdown was open. The thread's call (Prathmesh
 * and Vig, Sep 15) was to pull it out of the dropdown entirely, scope it to
 * Swarms, and leave it on the page.
 *
 * Informational blue, not warning amber, was Vig's call too: the notice loads
 * every time the feature does, so amber would read as an alarm on a screen
 * where nothing is actually wrong. The heading carries the instruction; the
 * body says why it matters.
 *
 * Shape mirrors `CloudUnreachableNotice`, its neighbour in the same section,
 * so the two bands read as one system rather than two. Tint plus
 * reading-weight body copy, per DESIGN.md: `info` clears 3:1 for large text
 * only, so the small print stays on `muted-foreground` and never on a fill.
 */
import { Info } from "lucide-react";

export const SWARM_PRODUCTION_NOTICE_HEADING =
  "Use a development or staging server for Swarms";

export const SWARM_PRODUCTION_NOTICE_BODY =
  "Agents take real actions on these servers, including writing and deleting data. Use development servers, not production.";

export function SwarmProductionNotice({
  "data-testid": testId = "swarm-production-notice",
}: {
  "data-testid"?: string;
} = {}) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 px-4 py-3"
      data-testid={testId}
    >
      <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-foreground">
          {SWARM_PRODUCTION_NOTICE_HEADING}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {SWARM_PRODUCTION_NOTICE_BODY}
        </p>
      </div>
    </div>
  );
}
