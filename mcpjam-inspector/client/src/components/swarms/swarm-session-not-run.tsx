/**
 * A swarm session that never ran (#5188): its attempt ended without recording
 * a single message, so nothing about the server under test was exercised.
 *
 * Every surface used to infer something from that absence instead. The detail
 * pane hedged "May not have run" under a judge that tried to grade it, and the
 * lists showed an ordinary row with no preview. These say the one true thing
 * and, when the attempt recorded it, why, in the words the Run tab uses for
 * the same attempt.
 */
import {
  swarmAttemptLifecycle,
  swarmSessionNeverRan,
} from "@mcpjam/sdk/contract";
import { ErrorCard } from "@/components/ui/error-card";
import {
  describeSwarmAttemptFailure,
  providerLabelForModelId,
} from "@/components/swarms/session-rate-limit";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import type { RunLaunchFailures } from "@/lib/swarm-api";
import { cn } from "@/lib/utils";
import { humanizeSwarmAttemptError } from "@/shared/swarm-attempt-error";

type AttemptStatus = NonNullable<SharedChatThread["runAttemptStatus"]>;

/**
 * Whether a session never ran, by the shared rule (`swarmSessionNeverRan`).
 *
 * A Sessions list row carries the answer already resolved from its verdict;
 * the detail read and the Findings drilldown carry the attempt status instead.
 * An unknown outcome is never "never ran": without a status there is nothing
 * to say, and the surfaces keep what they showed before.
 */
export function threadNeverRan(
  thread: Pick<
    SharedChatThread,
    | "sourceType"
    | "messageCount"
    | "neverRan"
    | "runAttemptStatus"
    | "runAttemptErrorCode"
  >,
): boolean {
  if (thread.sourceType !== "swarm") return false;
  if (thread.neverRan !== undefined) return thread.neverRan;
  if (!thread.runAttemptStatus) return false;
  const messageCount = thread.messageCount ?? 0;
  return swarmSessionNeverRan(
    swarmAttemptLifecycle(
      {
        status: thread.runAttemptStatus,
        errorCode: thread.runAttemptErrorCode ?? null,
      },
      messageCount > 0,
    ),
    messageCount,
  );
}

/** Said when the attempt recorded no reason (or a backend predates the field). */
const STATUS_REASON: Partial<Record<AttemptStatus, string>> = {
  failed:
    "Its attempt failed before the conversation started. No reason was recorded.",
  rate_limited:
    "A rate limit stopped its attempt before the conversation started.",
};

/**
 * True when the attempt row says something a reader can use. A bare unknown
 * code with no message humanizes to "failed for an unknown reason", which is
 * worse than the status sentence.
 */
export function hasRecordedReason(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): boolean {
  if (errorMessage?.trim()) return true;
  return humanizeSwarmAttemptError(null, errorCode).code !== undefined;
}

/**
 * The Sessions detail for a session that never ran. It replaces the empty
 * transcript, and with it the judge and the promote affordance: there is no
 * conversation to grade or to turn into a test case.
 */
export function SwarmSessionNotRun({
  status,
  errorCode,
  errorMessage,
  modelId,
}: {
  status: AttemptStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  modelId?: string;
}) {
  return (
    <div
      role="status"
      className="flex w-full max-w-md flex-col items-center gap-3 text-center"
      data-testid="swarm-session-not-run"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          This session didn't run
        </p>
        <p className="text-xs text-muted-foreground">
          It ended before recording a single message, so nothing about the
          server was tested.
        </p>
      </div>
      {hasRecordedReason(errorCode, errorMessage) ? (
        <div
          className="w-full text-left"
          data-testid="swarm-session-not-run-reason"
        >
          <ErrorCard
            variant="inline"
            error={describeSwarmAttemptFailure(
              errorMessage,
              errorCode,
              providerLabelForModelId(modelId),
            )}
          />
        </div>
      ) : (
        <p
          className="text-xs text-muted-foreground"
          data-testid="swarm-session-not-run-reason"
        >
          {STATUS_REASON[status] ?? "No reason was recorded."}
        </p>
      )}
    </div>
  );
}

/**
 * Why a wave's sessions never ran, in one sentence, for the Findings summary.
 *
 * Reasons merge across runs by (code, message), so a refusal that hit every
 * goal reads once, and the most common one is named. When it does not cover
 * every session that never ran, the sentence says how many it does. `null`
 * when nothing was refused, or when no attempt recorded a usable reason: the
 * summary above already counts those sessions, and "unknown" adds nothing.
 */
export function describeLaunchFailures(
  failures: readonly RunLaunchFailures[] | null | undefined,
): string | null {
  if (!failures?.length) return null;
  let notRun = 0;
  const merged = new Map<string, RunLaunchFailures["reasons"][number]>();
  for (const run of failures) {
    notRun += run.sessionsNotRun;
    for (const reason of run.reasons) {
      if (!hasRecordedReason(reason.errorCode, reason.errorMessage)) continue;
      const key = JSON.stringify([reason.errorCode, reason.errorMessage]);
      const seen = merged.get(key);
      if (seen) seen.count += reason.count;
      else merged.set(key, { ...reason });
    }
  }
  const top = [...merged.values()].sort((a, b) => b.count - a.count)[0];
  if (!top || notRun === 0) return null;
  const sentence = describeSwarmAttemptFailure(
    top.errorMessage,
    top.errorCode,
    providerLabelForModelId(undefined),
  ).oneLine;
  return top.count >= notRun
    ? sentence
    : `${sentence} (${top.count} of the ${notRun} sessions that didn't run)`;
}

/** The list-row mark for a session that never ran, in place of a preview. */
export function NeverRanTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "rounded-sm bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground",
        className,
      )}
      data-testid="swarm-session-never-ran-tag"
    >
      Didn't run
    </span>
  );
}
