import { describe, it, expect } from "vitest";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  buildToolCatalog,
  commitNewlyLoaded,
  createDiscoveryState,
  decideProgressivePlan,
  estimateTokens,
  lookupToolIdByModelName,
  META_TOOL_LOAD,
  META_TOOL_NAMES,
  META_TOOL_SEARCH,
  parseProgressiveToolsEnv,
  resolveActiveToolNames,
  searchToolCatalog,
  sumCatalogTokens,
} from "../progressive-tool-discovery.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeMcpTool(opts: {
  description?: string;
  serverId?: string;
  fields?: Record<string, { type: string; required?: boolean; desc?: string }>;
}) {
  const fields = opts.fields ?? {};
  const required: string[] = [];
  const properties: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(fields)) {
    properties[name] = {
      type: spec.type,
      ...(spec.desc ? { description: spec.desc } : {}),
    };
    if (spec.required) required.push(name);
  }
  const jsonSchema = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
  return {
    description: opts.description,
    parameters: { jsonSchema },
    _serverId: opts.serverId,
    execute: async () => ({}),
  };
}

function makeCatalogWithCount(count: number, serverId = "srv"): ToolSet {
  const result: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    result[`tool_${i}`] = makeMcpTool({
      description: `tool ${i}`,
      serverId,
      fields: { input: { type: "string" } },
    });
  }
  return result as unknown as ToolSet;
}

// ---------------------------------------------------------------------------
// catalog construction
// ---------------------------------------------------------------------------

describe("buildToolCatalog", () => {
  it("derives toolId from server id + original name", () => {
    const tools: ToolSet = {
      get_user: makeMcpTool({
        description: "Fetch a user by id",
        serverId: "asana",
        fields: { userId: { type: "string", required: true } },
      }),
    } as unknown as ToolSet;
    const catalog = buildToolCatalog(tools);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].toolId).toBe("asana::get_user");
    expect(catalog[0].serverId).toBe("asana");
    expect(catalog[0].modelName).toBe("get_user");
    expect(catalog[0].fields).toEqual([
      { name: "userId", type: "string", required: true },
    ]);
  });

  it("falls back to local:: prefix when no server id is attached", () => {
    const tools: ToolSet = {
      loadSkill: tool({
        description: "Load a skill",
        inputSchema: z.object({ name: z.string() }),
        execute: async () => "ok",
      }),
    } as unknown as ToolSet;
    const catalog = buildToolCatalog(tools);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].serverId).toBeNull();
    expect(catalog[0].toolId).toBe("local::loadSkill");
  });

  it("skips meta-tool entries even when present in the ToolSet", () => {
    const tools: ToolSet = {
      [META_TOOL_SEARCH]: makeMcpTool({ description: "x" }),
      [META_TOOL_LOAD]: makeMcpTool({ description: "y" }),
      real_tool: makeMcpTool({ description: "z", serverId: "s" }),
    } as unknown as ToolSet;
    const catalog = buildToolCatalog(tools);
    expect(catalog.map((e) => e.modelName)).toEqual(["real_tool"]);
  });

  it("summarizes required vs optional fields", () => {
    const tools: ToolSet = {
      complex: makeMcpTool({
        serverId: "s",
        fields: {
          a: { type: "string", required: true },
          b: { type: "number" },
          c: { type: "boolean", required: true, desc: "flag" },
        },
      }),
    } as unknown as ToolSet;
    const [entry] = buildToolCatalog(tools);
    expect(entry.fields).toEqual([
      { name: "a", type: "string", required: true },
      { name: "b", type: "number", required: false },
      {
        name: "c",
        type: "boolean",
        required: true,
        description: "flag",
      },
    ]);
  });

  it("emits non-zero token estimates per entry", () => {
    const tools: ToolSet = {
      a: makeMcpTool({
        description: "alpha tool",
        serverId: "s",
        fields: { x: { type: "string" } },
      }),
    } as unknown as ToolSet;
    const [entry] = buildToolCatalog(tools);
    expect(entry.tokenEstimate).toBeGreaterThan(0);
    expect(sumCatalogTokens([entry])).toBe(entry.tokenEstimate);
  });
});

// ---------------------------------------------------------------------------
// token estimation
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("approximates ~4 chars per token, rounded up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// policy decision
// ---------------------------------------------------------------------------

describe("decideProgressivePlan", () => {
  it("trips when tool count exceeds threshold", () => {
    const catalog = buildToolCatalog(makeCatalogWithCount(35));
    const plan = decideProgressivePlan({ catalog });
    expect(plan.enabled).toBe(true);
    expect(plan.reasons.some((r) => r.startsWith("tool_count"))).toBe(true);
  });

  it("trips when context ratio exceeds thresholdPct", () => {
    // Small tool count, but model context is tiny so ratio dominates.
    const catalog = buildToolCatalog(makeCatalogWithCount(5));
    const total = sumCatalogTokens(catalog);
    const plan = decideProgressivePlan({
      catalog,
      modelContextLength: Math.ceil(total / 0.04),
    });
    expect(plan.enabled).toBe(true);
    expect(plan.reasons.some((r) => r.startsWith("ctx_ratio"))).toBe(true);
  });

  it("stays disabled when all thresholds clear", () => {
    const catalog = buildToolCatalog(makeCatalogWithCount(5));
    const plan = decideProgressivePlan({
      catalog,
      modelContextLength: 200_000,
    });
    expect(plan.enabled).toBe(false);
    expect(plan.reasons).toContain("below_thresholds");
  });

  it("respects envOverride=on regardless of size", () => {
    const catalog = buildToolCatalog(makeCatalogWithCount(2));
    const plan = decideProgressivePlan({
      catalog,
      modelContextLength: 200_000,
      envOverride: true,
    });
    expect(plan.enabled).toBe(true);
    expect(plan.reasons).toEqual(["forced_on"]);
  });

  it("respects envOverride=off even past thresholds", () => {
    const catalog = buildToolCatalog(makeCatalogWithCount(50));
    const plan = decideProgressivePlan({
      catalog,
      envOverride: false,
    });
    expect(plan.enabled).toBe(false);
    expect(plan.reasons).toEqual(["forced_off"]);
  });

  it("respects options.enabled when no envOverride is set", () => {
    const catalog = buildToolCatalog(makeCatalogWithCount(2));
    const plan = decideProgressivePlan({
      catalog,
      modelContextLength: 200_000,
      options: { enabled: true },
    });
    expect(plan.enabled).toBe(true);
    expect(plan.reasons).toEqual(["forced_on"]);
  });
});

// ---------------------------------------------------------------------------
// env parsing
// ---------------------------------------------------------------------------

describe("parseProgressiveToolsEnv", () => {
  it("accepts auto / on / off / unknown", () => {
    expect(parseProgressiveToolsEnv("auto")).toBe("auto");
    expect(parseProgressiveToolsEnv("AUTO")).toBe("auto");
    expect(parseProgressiveToolsEnv("on")).toBe(true);
    expect(parseProgressiveToolsEnv("true")).toBe(true);
    expect(parseProgressiveToolsEnv("1")).toBe(true);
    expect(parseProgressiveToolsEnv("off")).toBe(false);
    expect(parseProgressiveToolsEnv("0")).toBe(false);
    expect(parseProgressiveToolsEnv("")).toBeUndefined();
    expect(parseProgressiveToolsEnv("maybe")).toBeUndefined();
    expect(parseProgressiveToolsEnv(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// search ranking
// ---------------------------------------------------------------------------

describe("searchToolCatalog", () => {
  const catalog = buildToolCatalog({
    asana_create_task: makeMcpTool({
      description: "Create a task in Asana",
      serverId: "asana",
      fields: { name: { type: "string", required: true } },
    }),
    asana_get_task: makeMcpTool({
      description: "Fetch a single task by id",
      serverId: "asana",
      fields: { taskId: { type: "string", required: true } },
    }),
    linear_create_issue: makeMcpTool({
      description: "Create an issue in Linear",
      serverId: "linear",
      fields: { title: { type: "string", required: true } },
    }),
  } as unknown as ToolSet);

  it("ranks name matches above description matches", () => {
    const matches = searchToolCatalog(catalog, "task");
    expect(matches[0].modelName.includes("task")).toBe(true);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("filters by serverIds when supplied", () => {
    const matches = searchToolCatalog(catalog, "create", {
      serverIds: ["linear"],
    });
    expect(matches.map((m) => m.modelName)).toEqual(["linear_create_issue"]);
  });

  it("returns no matches for terms with zero score", () => {
    const matches = searchToolCatalog(catalog, "xyzzy_never_matches");
    expect(matches).toHaveLength(0);
  });

  it("honors limit", () => {
    const matches = searchToolCatalog(catalog, "task", { limit: 1 });
    expect(matches).toHaveLength(1);
  });

  it("returns first N entries when query is empty (deterministic order)", () => {
    const matches = searchToolCatalog(catalog, "", { limit: 2 });
    expect(matches.map((m) => m.modelName)).toEqual([
      "asana_create_task",
      "asana_get_task",
    ]);
  });
});

// ---------------------------------------------------------------------------
// active tool resolution
// ---------------------------------------------------------------------------

describe("resolveActiveToolNames", () => {
  const tools: ToolSet = {
    asana_create_task: makeMcpTool({ serverId: "asana", fields: {} }),
    asana_get_task: makeMcpTool({ serverId: "asana", fields: {} }),
  } as unknown as ToolSet;
  const catalog = buildToolCatalog(tools);

  it("returns only the catalog (no meta-tools) when progressive is disabled", () => {
    // The orchestrator omits meta-tools from the toolset entirely when
    // progressive mode is off, so including their names here would only
    // produce dead names that miss every downstream lookup.
    const plan = decideProgressivePlan({
      catalog,
      modelContextLength: 200_000,
    });
    expect(plan.enabled).toBe(false);
    const state = createDiscoveryState();
    const active = resolveActiveToolNames(plan, state);
    expect(active.sort()).toEqual(
      ["asana_create_task", "asana_get_task"].sort(),
    );
  });

  it("returns only meta-tools when enabled and nothing is loaded", () => {
    const plan = decideProgressivePlan({ catalog, envOverride: true });
    const state = createDiscoveryState();
    const active = resolveActiveToolNames(plan, state);
    expect(active.sort()).toEqual([...META_TOOL_NAMES].sort());
  });

  it("includes loaded + newly-loaded + pending tools", () => {
    const plan = decideProgressivePlan({ catalog, envOverride: true });
    const state = createDiscoveryState();
    const createId = lookupToolIdByModelName(plan.catalog, "asana_create_task");
    const getId = lookupToolIdByModelName(plan.catalog, "asana_get_task");
    expect(createId).toBeDefined();
    expect(getId).toBeDefined();
    state.loadedToolIds.add(createId!);
    state.newlyLoadedToolIds.add(getId!);
    state.pendingApprovalToolIds.add(createId!);
    const active = resolveActiveToolNames(plan, state);
    expect(active.sort()).toEqual(
      [
        META_TOOL_SEARCH,
        META_TOOL_LOAD,
        "asana_create_task",
        "asana_get_task",
      ].sort(),
    );
  });

  it("ignores unknown ids in state", () => {
    const plan = decideProgressivePlan({ catalog, envOverride: true });
    const state = createDiscoveryState();
    state.loadedToolIds.add("ghost::id");
    const active = resolveActiveToolNames(plan, state);
    expect(active.sort()).toEqual([...META_TOOL_NAMES].sort());
  });
});

// ---------------------------------------------------------------------------
// commitNewlyLoaded
// ---------------------------------------------------------------------------

describe("commitNewlyLoaded", () => {
  it("promotes newly-loaded ids into loaded and clears the staging set", () => {
    const state = createDiscoveryState();
    state.newlyLoadedToolIds.add("a");
    state.newlyLoadedToolIds.add("b");
    const promoted = commitNewlyLoaded(state);
    expect(promoted).toBe(2);
    expect([...state.loadedToolIds].sort()).toEqual(["a", "b"]);
    expect(state.newlyLoadedToolIds.size).toBe(0);
  });

  it("does not double-count already loaded ids", () => {
    const state = createDiscoveryState();
    state.loadedToolIds.add("a");
    state.newlyLoadedToolIds.add("a");
    const promoted = commitNewlyLoaded(state);
    expect(promoted).toBe(0);
  });
});
