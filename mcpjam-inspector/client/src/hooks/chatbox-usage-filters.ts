import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

export type UsageFilterPreset =
  | "all"
  | "needs_review"
  | "low_ratings"
  | "no_feedback";

/**
 * Hand-mirrored from `convex/lib/usageInsights/filters.ts`
 * (`usageDimensionKeyValidator`). Keep the two in sync — the server rejects a
 * key it does not know.
 */
export type UsageDimensionKey =
  | "deviceKind"
  | "visitorSegment"
  | "language"
  | "modelId"
  | "feedbackBucket"
  | "synthetic"
  | "outcome"
  | "friction"
  | "behaviorTag"
  | "pathKey";

/**
 * Mirrors `SESSION_OUTCOMES`. Closed list so the grid's columns are stable
 * across chatboxes and every rate has a denominator.
 */
export const SESSION_OUTCOMES = [
  "completed",
  "partial",
  "unresolved",
  "errored",
  "unclear",
] as const;

export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

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
    case "deviceKind":
      return thread.deviceKind === chip.value;
    case "visitorSegment":
      return thread.visitorSegment === chip.value;
    case "language":
      return thread.language === chip.value;
    case "modelId":
      return thread.modelId === chip.value;
    case "feedbackBucket":
      return threadFeedbackBucket(thread) === chip.value;
    case "synthetic":
      // "hide" chip: thread matches the filter only when it's NOT synthetic.
      // "show" chip: thread matches when it IS synthetic.
      if (chip.value === "hide") return thread.synthetic !== true;
      if (chip.value === "show") return thread.synthetic === true;
      return true;
    // Goal facets. Absence never matches a concrete outcome — a thread with no
    // recorded outcome is not in the `unclear` bucket, and letting it match
    // would put unanalyzed rows inside a rate. The sentinel is the one value
    // that DOES select absence, and it selects only absence.
    case "outcome":
      if (chip.value === UNLABELED_OUTCOME) return thread.outcome == null;
      return thread.outcome === chip.value;
    case "friction":
      return thread.friction === chip.value;
    case "behaviorTag":
      // Array-contains, not equality: the one multi-valued dimension.
      return thread.behaviorTags?.includes(chip.value) ?? false;
    case "pathKey":
      return thread.pathKey === chip.value;
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

/**
 * Drop the chips that encode a grid-cell selection (cluster + outcome), leaving
 * every other dimension's chips alone. Exported so a caller that dismisses the
 * drill-down can clear the selection without having to know which cell was open.
 */
export function clearCellChips(filter: UsageFilterState): UsageFilterState {
  return {
    ...filter,
    chips: filter.chips.filter(
      (chip) =>
        chip.kind !== "cluster" &&
        !(chip.kind === "dimension" && chip.key === "outcome"),
    ),
  };
}

/**
 * Chip value for the `outcome` dimension meaning "no outcome recorded".
 *
 * The "not analyzed" grid cell has to be expressible as a chip. Without a
 * sentinel it can only be represented as a cluster chip alone, which is a
 * *different, wider* filter — every outcome in that goal — so the drill-down
 * (which passes `outcome: null` to the query) and the Sessions list / topic map
 * (which read the chips) would disagree about which sessions the user selected.
 *
 * Mirrored by `UNLABELED_OUTCOME` in `convex/lib/usageInsights/filters.ts`; the
 * chip `value` is a free-form string on the wire, so no validator change is
 * needed, but both matchers must agree on the meaning.
 */
export const UNLABELED_OUTCOME = "__unlabeled__";

/** The chip value representing a cell's outcome, sentinel included. */
export function outcomeChipValue(outcome: SessionOutcome | null): string {
  return outcome === null ? UNLABELED_OUTCOME : outcome;
}

/**
 * Select one cell of the goal × outcome grid.
 *
 * NOT two `toggleChip` calls. Chips are OR'd within a dimension (see
 * `threadMatchesFilterState`), so toggling a second cluster chip or a second
 * outcome chip WIDENS the selection — clicking "Invoice lookup / unresolved"
 * and then "Refunds / errored" would match four cells instead of one. Selecting
 * a cell therefore REPLACES the cluster and outcome selections together, as a
 * single atomic state transition. Chips for other dimensions are preserved,
 * because they are genuine additional narrowing the user asked for.
 *
 * Clicking the already-selected cell clears the selection, which is the
 * behavior a toggle would give and the only part worth keeping.
 *
 * `outcome: null` selects the "not analyzed" cell and is carried as the
 * `UNLABELED_OUTCOME` sentinel chip, so the cell narrows the Sessions list and
 * the map exactly as it narrows the drill-down.
 */
export function selectCell(
  filter: UsageFilterState,
  cell: {
    clusterId: string;
    clusterLabel?: string;
    outcome: SessionOutcome | null;
  },
): UsageFilterState {
  const others = clearCellChips(filter).chips;

  if (isCellSelected(filter, cell)) {
    return { ...filter, chips: others };
  }

  return {
    ...filter,
    chips: [
      ...others,
      {
        kind: "cluster",
        clusterId: cell.clusterId,
        label: cell.clusterLabel,
      },
      {
        kind: "dimension",
        key: "outcome",
        value: outcomeChipValue(cell.outcome),
        label: cell.outcome ?? "not analyzed",
      },
    ],
  };
}

/** Whether `filter` currently selects exactly this cell and no other. */
export function isCellSelected(
  filter: UsageFilterState,
  cell: { clusterId: string; outcome: SessionOutcome | null },
): boolean {
  const clusters = filter.chips.filter((chip) => chip.kind === "cluster");
  const outcomes = filter.chips.filter(
    (chip) => chip.kind === "dimension" && chip.key === "outcome",
  );
  if (clusters.length !== 1 || outcomes.length !== 1) return false;
  if (
    clusters[0].kind !== "cluster" ||
    clusters[0].clusterId !== cell.clusterId
  ) {
    return false;
  }
  const only = outcomes[0];
  return (
    only.kind === "dimension" && only.value === outcomeChipValue(cell.outcome)
  );
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
