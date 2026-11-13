/**
 * Reviewer sign-in attempts, read the way the routes and a resumed run need
 * them. The backend owns the attempt; every call here carries the caller's
 * bearer, and none reads or returns a secret's value.
 */
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { PlatformReviewerAttempt } from "@mcpjam/sdk/platform";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { logger } from "../../utils/logger.js";

const query = (name: string) =>
  makeFunctionReference<"query">(`directoryReviewerAttempts:${name}`);
const mutation = (name: string) =>
  makeFunctionReference<"mutation">(`directoryReviewerAttempts:${name}`);

export const reviewerAttemptFunctions = {
  create: mutation("createDirectoryReviewerAttempt"),
  get: query("getDirectoryReviewerAttempt"),
  list: query("listDirectoryReviewerAttempts"),
  resume: mutation("resumeDirectoryReviewerAttempt"),
  cancel: mutation("cancelDirectoryReviewerAttempt"),
};

export const ATTEMPT_NOT_FOUND =
  "Reviewer attempt not found for this submission. List the submission's attempts and pick one.";

type Scope = { projectId: string; submissionId: string };
type Translate = (error: unknown) => Error;

/** The attempt, if it belongs to this submission; any other answers 404. */
export async function readReviewerAttempt(
  convex: ConvexHttpClient,
  scope: Scope,
  attemptId: string,
  translate: Translate,
): Promise<PlatformReviewerAttempt> {
  let attempt: PlatformReviewerAttempt | null;
  try {
    attempt = await convex.query(reviewerAttemptFunctions.get, { attemptId });
  } catch (error) {
    throw translate(error);
  }
  if (
    attempt?.projectId !== scope.projectId ||
    attempt.submissionId !== scope.submissionId
  ) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, ATTEMPT_NOT_FOUND);
  }
  return attempt;
}

/** The attempt's id, if a run may work on it now: only while it is running. */
export async function runnableReviewerAttemptId(
  convex: ConvexHttpClient,
  scope: Scope,
  attemptId: string,
  translate: Translate,
): Promise<string> {
  const { id, state } = await readReviewerAttempt(convex, scope, attemptId, translate);
  if (state === "running") return id;
  throw new WebRouteError(
    409,
    ErrorCode.CONFLICT,
    state === "waiting-for-person"
      ? "This reviewer attempt is waiting for a person. Resume it, which starts its next run."
      : `This reviewer attempt is ${state}, so no run can work on it. Start a new attempt.`,
    { code: "attempt_not_running", state },
  );
}

/**
 * The attempt a resumed run worked on: the submission's newest attempt, if it
 * names this run. Only the newest can be open, and an open attempt names the
 * run working on it until it waits or ends.
 */
export async function reviewerAttemptForRun(
  convex: ConvexHttpClient,
  submissionId: string,
  runId: string,
): Promise<string | undefined> {
  try {
    const newest: PlatformReviewerAttempt[] | null = await convex.query(
      reviewerAttemptFunctions.list,
      { submissionId, limit: 1 },
    );
    return newest?.[0]?.currentRunId === runId ? newest[0].id : undefined;
  } catch (error) {
    // The run still grades the submission, only without the attempt, which
    // waits for a later run or expires.
    logger.warn("[readiness] could not find a resumed run's reviewer attempt", {
      runId,
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
