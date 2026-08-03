import { describe, expect, it } from "vitest";
import {
  EMPTY_USAGE_FILTER,
  UNLABELED_OUTCOME,
  UNLABELED_VALUE,
  applySelection,
  chipKey,
  clearSelectionChips,
  isSameSelection,
  isSelectionSelected,
  primaryBehaviorTag,
  threadMatchesChip,
  threadMatchesFilterState,
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

/** The old goal × outcome cell, which is now just a two-stage selection. */
const CELL_A_UNRESOLVED: InsightsSelection = {
  goal: { clusterId: "cluster-a", label: "Invoice lookup" },
  outcome: "unresolved",
};
const CELL_B_ERRORED: InsightsSelection = {
  goal: { clusterId: "cluster-b", label: "Refunds" },
  outcome: "errored",
};

describe("applySelection", () => {
  it("selects a goal × outcome pair as a cluster chip plus an outcome chip", () => {
    const next = applySelection(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED);
    expect(next.chips.map(chipKey).sort()).toEqual([
      "cluster:cluster-a",
      "outcome:unresolved",
    ]);
  });

  it("selects a single node as one chip", () => {
    const next = applySelection(EMPTY_USAGE_FILTER, {
      sentiment: "frustrated",
    });
    expect(next.chips.map(chipKey)).toEqual(["sentiment:frustrated"]);
  });

  it("selects a link as both endpoints, ANDed across the two dimensions", () => {
    const next = applySelection(EMPTY_USAGE_FILTER, {
      outcome: "completed",
      sentiment: "frustrated",
    });
    expect(next.chips.map(chipKey).sort()).toEqual([
      "outcome:completed",
      "sentiment:frustrated",
    ]);
    expect(
      threadMatchesFilterState(
        thread({ outcome: "completed", sentiment: "frustrated" }),
        next,
      ),
    ).toBe(true);
    expect(
      threadMatchesFilterState(
        thread({ outcome: "completed", sentiment: "satisfied" }),
        next,
      ),
    ).toBe(false);
  });

  it("NARROWS to exactly one selection when a second is applied", () => {
    // The reason this is not a series of toggleChip calls. Chips OR within a
    // dimension, so toggling would leave two cluster chips and two outcome
    // chips active — matching four flows instead of the one the user clicked.
    const first = applySelection(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED);
    const second = applySelection(first, CELL_B_ERRORED);

    expect(second.chips.map(chipKey).sort()).toEqual([
      "cluster:cluster-b",
      "outcome:errored",
    ]);
    expect(isSelectionSelected(second, CELL_B_ERRORED)).toBe(true);
    expect(isSelectionSelected(second, CELL_A_UNRESOLVED)).toBe(false);
  });

  it("widens rather than narrows if toggleChip is used instead — the bug this avoids", () => {
    // Pinned as a contrast case: if a future refactor reaches for toggleChip
    // here, this documents concretely what goes wrong.
    let widened: UsageFilterState = EMPTY_USAGE_FILTER;
    for (const cell of [CELL_A_UNRESOLVED, CELL_B_ERRORED]) {
      widened = toggleChip(widened, {
        kind: "cluster",
        clusterId: cell.goal!.clusterId,
      });
      widened = toggleChip(widened, {
        kind: "dimension",
        key: "outcome",
        value: cell.outcome as string,
      });
    }

    // A session from cluster-a with the OTHER selection's outcome now matches,
    // which is a flow the user never clicked.
    const crossCell = thread({
      themeClusterId: "cluster-a",
      outcome: "errored",
    });
    expect(threadMatchesFilterState(crossCell, widened)).toBe(true);
    // applySelection does not have that problem.
    const narrowed = applySelection(
      applySelection(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED),
      CELL_B_ERRORED,
    );
    expect(threadMatchesFilterState(crossCell, narrowed)).toBe(false);
  });

  it("replaces a stage that the new selection does not mention", () => {
    // Clicking an outcome node after a link was open must not leave the old
    // sentiment chip behind, silently keeping a narrower filter than the
    // diagram shows as selected.
    const link = applySelection(EMPTY_USAGE_FILTER, {
      outcome: "completed",
      sentiment: "frustrated",
    });
    const node = applySelection(link, { outcome: "errored" });
    expect(node.chips.map(chipKey)).toEqual(["outcome:errored"]);
  });

  it("preserves chips from other dimensions", () => {
    const withSynthetic = toggleChip(EMPTY_USAGE_FILTER, {
      kind: "dimension",
      key: "synthetic",
      value: "hide",
    });
    const next = applySelection(withSynthetic, CELL_A_UNRESOLVED);
    expect(next.chips.map(chipKey)).toContain("synthetic:hide");
    expect(next.chips.map(chipKey)).toContain("cluster:cluster-a");
  });

  it("preserves the preset", () => {
    const next = applySelection(
      { preset: "needs_review", chips: [] },
      CELL_A_UNRESOLVED,
    );
    expect(next.preset).toBe("needs_review");
  });

  it("represents an unlabeled node with the sentinel chip", () => {
    // The node has to be expressible as a chip. Omitting it would be a WIDER
    // filter, so the drill-down and the session list would disagree about what
    // the user selected.
    const next = applySelection(EMPTY_USAGE_FILTER, {
      goal: { clusterId: "cluster-a" },
      outcome: null,
    });
    expect(next.chips.map(chipKey).sort()).toEqual([
      "cluster:cluster-a",
      `outcome:${UNLABELED_OUTCOME}`,
    ]);
    expect(
      isSelectionSelected(next, {
        goal: { clusterId: "cluster-a" },
        outcome: null,
      }),
    ).toBe(true);
  });

  it("narrows the session list to unanalyzed sessions for an unlabeled node", () => {
    // The point of the sentinel: the same filter that drives the drill-down
    // must also narrow the Sessions list and the map to the same rows.
    const filter = applySelection(EMPTY_USAGE_FILTER, {
      goal: { clusterId: "cluster-a" },
      outcome: null,
    });
    const unanalyzed = thread({ themeClusterId: "cluster-a" });
    const analyzed = thread({
      themeClusterId: "cluster-a",
      outcome: "completed",
    });
    const unclear = thread({ themeClusterId: "cluster-a", outcome: "unclear" });
    expect(threadMatchesFilterState(unanalyzed, filter)).toBe(true);
    expect(threadMatchesFilterState(analyzed, filter)).toBe(false);
    // `unclear` is a verdict, not an absence — it is a different node.
    expect(threadMatchesFilterState(unclear, filter)).toBe(false);
  });

  it("does not confuse an unlabeled node with an unclear one", () => {
    const notAnalyzed = applySelection(EMPTY_USAGE_FILTER, { outcome: null });
    expect(isSelectionSelected(notAnalyzed, { outcome: "unclear" })).toBe(
      false,
    );

    const unclear = applySelection(EMPTY_USAGE_FILTER, { outcome: "unclear" });
    expect(isSelectionSelected(unclear, { outcome: null })).toBe(false);
  });

  it("keeps an unlabeled sentiment distinct from an unclear one", () => {
    const filter = applySelection(EMPTY_USAGE_FILTER, { sentiment: null });
    expect(threadMatchesFilterState(thread({}), filter)).toBe(true);
    expect(
      threadMatchesFilterState(thread({ sentiment: "unclear" }), filter),
    ).toBe(false);
  });
});

describe("clearSelectionChips", () => {
  it("removes the cluster and every stage dimension, and nothing else", () => {
    const filter = applySelection(
      toggleChip(EMPTY_USAGE_FILTER, {
        kind: "dimension",
        key: "synthetic",
        value: "hide",
      }),
      {
        goal: { clusterId: "cluster-a" },
        behavior: "looping",
        sentiment: null,
      },
    );
    expect(clearSelectionChips(filter).chips.map(chipKey)).toEqual([
      "synthetic:hide",
    ]);
  });

  it("is what a re-click must use, so a hand-dismissed chip cannot come back", () => {
    // The divergence case: chips already dismissed by hand while the panel is
    // still open. Routing the close through a chip-derived toggle would read
    // the selection as unselected and re-ADD the chips while the panel closes.
    const openButChipless = clearSelectionChips(
      applySelection(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED),
    );
    expect(clearSelectionChips(openButChipless).chips).toEqual([]);
    expect(
      applySelection(openButChipless, CELL_A_UNRESOLVED).chips,
    ).toHaveLength(2);
  });
});

describe("withoutSelectionChips", () => {
  it("subtracts the open selection's own chips by identity", () => {
    // What keeps the diagram from filtering itself by its own output.
    const filter = applySelection(EMPTY_USAGE_FILTER, {
      outcome: "errored",
      sentiment: "frustrated",
    });
    expect(
      withoutSelectionChips(filter, {
        outcome: "errored",
        sentiment: "frustrated",
      }).chips,
    ).toEqual([]);
  });

  it("leaves a cluster chip that some other surface wrote", () => {
    // The topic map writes cluster chips too. Clearing the dimension wholesale
    // would throw away a community the user picked on the map, and the diagram
    // would stop honoring it.
    const fromMap = toggleChip(EMPTY_USAGE_FILTER, {
      kind: "cluster",
      clusterId: "cluster-from-map",
    });
    const withSelection = { ...fromMap, chips: [...fromMap.chips] };
    expect(
      withoutSelectionChips(withSelection, { outcome: "errored" }).chips.map(
        chipKey,
      ),
    ).toEqual(["cluster:cluster-from-map"]);
  });

  it("removes nothing when no selection is open", () => {
    const filter = applySelection(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED);
    expect(withoutSelectionChips(filter, null)).toBe(filter);
  });
});

describe("isSameSelection", () => {
  it("treats structurally equal selections as the same", () => {
    expect(
      isSameSelection(
        { outcome: "completed", sentiment: "frustrated" },
        { sentiment: "frustrated", outcome: "completed" },
      ),
    ).toBe(true);
  });

  it("separates an unlabeled stage from an unselected one", () => {
    expect(isSameSelection({ outcome: null }, {})).toBe(false);
  });

  it("handles null on either side", () => {
    expect(isSameSelection(null, null)).toBe(true);
    expect(isSameSelection(null, { outcome: "errored" })).toBe(false);
  });
});

describe("isSelectionSelected", () => {
  it("is false when the filter is wider than the selection", () => {
    const widened = toggleChip(
      toggleChip(EMPTY_USAGE_FILTER, {
        kind: "cluster",
        clusterId: "cluster-a",
      }),
      { kind: "cluster", clusterId: "cluster-b" },
    );
    expect(
      isSelectionSelected(widened, { goal: { clusterId: "cluster-a" } }),
    ).toBe(false);
  });

  it("is false for an empty filter", () => {
    expect(isSelectionSelected(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED)).toBe(
      false,
    );
  });
});

describe("primaryBehavior chip matching", () => {
  it("mirrors the server's priority collapse", () => {
    expect(primaryBehaviorTag(["retried", "looping"])).toBe("looping");
    expect(primaryBehaviorTag([])).toBeNull();
    expect(primaryBehaviorTag(undefined)).toBeNull();
  });

  it("matches the collapsed value, not the tag array", () => {
    // The distinction from `behaviorTag`: this thread IS tagged retried, but its
    // primary behavior is looping, so a click on the looping node must not also
    // select it under retried.
    const looper = thread({ behaviorTags: ["retried", "looping"] });
    expect(
      threadMatchesChip(looper, {
        kind: "dimension",
        key: "primaryBehavior",
        value: "looping",
      }),
    ).toBe(true);
    expect(
      threadMatchesChip(looper, {
        kind: "dimension",
        key: "primaryBehavior",
        value: "retried",
      }),
    ).toBe(false);
    // The array-contains dimension still sees both — a different question.
    expect(
      threadMatchesChip(looper, {
        kind: "dimension",
        key: "behaviorTag",
        value: "retried",
      }),
    ).toBe(true);
  });

  it("selects untagged threads with the sentinel", () => {
    expect(
      threadMatchesChip(thread({}), {
        kind: "dimension",
        key: "primaryBehavior",
        value: UNLABELED_VALUE,
      }),
    ).toBe(true);
    expect(
      threadMatchesChip(thread({ behaviorTags: ["no_tools"] }), {
        kind: "dimension",
        key: "primaryBehavior",
        value: UNLABELED_VALUE,
      }),
    ).toBe(false);
  });
});

describe("goal-facet chip matching", () => {
  it("matches outcome by equality and never matches an absent one", () => {
    expect(
      threadMatchesChip(thread({ outcome: "unresolved" }), {
        kind: "dimension",
        key: "outcome",
        value: "unresolved",
      }),
    ).toBe(true);
    // A thread with no recorded outcome is not in the `unclear` bucket.
    expect(
      threadMatchesChip(thread({}), {
        kind: "dimension",
        key: "outcome",
        value: "unclear",
      }),
    ).toBe(false);
  });

  it("matches sentiment by equality and never matches an absent one", () => {
    expect(
      threadMatchesChip(thread({ sentiment: "gave_up" }), {
        kind: "dimension",
        key: "sentiment",
        value: "gave_up",
      }),
    ).toBe(true);
    expect(
      threadMatchesChip(thread({}), {
        kind: "dimension",
        key: "sentiment",
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
    expect(
      threadMatchesChip(thread({}), {
        kind: "dimension",
        key: "behaviorTag",
        value: "retried",
      }),
    ).toBe(false);
  });

  it("matches friction and pathKey by equality", () => {
    const t = thread({
      friction: "missing_capability",
      pathKey: "search→get",
    });
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

  it("ORs multiple behaviorTag chips within the dimension", () => {
    const t = thread({ behaviorTags: ["looping"] });
    expect(
      threadMatchesFilterState(t, {
        preset: "all",
        chips: [
          { kind: "dimension", key: "behaviorTag", value: "retried" },
          { kind: "dimension", key: "behaviorTag", value: "looping" },
        ],
      }),
    ).toBe(true);
  });
});
