/**
 * The reviewer sign-in in words: whether the credentials are saved, and how
 * far the latest rehearsal got. Saved, tested and delivered are separate
 * states; MCPJam says the first two, and a person records the third.
 */
import { formatDistanceToNow } from "date-fns";
import type {
  ReviewerAttempt,
  ReviewerSignIn,
} from "@/lib/apis/reviewer-attempts-api";

const DAY = { month: "short", day: "numeric", year: "numeric" } as const;

function signIn(attempt: ReviewerAttempt | null): string {
  switch (attempt?.state) {
    case "running":
      return "rehearsing the reviewer sign-in";
    case "waiting-for-person":
      return "reviewer sign-in waiting for a person";
  }
  const tested =
    attempt?.testedAt ??
    (attempt?.state === "passed" ? attempt.updatedAt : undefined);
  if (tested !== undefined) {
    const day = new Date(tested).toLocaleDateString("en-US", DAY);
    return `reviewer sign-in tested on ${day}`;
  }
  return attempt?.state === "failed"
    ? "reviewer sign-in failed"
    : "reviewer sign-in not tested";
}

/** One line, such as "Credentials saved; reviewer sign-in not tested". */
export function reviewerStatus(
  saved: boolean,
  attempt: ReviewerAttempt | null,
): string {
  return `${saved ? "Credentials saved" : "Credentials not saved"}; ${signIn(attempt)}`;
}

/** What else is known about the latest attempt, when it is not waiting. */
export function reviewerDetail(attempt: ReviewerAttempt | null) {
  switch (attempt?.state) {
    case "running": {
      const since = attempt.resumedAt ?? attempt.createdAt;
      return `Started ${formatDistanceToNow(since, { addSuffix: true })}.`;
    }
    case "failed":
      return (
        attempt.detail ??
        "The last rehearsal failed. Check the credentials, then rehearse again."
      );
    case "expired":
      return (
        attempt.detail ??
        "The last rehearsal expired before it finished. Rehearse again to test the sign-in."
      );
    case "cancelled":
      return attempt.detail ?? "The last rehearsal was cancelled.";
    default:
      return undefined;
  }
}

/**
 * What "Rehearse reviewer sign-in" sends: this submission's own secrets once
 * saved, or else the latest attempt's sign-in again, as an agent set it.
 */
export function rehearsalSignIn(
  savedHere: ReviewerSignIn | null,
  attempt: ReviewerAttempt | null,
): ReviewerSignIn | null {
  if (savedHere) return savedHere;
  if (!attempt) return null;
  const { passwordSecretName, usernameSecretName, username } = attempt;
  const { loginUrl, tenant } = attempt;
  return { passwordSecretName, usernameSecretName, username, loginUrl, tenant };
}
