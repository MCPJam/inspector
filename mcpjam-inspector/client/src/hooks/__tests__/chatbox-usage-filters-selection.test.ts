import { describe, expect, it } from "vitest";
import {
  EMPTY_USAGE_FILTER,
  applySelection,
  chipKey,
  isSameSelection,
  isSelectionSelected,
  threadMatchesChip,
  threadMatchesFilterState,
  threadThemeId,
  toggleChip,
  withoutSelectionChips,
  type InsightsSelection,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

function thread(overrides: Partial<SharedChatThread> = {}): SharedChatThread {
  return {
    _id: "s1",
    sourceType: "chatbox",
    chatSessionId: "cs1",
    messageCount: 4,
    startedAt: 0,
    lastActivityAt: 0,
    ...overrides,
  } as SharedChatThread;
}

const GOAL_A: InsightsSelection = {
  themes: [
    { dimension: "goal", clusterId: "g-a", label: "Refund a duplicate charge" },
  ],
};
const GOAL_B: InsightsSelection = {
  themes: [{ dimension: "goal", clusterId: "g-b", label: "Reconcile payout" }],
};
/** What a link click between the outcome and sentiment columns produces. */
const LINK: InsightsSelection = {
  themes: [
    { dimension: "outcome", clusterId: "o-1", label: "Goal reached" },
    { dimension: "sentiment", clusterId: "s-1", label: "Frustrated" },
  ],
};

describe("applySelection", () => {
  it("selects one theme as one chip carrying its axis", () => {
    const next = applySelection(EMPTY_USAGE_FILTER, GOAL_A);
    expect(next.chips.map(chipKey)).toEqual(["cluster:goal:g-a"]);
  });

  it("selects a link as both endpoints, ANDed across the two axes", () => {
    const next = applySelection(EMPTY_USAGE_FILTER, LINK);
    expect(next.chips.map(chipKey).sort()).toEqual([
      "cluster:outcome:o-1",
      "cluster:sentiment:s-1",
    ]);
    expect(
      threadMatchesFilterState(
        thread({ outcomeClusterId: "o-1", sentimentClusterId: "s-1" }),
        next,
      ),
    ).toBe(true);
    expect(
      threadMatchesFilterState(
        thread({ outcomeClusterId: "o-1", sentimentClusterId: "s-other" }),
        next,
      ),
    ).toBe(false);
  });

  it("replaces the previous selection rather than accumulating", () => {
    // Chips OR within an axis, so leaving the old theme behind would match both
    // instead of narrowing to the one that was clicked.
    const first = applySelection(EMPTY_USAGE_FILTER, GOAL_A);
    const second = applySelection(first, GOAL_B, GOAL_A);

    expect(second.chips.map(chipKey)).toEqual(["cluster:goal:g-b"]);
    expect(isSelectionSelected(second, GOAL_B)).toBe(true);
    expect(isSelectionSelected(second, GOAL_A)).toBe(false);
  });

  it("widens rather than narrows if toggleChip is used instead — the bug this avoids", () => {
    // Pinned as a contrast case: if a future refactor reaches for toggleChip
    // here, this documents concretely what goes wrong.
    let widened: UsageFilterState = EMPTY_USAGE_FILTER;
    for (const clusterId of ["g-a", "g-b"]) {
      widened = toggleChip(widened, {
        kind: "cluster",
        clusterId,
        dimension: "goal",
      });
    }
    expect(
      threadMatchesFilterState(thread({ themeClusterId: "g-a" }), widened),
    ).toBe(true);
    expect(
      threadMatchesFilterState(thread({ themeClusterId: "g-b" }), widened),
    ).toBe(true);

    const narrowed = applySelection(
      applySelection(EMPTY_USAGE_FILTER, GOAL_A),
      GOAL_B,
      GOAL_A,
    );
    expect(
      threadMatchesFilterState(thread({ themeClusterId: "g-b" }), narrowed),
    ).toBe(true);
    expect(
      threadMatchesFilterState(thread({ themeClusterId: "g-a" }), narrowed),
    ).toBe(false);
  });

  it("drops an axis the new selection does not mention", () => {
    // Clicking one outcome theme after a link was open must not leave the old
    // sentiment chip behind, silently keeping a narrower filter than the
    // diagram shows as selected.
    const link = applySelection(EMPTY_USAGE_FILTER, LINK);
    const node = applySelection(
      link,
      { themes: [{ dimension: "outcome", clusterId: "o-2" }] },
      LINK,
    );
    expect(node.chips.map(chipKey)).toEqual(["cluster:outcome:o-2"]);
  });

  it("preserves chips from other dimensions and the preset", () => {
    const withSynthetic = toggleChip(
      { preset: "needs_review", chips: [] },
      { kind: "dimension", key: "synthetic", value: "hide" },
    );
    const next = applySelection(withSynthetic, GOAL_A);
    expect(next.chips.map(chipKey)).toContain("synthetic:hide");
    expect(next.chips.map(chipKey)).toContain("cluster:goal:g-a");
    expect(next.preset).toBe("needs_review");
  });
});

describe("withoutSelectionChips", () => {
  it("subtracts the open selection's own chips by identity", () => {
    // What keeps the diagram from filtering itself by its own output.
    const filter = applySelection(EMPTY_USAGE_FILTER, LINK);
    expect(withoutSelectionChips(filter, LINK).chips).toEqual([]);
  });

  it("leaves a goal chip some other surface wrote on the same axis", () => {
    // THE regression this guards. The topic map writes goal chips too, so
    // clearing the axis wholesale would throw away a community the user picked
    // on the map and silently widen the cohort. Only the open selection's own
    // chip may go.
    const fromMap = toggleChip(EMPTY_USAGE_FILTER, {
      kind: "cluster",
      clusterId: "g-from-map",
      dimension: "goal",
    });
    const withSelection = applySelection(fromMap, GOAL_A);
    expect(
      withoutSelectionChips(withSelection, GOAL_A).chips.map(chipKey),
    ).toEqual(["cluster:goal:g-from-map"]);
  });

  it("removes nothing when no selection is open", () => {
    const filter = applySelection(EMPTY_USAGE_FILTER, GOAL_A);
    expect(withoutSelectionChips(filter, null)).toBe(filter);
  });
});

describe("isSameSelection", () => {
  it("ignores theme order", () => {
    expect(isSameSelection(LINK, { themes: [...LINK.themes].reverse() })).toBe(
      true,
    );
  });

  it("separates selections on different axes", () => {
    expect(
      isSameSelection(
        { themes: [{ dimension: "goal", clusterId: "x" }] },
        { themes: [{ dimension: "behavior", clusterId: "x" }] },
      ),
    ).toBe(false);
  });

  it("handles null on either side", () => {
    expect(isSameSelection(null, null)).toBe(true);
    expect(isSameSelection(null, GOAL_A)).toBe(false);
  });
});

describe("theme chips are scoped per axis", () => {
  it("matches a theme against its own axis, not any other", () => {
    const t = thread({ themeClusterId: "c-goal", behaviorClusterId: "c-beh" });
    expect(
      threadMatchesChip(t, {
        kind: "cluster",
        clusterId: "c-beh",
        dimension: "behavior",
      }),
    ).toBe(true);
    // The same id read against the wrong axis must not match, or a behavior
    // click would silently select on the goal column.
    expect(
      threadMatchesChip(t, {
        kind: "cluster",
        clusterId: "c-beh",
        dimension: "goal",
      }),
    ).toBe(false);
  });

  it("treats a chip with no dimension as a goal chip", () => {
    // Back-compat: every chip written before the split, and every chip the
    // topic map still writes, means the goal axis.
    expect(
      threadMatchesChip(thread({ themeClusterId: "c-goal" }), {
        kind: "cluster",
        clusterId: "c-goal",
      }),
    ).toBe(true);
  });

  it("ANDs themes across axes and ORs them within one", () => {
    // A session has exactly one theme per axis, so two chips on the SAME axis
    // must widen — requiring both would match nothing at all.
    const onPath = thread({
      themeClusterId: "c-goal",
      behaviorClusterId: "c-beh",
    });
    const otherBehavior = thread({
      themeClusterId: "c-goal",
      behaviorClusterId: "c-other",
    });
    const crossAxis: UsageFilterState = {
      preset: "all",
      chips: [
        { kind: "cluster", clusterId: "c-goal", dimension: "goal" },
        { kind: "cluster", clusterId: "c-beh", dimension: "behavior" },
      ],
    };
    expect(threadMatchesFilterState(onPath, crossAxis)).toBe(true);
    expect(threadMatchesFilterState(otherBehavior, crossAxis)).toBe(false);

    const sameAxis: UsageFilterState = {
      preset: "all",
      chips: [
        { kind: "cluster", clusterId: "c-beh", dimension: "behavior" },
        { kind: "cluster", clusterId: "c-other", dimension: "behavior" },
      ],
    };
    expect(threadMatchesFilterState(onPath, sameAxis)).toBe(true);
    expect(threadMatchesFilterState(otherBehavior, sameAxis)).toBe(true);
  });

  it("reads each axis off its own field", () => {
    const t = thread({
      themeClusterId: "g",
      behaviorClusterId: "b",
      outcomeClusterId: "o",
      sentimentClusterId: "s",
    });
    expect(threadThemeId(t, "goal")).toBe("g");
    expect(threadThemeId(t, "behavior")).toBe("b");
    expect(threadThemeId(t, "outcome")).toBe("o");
    expect(threadThemeId(t, "sentiment")).toBe("s");
    expect(threadThemeId(thread({}), "behavior")).toBeUndefined();
  });
});

describe("enum facet chips still work alongside themes", () => {
  it("matches outcome by equality and never matches an absent one", () => {
    // The state layer is untouched by the theme layer: these chips still back
    // every rate, and the topic map's outcome tinting still reads them.
    expect(
      threadMatchesChip(thread({ outcome: "unresolved" }), {
        kind: "dimension",
        key: "outcome",
        value: "unresolved",
      }),
    ).toBe(true);
    expect(
      threadMatchesChip(thread({}), {
        kind: "dimension",
        key: "outcome",
        value: "unclear",
      }),
    ).toBe(false);
  });

  it("matches behaviorTag by array-contains", () => {
    const tagged = thread({ behaviorTags: ["retried", "errored_tool"] });
    expect(
      threadMatchesChip(tagged, {
        kind: "dimension",
        key: "behaviorTag",
        value: "errored_tool",
      }),
    ).toBe(true);
    expect(
      threadMatchesChip(tagged, {
        kind: "dimension",
        key: "behaviorTag",
        value: "looping",
      }),
    ).toBe(false);
  });

  it("matches friction and pathKey by equality", () => {
    const t = thread({ friction: "missing_capability", pathKey: "search→get" });
    expect(
      threadMatchesChip(t, {
        kind: "dimension",
        key: "friction",
        value: "missing_capability",
      }),
    ).toBe(true);
    expect(
      threadMatchesChip(t, {
        kind: "dimension",
        key: "pathKey",
        value: "search→get",
      }),
    ).toBe(true);
  });
});
