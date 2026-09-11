import { AlertTriangle } from "lucide-react";

/**
 * Tells a tester that a server this session depends on did not connect.
 *
 * The failure it reports used to be silent: the composer's server list showed
 * a green dot for every server in the bootstrap payload whether or not anything
 * had ever reached them, so a tester could spend a whole session asking a model
 * with no tools why it couldn't do the thing they were sent here to try.
 *
 * Copy stays in the visitor's frame — they followed a link, they cannot fix the
 * scenario's setup, and transport detail is noise to them. Naming the server
 * and pointing at whoever shared the link is the whole actionable content.
 */
export function ScenarioUnreachableServersBanner({
  serverNames,
}: {
  serverNames: string[];
}) {
  // The live region is mounted even while empty. A `role="status"` element that
  // appears already populated is not reliably announced — the region has to
  // exist before the text arrives for the change to be one.
  return (
    <div role="status" aria-live="polite">
      {serverNames.length === 0 ? null : (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
          <div className="mx-auto flex w-full max-w-6xl items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <div className="min-w-0 text-xs leading-relaxed">
              <p className="font-medium text-foreground">
                {serverNames.length > 1
                  ? `${serverNames.length} servers couldn't be reached`
                  : `${serverNames[0]} couldn't be reached`}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {serverNames.length > 1 ? `${serverNames.join(", ")}. ` : null}
                Anything that needs{" "}
                {serverNames.length > 1 ? "these tools" : "this tool"} won&apos;t
                work in this session. You can still chat — let whoever shared
                this link know.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
