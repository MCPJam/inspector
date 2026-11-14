/**
 * A directory submission's reviewer sign-in attempts, through the SDK's own
 * client and the transport `directory-readiness-api.ts` gives it. A body
 * names project secrets; a secret's value never passes through here.
 */
import type {
  PlatformReviewerAttempt,
  PlatformReviewerAttemptCreateBody,
} from "@mcpjam/sdk/platform";
import { readinessPlatformClient as client } from "@/lib/apis/directory-readiness-api";
import type { SubmissionScope } from "@/lib/apis/directory-submissions-api";

export type ReviewerAttempt = PlatformReviewerAttempt;
/** What an attempt signs in with: secret names, and plain fields. */
export type ReviewerSignIn = Omit<
  PlatformReviewerAttemptCreateBody,
  "idempotencyKey"
>;

/** The submission's newest attempt, or `null` before its first. */
export async function getLatestReviewerAttempt(
  scope: SubmissionScope,
  signal?: AbortSignal,
): Promise<ReviewerAttempt | null> {
  const page = await client().listDirectoryReviewerAttempts(
    { ...scope, limit: 1 },
    { signal },
  );
  return page.items[0] ?? null;
}

/** Starts an attempt and the run that signs in. A retried key replays. */
export async function startReviewerAttempt(
  scope: SubmissionScope,
  signIn: ReviewerSignIn,
  idempotencyKey: string,
): Promise<ReviewerAttempt> {
  const started = await client().createDirectoryReviewerAttempt({
    ...scope,
    ...signIn,
    idempotencyKey,
  });
  return started.attempt;
}

/** Hands an attempt that waits for a person to a new run. */
export async function resumeReviewerAttempt(
  scope: SubmissionScope,
  attemptId: string,
): Promise<ReviewerAttempt> {
  const resumed = await client().resumeDirectoryReviewerAttempt({
    ...scope,
    attemptId,
  });
  return resumed.attempt;
}

export const cancelReviewerAttempt = (
  scope: SubmissionScope,
  attemptId: string,
): Promise<ReviewerAttempt> =>
  client().cancelDirectoryReviewerAttempt({ ...scope, attemptId });
