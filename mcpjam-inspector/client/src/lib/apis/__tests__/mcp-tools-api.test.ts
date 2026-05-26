import { describe, expect, it } from "vitest";
import { attachToolMetadata } from "../mcp-tools-api";
import type { ListToolsResultWithMetadata } from "../mcp-tools-api";

describe("attachToolMetadata", () => {
  it("copies inspector toolsMetadata onto matching tool _meta", () => {
    const result = attachToolMetadata({
      tools: [
        {
          name: "hidden_from_model",
          description: "App-only tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      toolsMetadata: {
        hidden_from_model: {
          ui: { visibility: ["app"] },
        },
      },
    } as ListToolsResultWithMetadata);

    expect(result.tools[0]._meta).toEqual({
      ui: { visibility: ["app"] },
    });
  });

  it("preserves tool-local _meta while adding inspector metadata", () => {
    const result = attachToolMetadata({
      tools: [
        {
          name: "render_chart",
          description: "Render chart",
          inputSchema: { type: "object", properties: {} },
          _meta: { existing: true },
        },
      ],
      toolsMetadata: {
        render_chart: {
          ui: {
            resourceUri: "ui://chart/widget.html",
            visibility: ["model", "app"],
          },
        },
      },
    } as ListToolsResultWithMetadata);

    expect(result.tools[0]._meta).toEqual({
      existing: true,
      ui: {
        resourceUri: "ui://chart/widget.html",
        visibility: ["model", "app"],
      },
    });
  });

  it("merges nested ui metadata instead of replacing it", () => {
    const result = attachToolMetadata({
      tools: [
        {
          name: "render_chart",
          description: "Render chart",
          inputSchema: { type: "object", properties: {} },
          _meta: {
            ui: { resourceUri: "ui://chart/widget.html" },
          },
        },
      ],
      toolsMetadata: {
        render_chart: {
          ui: { visibility: ["app"] },
        },
      },
    } as ListToolsResultWithMetadata);

    expect(result.tools[0]._meta).toEqual({
      ui: {
        resourceUri: "ui://chart/widget.html",
        visibility: ["app"],
      },
    });
  });
});
