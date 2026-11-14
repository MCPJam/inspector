import { describe, expect, it } from "vitest";
import { deriveAppPaneTools } from "../app-pane-tools";
import { makeAppInstance } from "@/test/factories";
import type { AppToolCatalogEntry } from "@mcpjam/widget-react";

const entry = (
  overrides: Partial<AppToolCatalogEntry> = {},
): AppToolCatalogEntry => ({
  instance: makeAppInstance(),
  alias: "app_12345678",
  bridgeId: "bridge",
  rawName: "move",
  readOnly: true,
  ...overrides,
});
describe("app pane groups", () => {
  it("groups offered and dropped tools, skips empty instances and deduplicates names", () => {
    const a = entry();
    const groups = deriveAppPaneTools({
      offered: [a, a, entry({ instance: makeAppInstance({ tools: [] }) })],
      dropped: [{ ...a, rawName: "other", reason: "entry_cap" }],
    });
    expect(groups).toHaveLength(1);
    expect(
      groups[0].tools.map((tool) => [tool.rawName, tool.availability]),
    ).toEqual([
      ["move", "offered"],
      ["other", "entry_cap"],
    ]);
  });
  it("keeps row identity through surface and bridge churn but separates sessions and parents", () => {
    const a = entry();
    const key = (item: AppToolCatalogEntry) =>
      deriveAppPaneTools({ offered: [item], dropped: [] })[0].tools[0].key;
    expect(key(a)).toBe("app:chat-1\0call-1\0move");
    expect(
      key({
        ...a,
        bridgeId: "new",
        instance: { ...a.instance, surface: "modal", bridgeId: "new" },
      }),
    ).toBe(key(a));
    expect(
      key({ ...a, instance: { ...a.instance, chatSessionId: "other" } }),
    ).not.toBe(key(a));
    expect(
      key({ ...a, instance: { ...a.instance, parentToolCallId: "other" } }),
    ).not.toBe(key(a));
  });
});
