import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook } from "@testing-library/react";
import { WebManagedServersProvider } from "@/contexts/web-managed-servers-context";
import { ScenarioSurfaceProvider } from "@/contexts/scenario-surface-context";
import {
  WidgetSurfaceProvider,
  type WidgetSurface,
} from "@/contexts/widget-surface-context";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { useWidgetHost } from "../use-widget-host";
import { SavedClientProvider } from "@/contexts/saved-client-context";
import { useHostContextStore } from "@/stores/client-context-store";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import type { HostSnapshot } from "@/lib/host-snapshot";

// Pin HOSTED_MODE off so the listResourceTemplates guard is exercised purely via
// the web-managed-servers context (the security-sensitive boundary concern).
// Every config export the hook reads has to appear here: vitest throws on a
// missing one rather than returning undefined, so a new read is a hard break
// in this suite. (VIEW_MOUNT_MODE was added without it and landed red.)
vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
  SANDBOX_ORIGIN: "",
  VIEW_MOUNT_MODE: "write",
  VIEW_SUBDOMAINS_ENABLED: false,
}));

// Isolate the hook from the api/network layer.
const listResourceTemplatesMock = vi.fn();
vi.mock("@/lib/apis/mcp-resource-templates-api", () => ({
  listResourceTemplates: (...args: unknown[]) =>
    listResourceTemplatesMock(...args),
}));
vi.mock("@/lib/apis/mcp-resources-api", () => ({
  readResource: vi.fn(),
  listResources: vi.fn(),
}));
vi.mock("@/lib/apis/mcp-prompts-api", () => ({ listPrompts: vi.fn() }));
vi.mock("../fetch-widget-content", () => ({ fetchMcpAppsWidgetContent: vi.fn() }));

function makeWrapper(opts: {
  webManaged?: boolean;
  scenario?: boolean;
  surface?: WidgetSurface;
  savedClient?: HostSnapshot;
}) {
  return ({ children }: { children: React.ReactNode }) => {
    let node = <>{children}</>;
    if (opts.savedClient) {
      node = <SavedClientProvider value={opts.savedClient}>{node}</SavedClientProvider>;
    }
    if (opts.surface !== undefined) {
      node = (
        <WidgetSurfaceProvider value={opts.surface}>
          {node}
        </WidgetSurfaceProvider>
      );
    }
    if (opts.scenario !== undefined) {
      node = (
        <ScenarioSurfaceProvider value={opts.scenario}>
          {node}
        </ScenarioSurfaceProvider>
      );
    }
    if (opts.webManaged !== undefined) {
      node = (
        <WebManagedServersProvider value={opts.webManaged}>
          {node}
        </WebManagedServersProvider>
      );
    }
    // Phase 1b: useWidgetHost now also reads the preferences store
    // (themeMode / hostStyle) for the renderer's environment inputs.
    // `usePreferencesStore` throws without its provider, so wrap the hook
    // in a provider on every surface (mirrors the renderer always being
    // mounted inside PreferencesStoreProvider in the real app).
    node = (
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        {node}
      </PreferencesStoreProvider>
    );
    return node;
  };
}

describe("useWidgetHost", () => {
  it("isolates saved context and CSP from ambient settings, including empty context", () => {
    useHostContextStore.getState().applyHostTemplate({ locale: "de-DE", timeZone: "Europe/Berlin" });
    useUIPlaygroundStore.getState().setMcpAppsCspMode("permissive");
    const client: HostSnapshot = {
      hostStyle: "claude",
      hostContext: {
        locale: "fr-FR", timeZone: "Europe/Paris", theme: "dark",
        availableDisplayModes: ["inline"],
        deviceCapabilities: { hover: false, touch: true },
        safeAreaInsets: { top: 12, right: 0, bottom: 0, left: 0 },
      },
      mcpProfile: { version: 1, apps: { sandbox: { csp: { mode: "declared" } } } },
    };
    const a = renderHook(() => useWidgetHost(), { wrapper: makeWrapper({ savedClient: client }) });
    const b = renderHook(() => useWidgetHost(), { wrapper: makeWrapper({ savedClient: { hostStyle: "chatgpt" } }) });
    expect(a.result.current.environment).toMatchObject({
      sharedHostStyle: "claude", draftHostContext: client.hostContext,
      playgroundLocale: "fr-FR", playgroundTimeZone: "Europe/Paris",
      playgroundCapabilities: { hover: false, touch: true },
      playgroundSafeAreaInsets: { top: 12 }, scenarioHostTheme: "dark",
    });
    expect(a.result.current.surface.playgroundCspMode).toBe("widget-declared");
    expect(b.result.current.environment).toMatchObject({
      sharedHostStyle: "chatgpt", draftHostContext: {}, playgroundLocale: "en-US",
      playgroundTimeZone: "UTC", playgroundCapabilities: { hover: true, touch: false },
    });
    expect(b.result.current.surface.playgroundCspMode).toBe("permissive");
  });
  beforeEach(() => {
    listResourceTemplatesMock.mockReset();
  });

  describe("services.listResourceTemplates (surface routing)", () => {
    it("delegates to the api when the surface is not web-managed", async () => {
      const templates = [{ uriTemplate: "ui://widget/{id}", name: "tpl" }];
      listResourceTemplatesMock.mockResolvedValue(templates);

      const { result } = renderHook(() => useWidgetHost(), {
        wrapper: makeWrapper({ webManaged: false }),
      });

      await expect(
        result.current.services.listResourceTemplates("server-1"),
      ).resolves.toEqual(templates);
      expect(listResourceTemplatesMock).toHaveBeenCalledWith("server-1", { forceHosted: false });
    });

    it("uses the hosted API on web-managed surfaces", async () => {
      listResourceTemplatesMock.mockResolvedValue([]);
      const { result } = renderHook(() => useWidgetHost(), {
        wrapper: makeWrapper({ webManaged: true }),
      });

      await expect(
        result.current.services.listResourceTemplates("server-1"),
      ).resolves.toEqual([]);
      expect(listResourceTemplatesMock).toHaveBeenCalledWith("server-1", { forceHosted: true });
    });
  });

  describe("surface.kind", () => {
    it("defaults to chat", () => {
      const { result } = renderHook(() => useWidgetHost(), {
        wrapper: makeWrapper({}),
      });
      expect(result.current.surface.kind).toBe("chat");
    });

    it("is playground when the widget surface is playground", () => {
      const { result } = renderHook(() => useWidgetHost(), {
        wrapper: makeWrapper({ surface: "playground" }),
      });
      expect(result.current.surface.kind).toBe("playground");
    });

    it("is scenario on a scenario surface", () => {
      const { result } = renderHook(() => useWidgetHost(), {
        wrapper: makeWrapper({ scenario: true }),
      });
      expect(result.current.surface.kind).toBe("scenario");
    });

    it("lets scenario win over playground (preserves CSP precedence)", () => {
      const { result } = renderHook(() => useWidgetHost(), {
        wrapper: makeWrapper({ scenario: true, surface: "playground" }),
      });
      expect(result.current.surface.kind).toBe("scenario");
    });
  });
});
