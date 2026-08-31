import { AlertTriangle, Server } from "lucide-react";
import type { CloudBlockTone } from "@/lib/cloud-server-readiness";
import { cn } from "@/lib/utils";

/**
 * One sentence, two surfaces: the suite header's disabled-run tooltip and the
 * Computer-environment section's notice band. Shared so a copy edit can't
 * leave one of them stale.
 */
export const EVAL_SANDBOX_CLOUD_UNREACHABLE_MESSAGE =
  "This suite pins a sandbox image, but this inspector can't run MCPJam cloud sandboxes.";

/**
 * Replay-specific variant: a replay provisions from the RUN's frozen snapshot
 * pin, which outlives clearing the live suite pin.
 */
export const EVAL_REPLAY_SNAPSHOT_CLOUD_UNREACHABLE_MESSAGE =
  "This run replays from its pinned sandbox image, but this inspector can't run MCPJam cloud sandboxes.";

/**
 * Preflight band for a cloud-only surface whose sandbox execution this
 * inspector cannot provide (`ephemeralCloudAvailable === false`) — shown
 * BEFORE a run is started, so the user isn't invited into a known failure.
 *
 * Tone contract mirrors `ComputersUnavailableMessage`: name the situation in
 * product terms; never instruct the user to set server environment variables.
 * Visual pattern mirrors the User Testing environment-error band.
 */
export function CloudUnreachableNotice({
  message,
  detail,
  tone = "warning",
  action,
  "data-testid": testId,
}: {
  message: string;
  detail?: string;
  /**
   * `guidance` for a setup step not taken yet: same shape and place, no alarm
   * colour or glyph. Defaults to `warning` so existing callers keep theirs.
   */
  tone?: CloudBlockTone;
  /** Omit unless it actually resolves this — a merely-related link is worse than none. */
  action?: { label: string; onClick: () => void };
  "data-testid"?: string;
}) {
  const isWarning = tone === "warning";
  const Icon = isWarning ? AlertTriangle : Server;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-4 py-3",
        isWarning
          ? "border-amber-500/30 bg-amber-500/10"
          : "border-border bg-muted/40",
      )}
      data-tone={tone}
      data-testid={testId ?? "cloud-unreachable-notice"}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          isWarning
            ? "text-amber-600 dark:text-amber-500"
            : "text-muted-foreground",
        )}
        {...(isWarning ? { "data-testid": "cloud-notice-alert-icon" } : {})}
      />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-foreground">{message}</p>
        {detail ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        ) : null}
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            data-testid="cloud-notice-action"
            className="mt-2 inline-flex items-center rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
