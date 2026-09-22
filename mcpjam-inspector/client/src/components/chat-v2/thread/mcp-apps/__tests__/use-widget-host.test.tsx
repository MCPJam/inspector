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
}) {
  return ({ children }: { children: React.ReactNode }) => {
    let node = <>{children}</>;
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
  beforeEach(() => {
    listResourceTemplatesMock.mockReset();
  });

  describe("services.listResourceTemplates (host-owned guard)", () => {
    it("delegates to the api when the surface is not web-managed", async () => {
      const templates = [{ uriTemplate: "ui://widget/{id}", name: "tpl" }];
      listResourceTemplatesMock.mockResolvedValue(templates);

      const { result } = renderHook(() => useWidgetHost(), {
        wrapper: makeWrapper({ webManaged: false }),
      });

      await expect(
        result.current.services.listResourceTemplates("server-1"),
      ).resolves.toEqual(templates);
      expect(listResourceTemplatesMock).toHaveBeenCalledWith("server-1");
    });

    it("throws and never hits the api on web-managed surfaces", async () => {
      const { result } = renderHook(() => useWidgetHost(), {
        wrapper: makeWrapper({ webManaged: true }),
      });

      await expect(
        result.current.services.listResourceTemplates("server-1"),
      ).rejects.toThrow(/hosted mode/i);
      expect(listResourceTemplatesMock).not.toHaveBeenCalled();
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
