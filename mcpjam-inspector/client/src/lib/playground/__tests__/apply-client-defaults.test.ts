import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// host-templates references the Vite-injected __APP_VERSION__ global when
// seeding template clientInfo. Provide a stable test value before importing.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = "0.0.0-test";

import { applyHostConfigToPlayground } from "../apply-client-defaults";
import * as selectedModelStorage from "@/lib/selected-model-storage";
import { useHostContextStore } from "@/stores/client-context-store";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";

describe("applyHostConfigToPlayground", () => {
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

    // Picking a named "Claude" host should update the loading-indicator
    // dispatch to "claude" and update the chat-composer model picker to
    // the host's saved model.
    expect(setHostStyle).toHaveBeenCalledWith("claude");
    expect(replaceLeadModelIdSpy).toHaveBeenCalledWith(
      "anthropic/claude-opus-4.5"
    );

    expect(applyHostTemplateSpy).toHaveBeenCalledWith(
      namedHostConfig.hostContext
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
      setters
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
      setters
    );

    // Empty/whitespace skips the configured id, then the resolver
    // tries the host style's template default.
    expect(replaceLeadModelIdSpy).toHaveBeenCalledWith(
      "anthropic/claude-haiku-4.5"
    );
  });

  it("falls back to MCPJam's default model for unknown host styles", () => {
    applyHostConfigToPlayground(
      {
        hostStyle: "some-byo-host-style",
        modelId: "totally-made-up-id",
        hostContext: {},
        mcpProfile: undefined,
        hostCapabilitiesOverride: undefined,
      },
      setters
    );

    // BYO style -> seedFromHostTemplate falls through to MCPJam.
    expect(replaceLeadModelIdSpy).toHaveBeenCalledWith(
      "anthropic/claude-haiku-4.5"
    );
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
      setters
    );

    expect(setHostStyle).toHaveBeenCalledWith("claude");
    expect(replaceLeadModelIdSpy).toHaveBeenCalledWith(
      "anthropic/claude-haiku-4.5"
    );
    expect(applyHostTemplateSpy).toHaveBeenCalledWith({});
    expect(setCustomViewportSpy).not.toHaveBeenCalled();
    expect(setDeviceTypeSpy).toHaveBeenCalledWith("fill");
    expect(setCspModeSpy).toHaveBeenCalledWith("permissive");
    expect(setMcpAppsCspModeSpy).toHaveBeenCalledWith("permissive");
    expect(setHostCapabilitiesOverride).toHaveBeenCalledWith(undefined);
  });
});
