/**
 * `/servers/plugins/:pluginId` keeps working without the plugin group card:
 * it opens the plugin's first server's Settings, or a skills-only plugin's
 * skill on the Skills tab, and says so when the plugin is not available.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  flag: true,
  installed: { value: undefined as unknown },
  version: { value: undefined as unknown },
  activeRows: { value: [] as unknown[] },
  navigate: vi.fn(),
}));

vi.mock("@/hooks/usePluginsEnabled", () => ({
  usePluginsEnabled: () => h.flag,
}));
vi.mock("@/hooks/usePluginImportApi", () => ({
  useProjectPlugins: (projectId: string | null) =>
    projectId ? h.installed.value : undefined,
  usePluginVersion: (id: string | null) => (id ? h.version.value : undefined),
}));
vi.mock("@/hooks/useActivePlugins", () => ({
  useActivePlugins: () => ({
    plugins: h.activeRows.value,
    activePlugins: [],
    activeServers: [],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({ canManageMembers: true, isLoading: false }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/lib/app-navigation", () => ({
  routePaths: { skills: "/skills" },
  useAppNavigate: () => h.navigate,
}));

import {
  pluginSkillsPath,
  useServersTabPlugins,
} from "../use-servers-tab-plugins";

const plugin = {
  pluginId: "pl_bits",
  projectId: "p_1",
  name: "bits-and-bolts",
  displayName: "Bits & Bolts",
  enabled: true,
  activeVersionId: "pv_1",
  createdAt: 1,
  updatedAt: 1,
};

function version(servers: unknown[], skills: unknown[] = []) {
  return { pluginVersionId: "pv_1", servers, skills };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.flag = true;
  h.installed.value = [plugin];
  h.activeRows.value = [];
  h.version.value = version([
    {
      componentId: "c_1",
      componentKey: "server:cad",
      declaredName: "cad",
      placement: "remote",
      authenticationPolicy: "on_install",
      materializedServerId: "s_cad",
    },
  ]);
});

describe("useServersTabPlugins permalinks", () => {
  it("opens the plugin's first server's Settings", () => {
    const { result } = renderHook(() =>
      useServersTabPlugins({ projectId: "p_1", routePluginId: "pl_bits" }),
    );
    expect(result.current.detail).toEqual({
      pluginId: "pl_bits",
      pluginLabel: "Bits & Bolts",
      serverId: "s_cad",
      serverName: "cad",
    });
    expect(result.current.routeUnavailable).toBe(false);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("does not reopen Settings once the viewer closed them", () => {
    const { result, rerender } = renderHook(() =>
      useServersTabPlugins({ projectId: "p_1", routePluginId: "pl_bits" }),
    );
    result.current.setDetail(null);
    rerender();
    expect(result.current.detail).toBeNull();
  });

  it("opens a skills-only plugin's skill on the Skills tab", () => {
    h.version.value = version(
      [],
      [{ componentId: "c_2", modelRef: "bits/triage", declaredName: "triage" }],
    );
    const { result } = renderHook(() =>
      useServersTabPlugins({ projectId: "p_1", routePluginId: "pl_bits" }),
    );
    expect(h.navigate).toHaveBeenCalledWith("/skills?plugin=pl_bits");
    expect(result.current.detail).toBeNull();
    expect(pluginSkillsPath("a b")).toBe("/skills?plugin=a%20b");
  });

  it("waits for the version before deciding", () => {
    h.version.value = undefined;
    const { result } = renderHook(() =>
      useServersTabPlugins({ projectId: "p_1", routePluginId: "pl_bits" }),
    );
    expect(result.current.detail).toBeNull();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("says a plugin this viewer cannot see is unavailable", () => {
    const { result } = renderHook(() =>
      useServersTabPlugins({ projectId: "p_1", routePluginId: "pl_gone" }),
    );
    expect(result.current.routeUnavailable).toBe(true);
    expect(result.current.detail).toBeNull();
  });

  it("says so outside the plugins rollout too", () => {
    h.flag = false;
    const { result } = renderHook(() =>
      useServersTabPlugins({ projectId: "p_1", routePluginId: "pl_bits" }),
    );
    expect(result.current.routeUnavailable).toBe(true);
    expect(result.current.plugins).toEqual([]);
  });

  it("knows whether any installed plugin adds a server card", () => {
    h.activeRows.value = [
      { pluginId: "pl_bits", status: "active", servers: [], skills: [] },
    ];
    const { result } = renderHook(() =>
      useServersTabPlugins({ projectId: "p_1", routePluginId: null }),
    );
    expect(result.current.hasPluginServers).toBe(false);
  });
});
