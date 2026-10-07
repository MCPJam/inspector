import { describe, expect, it } from "vitest";
import {
  isPluginMentionTool,
  pluginMentionToolUsesDefaultVisibility,
} from "../../../../shared/plugin-mentions.js";

const tool = (meta: Record<string, unknown>) => ({ _meta: meta });
describe("mention tool detection", () => {
  it("accepts any object marker, including future fields", () => {
    expect(
      isPluginMentionTool(
        tool({
          "openai/extensions": { "mentions/search": {} },
          ui: { visibility: ["app"] },
        }),
      ),
    ).toBe(true);
    expect(
      isPluginMentionTool(
        tool({
          "openai/extensions": { "mentions/search": { futureField: true } },
          ui: { visibility: ["model", "app"] },
        }),
      ),
    ).toBe(true);
  });
  it("treats a missing ui.visibility as the MCP Apps default", () => {
    const declared = tool({ "openai/extensions": { "mentions/search": {} } });
    expect(isPluginMentionTool(declared)).toBe(true);
    expect(pluginMentionToolUsesDefaultVisibility(declared)).toBe(true);
    const noVisibility = tool({
      "openai/extensions": { "mentions/search": {} },
      ui: { resourceUri: "ui://x" },
    });
    expect(isPluginMentionTool(noVisibility)).toBe(true);
    expect(
      pluginMentionToolUsesDefaultVisibility(
        tool({
          "openai/extensions": { "mentions/search": {} },
          ui: { visibility: ["app"] },
        }),
      ),
    ).toBe(false);
  });
  it.each([
    [{ "openai/extensions": { "mentions/search": true } }],
    [{ "openai/extensions": { "mentions/search": [] } }],
    [{ "openai/extensions": {} }],
    [
      {
        "openai/extensions": { "mentions/search": {} },
        ui: { visibility: ["model"] },
      },
    ],
    [{ "openai/extensions": { "mentions/search": {} }, ui: "app" }],
  ])("refuses %j", (meta) => {
    expect(isPluginMentionTool(tool(meta))).toBe(false);
  });
});
