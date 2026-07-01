import { describe, it, expect } from "vitest";
import type { ListToolsResult } from "@modelcontextprotocol/client";
import {
  convertMCPToolsToVercelTools,
  describeOutputSchemaForModel,
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

const weatherToolFixture: ListToolsResult = {
  tools: [
    {
      name: "get_weather",
      description: "Get weather for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      outputSchema: {
        type: "object",
        properties: {
          temperature: {
            type: "number",
            description: "Temperature in Celsius",
          },
          condition: { type: "string" },
          x: { type: "integer", description: "Density of seagulls in the sky" },
        },
        required: ["temperature", "condition", "x"],
      },
    },
    {
      name: "no_output_schema",
      description: "Plain tool",
      inputSchema: { type: "object", properties: {} },
    },
  ],
} as unknown as ListToolsResult;

describe("describeOutputSchemaForModel", () => {
  it("lists fields with type, required flag, and descriptions", () => {
    const summary = describeOutputSchemaForModel({
      type: "object",
      properties: {
        temperature: { type: "number", description: "Temperature in Celsius" },
        x: { type: "integer", description: "Density of seagulls in the sky" },
      },
      required: ["temperature"],
    });

    expect(summary).toContain(
      "temperature (number, required): Temperature in Celsius"
    );
    expect(summary).toContain("x (integer): Density of seagulls in the sky");
  });

  it("returns undefined when there is no usable schema", () => {
    expect(describeOutputSchemaForModel(undefined)).toBeUndefined();
    expect(describeOutputSchemaForModel(null)).toBeUndefined();
    expect(describeOutputSchemaForModel({})).toBeUndefined();
    expect(
      describeOutputSchemaForModel({ type: "object", properties: {} })
    ).toBeUndefined();
  });
});

describe("convertMCPToolsToVercelTools — outputSchema in description", () => {
  it("folds the output schema into the model-facing description", async () => {
    const tools = await convertMCPToolsToVercelTools(weatherToolFixture, {
      callTool,
    });

    const description = (tools.get_weather as { description?: string })
      .description;
    expect(description).toContain("Get weather for a city");
    expect(description).toContain("Returns structured output");
    // The field the model previously ignored is now documented for it.
    expect(description).toContain("Density of seagulls in the sky");
  });

  it("leaves descriptions untouched when no outputSchema is present", async () => {
    const tools = await convertMCPToolsToVercelTools(weatherToolFixture, {
      callTool,
    });

    expect(
      (tools.no_output_schema as { description?: string }).description
    ).toBe("Plain tool");
  });
});
