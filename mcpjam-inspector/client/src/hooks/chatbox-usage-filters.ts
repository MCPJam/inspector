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
  // Equality against the single collapsed behavior value. Distinct from
  // `behaviorTag` (array-contains) — this one was missing here while the
  // server has had it, so a `primaryBehavior` chip round-tripped as an
  // unknown key on this side.
  | "primaryBehavior"
  | "sentiment"
  | "pathKey"
  // Deterministic rubric criteria. ONE static key for every criterion — the
  // criterion's identity travels in the chip VALUE
  // (`<criterionId>:pass|fail|ungraded`), because the key is a closed union
  // and criterion ids are minted at authoring time. `chipGroupKey` re-splits
  // them so each criterion behaves as its own boolean dimension.
  | "criterion";

/** Chip-value verdicts for the `criterion` dimension. */
export const CRITERION_PASS = "pass";
export const CRITERION_FAIL = "fail";
export const CRITERION_UNGRADED = "ungraded";

export type CriterionVerdict = "pass" | "fail" | "ungraded";

/** Build a criterion chip value. Mirrors `criterionChipValue` on the server. */
export function criterionChipValue(
  criterionId: string,
  verdict: CriterionVerdict,
): string {
  return `${criterionId}:${verdict}`;
}

/**
 * Split a criterion chip value into `(criterionId, verdict)`.
 *
 * Splits at the LAST colon. Criterion ids are UUIDs today and carry none, but
 * they are opaque client-minted strings by contract, so parsing defensively
 * costs nothing. Returns `null` for an unparseable value; the matcher then
 * matches nothing, which is the safe direction for a chip we cannot read.
 *
 * Mirrors `parseCriterionChipValue` in
 * `convex/lib/usageInsights/filters.ts` — the two must agree exactly or a
 * server-filtered page and a client-filtered list would disagree about what
 * the user selected.
 */
export function parseCriterionChipValue(
  value: string,
): { criterionId: string; verdict: CriterionVerdict } | null {
  const idx = value.lastIndexOf(":");
  if (idx <= 0) return null;
  const criterionId = value.slice(0, idx);
  const verdict = value.slice(idx + 1);
  if (
    verdict !== CRITERION_PASS &&
    verdict !== CRITERION_FAIL &&
    verdict !== CRITERION_UNGRADED
  ) {
    return null;
  }
  return { criterionId, verdict };
}

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

/**
 * Priority order for collapsing the multi-label trajectory tags to the single
 * value `primaryBehavior` compares against. Mirrors
 * `PRIMARY_BEHAVIOR_PRIORITY` in `convex/lib/usageInsights/signalEnums.ts` —
 * NOT array order: a session that both looped and retried is a looping
 * session, and taking `behaviorTags[0]` would make the client and server
 * disagree about which cohort a chip selects.
 */
const PRIMARY_BEHAVIOR_PRIORITY = [
  "looping",
  "errored_tool",
  "retried",
  "multi_tool",
  "two_tool",
  "single_call",
  "long_conversation",
  "no_tools",
] as const;

/** The single behavior value for a thread, or null when it has no tags. */
export function primaryBehaviorTag(
  tags: readonly string[] | undefined | null,
): string | null {
  if (!tags || tags.length === 0) return null;
  for (const candidate of PRIMARY_BEHAVIOR_PRIORITY) {
    if (tags.includes(candidate)) return candidate;
  }
  return null;
}

/** Mirrors `SESSION_SENTIMENTS` in `convex/lib/usageInsights/signalEnums.ts`. */
export const SESSION_SENTIMENTS = [
  "satisfied",
  "neutral",
  "frustrated",
  "gave_up",
  "unclear",
] as const;

export type SessionSentiment = (typeof SESSION_SENTIMENTS)[number];

/** Mirrors `SIGNAL_DIMENSIONS`. Each axis is clustered independently. */
export const SIGNAL_DIMENSIONS = [
  "goal",
  "behavior",
  "outcome",
  "sentiment",
] as const;

export type SignalDimension = (typeof SIGNAL_DIMENSIONS)[number];

export type UsageFilterChip =
  | {
      kind: "cluster";
      clusterId: string;
      /** Which axis's theme. Absent means `goal` — what the topic map writes. */
      dimension?: SignalDimension;
      label?: string;
    }
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
    return threadThemeId(thread, chip.dimension ?? "goal") === chip.clusterId;
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
      const primary = primaryBehaviorTag(thread.behaviorTags);
      if (chip.value === UNLABELED_VALUE) return primary === null;
      return primary === chip.value;
    }
    case "pathKey":
      return thread.pathKey === chip.value;
    case "criterion": {
      const parsed = parseCriterionChipValue(chip.value);
      if (!parsed) return false;
      const stamp = thread.criteria;
      const result = (
        stamp?.status === "completed" ? stamp.results : undefined
      )?.find((r) => r.criterionId === parsed.criterionId);
      if (parsed.verdict === CRITERION_UNGRADED) {
        // IN SCOPE but unverdicted — pending, or grading failed. A session
        // whose run carried no rubric is not "ungraded for this criterion",
        // it has nothing to do with this criterion; selecting it would make
        // the cohort disagree with the facet count that offers the chip.
        if (!stamp) return false;
        const inScope =
          stamp.criterionIds === undefined ||
          stamp.criterionIds.includes(parsed.criterionId);
        return inScope && result === undefined;
      }
      if (result === undefined) return false;
      return result.passed === (parsed.verdict === CRITERION_PASS);
    }
    default:
      return false;
  }
}

function chipGroupKey(chip: UsageFilterChip): string {
  // Theme chips group PER AXIS. Chips OR within a group and AND across groups,
  // so lumping every theme into one group would turn a flow selection —
  // this goal AND this behavior — into "either", a strictly wider cohort than
  // the link that was clicked. Two themes on the SAME axis still OR, which is
  // right: a session has one theme per axis, so requiring both matches nothing.
  if (chip.kind === "cluster") return `cluster:${chip.dimension ?? "goal"}`;
  // Criterion chips group PER CRITERION, not all under one `criterion` key.
  // Each criterion is an independent boolean fact about a session, so chips on
  // DIFFERENT criteria must AND ("failed A and failed B" is the cohort worth
  // looking at) while pass/fail on the SAME criterion must OR — a session
  // cannot be both, and requiring both would match nothing.
  if (chip.key === "criterion") {
    const parsed = parseCriterionChipValue(chip.value);
    return parsed ? `criterion:${parsed.criterionId}` : "criterion:__invalid__";
  }
  return chip.key;
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
  // The dimension is part of the identity: the same cluster id read against a
  // different axis is a different filter, and collapsing them would make
  // dedupe and identity-subtraction remove the wrong chip.
  return chip.kind === "cluster"
    ? `cluster:${chip.dimension ?? "goal"}:${chip.clusterId}`
    : `${chip.key}:${chip.value}`;
}

/** The theme a session carries on one axis; `themeClusterId` is the goal one. */
export function threadThemeId(
  thread: SharedChatThread,
  dimension: SignalDimension,
): string | undefined {
  switch (dimension) {
    case "goal":
      return thread.themeClusterId;
    case "behavior":
      return thread.behaviorClusterId;
    case "outcome":
      return thread.outcomeClusterId;
    case "sentiment":
      return thread.sentimentClusterId;
    default:
      return undefined;
  }
}

/**
 * Chip value for the `outcome` dimension meaning "no outcome recorded".
 *
 * Still used by the topic map's outcome tinting, which reads the closed enum
 * rather than the theme.
 */
export const UNLABELED_OUTCOME = "__unlabeled__";

/** The same sentinel under the name the other enum dimensions use. */
export const UNLABELED_VALUE = UNLABELED_OUTCOME;

/** The chip value representing an outcome, sentinel included. */
export function outcomeChipValue(outcome: SessionOutcome | null): string {
  return outcome === null ? UNLABELED_OUTCOME : outcome;
}

export type ThemeRef = {
  dimension: SignalDimension;
  clusterId: string;
  label?: string;
};

/**
 * A selection in the insights flow: one theme per axis, for any subset of axes.
 *
 * A node click selects one theme; a link click selects the two it joins, which
 * ANDs across those axes. Sentinel nodes are never selectable, so there is no
 * "unlabeled" case here — `__other__` is a union of themes and `__unlabeled__`
 * is the absence of one, and a cluster chip can express neither.
 */
export type InsightsSelection = {
  themes: ThemeRef[];
};

export function isEmptySelection(selection: InsightsSelection): boolean {
  return selection.themes.length === 0;
}

/** The chips that express a selection. */
export function selectionChips(
  selection: InsightsSelection,
): UsageFilterChip[] {
  return selection.themes.map((theme) => ({
    kind: "cluster" as const,
    clusterId: theme.clusterId,
    dimension: theme.dimension,
    label: theme.label,
  }));
}

/**
 * Drop specific chips by key.
 *
 * The flow's teardown uses this with the keys it actually ADDED, which is not
 * the same as the keys its selection implies. If the topic map had already
 * written the very chip a flow click would add, the click adds nothing — and a
 * teardown that removed everything the selection implies would then delete the
 * map's chip, silently dropping a filter the user set somewhere else. Chip
 * equality cannot express ownership, so ownership is tracked by the caller and
 * spent here.
 */
export function removeChipsByKeys(
  filter: UsageFilterState,
  keys: readonly string[],
): UsageFilterState {
  if (keys.length === 0) return filter;
  const drop = new Set(keys);
  return {
    ...filter,
    chips: filter.chips.filter((chip) => !drop.has(chipKey(chip))),
  };
}

/**
 * The chips a selection would ADD to this filter — its own, excluding any that
 * are already present because another surface put them there.
 */
export function selectionChipsToAdd(
  filter: UsageFilterState,
  selection: InsightsSelection,
): UsageFilterChip[] {
  const existing = new Set(filter.chips.map(chipKey));
  return selectionChips(selection).filter(
    (chip) => !existing.has(chipKey(chip)),
  );
}

/**
 * Replace `previous` with `next`, leaving every other chip alone.
 *
 * NOT a series of `toggleChip` calls. Chips OR within an axis, so toggling a
 * second theme on the same axis WIDENS the selection — clicking one behavior
 * and then another would match both instead of narrowing to the second.
 *
 * `previousOwnedKeys` are the chips the previous selection actually added; pass
 * them so a chip it merely coincided with survives.
 */
export function applySelection(
  filter: UsageFilterState,
  next: InsightsSelection,
  previousOwnedKeys: readonly string[] = [],
): UsageFilterState {
  const base = removeChipsByKeys(filter, previousOwnedKeys);
  return {
    ...base,
    chips: [...base.chips, ...selectionChipsToAdd(base, next)],
  };
}

/** Whether every chip this selection implies is currently active. */
export function isSelectionSelected(
  filter: UsageFilterState,
  selection: InsightsSelection,
): boolean {
  if (isEmptySelection(selection)) return false;
  const active = new Set(filter.chips.map(chipKey));
  return selectionChips(selection).every((chip) => active.has(chipKey(chip)));
}

/** Structural equality, used to decide whether a click re-opens or closes. */
export function isSameSelection(
  a: InsightsSelection | null,
  b: InsightsSelection | null,
): boolean {
  if (a === null || b === null) return a === b;
  const left = selectionChips(a).map(chipKey).sort();
  const right = selectionChips(b).map(chipKey).sort();
  return (
    left.length === right.length && left.every((key, i) => key === right[i])
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
