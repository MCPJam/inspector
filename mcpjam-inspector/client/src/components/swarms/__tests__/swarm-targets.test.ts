import { describe, expect, it } from "vitest";
import {
  buildSwarmRunTargets,
  buildUnrunJourneyTargets,
  findTargetCellForChatSessionId,
  snapshotTargetModelLabels,
  summaryTargetKey,
} from "../swarm-targets";

const hostName = (id: string) => (id === "hostA" ? "Alpha" : id.slice(0, 8));

describe("summaryTargetKey", () => {
  it("keys env rows by targetId, legacy rows by hostId, and collapses host-shaped ids", () => {
    expect(summaryTargetKey({ hostId: "hostA" })).toBe("hostA");
    expect(summaryTargetKey({ hostId: "hostA", targetId: "host:hostA" })).toBe(
      "hostA",
    );
    expect(
      summaryTargetKey({ hostId: "hostA", targetId: "environment:e1" }),
    ).toBe("environment:e1");
  });
});

describe("buildSwarmRunTargets", () => {
  it("two same-host env targets → distinct columns, env-name labels, #n on collisions", () => {
    const targets = buildSwarmRunTargets({
      hostSummaries: [
        { hostId: "hostA", targetId: "environment:e1" },
        { hostId: "hostA", targetId: "environment:e2" },
      ],
      snapshotHosts: [
        {
          hostId: "hostA",
          targetId: "environment:e1",
          environmentRef: { environmentId: "e1", name: "Prod", revision: 1 },
        },
        {
          hostId: "hostA",
          targetId: "environment:e2",
          environmentRef: { environmentId: "e2", name: "Prod", revision: 2 },
        },
      ],
      hostName,
    });
    expect(targets.map((t) => t.key)).toEqual([
      "environment:e1",
      "environment:e2",
    ]);
    expect(targets.map((t) => t.label)).toEqual(["Prod #1", "Prod #2"]);
    expect(targets.map((t) => t.identity)).toEqual([
      { hostId: "hostA", environmentId: "e1" },
      { hostId: "hostA", environmentId: "e2" },
    ]);
  });

  it("legacy summaries (host-shaped or absent targetId) key by hostId with host-name labels", () => {
    const targets = buildSwarmRunTargets({
      hostSummaries: [
        { hostId: "hostA", targetId: "host:hostA" },
        { hostId: "hostB" },
      ],
      snapshotHosts: [{ hostId: "hostA", targetId: "host:hostA" }],
      hostName,
    });
    expect(targets.map((t) => t.key)).toEqual(["hostA", "hostB"]);
    expect(targets[0]!.label).toBe("Alpha");
    expect(targets[0]!.identity).toEqual({ hostId: "hostA" });
  });
});

describe("swarm target models with effort", () => {
  const hosted = (effort?: "low" | "high") => ({
    modelId: "openai/gpt-5.4-nano",
    source: "hosted" as const,
    fallback: { provider: "none" as const, model: "none" as const },
    ...(effort ? { settings: { reasoningEffort: effort } } : {}),
  });
  const snapshotHosts = [
    { hostId: "h1", hostName: "MCPJam", targetId: "t-low", modelId: "openai/gpt-5.4-nano", resolvedSelection: hosted("low") },
    { hostId: "h1", hostName: "MCPJam", targetId: "t-high", modelId: "openai/gpt-5.4-nano", resolvedSelection: hosted("high") },
  ];

  it("labels each target's model with its effort", () => {
    const labels = snapshotTargetModelLabels(snapshotHosts);
    expect(snapshotHosts.map((host) => labels.get(host))).toEqual([
      "gpt-5.4-nano · Low",
      "gpt-5.4-nano · High",
    ]);
  });

  it("tells two targets of one client apart by model, not #n", () => {
    const columns = buildSwarmRunTargets({
      hostSummaries: [
        { hostId: "h1", targetId: "t-low" },
        { hostId: "h1", targetId: "t-high" },
      ],
      snapshotHosts,
      hostName: () => "MCPJam",
    });
    expect(columns.map((column) => column.label)).toEqual([
      "MCPJam · gpt-5.4-nano · Low",
      "MCPJam · gpt-5.4-nano · High",
    ]);
    expect(columns.map((column) => column.model)).toEqual([
      "gpt-5.4-nano · Low",
      "gpt-5.4-nano · High",
    ]);
  });
});

describe("buildUnrunJourneyTargets", () => {
  it("env-based journey: environmentIds order, env labels, host from the live env", () => {
    const targets = buildUnrunJourneyTargets({
      hostIds: ["hostA"],
      environmentIds: ["e2", "e1"],
      environments: [
        { environmentId: "e1", projectId: "p", name: "One", hostId: "hostA", revision: 1 },
        { environmentId: "e2", projectId: "p", name: "Two", hostId: "hostA", revision: 1 },
      ],
      hostName,
    });
    expect(targets.map((t) => t.label)).toEqual(["Two", "One"]);
    expect(targets.map((t) => t.key)).toEqual([
      "environment:e2",
      "environment:e1",
    ]);
  });

  it("legacy journey: hostIds order", () => {
    const targets = buildUnrunJourneyTargets({
      hostIds: ["hostB", "hostA"],
      hostName,
    });
    expect(targets.map((t) => t.key)).toEqual(["hostB", "hostA"]);
  });
});

describe("findTargetCellForChatSessionId", () => {
  it("restores the (target, sessionIndex) cell by minted-id membership", () => {
    const targets = buildSwarmRunTargets({
      hostSummaries: [
        { hostId: "hostA", targetId: "environment:e1" },
        { hostId: "hostA", targetId: "environment:e2" },
      ],
      snapshotHosts: [
        {
          hostId: "hostA",
          targetId: "environment:e1",
          environmentRef: { environmentId: "e1", name: "A", revision: 1 },
        },
        {
          hostId: "hostA",
          targetId: "environment:e2",
          environmentRef: { environmentId: "e2", name: "B", revision: 1 },
        },
      ],
      hostName,
    });
    const cell = findTargetCellForChatSessionId({
      runId: "run-1",
      targets,
      sessionsPerTarget: 3,
      chatSessionId: "synth_run-1_env_e2_2",
    });
    expect(cell?.target.key).toBe("environment:e2");
    expect(cell?.sessionIndex).toBe(2);
    expect(
      findTargetCellForChatSessionId({
        runId: "run-1",
        targets,
        sessionsPerTarget: 3,
        chatSessionId: "synth_run-1_env_unknown_0",
      }),
    ).toBeNull();
  });
});
