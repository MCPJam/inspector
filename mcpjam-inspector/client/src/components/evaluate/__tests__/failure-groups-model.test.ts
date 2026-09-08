import { describe, expect, it } from "vitest";
import { NO_TOOL_PATH_KEY } from "@mcpjam/sdk/contract";

import {
  SANKEY_OTHER,
  SANKEY_UNLABELED,
  stageTotal,
} from "@/components/shared/usage-insights/insights-sankey";
import {
  FAILURE_FOLD_PER_STAGE,
  FAILURE_SANKEY_STAGES,
  UNJUDGED_REASON_LABEL,
  buildFailureSankey,
  failureGroupsHeader,
  flatReasonList,
  reasonCount,
  type FailureGroupMember,
  type SuiteFailureGroupsRow,
} from "../failure-groups-model";

function member(
  over: Partial<FailureGroupMember> &
    Pick<FailureGroupMember, "gradingKey" | "caseKey" | "pathKey">,
): FailureGroupMember {
  return {
    runId: "run_1",
    caseTitle: over.caseTitle ?? over.caseKey,
    ...over,
  };
}

function row(
  over: Partial<SuiteFailureGroupsRow> & { members: FailureGroupMember[] },
): SuiteFailureGroupsRow {
  return {
    suiteId: "suite_1",
    status: "completed",
    failedTrials: over.members.length,
    judgedFailedTrials: over.members.filter((m) => m.groupIndex !== undefined)
      .length,
    unjudgedFailedTrials: over.members.filter((m) => m.groupIndex === undefined)
      .length,
    grouped: true,
    k: 2,
    novelty: "notMeasured",
    groups: [
      { index: 0, label: "Skipped the lookup", memberCount: 1 },
      { index: 1, label: "Called a sibling", memberCount: 1 },
    ],
    ...over,
  };
}

function columnSum(
  sankey: ReturnType<typeof buildFailureSankey>,
  stage: (typeof FAILURE_SANKEY_STAGES)[number],
): number {
  return stageTotal(sankey, stage);
}

function adjacentOnly(sankey: ReturnType<typeof buildFailureSankey>): boolean {
  return sankey.links.every((link) => {
    const [from] = link.source.split(":");
    const [to] = link.target.split(":");
    return (
      (from === "case" && to === "route") ||
      (from === "route" && to === "reason")
    );
  });
}

describe("buildFailureSankey", () => {
  it("conserves flow in every column — one failed trial per ribbon", () => {
    const sankey = buildFailureSankey(
      row({
        members: [
          member({
            gradingKey: "a#1",
            caseKey: "case_a",
            caseTitle: "Look up a user",
            pathKey: "search→get",
            groupIndex: 0,
          }),
          member({
            gradingKey: "b#1",
            caseKey: "case_b",
            caseTitle: "Share a diagram",
            pathKey: NO_TOOL_PATH_KEY,
            groupIndex: 1,
          }),
          member({
            gradingKey: "a#2",
            caseKey: "case_a",
            caseTitle: "Look up a user",
            pathKey: "search→get",
          }),
        ],
      }),
    );

    expect(columnSum(sankey, "case")).toBe(3);
    expect(columnSum(sankey, "route")).toBe(3);
    expect(columnSum(sankey, "reason")).toBe(3);
    expect(
      sankey.links
        .filter((link) => link.source.startsWith("case:"))
        .reduce((sum, link) => sum + link.count, 0),
    ).toBe(3);
    expect(
      sankey.links
        .filter((link) => link.source.startsWith("route:"))
        .reduce((sum, link) => sum + link.count, 0),
    ).toBe(3);
    expect(adjacentOnly(sankey)).toBe(true);
    expect(
      sankey.links.every((link) => link.discordantCount === undefined),
    ).toBe(true);
  });

  it("maps an unjudged trial onto the unlabeled reason", () => {
    const sankey = buildFailureSankey(
      row({
        members: [
          member({
            gradingKey: "a#1",
            caseKey: "case_a",
            caseTitle: "Look up a user",
            pathKey: "search",
          }),
        ],
      }),
    );
    const unlabeled = sankey.nodes.find(
      (node) => node.stage === "reason" && node.key === SANKEY_UNLABELED,
    );
    expect(unlabeled).toMatchObject({
      label: UNJUDGED_REASON_LABEL,
      count: 1,
      clickable: false,
    });
  });

  it("labels no_tools as called nothing", () => {
    const sankey = buildFailureSankey(
      row({
        members: [
          member({
            gradingKey: "a#1",
            caseKey: "case_a",
            pathKey: NO_TOOL_PATH_KEY,
            groupIndex: 0,
          }),
        ],
      }),
    );
    expect(sankey.nodes.find((node) => node.stage === "route")?.label).toBe(
      "called nothing",
    );
  });

  it("folds a stage past 12 keys into SANKEY_OTHER and still conserves flow", () => {
    const members = Array.from({ length: FAILURE_FOLD_PER_STAGE + 3 }, (_, i) =>
      member({
        gradingKey: `c${i}#1`,
        caseKey: `case_${i}`,
        caseTitle: `Case ${i}`,
        pathKey: "search",
        groupIndex: 0,
      }),
    );
    const sankey = buildFailureSankey(row({ members }));
    const caseNodes = sankey.nodes.filter((node) => node.stage === "case");
    expect(caseNodes).toHaveLength(FAILURE_FOLD_PER_STAGE + 1);
    const other = caseNodes.find((node) => node.key === SANKEY_OTHER);
    expect(other?.count).toBe(3);
    expect(other?.clickable).toBe(false);
    expect(columnSum(sankey, "case")).toBe(members.length);
    expect(columnSum(sankey, "route")).toBe(members.length);
    expect(columnSum(sankey, "reason")).toBe(members.length);
    expect(sankey.foldedByStage?.case).toBe(3);
  });

  it("keeps a real key that spells a sentinel apart from the sentinel", () => {
    const sankey = buildFailureSankey(
      row({
        members: [
          member({
            gradingKey: "o#1",
            caseKey: SANKEY_OTHER,
            caseTitle: "A case whose key is __other__",
            pathKey: SANKEY_UNLABELED,
            groupIndex: 0,
          }),
          member({
            gradingKey: "u#1",
            caseKey: "case_b",
            caseTitle: "Share a diagram",
            pathKey: "search",
          }),
        ],
      }),
    );
    const caseNode = sankey.nodes.find(
      (node) =>
        node.stage === "case" && node.label === "A case whose key is __other__",
    );
    expect(caseNode).toBeDefined();
    expect(caseNode?.key).not.toBe(SANKEY_OTHER);
    expect(caseNode?.clickable).toBe(true);
    const routeNode = sankey.nodes.find(
      (node) => node.stage === "route" && node.label === SANKEY_UNLABELED,
    );
    expect(routeNode).toBeDefined();
    expect(routeNode?.key).not.toBe(SANKEY_UNLABELED);
    expect(routeNode?.clickable).toBe(true);
    // The true sentinel is still the only unjudged reason.
    const unjudged = sankey.nodes.filter(
      (node) => node.key === SANKEY_UNLABELED,
    );
    expect(unjudged).toHaveLength(1);
    expect(unjudged[0]).toMatchObject({ stage: "reason", count: 1 });
    expect(columnSum(sankey, "case")).toBe(2);
    expect(columnSum(sankey, "route")).toBe(2);
    expect(columnSum(sankey, "reason")).toBe(2);
  });
});

describe("flatReasonList", () => {
  it("lists reasons when clustering did not split", () => {
    const ungrouped = row({
      grouped: false,
      k: 1,
      members: [
        member({
          gradingKey: "a#1",
          caseKey: "case_a",
          pathKey: "search",
          groupIndex: 0,
        }),
        member({
          gradingKey: "b#1",
          caseKey: "case_b",
          pathKey: "search",
        }),
        member({
          gradingKey: "c#1",
          caseKey: "case_c",
          pathKey: NO_TOOL_PATH_KEY,
          groupIndex: 0,
        }),
      ],
    });
    expect(flatReasonList(ungrouped)).toEqual([
      { label: "Skipped the lookup", count: 2 },
      { label: UNJUDGED_REASON_LABEL, count: 1 },
    ]);
  });
});

describe("reasonCount", () => {
  it("counts the Not judged node when any member lacks a group", () => {
    const grouped = row({
      groups: [
        { index: 0, label: "A", memberCount: 1 },
        { index: 1, label: "B", memberCount: 1 },
      ],
      members: [
        member({
          gradingKey: "a#1",
          caseKey: "a",
          pathKey: "search",
          groupIndex: 0,
        }),
        member({
          gradingKey: "b#1",
          caseKey: "b",
          pathKey: "search",
          groupIndex: 1,
        }),
        member({ gradingKey: "c#1", caseKey: "c", pathKey: "search" }),
      ],
    });
    const sankey = buildFailureSankey(grouped);
    const drawn = sankey.nodes.filter((node) => node.stage === "reason").length;
    expect(reasonCount(grouped)).toBe(3);
    expect(reasonCount(grouped)).toBe(drawn);
  });

  it("counts the folded Other node once when groups fold past 12", () => {
    const groups = Array.from(
      { length: FAILURE_FOLD_PER_STAGE + 4 },
      (_, i) => ({
        index: i,
        label: `Reason ${i}`,
        memberCount: 1,
      }),
    );
    const members = groups.map((group, i) =>
      member({
        gradingKey: `m${i}#1`,
        caseKey: "case_a",
        pathKey: "search",
        groupIndex: group.index,
      }),
    );
    const folded = row({ groups, members });
    const drawn = buildFailureSankey(folded).nodes.filter(
      (node) => node.stage === "reason",
    );
    expect(drawn).toHaveLength(FAILURE_FOLD_PER_STAGE + 1);
    expect(reasonCount(folded)).toBe(drawn.length);
    expect(failureGroupsHeader(folded).summary).toBe(
      `${members.length} failed trials, ${FAILURE_FOLD_PER_STAGE + 1} reasons`,
    );
  });

  it("does not count a group whose members the row dropped", () => {
    const truncated = row({
      groups: [
        { index: 0, label: "A", memberCount: 1 },
        { index: 1, label: "B", memberCount: 1 },
        { index: 2, label: "C", memberCount: 1 },
      ],
      memberTruncation: { dropped: 1 },
      members: [
        member({
          gradingKey: "a#1",
          caseKey: "a",
          pathKey: "s",
          groupIndex: 0,
        }),
        member({
          gradingKey: "b#1",
          caseKey: "b",
          pathKey: "s",
          groupIndex: 1,
        }),
      ],
    });
    const drawn = buildFailureSankey(truncated).nodes.filter(
      (node) => node.stage === "reason",
    );
    expect(drawn).toHaveLength(2);
    expect(reasonCount(truncated)).toBe(2);
  });

  it("matches the groups when every member was judged", () => {
    expect(
      reasonCount(
        row({
          members: [
            member({
              gradingKey: "a#1",
              caseKey: "a",
              pathKey: "s",
              groupIndex: 0,
            }),
            member({
              gradingKey: "b#1",
              caseKey: "b",
              pathKey: "s",
              groupIndex: 1,
            }),
          ],
        }),
      ),
    ).toBe(2);
  });
});

describe("failureGroupsHeader", () => {
  it("says how many members were not drawn when the row was truncated", () => {
    const header = failureGroupsHeader(
      row({
        failedTrials: 60,
        memberTruncation: { dropped: 10 },
        members: [
          member({
            gradingKey: "a#1",
            caseKey: "a",
            pathKey: "s",
            groupIndex: 0,
          }),
          member({
            gradingKey: "b#1",
            caseKey: "b",
            pathKey: "s",
            groupIndex: 1,
          }),
        ],
      }),
    );
    expect(header.summary).toBe(
      "60 failed trials, 2 reasons · 10 more not drawn",
    );
    expect(header.summary).not.toContain("\n");
  });

  it("omits the novelty chip when novelty was not measured", () => {
    const header = failureGroupsHeader(
      row({
        failedTrials: 14,
        novelty: "notMeasured",
        groups: [
          { index: 0, label: "A", memberCount: 5 },
          { index: 1, label: "B", memberCount: 5 },
          { index: 2, label: "C", memberCount: 4 },
        ],
        // One member per group: the header counts the reason nodes drawn,
        // and a group with no member in the row draws none.
        members: [
          member({
            gradingKey: "a#1",
            caseKey: "a",
            pathKey: "search",
            groupIndex: 0,
            novel: true,
          }),
          member({
            gradingKey: "b#1",
            caseKey: "b",
            pathKey: "search",
            groupIndex: 1,
          }),
          member({
            gradingKey: "c#1",
            caseKey: "c",
            pathKey: "search",
            groupIndex: 2,
          }),
        ],
      }),
    );
    expect(header.summary).toBe("14 failed trials, 3 reasons");
    expect(header.noveltyLabel).toBeNull();
  });

  it("adds the novelty chip only when measured", () => {
    const header = failureGroupsHeader(
      row({
        failedTrials: 14,
        novelty: "measured",
        groups: [
          { index: 0, label: "A", memberCount: 5 },
          { index: 1, label: "B", memberCount: 5 },
          { index: 2, label: "C", memberCount: 4 },
        ],
        // One member per group: the header counts the reason nodes drawn,
        // and a group with no member in the row draws none.
        members: [
          member({
            gradingKey: "a#1",
            caseKey: "a",
            pathKey: "search",
            groupIndex: 0,
            novel: true,
          }),
          member({
            gradingKey: "b#1",
            caseKey: "b",
            pathKey: "search",
            groupIndex: 1,
          }),
          member({
            gradingKey: "c#1",
            caseKey: "c",
            pathKey: "search",
            groupIndex: 2,
          }),
        ],
      }),
    );
    expect(header.summary).toBe("14 failed trials, 3 reasons");
    expect(header.noveltyLabel).toBe("1 new");
  });
});
