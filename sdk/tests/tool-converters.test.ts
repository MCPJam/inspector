import { describe, it, expect } from "vitest";
import type { ListToolsResult } from "@modelcontextprotocol/client";
import {
  convertMCPToolsToVercelTools,
  isAppOnlyTool,
} from "../src/mcp-client-manager/tool-converters.js";

const callTool = async () => ({ content: [{ type: "text", text: "ok" }] });

const listToolsFixture: ListToolsResult = {
  tools: [
    {
      name: "app_only",
      description: "Should not be model-facing (SEP-1865 visibility=['app'])",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["app"] } },
    },
    {
      name: "model_only",
      description: "Explicitly model-only",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model"] } },
    },
    {
      name: "model_and_app",
      description: "Visible to both",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    {
      name: "default_visibility",
      description: "No visibility field — spec default is ['model','app']",
      inputSchema: { type: "object", properties: {} },
    },
  ],
} as unknown as ListToolsResult;

describe("isAppOnlyTool", () => {
  it("identifies visibility=['app'] as app-only", () => {
    expect(isAppOnlyTool({ ui: { visibility: ["app"] } })).toBe(true);
  });

  it("does not treat ['model','app'] as app-only", () => {
    expect(isAppOnlyTool({ ui: { visibility: ["model", "app"] } })).toBe(false);
  });

  it("does not treat ['model'] as app-only", () => {
    expect(isAppOnlyTool({ ui: { visibility: ["model"] } })).toBe(false);
  });

  it("treats omitted visibility as not app-only (spec default ['model','app'])", () => {
    expect(isAppOnlyTool(undefined)).toBe(false);
    expect(isAppOnlyTool({})).toBe(false);
    expect(isAppOnlyTool({ ui: {} })).toBe(false);
  });

  it("ignores non-array visibility values", () => {
    expect(isAppOnlyTool({ ui: { visibility: "app" } })).toBe(false);
  });
});

describe("convertMCPToolsToVercelTools — SEP-1865 visibility filtering", () => {
  it("excludes visibility=['app'] tools from the model-facing tool set by default", async () => {
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
    });

    expect(tools.app_only).toBeUndefined();
    expect(tools.model_only).toBeDefined();
    expect(tools.model_and_app).toBeDefined();
    expect(tools.default_visibility).toBeDefined();
  });

  it("included tools have an executable `execute` function", async () => {
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
    });

    expect(typeof (tools.model_only as { execute?: unknown }).execute).toBe(
      "function"
    );
  });

  it("includes app-only tools when includeAppOnly is true (Cursor-template parity)", async () => {
    const tools = await convertMCPToolsToVercelTools(listToolsFixture, {
      callTool,
      includeAppOnly: true,
    });

    expect(tools.app_only).toBeDefined();
    expect(tools.model_only).toBeDefined();
    expect(tools.model_and_app).toBeDefined();
    expect(tools.default_visibility).toBeDefined();
  });
});
