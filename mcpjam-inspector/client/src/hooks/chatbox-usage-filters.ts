import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

export type UsageSessionFilter =
  | "all"
  | "needs_review"
  | "low_ratings"
  | "no_feedback";

const MEANINGFUL_MESSAGE_THRESHOLD = 4;

function hasNoFeedbackRecord(thread: SharedChatThread): boolean {
  return (
    thread.feedbackRating == null &&
    !(thread.feedbackComment && thread.feedbackComment.trim().length > 0)
  );
}

/** Heuristic when backend does not yet send explicit review signals. */
function inferNeedsReviewHeuristic(thread: SharedChatThread): boolean {
  if (thread.authInterrupted) return true;
  if (
    hasNoFeedbackRecord(thread) &&
    thread.messageCount >= MEANINGFUL_MESSAGE_THRESHOLD
  ) {
    return true;
  }
  return false;
}

export function threadMatchesUsageFilter(
  thread: SharedChatThread,
  filter: UsageSessionFilter,
): boolean {
  if (filter === "all") return true;

  const rating = thread.feedbackRating;
  const comment = thread.feedbackComment?.trim() ?? "";

  if (filter === "low_ratings") {
    return rating === 1 || rating === 2;
  }

  if (filter === "no_feedback") {
    return hasNoFeedbackRecord(thread);
  }

  // needs_review
  if (rating === 1 || rating === 2) return true;
  if (rating === 3 && comment.length > 0) return true;
  if (inferNeedsReviewHeuristic(thread)) return true;
  return false;
}

export function compareThreadsForUsageList(
  a: SharedChatThread,
  b: SharedChatThread,
): number {
  const score = (t: SharedChatThread) => {
    let s = 0;
    const r = t.feedbackRating;
    if (r === 1 || r === 2) s += 100;
    else if (r === 3 && (t.feedbackComment?.trim().length ?? 0) > 0) s += 80;
    else if (t.authInterrupted) s += 70;
    else if (inferNeedsReviewHeuristic(t)) s += 50;
    if (r != null) s += (5 - r) * 5;
    return s;
  };

  const diff = score(b) - score(a);
  if (diff !== 0) return diff;

  const ra = a.feedbackRating ?? 99;
  const rb = b.feedbackRating ?? 99;
  if (ra !== rb) return ra - rb;

  return b.lastActivityAt - a.lastActivityAt;
}
