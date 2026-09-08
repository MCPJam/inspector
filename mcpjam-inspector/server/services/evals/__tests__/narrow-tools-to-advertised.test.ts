import { describe, expect, it } from "vitest";
import { narrowToolsToAdvertised } from "../../evals-runner";
import {
  createDiscoveryState,
  META_TOOL_LOAD,
  META_TOOL_SEARCH,
  type ProgressiveToolPlan,
  type ToolCatalogEntry,
} from "@/shared/progressive-tool-discovery";

// D7 P1 fix: `prepared.allTools` is always the FULL tool registry —
// prepareChatV2 builds it before any step runs. When progressive discovery
// is enabled, the model is only ever shown `resolveActiveToolNames(plan,
// discoveryState)` per step. Passing the unnarrowed registry into D7's
// selection-tool-catalog would let the judge see (and blame) metadata for a
// tool the model never had a chance to read — this suite pins the fix that
// closes that gap.

function catalogEntry(toolId: string, modelName: string): ToolCatalogEntry {
  return {
    toolId,
    modelName,
    serverId: "srv",
    originalName: modelName,
    fields: [],
    inputSchema: {},
    tokenEstimate: 10,
  };
}

function plan(
  catalog: ToolCatalogEntry[],
  enabled = true
): ProgressiveToolPlan {
  return {
    enabled,
    reasons: [],
    policy: {
      thresholdPct: 3,
      maxToolTokens: 10_000,
      maxToolCount: 30,
      searchLimit: 5,
    },
    catalog,
    totalTokenEstimate: 0,
  };
}

const allTools = {
  get_weather: { description: "weather" },
  delete_all_files: { description: "deletes files" },
  unrelated_tool: { description: "never touched" },
  [META_TOOL_SEARCH]: { description: "search meta-tool" },
  [META_TOOL_LOAD]: { description: "load meta-tool" },
} as any;

describe("narrowToolsToAdvertised", () => {
  it("returns allTools unchanged when progressive discovery is disabled", () => {
    const state = createDiscoveryState();
    const result = narrowToolsToAdvertised(allTools, plan([], false), state);
    expect(result).toBe(allTools);
  });

  it("drops a tool the model was never shown when discovery is enabled", () => {
    const catalog = [
      catalogEntry("srv::get_weather", "get_weather"),
      catalogEntry("srv::delete_all_files", "delete_all_files"),
      catalogEntry("srv::unrelated_tool", "unrelated_tool"),
    ];
    const state = createDiscoveryState();
    // Only the tool the model actually called got loaded — `get_weather`
    // (the expected tool it missed) was never shown to it.
    state.loadedToolIds.add("srv::delete_all_files");

    const result = narrowToolsToAdvertised(allTools, plan(catalog), state);

    expect(Object.keys(result).sort()).toEqual(
      [META_TOOL_LOAD, META_TOOL_SEARCH, "delete_all_files"].sort()
    );
    expect(result).not.toHaveProperty("get_weather");
    expect(result).not.toHaveProperty("unrelated_tool");
  });

  it("keeps a tool that is only in the newly-loaded staging set", () => {
    const catalog = [catalogEntry("srv::get_weather", "get_weather")];
    const state = createDiscoveryState();
    state.newlyLoadedToolIds.add("srv::get_weather");

    const result = narrowToolsToAdvertised(allTools, plan(catalog), state);

    expect(result).toHaveProperty("get_weather");
  });

  it("keeps every tool once all of them have been loaded across the turn", () => {
    const catalog = [
      catalogEntry("srv::get_weather", "get_weather"),
      catalogEntry("srv::delete_all_files", "delete_all_files"),
      catalogEntry("srv::unrelated_tool", "unrelated_tool"),
    ];
    const state = createDiscoveryState();
    state.loadedToolIds.add("srv::get_weather");
    state.loadedToolIds.add("srv::delete_all_files");
    state.loadedToolIds.add("srv::unrelated_tool");

    const result = narrowToolsToAdvertised(allTools, plan(catalog), state);

    expect(Object.keys(result).sort()).toEqual(Object.keys(allTools).sort());
  });
});
