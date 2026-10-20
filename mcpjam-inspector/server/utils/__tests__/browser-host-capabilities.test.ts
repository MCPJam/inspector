import { describe, expect, it } from "vitest";
import { resolveBrowserHostCapabilities } from "../browser-host-capabilities";

describe("browser host capabilities", () => {
  it.each(["claude", "chatgpt", "copilot"])(
    "honors explicit resource switches for %s",
    (hostStyle) => {
      for (const enabled of [true, false]) {
        const caps = resolveBrowserHostCapabilities({
          hostStyle,
          mcpProfile: {
            apps: { mcpAppsOverrides: { serverResources: enabled } },
          },
        });
        expect(caps?.serverResources).toEqual(enabled ? {} : undefined);
      }
    },
  );
  it("uses case overrides and keeps disabled access out of initialization", () => {
    expect(
      resolveBrowserHostCapabilities(
        {
          hostStyle: "claude",
          mcpProfile: { apps: { mcpAppsOverrides: { serverResources: true } } },
        },
        {
          mcpProfile: {
            apps: { mcpAppsOverrides: { serverResources: false } },
          },
        },
      )?.serverResources,
    ).toBeUndefined();
  });
  it("resolves a pinned swarm profile without relying on live client settings", () => {
    expect(
      resolveBrowserHostCapabilities({
        mcpProfile: {
          apps: {
            mcpAppsOverrides: { serverResources: true, serverTools: false },
          },
        },
      }),
    ).toEqual({ serverResources: {} });
  });
  it("preserves an empty legacy override and removes static sandbox grants", () => {
    expect(
      resolveBrowserHostCapabilities({
        hostStyle: "claude",
        hostCapabilitiesOverride: {},
      }),
    ).toEqual({});
    expect(
      resolveBrowserHostCapabilities({
        hostCapabilitiesOverride: {
          sandbox: { permissions: {} },
          serverResources: {},
        },
      }),
    ).toEqual({ serverResources: {} });
  });
  it("keeps default behavior only when there is no selected profile", () => {
    expect(resolveBrowserHostCapabilities()).toBeUndefined();
    expect(resolveBrowserHostCapabilities({ hostStyle: "unknown" })).toEqual(
      {},
    );
  });
});
