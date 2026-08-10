import { AlertTriangle } from "lucide-react";

/**
 * Amber preflight band for a cloud-only surface whose sandbox execution this
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
  "data-testid": testId,
}: {
  message: string;
  detail?: string;
  "data-testid"?: string;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3"
      data-testid={testId ?? "cloud-unreachable-notice"}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-foreground">{message}</p>
        {detail ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}
