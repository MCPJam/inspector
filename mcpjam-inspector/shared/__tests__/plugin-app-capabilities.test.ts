import { describe, expect, it } from "vitest";
import { pluginAppToolsEnabled } from "../plugin-app-capabilities";
describe("saved App execution capabilities", () => {
  it.each(["chatgpt", "codex"])(
    "honors an explicit denial for %s",
    (hostStyle) => {
      expect(
        pluginAppToolsEnabled({
          hostStyle,
          mcpProfile: { apps: { mcpAppsOverrides: { serverTools: false } } },
        }),
      ).toBe(false);
      expect(
        pluginAppToolsEnabled({
          hostStyle,
          mcpProfile: { apps: { mcpAppsOverrides: { serverTools: true } } },
        }),
      ).toBe(true);
    },
  );
  it("makes no claims for an unknown style or malformed override", () => {
    expect(pluginAppToolsEnabled({ hostStyle: "unknown" })).toBe(false);
    expect(
      pluginAppToolsEnabled({
        hostStyle: "chatgpt",
        mcpProfile: { apps: { mcpAppsOverrides: { serverTools: "true" } } },
      }),
    ).toBe(false);
  });
});
