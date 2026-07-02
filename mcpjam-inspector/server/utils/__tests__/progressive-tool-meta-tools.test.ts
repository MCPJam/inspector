import { describe, it, expect } from "vitest";
import {
  buildToolCatalog,
  createDiscoveryState,
  DEFAULT_TOOL_DISCOVERY_POLICY,
  META_TOOL_LOAD,
  META_TOOL_SEARCH,
} from "@/shared/progressive-tool-discovery";
import { createProgressiveMetaTools } from "../progressive-tool-meta-tools";
import type { ToolSet } from "ai";

function makeMcpTool(opts: {
  description?: string;
  serverId: string;
  fields?: Record<string, { type: string; required?: boolean }>;
}) {
  const fields = opts.fields ?? {};
  const required: string[] = [];
  const properties: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(fields)) {
    properties[name] = { type: spec.type };
    if (spec.required) required.push(name);
  }
  return {
    description: opts.description,
    parameters: {
      jsonSchema: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    },
    _serverId: opts.serverId,
    execute: async () => ({}),
  };
}

function makeCatalog() {
  const tools: ToolSet = {
    asana_create_task: makeMcpTool({
      description: "Create a task in Asana",
      serverId: "asana",
      fields: { name: { type: "string", required: true } },
    }),
    linear_create_issue: makeMcpTool({
      description: "Create an issue in Linear",
      serverId: "linear",
      fields: { title: { type: "string", required: true } },
    }),
  } as unknown as ToolSet;
  return buildToolCatalog(tools);
}

async function execTool(
  toolset: ToolSet,
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const t = toolset[name] as { execute?: (...args: unknown[]) => unknown };
  if (!t?.execute) throw new Error(`tool ${name} has no execute`);
  return (t.execute as any)(input, {});
}

describe("createProgressiveMetaTools", () => {
  it("exposes search_mcp_tools and load_mcp_tools", () => {
    const state = createDiscoveryState();
    const catalog = makeCatalog();
    const tools = createProgressiveMetaTools({
      getCatalog: () => catalog,
      state,
      policy: DEFAULT_TOOL_DISCOVERY_POLICY,
    });
    expect(Object.keys(tools).sort()).toEqual(
      [META_TOOL_SEARCH, META_TOOL_LOAD].sort()
    );
  });

  it("search_mcp_tools returns concise matches without full schemas", async () => {
    const state = createDiscoveryState();
    const catalog = makeCatalog();
    const tools = createProgressiveMetaTools({
      getCatalog: () => catalog,
      state,
      policy: DEFAULT_TOOL_DISCOVERY_POLICY,
    });
    const res = (await execTool(tools, META_TOOL_SEARCH, {
      query: "task",
    })) as { matches: { name: string; toolId: string }[] };
    expect(res.matches.length).toBeGreaterThan(0);
    expect(res.matches[0].name).toBe("asana_create_task");
    // Verify the match object is intentionally narrow — no `inputSchema`.
    expect(res.matches[0]).not.toHaveProperty("inputSchema");
  });

  it("search_mcp_tools ignores stray serverIds so guessed filters do not hide exact matches", async () => {
    const state = createDiscoveryState();
    const catalog = buildToolCatalog({
      get_categories: makeMcpTool({
        description: "Returns article categories as a nested tree",
        serverId: "DataPalace - localhost:3000",
      }),
      search_articles: makeMcpTool({
        description: "Search articles",
        serverId: "DataPalace - localhost:3000",
      }),
    } as unknown as ToolSet);
    const tools = createProgressiveMetaTools({
      getCatalog: () => catalog,
      state,
      policy: DEFAULT_TOOL_DISCOVERY_POLICY,
    });
    const res = (await execTool(tools, META_TOOL_SEARCH, {
      query: "get_categories",
      serverIds: ["gstack"],
    })) as { matches: { name: string; serverId: string }[] };
    expect(res.matches.map((m) => m.name)).toContain("get_categories");
  });

  it("search_mcp_tools clamps caller-supplied limit to bounded ceiling", async () => {
    // policy.searchLimit defaults to 8; the meta-tool caps the effective
    // limit at max(searchLimit * 4, 32) = 32. A bogus high value (or a
    // prompt-injected one) must not produce an oversized tool-result
    // payload. We can't observe the clamp directly via the public
    // surface, but we can prove the limit was capped by passing a large
    // value and verifying matches never exceed the ceiling regardless
    // of catalog size.
    const state = createDiscoveryState();
    // Build a 50-entry catalog (every entry matches the query "create"
    // because makeMcpTool puts that token nowhere — so we use a token
    // that's actually present in tool names). Use serverId variation
    // so each entry hashes to a distinct toolId.
    const tools: Record<string, unknown> = {};
    for (let i = 0; i < 50; i += 1) {
      tools[`asana_create_task_${i}`] = makeMcpTool({
        description: `Create a task in Asana (#${i})`,
        serverId: `asana_${i}`,
        fields: { name: { type: "string", required: true } },
      });
    }
    const catalog = buildToolCatalog(tools as unknown as ToolSet);
    const metaTools = createProgressiveMetaTools({
      getCatalog: () => catalog,
      state,
      policy: DEFAULT_TOOL_DISCOVERY_POLICY,
    });
    const res = (await execTool(metaTools, META_TOOL_SEARCH, {
      query: "create",
      limit: 10_000,
    })) as { matches: unknown[]; truncated: boolean };
    // Effective ceiling = max(searchLimit * 4, 32) = 32. The catalog has
    // 50 matches, so the response should hit the ceiling exactly.
    expect(res.matches.length).toBe(32);
    expect(res.truncated).toBe(true);
  });

  it("search_mcp_tools reports unsliced totalMatches and truncation flag", async () => {
    // policy.searchLimit defaults to 8 — build a 20-match catalog and
    // assert totalMatches reflects the full population, not the page
    // size. Prior bug: totalMatches always equalled matches.length.
    const tools: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) {
      tools[`asana_create_task_${i}`] = makeMcpTool({
        description: `Create a task in Asana (#${i})`,
        serverId: `asana_${i}`,
        fields: { name: { type: "string", required: true } },
      });
    }
    const catalog = buildToolCatalog(tools as unknown as ToolSet);
    const metaTools = createProgressiveMetaTools({
      getCatalog: () => catalog,
      state: createDiscoveryState(),
      policy: DEFAULT_TOOL_DISCOVERY_POLICY,
    });
    const res = (await execTool(metaTools, META_TOOL_SEARCH, {
      query: "create",
    })) as { matches: unknown[]; totalMatches: number; truncated: boolean };
    expect(res.matches.length).toBe(DEFAULT_TOOL_DISCOVERY_POLICY.searchLimit);
    expect(res.totalMatches).toBe(20);
    expect(res.truncated).toBe(true);
  });

  it("search_mcp_tools does not mark truncated when exactly limit matches exist", async () => {
    // Edge case: with N matches == limit, truncated should be false.
    // Prior bug: matches.length === effectiveLimit always set truncated=true.
    const tools: Record<string, unknown> = {};
    const limit = DEFAULT_TOOL_DISCOVERY_POLICY.searchLimit;
    for (let i = 0; i < limit; i += 1) {
      tools[`asana_create_task_${i}`] = makeMcpTool({
        description: `Create a task in Asana (#${i})`,
        serverId: `asana_${i}`,
        fields: { name: { type: "string", required: true } },
      });
    }
    const catalog = buildToolCatalog(tools as unknown as ToolSet);
    const metaTools = createProgressiveMetaTools({
      getCatalog: () => catalog,
      state: createDiscoveryState(),
      policy: DEFAULT_TOOL_DISCOVERY_POLICY,
    });
    const res = (await execTool(metaTools, META_TOOL_SEARCH, {
      query: "create",
    })) as { matches: unknown[]; totalMatches: number; truncated: boolean };
    expect(res.matches.length).toBe(limit);
    expect(res.totalMatches).toBe(limit);
    expect(res.truncated).toBe(false);
  });

  it("load_mcp_tools marks ids as newlyLoaded in state", async () => {
    const state = createDiscoveryState();
    const catalog = makeCatalog();
    const tools = createProgressiveMetaTools({
      getCatalog: () => catalog,
      state,
      policy: DEFAULT_TOOL_DISCOVERY_POLICY,
    });
    const res = (await execTool(tools, META_TOOL_LOAD, {
      toolIds: ["asana::asana_create_task", "nope::missing"],
    })) as { loaded: { toolId: string }[]; notFound: string[] };
    expect(res.loaded.map((l) => l.toolId)).toEqual([
      "asana::asana_create_task",
    ]);
    expect(res.notFound).toEqual(["nope::missing"]);
    expect([...state.newlyLoadedToolIds]).toEqual(["asana::asana_create_task"]);
  });
});
