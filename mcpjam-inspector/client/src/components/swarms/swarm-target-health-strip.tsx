/**
 * Terminal target-health strip — launch outcomes, kept OUT of the findings.
 *
 * A wave's targets can fail before a single session exists: the sandbox never
 * came up, the provider throttled, the host refused the connection. That used
 * to be mined as a `target_failures` finding, which produced a confident "your
 * MCP server is broken" row with no session to open behind it. The miner now
 * emits those outcomes as `targetHealth` instead, and this strip is where they
 * are shown — above the tab content, beside the findings, never among them.
 *
 * Rate-limited is a SEPARATE column from failed on purpose: throttling is a
 * retry-later, not a broken target, and merging the two made every throttled
 * wave read as an outage.
 */
import { cn } from "@/lib/utils";
import {
  humanizeSwarmAttemptError,
  UNKNOWN_ATTEMPT_ERROR_MESSAGE,
} from "@/shared/swarm-attempt-error";
import type { SwarmWaveTargetHealth } from "@/lib/swarm-api";

/** A target is worth a row only once something did not simply succeed. */
function hasTrouble(row: SwarmWaveTargetHealth): boolean {
  return row.failed > 0 || row.rateLimited > 0;
}

/**
 * The refusal, prettified through the SHARED humanizer — same path the live
 * Running step takes. Never rendered raw: rows written before the runner
 * started sanitizing still hold a full `swarm-agent <url> failed (429): {...}`
 * envelope, and a recognized code alone is enough for the humanizer to name a
 * sandbox failure with no stored message at all.
 *
 * `null` when the humanizer can only reach its unknown-reason fallback. Unlike
 * a per-attempt view, this strip has ALREADY said what happened in its chips —
 * "1 rate limited" followed by "The session failed for an unknown reason"
 * reads as a contradiction, and an unrecognized `errorCode` with no stored
 * message lands exactly there.
 */
export function targetFailureReason(row: SwarmWaveTargetHealth): string | null {
  if (!row.errorCode && !row.errorMessage) return null;
  const { message } = humanizeSwarmAttemptError(
    row.errorMessage,
    row.errorCode
  );
  return message === UNKNOWN_ATTEMPT_ERROR_MESSAGE ? null : message;
}

export function SwarmTargetHealthStrip({
  targetHealth,
  terminal,
}: {
  /** Optional: a server deployed before the field existed omits it. */
  targetHealth: SwarmWaveTargetHealth[] | undefined;
  /** Every run of the wave has left `running`. */
  terminal: boolean;
}) {
  // Mid-run counts are a moving target — an attempt that is about to be
  // retried reads as a failure until it isn't. Wait for the wave to settle
  // rather than flashing an outage banner at a healthy run.
  if (!terminal) return null;
  const troubled = (targetHealth ?? []).filter(hasTrouble);
  if (troubled.length === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border/40 bg-amber-500/[0.06] px-8 py-2"
      data-testid="swarm-target-health"
      role="status"
    >
      <span className="text-xs font-medium text-foreground">
        Some launches did not reach a session
      </span>
      {troubled.map((row) => {
        const reason = targetFailureReason(row);
        return (
          <span
            key={`${row.subjectKind}:${row.subjectId}`}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="swarm-target-health-row"
            data-subject-id={row.subjectId}
            {...(reason ? { title: reason } : {})}
          >
            <span className="font-medium text-foreground/80">
              {row.subjectLabel}
            </span>
            <span className="tabular-nums">
              {row.succeeded} of {row.attempted} started
            </span>
            {row.failed > 0 ? (
              <span
                className={cn(
                  "rounded border px-1 py-0 text-[10px] font-medium tabular-nums",
                  "border-destructive/40 bg-destructive/10 text-destructive"
                )}
                data-testid="swarm-target-health-failed"
              >
                {row.failed} failed
              </span>
            ) : null}
            {row.rateLimited > 0 ? (
              <span
                className={cn(
                  "rounded border px-1 py-0 text-[10px] font-medium tabular-nums",
                  "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                )}
                data-testid="swarm-target-health-rate-limited"
              >
                {row.rateLimited} rate limited
              </span>
            ) : null}
            {reason ? (
              <span
                className="max-w-[28rem] truncate"
                data-testid="swarm-target-health-reason"
              >
                {reason}
              </span>
            ) : null}
          </span>
        );
      })}
      <span className="text-[11px] text-muted-foreground">
        Launch outcomes — not a finding about the server's tools.
      </span>
    </div>
  );
}
