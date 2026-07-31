import { describe, expect, it } from "vitest";
import {
  EMPTY_USAGE_FILTER,
  UNLABELED_OUTCOME,
  chipKey,
  clearCellChips,
  isCellSelected,
  selectCell,
  threadMatchesChip,
  threadMatchesFilterState,
  toggleChip,
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

const CELL_A_UNRESOLVED = {
  clusterId: "cluster-a",
  clusterLabel: "Invoice lookup",
  outcome: "unresolved" as const,
};
const CELL_B_ERRORED = {
  clusterId: "cluster-b",
  clusterLabel: "Refunds",
  outcome: "errored" as const,
};

describe("selectCell", () => {
  it("selects one cell as a cluster chip plus an outcome chip", () => {
    const next = selectCell(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED);
    expect(next.chips.map(chipKey).sort()).toEqual([
      "cluster:cluster-a",
      "outcome:unresolved",
    ]);
  });

  it("NARROWS to exactly one cell when a second cell is clicked", () => {
    // The reason this is not two toggleChip calls. Chips OR within a dimension,
    // so toggling would leave two cluster chips and two outcome chips active —
    // matching four cells instead of the one the user clicked.
    const first = selectCell(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED);
    const second = selectCell(first, CELL_B_ERRORED);

    expect(second.chips.map(chipKey).sort()).toEqual([
      "cluster:cluster-b",
      "outcome:errored",
    ]);
    expect(isCellSelected(second, CELL_B_ERRORED)).toBe(true);
    expect(isCellSelected(second, CELL_A_UNRESOLVED)).toBe(false);
  });

  it("widens rather than narrows if toggleChip is used instead — the bug this avoids", () => {
    // Pinned as a contrast case: if a future refactor reaches for toggleChip
    // here, this documents concretely what goes wrong.
    let widened: UsageFilterState = EMPTY_USAGE_FILTER;
    for (const cell of [CELL_A_UNRESOLVED, CELL_B_ERRORED]) {
      widened = toggleChip(widened, {
        kind: "cluster",
        clusterId: cell.clusterId,
      });
      widened = toggleChip(widened, {
        kind: "dimension",
        key: "outcome",
        value: cell.outcome,
      });
    }

    // A session from cluster-a with the OTHER cell's outcome now matches,
    // which is a cell the user never clicked.
    const crossCell = thread({
      themeClusterId: "cluster-a",
      outcome: "errored",
    });
    expect(threadMatchesFilterState(crossCell, widened)).toBe(true);
    // selectCell does not have that problem.
    const narrowed = selectCell(
      selectCell(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED),
      CELL_B_ERRORED
    );
    expect(threadMatchesFilterState(crossCell, narrowed)).toBe(false);
  });

  it("clears the selection when the selected cell is clicked again", () => {
    const selected = selectCell(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED);
    const cleared = selectCell(selected, CELL_A_UNRESOLVED);
    expect(cleared.chips).toEqual([]);
    expect(isCellSelected(cleared, CELL_A_UNRESOLVED)).toBe(false);
  });

  it("preserves chips from other dimensions", () => {
    const withSynthetic = toggleChip(EMPTY_USAGE_FILTER, {
      kind: "dimension",
      key: "synthetic",
      value: "hide",
    });
    const next = selectCell(withSynthetic, CELL_A_UNRESOLVED);
    expect(next.chips.map(chipKey)).toContain("synthetic:hide");
    expect(next.chips.map(chipKey)).toContain("cluster:cluster-a");
  });

  it("preserves the preset", () => {
    const next = selectCell(
      { preset: "needs_review", chips: [] },
      CELL_A_UNRESOLVED
    );
    expect(next.preset).toBe("needs_review");
  });

  it("represents the not-analyzed cell with the unlabeled sentinel chip", () => {
    // The cell has to be expressible as a chip. A cluster chip ALONE would be a
    // wider filter — every outcome in that goal — so the drill-down and the
    // session list would disagree about what the user selected.
    const next = selectCell(EMPTY_USAGE_FILTER, {
      clusterId: "cluster-a",
      outcome: null,
    });
    expect(next.chips.map(chipKey).sort()).toEqual([
      "cluster:cluster-a",
      `outcome:${UNLABELED_OUTCOME}`,
    ]);
    expect(
      isCellSelected(next, { clusterId: "cluster-a", outcome: null })
    ).toBe(true);
  });

  it("narrows the session list to unanalyzed sessions for the not-analyzed cell", () => {
    // The point of the sentinel: the same filter that drives the drill-down
    // must also narrow the Sessions list and the map to the same rows.
    const filter = selectCell(EMPTY_USAGE_FILTER, {
      clusterId: "cluster-a",
      outcome: null,
    });
    const unanalyzed = thread({ themeClusterId: "cluster-a" });
    const analyzed = thread({
      themeClusterId: "cluster-a",
      outcome: "completed",
    });
    const unclear = thread({
      themeClusterId: "cluster-a",
      outcome: "unclear",
    });
    expect(threadMatchesFilterState(unanalyzed, filter)).toBe(true);
    expect(threadMatchesFilterState(analyzed, filter)).toBe(false);
    // `unclear` is a verdict, not an absence — it is a different cell.
    expect(threadMatchesFilterState(unclear, filter)).toBe(false);
  });

  it("matches only absence for the sentinel, and only the value otherwise", () => {
    expect(
      threadMatchesChip(thread({}), {
        kind: "dimension",
        key: "outcome",
        value: UNLABELED_OUTCOME,
      })
    ).toBe(true);
    expect(
      threadMatchesChip(thread({ outcome: "completed" }), {
        kind: "dimension",
        key: "outcome",
        value: UNLABELED_OUTCOME,
      })
    ).toBe(false);
  });

  it("does not confuse the not-analyzed cell with the unclear cell", () => {
    const notAnalyzed = selectCell(EMPTY_USAGE_FILTER, {
      clusterId: "cluster-a",
      outcome: null,
    });
    expect(
      isCellSelected(notAnalyzed, {
        clusterId: "cluster-a",
        outcome: "unclear",
      })
    ).toBe(false);

    const unclear = selectCell(EMPTY_USAGE_FILTER, {
      clusterId: "cluster-a",
      outcome: "unclear",
    });
    expect(
      isCellSelected(unclear, { clusterId: "cluster-a", outcome: null })
    ).toBe(false);
  });

  it("switches from the not-analyzed cell to a concrete outcome cell cleanly", () => {
    const notAnalyzed = selectCell(EMPTY_USAGE_FILTER, {
      clusterId: "cluster-a",
      outcome: null,
    });
    const concrete = selectCell(notAnalyzed, CELL_A_UNRESOLVED);
    expect(concrete.chips.map(chipKey).sort()).toEqual([
      "cluster:cluster-a",
      "outcome:unresolved",
    ]);
  });
});

describe("clearCellChips", () => {
  it("removes only the cluster and outcome chips", () => {
    const filter = selectCell(
      toggleChip(EMPTY_USAGE_FILTER, {
        kind: "dimension",
        key: "synthetic",
        value: "hide",
      }),
      CELL_A_UNRESOLVED
    );
    const cleared = clearCellChips(filter);
    expect(cleared.chips.map(chipKey)).toEqual(["synthetic:hide"]);
  });

  it("is what a re-click must use, so a hand-dismissed chip cannot come back", () => {
    // The divergence case: chips already dismissed by hand while the panel is
    // still open. Routing the close through selectCell's chip-derived toggle
    // would read the cell as unselected and re-ADD the chips while the panel
    // closes; clearCellChips cannot do that.
    const openButChipless = clearCellChips(
      selectCell(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED)
    );
    expect(clearCellChips(openButChipless).chips).toEqual([]);
    expect(selectCell(openButChipless, CELL_A_UNRESOLVED).chips).toHaveLength(
      2
    );
  });
});

describe("isCellSelected", () => {
  it("is false when two clusters are selected", () => {
    const widened = toggleChip(
      toggleChip(EMPTY_USAGE_FILTER, {
        kind: "cluster",
        clusterId: "cluster-a",
      }),
      { kind: "cluster", clusterId: "cluster-b" }
    );
    expect(
      isCellSelected(widened, {
        clusterId: "cluster-a",
        outcome: null,
      })
    ).toBe(false);
  });

  it("is false for an empty filter", () => {
    expect(isCellSelected(EMPTY_USAGE_FILTER, CELL_A_UNRESOLVED)).toBe(false);
  });
});

describe("goal-facet chip matching", () => {
  it("matches outcome by equality and never matches an absent one", () => {
    expect(
      threadMatchesChip(thread({ outcome: "unresolved" }), {
        kind: "dimension",
        key: "outcome",
        value: "unresolved",
      })
    ).toBe(true);
    // A thread with no recorded outcome is not in the `unclear` bucket.
    expect(
      threadMatchesChip(thread({}), {
        kind: "dimension",
        key: "outcome",
        value: "unclear",
      })
    ).toBe(false);
  });

  it("matches behaviorTag by array-contains", () => {
    const tagged = thread({ behaviorTags: ["retried", "errored_tool"] });
    expect(
      threadMatchesChip(tagged, {
        kind: "dimension",
        key: "behaviorTag",
        value: "errored_tool",
      })
    ).toBe(true);
    expect(
      threadMatchesChip(tagged, {
        kind: "dimension",
        key: "behaviorTag",
        value: "looping",
      })
    ).toBe(false);
    expect(
      threadMatchesChip(thread({}), {
        kind: "dimension",
        key: "behaviorTag",
        value: "retried",
      })
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
      })
    ).toBe(true);
    expect(
      threadMatchesChip(t, {
        kind: "dimension",
        key: "pathKey",
        value: "search→get",
      })
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
      })
    ).toBe(true);
  });
});
