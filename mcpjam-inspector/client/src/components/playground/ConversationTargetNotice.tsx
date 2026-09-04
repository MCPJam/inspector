import { AlertTriangle } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import type { ConversationTargetDisclosure } from "@/lib/conversation-execution-target";

/**
 * Honest header for a REOPENED conversation whose composer does not describe
 * it.
 *
 * The Playground's host, environment and tool controls are ambient per-project
 * browser state, so a conversation opened by `?conversation=<id>` renders under
 * the viewer's current selection. Left unlabelled that reads as a statement
 * about the conversation, and a reply typed under it silently runs on a target
 * the transcript never used.
 *
 * Two things are said here, and nothing is invented:
 *
 *   - `unrecorded` — the conversation stored no execution target, so we say so
 *     rather than dressing the ambient selection up as history.
 *   - `mismatch` — it DID store one and it is not the one selected, so we name
 *     the recorded id and say a reply goes elsewhere.
 *
 * `onAcknowledge` is what un-gates the composer. Continuing on a different
 * target is legitimate — that is why this is a one-click acknowledgement and
 * not a refusal — but it has to be the user's deliberate act, which is exactly
 * what "silently ran on the wrong host" was missing.
 */
export function ConversationTargetNotice({
  disclosure,
  composerHostName,
  composerEnvironmentId,
  onAcknowledge,
  className,
}: {
  disclosure: ConversationTargetDisclosure;
  /** Display name of the host a reply would run on, when one is resolved. */
  composerHostName?: string | null;
  /** Environment a reply would run on, when the composer is in environment mode. */
  composerEnvironmentId?: string | null;
  onAcknowledge: () => void;
  className?: string;
}) {
  if (disclosure.kind === "none") return null;

  const runsOn = composerEnvironmentId
    ? `environment ${composerEnvironmentId}`
    : composerHostName
    ? composerHostName
    : "your current selection";

  return (
    <div
      className={cn(
        "mx-2 mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400",
        className,
      )}
      role="status"
      data-testid="conversation-target-notice"
      data-disclosure={disclosure.kind}
    >
      <AlertTriangle className="mt-[2px] size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {disclosure.kind === "unrecorded" ? (
          <p>
            <span className="font-medium">
              As-run configuration unavailable.
            </span>{" "}
            This conversation didn&apos;t record which host or environment it
            ran on, so the controls below are your current selection — not this
            chat&apos;s. A reply will run on {runsOn}.
          </p>
        ) : (
          <p>
            <span className="font-medium">
              This conversation ran somewhere else.
            </span>{" "}
            It recorded{" "}
            {disclosure.recorded.kind === "environment" ? (
              <>
                environment{" "}
                <code className="font-mono">
                  {disclosure.recorded.environmentId}
                </code>
              </>
            ) : (
              <>
                host{" "}
                <code className="font-mono">{disclosure.recorded.hostId}</code>
              </>
            )}
            , which is not what is selected. A reply will run on {runsOn}.
          </p>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-[11px] font-medium"
        onClick={onAcknowledge}
        data-testid="conversation-target-notice-acknowledge"
      >
        Continue here
      </Button>
    </div>
  );
}
