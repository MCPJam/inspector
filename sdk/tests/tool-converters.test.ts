import { describe, expect, it, vi } from "vitest";
import type { ListToolsResult } from "@modelcontextprotocol/client";
import {
  convertMCPToolsToVercelTools,
  MCP_OUTPUT_SCHEMA_PROPERTY,
} from "../src/mcp-client-manager/tool-converters";

describe("convertMCPToolsToVercelTools", () => {
  it("preserves MCP output schemas as model-visible metadata", async () => {
    const outputSchema = {
      type: "object",
      properties: {
        temperature: {
          type: "number",
          description: "Temperature in Celsius",
        },
        x: {
          type: "integer",
          description: "Density of seagulls in the sky",
        },
      },
      required: ["temperature", "x"],
    };

    const tools = await convertMCPToolsToVercelTools(
      {
        tools: [
          {
            name: "get_weather",
            description: "Get weather for a city.",
            inputSchema: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
            outputSchema,
          },
        ],
      } as ListToolsResult,
      {
        callTool: vi.fn(),
      }
    );

    const weatherTool = tools.get_weather as Record<string, unknown>;

    expect(weatherTool.description).toContain("Get weather for a city.");
    expect(weatherTool.description).toContain(
      "MCP output schema for structuredContent:"
    );
    expect(weatherTool.description).toContain("Density of seagulls in the sky");
    expect(weatherTool[MCP_OUTPUT_SCHEMA_PROPERTY]).toBe(outputSchema);
    expect(weatherTool.outputSchema).toBeUndefined();
  });

  it("does not change descriptions when a tool has no output schema", async () => {
    const tools = await convertMCPToolsToVercelTools(
      {
        tools: [
          {
            name: "echo",
            description: "Echo a message.",
            inputSchema: {
              type: "object",
              properties: {
                message: { type: "string" },
              },
              required: ["message"],
            },
          },
        ],
      } as ListToolsResult,
      {
        callTool: vi.fn(),
      }
    );

    expect(tools.echo.description).toBe("Echo a message.");
    expect(
      (tools.echo as Record<string, unknown>)[MCP_OUTPUT_SCHEMA_PROPERTY]
    ).toBeUndefined();
  });
});
