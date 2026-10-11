import { useEffect, useRef, useState } from "react";
import { useConvexAuth } from "convex/react";
import { routePaths, useAppNavigate } from "@/lib/app-navigation";
import { resolvePermalinkTarget } from "@/lib/permalink-target";
import type { ActivePluginRow } from "@/lib/plugins/active-plugins-types";
import type { PluginSummary } from "@/lib/plugins/plugin-api-types";
import { useActivePlugins } from "@/hooks/useActivePlugins";
import {
  usePluginVersion,
  useProjectPlugins,
} from "@/hooks/usePluginImportApi";
import { usePluginsEnabled } from "@/hooks/usePluginsEnabled";
import { useCanManageProjectClients } from "@/hooks/useProjects";
import type { PluginServerDetail } from "@/components/connection/ServerDetailModal";
import { pluginCardServers } from "./InstalledPluginServerCards";

/** Where a skills-only plugin's permalink lands: its skill on the Skills tab. */
export function pluginSkillsPath(pluginId: string): string {
  return `${routePaths.skills}?plugin=${encodeURIComponent(pluginId)}`;
}

/**
 * The installed plugins as the Servers tab shows them: their servers as cards
 * beside the project's own, and a `/servers/plugins/:pluginId` permalink
 * opening the first server's Settings — or, for a plugin with only skills,
 * that plugin's skill on the Skills tab.
 */
export function useServersTabPlugins({
  projectId,
  routePluginId,
}: {
  /** The Convex project id. */
  projectId: string | null;
  routePluginId: string | null;
}) {
  const enabled = usePluginsEnabled();
  const installed = useProjectPlugins(enabled ? projectId : null);
  const { plugins: activeRows } = useActivePlugins(projectId);
  const { isAuthenticated } = useConvexAuth();
  // Plugin management clears `canManageProjectMembers`, which this mirrors
  // for anonymous owners too (the members list answers false for them).
  const { canManage } = useCanManageProjectClients({
    isAuthenticated,
    projectId,
  });
  const navigate = useAppNavigate();
  const [detail, setDetail] = useState<PluginServerDetail | null>(null);
  // An open plugin belongs to the project it was opened in. Kept across a
  // switch, its Settings would act on that plugin under the new project.
  const [detailProjectId, setDetailProjectId] = useState(projectId);
  if (detailProjectId !== projectId) {
    setDetailProjectId(projectId);
    setDetail(null);
  }

  // The flag is a per-viewer rollout, so a permalink can reach someone outside
  // it. Same answer as a missing plugin: whether it exists is not ours to say.
  const routeState = enabled
    ? resolvePermalinkTarget(
        routePluginId,
        installed,
        (plugin) => plugin.pluginId,
      )
    : routePluginId
      ? ({ kind: "unavailable", requestedId: routePluginId } as const)
      : ({ kind: "none" } as const);
  const routedPlugin = routeState.kind === "found" ? routeState.target : null;
  const routedVersion = usePluginVersion(routedPlugin?.activeVersionId ?? null);
  const routedRow = routedPlugin
    ? activeRows.find((row) => row.pluginId === routedPlugin.pluginId)
    : undefined;

  // Act on a permalink once; closing the modal must not reopen it.
  const handledRouteRef = useRef<string | null>(null);
  useEffect(() => {
    if (!routePluginId) {
      handledRouteRef.current = null;
      return;
    }
    if (!routedPlugin || handledRouteRef.current === routePluginId) return;
    const versionLoaded =
      !!routedVersion &&
      routedVersion.pluginVersionId === routedPlugin.activeVersionId;
    if (routedPlugin.activeVersionId && !versionLoaded) return;
    handledRouteRef.current = routePluginId;
    const pluginLabel = routedPlugin.displayName || routedPlugin.name;
    const [firstServer] = pluginCardServers(
      routedPlugin,
      routedVersion,
      routedRow,
    );
    if (firstServer) {
      setDetail({
        pluginId: routedPlugin.pluginId,
        pluginLabel,
        serverId: firstServer.serverId,
        serverName: firstServer.name,
      });
      return;
    }
    if (versionLoaded && routedVersion.skills.length > 0) {
      navigate(pluginSkillsPath(routedPlugin.pluginId));
      return;
    }
    // Nothing to land on (no active version): the plugin's Settings alone.
    setDetail({
      pluginId: routedPlugin.pluginId,
      pluginLabel,
      serverId: null,
      serverName: pluginLabel,
    });
  }, [routePluginId, routedPlugin, routedVersion, routedRow, navigate]);

  const plugins: PluginSummary[] = installed ?? [];
  const rowFor = (pluginId: string): ActivePluginRow | undefined =>
    activeRows.find((row) => row.pluginId === pluginId);
  return {
    plugins,
    rowFor,
    canManage,
    /** A permalink named a plugin this viewer cannot see. */
    routeUnavailable: routeState.kind === "unavailable",
    /**
     * Whether any installed plugin adds a card to the grid: a server card, or
     * its own card when it has no version active or nothing to show. Without
     * an answer from the active-plugins read, an activated plugin is assumed
     * to add servers.
     */
    hasPluginCards: plugins.some((plugin) => {
      if (!plugin.activeVersionId) return true;
      const row = rowFor(plugin.pluginId);
      return row ? row.servers.length > 0 || row.skills.length === 0 : true;
    }),
    detail,
    setDetail,
  };
}
