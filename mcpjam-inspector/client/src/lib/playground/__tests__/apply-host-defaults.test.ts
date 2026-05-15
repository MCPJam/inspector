import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyHostConfigToPlayground,
  applyHostDefaultsToPlayground,
} from "../apply-host-defaults";
import { useHostContextStore } from "@/stores/host-context-store";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

describe("applyHostDefaultsToPlayground", () => {
  let applyHostTemplateSpy: ReturnType<typeof vi.fn>;
  let setCustomViewportSpy: ReturnType<typeof vi.fn>;
  let setDeviceTypeSpy: ReturnType<typeof vi.fn>;
  let setCspModeSpy: ReturnType<typeof vi.fn>;
  let setMcpAppsCspModeSpy: ReturnType<typeof vi.fn>;
  let setHostStyle: ReturnType<typeof vi.fn>;
  let setHostCapabilitiesOverride: ReturnType<typeof vi.fn>;
  let setters: {
    setHostStyle: typeof setHostStyle;
    setHostCapabilitiesOverride: typeof setHostCapabilitiesOverride;
  };

  beforeEach(() => {
    applyHostTemplateSpy = vi.fn();
    setCustomViewportSpy = vi.fn();
    setDeviceTypeSpy = vi.fn();
    setCspModeSpy = vi.fn();
    setMcpAppsCspModeSpy = vi.fn();
    setHostStyle = vi.fn();
    setHostCapabilitiesOverride = vi.fn();
    setters = { setHostStyle, setHostCapabilitiesOverride };

    vi.spyOn(useHostContextStore, "getState").mockReturnValue({
      applyHostTemplate: applyHostTemplateSpy,
    } as unknown as ReturnType<typeof useHostContextStore.getState>);

    vi.spyOn(useUIPlaygroundStore, "getState").mockReturnValue({
      setCustomViewport: setCustomViewportSpy,
      setDeviceType: setDeviceTypeSpy,
      setCspMode: setCspModeSpy,
      setMcpAppsCspMode: setMcpAppsCspModeSpy,
    } as unknown as ReturnType<typeof useUIPlaygroundStore.getState>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("snapshots Claude template defaults: hostStyle 'claude', container 720x5000, widget-declared CSP, override set", () => {
    applyHostDefaultsToPlayground("claude", setters);

    // hostStyle is the first thing written so the brand-pill / loading
    // indicator dispatch update before the chip stores repaint.
    expect(setHostStyle).toHaveBeenCalledWith("claude");
    expect(setHostStyle.mock.invocationCallOrder[0]).toBeLessThan(
      applyHostTemplateSpy.mock.invocationCallOrder[0],
    );

    expect(applyHostTemplateSpy).toHaveBeenCalledTimes(1);
    expect(applyHostTemplateSpy.mock.calls[0]?.[0]).toMatchObject({
      locale: "en-US",
      timeZone: "America/Los_Angeles",
      containerDimensions: { width: 720, maxHeight: 5000 },
    });

    expect(setCustomViewportSpy).toHaveBeenCalledWith({
      width: 720,
      height: 5000,
    });
    expect(setDeviceTypeSpy).not.toHaveBeenCalled();

    expect(setCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("widget-declared");

    // Claude's template sets a non-empty hostCapabilitiesOverride.
    expect(setHostCapabilitiesOverride).toHaveBeenCalledTimes(1);
    expect(setHostCapabilitiesOverride.mock.calls[0]?.[0]).toBeDefined();
  });

  it("snapshots ChatGPT template defaults: container falls back to maxWidth=768 + height=400", () => {
    applyHostDefaultsToPlayground("chatgpt", setters);

    expect(setHostStyle).toHaveBeenCalledWith("chatgpt");
    expect(setCustomViewportSpy).toHaveBeenCalledWith({
      width: 768,
      height: 400,
    });
    expect(setCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setHostCapabilitiesOverride.mock.calls[0]?.[0]).toBeDefined();
  });

  it("snapshots Cursor template defaults: container 748x800 (maxHeight)", () => {
    applyHostDefaultsToPlayground("cursor", setters);

    expect(setHostStyle).toHaveBeenCalledWith("cursor");
    expect(setCustomViewportSpy).toHaveBeenCalledWith({
      width: 748,
      height: 800,
    });
    expect(setCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setHostCapabilitiesOverride.mock.calls[0]?.[0]).toBeDefined();
  });

  it("snapshots MCPJam fallback: setDeviceType('desktop'), permissive CSP, override cleared", () => {
    applyHostDefaultsToPlayground("mcpjam", setters);

    expect(setHostStyle).toHaveBeenCalledWith("mcpjam");
    // MCPJam template has no hostContext.containerDimensions, so we fall
    // back to the device-type setter rather than custom viewport.
    expect(setCustomViewportSpy).not.toHaveBeenCalled();
    expect(setDeviceTypeSpy).toHaveBeenCalledWith("desktop");

    expect(setCspModeSpy).toHaveBeenCalledWith("permissive");
    expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("permissive");

    // MCPJam template doesn't set hostCapabilitiesOverride → undefined,
    // which clears the override (host-style preset takes over).
    expect(setHostCapabilitiesOverride).toHaveBeenCalledTimes(1);
    expect(setHostCapabilitiesOverride.mock.calls[0]?.[0]).toBeUndefined();
  });

  it("preserves the picked hostStyle for an unknown BYO host id even though template falls back to MCPJam", () => {
    applyHostDefaultsToPlayground("some-byo-custom-host", setters);

    // Brand-pill identity wins: the user's pick is what's advertised, not
    // the MCPJam fallback the template resolution returned.
    expect(setHostStyle).toHaveBeenCalledWith("some-byo-custom-host");
    // Body-of-work still comes from MCPJam (no template entry).
    expect(setDeviceTypeSpy).toHaveBeenCalledWith("desktop");
    expect(setCspModeSpy).toHaveBeenCalledWith("permissive");
    expect(setHostCapabilitiesOverride.mock.calls[0]?.[0]).toBeUndefined();
  });

  describe("applyHostConfigToPlayground (used by named-host picker sync)", () => {
    it("snapshots a named host's persisted config: hostStyle + hostContext + container + CSP + override", () => {
      const namedHostConfig = {
        hostStyle: "claude",
        hostContext: {
          locale: "fr-FR",
          timeZone: "Europe/Paris",
          containerDimensions: { width: 900, maxHeight: 1200 },
          theme: "light",
        },
        mcpProfile: {
          profileVersion: 1 as const,
          apps: { sandbox: { csp: { mode: "declared" as const } } },
        },
        hostCapabilitiesOverride: { openLinks: {} },
      };

      applyHostConfigToPlayground(namedHostConfig, setters);

      // Picking a named "Claude" host should flip the brand pill / loading
      // indicator dispatch to "claude" — the bug from the screenshot.
      expect(setHostStyle).toHaveBeenCalledWith("claude");

      expect(applyHostTemplateSpy).toHaveBeenCalledWith(
        namedHostConfig.hostContext,
      );
      expect(setCustomViewportSpy).toHaveBeenCalledWith({
        width: 900,
        height: 1200,
      });
      expect(setCspModeSpy).toHaveBeenCalledWith("widget-declared");
      expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("widget-declared");
      expect(setHostCapabilitiesOverride).toHaveBeenCalledWith({
        openLinks: {},
      });
    });

    it("clears override and resets device when the config has no overrides / dims / sandbox", () => {
      // A "blank" host config — exercises every fallback branch.
      applyHostConfigToPlayground(
        {
          hostStyle: "claude",
          hostContext: {},
          mcpProfile: undefined,
          hostCapabilitiesOverride: undefined,
        },
        setters,
      );

      expect(setHostStyle).toHaveBeenCalledWith("claude");
      expect(applyHostTemplateSpy).toHaveBeenCalledWith({});
      expect(setCustomViewportSpy).not.toHaveBeenCalled();
      expect(setDeviceTypeSpy).toHaveBeenCalledWith("desktop");
      expect(setCspModeSpy).toHaveBeenCalledWith("permissive");
      expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("permissive");
      expect(setHostCapabilitiesOverride).toHaveBeenCalledWith(undefined);
    });
  });
});
