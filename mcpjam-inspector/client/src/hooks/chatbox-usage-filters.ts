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
  | "primaryBehavior"
  | "sentiment"
  | "pathKey";

/**
 * Mirrors `SESSION_OUTCOMES`. Closed list so the flow's columns are stable
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

/** Mirrors `SESSION_SENTIMENTS` in `convex/lib/usageInsights/signalEnums.ts`. */
export const SESSION_SENTIMENTS = [
  "satisfied",
  "neutral",
  "frustrated",
  "gave_up",
  "unclear",
] as const;

export type SessionSentiment = (typeof SESSION_SENTIMENTS)[number];

/**
 * Mirrors `PRIMARY_BEHAVIOR_PRIORITY`. The order IS the contract — it decides
 * which single node a multi-tagged session appears under, so a drift between
 * this list and the server's would make a node's click select a different set
 * of sessions than the node counted.
 */
export const PRIMARY_BEHAVIOR_PRIORITY = [
  "looping",
  "errored_tool",
  "retried",
  "multi_tool",
  "single_call",
  "long_conversation",
  "no_tools",
] as const;

export type PrimaryBehavior = (typeof PRIMARY_BEHAVIOR_PRIORITY)[number];

/** Client mirror of `primaryBehaviorTag`. */
export function primaryBehaviorTag(
  tags: readonly string[] | undefined | null,
): PrimaryBehavior | null {
  if (!tags || tags.length === 0) return null;
  for (const candidate of PRIMARY_BEHAVIOR_PRIORITY) {
    if (tags.includes(candidate)) return candidate;
  }
  return null;
}

export type UsageFilterChip =
  | { kind: "cluster"; clusterId: string; label?: string }
  | {
      kind: "dimension";
      key: UsageDimensionKey;
      value: string;
      label?: string;
    };

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
    case "sentiment":
      if (chip.value === UNLABELED_VALUE) return thread.sentiment == null;
      return thread.sentiment === chip.value;
    case "behaviorTag":
      // Array-contains, not equality: the one multi-valued dimension.
      return thread.behaviorTags?.includes(chip.value) ?? false;
    case "primaryBehavior": {
      // Equality against the collapsed value, NOT array-contains. A session
      // tagged both `looping` and `retried` belongs to the looping node only,
      // so a click on `retried` must not also select it.
      const primary = primaryBehaviorTag(thread.behaviorTags);
      if (chip.value === UNLABELED_VALUE) return primary === null;
      return primary === chip.value;
    }
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

/** The dimensions a flow selection owns. Everything else is the user's own narrowing. */
const SELECTION_DIMENSION_KEYS: readonly UsageDimensionKey[] = [
  "primaryBehavior",
  "outcome",
  "sentiment",
];

/**
 * Drop the chips that encode a flow selection (cluster + the three stage
 * dimensions), leaving every other dimension's chips alone. Exported so a caller
 * that dismisses the drill-down can clear the selection without having to know
 * which node or link was open.
 */
export function clearSelectionChips(
  filter: UsageFilterState,
): UsageFilterState {
  return {
    ...filter,
    chips: filter.chips.filter(
      (chip) =>
        chip.kind !== "cluster" &&
        !(
          chip.kind === "dimension" &&
          SELECTION_DIMENSION_KEYS.includes(chip.key)
        ),
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

/**
 * The same sentinel, named for the dimensions that adopted it after the outcome
 * grid. Every stage of the flow has an unlabeled node, and clicking one has to
 * produce a chip selecting exactly those sessions.
 */
export const UNLABELED_VALUE = UNLABELED_OUTCOME;

/**
 * Drop only the chips that the *currently open* cell put there, by identity.
 *
 * `clearCellChips` cannot serve this purpose. It strips the cluster dimension
 * wholesale, but the grid is not the only thing that writes cluster chips — the
 * topic map (clicking a community) and the usage-insights strip do too. Using it
 * to build the breakdown's own query therefore silently discarded a
 * map-originated cluster filter, so selecting a community stopped narrowing the
 * grid at all. Subtracting the open cell's two chips by value leaves every other
 * cluster chip, whatever wrote it, intact.
 *
 * With `cell` null nothing is removed: no cell is open, so no chip in the filter
 * is the grid's own output.
 */
export function withoutSelectionChips(
  filter: UsageFilterState,
  selection: InsightsSelection | null,
): UsageFilterState {
  if (!selection) return filter;
  const own = new Set(selectionChips(selection).map(chipKey));
  return {
    ...filter,
    chips: filter.chips.filter((chip) => !own.has(chipKey(chip))),
  };
}

/** The chip value representing a stage value, sentinel included. */
export function outcomeChipValue(outcome: SessionOutcome | null): string {
  return outcome === null ? UNLABELED_OUTCOME : outcome;
}

function stageChipValue(value: string | null): string {
  return value === null ? UNLABELED_VALUE : value;
}

/**
 * A selection in the insights flow: any subset of the four stages.
 *
 * A key being absent means "this stage is not part of the selection". A key set
 * to `null` means "the unlabeled node of this stage is selected" — a real,
 * clickable choice, and a different claim from absence. Clicking a node produces
 * a one-key selection; clicking a link produces a two-key one.
 *
 * The old goal × outcome cell is just the `{ goal, outcome }` case.
 */
export type InsightsSelection = {
  goal?: { clusterId: string; label?: string };
  behavior?: PrimaryBehavior | null;
  outcome?: SessionOutcome | null;
  sentiment?: SessionSentiment | null;
};

export function isEmptySelection(selection: InsightsSelection): boolean {
  return (
    selection.goal === undefined &&
    selection.behavior === undefined &&
    selection.outcome === undefined &&
    selection.sentiment === undefined
  );
}

/** The chips that express a selection. Order is stable for comparison. */
export function selectionChips(
  selection: InsightsSelection,
): UsageFilterChip[] {
  const chips: UsageFilterChip[] = [];
  if (selection.goal) {
    chips.push({
      kind: "cluster",
      clusterId: selection.goal.clusterId,
      label: selection.goal.label,
    });
  }
  if (selection.behavior !== undefined) {
    chips.push({
      kind: "dimension",
      key: "primaryBehavior",
      value: stageChipValue(selection.behavior),
      label: selection.behavior ?? "not analyzed",
    });
  }
  if (selection.outcome !== undefined) {
    chips.push({
      kind: "dimension",
      key: "outcome",
      value: outcomeChipValue(selection.outcome),
      label: selection.outcome ?? "not analyzed",
    });
  }
  if (selection.sentiment !== undefined) {
    chips.push({
      kind: "dimension",
      key: "sentiment",
      value: stageChipValue(selection.sentiment),
      label: selection.sentiment ?? "not analyzed",
    });
  }
  return chips;
}

/**
 * Apply a flow selection to the filter.
 *
 * NOT a series of `toggleChip` calls. Chips are OR'd within a dimension (see
 * `threadMatchesFilterState`), so toggling a second outcome chip WIDENS the
 * selection — clicking "completed → satisfied" and then "errored → frustrated"
 * would match four flows instead of one. A selection therefore REPLACES every
 * stage dimension at once, as a single atomic transition. Chips for other
 * dimensions are preserved, because they are genuine narrowing the user asked
 * for.
 *
 * A `null` stage value is carried as the `UNLABELED_VALUE` sentinel, so an
 * unlabeled node narrows the Sessions list and the map exactly as it narrows
 * the drill-down.
 */
export function applySelection(
  filter: UsageFilterState,
  selection: InsightsSelection,
): UsageFilterState {
  const others = clearSelectionChips(filter).chips;
  return { ...filter, chips: [...others, ...selectionChips(selection)] };
}

/** Whether `filter` currently expresses exactly this selection and no other. */
export function isSelectionSelected(
  filter: UsageFilterState,
  selection: InsightsSelection,
): boolean {
  const wanted = selectionChips(selection).map(chipKey).sort();
  const present = filter.chips
    .filter(
      (chip) =>
        chip.kind === "cluster" ||
        SELECTION_DIMENSION_KEYS.includes(chip.key as UsageDimensionKey),
    )
    .map(chipKey)
    .sort();
  if (wanted.length !== present.length) return false;
  return wanted.every((key, i) => key === present[i]);
}

/** Structural equality, used to decide whether a click re-opens or closes. */
export function isSameSelection(
  a: InsightsSelection | null,
  b: InsightsSelection | null,
): boolean {
  if (a === null || b === null) return a === b;
  const keys = selectionChips(a).map(chipKey).sort();
  const other = selectionChips(b).map(chipKey).sort();
  return (
    keys.length === other.length && keys.every((key, i) => key === other[i])
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
