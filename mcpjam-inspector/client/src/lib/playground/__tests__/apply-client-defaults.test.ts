import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// host-templates references the Vite-injected __APP_VERSION__ global when
// seeding template clientInfo. Provide a stable test value before importing.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = "0.0.0-test";

import {
  applyHostConfigToPlayground,
  applyHostDefaultsToPlayground,
} from "../apply-client-defaults";
import { seedFromHostTemplate } from "@/lib/client-templates";
import * as selectedModelStorage from "@/lib/selected-model-storage";
import { useHostContextStore } from "@/stores/client-context-store";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

describe("applyHostDefaultsToPlayground", () => {
  let applyHostTemplateSpy: ReturnType<typeof vi.fn>;
  let setCustomViewportSpy: ReturnType<typeof vi.fn>;
  let setDeviceTypeSpy: ReturnType<typeof vi.fn>;
  let setCspModeSpy: ReturnType<typeof vi.fn>;
  let setMcpAppsCspModeSpy: ReturnType<typeof vi.fn>;
  let setHostStyle: ReturnType<typeof vi.fn>;
  let setHostCapabilitiesOverride: ReturnType<typeof vi.fn>;
  let setChatUiOverride: ReturnType<typeof vi.fn>;
  let replaceLeadModelIdSpy: ReturnType<typeof vi.spyOn>;
  let setters: {
    setHostStyle: typeof setHostStyle;
    setHostCapabilitiesOverride: typeof setHostCapabilitiesOverride;
    setChatUiOverride: typeof setChatUiOverride;
  };

  beforeEach(() => {
    applyHostTemplateSpy = vi.fn();
    setCustomViewportSpy = vi.fn();
    setDeviceTypeSpy = vi.fn();
    setCspModeSpy = vi.fn();
    setMcpAppsCspModeSpy = vi.fn();
    setHostStyle = vi.fn();
    setHostCapabilitiesOverride = vi.fn();
    setChatUiOverride = vi.fn();
    setters = {
      setHostStyle,
      setHostCapabilitiesOverride,
      setChatUiOverride,
    };

    vi.spyOn(useHostContextStore, "getState").mockReturnValue({
      applyHostTemplate: applyHostTemplateSpy,
    } as unknown as ReturnType<typeof useHostContextStore.getState>);

    vi.spyOn(useUIPlaygroundStore, "getState").mockReturnValue({
      setCustomViewport: setCustomViewportSpy,
      setDeviceType: setDeviceTypeSpy,
      setCspMode: setCspModeSpy,
      setMcpAppsCspMode: setMcpAppsCspModeSpy,
    } as unknown as ReturnType<typeof useUIPlaygroundStore.getState>);

    // Stub the model-storage host-switch primitive so the test can assert
    // without touching real localStorage / event listeners.
    replaceLeadModelIdSpy = vi
      .spyOn(selectedModelStorage, "replaceLeadModelId")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("snapshots Claude template defaults: hostStyle 'claude', model anthropic/claude-haiku-4.5 (guest-allowed), containerDimensions forwarded to View hostContext only, widget-declared CSP, override set", () => {
    applyHostDefaultsToPlayground("claude", setters);

    // hostStyle is the first thing written so the brand-pill / loading
    // indicator dispatch update before the chip stores repaint.
    expect(setHostStyle).toHaveBeenCalledWith("claude");
    expect(setHostStyle.mock.invocationCallOrder[0]).toBeLessThan(
      applyHostTemplateSpy.mock.invocationCallOrder[0],
    );

    // Lead model id is persisted via the storage helper (which fires the
    // same-tab event so usePersistedModel re-reads).
    expect(replaceLeadModelIdSpy).toHaveBeenCalledWith(
      "anthropic/claude-haiku-4.5",
    );

    // containerDimensions still flow into the host-context store; Views
    // receive them via ui/initialize.hostContext per SEP-1865.
    expect(applyHostTemplateSpy).toHaveBeenCalledTimes(1);
    expect(applyHostTemplateSpy.mock.calls[0]?.[0]).toMatchObject({
      locale: "en-US",
      timeZone: "America/Los_Angeles",
      containerDimensions: { width: 720, maxHeight: 5000 },
    });

    // But the playground's device-frame viewport is NOT shrunk to the
    // View's container dimensions — chat stays full-width.
    expect(setCustomViewportSpy).not.toHaveBeenCalled();
    expect(setDeviceTypeSpy).toHaveBeenCalledWith("fill");

    expect(setCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("widget-declared");

    // Claude's template sets a non-empty hostCapabilitiesOverride.
    expect(setHostCapabilitiesOverride).toHaveBeenCalledTimes(1);
    expect(setHostCapabilitiesOverride.mock.calls[0]?.[0]).toBeDefined();
  });

  it("snapshots ChatGPT template defaults: container metadata stays in host context, playground viewport stays fill, model openai/gpt-5-nano (guest-allowed)", () => {
    applyHostDefaultsToPlayground("chatgpt", setters);

    expect(setHostStyle).toHaveBeenCalledWith("chatgpt");
    expect(replaceLeadModelIdSpy).toHaveBeenCalledWith("openai/gpt-5-nano");
    expect(setCustomViewportSpy).not.toHaveBeenCalled();
    expect(setDeviceTypeSpy).toHaveBeenCalledWith("fill");
    expect(setCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setHostCapabilitiesOverride.mock.calls[0]?.[0]).toBeDefined();
  });

  it("snapshots Le Chat template defaults from the Mistral capture", () => {
    applyHostDefaultsToPlayground("mistral", setters);

    expect(setHostStyle).toHaveBeenCalledWith("mistral");
    expect(replaceLeadModelIdSpy).toHaveBeenCalledWith(
      "mistral-large-latest",
    );
    expect(applyHostTemplateSpy).toHaveBeenCalledTimes(1);
    expect(applyHostTemplateSpy.mock.calls[0]?.[0]).toMatchObject({
      theme: "dark",
      displayMode: "fullscreen",
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { width: 1130.5 },
      locale: "en",
      timeZone: "America/Los_Angeles",
      userAgent: "Le Chat/1.0.0",
      platform: "web",
      styles: {
        variables: {
          "--color-background-primary": "#111115",
          "--color-text-info": "#48bfff",
        },
      },
    });
    expect(setCustomViewportSpy).not.toHaveBeenCalled();
    expect(setDeviceTypeSpy).toHaveBeenCalledWith("fill");
    expect(setCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setHostCapabilitiesOverride.mock.calls[0]?.[0]).toMatchObject({
      serverTools: {},
      serverResources: {},
      logging: {},
      updateModelContext: { text: {} },
      message: { text: {}, image: {} },
    });

    const seed = seedFromHostTemplate("mistral");
    expect(seed.clientCapabilities).toEqual({});
    expect(seed.mcpProfile).toMatchObject({
      initialize: {
        supportedProtocolVersions: ["2025-11-25"],
        clientInfo: { name: "mcp", version: "0.1.0" },
      },
      apps: {
        uiInitialize: {
          hostInfo: { name: "Le Chat", version: "1.0.0" },
        },
        compatRuntime: { openaiApps: false },
        sandbox: {
          csp: {
            mode: "declared",
            restrictTo: {
              connectDomains: [
                "https://api.openai.com",
                "https://api.anthropic.com",
                "https://cdn.jsdelivr.net",
              ],
              resourceDomains: ["https://cdn.jsdelivr.net"],
            },
          },
          permissions: {
            mode: "custom",
            allow: { clipboardWrite: true },
          },
          sandboxAttrs: ["allow-forms"],
        },
      },
    });
  });

  it("snapshots Cursor template defaults: container metadata stays in host context, playground viewport stays fill, model anthropic/claude-sonnet-4.5 (guest-allowed)", () => {
    applyHostDefaultsToPlayground("cursor", setters);

    expect(setHostStyle).toHaveBeenCalledWith("cursor");
    expect(replaceLeadModelIdSpy).toHaveBeenCalledWith(
      "anthropic/claude-sonnet-4.5",
    );
    expect(setCustomViewportSpy).not.toHaveBeenCalled();
    expect(setDeviceTypeSpy).toHaveBeenCalledWith("fill");
    expect(setCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setHostCapabilitiesOverride.mock.calls[0]?.[0]).toBeDefined();
  });

  it("snapshots MCPJam fallback: setDeviceType('fill'), widget-declared CSP, override set, model id NOT touched", () => {
    applyHostDefaultsToPlayground("mcpjam", setters);

    expect(setHostStyle).toHaveBeenCalledWith("mcpjam");

    // MCPJam template has an empty modelId — we deliberately don't
    // clear the user's last picked model on a no-op host config.
    expect(replaceLeadModelIdSpy).not.toHaveBeenCalled();

    expect(setCustomViewportSpy).not.toHaveBeenCalled();
    expect(setDeviceTypeSpy).toHaveBeenCalledWith("fill");

    // MCPJam template advertises apps.sandbox.csp.mode "declared" so the
    // Permissive chip resolves to widget-declared, same as Claude/ChatGPT.
    expect(setCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("widget-declared");

    // MCPJam template now ships its own hostCapabilitiesOverride
    // (openLinks, updateModelContext, etc.) — the override is set, not
    // cleared, so widgets see MCPJam's advertised host surface.
    expect(setHostCapabilitiesOverride).toHaveBeenCalledTimes(1);
    expect(setHostCapabilitiesOverride.mock.calls[0]?.[0]).toBeDefined();
  });

  it("preserves the picked hostStyle for an unknown BYO host id even though template falls back to MCPJam", () => {
    applyHostDefaultsToPlayground("some-byo-custom-host", setters);

    // Brand-pill identity wins: the user's pick is what's advertised, not
    // the MCPJam fallback the template resolution returned.
    expect(setHostStyle).toHaveBeenCalledWith("some-byo-custom-host");
    // Body-of-work still comes from MCPJam (no template entry); since
    // MCPJam template's modelId is empty, the user's last picked model
    // is preserved.
    expect(replaceLeadModelIdSpy).not.toHaveBeenCalled();
    expect(setDeviceTypeSpy).toHaveBeenCalledWith("fill");
    // MCPJam fallback now stamps apps.sandbox.csp.mode "declared" and a
    // hostCapabilitiesOverride, so the BYO unknown id inherits both like
    // other branded templates.
    expect(setCspModeSpy).toHaveBeenCalledWith("widget-declared");
    expect(setHostCapabilitiesOverride.mock.calls[0]?.[0]).toBeDefined();
  });

  describe("applyHostConfigToPlayground (used by named-host picker sync)", () => {
    it("snapshots a named host's persisted config: hostStyle + model (canonical id passes through) + hostContext + container + CSP + override + chatUiOverride", () => {
      const namedHostConfig = {
        hostStyle: "claude",
        // Canonical id that exists in SUPPORTED_MODELS — passes through
        // the resolver as-is (no template fallback needed).
        modelId: "anthropic/claude-opus-4.5",
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
        chatUiOverride: { palette: { accent: "#ff00aa" } },
      };

      applyHostConfigToPlayground(namedHostConfig, setters);

      // Picking a named "Claude" host should flip the brand pill / loading
      // indicator dispatch to "claude" — and update the chat-composer
      // model picker to the host's saved model.
      expect(setHostStyle).toHaveBeenCalledWith("claude");
      expect(replaceLeadModelIdSpy).toHaveBeenCalledWith(
        "anthropic/claude-opus-4.5",
      );

      expect(applyHostTemplateSpy).toHaveBeenCalledWith(
        namedHostConfig.hostContext,
      );
      // containerDimensions belongs to the View iframe (delivered via
      // applyHostTemplate above), not the playground's device frame.
      expect(setCustomViewportSpy).not.toHaveBeenCalled();
      expect(setDeviceTypeSpy).toHaveBeenCalledWith("fill");
      expect(setCspModeSpy).toHaveBeenCalledWith("widget-declared");
      expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("widget-declared");
      expect(setHostCapabilitiesOverride).toHaveBeenCalledWith({
        openLinks: {},
      });
      // chatUiOverride is snapshotted into preferences so the playground's
      // ChatboxChatUiOverrideProvider picks up the host's custom palette /
      // logo / indicator without per-surface wiring.
      expect(setChatUiOverride).toHaveBeenCalledWith({
        palette: { accent: "#ff00aa" },
      });
    });

    it("passes a BYOK bare id straight through when it resolves in SUPPORTED_MODELS (host is source of truth)", () => {
      // "gpt-5" is a valid SUPPORTED_MODELS entry (BYOK; openai/gpt-5-nano
      // is the MCPJam-provided cousin). Pre-everything-from-host behavior
      // snapped this to the ChatGPT template default; that hides the
      // host's actual saved pick. Trust the host: surface "gpt-5" and let
      // the picker decide whether to render it as disabled (no key).
      applyHostConfigToPlayground(
        {
          hostStyle: "chatgpt",
          modelId: "gpt-5",
          hostContext: {},
          mcpProfile: undefined,
          hostCapabilitiesOverride: undefined,
        },
        setters,
      );

      expect(replaceLeadModelIdSpy).toHaveBeenCalledWith("gpt-5");
    });

    it("falls back to the template default when the persisted modelId is whitespace-only", () => {
      applyHostConfigToPlayground(
        {
          hostStyle: "claude",
          modelId: "   ",
          hostContext: {},
          mcpProfile: undefined,
          hostCapabilitiesOverride: undefined,
        },
        setters,
      );

      // Empty/whitespace skips the configured id, then the resolver
      // tries the host style's template default.
      expect(replaceLeadModelIdSpy).toHaveBeenCalledWith(
        "anthropic/claude-haiku-4.5",
      );
    });

    it("leaves the model picker alone when neither the configured id nor the template fallback resolves (BYO host, MCPJam template fallback)", () => {
      applyHostConfigToPlayground(
        {
          hostStyle: "some-byo-host-style",
          modelId: "totally-made-up-id",
          hostContext: {},
          mcpProfile: undefined,
          hostCapabilitiesOverride: undefined,
        },
        setters,
      );

      // BYO style → seedFromHostTemplate falls through to MCPJam, whose
      // modelId is empty → resolver returns undefined → no save.
      expect(replaceLeadModelIdSpy).not.toHaveBeenCalled();
    });

    it("clears override and resets device when the config has no overrides / dims / sandbox; model resolves from template", () => {
      // A "blank" host config — exercises every fallback branch. The
      // model resolver picks up the Claude template's canonical default
      // since the configured modelId is empty.
      applyHostConfigToPlayground(
        {
          hostStyle: "claude",
          modelId: "",
          hostContext: {},
          mcpProfile: undefined,
          hostCapabilitiesOverride: undefined,
        },
        setters,
      );

      expect(setHostStyle).toHaveBeenCalledWith("claude");
      expect(replaceLeadModelIdSpy).toHaveBeenCalledWith(
        "anthropic/claude-haiku-4.5",
      );
      expect(applyHostTemplateSpy).toHaveBeenCalledWith({});
      expect(setCustomViewportSpy).not.toHaveBeenCalled();
      expect(setDeviceTypeSpy).toHaveBeenCalledWith("fill");
      expect(setCspModeSpy).toHaveBeenCalledWith("permissive");
      expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("permissive");
      expect(setHostCapabilitiesOverride).toHaveBeenCalledWith(undefined);
    });
  });
});
