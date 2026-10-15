import { describe, expect, it } from "vitest";
import { comparisonKey } from "@mcpjam/sdk/browser";
import { formatWaveModelLabel, waveTargets } from "../swarm-overview-panel";
import type { SwarmOverviewRun } from "@/lib/swarm-api";

const SONNET = "anthropic/claude-sonnet-5.5";
const key = (reasoningEffort: "low" | "high") =>
  comparisonKey({
    modelId: SONNET,
    source: "hosted",
    settings: { reasoningEffort },
    fallback: { provider: "none", model: "none" },
  });

const runWith = (targets: SwarmOverviewRun["targets"]) =>
  ({ targets } as unknown as SwarmOverviewRun);

describe("swarm wave targets by targetKey", () => {
  it("two efforts of one model on one client are two targets", () => {
    const targets = waveTargets([
      runWith([
        { hostName: "Claude", modelId: SONNET, targetKey: key("low") },
        { hostName: "Claude", modelId: SONNET, targetKey: key("high") },
      ]),
      runWith([{ hostName: "Claude", modelId: SONNET, targetKey: key("low") }]),
    ]);
    expect(targets).toHaveLength(2);
    expect(formatWaveModelLabel(targets)).toMatch(/ · Low \+1$/);
  });

  it("default targets dedupe and label exactly as before", () => {
    const targets = waveTargets([
      runWith([{ hostName: "Claude", modelId: SONNET }]),
      runWith([{ hostName: "Claude", modelId: SONNET, targetKey: SONNET }]),
    ]);
    expect(targets).toHaveLength(1);
    expect(formatWaveModelLabel(targets)).not.toContain("·");
  });
});
