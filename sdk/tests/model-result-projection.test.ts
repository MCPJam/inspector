import { describe, expect, it } from "vitest";
import {
  convertMCPToolsToVercelTools,
  projectMcpToolResultForModel,
} from "../src/mcp-client-manager/tool-converters";
describe("shared MCP model result projection", () => {
  it("matches the existing tool converter without changing the original App result", async () => {
    const metadata = { ui: { resourceUri: "ui://app" } };
    const result = {
      content: [{ type: "text" as const, text: "model text" }],
      structuredContent: { widget: "state" },
      _meta: { private: "widget secret" },
    };
    const tools = await convertMCPToolsToVercelTools(
      {
        tools: [
          { name: "show", inputSchema: { type: "object" }, _meta: metadata },
        ],
      },
      { callTool: async () => result }
    );
    const projected = await projectMcpToolResultForModel(result, metadata);
    expect(projected).toEqual(
      await tools.show.toModelOutput!({
        toolCallId: "call",
        input: {},
        output: result,
      })
    );
    expect(projected).toEqual({
      type: "json",
      value: { content: result.content },
    });
    expect(result.structuredContent).toEqual({ widget: "state" });
    expect(result._meta.private).toBe("widget secret");
  });
});
