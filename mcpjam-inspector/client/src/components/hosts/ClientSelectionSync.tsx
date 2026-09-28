import { useEffect, useRef } from "react";
import { useConvexAuth } from "convex/react";
import { getCatalogHost, getCatalogTemplate } from "@mcpjam/sdk/host-compat";
import { useHostList, useHostMutations } from "@/hooks/useClients";
import { useCanManageProjectClients } from "@/hooks/useProjects";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { cloneHostTemplateInput } from "@/lib/client-config-v2";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/** Preserve project initialization independently of the client selector UI. */
export function ClientSelectionSync({ projectId }: { projectId: string }) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const { createHost } = useHostMutations();
  // Only project admins may create clients; a member or guest opening an
  // empty project gets no default client rather than a refused create.
  const { canManage, isLoading: roleLoading } = useCanManageProjectClients({
    isAuthenticated,
    projectId,
  });
  const catalogState = useHostCatalog();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);
  const seededProjects = useRef(new Set<string>());
  const defaultName =
    catalogState.status === "live"
      ? getCatalogHost(catalogState.catalog, "mcpjam")?.label ?? "MCPJam"
      : "MCPJam";

  useEffect(() => {
    if (
      !isAuthenticated ||
      isLoading ||
      roleLoading ||
      !canManage ||
      hosts.length ||
      seededProjects.current.has(projectId) ||
      catalogState.status !== "live"
    )
      return;
    const template = getCatalogTemplate(catalogState.catalog, "mcpjam");
    if (!template) return;
    seededProjects.current.add(projectId);
    createHost({
      projectId,
      name: defaultName,
      // First-run guests can try the client before signing up to share.
      scenarioMode: "project_members",
      input: cloneHostTemplateInput(template, { themeMode }),
    }).catch(() => {
      seededProjects.current.delete(projectId);
    });
  }, [
    isAuthenticated,
    isLoading,
    roleLoading,
    canManage,
    hosts.length,
    projectId,
    catalogState,
    createHost,
    defaultName,
    themeMode,
  ]);

  useEffect(() => {
    if (isLoading || hosts.some((h) => h.hostId === previewedHostId)) return;
    const fallback =
      hosts.find((h) => h.name === defaultName) ??
      hosts.find((h) => h.name === "MCPJam") ??
      [...hosts].sort((a, b) => a.name.localeCompare(b.name))[0];
    if (fallback) setPreviewedHostId(fallback.hostId);
  }, [hosts, isLoading, previewedHostId, defaultName, setPreviewedHostId]);

  return null;
}
