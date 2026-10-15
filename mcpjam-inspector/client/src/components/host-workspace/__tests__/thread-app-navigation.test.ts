import { describe, expect, it, vi } from "vitest";
import type { WidgetHost } from "@mcpjam/widget-react";
import { withThreadAppNavigation } from "../thread-app-navigation";
import type { ThreadAppHandle } from "../thread-app-api";
function host(native: boolean, enabled: boolean) {
  return {
    environment: { draftHostContext: { theme: "dark" } },
    services: {},
    resolvers: {
      resolveEffectiveHostCapabilities: () => (native ? { openLinks: {} } : {}),
      resolveEffectiveMcpAppsCapabilities: () => ({ openLinks: enabled }),
    },
  } as unknown as WidgetHost;
}
describe("owned navigation host", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("requires native %s and policy %s", (native, enabled) => {
    const original = host(native, enabled);
    const owned = host(false, false);
    const open = vi.fn();
    const result = withThreadAppNavigation(
      owned,
      original,
      {
        deepLinkNamespace: { pluginId: "p", runtime: "chatgpt" },
        deepLink: { url: "/parts" },
      } as ThreadAppHandle,
      open,
    );
    expect(result.environment.draftHostContext["openai/deepLink"]).toEqual({
      url: "/parts",
    });
    expect(
      result.resolvers.resolveEffectiveMcpAppsCapabilities({
        hostStyle: "chatgpt",
      }).openLinks,
    ).toBe(native && enabled);
    expect(
      !!result.resolvers.resolveEffectiveHostCapabilities({
        hostStyle: "chatgpt",
      }).openLinks,
    ).toBe(native && enabled);
    expect(open).not.toHaveBeenCalled();
  });
  it("adds no authority without server namespace", () => {
    const original = host(true, true);
    const owned = host(false, false);
    expect(
      withThreadAppNavigation(owned, original, {} as ThreadAppHandle, vi.fn()),
    ).toBe(owned);
  });
});
