import { useEffect, useRef } from "react";
import { useConvexAuth } from "convex/react";
import { getCatalogHost, getCatalogTemplate } from "@mcpjam/sdk/host-compat";
import { useHostList, useHostMutations } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { cloneHostTemplateInput } from "@/lib/client-config-v2";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/** Preserve project initialization independently of the client selector UI. */
export function ClientSelectionSync({ projectId }: { projectId: string }) {
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const { createHost } = useHostMutations();
  const catalogState = useHostCatalog();
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(projectId);
  const seededProject = useRef<string | null>(null);
  const defaultName =
    catalogState.status === "live"
      ? (getCatalogHost(catalogState.catalog, "mcpjam")?.label ?? "MCPJam")
      : "MCPJam";

  useEffect(() => {
    if (
      !isAuthenticated ||
      isLoading ||
      hosts.length ||
      seededProject.current === projectId ||
      catalogState.status !== "live"
    )
      return;
    const template = getCatalogTemplate(catalogState.catalog, "mcpjam");
    if (!template) return;
    seededProject.current = projectId;
    createHost({
      projectId,
      name: defaultName,
      input: cloneHostTemplateInput(template, { themeMode }),
    }).catch(() => {
      seededProject.current = null;
    });
  }, [
    isAuthenticated,
    isLoading,
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
