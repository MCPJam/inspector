import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

export type UsageFilterPreset =
  | "all"
  | "needs_review"
  | "low_ratings"
  | "no_feedback";

export type UsageDimensionKey =
  | "geoCountry"
  | "deviceKind"
  | "visitorSegment"
  | "language"
  | "modelId"
  | "feedbackBucket";

export type UsageFilterChip =
  | { kind: "cluster"; clusterId: string; label?: string }
  | { kind: "dimension"; key: UsageDimensionKey; value: string; label?: string };

export type UsageFilterState = {
  preset: UsageFilterPreset;
  chips: UsageFilterChip[];
};

/** Back-compat alias for the old string-only preset. */
export type UsageSessionFilter = UsageFilterPreset;

export const EMPTY_USAGE_FILTER: UsageFilterState = {
  preset: "all",
  chips: [],
};

const MEANINGFUL_MESSAGE_THRESHOLD = 4;

function hasNoFeedbackRecord(thread: SharedChatThread): boolean {
  return (
    thread.feedbackRating == null &&
    !(thread.feedbackComment && thread.feedbackComment.trim().length > 0)
  );
}

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

function threadLanguage(thread: SharedChatThread): string | undefined {
  return thread.language;
}

function threadFeedbackBucket(thread: SharedChatThread): string {
  const r = thread.feedbackRating;
  if (r == null) return "none";
  if (r >= 4) return "positive";
  if (r >= 3) return "neutral";
  return "negative";
}

export function threadMatchesUsageFilter(
  thread: SharedChatThread,
  filter: UsageFilterPreset,
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

export function threadMatchesChip(
  thread: SharedChatThread,
  chip: UsageFilterChip,
): boolean {
  if (chip.kind === "cluster") {
    return thread.themeClusterId === chip.clusterId;
  }
  switch (chip.key) {
    case "geoCountry":
      return thread.geoCountry === chip.value;
    case "deviceKind":
      return thread.deviceKind === chip.value;
    case "visitorSegment":
      return thread.visitorSegment === chip.value;
    case "language":
      return threadLanguage(thread) === chip.value;
    case "modelId":
      return thread.modelId === chip.value;
    case "feedbackBucket":
      return threadFeedbackBucket(thread) === chip.value;
    default:
      return false;
  }
}

function chipGroupKey(chip: UsageFilterChip): string {
  return chip.kind === "cluster" ? "cluster" : chip.key;
}

export function threadMatchesFilterState(
  thread: SharedChatThread,
  filter: UsageFilterState,
): boolean {
  if (!threadMatchesUsageFilter(thread, filter.preset)) return false;
  // Chips are AND'd across dimensions but OR'd within the same dimension.
  // A thread can only belong to one cluster / one country / etc., so
  // stacking two chips for the same dimension should widen rather than
  // produce an impossible match.
  const groups = new Map<string, UsageFilterChip[]>();
  for (const chip of filter.chips) {
    const key = chipGroupKey(chip);
    const bucket = groups.get(key) ?? [];
    bucket.push(chip);
    groups.set(key, bucket);
  }
  for (const bucket of groups.values()) {
    const matchesAny = bucket.some((chip) => threadMatchesChip(thread, chip));
    if (!matchesAny) return false;
  }
  return true;
}

export function toggleChip(
  filter: UsageFilterState,
  chip: UsageFilterChip,
): UsageFilterState {
  const matches = filter.chips.findIndex((c) => chipKey(c) === chipKey(chip));
  if (matches >= 0) {
    return {
      ...filter,
      chips: filter.chips.filter((_, i) => i !== matches),
    };
  }
  return { ...filter, chips: [...filter.chips, chip] };
}

export function chipKey(chip: UsageFilterChip): string {
  return chip.kind === "cluster"
    ? `cluster:${chip.clusterId}`
    : `${chip.key}:${chip.value}`;
}

export function removeChipByKey(
  filter: UsageFilterState,
  key: string,
): UsageFilterState {
  return {
    ...filter,
    chips: filter.chips.filter((c) => chipKey(c) !== key),
  };
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
