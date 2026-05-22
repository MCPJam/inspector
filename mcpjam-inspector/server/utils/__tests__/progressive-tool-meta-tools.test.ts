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
  input: Record<string, unknown>,
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
      [META_TOOL_SEARCH, META_TOOL_LOAD].sort(),
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

  it("search_mcp_tools respects serverIds filter", async () => {
    const state = createDiscoveryState();
    const catalog = makeCatalog();
    const tools = createProgressiveMetaTools({
      getCatalog: () => catalog,
      state,
      policy: DEFAULT_TOOL_DISCOVERY_POLICY,
    });
    const res = (await execTool(tools, META_TOOL_SEARCH, {
      query: "create",
      serverIds: ["linear"],
    })) as { matches: { name: string }[] };
    expect(res.matches.map((m) => m.name)).toEqual(["linear_create_issue"]);
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
    expect([...state.newlyLoadedToolIds]).toEqual([
      "asana::asana_create_task",
    ]);
  });
});
