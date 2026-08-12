import { describe, expect, it } from "vitest";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import {
  detectUIType,
  isMCPApp,
  isOpenAIApp,
  isOpenAIAppAndMCPApp,
  UIType,
} from "../mcp-apps-utils";

function toolsData(
  toolsMetadata: Record<string, Record<string, unknown>>,
): ListToolsResultWithMetadata {
  return { tools: [], toolsMetadata } as unknown as ListToolsResultWithMetadata;
}

describe("MCP App detection with malformed server metadata", () => {
  // INSPECTOR-CLIENT-227. `toolsMetadata` is third-party — it reaches the
  // client verbatim from the connected server. ServerDetailModal calls all
  // three predicates in its render body, so a throw here unwinds to the route
  // error element and blanks `/servers` rather than skipping one bad tool.
  const MALFORMED: Array<[string, unknown]> = [
    ["the empty string", ""],
    ["a non-ui:// string", "https://example.com/app.html"],
    ["a number", 42],
    ["an object", { href: "ui://server/app.html" }],
    ["null", null],
  ];

  it.each(MALFORMED)(
    "classifies a tool declaring %s as not-an-app instead of throwing",
    (_label, resourceUri) => {
      const meta = { ui: { resourceUri } };

      expect(detectUIType(meta, undefined)).toBeNull();
      expect(isMCPApp(toolsData({ broken: meta }))).toBe(false);
      expect(isOpenAIApp(toolsData({ broken: meta }))).toBe(false);
      expect(isOpenAIAppAndMCPApp(toolsData({ broken: meta }))).toBe(false);
    },
  );

  it("still detects the valid tools alongside a malformed one", () => {
    const data = toolsData({
      broken: { ui: { resourceUri: "" } },
      good: { ui: { resourceUri: "ui://server/app.html" } },
    });

    expect(isMCPApp(data)).toBe(true);
  });

  it("keeps an openai-only tool classified when its ui.resourceUri is malformed", () => {
    const meta = {
      "openai/outputTemplate": "ui://tmpl",
      ui: { resourceUri: "" },
    };

    expect(detectUIType(meta, undefined)).toBe(UIType.OPENAI_SDK);
    expect(isOpenAIApp(toolsData({ mixed: meta }))).toBe(true);
    expect(isOpenAIAppAndMCPApp(toolsData({ mixed: meta }))).toBe(false);
  });
});
