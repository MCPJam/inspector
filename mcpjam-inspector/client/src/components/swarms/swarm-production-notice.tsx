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
 * The treatment is `ErrorCard`'s `info` severity — the Figma node Vig linked
 * (`Design System — MCPJam App`, node 119-2) documents that component by name,
 * so this reads its palette from `severityStyles` rather than restating the
 * classes. It does NOT render an `ErrorCard`: that component reports a
 * `NormalizedError` and carries `role="alert"`, details, copy and a docs link.
 * Nothing here has failed — this is standing guidance — and minting a fake
 * error to borrow a colour would put a live alert on a healthy screen.
 */
import { severityStyles } from "@/components/ui/error-card";
import { cn } from "@/lib/utils";

// Module-local, not exported: the tests assert the copy with their own
// literal regexes on purpose, since a test importing the same constant the
// component renders asserts only that a string equals itself.
const SWARM_PRODUCTION_NOTICE_HEADING =
  "Use a development or staging server for Swarms";

const SWARM_PRODUCTION_NOTICE_BODY =
  "Agents take real actions on these servers, including writing and deleting data. Use development servers, not production.";

export function SwarmProductionNotice({
  "data-testid": testId,
}: {
  "data-testid": string;
}) {
  const styles = severityStyles("info");
  const Icon = styles.icon;
  return (
    <div
      className={cn("rounded-md border p-3 text-xs", styles.container)}
      data-testid={testId}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={cn("mt-0.5 h-4 w-4 flex-shrink-0", styles.iconClass)}
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium leading-tight">
            {SWARM_PRODUCTION_NOTICE_HEADING}
          </p>
          <p className="leading-snug text-foreground/80">
            {SWARM_PRODUCTION_NOTICE_BODY}
          </p>
        </div>
      </div>
    </div>
  );
}
